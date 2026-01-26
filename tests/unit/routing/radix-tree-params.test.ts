import { RadixTree } from '../../../src/core/routing/radix-tree';

describe('RadixTree - Parameter Name Handling', () => {
  let tree: RadixTree;

  beforeEach(() => {
    tree = new RadixTree();
  });

  test('should preserve different parameter names at same position', () => {
    // Register two routes with different parameter names
    tree.insert('/users/:email/profile', { id: 'route1' });
    tree.insert('/users/:id/settings', { id: 'route2' });

    // Search should return correct parameter names for each route
    const result1 = tree.search('/users/test@example.com/profile');
    expect(result1?.handler.id).toBe('route1');
    expect(result1?.params).toEqual({ email: 'test@example.com' });

    const result2 = tree.search('/users/123/settings');
    expect(result2?.handler.id).toBe('route2');
    expect(result2?.params).toEqual({ id: '123' });
  });

  test('should handle module routes with different parameter names', () => {
    // Simulate module routes like the user's scenario
    tree.insert('/api/v1.0.0/leads/:leadId/activity', { name: 'getLeadActivity' });
    tree.insert('/api/v1.0.0/users/:userId/activity', { name: 'getUserActivity' });
    tree.insert('/api/v1.0.0/products/:id/activity', { name: 'getProductActivity' });

    // Each should preserve its own parameter name
    const leadResult = tree.search('/api/v1.0.0/leads/123/activity');
    expect(leadResult?.handler.name).toBe('getLeadActivity');
    expect(leadResult?.params).toEqual({ leadId: '123' });

    const userResult = tree.search('/api/v1.0.0/users/456/activity');
    expect(userResult?.handler.name).toBe('getUserActivity');
    expect(userResult?.params).toEqual({ userId: '456' });

    const productResult = tree.search('/api/v1.0.0/products/789/activity');
    expect(productResult?.handler.name).toBe('getProductActivity');
    expect(productResult?.params).toEqual({ id: '789' });
  });

  test('should handle multiple parameters with different names', () => {
    tree.insert('/api/:version/users/:userId/posts/:postId', { id: 'route1' });
    tree.insert('/api/:ver/products/:productId/reviews/:reviewId', { id: 'route2' });

    const result1 = tree.search('/api/v1/users/123/posts/456');
    expect(result1?.params).toEqual({
      version: 'v1',
      userId: '123',
      postId: '456',
    });

    const result2 = tree.search('/api/v2/products/789/reviews/101');
    expect(result2?.params).toEqual({
      ver: 'v2',
      productId: '789',
      reviewId: '101',
    });
  });

  test('should handle routes with same parameter name correctly', () => {
    // When parameter names are the same, it should still work
    tree.insert('/users/:id/profile', { id: 'route1' });
    tree.insert('/users/:id/settings', { id: 'route2' });

    const result1 = tree.search('/users/123/profile');
    expect(result1?.handler.id).toBe('route1');
    expect(result1?.params).toEqual({ id: '123' });

    const result2 = tree.search('/users/456/settings');
    expect(result2?.handler.id).toBe('route2');
    expect(result2?.params).toEqual({ id: '456' });
  });

  test('should return null for non-matching routes', () => {
    tree.insert('/users/:id/profile', { id: 'route1' });

    const result = tree.search('/users/123/nonexistent');
    expect(result).toBeNull();
  });

  test('should handle root parameter routes', () => {
    tree.insert('/:id', { id: 'root' });
    tree.insert('/:slug/page', { id: 'page' });

    const result1 = tree.search('/123');
    expect(result1?.params).toEqual({ id: '123' });

    const result2 = tree.search('/hello/page');
    expect(result2?.params).toEqual({ slug: 'hello' });
  });
});
