/* eslint-disable no-undef */
import { createApp, middleware } from '../../src/index.js';
import { Moro } from '../../src/moro.js';
import { createTestPort } from '../setup.js';

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
