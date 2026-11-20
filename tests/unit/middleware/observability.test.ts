import { describe, it, expect } from '@jest/globals';
import { PrometheusCore } from '../../../src/core/middleware/built-in/prometheus/core.js';
import { createPrometheusMiddleware } from '../../../src/core/middleware/built-in/prometheus/middleware.js';
import {
  buildEmfRecord,
  createCloudWatchMiddleware,
} from '../../../src/core/middleware/built-in/cloudwatch/middleware.js';
import { createErrorTrackerMiddleware } from '../../../src/core/middleware/built-in/error-tracker/middleware.js';
import { logger } from '../../../src/core/logger/index.js';

type FinishListener = () => void;

function fakeReqRes(method: string, path: string, statusCode = 200) {
  const listeners: FinishListener[] = [];
  let body: string | undefined;
  const headers: Record<string, string> = {};

  const req: any = { method, path };
  const res: any = {
    statusCode,
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
    on: (event: string, cb: FinishListener) => {
      if (event === 'finish') listeners.push(cb);
    },
    end: (data?: string) => {
      body = data;
    },
  };

  return {
    req,
    res,
    headers,
    getBody: () => body,
    finish: () => listeners.forEach(listener => listener()),
  };
}

describe('Prometheus middleware', () => {
  it('records counters and histogram series in exposition format', () => {
    const core = new PrometheusCore({ includeProcessMetrics: false, includePoolMetrics: false });
    core.recordRequest('GET', 200, 3);
    core.recordRequest('GET', 200, 700);
    core.recordRequest('POST', 500, 40);

    const output = core.render();
    expect(output).toContain('http_requests_total{method="GET",status="200"} 2');
    expect(output).toContain('http_requests_total{method="POST",status="500"} 1');
    // 3ms falls in the 0.005 bucket; 700ms only in the 1s+ buckets
    expect(output).toContain(
      'http_request_duration_seconds_bucket{method="GET",status="200",le="0.005"} 1'
    );
    expect(output).toContain(
      'http_request_duration_seconds_bucket{method="GET",status="200",le="+Inf"} 2'
    );
    expect(output).toContain('http_request_duration_seconds_count{method="GET",status="200"} 2');
  });

  it('serves the exposition at the endpoint and records other requests', () => {
    const mw = createPrometheusMiddleware({
      includeProcessMetrics: false,
      includePoolMetrics: false,
    });

    // A normal request gets recorded on finish
    const normal = fakeReqRes('GET', '/api/users');
    let nextCalled = false;
    mw(normal.req, normal.res, (() => {
      nextCalled = true;
    }) as any);
    expect(nextCalled).toBe(true);
    normal.finish();

    // The metrics endpoint responds without calling next
    const scrape = fakeReqRes('GET', '/metrics');
    let scrapeNext = false;
    mw(scrape.req, scrape.res, (() => {
      scrapeNext = true;
    }) as any);
    expect(scrapeNext).toBe(false);
    expect(scrape.headers['Content-Type']).toContain('text/plain');
    expect(scrape.getBody()).toContain('http_requests_total{method="GET",status="200"} 1');
  });

  it('includes process and pool metrics by default', () => {
    const core = new PrometheusCore();
    const output = core.render();
    expect(output).toContain('process_resident_memory_bytes');
    expect(output).toContain('moro_pool_max_size{pool="params"}');
    expect(output).toContain('moro_route_cache_hits_total');
  });
});

describe('CloudWatch EMF middleware', () => {
  it('builds spec-shaped EMF records', () => {
    const record = buildEmfRecord(
      { namespace: 'MoroAPI', dimensions: { Service: 'api' } },
      { method: 'GET', path: '/users' },
      200,
      42
    );

    expect(record._aws.CloudWatchMetrics[0].Namespace).toBe('MoroAPI');
    expect(record._aws.CloudWatchMetrics[0].Dimensions[0]).toEqual(['Method', 'Status', 'Service']);
    expect(record.Method).toBe('GET');
    expect(record.Status).toBe('200');
    expect(record.Service).toBe('api');
    expect(record.RequestCount).toBe(1);
    expect(record.RequestDuration).toBe(42);
    expect(typeof record._aws.Timestamp).toBe('number');
  });

  it('emits one JSON line per completed request', () => {
    const lines: string[] = [];
    const mw = createCloudWatchMiddleware({
      namespace: 'TestNS',
      emit: line => lines.push(line),
    });

    const ctx = fakeReqRes('POST', '/orders', 201);
    let nextCalled = false;
    mw(ctx.req, ctx.res, (() => {
      nextCalled = true;
    }) as any);
    expect(nextCalled).toBe(true);
    expect(lines.length).toBe(0); // nothing until the response finishes

    ctx.finish();
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed._aws.CloudWatchMetrics[0].Namespace).toBe('TestNS');
    expect(parsed.Status).toBe('201');
    expect(parsed.Path).toBe('/orders');
  });
});

describe('Error tracker middleware', () => {
  // What the tracker logged for one failing request: the metadata of its
  // 'Request error' entry, read through an output added to the logger.
  function trackedContext(
    options: Parameters<typeof createErrorTrackerMiddleware>[0],
    url: string
  ): { metadata: Record<string, any>; passedOn: unknown } {
    const entries: Array<Record<string, any>> = [];
    logger.addOutput({
      name: 'error-tracker-capture',
      write: (entry: any) => {
        if (entry.message === 'Request error') entries.push({ ...entry.metadata });
      },
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = new Error('handler failed');
    let passedOn: unknown;
    try {
      createErrorTrackerMiddleware(options)(
        error,
        { url, method: 'GET' } as any,
        {} as any,
        err => {
          passedOn = err;
        }
      );
      logger.flush();
    } finally {
      logger.removeOutput('error-tracker-capture');
      stderr.mockRestore();
    }
    expect(entries).toHaveLength(1);
    return { metadata: entries[0] as Record<string, any>, passedOn };
  }

  it('logs the request URL with credential-carrying query parameters redacted', () => {
    const { metadata, passedOn } = trackedContext(
      undefined,
      '/reset?email=ada%40example.com&token=9f8e7d&Signature=abc123#form'
    );

    expect(metadata.url).toBe(
      '/reset?email=ada%40example.com&token=REDACTED&Signature=REDACTED#form'
    );
    expect(metadata).toMatchObject({ error: 'handler failed', method: 'GET' });
    // the error still reaches the framework's error handling
    expect((passedOn as Error).message).toBe('handler failed');
  });

  it('takes its own list of parameter names, or false to log the URL as received', () => {
    expect(
      trackedContext({ redactedQueryParams: ['invite'] }, '/join?invite=abc&token=t-1').metadata.url
    ).toBe('/join?invite=REDACTED&token=t-1');
    expect(
      trackedContext({ redactedQueryParams: false }, '/join?invite=abc&token=t-1').metadata.url
    ).toBe('/join?invite=abc&token=t-1');
  });
});
