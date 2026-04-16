/* eslint-disable */
// Integration Tests - app.group() route grouping
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { createTestPort, delay, closeApp } from '../setup.js';

describe('app.group() Route Grouping', () => {
  let app: any;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    app = await createApp({ logger: { level: 'error' } });
    port = createTestPort();
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await closeApp(app);
    await delay(100);
  });

  it('should prefix all routes in a group', async () => {
    app.group('/api', (group: any) => {
      group.get('/users', () => ({ resource: 'users' }));
      group.get('/products', () => ({ resource: 'products' }));
    });

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });
    await delay(100);

    await request(baseUrl)
      .get('/api/users')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.resource).toBe('users');
      });

    await request(baseUrl)
      .get('/api/products')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.resource).toBe('products');
      });
  });

  it('should support all HTTP methods in a group', async () => {
    app.group('/items', (group: any) => {
      group.get('/', () => ({ method: 'GET' }));
      group.post('/', () => ({ method: 'POST' }));
      group.put('/:id', (req: any) => ({ method: 'PUT', id: req.params.id }));
      group.delete('/:id', (req: any) => ({ method: 'DELETE', id: req.params.id }));
      group.patch('/:id', (req: any) => ({ method: 'PATCH', id: req.params.id }));
    });

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });
    await delay(100);

    await request(baseUrl)
      .get('/items')
      .expect(200)
      .expect((res: any) => expect(res.body.method).toBe('GET'));

    await request(baseUrl)
      .post('/items')
      .expect(200)
      .expect((res: any) => expect(res.body.method).toBe('POST'));

    await request(baseUrl)
      .put('/items/42')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.method).toBe('PUT');
        expect(res.body.id).toBe('42');
      });

    await request(baseUrl)
      .delete('/items/42')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.method).toBe('DELETE');
        expect(res.body.id).toBe('42');
      });

    await request(baseUrl)
      .patch('/items/42')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.method).toBe('PATCH');
        expect(res.body.id).toBe('42');
      });
  });

  it('should support the chainable builder API in a group', async () => {
    app.group('/api/v1', (group: any) => {
      group.get('/users').handler((req: any) => ({
        success: true,
        path: req.path,
      }));

      group.post('/users').handler((req: any) => ({
        success: true,
        created: true,
      }));
    });

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });
    await delay(100);

    await request(baseUrl)
      .get('/api/v1/users')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.success).toBe(true);
      });

    await request(baseUrl)
      .post('/api/v1/users')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.success).toBe(true);
        expect(res.body.created).toBe(true);
      });
  });

  it('should support nested groups', async () => {
    app.group('/api', (api: any) => {
      api.group('/v1', (v1: any) => {
        v1.get('/users', () => ({ version: 1, resource: 'users' }));
        v1.get('/orders', () => ({ version: 1, resource: 'orders' }));
      });

      api.group('/v2', (v2: any) => {
        v2.get('/users', () => ({ version: 2, resource: 'users' }));
      });
    });

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });
    await delay(100);

    await request(baseUrl)
      .get('/api/v1/users')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.version).toBe(1);
        expect(res.body.resource).toBe('users');
      });

    await request(baseUrl)
      .get('/api/v1/orders')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.version).toBe(1);
        expect(res.body.resource).toBe('orders');
      });

    await request(baseUrl)
      .get('/api/v2/users')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.version).toBe(2);
        expect(res.body.resource).toBe('users');
      });
  });

  it('should not affect routes registered outside the group', async () => {
    app.get('/standalone', () => ({ standalone: true }));

    app.group('/grouped', (group: any) => {
      group.get('/route', () => ({ grouped: true }));
    });

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });
    await delay(100);

    await request(baseUrl)
      .get('/standalone')
      .expect(200)
      .expect((res: any) => expect(res.body.standalone).toBe(true));

    await request(baseUrl)
      .get('/grouped/route')
      .expect(200)
      .expect((res: any) => expect(res.body.grouped).toBe(true));

    // The un-prefixed path should not exist
    await request(baseUrl).get('/route').expect(404);
  });

  it('should handle route parameters within a group', async () => {
    app.group('/users', (users: any) => {
      users.get('/:userId/posts/:postId', (req: any) => ({
        userId: req.params.userId,
        postId: req.params.postId,
      }));
    });

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });
    await delay(100);

    await request(baseUrl)
      .get('/users/5/posts/99')
      .expect(200)
      .expect((res: any) => {
        expect(res.body.userId).toBe('5');
        expect(res.body.postId).toBe('99');
      });
  });

  it('should normalize trailing slashes on prefix', async () => {
    app.group('/api/', (group: any) => {
      group.get('/test', () => ({ ok: true }));
    });

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });
    await delay(100);

    // Should register as /api/test, not /api//test
    await request(baseUrl)
      .get('/api/test')
      .expect(200)
      .expect((res: any) => expect(res.body.ok).toBe(true));
  });
});
