/* eslint-disable */
// @ts-nocheck
// Unit Tests - MoroJS Validation Integration
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { validate, body, query, params, z, ValidationConfig } from '../../../src/index.js';

describe('MoroJS Validation Integration', () => {
  // Mock HTTP objects for testing
  const createMockRequest = (data: any = {}): any => ({
    method: 'GET',
    path: '/test',
    query: {},
    params: {},
    body: {},
    headers: {},
    ...data,
  });

  const createMockResponse = (): any => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      headersSent: false,
    };
    return res;
  };

  describe('validate function', () => {
    it('should validate body successfully', async () => {
      const schema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
      });

      const config: ValidationConfig = { body: schema };
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({
        body: { name: 'John Doe', email: 'john@example.com' },
      });
      const res = createMockResponse();

      const wrappedHandler = validate(config, handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { name: 'John Doe', email: 'john@example.com' },
        }),
        res
      );
    });

    it('should return validation error for invalid body', async () => {
      const schema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
      });

      const config: ValidationConfig = { body: schema };
      const handler = jest.fn();

      const req = createMockRequest({
        body: { name: 'J', email: 'invalid-email' },
      });
      const res = createMockResponse();

      const wrappedHandler = validate(config, handler);
      await wrappedHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Validation failed for body',
        })
      );
      expect(handler).not.toHaveBeenCalled();
    });

    it('should validate query parameters with coercion', async () => {
      const schema = z.object({
        limit: z.coerce.number().min(1).max(100).default(10),
        search: z.string().optional(),
      });

      const config: ValidationConfig = { query: schema };
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({
        query: { limit: '25', search: 'test' },
      });
      const res = createMockResponse();

      const wrappedHandler = validate(config, handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { limit: 25, search: 'test' },
        }),
        res
      );
    });

    it('should validate path parameters', async () => {
      const schema = z.object({
        id: z.string().uuid(),
        category: z.enum(['user', 'admin']),
      });

      const config: ValidationConfig = { params: schema };
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({
        params: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          category: 'user',
        },
      });
      const res = createMockResponse();

      const wrappedHandler = validate(config, handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          params: {
            id: '123e4567-e89b-12d3-a456-426614174000',
            category: 'user',
          },
        }),
        res
      );
    });
  });

  describe('convenience functions', () => {
    it('body() should create body validation wrapper', async () => {
      const schema = z.object({ name: z.string() });
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({ body: { name: 'John' } });
      const res = createMockResponse();

      const wrappedHandler = body(schema)(handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { name: 'John' },
        }),
        res
      );
    });

    it('query() should create query validation wrapper', async () => {
      const schema = z.object({ limit: z.coerce.number() });
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({ query: { limit: '10' } });
      const res = createMockResponse();

      const wrappedHandler = query(schema)(handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { limit: 10 },
        }),
        res
      );
    });

    it('params() should create params validation wrapper', async () => {
      const schema = z.object({ id: z.string().uuid() });
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
      });
      const res = createMockResponse();

      const wrappedHandler = params(schema)(handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        }),
        res
      );
    });
  });
});
