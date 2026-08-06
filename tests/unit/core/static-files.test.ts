import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { staticFiles, StaticCore } from '../../../src/core/middleware/built-in/static/index.js';

/**
 * Writable-shaped response double: streamed responses reach it through
 * stream.pipe(), so it has to behave like a real sink (write/end/events),
 * not just record the last call.
 */
class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, any> = {};
  chunks: Buffer[] = [];
  ended = false;
  piped = false;
  headersSent = false;
  private jsonBody: any;
  readonly finished: Promise<void>;
  private resolveFinished!: () => void;

  constructor() {
    super();
    this.finished = new Promise<void>(resolve => {
      this.resolveFinished = resolve;
    });
  }

  /** JSON payload when one was sent, otherwise the raw bytes written. */
  get body(): any {
    if (this.jsonBody !== undefined) return this.jsonBody;
    return this.chunks.length ? Buffer.concat(this.chunks) : undefined;
  }

  setHeader(name: string, value: any): void {
    this.headers[name.toLowerCase()] = value;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: any): void {
    this.jsonBody = payload;
    this.end();
  }

  write(chunk: any): boolean {
    this.piped = true;
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(data?: any): void {
    if (data !== undefined) this.chunks.push(Buffer.from(data));
    this.headersSent = true;
    this.ended = true;
    this.emit('finish');
    this.emit('close');
    this.resolveFinished();
  }
}

function createResponse(): MockResponse {
  return new MockResponse();
}

function createRequest(reqPath: string, method = 'GET', headers: Record<string, string> = {}) {
  return { method, path: reqPath, headers } as any;
}

/** Run the middleware and report whether it served the request or called next() */
async function run(mw: any, reqPath: string, method = 'GET', headers: Record<string, string> = {}) {
  const req = createRequest(reqPath, method, headers);
  const res = createResponse();
  let nextCalled = false;
  await mw(req, res, () => {
    nextCalled = true;
  });
  // Streamed responses complete after the middleware returns
  if (!nextCalled && !res.ended) await res.finished;
  return { res, nextCalled };
}

describe('staticFiles', () => {
  let root: string;

  beforeAll(async () => {
    // realpath: os.tmpdir() is a symlink on macOS, which the traversal guard
    // (correctly) rejects if the configured root is the unresolved path
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-static-')));
    await fs.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'app.css'), 'body{color:red}');
    await fs.writeFile(path.join(root, 'index.html'), '<h1>root</h1>');
    await fs.writeFile(path.join(root, 'nested', 'deep.txt'), 'deep');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('serving from the URL root (default)', () => {
    it('serves a file at its path below root', async () => {
      const { res, nextCalled } = await run(staticFiles({ root }), '/app.css');

      expect(nextCalled).toBe(false);
      expect(res.headers['content-type']).toBe('text/css; charset=utf-8');
      expect(res.body.toString()).toBe('body{color:red}');
    });

    it('falls through for a file that does not exist', async () => {
      const { res, nextCalled } = await run(staticFiles({ root }), '/missing.css');

      expect(nextCalled).toBe(true);
      expect(res.ended).toBe(false);
    });
  });

  describe('prefix', () => {
    it('serves files mounted under the prefix, with the prefix stripped', async () => {
      const mw = staticFiles({ root, prefix: '/cdn' });

      const css = await run(mw, '/cdn/app.css');
      expect(css.nextCalled).toBe(false);
      expect(css.res.body.toString()).toBe('body{color:red}');

      const nested = await run(mw, '/cdn/nested/deep.txt');
      expect(nested.nextCalled).toBe(false);
      expect(nested.res.body.toString()).toBe('deep');
    });

    it('falls through for requests outside the prefix', async () => {
      const mw = staticFiles({ root, prefix: '/cdn' });

      for (const outside of ['/app.css', '/other/app.css', '/']) {
        const { res, nextCalled } = await run(mw, outside);
        expect(nextCalled).toBe(true);
        expect(res.ended).toBe(false);
      }
    });

    it('does not treat a sibling path as being inside the prefix', async () => {
      const { res, nextCalled } = await run(
        staticFiles({ root, prefix: '/cdn' }),
        '/cdn-backup/app.css'
      );

      expect(nextCalled).toBe(true);
      expect(res.ended).toBe(false);
    });

    it('serves the directory index for the prefix itself', async () => {
      const { res, nextCalled } = await run(staticFiles({ root, prefix: '/cdn' }), '/cdn');

      expect(nextCalled).toBe(false);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.body.toString()).toBe('<h1>root</h1>');
    });

    it('normalizes equivalent prefix spellings', async () => {
      for (const prefix of ['/cdn', 'cdn', '/cdn/', ' /cdn ']) {
        const { res, nextCalled } = await run(staticFiles({ root, prefix }), '/cdn/app.css');
        expect(nextCalled).toBe(false);
        expect(res.body.toString()).toBe('body{color:red}');
      }
    });

    it('treats an empty or root prefix as serving from the URL root', async () => {
      for (const prefix of ['', '/', '   ']) {
        expect(new StaticCore({ root, prefix }).getPrefix()).toBe('');

        const { nextCalled } = await run(staticFiles({ root, prefix }), '/app.css');
        expect(nextCalled).toBe(false);
      }
    });

    it('still blocks traversal out of root through the prefix', async () => {
      const { res, nextCalled } = await run(
        staticFiles({ root, prefix: '/cdn' }),
        '/cdn/../../etc/passwd'
      );

      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
    });

    it('applies cache and etag options to prefixed responses', async () => {
      const mw = staticFiles({ root, prefix: '/cdn', maxAge: 3600 });
      const { res } = await run(mw, '/cdn/app.css');

      expect(res.headers['cache-control']).toBe('public, max-age=3600');
      expect(res.headers.etag).toMatch(/^"[a-f0-9]+"$/);

      // Conditional request against the same file gets a 304
      const req = createRequest('/cdn/app.css');
      req.headers['if-none-match'] = res.headers.etag;
      const conditional = createResponse();
      await mw(req, conditional as any, () => {
        throw new Error('next() should not be called for a 304');
      });
      expect(conditional.statusCode).toBe(304);
    });

    it('ignores non-GET/HEAD methods under the prefix', async () => {
      const { res, nextCalled } = await run(
        staticFiles({ root, prefix: '/cdn' }),
        '/cdn/app.css',
        'POST'
      );

      expect(nextCalled).toBe(true);
      expect(res.ended).toBe(false);
    });
  });

  describe('conditional requests', () => {
    it('sends Last-Modified and answers If-Modified-Since with a 304', async () => {
      const mw = staticFiles({ root });
      const { res } = await run(mw, '/app.css');
      const lastModified = res.headers['last-modified'];
      expect(lastModified).toBe((await fs.stat(path.join(root, 'app.css'))).mtime.toUTCString());

      const req = createRequest('/app.css');
      req.headers['if-modified-since'] = lastModified;
      const conditional = createResponse();
      await mw(req, conditional as any, () => {
        throw new Error('next() should not be called');
      });

      expect(conditional.statusCode).toBe(304);
      expect(conditional.headers['content-length']).toBeUndefined();
    });

    it('serves the file when If-Modified-Since predates the file', async () => {
      const req = createRequest('/app.css');
      req.headers['if-modified-since'] = new Date(2000, 0, 1).toUTCString();
      const res = createResponse();
      await staticFiles({ root })(req, res as any, () => {});

      expect(res.statusCode).toBe(200);
      expect(res.body.toString()).toBe('body{color:red}');
    });

    it('honours a weak or multi-value If-None-Match', async () => {
      const mw = staticFiles({ root });
      const { res } = await run(mw, '/app.css');

      const req = createRequest('/app.css');
      req.headers['if-none-match'] = `"other", W/${res.headers.etag}`;
      const conditional = createResponse();
      await mw(req, conditional as any, () => {});

      expect(conditional.statusCode).toBe(304);
    });

    it('can be turned off with lastModified: false', async () => {
      const { res } = await run(staticFiles({ root, lastModified: false }), '/app.css');
      expect(res.headers['last-modified']).toBeUndefined();
    });
  });

  describe('range requests', () => {
    it('advertises Accept-Ranges', async () => {
      const { res } = await run(staticFiles({ root }), '/app.css');
      expect(res.headers['accept-ranges']).toBe('bytes');
    });

    it('serves a byte range as 206 with Content-Range', async () => {
      const { res } = await run(staticFiles({ root }), '/app.css', 'GET', {
        range: 'bytes=0-3',
      });

      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 0-3/15');
      expect(res.headers['content-length']).toBe(4);
      expect(res.body.toString()).toBe('body');
    });

    it('serves an open-ended and a suffix range', async () => {
      const open = await run(staticFiles({ root }), '/app.css', 'GET', { range: 'bytes=5-' });
      expect(open.res.statusCode).toBe(206);
      expect(open.res.body.toString()).toBe('color:red}');

      const suffix = await run(staticFiles({ root }), '/app.css', 'GET', { range: 'bytes=-4' });
      expect(suffix.res.statusCode).toBe(206);
      expect(suffix.res.headers['content-range']).toBe('bytes 11-14/15');
      expect(suffix.res.body.toString()).toBe('red}');
    });

    it('answers an unsatisfiable range with 416', async () => {
      const req = createRequest('/app.css');
      req.headers.range = 'bytes=999-1050';
      const res = createResponse();
      await staticFiles({ root })(req, res as any, () => {});

      expect(res.statusCode).toBe(416);
      expect(res.headers['content-range']).toBe('bytes */15');
    });

    it('sends the whole entity for a multi-range request', async () => {
      const req = createRequest('/app.css');
      req.headers.range = 'bytes=0-1,4-5';
      const res = createResponse();
      await staticFiles({ root })(req, res as any, () => {});

      expect(res.statusCode).toBe(200);
      expect(res.body.toString()).toBe('body{color:red}');
    });

    it('ignores the range when If-Range no longer matches', async () => {
      const req = createRequest('/app.css');
      req.headers.range = 'bytes=0-3';
      req.headers['if-range'] = '"stale-etag"';
      const res = createResponse();
      await staticFiles({ root })(req, res as any, () => {});

      expect(res.statusCode).toBe(200);
      expect(res.body.toString()).toBe('body{color:red}');
    });

    it('serves the range when If-Range still matches the etag', async () => {
      const mw = staticFiles({ root });
      const { res } = await run(mw, '/app.css');

      const ranged = await run(mw, '/app.css', 'GET', {
        range: 'bytes=0-3',
        'if-range': res.headers.etag,
      });

      expect(ranged.res.statusCode).toBe(206);
      expect(ranged.res.body.toString()).toBe('body');
    });

    it('answers HEAD with range headers and no body', async () => {
      const req = createRequest('/app.css', 'HEAD');
      req.headers.range = 'bytes=0-3';
      const res = createResponse();
      await staticFiles({ root })(req, res as any, () => {});

      expect(res.statusCode).toBe(206);
      expect(res.headers['content-length']).toBe(4);
      expect(res.body).toBeUndefined();
    });

    it('can be turned off with acceptRanges: false', async () => {
      const req = createRequest('/app.css');
      req.headers.range = 'bytes=0-3';
      const res = createResponse();
      await staticFiles({ root, acceptRanges: false })(req, res as any, () => {});

      expect(res.headers['accept-ranges']).toBeUndefined();
      expect(res.statusCode).toBe(200);
      expect(res.body.toString()).toBe('body{color:red}');
    });
  });

  describe('large files', () => {
    it('streams a file above the buffering threshold', async () => {
      const big = Buffer.alloc(600 * 1024, 'x');
      await fs.writeFile(path.join(root, 'big.bin'), big);

      const { res } = await run(staticFiles({ root }), '/big.bin');

      expect(res.headers['content-length']).toBe(big.length);
      expect(res.piped).toBe(true);
      expect(Buffer.concat(res.chunks).length).toBe(big.length);
    });

    it('streams only the requested slice of a large file', async () => {
      const { res } = await run(staticFiles({ root }), '/big.bin', 'GET', {
        range: 'bytes=0-99',
      });

      expect(res.statusCode).toBe(206);
      expect(res.headers['content-length']).toBe(100);
      expect(Buffer.concat(res.chunks).length).toBe(100);
    });
  });
});
