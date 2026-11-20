/* eslint-disable */
// @ts-nocheck
// Integration Tests - behavioral parity between the native @morojs/engine HTTP
// backend and the Node http backend. The SAME representative requests (JSON GET,
// POST echo, 404, route params, query, custom headers) run against
// createApp({ server: { engine: 'moro' } }) and createApp({ server: { engine:
// 'node' } }); their status, body and key headers must match - proving the
// engine adapter is a drop-in for the Node path.
//
// The two engines run in SEPARATE phases (never simultaneously): UnifiedRouter
// is a process-wide singleton, so we reset it between phases and keep only one
// app alive at a time. Skipped entirely when the native engine can't load (a
// parity test without the engine leg is meaningless).
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp, param } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { logger } from '../../src/core/logger/index.js';
import { closeApp, createTestPort } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';
import {
  registerSyntaxRoutes,
  SYNTAX_CASES,
  RAW_PATH_CASES,
  rawGet,
  collectAnswers,
  expectedAnswers,
} from '../utils/route-syntax-parity.js';

const testPort = () => createTestPort();

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

// Register the identical route surface on either engine
function registerRoutes(app: any): void {
  app.get('/json', () => ({ hello: 'world', n: 1, list: [1, 2, 3] }));
  app.post('/echo', (req: any) => ({ received: req.body }));
  app.get('/users/:id', (req: any) => ({ id: req.params.id }));
  app.get('/search', (req: any) => ({ query: req.query }));
  app.get('/hdr', (req: any) => ({ h: req.headers['x-test-header'] ?? null }));
}

// Normalize a response for cross-engine comparison. Content-type is reduced to
// its media type (the Node path appends "; charset=utf-8" to JSON, the engine
// does not - a cosmetic difference, not a behavioral one).
async function grab(p: Promise<Response>) {
  const r = await p;
  const ct = r.headers.get('content-type');
  return {
    status: r.status,
    contentType: ct ? ct.split(';')[0].trim() : null,
    body: await r.json().catch(() => null),
  };
}

async function collect(port: number) {
  const base = `http://localhost:${port}`;
  return {
    jsonGet: await grab(fetch(`${base}/json`)),
    postEcho: await grab(
      fetch(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1, b: 'two', nested: { x: true, arr: [9, 8] } }),
      })
    ),
    notFound: await grab(fetch(`${base}/nope`)),
    params: await grab(fetch(`${base}/users/abc123`)),
    query: await grab(fetch(`${base}/search?a=1&b=2&c=hello&d=`)),
    headers: await grab(fetch(`${base}/hdr`, { headers: { 'x-test-header': 'parity-value' } })),
  };
}

describeEngine('Engine <-> Node behavioral parity', () => {
  let app: any;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  async function runPhase(engine: 'moro' | 'node') {
    resetConfig();
    UnifiedRouter.reset(); // singleton router - isolate the two phases
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    registerRoutes(app);
    const port = testPort();
    await listen(app, port);
    const results = await collect(port);
    await closeApp(app);
    app = null;
    return results;
  }

  it('produces matching status, body and key headers on both engines', async () => {
    const nodeResults = await runPhase('node');
    const moroResults = await runPhase('moro');

    // Sanity: the Node baseline behaved as expected before comparing
    expect(nodeResults.jsonGet.status).toBe(200);
    expect(nodeResults.jsonGet.body).toEqual({ hello: 'world', n: 1, list: [1, 2, 3] });
    expect(nodeResults.notFound.status).toBe(404);
    expect(nodeResults.params.body).toEqual({ id: 'abc123' });

    // Full cross-engine parity across every representative request
    for (const key of Object.keys(nodeResults) as Array<keyof typeof nodeResults>) {
      expect(moroResults[key].status).toBe(nodeResults[key].status);
      expect(moroResults[key].body).toEqual(nodeResults[key].body);
      expect(moroResults[key].contentType).toBe(nodeResults[key].contentType);
    }
  }, 30000);

  // A route path without parameters is its own text: '.' and '+' stand for
  // themselves, and so does a '*' that is not the whole last segment (that
  // one is a wildcard, covered below).
  const LITERAL_ROUTES = ['/docs', '/v1.0/ping', '/a+b', '/c++', '/glob/**', '/img/*.png'];
  const LITERAL_CASES: Array<[url: string, route: string | null]> = [
    ['/docs', '/docs'],
    ['/docs/intro', null],
    ['/v1.0/ping', '/v1.0/ping'],
    ['/v1x0/ping', null],
    ['/a+b', '/a+b'],
    ['/aab', null],
    ['/c++', '/c++'],
    ['/c', null],
    ['/glob/**', '/glob/**'],
    ['/glob/', null],
    ['/glob/x', null],
    ['/glob/x/y', null],
    ['/img/*.png', '/img/*.png'],
    ['/img/a.png', null],
  ];

  async function literalPhase(engine: 'moro' | 'node') {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    for (const route of LITERAL_ROUTES) app.get(route, () => ({ route }));
    const port = testPort();
    await listen(app, port);
    const answers: Record<string, string> = {};
    for (const [url] of LITERAL_CASES) {
      const reply = await grab(fetch(`http://localhost:${port}${url}`));
      answers[url] = reply.status === 200 ? `200 ${reply.body.route}` : String(reply.status);
    }
    await closeApp(app);
    app = null;
    return { answers };
  }

  it('answers a route without parameters only for the URL it is written as, on both engines', async () => {
    const expected: Record<string, string> = {};
    for (const [url, route] of LITERAL_CASES) expected[url] = route ? `200 ${route}` : '404';

    const node = await literalPhase('node');
    const moro = await literalPhase('moro');

    expect(node.answers).toEqual(expected);
    expect(moro.answers).toEqual(expected);
  }, 30000);

  // Optional parameters and wildcards: the documented answer for every URL
  // of the shared table, and nothing said about the paths when they are
  // registered. The dot-segment URLs are sent as written, which fetch() would
  // not do.
  it.each(['node', 'moro'] as const)(
    'answers optional parameters and wildcards as documented (%s)',
    async engine => {
      resetConfig();
      UnifiedRouter.reset();
      const warnings: string[] = [];
      logger.addOutput({
        name: 'route-syntax',
        write: (entry: any) => {
          if (entry.level === 'warn' && String(entry.message).startsWith('Route GET ')) {
            warnings.push(String(entry.message));
          }
        },
      } as any);
      try {
        app = await createApp({ logger: { level: 'warn' }, server: { engine } });
        await registerSyntaxRoutes(app);
        const port = testPort();
        await listen(app, port);
        expect(app.engine.server).toBe(engine === 'moro' ? 'engine' : 'node');

        const cases = [...SYNTAX_CASES, ...RAW_PATH_CASES];
        expect(await collectAnswers(cases, url => rawGet(port, url))).toEqual(
          expectedAnswers(cases)
        );
        // The guard in front of '/files/private' lets a request through to
        // the wildcard route behind it
        const passed = await fetch(`http://localhost:${port}/files/private/x`, {
          headers: { 'x-pass': 'yes' },
        });
        expect(await passed.json()).toEqual({ route: '/files/*', params: { '*': 'private/x' } });

        // Only the '*' that is no wildcard is worth a word
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Route GET /glob/** ');
      } finally {
        logger.removeOutput('route-syntax');
        logger.setLevel('error');
      }
    },
    30000
  );

  // Paths written in another router's pattern syntax. Patterns are not
  // supported; such a route goes on answering exactly what it has answered
  // on each server, and says so once when registered. A dot is different: in
  // the fixed text of a path it is a dot.
  const SYNTAX_ROUTES = [
    '/re/:id(\\d+)',
    '/q/:a/b?x',
    '/u/:id/v1.0',
    '/v1.0.0/items/:id',
    '/proxy/:svc/.*',
    '/plain/:id',
    '/search?debug',
  ];
  const answered = (route: string, params: Record<string, string>) =>
    `200 ${route} ${JSON.stringify(params)}`;
  // What both servers answer
  const SYNTAX_SHARED: Record<string, string> = {
    '/re/12': answered('/re/:id(\\d+)', { 'id(\\d+)': '12' }),
    '/re/ab': answered('/re/:id(\\d+)', { 'id(\\d+)': 'ab' }),
    '/re': '404',
    '/q/1/bx': answered('/q/:a/b?x', { a: '1' }),
    '/q/1/x': answered('/q/:a/b?x', { a: '1' }),
    '/q/1/b': '404',
    '/u/7/v1.0': answered('/u/:id/v1.0', { id: '7' }),
    '/u/7/v1X0': '404',
    '/v1.0.0/items/3': answered('/v1.0.0/items/:id', { id: '3' }),
    '/v1x0x0/items/3': '404',
    '/proxy/a/b': answered('/proxy/:svc/.*', { svc: 'a' }),
    '/proxy/a/b/c': answered('/proxy/:svc/.*', { svc: 'a' }),
    '/proxy/a': '404',
    '/proxy/a/.*': answered('/proxy/:svc/.*', { svc: 'a' }),
    '/plain/1': answered('/plain/:id', { id: '1' }),
  };
  // Where they differ, and have differed: what the warning is about
  const SYNTAX_PER_ENGINE: Record<'node' | 'moro', Record<string, string>> = {
    node: {
      '/proxy/a/': '404',
      '/search': '404',
    },
    moro: {
      '/proxy/a/': answered('/proxy/:svc/.*', { svc: 'a' }),
      '/search': answered('/search?debug', {}),
    },
  };

  async function syntaxPhase(engine: 'moro' | 'node') {
    resetConfig();
    UnifiedRouter.reset();
    const warnings: string[] = [];
    logger.addOutput({
      name: 'route-syntax',
      write: (entry: any) => {
        if (entry.level === 'warn' && String(entry.message).startsWith('Route GET ')) {
          warnings.push(String(entry.message));
        }
      },
    } as any);
    try {
      app = await createApp({ logger: { level: 'warn' }, server: { engine } });
      for (const route of SYNTAX_ROUTES) {
        app.get(route, (req: any) => ({ route, params: req.params }));
      }
      // Registered again: the route is replaced, and nothing more is said
      app.get('/q/:a/b?x', (req: any) => ({ route: '/q/:a/b?x', params: req.params }));
      const port = testPort();
      await listen(app, port);
      const answers: Record<string, string> = {};
      const urls = [...Object.keys(SYNTAX_SHARED), ...Object.keys(SYNTAX_PER_ENGINE[engine])];
      for (const url of urls) {
        const reply = await grab(fetch(`http://localhost:${port}${url}`));
        answers[url] =
          reply.status === 200
            ? `200 ${reply.body.route} ${JSON.stringify(reply.body.params)}`
            : String(reply.status);
      }
      await closeApp(app);
      app = null;
      return { answers, warnings };
    } finally {
      logger.removeOutput('route-syntax');
      logger.setLevel('error');
    }
  }

  it.each(['node', 'moro'] as const)(
    'keeps what unsupported path syntax answered, warns once per route, and reads a dot as a dot (%s)',
    async engine => {
      const { answers, warnings } = await syntaxPhase(engine);
      expect(answers).toEqual({ ...SYNTAX_SHARED, ...SYNTAX_PER_ENGINE[engine] });

      // One line for each route that uses such syntax, naming path and character
      const about = (route: string) => warnings.filter(w => w.startsWith(`Route GET ${route} `));
      expect(warnings).toHaveLength(4);
      expect(about('/q/:a/b?x')).toHaveLength(1);
      expect(about('/q/:a/b?x')[0]).toContain("contains '?'");
      expect(about('/re/:id(\\d+)')[0]).toContain("req.params['id(\\d+)']");
      expect(about('/re/:id(\\d+)')[0]).toContain('patterns are not supported');
      expect(about('/proxy/:svc/.*')[0]).toContain("contains '*'");
      expect(about('/search?debug')[0]).toContain('never includes the query string');
      // Dots and plain parameters are ordinary paths
      expect(about('/u/:id/v1.0')).toEqual([]);
      expect(about('/v1.0.0/items/:id')).toEqual([]);
      expect(about('/plain/:id')).toEqual([]);
    },
    30000
  );
});

// A route with a literal body, or a param() handler, can be answered by the
// native engine without entering JS. That holds only while the app has nothing
// a request must pass first: with global middleware (app.use(), or the
// config-driven kind) or a request / response hook, registered at any time,
// those routes are dispatched like every other one.
describeEngine('Engine: literal-body and param() routes behind global middleware and hooks', () => {
  let app: any;
  let base: string;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  async function createEngineApp(options: any = {}) {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      routing: false,
      ...options,
      // Request logging is global middleware too; off, so that each case
      // decides what is in front of the routes.
      server: { engine: 'moro', requestLogging: { enabled: false }, ...options.server },
    });
    app.get('/fn', () => ({ ok: true }));
    app.get('/banner', 'build 1.2.3');
    app.get('/config', '{"feature":true}');
    app.get('/user/:id').handler(param('id'));
    return app;
  }

  async function start() {
    const port = testPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${port}`;
  }

  const PATHS = ['/fn', '/banner', '/config', '/user/42'];
  const statuses = async () =>
    Promise.all(PATHS.map(async path => (await fetch(base + path)).status));

  it('answers them itself while nothing is registered in front, a param() reply as plain text', async () => {
    await createEngineApp();
    await start();

    const banner = await fetch(`${base}/banner`);
    expect(banner.status).toBe(200);
    expect(await banner.text()).toBe('build 1.2.3');

    // The engine echoes the segment as it is on the wire; the reply is typed,
    // so a browser never works a type out from bytes the client chose.
    const echoed = await fetch(`${base}/user/a%3Cb%3E`);
    expect(echoed.status).toBe(200);
    expect(echoed.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    if (app.core.httpServer.paramRoutesEnabled) expect(await echoed.text()).toBe('a%3Cb%3E');
  });

  it('leaves a param() route to the router when another route of the method could match its paths', async () => {
    await createEngineApp();
    app.get('/user/me', (_req: any, res: any) => res.send('ME-HANDLER'));
    app.get('/user/:name/posts', (_req: any, res: any) => res.send('POSTS'));
    await start();

    // '/user/me' is a literal route of its own: the engine must not echo 'me'.
    const me = await fetch(`${base}/user/me`);
    expect(me.status).toBe(200);
    expect(await me.text()).toBe('ME-HANDLER');
    // Every other path still gets the param() reply, now from the router.
    const other = await fetch(`${base}/user/42`);
    expect(await other.text()).toBe('42');
    expect(other.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await (await fetch(`${base}/user/7/posts`)).text()).toBe('POSTS');
  });

  it('takes a param() route back from the engine when a route registered after listen() shadows it', async () => {
    await createEngineApp();
    await start();
    if (app.core.httpServer.paramRoutesEnabled) {
      expect(await (await fetch(`${base}/user/me`)).text()).toBe('me');
    }

    app.get('/user/me', (_req: any, res: any) => res.send('ME-HANDLER'));
    app.get('/late', 'late banner');

    expect(await (await fetch(`${base}/user/me`)).text()).toBe('ME-HANDLER');
    const other = await fetch(`${base}/user/42`);
    expect(await other.text()).toBe('42');
    expect(other.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await (await fetch(`${base}/late`)).text()).toBe('late banner');
  });

  it('runs a global guard in front of every one of them', async () => {
    await createEngineApp();
    let guardCalls = 0;
    await app.use((_req: any, res: any, _next: () => void) => {
      guardCalls++;
      res.status(401).json({ error: 'sign in' });
    });
    await start();

    expect(await statuses()).toEqual([401, 401, 401, 401]);
    expect(guardCalls).toBe(4);
  });

  it('puts middleware registered after listen() in front of them', async () => {
    await createEngineApp();
    await start();
    expect(await statuses()).toEqual([200, 200, 200, 200]);

    const seen: string[] = [];
    await app.use((req: any, res: any, next: () => void) => {
      seen.push(req.path);
      res.setHeader('X-Checked', 'yes');
      next();
    });

    for (const path of PATHS) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-checked')).toBe('yes');
    }
    expect(seen).toEqual(PATHS);
    // The reply itself is the one the route always gave.
    expect(await (await fetch(`${base}/banner`)).text()).toBe('build 1.2.3');
    const config = await fetch(`${base}/config`);
    expect(config.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await config.json()).toEqual({ feature: true });
  });

  it('runs a request hook registered after listen(), and steps back when it is removed', async () => {
    await createEngineApp();
    await start();

    const seen: string[] = [];
    const hook = (context: any) => {
      seen.push(context.request.path);
      if (context.request.path === '/banner') context.response.status(403).json({ error: 'no' });
    };
    app.hooks.before('request', hook);
    expect(await statuses()).toEqual([200, 403, 200, 200]);
    // statuses() sends the four requests together: they arrive in any order
    const once = [...PATHS].sort();
    expect([...seen].sort()).toEqual(once);

    app.hooks.removeHook('request', hook);
    expect(await statuses()).toEqual([200, 200, 200, 200]);
    expect([...seen].sort()).toEqual(once); // not called again
  });

  it('applies config-driven middleware to them', async () => {
    await createEngineApp({ security: { helmet: { enabled: true } } });
    await start();

    for (const path of PATHS) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });
});
