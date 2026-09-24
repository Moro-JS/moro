// @ts-nocheck
// Unit Tests - a literal body given to RouteBuilder.handler(): the route gets
// a handler that res.send()s the body, and - only when nothing else is
// configured on the route - a `static` reply a native engine can answer
// without JS, carrying the content-type send() would have implied.
import { describe, it, expect } from '@jest/globals';
import { createRoute } from '../../../src/index.js';
import { UnifiedRouter, compileStaticRoute } from '../../../src/core/routing/unified-router.js';

function fakeRes() {
  const calls: any[] = [];
  return {
    calls,
    send(body: any) {
      calls.push(['send', body]);
    },
    end(body?: any) {
      calls.push(['end', body]);
    },
  };
}

function findRoute(method: string, path: string) {
  return UnifiedRouter.getInstance()
    .getAllRoutes()
    .find(r => r.method === method && r.path === path);
}

describe('RouteBuilder.handler() with a literal body', () => {
  it('an empty body goes out as res.end() would: no header block on either path', () => {
    createRoute('GET', '/literal-empty').handler('');
    const schema = findRoute('GET', '/literal-empty');
    expect(schema).toBeDefined();
    expect(schema.static).toEqual({ status: 200, headers: null, body: '' });

    const res = fakeRes();
    schema.handler({}, res);
    expect(res.calls).toEqual([['end', undefined]]);

    const bytes = Buffer.alloc(0);
    createRoute('GET', '/literal-empty-buffer').handler(bytes);
    expect(findRoute('GET', '/literal-empty-buffer').static).toEqual({
      status: 200,
      headers: null,
      body: bytes,
    });
  });

  it('a non-empty body goes out as res.send() would, with the implied content-type', () => {
    createRoute('GET', '/literal-text').handler('ok');
    const schema = findRoute('GET', '/literal-text');
    expect(schema.static).toEqual({
      status: 200,
      headers: ['content-type', 'text/plain; charset=utf-8'],
      body: 'ok',
    });

    const res = fakeRes();
    schema.handler({}, res);
    expect(res.calls).toEqual([['send', 'ok']]);
  });

  it('implies the content-type send() would: JSON-looking text and Buffers', () => {
    createRoute('GET', '/literal-json').handler('{"ok":true}');
    expect(findRoute('GET', '/literal-json').static.headers).toEqual([
      'content-type',
      'application/json; charset=utf-8',
    ]);

    const bytes = Buffer.from([1, 2, 3]);
    createRoute('GET', '/literal-bytes').handler(bytes);
    const schema = findRoute('GET', '/literal-bytes');
    expect(schema.static).toEqual({
      status: 200,
      headers: ['content-type', 'application/octet-stream'],
      body: bytes,
    });
  });

  it('keeps a configured route on the normal pipeline (handler only, no static reply)', () => {
    const next = async (_req: any, _res: any, n: () => void) => n();
    createRoute('GET', '/literal-auth')
      .auth({ roles: ['admin'] })
      .handler('');
    createRoute('GET', '/literal-before').before(next).handler('');
    createRoute('GET', '/literal-rate').rateLimit({ requests: 1, window: 1000 }).handler('');
    createRoute('GET', '/literal-cache').cache({ ttl: 1 }).handler('');
    createRoute('GET', '/literal-user/:id').handler('');
    createRoute('GET', '/literal-files/*').handler('');

    for (const path of [
      '/literal-auth',
      '/literal-before',
      '/literal-rate',
      '/literal-cache',
      '/literal-user/:id',
      '/literal-files/*',
    ]) {
      const schema = findRoute('GET', path);
      expect(schema.static).toBeUndefined();
      const res = fakeRes();
      schema.handler({}, res);
      expect(res.calls).toEqual([['end', undefined]]);
    }

    const arr = compileStaticRoute(
      { method: 'GET', path: '/literal-array', middleware: [next] },
      'x'
    );
    expect(arr.static).toBeUndefined();
  });

  it('is accepted by every entry point: schema-first, app.get(path, body), app.route()', async () => {
    const router = UnifiedRouter.getInstance();
    router.registerRoute({ method: 'GET', path: '/schema-literal', handler: 'from schema' });
    const viaSchema = findRoute('GET', '/schema-literal');
    expect(viaSchema.static).toMatchObject({ status: 200, body: 'from schema' });
    expect(typeof viaSchema.handler).toBe('function');

    const { createApp } = await import('../../../src/index.js');
    const app = await createApp({ logger: { level: 'error' } });
    app.get('/twoarg-literal', '');
    app.post('/twoarg-mw', '', { middleware: [async (_r: any, _s: any, n: () => void) => n()] });
    app.route({ method: 'GET', path: '/route-literal', handler: 'routed' });

    expect(findRoute('GET', '/twoarg-literal').static).toMatchObject({ body: '' });
    const withMiddleware = findRoute('POST', '/twoarg-mw');
    expect(withMiddleware.static).toBeUndefined();
    const res = fakeRes();
    withMiddleware.handler({}, res);
    expect(res.calls).toEqual([['end', undefined]]);
    expect(findRoute('GET', '/route-literal').static).toMatchObject({ body: 'routed' });

    expect(() =>
      router.registerRoute({ method: 'GET', path: '/schema-number', handler: 42 })
    ).toThrow(/must be a function/);
  });

  it('still requires a handler: nothing, null or a number is refused', () => {
    expect(() => createRoute('GET', '/literal-none').handler()).toThrow(/Handler is required/);
    expect(() => createRoute('GET', '/literal-null').handler(null)).toThrow(/Handler is required/);
    expect(() => createRoute('GET', '/literal-number').handler(42)).toThrow(/Handler is required/);
  });
});
