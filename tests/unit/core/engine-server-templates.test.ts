// @ts-nocheck
// Unit Tests - MoroEngineServer prepared response templates.
//
// Every response shape the adapter can emit is run against a fake engine
// WITHOUT templates (a 1.1.x engine: capabilities absent) and WITH them (a
// 1.1.6 engine: capabilities.responseTemplates), and the ops that reached the
// "wire" must be identical - the template path may only change WHICH native
// call ran, never the status, headers or body. Plus: templates are prepared
// exactly once per (kind, status), never used when the app set headers or
// compression is on, never assigned when the flag is set but a function is
// missing, and re-prepared after close() + listen().
import { describe, it, expect } from '@jest/globals';
import { MoroEngineServer } from '../../../src/core/http/moro-engine-server.js';
import { createFakeEngine, foldFlat, wireOps } from '../../utils/fake-engine.js';
import { getEngineCapabilities } from '../../../src/core/utilities/package-utils.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

const TEMPLATE_CAPS = {
  limits: true,
  tls: true,
  http2: false,
  wsDeflate: true,
  responseLimits: true,
  tlsPolicy: true,
  staticRoutes: true,
  responseTemplates: true,
  asyncNotify: true,
  workerThreads: true,
  fastCalls: true,
};

function createServer(engine: any, options: any = {}) {
  const capabilities = getEngineCapabilities(engine);
  const server = new MoroEngineServer({ engineModule: engine, capabilities, ...options });
  return server;
}

// Run `handler` for one request on both engines; return both op lists.
async function bothWays(
  handler: (req: any, res: any) => any,
  simulate: any = {},
  serverOptions: any = {}
) {
  const plain = createFakeEngine();
  const templated = createFakeEngine({ capabilities: TEMPLATE_CAPS });
  const out: any[] = [];
  for (const engine of [plain, templated]) {
    const server = createServer(engine, serverOptions);
    server.setRouterHandler((req, res) => {
      handler(req, res);
      return true;
    });
    const reqId = engine.simulate(simulate);
    await tick();
    await tick();
    out.push({ engine, ops: engine.requests.get(reqId).ops });
  }
  return { plain: out[0], templated: out[1] };
}

const SCENARIOS: Array<[string, (req: any, res: any) => void, any?]> = [
  ['json 200', (_req, res) => res.json({ success: true, data: 'x' })],
  ['status(201).json', (_req, res) => res.status(201).json({ created: true })],
  ['send JSON-looking string', (_req, res) => res.send('{"a":1}')],
  ['send text', (_req, res) => res.send('hello')],
  ['send Buffer', (_req, res) => res.send(Buffer.from([1, 2, 3]))],
  ['sendStatus(404)', (_req, res) => res.sendStatus(404)],
  ['sendStatus(599) (unknown code)', (_req, res) => res.sendStatus(599)],
  ['noContent()', (_req, res) => res.noContent()],
  ['end()', (_req, res) => res.end()],
  ['status(500).end("x")', (_req, res) => res.status(500).end('x')],
  ['end("") empty string', (_req, res) => res.end('')],
  [
    'setHeader then json (user header => never a template)',
    (_req, res) => {
      res.setHeader('X-Custom', '1');
      res.json({ ok: true });
    },
  ],
  [
    'setHeader then send',
    (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.send('t');
    },
  ],
  [
    'writeHead + write + end("tail") streaming',
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('a');
      res.end('b');
    },
  ],
  [
    'writeHead + end() streaming without chunk',
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end();
    },
  ],
];

describe('MoroEngineServer prepared response templates (fake engine)', () => {
  describe('wire parity: templated engine == plain engine', () => {
    for (const [name, handler] of SCENARIOS) {
      it(name, async () => {
        const { plain, templated } = await bothWays(handler);
        expect(wireOps(templated.ops)).toEqual(wireOps(plain.ops));
      });
    }

    it('framework 404 (router miss) is byte-equivalent and needs no header object', async () => {
      const plain = createFakeEngine();
      const templated = createFakeEngine({ capabilities: TEMPLATE_CAPS });
      const results: any[] = [];
      for (const engine of [plain, templated]) {
        const server = createServer(engine);
        server.setRouterHandler(() => false); // miss
        const reqId = engine.simulate({ path: '/nope' });
        await tick();
        await tick();
        results.push(engine.requests.get(reqId).ops);
      }
      expect(wireOps(results[1])).toEqual(wireOps(results[0]));
      expect(results[0][0].status).toBe(404);
      expect(foldFlat(results[0][0].headersFlat)['content-type']).toEqual(['application/json']);
      expect(results[0][0].body).toBe('{"success":false,"error":"Not found"}');
      expect(results[1][0].viaTemplate).toBe(true);
    });

    it('framework 500 (handler throws) is byte-equivalent', async () => {
      const { plain, templated } = await bothWays(() => {
        throw new Error('boom');
      });
      expect(wireOps(templated.ops)).toEqual(wireOps(plain.ops));
      expect(plain.ops[0].status).toBe(500);
      expect(plain.ops[0].body).toBe('{"success":false,"error":"Internal server error"}');
    });

    it('framework 400 (malformed JSON body) is byte-equivalent', async () => {
      const { plain, templated } = await bothWays((_req, res) => res.json({ ok: true }), {
        method: 'POST',
        path: '/p',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      expect(wireOps(templated.ops)).toEqual(wireOps(plain.ops));
      expect(plain.ops[0].status).toBe(400);
    });
  });

  describe('which native call ran', () => {
    it('json()/send()/end()/sendStatus() use respondPrepared on a template engine', async () => {
      const engine = createFakeEngine({ capabilities: TEMPLATE_CAPS });
      const server = createServer(engine);
      const cases: Array<[string, (res: any) => void, string]> = [
        ['/json', res => res.json({ a: 1 }), 'respondPrepared'],
        ['/send', res => res.send('x'), 'respondPrepared'],
        ['/end', res => res.end(), 'respondPreparedEmpty'],
        ['/status', res => res.sendStatus(404), 'respondPrepared'],
      ];
      server.setRouterHandler((req, res) => {
        cases.find(c => c[0] === req.path)![1](res);
        return true;
      });
      for (const [path, , native] of cases) {
        const reqId = engine.simulate({ path });
        await tick();
        const op = engine.requests.get(reqId).ops[0];
        expect(op.viaTemplate).toBe(true);
        if (native === 'respondPreparedEmpty') expect(op.body).toBeNull();
      }
    });

    it('prepares each (kind, status) exactly once across many responses', async () => {
      const engine = createFakeEngine({ capabilities: TEMPLATE_CAPS });
      const server = createServer(engine);
      server.setRouterHandler((req, res) => {
        if (req.path === '/a') res.json({ a: 1 });
        else if (req.path === '/b') res.status(201).json({ b: 1 });
        else res.send('text');
        return true;
      });
      for (let i = 0; i < 100; i++) {
        engine.simulate({ path: ['/a', '/b', '/c'][i % 3] });
      }
      await tick();
      expect(engine.prepareCalls).toHaveLength(3);
      expect(engine.prepareCalls.map(c => c.status).sort()).toEqual([200, 200, 201]);
    });

    it('never prepares when the capability is absent, or when the flag is set but a function is missing', async () => {
      for (const engine of [
        createFakeEngine(),
        createFakeEngine({ capabilities: TEMPLATE_CAPS, omitFunctions: ['respondPreparedEmpty'] }),
        createFakeEngine({ capabilities: TEMPLATE_CAPS, omitFunctions: ['endWith'] }),
      ]) {
        const server = createServer(engine);
        server.setRouterHandler((_req, res) => {
          res.json({ ok: true });
          return true;
        });
        const reqId = engine.simulate({ path: '/' });
        await tick();
        expect(engine.prepareCalls).toHaveLength(0);
        expect(engine.requests.get(reqId).ops[0].viaTemplate).toBeUndefined();
      }
    });

    it('user-set headers or compression keep the respond() path', async () => {
      const engine = createFakeEngine({ capabilities: TEMPLATE_CAPS });
      const server = createServer(engine);
      server.setRouterHandler((req, res) => {
        if (req.path === '/h') {
          res.setHeader('X-A', '1');
          res.json({ ok: true });
        } else res.send('plain');
        return true;
      });
      const a = engine.simulate({ path: '/h' });
      await tick();
      expect(engine.requests.get(a).ops[0].viaTemplate).toBeUndefined();
      expect(foldFlat(engine.requests.get(a).ops[0].headersFlat)).toEqual({
        'x-a': ['1'],
        'content-type': ['application/json'],
      });

      const compressed = createFakeEngine({ capabilities: TEMPLATE_CAPS });
      const cserver = createServer(compressed);
      // Compression is wired through configurePerformance() (as Moro does at
      // boot), not the constructor options.
      cserver.configurePerformance({ compression: { enabled: true, threshold: 1024 } });
      cserver.setRouterHandler((_req, res) => {
        res.json({ ok: true });
        return true;
      });
      const b = compressed.simulate({ path: '/' });
      await tick();
      expect(compressed.requests.get(b).ops[0].viaTemplate).toBeUndefined();
      expect(compressed.prepareCalls).toHaveLength(0);
    });

    it('re-prepares after close() + listen() (template ids belong to one native server)', async () => {
      const engine = createFakeEngine({ capabilities: TEMPLATE_CAPS });
      const server = createServer(engine);
      server.setRouterHandler((_req, res) => {
        res.json({ ok: true });
        return true;
      });
      server.listen(0);
      engine.simulate({ path: '/' });
      await tick();
      expect(engine.prepareCalls).toHaveLength(1);
      const firstServerId = engine.prepareCalls[0].serverId;
      await new Promise<void>(resolve => server.close(() => resolve()));
      server.listen(0);
      engine.simulate({ path: '/' });
      await tick();
      expect(engine.prepareCalls).toHaveLength(2);
      expect(engine.prepareCalls[1].serverId).not.toBe(firstServerId);
    });

    it('getHeader("content-type") and responseHeaders still answer after a template send()', async () => {
      const engine = createFakeEngine({ capabilities: TEMPLATE_CAPS });
      const server = createServer(engine);
      let seen: any = null;
      server.setRouterHandler((_req, res) => {
        res.send('hello');
        seen = {
          ct: res.getHeader('Content-Type'),
          obj: res.responseHeaders['content-type'],
          other: res.getHeader('x-none'),
        };
        return true;
      });
      engine.simulate({ path: '/' });
      await tick();
      expect(seen).toEqual({
        ct: 'text/plain; charset=utf-8',
        obj: 'text/plain; charset=utf-8',
        other: undefined,
      });
    });

    it('streaming end(chunk) uses endWith on a template engine, end() otherwise', async () => {
      const engine = createFakeEngine({ capabilities: TEMPLATE_CAPS });
      const server = createServer(engine);
      server.setRouterHandler((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('a');
        if (req.path === '/chunk') res.end('b');
        else res.end();
        return true;
      });
      const a = engine.simulate({ path: '/chunk' });
      const b = engine.simulate({ path: '/plain' });
      await tick();
      const opsA = engine.requests.get(a).ops;
      const opsB = engine.requests.get(b).ops;
      expect(opsA[opsA.length - 1]).toEqual({ type: 'end', chunk: 'b', viaEndWith: true });
      expect(opsB[opsB.length - 1]).toEqual({ type: 'end', chunk: undefined });
    });
  });

  describe('getEngineCapabilities', () => {
    it('maps every flag with === true and defaults the rest to false', () => {
      const caps = getEngineCapabilities({
        probe: () => ({
          ok: true,
          capabilities: { responseTemplates: true, workerThreads: 'yes', limits: 1 },
          transport: 'uring',
        }),
      });
      expect(caps.responseTemplates).toBe(true);
      expect(caps.workerThreads).toBe(false);
      expect(caps.limits).toBe(false);
      expect(caps.fastCalls).toBe(false);
      expect(caps.transport).toBe('uring');
    });

    it('tolerates a throwing or missing probe()', () => {
      expect(
        getEngineCapabilities({
          probe: () => {
            throw new Error('x');
          },
        }).responseTemplates
      ).toBe(false);
      expect(getEngineCapabilities({ serve() {} }).limits).toBe(false);
    });
  });
});
