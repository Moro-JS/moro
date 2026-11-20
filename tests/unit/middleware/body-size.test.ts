// bodySize() middleware and the body-parser `limit` options.
//
//   - the multipart exemption applies to the multipart/form-data media type
//     only; a Content-Type that merely mentions it is limited like any other
//   - a request with Content-Length is judged by the header; one without it
//     (chunked) is measured by the body that was received
//   - json()/urlencoded()/raw()/text() apply their `limit` to the bodies
//     they handle and answer 413 over it
import { describe, it, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import { BodySizeCore } from '../../../src/core/middleware/built-in/body-size/index.js';
import { createBodySizeMiddleware } from '../../../src/core/middleware/built-in/body-size/middleware.js';

// One shared logger double, so warnings logged when a parser is created can
// be read back (the real loggers are module-level instances).
jest.mock('../../../src/core/logger/index.js', () => {
  const shared = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createFrameworkLogger: () => shared };
});

type Parsers = typeof import('../../../src/core/middleware/built-in/body-parsers/index.js');

let parsers: Parsers;
let log: { warn: jest.Mock };
const warnings = (): string[] => log.warn.mock.calls.map(call => String(call[0]));

beforeAll(async () => {
  // tests/setup.ts has already loaded the framework against the real logger;
  // load the parsers again, against the double above.
  jest.resetModules();
  parsers = await import('../../../src/core/middleware/built-in/body-parsers/index.js');
  const { createFrameworkLogger } = await import('../../../src/core/logger/index.js');
  log = createFrameworkLogger('test') as unknown as typeof log;
});

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
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

/** Whether a request with these headers/body passes a 1 KB limit */
function check(headers: Record<string, string>, extra: Record<string, unknown> = {}) {
  const core = new BodySizeCore({ limit: '1kb' });
  const res = makeRes();
  const allowed = core.checkBodySize({ headers, ...extra } as any, res);
  return { allowed, res };
}

const BIG = 'x'.repeat(5000);

describe('bodySize()', () => {
  describe('multipart exemption', () => {
    it('applies to the multipart/form-data media type', () => {
      for (const contentType of [
        'multipart/form-data; boundary=x',
        'multipart/form-data',
        'Multipart/Form-Data ; boundary=x',
      ]) {
        const { allowed } = check({ 'content-type': contentType, 'content-length': '500000' });
        expect(allowed).toBe(true);
      }
    });

    it.each([
      'application/json; x=multipart/form-data',
      'application/json;multipart/form-data',
      'application/x-multipart/form-data',
      'text/plain; note="multipart/form-data"',
    ])('does not apply to a type that only mentions it: %s', contentType => {
      const { allowed, res } = check({ 'content-type': contentType, 'content-length': '500000' });
      expect(allowed).toBe(false);
      expect(res.statusCode).toBe(413);
    });
  });

  describe('requests with Content-Length', () => {
    it('are judged by the header', () => {
      expect(check({ 'content-length': '1024' }).allowed).toBe(true);
      const over = check({ 'content-type': 'application/json', 'content-length': '1025' });
      expect(over.allowed).toBe(false);
      expect(over.res.statusCode).toBe(413);
      expect(over.res.body).toMatchObject({ error: 'Request entity too large', limit: '1.00KB' });
    });

    it('never look at the body', () => {
      const req: any = { headers: { 'content-length': '10' } };
      for (const key of ['body', 'rawBody']) {
        Object.defineProperty(req, key, {
          get() {
            throw new Error(`${key} was read for a request that declared its length`);
          },
        });
      }
      const core = new BodySizeCore({ limit: '1kb' });
      expect(core.checkBodySize(req, makeRes())).toBe(true);
    });
  });

  describe('requests without Content-Length (chunked)', () => {
    const chunked = { 'content-type': 'application/json', 'transfer-encoding': 'chunked' };

    it('are measured by the raw body the server retained', () => {
      const parsed = { a: 1 };
      const over = check(chunked, { body: parsed, rawBody: Buffer.alloc(5000) });
      expect(over.allowed).toBe(false);
      expect(over.res.statusCode).toBe(413);
      expect(over.res.body.received).toBe('4.88KB');

      expect(check(chunked, { body: parsed, rawBody: Buffer.alloc(1024) }).allowed).toBe(true);
    });

    it('are measured by a string or Buffer body when no raw bytes were kept', () => {
      expect(check(chunked, { body: BIG }).allowed).toBe(false);
      expect(check(chunked, { body: Buffer.alloc(5000) }).allowed).toBe(false);
      expect(check(chunked, { body: 'small' }).allowed).toBe(true);
      expect(check(chunked, { body: Buffer.alloc(8) }).allowed).toBe(true);
      // bytes, not characters
      expect(check(chunked, { body: 'é'.repeat(600) }).allowed).toBe(false);
    });

    it('are measured by the serialized size of a parsed body as a last resort', () => {
      expect(check(chunked, { body: { a: BIG } }).allowed).toBe(false);
      expect(check(chunked, { body: { a: 'ok' } }).allowed).toBe(true);
    });

    it('pass when there is no body at all', () => {
      expect(check({}).allowed).toBe(true);
      expect(check({}, { body: null, rawBody: null }).allowed).toBe(true);
      expect(check({}, { body: undefined }).allowed).toBe(true);
    });

    it('leave real multipart uploads to the upload limit', () => {
      const upload = check(
        { 'content-type': 'multipart/form-data; boundary=x' },
        { body: { files: {} }, rawBody: Buffer.alloc(5000) }
      );
      expect(upload.allowed).toBe(true);
    });

    it('are rejected through the middleware without reaching next()', () => {
      const mw = createBodySizeMiddleware({ limit: '1kb' });
      const res = makeRes();
      let nextCalled = false;
      mw({ headers: chunked, body: { a: BIG }, rawBody: Buffer.from(BIG) } as any, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(413);
    });
  });
});

describe('body parser `limit`', () => {
  beforeEach(() => {
    log.warn.mockClear();
  });

  /** Run one request through a parser: was next() reached, and what was answered */
  function run(mw: any, headers: Record<string, string>, extra: Record<string, unknown> = {}) {
    const res = makeRes();
    let nextCalled = false;
    mw({ headers, ...extra } as any, res, () => {
      nextCalled = true;
    });
    return { nextCalled, res };
  }

  const TOO_LARGE = { success: false, error: 'Request entity too large' };

  it.each([
    ['json', () => parsers.json({ limit: '1kb' }), 'application/json; charset=utf-8'],
    [
      'urlencoded',
      () => parsers.urlencoded({ extended: true, limit: 1024 }),
      'application/x-www-form-urlencoded',
    ],
    ['raw', () => parsers.raw({ limit: '1kb' }), 'application/octet-stream'],
    ['text', () => parsers.text({ limit: '1kb' }), 'text/plain'],
  ])('%s({ limit }) answers 413 for a body over the limit', (_name, create, contentType) => {
    const mw = create();

    const over = run(mw, { 'content-type': contentType, 'content-length': '1025' });
    expect(over.nextCalled).toBe(false);
    expect(over.res.statusCode).toBe(413);
    expect(over.res.body).toEqual(TOO_LARGE);

    const atLimit = run(mw, { 'content-type': contentType, 'content-length': '1024' });
    expect(atLimit.nextCalled).toBe(true);
    expect(atLimit.res.statusCode).toBe(200);

    // nothing to say when the limit is one that can be applied
    expect(warnings()).toEqual([]);
  });

  it('measures a chunked body by what was received', () => {
    const chunked = { 'content-type': 'application/json', 'transfer-encoding': 'chunked' };
    const mw = parsers.json({ limit: '1kb' });

    const over = run(mw, chunked, { body: { a: BIG }, rawBody: Buffer.from(BIG) });
    expect(over.nextCalled).toBe(false);
    expect(over.res.statusCode).toBe(413);

    expect(run(mw, chunked, { body: { a: 1 }, rawBody: Buffer.from('{"a":1}') }).nextCalled).toBe(
      true
    );
    expect(
      run(parsers.text({ limit: 16 }), { 'content-type': 'text/plain' }, { body: BIG })
    ).toMatchObject({
      nextCalled: false,
    });
  });

  it('applies only to the content types the parser handles, and still converts those', () => {
    const form: any = {
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '7' },
      body: 'a=1&b=2',
    };
    parsers.urlencoded({ limit: '1kb' })(form, makeRes(), () => undefined);
    expect(form.body).toEqual({ a: '1', b: '2' });

    const text: any = {
      headers: { 'content-type': 'text/plain', 'content-length': '2' },
      body: Buffer.from('hi'),
    };
    parsers.text({ limit: '1kb' })(text, makeRes(), () => undefined);
    expect(text.body).toBe('hi');

    const big = { 'content-length': '5000' };
    // a form body is not json()'s to limit, and the other way round
    expect(
      run(parsers.json({ limit: 10 }), { ...big, 'content-type': 'text/plain' }).nextCalled
    ).toBe(true);
    expect(
      run(parsers.urlencoded({ limit: 10 }), { ...big, 'content-type': 'application/json' })
        .nextCalled
    ).toBe(true);
    expect(
      run(parsers.raw({ limit: 10 }), { ...big, 'content-type': 'application/json' }).nextCalled
    ).toBe(true);
    expect(
      run(parsers.text({ limit: 10 }), { ...big, 'content-type': 'application/json' }).nextCalled
    ).toBe(true);
    // the `type` option decides for raw() and text()
    expect(
      run(parsers.raw({ limit: 10, type: 'image/*' }), { ...big, 'content-type': 'image/png' })
        .nextCalled
    ).toBe(false);
    expect(
      run(parsers.text({ limit: 10, type: 'application/xml' }), {
        ...big,
        'content-type': 'application/xml',
      }).nextCalled
    ).toBe(false);
  });

  it('reports a limit it cannot read, once, and does not apply it', () => {
    const mw = parsers.json({ limit: '1 megabyte' });
    const logged = warnings();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('json(');
    expect(logged[0]).toContain('1 megabyte');
    expect(logged[0]).toContain('not applied');

    const res = run(mw, { 'content-type': 'application/json', 'content-length': '5000000' });
    expect(res.nextCalled).toBe(true);

    // Parsers created without a limit say nothing and limit nothing
    log.warn.mockClear();
    const unlimited: Array<[any, string]> = [
      [parsers.json(), 'application/json'],
      [parsers.json({ strict: true }), 'application/json'],
      [parsers.urlencoded({ extended: true }), 'application/x-www-form-urlencoded'],
      [parsers.raw({ type: 'application/octet-stream' }), 'application/octet-stream'],
      [parsers.text(), 'text/plain'],
    ];
    expect(warnings()).toEqual([]);
    for (const [parser, contentType] of unlimited) {
      const headers = { 'content-type': contentType, 'content-length': '50000000' };
      expect(run(parser, headers).nextCalled).toBe(true);
    }
  });
});
