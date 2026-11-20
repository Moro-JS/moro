import net from 'node:net';
import { createApp, middleware } from '../../src/index.js';
import { Moro } from '../../src/moro.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp, createTestPort } from '../setup.js';
import { engineLoadable } from './engine-test-utils.js';

describe('Prometheus metrics endpoint - integration', () => {
  let app: Moro;
  let port: number;

  beforeEach(async () => {
    port = createTestPort();
    app = await createApp({ logging: { level: 'error' } });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('serves scraped metrics reflecting handled requests', async () => {
    await app.use(middleware.prometheus({ endpoint: '/metrics' }));
    app.get('/hello', () => ({ ok: true }));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Generate some traffic
    await fetch(`http://localhost:${port}/hello`);
    await fetch(`http://localhost:${port}/hello`);

    const response = await fetch(`http://localhost:${port}/metrics`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toMatch(/http_requests_total\{method="GET",status="200"\} \d+/);
    expect(body).toContain('http_request_duration_seconds_bucket');
    expect(body).toContain('moro_pool_max_size{pool="params"}');
  });
});

// One request with an arbitrary method token, written by hand (fetch and
// http.request refuse those).
function rawRequest(port: number, method: string, reqPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${method} ${reqPath} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', d => chunks.push(d));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.setTimeout(3000, () => socket.destroy());
  });
}

// Who may scrape the endpoint, and which label values a client can create.
// UnifiedRouter and the configuration are process-wide, so each test boots one
// app, exercises it and closes it before the next one starts.
type BackendId = 'node' | 'moro';
const BACKENDS: BackendId[] = engineLoadable ? ['node', 'moro'] : ['node'];

describe.each(BACKENDS)('Prometheus metrics endpoint on the %s backend', backend => {
  let app: any;

  async function boot(register: (app: any) => Promise<void>): Promise<number> {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      routing: false,
      server: { engine: backend },
    } as any);
    await register(app);
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    return port;
  }

  afterEach(async () => {
    if (app) await closeApp(app);
    app = undefined;
  });

  it('serves /metrics only to callers authorize() accepts', async () => {
    const port = await boot(async app => {
      await app.use(
        middleware.prometheus({
          authorize: (req: any) => req.headers.authorization === 'Bearer scrape-token',
        })
      );
      app.get('/hello', () => ({ ok: true }));
    });
    const base = `http://127.0.0.1:${port}`;

    await fetch(`${base}/hello`);
    const denied = await fetch(`${base}/metrics`);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('http_requests_total');

    const allowed = await fetch(`${base}/metrics`, {
      headers: { authorization: 'Bearer scrape-token' },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toMatch(/http_requests_total\{method="GET",status="200"\} \d+/);
  });

  it('does not grow a series per made-up method token', async () => {
    const port = await boot(async app => {
      await app.use(middleware.prometheus());
      app.get('/hello', () => ({ ok: true }));
    });
    const base = `http://127.0.0.1:${port}`;

    // The Node parser refuses unknown methods outright; the native engine
    // passes them on to the application
    for (let i = 0; i < 25; i++) await rawRequest(port, `BREW${i}`, '/hello');
    await fetch(`${base}/hello`);

    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).not.toMatch(/BREW\d/);
    const methods = new Set(
      [...metrics.matchAll(/http_requests_total\{method="([^"]*)"/g)].map(m => m[1])
    );
    expect(methods.has('GET')).toBe(true);
    expect(methods.size).toBeLessThanOrEqual(2);
  });
});
