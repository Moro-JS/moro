/* eslint-disable */
// Unit Tests - Universal Validation Adapters
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ValidationSchema, joi, yup, customValidator, z } from '../../src/index.js';

describe('Universal Validation Adapters', () => {
  describe('Zod (Native Support)', () => {
    it('should work directly with Zod schemas', async () => {
      const schema = z.object({
        name: z.string(),
        age: z.number().min(18),
      });

      const validData = { name: 'John', age: 25 };
      const result = await schema.parseAsync(validData);

      expect(result).toEqual(validData);
    });

    it('should throw ValidationError for invalid data', async () => {
      const schema = z.object({
        name: z.string(),
        age: z.number().min(18),
      });

      const invalidData = { name: 'John', age: 16 };

      await expect(schema.parseAsync(invalidData)).rejects.toThrow();
    });
  });

  describe('Custom Validator Adapter', () => {
    it('should work with custom validation functions', async () => {
      const validateUser = customValidator(async (data: any) => {
        if (!data.name || typeof data.name !== 'string') {
          throw new Error('Name is required and must be a string');
        }
        if (data.age && (typeof data.age !== 'number' || data.age < 18)) {
          throw new Error('Age must be a number and at least 18');
        }
        return {
          name: data.name,
          age: data.age || null,
        };
      });

      const validData = { name: 'John', age: 25 };
      const result = await validateUser.parseAsync(validData);

      expect(result).toEqual(validData);
    });

    it('should throw ValidationError for invalid data', async () => {
      const validateUser = customValidator(async (data: any) => {
        if (data.age < 18) {
          throw new Error('Age must be at least 18');
        }
        return data;
      });

      const invalidData = { name: 'John', age: 16 };

      await expect(validateUser.parseAsync(invalidData)).rejects.toThrow();
    });
  });

  describe('ValidationSchema Interface', () => {
    it('should be compatible with all validation libraries', () => {
      // Zod schema implements ValidationSchema
      const zodSchema = z.string();
      const customSchema = customValidator((data: any) => String(data));

      // All schemas should have parseAsync method
      expect(typeof zodSchema.parseAsync).toBe('function');
      expect(typeof customSchema.parseAsync).toBe('function');
    });

    it('should work in validation config', async () => {
      const customSchema: ValidationSchema<{ name: string }> = customValidator(
        async (data: any) => {
          if (!data.name) throw new Error('Name required');
          return { name: data.name };
        }
      );

      const result = await customSchema.parseAsync({ name: 'John' });
      expect(result).toEqual({ name: 'John' });
    });
  });

  describe('Type Safety', () => {
    it('should maintain type safety with Zod', async () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const data = await schema.parseAsync({ name: 'John', age: 25 });

      // TypeScript should infer these types correctly
      const name: string = data.name;
      const age: number = data.age;

      expect(name).toBe('John');
      expect(age).toBe(25);
    });

    it('should work with generic ValidationSchema type', async () => {
      interface User {
        name: string;
        age: number;
      }

      const schema: ValidationSchema<User> = customValidator(async (data: any): Promise<User> => {
        return {
          name: String(data.name),
          age: Number(data.age),
        };
      });

      const result = await schema.parseAsync({ name: 'John', age: '25' });

      expect(result.name).toBe('John');
      expect(result.age).toBe(25);
    });
  });
});
