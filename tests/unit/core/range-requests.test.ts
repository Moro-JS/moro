// Unit - middleware.range() / res.sendRange(): Range header parsing (RFC 9110
// section 14), If-Range, multipart/byteranges framing, and the failure modes
// that used to leak a path, hang the response or take the process down.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { range, RangeCore } from '../../../src/core/middleware/built-in/range/index.js';

/**
 * Writable-shaped response double. sendRange streams through write()/'drain',
 * so this has to behave like a real sink, not just record the last call.
 */
class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, any> = {};
  chunks: Buffer[] = [];
  ended = false;
  headersSent = false;
  writes = 0;
  /** Report backpressure on every write and release it on a later tick */
  slow = false;
  /** Simulate the client disconnecting once this many writes have happened */
  abortAfterWrites = Infinity;
  private jsonBody: any;

  get body(): any {
    if (this.jsonBody !== undefined) return this.jsonBody;
    return Buffer.concat(this.chunks);
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString('latin1');
  }

  header(name: string): any {
    return this.headers[name.toLowerCase()];
  }

  setHeader(name: string, value: any): void {
    this.headers[name.toLowerCase()] = value;
  }

  getHeader(name: string): any {
    return this.headers[name.toLowerCase()];
  }

  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: any): void {
    this.jsonBody = payload;
    this.headersSent = true;
    this.ended = true;
  }

  write(chunk: any): boolean {
    if (this.ended) return false;
    this.headersSent = true;
    this.writes++;
    this.chunks.push(Buffer.from(chunk));
    if (this.writes >= this.abortAfterWrites) {
      this.ended = true;
      setImmediate(() => this.emit('close'));
      return false;
    }
    if (this.slow) {
      setImmediate(() => this.emit('drain'));
      return false;
    }
    return true;
  }

  end(data?: any): void {
    if (this.ended) return;
    if (data !== undefined) this.chunks.push(Buffer.from(data));
    this.headersSent = true;
    this.ended = true;
    this.emit('finish');
    this.emit('close');
  }
}

interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  options?: { acceptRanges?: string; maxRanges?: number; root?: string };
  /** Second argument of sendRange(): an fs.Stats or `{ root }` */
  stats?: any;
  prepare?: (res: MockResponse) => void;
}

/** Install the middleware on a fresh req/res pair and call res.sendRange() */
async function send(filePath: string, opts: SendOptions = {}): Promise<MockResponse> {
  const req: any = { method: opts.method ?? 'GET', headers: opts.headers ?? {} };
  const res = new MockResponse();
  let nextCalled = false;
  range(opts.options)(req, res as any, () => {
    nextCalled = true;
  });
  expect(nextCalled).toBe(true);
  opts.prepare?.(res);
  await (res as any).sendRange(filePath, opts.stats);
  return res;
}

const withRange = (value: string, extra: Partial<SendOptions> = {}): SendOptions => ({
  ...extra,
  headers: { ...(extra.headers ?? {}), range: value },
});

describe('middleware.range() - res.sendRange()', () => {
  let dir: string;
  let sample: string; // 990 x 'a' then '0123456789' -> 1000 bytes
  let empty: string;
  let big: string; // several stream chunks
  let bigData: Buffer;
  const SIZE = 1000;

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-range-')));
    sample = path.join(dir, 'sample.bin');
    empty = path.join(dir, 'empty.bin');
    big = path.join(dir, 'big.bin');
    await fs.writeFile(sample, 'a'.repeat(990) + '0123456789');
    await fs.writeFile(empty, '');
    bigData = Buffer.alloc(300 * 1024 + 17);
    for (let i = 0; i < bigData.length; i++) bigData[i] = (i * 31 + (i >> 8)) & 0xff;
    await fs.writeFile(big, bigData);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('without a Range header', () => {
    it('sends the whole file and advertises range support', async () => {
      const res = await send(sample);
      expect(res.statusCode).toBe(200);
      expect(res.header('accept-ranges')).toBe('bytes');
      expect(res.header('content-length')).toBe(SIZE);
      expect(res.header('content-range')).toBeUndefined();
      expect(res.body.length).toBe(SIZE);
      expect(res.ended).toBe(true);
    });

    it('sends an empty file as an empty 200', async () => {
      const res = await send(empty);
      expect(res.statusCode).toBe(200);
      expect(res.header('content-length')).toBe(0);
      expect(res.body.length).toBe(0);
      expect(res.ended).toBe(true);
    });

    it('streams a large file intact, in more than one write', async () => {
      const res = await send(big);
      expect(res.statusCode).toBe(200);
      expect(res.writes).toBeGreaterThan(1);
      expect(res.body.equals(bigData)).toBe(true);
    });
  });

  // The four requests from GitHub issue #36
  describe('suffix ranges and last-pos clamping (issue #36)', () => {
    it('bytes=-N returns the LAST N bytes', async () => {
      const res = await send(sample, withRange('bytes=-10'));
      expect(res.statusCode).toBe(206);
      expect(res.header('content-range')).toBe('bytes 990-999/1000');
      expect(res.header('content-length')).toBe(10);
      expect(res.text).toBe('0123456789');
    });

    it('a suffix longer than the file is the whole file', async () => {
      const res = await send(sample, withRange('bytes=-2000'));
      expect(res.statusCode).toBe(206);
      expect(res.header('content-range')).toBe('bytes 0-999/1000');
      expect(res.body.length).toBe(SIZE);
    });

    it('clamps a last-pos past the end of the file', async () => {
      const res = await send(sample, withRange('bytes=995-2000'));
      expect(res.statusCode).toBe(206);
      expect(res.header('content-range')).toBe('bytes 995-999/1000');
      expect(res.header('content-length')).toBe(5);
      expect(res.text).toBe('56789');
    });

    it('clamps a last-pos equal to the file size', async () => {
      const res = await send(sample, withRange('bytes=0-1000'));
      expect(res.statusCode).toBe(206);
      expect(res.header('content-range')).toBe('bytes 0-999/1000');
      expect(res.body.length).toBe(SIZE);
    });
  });

  describe('single ranges', () => {
    it('serves first-last', async () => {
      const res = await send(sample, withRange('bytes=985-994'));
      expect(res.statusCode).toBe(206);
      expect(res.header('content-range')).toBe('bytes 985-994/1000');
      expect(res.text).toBe('aaaaa01234');
    });

    it('serves an open-ended range', async () => {
      const res = await send(sample, withRange('bytes=990-'));
      expect(res.statusCode).toBe(206);
      expect(res.header('content-range')).toBe('bytes 990-999/1000');
      expect(res.text).toBe('0123456789');
    });

    it('serves a one-byte range', async () => {
      const res = await send(sample, withRange('bytes=999-999'));
      expect(res.statusCode).toBe(206);
      expect(res.text).toBe('9');
    });

    it('treats the unit as case-insensitive and allows whitespace', async () => {
      const res = await send(sample, withRange('Bytes= 990-994 '));
      expect(res.statusCode).toBe(206);
      expect(res.text).toBe('01234');
    });

    it('serves a slice of a large file intact', async () => {
      const res = await send(big, withRange('bytes=1000-250000'));
      expect(res.statusCode).toBe(206);
      expect(res.body.equals(bigData.subarray(1000, 250001))).toBe(true);
    });
  });

  describe('unsatisfiable ranges', () => {
    it.each([
      ['a first-pos at the end of the file', 'bytes=1000-'],
      ['a first-pos past the end of the file', 'bytes=5000-6000'],
      ['a zero-length suffix', 'bytes=-0'],
      ['a first-pos after its last-pos', 'bytes=10-5'],
      ['a first-pos too large for a number', `bytes=${'9'.repeat(400)}-`],
    ])('answers 416 for %s', async (_name, header) => {
      const res = await send(sample, withRange(header));
      expect(res.statusCode).toBe(416);
      expect(res.header('content-range')).toBe('bytes */1000');
      expect(res.body).toEqual({ success: false, error: 'Range not satisfiable' });
    });

    it('answers 416 for any range of an empty file', async () => {
      const res = await send(empty, withRange('bytes=0-0'));
      expect(res.statusCode).toBe(416);
      expect(res.header('content-range')).toBe('bytes */0');
    });
  });

  describe('malformed Range headers are ignored', () => {
    it.each([
      'bytes=abc-def',
      'bytes=5-abc',
      'bytes=--5',
      'bytes=-',
      'bytes=',
      'bytes',
      '0-9',
      'items=0-5',
      'bytes=1e2-2e2',
      'bytes=0x10-0x20',
      'bytes=0-9junk',
      'bytes=0 - 9',
      'bytes=+1-5',
      'bytes=1.5-9',
      'bytes=0-1,,5-6',
    ])('%s sends the whole file', async header => {
      const res = await send(sample, withRange(header, { options: { maxRanges: 5 } }));
      expect(res.statusCode).toBe(200);
      expect(res.header('content-range')).toBeUndefined();
      expect(res.header('content-length')).toBe(SIZE);
      expect(res.body.length).toBe(SIZE);
    });

    it('never puts NaN in a header', async () => {
      const res = await send(sample, withRange('bytes=abc-def'));
      expect(JSON.stringify(res.headers)).not.toContain('NaN');
    });
  });

  describe('multiple ranges', () => {
    const parseParts = (res: MockResponse) => {
      const contentType = String(res.header('content-type'));
      const boundary = contentType.split('boundary=')[1] as string;
      const raw = res.text;
      const sections = raw.split(`--${boundary}`);
      // ['', part, part, ..., '--\r\n']
      const parts = sections.slice(1, -1).map(section => {
        const [head, ...rest] = section.replace(/^\r\n/, '').split('\r\n\r\n');
        return { head: head as string, data: rest.join('\r\n\r\n').replace(/\r\n$/, '') };
      });
      return { boundary, parts, closing: sections[sections.length - 1] };
    };

    it('sends the whole file when there are more ranges than maxRanges (default 1)', async () => {
      const res = await send(sample, withRange('bytes=0-0,5-5'));
      expect(res.statusCode).toBe(200);
      expect(res.body.length).toBe(SIZE);
    });

    it('answers multipart/byteranges with a Content-Length that matches the body', async () => {
      const res = await send(
        sample,
        withRange('bytes=0-4, 990-994,-2', {
          options: { maxRanges: 5 },
          prepare: r => r.setHeader('Content-Type', 'video/mp4'),
        })
      );
      expect(res.statusCode).toBe(206);
      expect(res.header('content-type')).toMatch(/^multipart\/byteranges; boundary=[0-9a-f]{24}$/);
      expect(res.header('content-range')).toBeUndefined();
      expect(res.header('content-length')).toBe(res.body.length);

      const { parts, closing } = parseParts(res);
      expect(closing).toBe('--\r\n');
      expect(parts).toEqual([
        { head: 'Content-Type: video/mp4\r\nContent-Range: bytes 0-4/1000', data: 'aaaaa' },
        { head: 'Content-Type: video/mp4\r\nContent-Range: bytes 990-994/1000', data: '01234' },
        { head: 'Content-Type: video/mp4\r\nContent-Range: bytes 998-999/1000', data: '89' },
      ]);
    });

    it('labels parts application/octet-stream when the handler set no type', async () => {
      const res = await send(sample, withRange('bytes=0-0,5-5', { options: { maxRanges: 2 } }));
      const { parts } = parseParts(res);
      expect(parts[0]?.head).toContain('Content-Type: application/octet-stream');
    });

    it('uses a different boundary on every response', async () => {
      const opts = withRange('bytes=0-0,5-5', { options: { maxRanges: 2 } });
      const a = parseParts(await send(sample, opts)).boundary;
      const b = parseParts(await send(sample, opts)).boundary;
      expect(a).not.toBe(b);
    });

    it('drops the unsatisfiable members of a set', async () => {
      const res = await send(
        sample,
        withRange('bytes=5000-,990-994', { options: { maxRanges: 5 } })
      );
      expect(res.statusCode).toBe(206);
      expect(res.header('content-range')).toBe('bytes 990-994/1000');
      expect(res.text).toBe('01234');
    });

    it('answers 416 when no member of the set is satisfiable', async () => {
      const res = await send(sample, withRange('bytes=5000-,-0', { options: { maxRanges: 5 } }));
      expect(res.statusCode).toBe(416);
    });

    it('sends the file once when the ranges add up to more than the file', async () => {
      const res = await send(
        sample,
        withRange('bytes=0-999,0-999,0-999,0-999', { options: { maxRanges: 10 } })
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.length).toBe(SIZE);
    });

    it('streams large parts intact', async () => {
      const res = await send(
        big,
        withRange('bytes=0-99999,200000-270000', { options: { maxRanges: 2 } })
      );
      expect(res.statusCode).toBe(206);
      expect(res.header('content-length')).toBe(res.body.length);
      const body: Buffer = res.body;
      expect(body.includes(bigData.subarray(0, 100000))).toBe(true);
      expect(body.includes(bigData.subarray(200000, 270001))).toBe(true);
    });
  });

  describe('If-Range', () => {
    const etag = '"v1-abc"';

    it('honours the range when the ETag on the response matches', async () => {
      const res = await send(
        sample,
        withRange('bytes=0-9', {
          headers: { 'if-range': etag },
          prepare: r => r.setHeader('ETag', etag),
        })
      );
      expect(res.statusCode).toBe(206);
    });

    it('sends the whole file when the ETag no longer matches', async () => {
      const res = await send(
        sample,
        withRange('bytes=0-9', {
          headers: { 'if-range': '"v0-old"' },
          prepare: r => r.setHeader('ETag', etag),
        })
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.length).toBe(SIZE);
    });

    it('never matches a weak validator', async () => {
      const res = await send(
        sample,
        withRange('bytes=0-9', {
          headers: { 'if-range': 'W/"v1-abc"' },
          prepare: r => r.setHeader('ETag', 'W/"v1-abc"'),
        })
      );
      expect(res.statusCode).toBe(200);
    });

    it('sends the whole file when the response carries no validator to compare', async () => {
      const res = await send(sample, withRange('bytes=0-9', { headers: { 'if-range': etag } }));
      expect(res.statusCode).toBe(200);
    });

    it('honours the range when the date equals Last-Modified', async () => {
      const date = 'Wed, 21 Oct 2026 07:28:00 GMT';
      const fresh = await send(
        sample,
        withRange('bytes=0-9', {
          headers: { 'if-range': date },
          prepare: r => r.setHeader('Last-Modified', date),
        })
      );
      expect(fresh.statusCode).toBe(206);

      const stale = await send(
        sample,
        withRange('bytes=0-9', {
          headers: { 'if-range': 'Tue, 20 Oct 2026 07:28:00 GMT' },
          prepare: r => r.setHeader('Last-Modified', date),
        })
      );
      expect(stale.statusCode).toBe(200);
    });
  });

  describe('method and options', () => {
    it('answers HEAD with headers only and ignores Range', async () => {
      const res = await send(sample, withRange('bytes=0-9', { method: 'HEAD' }));
      expect(res.statusCode).toBe(200);
      expect(res.header('content-length')).toBe(SIZE);
      expect(res.header('accept-ranges')).toBe('bytes');
      expect(res.body.length).toBe(0);
      expect(res.ended).toBe(true);
    });

    it('does not serve ranges when configured to advertise none', async () => {
      const res = await send(sample, withRange('bytes=0-9', { options: { acceptRanges: 'none' } }));
      expect(res.statusCode).toBe(200);
      expect(res.header('accept-ranges')).toBe('none');
      expect(res.body.length).toBe(SIZE);
    });

    it.each([
      [undefined, 1],
      [0, 1],
      [-3, 1],
      [Number.NaN, 1],
      [2.5, 1],
      [4, 4],
    ])('maxRanges %p resolves to %p', (given, expected) => {
      expect(new RangeCore({ maxRanges: given as any }).getMaxRanges()).toBe(expected);
    });
  });

  describe('files that cannot be served', () => {
    const expectNotFound = (res: MockResponse) => {
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ success: false, error: 'File not found' });
      // No fs error text, so no path on disk
      expect(JSON.stringify(res.body)).not.toContain(dir);
      expect(res.body.details).toBeUndefined();
    };

    it('answers 404 for a missing file, without the path', async () => {
      expectNotFound(await send(path.join(dir, 'nope.bin')));
      expectNotFound(await send(path.join(dir, 'nope.bin'), withRange('bytes=0-9')));
    });

    it('answers 404 for a directory', async () => {
      expectNotFound(await send(dir));
    });

    it('answers 404 for a path below a file', async () => {
      expectNotFound(await send(path.join(sample, 'child')));
    });

    it('answers 404 for a path with a NUL byte', async () => {
      expectNotFound(await send(`${sample}\0.mp4`));
    });

    it('answers 404 when caller-supplied stats are for a file that is gone', async () => {
      const stats = await fs.stat(sample);
      const res = await send(path.join(dir, 'gone.bin'), withRange('bytes=0-9', { stats }));
      expectNotFound(res);
      expect(res.header('content-range')).toBeUndefined();
    });

    it('takes the size from the file itself, not from caller-supplied stats', async () => {
      // Stats of the 1000-byte sample, handed in for the far larger file
      const stats = await fs.stat(sample);
      const res = await send(big, withRange('bytes=-10', { stats }));
      expect(res.statusCode).toBe(206);
      const size = bigData.length;
      expect(res.header('content-range')).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
      expect(res.body.equals(bigData.subarray(size - 10))).toBe(true);
    });

    it('answers a generic 500 for other failures, without the error text', async () => {
      const res = await send(sample, {
        // The response fails before a byte is out: the body is not coming
        prepare: r => {
          r.write = () => {
            throw new Error(`EIO: i/o error, read '${sample}'`);
          };
        },
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'Range request failed' });
      expect(JSON.stringify(res.body)).not.toContain(dir);
    });

    it('never rejects', async () => {
      await expect(send(path.join(dir, 'nope.bin'))).resolves.toBeDefined();
      await expect(send(undefined as any)).resolves.toBeDefined();
    });
  });

  describe('root (opt-in confinement)', () => {
    let root: string; // <dir>/served
    let outside: string; // <dir>/served-private: a sibling sharing the prefix

    beforeAll(async () => {
      root = path.join(dir, 'served');
      outside = path.join(dir, 'served-private');
      await fs.mkdir(path.join(root, 'nested'), { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(root, 'clip.bin'), 'a'.repeat(990) + '0123456789');
      await fs.writeFile(path.join(root, 'nested', 'deep.bin'), 'deep-file');
      await fs.writeFile(path.join(outside, 'secret.bin'), 'TOP-SECRET');
      await fs.writeFile(path.join(dir, 'secret.bin'), 'TOP-SECRET');
      // Links inside the root: one leading out of it, one staying within it
      await fs.symlink(path.join(outside, 'secret.bin'), path.join(root, 'escape.bin'));
      await fs.symlink(path.join(root, 'clip.bin'), path.join(root, 'alias.bin'));
      await fs.symlink(outside, path.join(root, 'escape-dir'));
      // The root reached through a link
      await fs.symlink(root, path.join(dir, 'current'));
    });

    const expectRefused = (res: MockResponse) => {
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ success: false, error: 'File not found' });
      expect(res.text).not.toContain('TOP-SECRET');
    };

    it('changes nothing when it is not set', async () => {
      // Unconfined, as before: the path is served as given
      const res = await send(path.join(root, '..', 'secret.bin'));
      expect(res.statusCode).toBe(200);
      expect(res.text).toBe('TOP-SECRET');
    });

    describe.each([
      ['per call', (file: string): SendOptions => ({ stats: { root } })],
      ['on the middleware', (file: string): SendOptions => ({ options: { root } })],
    ])('%s', (_name, confined) => {
      it('serves a path relative to the root', async () => {
        const res = await send('clip.bin', confined('clip.bin'));
        expect(res.statusCode).toBe(200);
        expect(res.body.length).toBe(1000);
      });

      it('serves a nested path', async () => {
        const res = await send('nested/deep.bin', confined('nested/deep.bin'));
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe('deep-file');
      });

      it('answers Range requests', async () => {
        const res = await send('clip.bin', {
          ...confined('clip.bin'),
          headers: { range: 'bytes=-10' },
        });
        expect(res.statusCode).toBe(206);
        expect(res.header('content-range')).toBe('bytes 990-999/1000');
        expect(res.text).toBe('0123456789');
      });

      it('serves an absolute path that is inside the root', async () => {
        const file = path.join(root, 'clip.bin');
        const res = await send(file, confined(file));
        expect(res.statusCode).toBe(200);
      });

      it.each([
        ['a parent traversal', '../secret.bin'],
        ['a traversal through a subdirectory', 'nested/../../secret.bin'],
        ['a sibling directory sharing the prefix', '../served-private/secret.bin'],
        ['a symlink leading out of the root', 'escape.bin'],
        ['a path through a symlinked directory', 'escape-dir/secret.bin'],
        ['the root itself', ''],
        ['the root itself, as a dot', '.'],
        ['a missing file', 'nope.bin'],
        ['a directory', 'nested'],
        ['a path with a NUL byte', 'clip.bin\0.mp4'],
      ])('refuses %s', async (_what, file) => {
        expectRefused(await send(file, confined(file)));
      });

      it('refuses an absolute path outside the root', async () => {
        const file = path.join(dir, 'secret.bin');
        expectRefused(await send(file, confined(file)));
        const sibling = path.join(outside, 'secret.bin');
        expectRefused(await send(sibling, confined(sibling)));
      });

      it('follows a symlink that stays inside the root', async () => {
        const res = await send('alias.bin', confined('alias.bin'));
        expect(res.statusCode).toBe(200);
        expect(res.body.length).toBe(1000);
      });
    });

    it('accepts a root that is itself a symlink', async () => {
      const linked = path.join(dir, 'current');
      const ok = await send('clip.bin', { stats: { root: linked } });
      expect(ok.statusCode).toBe(200);
      expectRefused(await send('../secret.bin', { stats: { root: linked } }));
      expectRefused(await send('escape.bin', { stats: { root: linked } }));
    });

    it('accepts a relative root', async () => {
      const relative = path.relative(process.cwd(), root);
      const res = await send('clip.bin', { stats: { root: relative } });
      expect(res.statusCode).toBe(200);
    });

    it('lets a call override the root set on the middleware', async () => {
      const res = await send('secret.bin', { options: { root }, stats: { root: outside } });
      expect(res.statusCode).toBe(200);
      expect(res.text).toBe('TOP-SECRET');
      // ...and the middleware root still applies to calls that pass none
      expectRefused(await send('secret.bin', { options: { root } }));
    });

    it('still confines when the caller passes fs.Stats instead of options', async () => {
      const stats = await fs.stat(path.join(dir, 'secret.bin'));
      expectRefused(await send('../secret.bin', { options: { root }, stats }));
      const ok = await send('clip.bin', { options: { root }, stats });
      expect(ok.statusCode).toBe(200);
      // Size is the served file's, not the one the stats describe
      expect(ok.header('content-length')).toBe(1000);
    });

    it('rejects an empty or non-string root at setup', () => {
      expect(() => range({ root: '' })).toThrow(TypeError);
      expect(() => range({ root: 42 as any })).toThrow(TypeError);
      expect(() => range({ root: null as any })).toThrow(TypeError);
      expect(() => range({ root: undefined })).not.toThrow();
    });

    it('fails closed when a call passes an empty or non-string root', async () => {
      for (const bad of ['', 42, null, {}]) {
        const res = await send(path.join(dir, 'secret.bin'), { stats: { root: bad } });
        expect(res.statusCode).toBe(500);
        expect(res.text).not.toContain('TOP-SECRET');
        expect(res.body).toEqual({ success: false, error: 'Range request failed' });
      }
    });

    it('refuses a non-string path', async () => {
      expectRefused(await send(undefined as any, { stats: { root } }));
    });
  });

  describe('streaming', () => {
    it('waits for drain when the response pushes back', async () => {
      const req: any = { method: 'GET', headers: {} };
      const res = new MockResponse();
      res.slow = true;
      range()(req, res as any, () => undefined);
      await (res as any).sendRange(big);

      expect(res.writes).toBeGreaterThan(1);
      expect(res.body.equals(bigData)).toBe(true);
      expect(res.ended).toBe(true);
    });

    it('stops reading and settles when the client disconnects mid-transfer', async () => {
      const req: any = { method: 'GET', headers: { range: 'bytes=0-99999,100000-299999' } };
      const res = new MockResponse();
      res.abortAfterWrites = 2;
      range({ maxRanges: 2 })(req, res as any, () => undefined);
      await (res as any).sendRange(big);

      expect(res.writes).toBe(2);
      expect(res.body.length).toBeLessThan(bigData.length);
    });

    it('leaves no listeners behind on the response', async () => {
      const req: any = { method: 'GET', headers: { range: 'bytes=0-9,20-29' } };
      const res = new MockResponse();
      range({ maxRanges: 2 })(req, res as any, () => undefined);
      await (res as any).sendRange(sample);

      expect(res.listenerCount('close')).toBe(0);
      expect(res.listenerCount('drain')).toBe(0);
    });

    it('buffers when the response cannot be streamed into (HTTP/2 shape)', async () => {
      const make = () => {
        const headers: Record<string, any> = {};
        const out: any = {
          statusCode: 200,
          headersSent: false,
          headers,
          setHeader: (n: string, v: any) => {
            headers[n.toLowerCase()] = v;
          },
          getHeader: (n: string) => headers[n.toLowerCase()],
          status(code: number) {
            out.statusCode = code;
            return out;
          },
          json(payload: any) {
            out.body = payload;
          },
          end(data?: any) {
            out.body = data;
          },
        };
        return out;
      };

      const whole = make();
      range()({ method: 'GET', headers: {} } as any, whole, () => undefined);
      await whole.sendRange(sample);
      expect(whole.statusCode).toBe(200);
      expect(whole.body.length).toBe(SIZE);

      const single = make();
      range()({ method: 'GET', headers: { range: 'bytes=-10' } } as any, single, () => undefined);
      await single.sendRange(sample);
      expect(single.statusCode).toBe(206);
      expect(single.body.toString()).toBe('0123456789');

      const multi = make();
      range({ maxRanges: 2 })(
        { method: 'GET', headers: { range: 'bytes=0-1,998-999' } } as any,
        multi,
        () => undefined
      );
      await multi.sendRange(sample);
      expect(multi.statusCode).toBe(206);
      expect(multi.headers['content-length']).toBe(multi.body.length);
      expect(multi.body.toString()).toContain('Content-Range: bytes 998-999/1000\r\n\r\n89\r\n');
    });
  });
});
