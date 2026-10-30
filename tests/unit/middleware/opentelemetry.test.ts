import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  context,
  metrics,
  propagation,
  trace,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { createOpenTelemetryMiddleware } from '../../../src/core/middleware/built-in/opentelemetry/middleware.js';
import { loadOpenTelemetryApi } from '../../../src/core/middleware/built-in/opentelemetry/core.js';
import { UnifiedRouter } from '../../../src/core/routing/unified-router.js';

const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new MeterProvider({ readers: [reader] });

function fakeRequest(method: string, url: string, headers: Record<string, string> = {}): any {
  const q = url.indexOf('?');
  return {
    method,
    url,
    path: q === -1 ? url : url.slice(0, q),
    headers: { host: 'api.example.com:8080', 'user-agent': 'jest/1.0', ...headers },
    ip: '10.0.0.7',
    protocol: 'http',
    httpVersion: '1.1',
  };
}

function fakeResponse(statusCode = 200) {
  const listeners: Record<string, Array<() => void>> = {};
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode,
    headersSent: false,
    writableEnded: false,
    on(event: string, cb: () => void) {
      (listeners[event] ??= []).push(cb);
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
  };
  const emit = (event: string) => (listeners[event] ?? []).forEach(cb => cb());
  return {
    res,
    // Completed response: 'finish' then 'close' (Node ServerResponse order)
    finish() {
      res.headersSent = true;
      res.writableEnded = true;
      emit('finish');
      emit('close');
    },
    // Client went away: 'close' only
    abort() {
      emit('close');
    },
  };
}

const finished = (): ReadableSpan[] => exporter.getFinishedSpans();

async function metric(name: string) {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics
    .flatMap(scope => scope.metrics)
    .find(m => m.descriptor.name === name);
}

function registerRoutes() {
  const router = UnifiedRouter.getInstance();
  router.get('/users').handler(() => ({ ok: true }));
  router.get('/users/:id').handler(() => ({ ok: true }));
  router.post('/users/:id').handler(() => ({ ok: true }));
}

describe('OpenTelemetry middleware', () => {
  beforeAll(async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(tracerProvider);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    metrics.setGlobalMeterProvider(meterProvider);
    // Loaded once here so every middleware instance below is synchronous from
    // its first request, as it is in an app whose SDK started before listen()
    await loadOpenTelemetryApi();
  });

  afterAll(async () => {
    await tracerProvider.shutdown();
    await meterProvider.shutdown();
    trace.disable();
    metrics.disable();
    propagation.disable();
    context.disable();
  });

  beforeEach(() => {
    exporter.reset();
    registerRoutes();
  });

  it('opens a SERVER span named by method and route with semantic-convention attributes', () => {
    const mw = createOpenTelemetryMiddleware();
    const req = fakeRequest('GET', '/users/42?expand=orders');
    const { res, finish } = fakeResponse(200);
    let nextCalled = false;

    context.with(ROOT_CONTEXT, () => {
      mw(req, res, () => {
        nextCalled = true;
      });
      finish();
    });

    expect(nextCalled).toBe(true);
    const spans = finished();
    expect(spans).toHaveLength(1);
    const span = spans[0] as ReadableSpan;
    expect(span.name).toBe('GET /users/:id');
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.instrumentationScope.name).toBe('@morojs/moro');
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/users/:id',
      'url.path': '/users/42',
      'url.query': 'expand=orders',
      'url.scheme': 'http',
      'server.address': 'api.example.com',
      'server.port': 8080,
      'client.address': '10.0.0.7',
      'user_agent.original': 'jest/1.0',
      'network.protocol.version': '1.1',
      'http.response.status_code': 200,
    });
    expect(span.attributes['error.type']).toBeUndefined();
  });

  it('names the span by method alone when no route matches and never records the raw path as route', () => {
    const mw = createOpenTelemetryMiddleware();
    const req = fakeRequest('GET', '/no/such/thing');
    const { res, finish } = fakeResponse(404);

    context.with(ROOT_CONTEXT, () => {
      mw(req, res, () => {});
      finish();
    });

    const span = finished()[0] as ReadableSpan;
    expect(span.name).toBe('GET');
    expect(span.attributes['http.route']).toBeUndefined();
    expect(span.attributes['http.response.status_code']).toBe(404);
    // 4xx is not a server error
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes['error.type']).toBeUndefined();
  });

  it('marks 5xx responses as errors', () => {
    const mw = createOpenTelemetryMiddleware();
    const { res, finish } = fakeResponse(503);

    context.with(ROOT_CONTEXT, () => {
      mw(fakeRequest('GET', '/users'), res, () => {});
      finish();
    });

    const span = finished()[0] as ReadableSpan;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('503');
    expect(span.attributes['http.response.status_code']).toBe(503);
  });

  it('records a client disconnect as an aborted request', () => {
    const mw = createOpenTelemetryMiddleware();
    const { res, abort } = fakeResponse(200);

    context.with(ROOT_CONTEXT, () => {
      mw(fakeRequest('GET', '/users'), res, () => {});
      abort();
    });

    const span = finished()[0] as ReadableSpan;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('aborted');
    // Nothing was sent, so no status code is claimed
    expect(span.attributes['http.response.status_code']).toBeUndefined();
  });

  it('continues the trace carried by an incoming traceparent header', () => {
    const mw = createOpenTelemetryMiddleware();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentId = '00f067aa0ba902b7';
    const req = fakeRequest('GET', '/users', {
      traceparent: `00-${traceId}-${parentId}-01`,
    });
    const { res, finish } = fakeResponse(200);

    context.with(ROOT_CONTEXT, () => {
      mw(req, res, () => {});
      finish();
    });

    const span = finished()[0] as ReadableSpan;
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.parentSpanContext?.spanId).toBe(parentId);
    expect(span.parentSpanContext?.isRemote).toBe(true);
  });

  it('does not continue incoming context when propagation is off', () => {
    const mw = createOpenTelemetryMiddleware({ propagation: false });
    const req = fakeRequest('GET', '/users', {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    const { res, finish } = fakeResponse(200);

    context.with(ROOT_CONTEXT, () => {
      mw(req, res, () => {});
      finish();
    });

    const span = finished()[0] as ReadableSpan;
    expect(span.spanContext().traceId).not.toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(span.parentSpanContext).toBeUndefined();
  });

  it('makes the span current for the rest of the dispatch, after the middleware has returned', () => {
    // The servers run the chain iteratively: downstream middleware and the
    // handler execute after this middleware returns, not inside next()
    const mw = createOpenTelemetryMiddleware();
    const { res, finish } = fakeResponse(200);
    let activeAfterReturn: string | undefined;
    let activeInsideAwait: string | undefined;

    const run = context.with(ROOT_CONTEXT, async () => {
      mw(fakeRequest('GET', '/users/7'), res, () => {});
      activeAfterReturn = trace.getActiveSpan()?.spanContext().spanId;
      await new Promise(resolve => setTimeout(resolve, 1));
      activeInsideAwait = trace.getActiveSpan()?.spanContext().spanId;
      finish();
    });

    return run.then(() => {
      const span = finished()[0] as ReadableSpan;
      expect(activeAfterReturn).toBe(span.spanContext().spanId);
      expect(activeInsideAwait).toBe(span.spanContext().spanId);
    });
  });

  it('never parents a request to the context an earlier request left behind', () => {
    const mw = createOpenTelemetryMiddleware();
    let activeDuringSecond: string | undefined;

    context.with(ROOT_CONTEXT, () => {
      const first = fakeResponse(200);
      mw(fakeRequest('GET', '/users/1'), first.res, () => {});
      first.finish();

      // Same synchronous flow: the first request's context is still current
      const second = fakeResponse(200);
      mw(fakeRequest('GET', '/users/2'), second.res, () => {});
      activeDuringSecond = trace.getActiveSpan()?.spanContext().spanId;
      second.finish();
    });

    const [firstSpan, secondSpan] = finished() as [ReadableSpan, ReadableSpan];
    expect(secondSpan.parentSpanContext).toBeUndefined();
    expect(secondSpan.spanContext().traceId).not.toBe(firstSpan.spanContext().traceId);
    expect(activeDuringSecond).toBe(secondSpan.spanContext().spanId);
  });

  it('nests under a span an outer instrumentation already opened for this request', () => {
    const mw = createOpenTelemetryMiddleware();
    const outer = trace.getTracer('test').startSpan('HTTP GET', { kind: SpanKind.SERVER });
    const { res, finish } = fakeResponse(200);

    context.with(trace.setSpan(ROOT_CONTEXT, outer), () => {
      mw(fakeRequest('GET', '/users/9'), res, () => {});
      finish();
    });
    outer.end();

    const inner = finished().find(s => s.name === 'GET /users/:id') as ReadableSpan;
    expect(inner.kind).toBe(SpanKind.INTERNAL);
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
  });

  it('skips ignored paths and drops a stale request context for them', () => {
    const mw = createOpenTelemetryMiddleware({ ignorePaths: ['/health', /^\/metrics/] });
    let nextCalls = 0;
    let activeDuringIgnored: unknown = 'unset';

    context.with(ROOT_CONTEXT, () => {
      const traced = fakeResponse(200);
      mw(fakeRequest('GET', '/users'), traced.res, () => nextCalls++);
      traced.finish();

      const health = fakeResponse(200);
      mw(fakeRequest('GET', '/health'), health.res, () => nextCalls++);
      activeDuringIgnored = trace.getActiveSpan();
      health.finish();

      const scrape = fakeResponse(200);
      mw(fakeRequest('GET', '/metrics/prometheus'), scrape.res, () => nextCalls++);
      scrape.finish();
    });

    expect(nextCalls).toBe(3);
    expect(finished().map(s => s.attributes['url.path'])).toEqual(['/users']);
    expect(activeDuringIgnored).toBeUndefined();
  });

  it('captures configured request and response headers', () => {
    const mw = createOpenTelemetryMiddleware({
      captureRequestHeaders: ['X-Tenant-Id'],
      captureResponseHeaders: ['Content-Type'],
    });
    const { res, finish } = fakeResponse(200);

    context.with(ROOT_CONTEXT, () => {
      mw(fakeRequest('GET', '/users', { 'x-tenant-id': 'acme' }), res, () => {});
      res.setHeader('Content-Type', 'application/json');
      finish();
    });

    const span = finished()[0] as ReadableSpan;
    expect(span.attributes['http.request.header.x-tenant-id']).toEqual(['acme']);
    expect(span.attributes['http.response.header.content-type']).toEqual(['application/json']);
  });

  it('maps unknown methods to _OTHER and keeps the original', () => {
    const mw = createOpenTelemetryMiddleware();
    const { res, finish } = fakeResponse(200);

    context.with(ROOT_CONTEXT, () => {
      mw(fakeRequest('PURGE', '/users'), res, () => {});
      finish();
    });

    const span = finished()[0] as ReadableSpan;
    expect(span.name).toBe('HTTP');
    expect(span.attributes['http.request.method']).toBe('_OTHER');
    expect(span.attributes['http.request.method_original']).toBe('PURGE');
  });

  it('honours a custom span name and static attributes', () => {
    const mw = createOpenTelemetryMiddleware({
      spanName: (req, route) => `${(req.method ?? 'GET').toLowerCase()} ${route ?? 'unmatched'}`,
      attributes: { 'deployment.environment.name': 'test' },
    });
    const { res, finish } = fakeResponse(200);

    context.with(ROOT_CONTEXT, () => {
      mw(fakeRequest('GET', '/users/3'), res, () => {});
      finish();
    });

    const span = finished()[0] as ReadableSpan;
    expect(span.name).toBe('get /users/:id');
    expect(span.attributes['deployment.environment.name']).toBe('test');
  });

  it('instruments a request only once even if registered twice', () => {
    const mw = createOpenTelemetryMiddleware();
    const req = fakeRequest('GET', '/users');
    const { res, finish } = fakeResponse(200);
    let nextCalls = 0;

    context.with(ROOT_CONTEXT, () => {
      mw(req, res, () => nextCalls++);
      mw(req, res, () => nextCalls++);
      finish();
    });

    expect(nextCalls).toBe(2);
    expect(finished()).toHaveLength(1);
  });

  it('records the duration histogram and, when opted in, the active-request counter', async () => {
    const mw = createOpenTelemetryMiddleware({
      attributes: { 'service.tier': 'edge' },
      activeRequests: true,
    });
    const { res, finish } = fakeResponse(201);

    context.with(ROOT_CONTEXT, () => {
      mw(fakeRequest('POST', '/users/5'), res, () => {});
    });

    const inFlight = await metric('http.server.active_requests');
    const inFlightPoint = inFlight?.dataPoints.find(
      p => p.attributes['http.request.method'] === 'POST'
    );
    expect(inFlightPoint?.value).toBe(1);
    expect(inFlightPoint?.attributes).toEqual({
      'http.request.method': 'POST',
      'url.scheme': 'http',
      'service.tier': 'edge',
    });

    finish();

    const duration = await metric('http.server.request.duration');
    expect(duration?.descriptor.unit).toBe('s');
    // The reader is cumulative across tests: select this request's series precisely
    const point = duration?.dataPoints.find(
      p =>
        p.attributes['http.request.method'] === 'POST' &&
        p.attributes['http.route'] === '/users/:id'
    );
    expect(point).toBeDefined();
    expect(point?.attributes).toEqual({
      'http.request.method': 'POST',
      'url.scheme': 'http',
      'http.response.status_code': 201,
      'http.route': '/users/:id',
      'network.protocol.version': '1.1',
      'service.tier': 'edge',
    });
    const histogram = point?.value as { count: number; buckets: { boundaries: number[] } };
    expect(histogram.count).toBe(1);
    // Bucket advice from the semantic conventions is honoured
    expect(histogram.buckets.boundaries[0]).toBe(0.005);

    const settled = await metric('http.server.active_requests');
    expect(
      settled?.dataPoints.find(p => p.attributes['http.request.method'] === 'POST')?.value
    ).toBe(0);
  });

  it('can run traces-only or metrics-only', async () => {
    const tracesOnly = createOpenTelemetryMiddleware({ traces: true, metrics: false });
    const metricsOnly = createOpenTelemetryMiddleware({ traces: false, metrics: true });

    context.with(ROOT_CONTEXT, () => {
      const a = fakeResponse(200);
      tracesOnly(fakeRequest('DELETE', '/users/1'), a.res, () => {});
      a.finish();
      const b = fakeResponse(200);
      metricsOnly(fakeRequest('DELETE', '/users/2'), b.res, () => {});
      b.finish();
    });

    expect(finished().map(s => s.attributes['url.path'])).toEqual(['/users/1']);
    const duration = await metric('http.server.request.duration');
    const deletes = duration?.dataPoints.filter(
      p => p.attributes['http.request.method'] === 'DELETE'
    );
    expect(deletes).toHaveLength(1);
    expect((deletes?.[0]?.value as { count: number }).count).toBe(1);
  });
});
