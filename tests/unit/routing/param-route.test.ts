// @ts-nocheck
// Unit Tests - param(name) in place of a handler: the route gets a handler
// that ends the response with req.params[name], and - on a bare route with
// exactly that one parameter - a `paramEcho` shape (prefix, suffix) a native
// engine can answer without JS.
import { describe, it, expect } from '@jest/globals';
import { createRoute, param } from '../../../src/index.js';
import { UnifiedRouter, isParamEcho } from '../../../src/core/routing/unified-router.js';

function fakeRes() {
  const calls: any[] = [];
  return {
    calls,
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

describe('param(name) handlers', () => {
  it('param() produces a frozen marker and rejects a missing name', () => {
    const p = param('id');
    expect(isParamEcho(p)).toBe(true);
    expect(p.name).toBe('id');
    expect(Object.isFrozen(p)).toBe(true);
    expect(isParamEcho({ name: 'id' })).toBe(false);
    expect(() => param('')).toThrow(/parameter name/);
  });

  it('registers the engine shape and a handler that ends with the parameter', () => {
    createRoute('GET', '/pe-user/:id').handler(param('id'));
    const schema = findRoute('GET', '/pe-user/:id');
    expect(schema.paramEcho).toEqual({
      name: 'id',
      prefix: '/pe-user/',
      suffix: '',
      status: 200,
      headers: null,
    });
    const res = fakeRes();
    schema.handler({ params: { id: '42' } }, res);
    expect(res.calls).toEqual([['end', '42']]);
  });

  it('keeps the segments after the parameter as the suffix', () => {
    createRoute('GET', '/pe-users/:id/profile').handler(param('id'));
    expect(findRoute('GET', '/pe-users/:id/profile').paramEcho).toMatchObject({
      prefix: '/pe-users/',
      suffix: '/profile',
    });
  });

  it('stays a plain handler when the engine could not answer it', () => {
    const next = async (_req: any, _res: any, n: () => void) => n();
    createRoute('GET', '/pe-auth/:id')
      .auth({ roles: ['admin'] })
      .handler(param('id'));
    createRoute('GET', '/pe-before/:id').before(next).handler(param('id'));
    createRoute('GET', '/pe-two/:a/:b').handler(param('a')); // two parameters
    createRoute('GET', '/pe-missing/:id').handler(param('other')); // not in the path
    createRoute('GET', '/pe-wild/:id/*').handler(param('id')); // wildcard
    createRoute('GET', '/pe-longer/:identity').handler(param('id')); // ":id" is not the segment
    createRoute('GET', '/pe-trail/:id/').handler(param('id')); // trailing slash: an empty last segment

    for (const path of [
      '/pe-auth/:id',
      '/pe-before/:id',
      '/pe-two/:a/:b',
      '/pe-missing/:id',
      '/pe-wild/:id/*',
      '/pe-longer/:identity',
      '/pe-trail/:id/',
    ]) {
      const schema = findRoute('GET', path);
      expect(schema.paramEcho).toBeUndefined();
      expect(typeof schema.handler).toBe('function');
    }
    const res = fakeRes();
    findRoute('GET', '/pe-two/:a/:b').handler({ params: { a: 'x', b: 'y' } }, res);
    expect(res.calls).toEqual([['end', 'x']]);
  });

  it('rejects a parameter that is only part of a segment', () => {
    // The router would call that parameter "name.json"; param('name') could never see it.
    expect(() => createRoute('GET', '/pe-files/:name.json').handler(param('name'))).toThrow(
      /whole segment/
    );
  });

  it('is accepted by the two-argument form and by route(schema)', async () => {
    const { createApp } = await import('../../../src/index.js');
    const app = await createApp({ logger: { level: 'error' } });
    app.get('/pe-twoarg/:id', param('id'));
    app.route({ method: 'GET', path: '/pe-route/:id', handler: param('id') });
    expect(findRoute('GET', '/pe-twoarg/:id').paramEcho).toMatchObject({ prefix: '/pe-twoarg/' });
    expect(findRoute('GET', '/pe-route/:id').paramEcho).toMatchObject({ prefix: '/pe-route/' });
  });
});
