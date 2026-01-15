// @ts-nocheck
// Unit Tests - Validation Error Handler
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { validate, z, ValidationConfig } from '../../src/index.js';
import type { ValidationErrorHandler } from '../../src/types/config.js';
import { resetConfigForTesting } from '../../src/core/config/config-manager.js';
import { initializeConfig } from '../../src/core/config/index.js';

describe('Validation Error Handler', () => {
  // Mock HTTP objects for testing
  const createMockRequest = (data: any = {}): any => ({
    method: 'POST',
    path: '/test',
    url: '/test',
    query: {},
    params: {},
    body: {},
    headers: {},
    requestId: 'test-123',
    ...data,
  });

  const createMockResponse = (): any => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      headersSent: false,
    };
    return res;
  };

  beforeEach(() => {
    resetConfigForTesting();
  });

  afterEach(() => {
    resetConfigForTesting();
  });

  it('should use global validation error handler', async () => {
    const customHandler: ValidationErrorHandler = (errors, context) => ({
      status: 422,
      body: {
        error: 'CUSTOM_VALIDATION_ERROR',
        message: 'Custom validation failed',
        issues: errors,
        path: context.request.path,
      },
    });

    // Initialize config with custom handler
    initializeConfig({
      validation: {
        onError: customHandler,
      },
      logging: { level: 'error' },
    });

    const schema = z.object({
      name: z.string().min(2),
      email: z.string().email(),
    });

    const config: ValidationConfig = { body: schema };
    const handler = jest.fn();

    const req = createMockRequest({
      body: { name: 'a', email: 'invalid' },
    });
    const res = createMockResponse();

    const wrappedHandler = validate(config, handler);
    await wrappedHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CUSTOM_VALIDATION_ERROR',
        message: 'Custom validation failed',
        issues: expect.any(Array),
        path: '/test',
      })
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('should use route-level validation error handler over global', async () => {
    const globalHandler: ValidationErrorHandler = () => ({
      status: 400,
      body: { error: 'GLOBAL_ERROR' },
    });

    const routeHandler: ValidationErrorHandler = errors => ({
      status: 422,
      body: {
        error: 'ROUTE_LEVEL_ERROR',
        details: errors.map(e => ({ field: e.field, msg: e.message })),
      },
    });

    // Initialize config with global handler
    initializeConfig({
      validation: {
        onError: globalHandler,
      },
      logging: { level: 'error' },
    });

    const schema = z.object({
      name: z.string().min(2),
    });

    const config: ValidationConfig = {
      body: schema,
      onValidationError: routeHandler,
    };
    const handler = jest.fn();

    const req = createMockRequest({
      body: { name: 'a' },
    });
    const res = createMockResponse();

    const wrappedHandler = validate(config, handler);
    await wrappedHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'ROUTE_LEVEL_ERROR',
        details: expect.any(Array),
      })
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('should use default error handler when no custom handler provided', async () => {
    // Initialize config without custom handler
    initializeConfig({
      logging: { level: 'error' },
    });

    const schema = z.object({
      email: z.string().email(),
    });

    const config: ValidationConfig = { body: schema };
    const handler = jest.fn();

    const req = createMockRequest({
      body: { email: 'invalid' },
    });
    const res = createMockResponse();

    const wrappedHandler = validate(config, handler);
    await wrappedHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Validation failed for body',
        details: expect.any(Array),
      })
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('should handle custom headers in error response', async () => {
    const customHandler: ValidationErrorHandler = errors => ({
      status: 422,
      body: { error: 'VALIDATION_FAILED', errors },
      headers: {
        'X-Custom-Header': 'validation-error',
        'X-Error-Count': String(errors.length),
      },
    });

    // Initialize config with custom handler
    initializeConfig({
      validation: {
        onError: customHandler,
      },
      logging: { level: 'error' },
    });

    const schema = z.object({ name: z.string() });

    const config: ValidationConfig = { body: schema };
    const handler = jest.fn();

    const req = createMockRequest({
      body: { name: 123 },
    });
    const res = createMockResponse();

    const wrappedHandler = validate(config, handler);
    await wrappedHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.setHeader).toHaveBeenCalledWith('X-Custom-Header', 'validation-error');
    expect(res.setHeader).toHaveBeenCalledWith('X-Error-Count', expect.any(String));
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'VALIDATION_FAILED',
        errors: expect.any(Array),
      })
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('should provide validation context to error handler', async () => {
    let capturedContext: any = null;

    const customHandler: ValidationErrorHandler = (errors, context) => {
      capturedContext = context;
      return {
        status: 422,
        body: { error: 'TEST' },
      };
    };

    // Initialize config with custom handler
    initializeConfig({
      validation: {
        onError: customHandler,
      },
      logging: { level: 'error' },
    });

    const schema = z.object({ name: z.string() });
    const config: ValidationConfig = { body: schema };
    const handler = jest.fn();

    const req = createMockRequest({
      method: 'POST',
      path: '/api/users',
      url: '/api/users',
      body: { name: 123 },
    });
    const res = createMockResponse();

    const wrappedHandler = validate(config, handler);
    await wrappedHandler(req, res);

    expect(capturedContext).toBeDefined();
    expect(capturedContext.request.method).toBe('POST');
    expect(capturedContext.request.path).toBe('/api/users');
    expect(capturedContext.field).toBe('body');
  });

  it('should handle validation errors for query parameters', async () => {
    const customHandler: ValidationErrorHandler = (errors, context) => ({
      status: 422,
      body: {
        error: 'QUERY_VALIDATION_ERROR',
        field: context.field,
        issues: errors,
      },
    });

    // Initialize config with custom handler
    initializeConfig({
      validation: {
        onError: customHandler,
      },
      logging: { level: 'error' },
    });

    const schema = z.object({
      limit: z.coerce.number().min(1).max(100),
    });

    const config: ValidationConfig = { query: schema };
    const handler = jest.fn();

    const req = createMockRequest({
      query: { limit: '500' }, // Invalid - exceeds max
    });
    const res = createMockResponse();

    const wrappedHandler = validate(config, handler);
    await wrappedHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'QUERY_VALIDATION_ERROR',
        field: 'query',
        issues: expect.any(Array),
      })
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('should handle validation errors for params', async () => {
    const customHandler: ValidationErrorHandler = (errors, context) => ({
      status: 422,
      body: {
        error: 'PARAMS_VALIDATION_ERROR',
        field: context.field,
        issues: errors,
      },
    });

    // Initialize config with custom handler
    initializeConfig({
      validation: {
        onError: customHandler,
      },
      logging: { level: 'error' },
    });

    const schema = z.object({
      id: z.string().uuid(),
    });

    const config: ValidationConfig = { params: schema };
    const handler = jest.fn();

    const req = createMockRequest({
      params: { id: 'not-a-uuid' },
    });
    const res = createMockResponse();

    const wrappedHandler = validate(config, handler);
    await wrappedHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'PARAMS_VALIDATION_ERROR',
        field: 'params',
        issues: expect.any(Array),
      })
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
