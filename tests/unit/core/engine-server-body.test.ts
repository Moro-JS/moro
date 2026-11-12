// @ts-nocheck
// Unit Tests - MoroEngineServer request bodies.
//
// An engine with the typed reads (capabilities.bodyText: getBodyType /
// getBodyText) hands a decodable ASCII body over as a string, and one with
// capabilities.bodyLent can lend an unparsed body for the request's lifetime
// (server.lendBodies). Neither may change what a handler sees: every body
// here is run on an engine without the capabilities and on one with them and
// must give the same req.body and the same req.rawBody. What changes is which
// native calls were made, and that is pinned too.
import { describe, it, expect } from '@jest/globals';
import { MoroEngineServer } from '../../../src/core/http/moro-engine-server.js';
import { createFakeEngine } from '../../utils/fake-engine.js';
import { getEngineCapabilities } from '../../../src/core/utilities/package-utils.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

const BASE_CAPS = {
  limits: true,
  tls: true,
  responseTemplates: true,
  asyncNotify: true,
  callbackScope: true,
};
const TYPED = { ...BASE_CAPS, bodyText: true, bodyLent: true };

function createServer(engine: any, options: any = {}) {
  return new MoroEngineServer({
    engineModule: engine,
    capabilities: getEngineCapabilities(engine),
    ...options,
  });
}

// One request; resolves to what the handler saw and what was answered.
async function run(engine: any, simulate: any, options: any = {}, handler?: any) {
  const server = createServer(engine, options);
  const seen: any = { called: false };
  server.setRouterHandler((req, res) => {
    seen.called = true;
    seen.req = req;
    seen.body = req.body;
    if (handler) return handler(req, res, seen) ?? true;
    seen.rawBody = req.rawBody;
    res.json({ ok: true });
    return true;
  });
  const reqId = engine.simulate({ method: 'POST', path: '/b', ...simulate });
  await tick();
  await tick();
  return { seen, ops: engine.requests.get(reqId).ops, calls: engine.bodyCalls, server };
}

const utf8 = (s: string) => Buffer.from(s, 'utf8');

const BODIES: Array<[string, any]> = [
  [
    'JSON, ASCII',
    { headers: { 'content-type': 'application/json' }, body: '{"a":1,"b":["x","y"]}' },
  ],
  [
    'JSON with a charset parameter',
    { headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"n":null}' },
  ],
  [
    'JSON, non-ASCII',
    { headers: { 'content-type': 'application/json' }, body: utf8('{"name":"Zoë ☕"}') },
  ],
  [
    'form, ASCII',
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=two+words&c=%C3%A9',
    },
  ],
  [
    'form, non-ASCII',
    { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: utf8('name=Zoë') },
  ],
  ['text, ASCII', { headers: { 'content-type': 'text/plain' }, body: 'hello world' }],
  [
    'text, non-ASCII',
    { headers: { 'content-type': 'text/plain; charset=utf-8' }, body: utf8('héllo') },
  ],
  ['no content type', { body: '42' }],
  [
    'binary',
    {
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([0, 1, 2, 255, 254]),
    },
  ],
  [
    'binary whose bytes happen to be ASCII',
    { headers: { 'content-type': 'application/octet-stream' }, body: 'looks-like-text' },
  ],
  [
    'image',
    { headers: { 'content-type': 'image/png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ],
  [
    'multipart',
    {
      headers: { 'content-type': 'multipart/form-data; boundary=XX' },
      body: '--XX\r\nContent-Disposition: form-data; name="f"\r\n\r\nv\r\n--XX--\r\n',
    },
  ],
];

describe('MoroEngineServer request bodies (fake engine)', () => {
  describe('same req.body and req.rawBody with and without the typed reads', () => {
    for (const [name, simulate] of BODIES) {
      it(name, async () => {
        const legacy = await run(createFakeEngine({ capabilities: BASE_CAPS }), simulate);
        const typed = await run(createFakeEngine({ capabilities: TYPED }), simulate);
        const lending = await run(
          createFakeEngine({ capabilities: TYPED }),
          simulate,
          {
            lendBodies: true,
          },
          (req, res, seen) => {
            // a lent body is only read while the request is open
            seen.rawBody = req.rawBody && Buffer.from(req.rawBody);
            seen.body = Buffer.isBuffer(req.body) ? Buffer.from(req.body) : req.body;
            res.json({ ok: true });
            return true;
          }
        );
        expect(legacy.seen.called).toBe(true);
        for (const other of [typed, lending]) {
          expect(other.seen.body).toEqual(legacy.seen.body);
          expect(Buffer.isBuffer(other.seen.body)).toBe(Buffer.isBuffer(legacy.seen.body));
          expect(other.seen.rawBody).toEqual(legacy.seen.rawBody);
          expect(Buffer.isBuffer(other.seen.rawBody)).toBe(true);
        }
        const bytes = Buffer.isBuffer(simulate.body) ? simulate.body : Buffer.from(simulate.body);
        expect(legacy.seen.rawBody.equals(bytes)).toBe(true);
      });
    }
  });

  describe('which native reads are made', () => {
    it('no body: one call, and nothing is parsed', async () => {
      const { seen, calls } = await run(createFakeEngine({ capabilities: TYPED }), {});
      expect(calls).toEqual(['getBodyType']);
      expect(seen.body).toBe(null);
      expect(seen.rawBody).toBe(null);
    });

    it('an ASCII JSON body never becomes a buffer unless rawBody is read', async () => {
      const engine = createFakeEngine({ capabilities: TYPED });
      const { seen, calls } = await run(
        engine,
        { headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
        {},
        (req, res, s) => {
          s.rawBefore = req._rawBody;
          res.json({ ok: true });
          return true;
        }
      );
      expect(calls).toEqual(['getBodyType', 'getBodyText']);
      expect(seen.body).toEqual({ a: 1 });
      expect(seen.rawBefore).toBe(undefined);
      // ...and is still there to read afterwards, as the exact bytes
      expect(seen.req.rawBody.toString('latin1')).toBe('{"a":1}');
      expect(seen.req.rawBody).toBe(seen.req.rawBody);
    });

    it('a non-ASCII JSON body falls back to the bytes', async () => {
      const { seen, calls } = await run(createFakeEngine({ capabilities: TYPED }), {
        headers: { 'content-type': 'application/json' },
        body: utf8('{"s":"é"}'),
      });
      expect(calls).toEqual(['getBodyType', 'getBodyText', 'getBody']);
      expect(seen.body).toEqual({ s: 'é' });
    });

    it('a binary body is not read as text, even when its bytes are ASCII', async () => {
      const { seen, calls } = await run(createFakeEngine({ capabilities: TYPED }), {
        headers: { 'content-type': 'application/octet-stream' },
        body: 'ascii',
      });
      expect(calls).toEqual(['getBodyType', 'getBody']);
      expect(Buffer.isBuffer(seen.body)).toBe(true);
    });

    it('an engine without the capability is read the old way', async () => {
      const { calls } = await run(createFakeEngine({ capabilities: BASE_CAPS }), {
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      });
      expect(calls).toEqual(['getBody']);
    });

    it('the capability without the functions changes nothing', async () => {
      const engine = createFakeEngine({ capabilities: TYPED });
      delete engine.getBodyText;
      const { seen, calls } = await run(engine, {
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      });
      expect(calls).toEqual(['getBody']);
      expect(seen.body).toEqual({ a: 1 });
    });
  });

  describe('errors keep their status on the text path', () => {
    it('malformed JSON is a 400', async () => {
      const { seen, ops } = await run(createFakeEngine({ capabilities: TYPED }), {
        headers: { 'content-type': 'application/json' },
        body: '{"a":',
      });
      expect(seen.called).toBe(false);
      expect(ops[ops.length - 1].status).toBe(400);
    });

    it('a body over server.bodySizeLimit is a 413', async () => {
      const { seen, ops } = await run(
        createFakeEngine({ capabilities: TYPED }),
        { headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(65) },
        { maxBodySize: 64 }
      );
      expect(seen.called).toBe(false);
      expect(ops[ops.length - 1].status).toBe(413);
    });

    it('the app error handler sees both, as on the byte path', async () => {
      const statuses: number[] = [];
      for (const caps of [BASE_CAPS, TYPED]) {
        const engine = createFakeEngine({ capabilities: caps });
        const server = createServer(engine);
        server.setRouterHandler(() => true);
        server.setErrorHandler((err, _req, res) => {
          res.status(422).json({ handled: err.statusCode });
        });
        const reqId = engine.simulate({
          method: 'POST',
          path: '/b',
          headers: { 'content-type': 'application/json' },
          body: 'not json',
        });
        await tick();
        await tick();
        const ops = engine.requests.get(reqId).ops;
        statuses.push(ops[ops.length - 1].status);
      }
      expect(statuses).toEqual([422, 422]);
    });
  });

  describe('server.lendBodies', () => {
    const binary = {
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('0123456789abcdef'),
    };

    it('is off by default: the body is handed over and outlives the response', async () => {
      const { seen, calls } = await run(createFakeEngine({ capabilities: TYPED }), binary);
      expect(calls).toEqual(['getBodyType', 'getBody']);
      expect(seen.body.length).toBe(16);
    });

    it('lends an unparsed body: readable in the handler, empty after the response', async () => {
      const { seen, calls } = await run(
        createFakeEngine({ capabilities: TYPED }),
        binary,
        { lendBodies: true },
        (req, res, s) => {
          s.during = req.body.toString('latin1');
          s.rawIsBody = req.rawBody === req.body;
          res.send(req.body);
          return true;
        }
      );
      expect(calls).toEqual(['getBodyType', 'getBodyLent']);
      expect(seen.during).toBe('0123456789abcdef');
      expect(seen.rawIsBody).toBe(true);
      expect(seen.body.length).toBe(0);
    });

    it('stays readable across an asynchronous handler', async () => {
      const engine = createFakeEngine({ capabilities: TYPED });
      const server = createServer(engine, { lendBodies: true });
      const seen: any = {};
      server.setRouterHandler(async (req, res) => {
        await tick();
        seen.late = req.body.toString('latin1');
        res.send('done');
        seen.after = req.body.length;
        return true;
      });
      engine.simulate({ method: 'POST', path: '/b', ...binary });
      for (let i = 0; i < 4; i++) await tick();
      expect(seen.late).toBe('0123456789abcdef');
      expect(seen.after).toBe(0);
    });

    it('never lends what the framework parses or what outlives the request', async () => {
      const parsed = [
        { headers: { 'content-type': 'application/json' }, body: utf8('{"s":"é"}') },
        { headers: { 'content-type': 'text/plain' }, body: utf8('é') },
        {
          headers: { 'content-type': 'multipart/form-data; boundary=XX' },
          body: '--XX\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\n\r\nDATA\r\n--XX--\r\n',
        },
      ];
      for (const simulate of parsed) {
        const { seen, calls } = await run(createFakeEngine({ capabilities: TYPED }), simulate, {
          lendBodies: true,
        });
        expect(calls).not.toContain('getBodyLent');
        expect(seen.req.rawBody.length).toBeGreaterThan(0);
      }
      const multipart = await run(createFakeEngine({ capabilities: TYPED }), parsed[2], {
        lendBodies: true,
      });
      expect(multipart.seen.body.files.f.data.toString()).toBe('DATA');
    });

    it('is ignored by an engine that cannot lend', async () => {
      const { seen, calls } = await run(
        createFakeEngine({ capabilities: { ...BASE_CAPS, bodyText: true } }),
        binary,
        { lendBodies: true }
      );
      expect(calls).toEqual(['getBodyType', 'getBody']);
      expect(seen.body.length).toBe(16);
    });
  });
});
