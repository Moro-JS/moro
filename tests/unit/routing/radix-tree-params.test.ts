import { RadixTree } from '../../../src/core/routing/radix-tree.js';

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

describe('RadixTree - optional forms and wildcards', () => {
  let tree: RadixTree;
  const found = (path: string) => {
    const result = tree.search(path);
    return result ? [result.handler, result.params] : null;
  };

  beforeEach(() => {
    tree = new RadixTree();
  });

  test('a route with exactly a path keeps it from an optional form, whichever is inserted first', () => {
    tree.insert('/users', 'optional', { optional: true });
    tree.insert('/users/:id', 'optional', { optional: true });
    expect(found('/users')).toEqual(['optional', {}]);
    expect(found('/users/')).toEqual(['optional', {}]);
    expect(found('/users/7')).toEqual(['optional', { id: '7' }]);

    // Inserted after the optional form: takes the path over
    tree.insert('/users/:userId', 'required');
    expect(found('/users/7')).toEqual(['required', { userId: '7' }]);
    expect(found('/users')).toEqual(['optional', {}]);

    // Inserted before it: keeps the path
    tree.insert('/accounts/:accountId', 'required');
    tree.insert('/accounts', 'optional', { optional: true });
    tree.insert('/accounts/:id', 'optional', { optional: true });
    expect(found('/accounts/7')).toEqual(['required', { accountId: '7' }]);
    expect(found('/accounts')).toEqual(['optional', {}]);

    // Between two optional forms of one path the later one answers, as for
    // any two routes with one path
    tree.insert('/a/:b', 'first', { optional: true });
    tree.insert('/a/:c', 'second', { optional: true });
    expect(found('/a/1')).toEqual(['second', { c: '1' }]);
  });

  test('a wildcard takes what follows the slash after its path', () => {
    tree.insert('/files', 'files', { wildcard: '*' });

    expect(found('/files')).toBeNull();
    expect(found('/files/')).toEqual(['files', { '*': '' }]);
    expect(found('/files/a')).toEqual(['files', { '*': 'a' }]);
    expect(found('/files/a/b.txt')).toEqual(['files', { '*': 'a/b.txt' }]);
    expect(found('/files/a/')).toEqual(['files', { '*': 'a/' }]);
    expect(found('/files/a%2Fb/c')).toEqual(['files', { '*': 'a/b/c' }]);
    expect(found('/filesystem/a')).toBeNull();
  });

  test('a wildcard does not take a path with an empty segment', () => {
    tree.insert('/files', 'files', { wildcard: '*' });
    tree.insert('', 'everything', { wildcard: '*' });

    for (const path of ['/files//x', '/files/a//b', '/files/a//', '/files//', '//files/a', '//']) {
      expect(found(path)).toBeNull();
    }
    expect(found('/')).toEqual(['everything', { '*': '' }]);
    expect(found('/other/x')).toEqual(['everything', { '*': 'other/x' }]);
  });

  test('a wildcard is tried after every other route, whatever the order of insertion', () => {
    tree.insert('/files', 'wild', { wildcard: '*' });
    tree.insert('/files/:name', 'param');
    tree.insert('/files/:name/meta', 'meta');

    expect(found('/files/a')).toEqual(['param', { name: 'a' }]);
    expect(found('/files/a/')).toEqual(['param', { name: 'a' }]);
    expect(found('/files/a/meta')).toEqual(['meta', { name: 'a' }]);
    expect(found('/files/a/other')).toEqual(['wild', { '*': 'a/other' }]);
    expect(found('/files/')).toEqual(['wild', { '*': '' }]);
  });

  test('a route that matches the whole path wins over a wildcard deeper in the tree', () => {
    tree.insert('/a/b', 'deep-wild', { wildcard: '*' });
    tree.insert('/a/:x/c', 'param');

    expect(found('/a/b/c')).toEqual(['param', { x: 'b' }]);
    expect(found('/a/b/d')).toEqual(['deep-wild', { '*': 'd' }]);
  });

  test('among wildcards the one with the longest path in front of it answers', () => {
    tree.insert('', 'root', { wildcard: '*' });
    tree.insert('/files', 'files', { wildcard: '*' });
    tree.insert('/files/img', 'img', { wildcard: 'rest' });
    tree.insert('/files/:kind/raw', 'raw', { wildcard: '*' });

    expect(found('/files/img/a.png')).toEqual(['img', { rest: 'a.png' }]);
    expect(found('/files/img')).toEqual(['files', { '*': 'img' }]);
    expect(found('/files/doc/raw/x/y')).toEqual(['raw', { kind: 'doc', '*': 'x/y' }]);
    expect(found('/files/doc/other')).toEqual(['files', { '*': 'doc/other' }]);
    expect(found('/elsewhere')).toEqual(['root', { '*': 'elsewhere' }]);
  });

  test('clear() forgets wildcards, and the tree takes new ones', () => {
    tree.insert('/files', 'old', { wildcard: '*' });
    tree.clear();
    expect(found('/files/a')).toBeNull();

    tree.insert('/docs', 'new', { wildcard: '*' });
    expect(found('/docs/a/b')).toEqual(['new', { '*': 'a/b' }]);
    expect(found('/files/a')).toBeNull();
  });
});
