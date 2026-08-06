import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CookieCore,
  signCookieValue,
  unsignCookieValue,
} from '../../../src/core/middleware/built-in/cookie/index.js';
import { createCookieMiddleware } from '../../../src/core/middleware/built-in/cookie/middleware.js';
import { SessionCore } from '../../../src/core/middleware/built-in/session/index.js';
import { UploadCore } from '../../../src/core/middleware/built-in/upload/index.js';
import { createUploadMiddleware } from '../../../src/core/middleware/built-in/upload/middleware.js';

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
    (req as any).body = { files: { doc: makeFile('doc.txt', 'via middleware') } };
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
    (req as any).body = { files: { doc: makeFile('rejected.txt', 'nope') } };
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
