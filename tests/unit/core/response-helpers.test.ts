/**
 * Test: Standardized Response Helpers
 *
 * Tests for the response helper functions
 */

import { describe, it, expect } from '@jest/globals';
import { performance } from 'perf_hooks';
import {
  response,
  ResponseBuilder,
  ApiSuccessResponse,
  ApiErrorResponse,
} from '../../../src/index.js';

describe('Response Helpers', () => {
  describe('response.success()', () => {
    it('should create a success response', () => {
      const data = { id: 1, name: 'Test' };
      const result = response.success(data);

      expect(result).toEqual({
        success: true,
        data: { id: 1, name: 'Test' },
      });
    });

    it('should create a success response with message', () => {
      const data = { id: 1, name: 'Test' };
      const result = response.success(data, 'Created successfully');

      expect(result).toEqual({
        success: true,
        data: { id: 1, name: 'Test' },
        message: 'Created successfully',
      });
    });
  });

  describe('response.error()', () => {
    it('should create a basic error response', () => {
      const result = response.error('Something went wrong');

      expect(result).toEqual({
        success: false,
        error: 'Something went wrong',
      });
    });

    it('should create an error response with code', () => {
      const result = response.error('Database error', 'DB_ERROR');

      expect(result).toEqual({
        success: false,
        error: 'Database error',
        code: 'DB_ERROR',
      });
    });

    it('should create an error response with code and message', () => {
      const result = response.error('Database error', 'DB_ERROR', 'Unable to connect to database');

      expect(result).toEqual({
        success: false,
        error: 'Database error',
        code: 'DB_ERROR',
        message: 'Unable to connect to database',
      });
    });
  });

  describe('response.validationError()', () => {
    it('should create a validation error response', () => {
      const details = [
        { field: 'email', message: 'Invalid email', code: 'INVALID_EMAIL' },
        { field: 'name', message: 'Required', code: 'REQUIRED' },
      ];

      const result = response.validationError(details);

      expect(result).toEqual({
        success: false,
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        message: 'One or more fields failed validation',
        details,
      });
    });

    it('should create a validation error with custom message', () => {
      const details = [{ field: 'email', message: 'Invalid email' }];
      const result = response.validationError(details, 'Custom validation message');

      expect(result.message).toBe('Custom validation message');
    });
  });

  describe('HTTP error helpers', () => {
    it('unauthorized() should create 401 response', () => {
      const result = response.unauthorized('Please log in');

      expect(result).toEqual({
        success: false,
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        message: 'Please log in',
      });
    });

    it('forbidden() should create 403 response', () => {
      const result = response.forbidden('Admin only');

      expect(result).toEqual({
        success: false,
        error: 'Forbidden',
        code: 'FORBIDDEN',
        message: 'Admin only',
      });
    });

    it('notFound() should create 404 response', () => {
      const result = response.notFound('User');

      expect(result).toEqual({
        success: false,
        error: 'Not Found',
        code: 'NOT_FOUND',
        message: 'User not found',
      });
    });

    it('conflict() should create 409 response', () => {
      const result = response.conflict('Email already exists');

      expect(result).toEqual({
        success: false,
        error: 'Conflict',
        code: 'CONFLICT',
        message: 'Email already exists',
      });
    });

    it('badRequest() should create 400 response', () => {
      const result = response.badRequest('Invalid input');

      expect(result).toEqual({
        success: false,
        error: 'Bad Request',
        code: 'BAD_REQUEST',
        message: 'Invalid input',
      });
    });

    it('internalError() should create 500 response', () => {
      const result = response.internalError('Server error');

      expect(result).toEqual({
        success: false,
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
        message: 'Server error',
      });
    });

    it('rateLimited() should create 429 response', () => {
      const result = response.rateLimited(60);

      expect(result).toEqual({
        success: false,
        error: 'Too Many Requests',
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded',
        details: { retryAfter: 60 },
      });
    });
  });

  describe('response object', () => {
    it('should expose all helper functions', () => {
      expect(response.success).toBeDefined();
      expect(response.error).toBeDefined();
      expect(response.validationError).toBeDefined();
      expect(response.unauthorized).toBeDefined();
      expect(response.forbidden).toBeDefined();
      expect(response.notFound).toBeDefined();
      expect(response.conflict).toBeDefined();
      expect(response.badRequest).toBeDefined();
      expect(response.internalError).toBeDefined();
      expect(response.rateLimited).toBeDefined();
    });
  });

  describe('ResponseBuilder', () => {
    it('should build a success response', () => {
      const data = { id: 1, name: 'Test' };
      const result = ResponseBuilder.success(data).build();

      expect(result).toEqual({
        success: true,
        data: { id: 1, name: 'Test' },
      });
    });

    it('should build a success response with message', () => {
      const data = { id: 1, name: 'Test' };
      const result = ResponseBuilder.success(data).message('Created successfully').build();

      expect(result).toEqual({
        success: true,
        data: { id: 1, name: 'Test' },
        message: 'Created successfully',
      });
    });

    it('should build an error response', () => {
      const result = ResponseBuilder.error('Database error', 'DB_ERROR').build();

      expect(result).toEqual({
        success: false,
        error: 'Database error',
        code: 'DB_ERROR',
      });
    });

    it('should build an error response with all fields', () => {
      const result = ResponseBuilder.error('Database error', 'DB_ERROR')
        .message('Unable to connect')
        .details({ host: 'localhost', port: 5432 })
        .build();

      expect(result).toEqual({
        success: false,
        error: 'Database error',
        code: 'DB_ERROR',
        message: 'Unable to connect',
        details: { host: 'localhost', port: 5432 },
      });
    });

    it('should allow method chaining', () => {
      const result = ResponseBuilder.error('Test error')
        .code('TEST_ERROR')
        .message('Test message')
        .details({ test: true })
        .build();

      expect(result).toEqual({
        success: false,
        error: 'Test error',
        code: 'TEST_ERROR',
        message: 'Test message',
        details: { test: true },
      });
    });
  });

  describe('TypeScript types', () => {
    it('should work with ApiSuccessResponse type', () => {
      interface User {
        id: number;
        name: string;
      }

      const result: ApiSuccessResponse<User> = response.success<User>({
        id: 1,
        name: 'Test',
      });

      expect(result.success).toBe(true);
      expect(result.data.id).toBe(1);
      expect(result.data.name).toBe('Test');
    });

    it('should work with ApiErrorResponse type', () => {
      const result: ApiErrorResponse = response.error('Test error', 'TEST_CODE');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Test error');
      expect(result.code).toBe('TEST_CODE');
    });
  });

  describe('Performance', () => {
    it('should be lightweight (just return objects)', () => {
      const start = performance.now();

      for (let i = 0; i < 10000; i++) {
        response.success({ id: i, name: 'Test' });
      }

      const end = performance.now();
      const duration = end - start;

      // Should be very fast (< 10ms for 10k operations)
      expect(duration).toBeLessThan(10);
    });

    it('should create objects without unnecessary overhead', () => {
      const data = { id: 1, name: 'Test' };
      const result = response.success(data);

      // Should only have the necessary properties
      expect(Object.keys(result)).toEqual(['success', 'data']);
    });

    it('should not include undefined properties', () => {
      const result1 = response.success({ id: 1 });
      expect('message' in result1).toBe(false);

      const result2 = response.error('Test');
      expect('code' in result2).toBe(false);
      expect('message' in result2).toBe(false);
    });
  });

  describe('Integration with framework', () => {
    it('should match fast-path optimization format', () => {
      // The framework optimizes responses with { success, data } or { success, error }
      const successResp = response.success({ id: 1 });
      expect(successResp).toHaveProperty('success', true);
      expect(successResp).toHaveProperty('data');

      const errorResp = response.error('Test');
      expect(errorResp).toHaveProperty('success', false);
      expect(errorResp).toHaveProperty('error');
    });

    it('should work with OpenAPI documentation format', () => {
      const result = response.success({ id: 1 }, 'Success message');

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('message');
    });
  });
});
