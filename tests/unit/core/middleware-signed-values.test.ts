import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { MoroHttpServer } from '../../../src/core/http/http-server.js';
import {
  CookieCore,
  signCookieValue,
  unsignCookieValue,
} from '../../../src/core/middleware/built-in/cookie/index.js';
import { createCookieMiddleware } from '../../../src/core/middleware/built-in/cookie/middleware.js';
import { SessionCore } from '../../../src/core/middleware/built-in/session/index.js';
import { UploadCore } from '../../../src/core/middleware/built-in/upload/index.js';
import { createUploadMiddleware } from '../../../src/core/middleware/built-in/upload/middleware.js';
import { MULTIPART_BODY } from '../../../src/core/http/utils/multipart-parser.js';

const SECRET = 'test-signing-secret';

function makeRes(): any {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, any>,
    body: undefined,
    setHeader(name: string, value: any) {
      res.headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return res.headers[name.toLowerCase()];
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function makeReq(headers: Record<string, string> = {}): any {
  return { method: 'POST', path: '/upload', headers };
}

/** The value of a Set-Cookie entry, before attributes. */
function cookieValue(res: any, name: string): string | undefined {
  const header = res.getHeader('Set-Cookie') as string[] | undefined;
  const entry = header?.find(c => c.startsWith(`${name}=`));
  return entry
    ? decodeURIComponent(entry.slice(name.length + 1).split(';')[0] as string)
    : undefined;
}

describe('cookie signing', () => {
  it('round-trips a signed value', () => {
    const signed = signCookieValue('hello', SECRET);

    expect(signed.startsWith('s:hello.')).toBe(true);
    expect(unsignCookieValue(signed, SECRET)).toBe('hello');
  });

  it('rejects a tampered value and a wrong secret', () => {
    const signed = signCookieValue('admin', SECRET);

    expect(unsignCookieValue(signed.replace('admin', 'attacker'), SECRET)).toBeNull();
    expect(unsignCookieValue(signed, 'other-secret')).toBeNull();
    expect(unsignCookieValue('plain-value', SECRET)).toBeNull();
  });

  it('signs on the way out when the cookie asks for it', () => {
    const core = new CookieCore(SECRET);
    const res = makeRes();

    core.setCookie(res, 'session', 'abc123', { signed: true, httpOnly: true });

    const value = cookieValue(res, 'session') as string;
    expect(value).not.toBe('abc123');
    expect(unsignCookieValue(value, SECRET)).toBe('abc123');
  });

  it('throws instead of silently sending an unsigned cookie', () => {
    const core = new CookieCore();

    expect(() => core.setCookie(makeRes(), 'session', 'abc', { signed: true })).toThrow(
      /no secret is configured/
    );
  });

  it('separates verified signed cookies from plain ones', () => {
    const core = new CookieCore(SECRET);
    const signed = signCookieValue('abc123', SECRET);
    const tampered = signCookieValue('abc123', 'other-secret');

    const split = core.splitSignedCookies({ session: signed, theme: 'dark', forged: tampered });

    expect(split.signedCookies).toEqual({ session: 'abc123' });
    expect(split.cookies).toEqual({ theme: 'dark' });
    // A value that fails verification appears nowhere
    expect(split.cookies.forged).toBeUndefined();
  });

  it('populates req.cookies and req.signedCookies through the middleware', async () => {
    const mw = createCookieMiddleware(SECRET);
    const req: any = {
      headers: {
        cookie: `session=${encodeURIComponent(signCookieValue('abc123', SECRET))}; theme=dark`,
      },
    };

    await mw(req, makeRes(), (async () => {}) as any);

    expect(req.signedCookies).toEqual({ session: 'abc123' });
    expect(req.cookies).toEqual({ theme: 'dark' });
  });

  describe('a name sent more than once', () => {
    const core = new CookieCore(SECRET);
    const valid = encodeURIComponent(signCookieValue('abc123', SECRET));
    const forged = encodeURIComponent(signCookieValue('admin', 'other-secret'));

    it('keeps the verified signed value when a plain cookie of the same name follows it', () => {
      const split = core.readCookies(`session=${valid}; session=attacker; theme=dark`);

      expect(split.signedCookies).toEqual({ session: 'abc123' });
      // and the planted value does not stand in for it among the plain cookies
      expect(split.cookies).toEqual({ theme: 'dark' });
    });

    it('keeps the verified signed value when a plain cookie of the same name precedes it', () => {
      const split = core.readCookies(`session=attacker; session=${valid}`);

      expect(split.signedCookies).toEqual({ session: 'abc123' });
      expect(split.cookies).toEqual({});
    });

    it('keeps the verified signed value when a badly signed one follows it', () => {
      const split = core.readCookies(`session=${valid}; session=${forged}`);

      expect(split.signedCookies).toEqual({ session: 'abc123' });
      expect(split.cookies).toEqual({});
    });

    it('never accepts a value that fails verification, wherever it appears', () => {
      expect(core.readCookies(`session=${forged}; session=plain`)).toEqual({
        cookies: { session: 'plain' },
        signedCookies: {},
      });
      expect(core.readCookies(`session=plain; session=${forged}`)).toEqual({
        cookies: {},
        signedCookies: {},
      });
    });

    it('reaches req.signedCookies through the middleware', async () => {
      const mw = createCookieMiddleware(SECRET);
      const req: any = { headers: { cookie: `session=${valid}; session=attacker` } };

      await mw(req, makeRes(), (async () => {}) as any);

      expect(req.signedCookies).toEqual({ session: 'abc123' });
      expect(req.cookies).toEqual({});
    });
  });

  it('reads a header without repeated names exactly as parse-then-split does', () => {
    const signed = encodeURIComponent(signCookieValue('abc123', SECRET));
    const headers = [
      '',
      'theme=dark',
      ` a=1;b=2 ;  c=%7B%22x%22%3A1%7D; session=${signed}`,
      'bad=%E0%A4%A; empty=; =novalue; noequals; spaced = v ; eq=a=b',
      `forged=${encodeURIComponent(signCookieValue('x', 'other-secret'))}; ok=1`,
    ];

    for (const secret of [SECRET, undefined]) {
      const core = new CookieCore(secret);
      for (const header of headers) {
        expect(core.readCookies(header)).toEqual(
          core.splitSignedCookies(core.parseCookies(header))
        );
      }
    }
  });
});

describe('res.cookie with signed: true and no cookie middleware (Node http server)', () => {
  it('throws at the call instead of sending the value unsigned', async () => {
    const server = new MoroHttpServer();
    server.get('/set', (_req: any, res: any) => {
      let message = '';
      try {
        res.cookie('pref', 'dark', { signed: true });
      } catch (error) {
        message = (error as Error).message;
      }
      res.cookie('plain', 'y');
      res.json({ message });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.getServer().address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/set`);
      const { message } = (await res.json()) as { message: string };
      expect(message).toMatch(/res\.cookie\('pref'.*signed: true.*cannot sign/);
      expect(message).toMatch(/middleware\.cookie\(\{ secret/);
      // nothing went out under the name the application wanted signed
      expect(res.headers.getSetCookie()).toEqual(['plain=y; Path=/']);
    } finally {
      server.getServer().closeAllConnections();
      await server.close();
    }
  });
});

describe('cookie secret rotation', () => {
  const NEW = 'new-signing-secret';
  const OLD = 'old-signing-secret';

  it('signs with the first secret', () => {
    const core = new CookieCore([NEW, OLD]);
    const res = makeRes();
    core.setCookie(res, 'session', 'abc123', { signed: true });

    const raw = cookieValue(res, 'session') as string;
    expect(unsignCookieValue(raw, NEW)).toBe('abc123');
    expect(unsignCookieValue(raw, OLD)).toBeNull();
  });

  it('verifies a cookie signed with any listed secret, and with no other', () => {
    const core = new CookieCore([NEW, OLD]);
    const header = [
      `fresh=${encodeURIComponent(signCookieValue('a', NEW))}`,
      `older=${encodeURIComponent(signCookieValue('b', OLD))}`,
      `retired=${encodeURIComponent(signCookieValue('c', 'retired-secret'))}`,
      'plain=d',
    ].join('; ');

    expect(core.readCookies(header)).toEqual({
      cookies: { plain: 'd' },
      signedCookies: { fresh: 'a', older: 'b' },
    });
    expect(unsignCookieValue(signCookieValue('b', OLD), [NEW, OLD])).toBe('b');
    expect(unsignCookieValue(signCookieValue('c', 'retired-secret'), [NEW, OLD])).toBeNull();
  });

  it('is accepted by the middleware factories', async () => {
    const req: any = {
      headers: { cookie: `older=${encodeURIComponent(signCookieValue('b', OLD))}` },
    };
    await createCookieMiddleware([NEW, OLD])(req, makeRes(), (async () => {}) as any);
    expect(req.signedCookies).toEqual({ older: 'b' });
  });

  it('treats an empty list as no secret', () => {
    const core = new CookieCore([]);
    expect(() => core.setCookie(makeRes(), 'session', 'x', { signed: true })).toThrow(
      /no secret is configured/
    );
  });
});

describe('cookie middleware: names, attributes and lifetime', () => {
  const set = (name: string, value: string, options?: Record<string, any>) => {
    const res = makeRes();
    new CookieCore().setCookie(res, name, value, options as any);
    return res.getHeader('Set-Cookie')[0] as string;
  };

  it('sends maxAge, given in milliseconds, as seconds of Max-Age', () => {
    expect(set('a', '1', { maxAge: 24 * 60 * 60 * 1000 })).toBe('a=1; Max-Age=86400; Path=/');
    expect(set('a', '1', { maxAge: 1500 })).toBe('a=1; Max-Age=1; Path=/');
    expect(set('a', '1', { maxAge: 0 })).toBe('a=1; Max-Age=0; Path=/');
    expect(set('a', '1', { maxAge: null })).toBe('a=1; Path=/');
  });

  it('refuses a name that is not a cookie name', () => {
    for (const name of ['', 'a b', 'a=b', 'a;b', 'a,b', 'a\r\nSet-Cookie: x', 'caf\u00e9']) {
      expect(() => set(name, '1')).toThrow(/Invalid cookie name/);
    }
    // Path defaults to '/', as from res.cookie() without the middleware
    expect(set('__Host-sid.v1', '1')).toBe('__Host-sid.v1=1; Path=/');
  });

  it('refuses a domain, path or sameSite that would add attributes', () => {
    expect(() => set('a', '1', { domain: 'example.com; Secure' })).toThrow(/Invalid cookie domain/);
    expect(() => set('a', '1', { domain: 'exa mple.com' })).toThrow(/Invalid cookie domain/);
    expect(() => set('a', '1', { path: '/x; Domain=evil.example' })).toThrow(/Invalid cookie path/);
    expect(() => set('a', '1', { path: '/x\r\nSet-Cookie: y=1' })).toThrow(/Invalid cookie path/);
    expect(() => set('a', '1', { sameSite: 'lax; Domain=evil.example' })).toThrow(
      /Invalid cookie sameSite/
    );
    expect(() => set('a', '1', { sameSite: 'sometimes' })).toThrow(/Invalid cookie sameSite/);

    expect(set('a', '1', { domain: '.example.com', path: '/app,v2', sameSite: 'Lax' })).toBe(
      'a=1; SameSite=Lax; Domain=.example.com; Path=/app,v2'
    );
  });
});

describe('session id signing', () => {
  const options = { secret: SECRET, store: 'memory' as const, name: 'sid' };

  it('signs the session cookie and reads it back', async () => {
    const core = new SessionCore(options);
    const res = makeRes();
    res.cookie = (name: string, value: string) => {
      new CookieCore().setCookie(res, name, value);
      return res;
    };

    await core.createSession({ headers: {} } as any, res);
    const raw = cookieValue(res, 'sid') as string;

    expect(raw.startsWith('s:')).toBe(true);
    expect(core.readSessionId({ headers: {}, cookies: { sid: raw } } as any)).toBe(
      unsignCookieValue(raw, SECRET)
    );
  });

  it('ignores a session id whose signature does not verify', () => {
    const core = new SessionCore(options);

    // Forged, unsigned, and signed-with-the-wrong-key are all rejected
    expect(
      core.readSessionId({ headers: {}, cookies: { sid: 'forged-id' } } as any)
    ).toBeUndefined();
    expect(
      core.readSessionId({
        headers: {},
        cookies: { sid: signCookieValue('forged-id', 'other-secret') },
      } as any)
    ).toBeUndefined();
  });

  it('accepts an id the cookie middleware already verified', () => {
    const core = new SessionCore(options);

    expect(core.readSessionId({ headers: {}, signedCookies: { sid: 'verified-id' } } as any)).toBe(
      'verified-id'
    );
  });

  it('passes the raw id through when no secret is configured', () => {
    const core = new SessionCore({ store: 'memory', name: 'sid' });

    expect(core.readSessionId({ headers: {}, cookies: { sid: 'plain-id' } } as any)).toBe(
      'plain-id'
    );
  });
});

describe('upload dest', () => {
  let dest: string;

  beforeAll(async () => {
    dest = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-upload-')));
  });

  afterAll(async () => {
    await fs.rm(dest, { recursive: true, force: true });
  });

  const makeFile = (filename: string, contents: string) => ({
    filename,
    mimetype: 'text/plain',
    data: Buffer.from(contents),
    size: contents.length,
  });

  // The middleware reads files only from the multipart parser's output, which
  // carries this brand; a hand-built body stands in for it here.
  const parsedBody = (files: Record<string, any>) =>
    Object.defineProperty({ files }, MULTIPART_BODY, { value: true });

  it('writes files to disk and records where they went', async () => {
    const core = new UploadCore({ dest });
    const files: Record<string, any> = { report: makeFile('report.txt', 'hello') };

    await core.persistFiles(files);

    expect(files.report.destination).toBe(dest);
    expect(files.report.path).toContain('report.txt');
    expect(await fs.readFile(files.report.path, 'utf8')).toBe('hello');
  });

  it('does not write anything when no dest is configured', async () => {
    const core = new UploadCore();
    const files: Record<string, any> = { report: makeFile('report.txt', 'hello') };

    await core.persistFiles(files);

    expect(files.report.path).toBeUndefined();
  });

  it('keeps same-named uploads from overwriting each other', async () => {
    const core = new UploadCore({ dest });
    const first: Record<string, any> = { f: makeFile('same.txt', 'first') };
    const second: Record<string, any> = { f: makeFile('same.txt', 'second') };

    await core.persistFiles(first);
    await core.persistFiles(second);

    expect(first.f.path).not.toBe(second.f.path);
    expect(await fs.readFile(first.f.path, 'utf8')).toBe('first');
    expect(await fs.readFile(second.f.path, 'utf8')).toBe('second');
  });

  it('never lets a crafted filename escape the destination', async () => {
    const core = new UploadCore({ dest });
    const files: Record<string, any> = { evil: makeFile('../../escaped.txt', 'nope') };

    await core.persistFiles(files);

    expect(path.dirname(files.evil.path)).toBe(dest);
    expect(files.evil.path).toContain('escaped.txt');
  });

  it('persists through the middleware after validation passes', async () => {
    const mw = createUploadMiddleware({ dest });
    const req = makeReq({ 'content-type': 'multipart/form-data; boundary=x' });
    (req as any).body = parsedBody({ doc: makeFile('doc.txt', 'via middleware') });
    let nextCalled = false;

    await mw(req, makeRes(), () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(await fs.readFile((req as any).files.doc.path, 'utf8')).toBe('via middleware');
  });

  it('does not write files that failed validation', async () => {
    const mw = createUploadMiddleware({ dest, allowedTypes: ['image/png'] });
    const req = makeReq({ 'content-type': 'multipart/form-data; boundary=x' });
    (req as any).body = parsedBody({ doc: makeFile('rejected.txt', 'nope') });
    const res = makeRes();
    let nextCalled = false;

    await mw(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    expect((req as any).files.doc.path).toBeUndefined();
    const written = await fs.readdir(dest);
    expect(written.some(f => f.includes('rejected.txt'))).toBe(false);
  });
});
