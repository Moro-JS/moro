// Unit Tests - Basic MoroJS Functionality
import { describe, it, expect } from '@jest/globals';
import { z, defineModule } from '../../../src/index.js';

describe('MoroJS Basic Functionality', () => {
  describe('Framework exports', () => {
    it('should export core functions', () => {
      expect(z).toBeDefined();
      expect(defineModule).toBeDefined();
      expect(typeof z.object).toBe('function');
      expect(typeof defineModule).toBe('function');
    });

    it('should have Zod integration working', () => {
      const schema = z.string();
      expect(schema.safeParse('test').success).toBe(true);
      expect(schema.safeParse(123).success).toBe(false);
    });
  });

  describe('Zod validation', () => {
    it('should export Zod', () => {
      expect(z).toBeDefined();
      expect(typeof z.object).toBe('function');
      expect(typeof z.string).toBe('function');
      expect(typeof z.number).toBe('function');
    });

    it('should create and validate schemas', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const validData = { name: 'John', age: 30 };
      const result = schema.safeParse(validData);
      expect(result.success).toBe(true);

      const invalidData = { name: 'John', age: 'thirty' };
      const invalidResult = schema.safeParse(invalidData);
      expect(invalidResult.success).toBe(false);
    });
  });

  describe('defineModule', () => {
    it('should create a module definition', () => {
      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/test',
            handler: async () => ({ success: true }),
          },
        ],
      });

      expect(module).toBeDefined();
      expect(module.name).toBe('test-module');
      expect(module.version).toBe('1.0.0');
    });

    it('should create a module with validation', () => {
      const userSchema = z.object({
        name: z.string(),
        email: z.string().email(),
      });

      const module = defineModule({
        name: 'users',
        version: '1.0.0',
        routes: [
          {
            method: 'POST',
            path: '/users',
            validation: { body: userSchema },
            handler: async (req: any) => ({ success: true, user: req.body }),
          },
        ],
      });

      expect(module).toBeDefined();
      expect(module.name).toBe('users');
      expect(module.routes).toHaveLength(1);
    });
  });

  describe('Framework functionality', () => {
    it('should provide validation capabilities', () => {
      const userSchema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
        age: z.number().optional(),
      });

      const validUser = { name: 'John Doe', email: 'john@example.com' };
      const invalidUser = { name: 'J', email: 'invalid' };

      expect(userSchema.safeParse(validUser).success).toBe(true);
      expect(userSchema.safeParse(invalidUser).success).toBe(false);
    });

    it('should provide module definition capabilities', () => {
      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/test',
            handler: async () => ({ success: true }),
          },
        ],
      });

      expect(module).toBeDefined();
      expect(module.name).toBe('test-module');
      expect(module.version).toBe('1.0.0');
      expect(module.routes).toHaveLength(1);
    });
  });
});
