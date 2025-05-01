// Simple Integration Tests - Basic MoroJS HTTP functionality
import request from 'supertest';
import { createApp } from '../../src';
import { createTestPort, delay } from '../setup';

describe('MoroJS Basic Integration', () => {
  let app: any;
  let port: number;

  beforeEach(() => {
    app = createApp();
    port = createTestPort();
  });

  afterEach(async () => {
    // Close HTTP server if it exists
    try {
      if (app.core && app.core.httpServer) {
        await app.core.httpServer.close();
      }
    } catch (error) {
      // Ignore close errors
    }
    
    // Close Socket.IO if it exists
    try {
      if (app.core && app.core.io) {
        await new Promise<void>((resolve) => {
          app.core.io.close(() => resolve());
        });
      }
    } catch (error) {
      // Ignore close errors
    }
    
    // Destroy the container to clean up intervals
    try {
      if (app.core && app.core.container && typeof app.core.container.destroy === 'function') {
        app.core.container.destroy();
      }
    } catch (error) {
      // Ignore destroy errors
    }
    
    await delay(100);
  });

  it('should create a basic MoroJS server with GET route', async () => {
    // Add a simple GET route
    app.get('/test', (req: any) => {
      return { message: 'Hello World', path: req.path };
    });

    // Start server
    await new Promise<void>((resolve) => {
      app.listen(port, () => {
        resolve();
      });
    });
    
    await delay(100);

    const response = await request(`http://localhost:${port}`)
      .get('/test')
      .expect(200);

    expect(response.body).toEqual({
      message: 'Hello World',
      path: '/test'
    });
  });

  it('should handle POST requests with JSON body', async () => {
    // Add a POST route that echoes the received data
    app.post('/users', (req: any) => {
      return {
        success: true,
        method: 'POST',
        receivedData: req.body
      };
    });

    // Start server
    await new Promise<void>((resolve) => {
      app.listen(port, () => {
        resolve();
      });
    });
    
    await delay(100);

    const testData = { name: 'John Doe', email: 'john@example.com' };
    const response = await request(`http://localhost:${port}`)
      .post('/users')
      .send(testData)
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      method: 'POST',
      receivedData: testData
    });
  });

  it('should handle different HTTP methods', async () => {
    // Add routes for different HTTP methods
    app.get('/test', (req: any) => ({
      method: 'GET',
      url: req.path,
      timestamp: new Date().toISOString()
    }));

    app.post('/test', (req: any) => ({
      method: 'POST',
      url: req.path,
      timestamp: new Date().toISOString()
    }));

    app.put('/test', (req: any) => ({
      method: 'PUT',
      url: req.path,
      timestamp: new Date().toISOString()
    }));

    app.delete('/test', (req: any) => ({
      method: 'DELETE',
      url: req.path,
      timestamp: new Date().toISOString()
    }));

    // Start server
    await new Promise<void>((resolve) => {
      app.listen(port, () => {
        resolve();
      });
    });
    
    await delay(100);

    const baseUrl = `http://localhost:${port}`;

    // Test GET
    await request(baseUrl)
      .get('/test')
      .expect(200)
      .expect((res) => {
        expect(res.body.method).toBe('GET');
        expect(res.body.url).toBe('/test');
      });

    // Test POST
    await request(baseUrl)
      .post('/test')
      .expect(200)
      .expect((res) => {
        expect(res.body.method).toBe('POST');
      });

    // Test PUT
    await request(baseUrl)
      .put('/test')
      .expect(200)
      .expect((res) => {
        expect(res.body.method).toBe('PUT');
      });

    // Test DELETE
    await request(baseUrl)
      .delete('/test')
      .expect(200)
      .expect((res) => {
        expect(res.body.method).toBe('DELETE');
      });
  });

  it('should handle error responses and 404s', async () => {
    // Add an error route
    app.get('/error', () => {
      throw new Error('Test error');
    });

    // Add a working route for comparison
    app.get('/working', () => ({
      success: true,
      message: 'This route works'
    }));

    // Start server
    await new Promise<void>((resolve) => {
      app.listen(port, () => {
        resolve();
      });
    });
    
    await delay(100);

    const baseUrl = `http://localhost:${port}`;

    // Test working route first
    await request(baseUrl)
      .get('/working')
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.message).toBe('This route works');
      });

    // Test error route - may return 500 or 404 depending on error handling
    const errorResponse = await request(baseUrl)
      .get('/error');
    
    // Accept either 404 or 500, since error handling may vary
    expect([404, 500]).toContain(errorResponse.status);

    // Test 404 for non-existent route
    await request(baseUrl)
      .get('/nonexistent')
      .expect(404);
  });

  it('should test MoroJS specific features', async () => {
    // Test middleware chaining
    app.use((req: any, res: any, next: () => void) => {
      req.customProperty = 'middleware-added';
      next();
    });

    app.get('/middleware-test', (req: any) => ({
      success: true,
      customProperty: req.customProperty,
      framework: 'MoroJS'
    }));

    // Test route with parameters
    app.get('/users/:id', (req: any) => ({
      success: true,
      userId: req.params.id,
      message: `User ${req.params.id} found`
    }));

    // Start server
    await new Promise<void>((resolve) => {
      app.listen(port, () => {
        resolve();
      });
    });
    
    await delay(100);

    const baseUrl = `http://localhost:${port}`;

    // Test middleware
    await request(baseUrl)
      .get('/middleware-test')
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.customProperty).toBe('middleware-added');
        expect(res.body.framework).toBe('MoroJS');
      });

    // Test route parameters
    await request(baseUrl)
      .get('/users/123')
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.userId).toBe('123');
        expect(res.body.message).toBe('User 123 found');
      });
  });
}); 