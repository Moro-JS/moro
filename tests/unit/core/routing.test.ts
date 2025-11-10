/* eslint-disable */
// Unit Tests - Intelligent Routing System
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createRoute, EXECUTION_PHASES, z, defineModule } from '../../../src/index.js';

describe('Intelligent Routing System', () => {
  describe('createRoute helper', () => {
    it('should create a route builder for GET', () => {
      const builder = createRoute('GET', '/test');
      expect(builder).toBeDefined();
      expect(typeof builder).toBe('object');
    });

    it('should create a route builder for POST', () => {
      const builder = createRoute('POST', '/users');
      expect(builder).toBeDefined();
      expect(typeof builder).toBe('object');
    });

    it('should create routes for all HTTP methods', () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

      methods.forEach(method => {
        const builder = createRoute(method, '/test');
        expect(builder).toBeDefined();
        expect(typeof builder).toBe('object');
      });
    });

    it('should create routes with different paths', () => {
      const paths = ['/users', '/users/:id', '/api/v1/users', '/complex/path/with/many/segments'];

      paths.forEach(path => {
        const builder = createRoute('GET', path);
        expect(builder).toBeDefined();
      });
    });
  });

  describe('EXECUTION_PHASES', () => {
    it('should define all required execution phases', () => {
      expect(EXECUTION_PHASES).toBeDefined();
      expect(Array.isArray(EXECUTION_PHASES)).toBe(true);

      // Check that the phases exist in the array
      expect(EXECUTION_PHASES).toContain('security');
      expect(EXECUTION_PHASES).toContain('parsing');
      expect(EXECUTION_PHASES).toContain('rateLimit');
      expect(EXECUTION_PHASES).toContain('auth');
      expect(EXECUTION_PHASES).toContain('validation');
      expect(EXECUTION_PHASES).toContain('cache');
      expect(EXECUTION_PHASES).toContain('handler');
    });

    it('should have string values for phases', () => {
      EXECUTION_PHASES.forEach(phase => {
        expect(typeof phase).toBe('string');
        expect(phase.length).toBeGreaterThan(0);
      });
    });

    it('should have correct phase order', () => {
      const expectedOrder = [
        'security',
        'parsing',
        'rateLimit',
        'before',
        'auth',
        'validation',
        'transform',
        'cache',
        'after',
        'handler',
      ];

      expect(EXECUTION_PHASES).toEqual(expectedOrder);
    });

    it('should have 10 execution phases', () => {
      expect(EXECUTION_PHASES.length).toBe(10);
    });
  });

  describe('Route Builder Validation', () => {
    it('should work with Zod schemas', () => {
      const userSchema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
        age: z.number().min(18).optional(),
      });

      // Test that the schema works
      const validUser = { name: 'John Doe', email: 'john@example.com', age: 25 };
      const invalidUser = { name: 'J', email: 'invalid', age: 16 };

      expect(userSchema.safeParse(validUser).success).toBe(true);
      expect(userSchema.safeParse(invalidUser).success).toBe(false);

      // Test that we can create a route with this schema
      const builder = createRoute('POST', '/users');
      expect(builder).toBeDefined();
    });

    it('should work with query parameter schemas', () => {
      const querySchema = z.object({
        page: z.coerce.number().min(1).default(1),
        limit: z.coerce.number().min(1).max(100).default(10),
        search: z.string().optional(),
      });

      // Test schema functionality
      const validQuery = { page: '2', limit: '25', search: 'test' };
      const result = querySchema.parse(validQuery);

      expect(result).toEqual({ page: 2, limit: 25, search: 'test' });

      // Test route creation
      const builder = createRoute('GET', '/search');
      expect(builder).toBeDefined();
    });

    it('should work with path parameter schemas', () => {
      const paramsSchema = z.object({
        id: z.string().uuid(),
        category: z.enum(['users', 'posts', 'comments']),
      });

      // Test schema functionality
      const validParams = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        category: 'users',
      };
      const invalidParams = {
        id: 'invalid-uuid',
        category: 'invalid-category',
      };

      expect(paramsSchema.safeParse(validParams).success).toBe(true);
      expect(paramsSchema.safeParse(invalidParams).success).toBe(false);

      // Test route creation
      const builder = createRoute('GET', '/api/:category/:id');
      expect(builder).toBeDefined();
    });
  });

  describe('Complex Validation Scenarios', () => {
    it('should handle nested object validation', () => {
      const complexSchema = z.object({
        user: z.object({
          profile: z.object({
            name: z.string(),
            age: z.number(),
          }),
          settings: z.object({
            theme: z.enum(['light', 'dark']),
            notifications: z.boolean(),
          }),
        }),
        metadata: z.object({
          source: z.string(),
          timestamp: z.string().datetime(),
        }),
      });

      const validData = {
        user: {
          profile: { name: 'John', age: 30 },
          settings: { theme: 'dark', notifications: true },
        },
        metadata: {
          source: 'api',
          timestamp: new Date().toISOString(),
        },
      };

      expect(complexSchema.safeParse(validData).success).toBe(true);

      // Test route creation with complex schema
      const builder = createRoute('POST', '/complex');
      expect(builder).toBeDefined();
    });

    it('should handle array validation', () => {
      const arraySchema = z.object({
        items: z
          .array(
            z.object({
              id: z.number(),
              name: z.string(),
              tags: z.array(z.string()).max(5),
            })
          )
          .min(1)
          .max(10),
      });

      const validData = {
        items: [
          { id: 1, name: 'Item 1', tags: ['tag1', 'tag2'] },
          { id: 2, name: 'Item 2', tags: ['tag3'] },
        ],
      };

      expect(arraySchema.safeParse(validData).success).toBe(true);

      // Test route creation
      const builder = createRoute('POST', '/batch');
      expect(builder).toBeDefined();
    });

    it('should handle custom validation refinements', () => {
      const passwordSchema = z
        .object({
          password: z.string().min(8),
          confirmPassword: z.string(),
        })
        .refine((data: any) => data.password === data.confirmPassword, {
          message: "Passwords don't match",
          path: ['confirmPassword'],
        });

      const validData = {
        password: 'secret123',
        confirmPassword: 'secret123',
      };

      const invalidData = {
        password: 'secret123',
        confirmPassword: 'different',
      };

      expect(passwordSchema.safeParse(validData).success).toBe(true);
      expect(passwordSchema.safeParse(invalidData).success).toBe(false);

      // Test route creation
      const builder = createRoute('POST', '/register');
      expect(builder).toBeDefined();
    });
  });

  describe('Module Configuration', () => {
    it('should handle modules with dependencies', () => {
      const module = defineModule({
        name: 'dependent-module',
        version: '1.0.0',
        dependencies: ['auth@1.0.0', 'users@2.0.0', 'database@1.5.0'],
      });

      expect(module.dependencies).toEqual(['auth@1.0.0', 'users@2.0.0', 'database@1.5.0']);
    });

    it('should handle modules with custom configuration', () => {
      const module = defineModule({
        name: 'configurable-module',
        version: '1.0.0',
        config: {
          apiEndpoint: 'https://api.example.com',
          timeout: 5000,
          retries: 3,
          features: {
            caching: true,
            logging: false,
            analytics: true,
          },
        },
      });

      expect(module.config).toEqual({
        apiEndpoint: 'https://api.example.com',
        timeout: 5000,
        retries: 3,
        features: {
          caching: true,
          logging: false,
          analytics: true,
        },
      });
    });

    it('should handle modules with no routes or sockets', () => {
      const module = defineModule({
        name: 'config-only-module',
        version: '1.0.0',
        config: {
          setting1: 'value1',
          setting2: 42,
          setting3: true,
        },
      });

      expect(module.name).toBe('config-only-module');
      expect(module.version).toBe('1.0.0');
      expect(module.config).toBeDefined();
      expect(module.routes).toBeUndefined();
      expect(module.sockets).toBeUndefined();
    });
  });
});
