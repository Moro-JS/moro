import { describe, it, expect, beforeEach } from '@jest/globals';
import { UnifiedRouter } from '../../../src/core/routing/unified-router.js';

describe('UnifiedRouter.matchRoute', () => {
  let router: UnifiedRouter;

  beforeEach(() => {
    UnifiedRouter.reset();
    router = UnifiedRouter.getInstance();
    router.get('/users').handler(() => ({ ok: true }));
    router.get('/users/:id').handler(() => ({ ok: true }));
    router.post('/users/:id/orders/:orderId').handler(() => ({ ok: true }));
  });

  it('returns the template of a static route', () => {
    expect(router.matchRoute('GET', '/users')).toBe('/users');
  });

  it('returns the template of a parametric route, not the concrete path', () => {
    expect(router.matchRoute('GET', '/users/42')).toBe('/users/:id');
    expect(router.matchRoute('POST', '/users/42/orders/7')).toBe('/users/:id/orders/:orderId');
  });

  it('is method-specific and case-tolerant', () => {
    expect(router.matchRoute('POST', '/users/42')).toBeUndefined();
    expect(router.matchRoute('get', '/users/42')).toBe('/users/:id');
  });

  it('returns undefined for unmatched paths', () => {
    expect(router.matchRoute('GET', '/nope')).toBeUndefined();
    expect(router.matchRoute('GET', '/users/42/extra')).toBeUndefined();
  });

  it('does not touch the request or execute anything', () => {
    const before = router.getStats().requestCount;
    router.matchRoute('GET', '/users/42');
    expect(router.getStats().requestCount).toBe(before);
  });
});
