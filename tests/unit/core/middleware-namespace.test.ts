import { describe, it, expect, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as moro from '../../../src/index.js';
import { registerHelmetHooks } from '../../../src/core/middleware/built-in/helmet/index.js';
import { registerBodySizeHooks } from '../../../src/core/middleware/built-in/body-size/index.js';
import { registerStaticHooks } from '../../../src/core/middleware/built-in/static/index.js';

const { middleware, builtInMiddleware } = moro;

describe('Middleware namespace exports', () => {
  it('middleware is the built-in middleware namespace', () => {
    expect(typeof (middleware as any).helmet).toBe('function');
    expect(typeof (middleware as any).cors).toBe('function');
    expect(typeof (middleware as any).auth).toBe('function');
    expect(typeof (middleware as any).compression).toBe('function');
    expect(typeof (middleware as any).staticFiles).toBe('function');
  });

  it('builtInMiddleware is a deprecated alias of middleware', () => {
    expect(builtInMiddleware).toBe(middleware);
  });

  it('the observability middleware are proper built-in factories', () => {
    // Zero-config factories: called (no options needed) and return middleware
    const requestLogger = (middleware as any).requestLogger();
    expect(typeof requestLogger).toBe('function');
    expect(requestLogger.length).toBe(3);

    const performanceMonitor = (middleware as any).performanceMonitor();
    expect(typeof performanceMonitor).toBe('function');
    expect(performanceMonitor.length).toBe(3);

    // errorTracker produces the 4-arg (err, req, res, next) error-handler shape
    const errorTracker = (middleware as any).errorTracker();
    expect(typeof errorTracker).toBe('function');
    expect(errorTracker.length).toBe(4);

    // openTelemetry needs only @opentelemetry/api (a dev dependency here)
    const openTelemetry = (middleware as any).openTelemetry();
    expect(typeof openTelemetry).toBe('function');
    expect(openTelemetry.length).toBe(3);
  });

  it('standardMiddleware and simpleMiddleware no longer exist', () => {
    expect((moro as any).standardMiddleware).toBeUndefined();
    expect((moro as any).simpleMiddleware).toBeUndefined();
  });

  it('built-in factories are branded for uncalled-factory detection', () => {
    const brand = Symbol.for('morojs.middleware-factory');
    expect(((middleware as any).helmet as any)[brand]).toBe(true);
    expect(((middleware as any).requestLogger as any)[brand]).toBe(true);
    // instances produced by factories are NOT branded — they are real middleware
    expect(((middleware as any).helmet() as any)[brand]).toBeUndefined();
  });
});

// Every request hook runs for every request, also after one of them has
// answered it (a rate limit's 429). A response that has been sent takes no
// more headers and no second answer: on the Node.js server either one throws.
describe('Built-in request hooks and a request that was already answered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-answered-'));
  fs.writeFileSync(path.join(root, 'page.html'), '<p>page</p>');

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // A sent response, as strict as the Node.js one: whatever is called on it throws
  function sentResponse() {
    const touched: string[] = [];
    const refuse =
      (name: string) =>
      (..._args: unknown[]): never => {
        touched.push(name);
        throw new Error(`${name}() on a response that was already sent`);
      };
    const res: Record<string, unknown> = {
      headersSent: true,
      statusCode: 429,
      getHeader: () => undefined,
      on: () => res,
      once: () => res,
    };
    for (const name of [
      'setHeader',
      'removeHeader',
      'writeHead',
      'write',
      'end',
      'status',
      'json',
      'send',
      'cookie',
      'pipe',
    ]) {
      res[name] = refuse(name);
    }
    return { res, touched };
  }

  const request = (method: string, urlPath: string, headers: Record<string, string> = {}) => ({
    method,
    path: urlPath,
    url: urlPath,
    headers: { host: 'app.example', origin: 'https://app.example', ...headers },
    query: {},
    params: {},
    cookies: {},
    body: undefined,
    ip: '203.0.113.7',
    on: () => undefined,
  });

  type Hook = (context: { request: unknown; response: unknown }) => unknown;

  // The request hooks a built-in registers, whichever way it registers them
  async function hooksOf(register: (hooks: any) => unknown): Promise<Hook[]> {
    const collected: Hook[] = [];
    const collect = (event: string, fn: Hook) => {
      if (event === 'request') collected.push(fn);
      return hooks;
    };
    const hooks: any = { before: collect, hook: collect, on: collect, after: () => hooks };
    await register(hooks);
    return collected;
  }

  const install = (mw: any) => (hooks: any) => mw.install(hooks, {});
  const m = middleware as any;

  const CASES: Array<[name: string, register: (hooks: any) => unknown, req: unknown]> = [
    ['cors', install(m.cors({ origin: 'https://app.example' })), request('GET', '/')],
    ['csp', install(m.csp({})), request('GET', '/')],
    ['session', install(m.session({ secret: 'a-secret-for-this-test-only' })), request('GET', '/')],
    ['cache', install(m.cache({ adapter: 'memory' })), request('GET', '/')],
    [
      'cdn',
      install(
        m.cdn({
          adapter: {
            purge: async () => undefined,
            setHeaders: (res: any) => res.setHeader('CDN-Cache-Control', 'max-age=60'),
          },
        })
      ),
      request('GET', '/'),
    ],
    ['helmet (hook form)', (hooks: any) => registerHelmetHooks(hooks, {}), request('GET', '/')],
    [
      'bodySize (hook form)',
      (hooks: any) => registerBodySizeHooks(hooks, { limit: '1kb' }),
      request('POST', '/', { 'content-length': '5000', 'content-type': 'application/json' }),
    ],
    [
      'staticFiles (hook form)',
      (hooks: any) => registerStaticHooks(hooks, { root }),
      request('GET', '/page.html'),
    ],
  ];

  it.each(CASES)('%s does nothing to it', async (_name, register, req) => {
    const hooks = await hooksOf(register);
    expect(hooks.length).toBeGreaterThan(0);

    const { res, touched } = sentResponse();
    for (const hook of hooks) await hook({ request: req, response: res });
    expect(touched).toEqual([]);
  });
});
