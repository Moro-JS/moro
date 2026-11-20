// Metrics middleware - the method label and who may read /metrics.
//
// prometheus() and cloudWatch() label by a normalized request method: the
// standard methods keep their name and every other token becomes OTHER. The
// native engine passes any method token through to the application, so the
// label set must stay fixed whatever a client sends - one Prometheus series /
// one (billable) CloudWatch dimension value, not one per token. prometheus()
// also takes an `authorize` option that decides who may read the endpoint.
import { describe, it, expect } from '@jest/globals';
import { PrometheusCore } from '../../../src/core/middleware/built-in/prometheus/core.js';
import { createPrometheusMiddleware } from '../../../src/core/middleware/built-in/prometheus/middleware.js';
import {
  normalizeMethodLabel,
  OTHER_METHOD,
} from '../../../src/core/middleware/built-in/prometheus/method-label.js';
import {
  buildEmfRecord,
  createCloudWatchMiddleware,
} from '../../../src/core/middleware/built-in/cloudwatch/middleware.js';

function fakeReqRes(method: string, path: string, headers: Record<string, string> = {}) {
  const listeners: Array<() => void> = [];
  const sent: { body?: string; headers: Record<string, string> } = { headers: {} };
  const req: any = { method, path, headers };
  const res: any = {
    statusCode: 200,
    setHeader: (key: string, value: string) => {
      sent.headers[key.toLowerCase()] = value;
    },
    on: (event: string, cb: () => void) => {
      if (event === 'finish') listeners.push(cb);
    },
    end: (data?: string) => {
      sent.body = data;
    },
  };
  return { req, res, sent, finish: () => listeners.forEach(listener => listener()) };
}

const quiet = { includeProcessMetrics: false, includePoolMetrics: false };

/** The distinct http_requests_total series in an exposition */
const requestSeries = (exposition: string): string[] =>
  exposition.split('\n').filter(line => line.startsWith('http_requests_total{'));

describe('metrics method label', () => {
  describe('normalizeMethodLabel', () => {
    it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'])(
      'keeps %s',
      method => {
        expect(normalizeMethodLabel(method)).toBe(method);
        expect(normalizeMethodLabel(method.toLowerCase())).toBe(method);
      }
    );

    it.each([
      'PROPFIND',
      'UNKNOWN',
      'GETX',
      'G',
      '',
      'X'.repeat(4000),
      'GET"} 1\nforged_metric{a="',
      'get\0',
    ])('maps %j to OTHER', method => {
      expect(normalizeMethodLabel(method)).toBe(OTHER_METHOD);
    });

    it('maps a missing method to OTHER', () => {
      expect(normalizeMethodLabel(undefined)).toBe('OTHER');
      expect(normalizeMethodLabel(null)).toBe('OTHER');
    });
  });

  describe('prometheus', () => {
    it('does not grow a series per method token', () => {
      const core = new PrometheusCore(quiet);
      for (let i = 0; i < 500; i++) core.recordRequest(`M${i}-${'x'.repeat(40)}`, 404, 1);
      core.recordRequest('get', 200, 1);
      core.recordRequest('GET', 200, 1);

      const series = requestSeries(core.render());
      expect(series).toEqual([
        'http_requests_total{method="OTHER",status="404"} 500',
        'http_requests_total{method="GET",status="200"} 2',
      ]);
    });

    it('cannot be made to emit a forged line through the method', () => {
      const core = new PrometheusCore(quiet);
      core.recordRequest('X"} 1\nforged_total{a="b', 200, 1);
      const output = core.render();
      expect(output).not.toContain('forged_total');
      expect(requestSeries(output)).toEqual(['http_requests_total{method="OTHER",status="200"} 1']);
    });

    it('labels through the middleware the same way', () => {
      const mw = createPrometheusMiddleware(quiet);
      for (const method of ['BREW', 'WHEN', 'post']) {
        const exchange = fakeReqRes(method, '/x');
        mw(exchange.req, exchange.res, () => undefined);
        exchange.finish();
      }
      const scrape = fakeReqRes('GET', '/metrics');
      mw(scrape.req, scrape.res, () => undefined);
      expect(requestSeries(scrape.sent.body as string)).toEqual([
        'http_requests_total{method="OTHER",status="200"} 2',
        'http_requests_total{method="POST",status="200"} 1',
      ]);
    });
  });

  describe('cloudWatch', () => {
    const options = { namespace: 'Test', dimensions: {} };

    it('uses the normalized method as the dimension value', () => {
      expect(buildEmfRecord(options, { method: 'GET', path: '/' }, 200, 1).Method).toBe('GET');
      expect(buildEmfRecord(options, { method: 'delete', path: '/' }, 200, 1).Method).toBe(
        'DELETE'
      );
      expect(buildEmfRecord(options, { method: 'PROPFIND', path: '/' }, 200, 1).Method).toBe(
        'OTHER'
      );
    });

    it('emits one dimension value for any number of made-up methods', () => {
      const lines: string[] = [];
      const mw = createCloudWatchMiddleware({ emit: line => lines.push(line) });
      for (let i = 0; i < 50; i++) {
        const exchange = fakeReqRes(`TOKEN${i}`, '/x');
        mw(exchange.req, exchange.res, () => undefined);
        exchange.finish();
      }
      const methods = new Set(lines.map(line => JSON.parse(line).Method));
      expect([...methods]).toEqual(['OTHER']);
    });
  });
});

describe('prometheus authorize option', () => {
  const scrape = async (
    authorize: ((req: any) => boolean | Promise<boolean>) | undefined,
    headers: Record<string, string> = {}
  ) => {
    const mw = createPrometheusMiddleware(
      authorize === undefined ? quiet : { ...quiet, authorize }
    );
    const exchange = fakeReqRes('GET', '/metrics', headers);
    let nextCalled = false;
    mw(exchange.req, exchange.res, () => {
      nextCalled = true;
    });
    // an async authorize settles on a later tick
    await new Promise<void>(resolve => setImmediate(resolve));
    return { ...exchange, nextCalled };
  };

  it('leaves the endpoint open when not given (the default)', async () => {
    const { res, sent } = await scrape(undefined);
    expect(res.statusCode).toBe(200);
    expect(sent.headers['content-type']).toContain('text/plain; version=0.0.4');
    expect(sent.body).toContain('# TYPE http_requests_total counter');
  });

  it('serves the exposition when it returns true', async () => {
    const byToken = (req: any) => req.headers.authorization === 'Bearer scrape-token';
    const { res, sent } = await scrape(byToken, { authorization: 'Bearer scrape-token' });
    expect(res.statusCode).toBe(200);
    expect(sent.body).toContain('http_requests_total');
  });

  it('answers 403 without the metrics when it returns false', async () => {
    const byToken = (req: any) => req.headers.authorization === 'Bearer scrape-token';
    const { res, sent, nextCalled } = await scrape(byToken, { authorization: 'Bearer guess' });
    expect(res.statusCode).toBe(403);
    expect(sent.body).not.toContain('http_requests_total');
    expect(nextCalled).toBe(false);
  });

  it('awaits an async decision', async () => {
    const allowed = await scrape(async () => true);
    expect(allowed.res.statusCode).toBe(200);
    expect(allowed.sent.body).toContain('http_requests_total');

    const denied = await scrape(async () => false);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.sent.body).not.toContain('http_requests_total');
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('boom');
      },
    ],
    ['rejects', () => Promise.reject(new Error('boom'))],
    ['returns a truthy non-boolean', () => 'yes' as unknown as boolean],
    ['resolves to a truthy non-boolean', async () => 1 as unknown as boolean],
  ])('fails closed when authorize %s', async (_label, authorize) => {
    const { res, sent } = await scrape(authorize);
    expect(res.statusCode).toBe(403);
    expect(sent.body).not.toContain('http_requests_total');
  });

  it('is not consulted for other requests', async () => {
    let asked = 0;
    const mw = createPrometheusMiddleware({
      ...quiet,
      authorize: () => {
        asked++;
        return false;
      },
    });
    const exchange = fakeReqRes('GET', '/hello');
    let nextCalled = false;
    mw(exchange.req, exchange.res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(asked).toBe(0);
  });
});
