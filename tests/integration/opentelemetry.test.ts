 
// OpenTelemetry middleware through the real servers: span naming by route
// template, the span being current inside handlers (the dispatcher runs the
// chain iteratively, so this is the property worth proving end to end), error
// classification and W3C trace-context continuation - on both transports.
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { context, propagation, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { createApp, middleware } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp, createTestPort } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  propagation.disable();
  context.disable();
});

async function spansNamed(name: string, count = 1, timeoutMs = 3000): Promise<ReadableSpan[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const matching = exporter.getFinishedSpans().filter(s => s.name === name);
    if (matching.length >= count) return matching;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${count} span(s) named "${name}"; have ${JSON.stringify(
          exporter.getFinishedSpans().map(s => s.name)
        )}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function suite(engine: 'node' | 'moro') {
  let app: any;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
    exporter.reset();
  });

  const boot = async () => {
    const port = createTestPort();
    const seen: Record<string, string | undefined> = {};
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    await app.use(middleware.openTelemetry({ ignorePaths: ['/health'] }));

    app.get('/users/:id', (req: any) => {
      seen.sync = trace.getActiveSpan()?.spanContext().spanId;
      return { id: req.params.id };
    });
    app.get('/orders/:id', async (req: any) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      seen.async = trace.getActiveSpan()?.spanContext().spanId;
      return { id: req.params.id };
    });
    app.get('/boom', () => {
      throw new Error('boom');
    });
    app.get('/health', () => ({ ok: true }));

    await new Promise<void>(resolve => app.listen(port, () => resolve()));
    return { port, seen };
  };

  it('names spans by the route template and keeps them current inside sync and async handlers', async () => {
    const { port, seen } = await boot();

    const users = await fetch(`http://localhost:${port}/users/42?expand=1`);
    expect(users.status).toBe(200);
    const orders = await fetch(`http://localhost:${port}/orders/7`);
    expect(orders.status).toBe(200);

    const [userSpan] = await spansNamed('GET /users/:id');
    const [orderSpan] = await spansNamed('GET /orders/:id');

    expect(userSpan?.kind).toBe(SpanKind.SERVER);
    expect(userSpan?.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/users/:id',
      'url.path': '/users/42',
      'url.query': 'expand=1',
      'http.response.status_code': 200,
    });
    expect(userSpan?.status.code).toBe(SpanStatusCode.UNSET);
    expect(typeof userSpan?.attributes['client.address']).toBe('string');

    // The handler saw this very span as the active one - synchronous and after an await
    expect(seen.sync).toBe(userSpan?.spanContext().spanId);
    expect(seen.async).toBe(orderSpan?.spanContext().spanId);
  });

  it('reports unmatched paths by method only and handler failures as errors', async () => {
    const { port } = await boot();

    const missing = await fetch(`http://localhost:${port}/nope/123`);
    expect(missing.status).toBe(404);
    const boom = await fetch(`http://localhost:${port}/boom`);
    expect(boom.status).toBe(500);

    const [notFound] = await spansNamed('GET');
    expect(notFound?.attributes['http.route']).toBeUndefined();
    expect(notFound?.attributes['url.path']).toBe('/nope/123');
    expect(notFound?.attributes['http.response.status_code']).toBe(404);
    expect(notFound?.status.code).toBe(SpanStatusCode.UNSET);

    const [failed] = await spansNamed('GET /boom');
    expect(failed?.attributes['http.response.status_code']).toBe(500);
    expect(failed?.attributes['error.type']).toBe('500');
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('continues an incoming W3C trace and skips ignored paths', async () => {
    const { port } = await boot();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentId = '00f067aa0ba902b7';

    const res = await fetch(`http://localhost:${port}/users/1`, {
      headers: { traceparent: `00-${traceId}-${parentId}-01` },
    });
    expect(res.status).toBe(200);
    const health = await fetch(`http://localhost:${port}/health`);
    expect(health.status).toBe(200);

    const [span] = await spansNamed('GET /users/:id');
    expect(span?.spanContext().traceId).toBe(traceId);
    expect(span?.parentSpanContext?.spanId).toBe(parentId);

    // Give a stray /health span every chance to show up before asserting it did not
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(exporter.getFinishedSpans().some(s => s.attributes['url.path'] === '/health')).toBe(
      false
    );
  });
}

describe('OpenTelemetry middleware - Node transport', () => suite('node'));
describeEngine('OpenTelemetry middleware - native engine', () => suite('moro'));
