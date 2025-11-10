/* eslint-disable */
// Unit Tests - Zod Validation Functionality
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { z } from 'zod';

describe('Zod Validation', () => {
  describe('Basic Schema Validation', () => {
    it('should validate string schemas', () => {
      const schema = z.string();

      expect(schema.safeParse('hello').success).toBe(true);
      expect(schema.safeParse(123).success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
    });

    it('should validate number schemas', () => {
      const schema = z.number();

      expect(schema.safeParse(42).success).toBe(true);
      expect(schema.safeParse('42').success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
    });

    it('should validate boolean schemas', () => {
      const schema = z.boolean();

      expect(schema.safeParse(true).success).toBe(true);
      expect(schema.safeParse(false).success).toBe(true);
      expect(schema.safeParse('true').success).toBe(false);
      expect(schema.safeParse(1).success).toBe(false);
    });
  });

  describe('Object Schema Validation', () => {
    it('should validate object schemas', () => {
      const userSchema = z.object({
        name: z.string(),
        age: z.number(),
        email: z.string().email(),
      });

      const validUser = {
        name: 'John Doe',
        age: 30,
        email: 'john@example.com',
      };

      const invalidUser = {
        name: 'John Doe',
        age: 'thirty', // Should be number
        email: 'invalid-email', // Should be valid email
      };

      expect(userSchema.safeParse(validUser).success).toBe(true);
      expect(userSchema.safeParse(invalidUser).success).toBe(false);
    });

    it('should handle optional fields', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number().optional(),
        bio: z.string().optional(),
      });

      const validWithOptional = { name: 'John', age: 30 };
      const validWithoutOptional = { name: 'John' };
      const invalid = { age: 30 }; // Missing required name

      expect(schema.safeParse(validWithOptional).success).toBe(true);
      expect(schema.safeParse(validWithoutOptional).success).toBe(true);
      expect(schema.safeParse(invalid).success).toBe(false);
    });

    it('should handle default values', () => {
      const schema = z.object({
        name: z.string(),
        role: z.string().default('user'),
        active: z.boolean().default(true),
      });

      const input = { name: 'John' };
      const result = schema.parse(input);

      expect(result).toEqual({
        name: 'John',
        role: 'user',
        active: true,
      });
    });
  });

  describe('String Validation Rules', () => {
    it('should validate string length constraints', () => {
      const schema = z.string().min(2).max(10);

      expect(schema.safeParse('ab').success).toBe(true);
      expect(schema.safeParse('abcdefghij').success).toBe(true);
      expect(schema.safeParse('a').success).toBe(false); // Too short
      expect(schema.safeParse('abcdefghijk').success).toBe(false); // Too long
    });

    it('should validate email format', () => {
      const schema = z.string().email();

      expect(schema.safeParse('test@example.com').success).toBe(true);
      expect(schema.safeParse('user+tag@domain.co.uk').success).toBe(true);
      expect(schema.safeParse('invalid-email').success).toBe(false);
      expect(schema.safeParse('test@').success).toBe(false);
      expect(schema.safeParse('@example.com').success).toBe(false);
    });

    it('should validate URL format', () => {
      const schema = z.string().url();

      expect(schema.safeParse('https://example.com').success).toBe(true);
      expect(schema.safeParse('http://localhost:3000').success).toBe(true);
      expect(schema.safeParse('ftp://files.example.com').success).toBe(true);
      expect(schema.safeParse('invalid-url').success).toBe(false);
      expect(schema.safeParse('example.com').success).toBe(false);
    });

    it('should validate UUID format', () => {
      const schema = z.string().uuid();

      expect(schema.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
      expect(schema.safeParse('invalid-uuid').success).toBe(false);
      expect(schema.safeParse('123e4567-e89b-12d3-a456').success).toBe(false);
    });

    it('should validate regex patterns', () => {
      const usernameSchema = z.string().regex(/^[a-zA-Z0-9_]+$/);

      expect(usernameSchema.safeParse('john_doe123').success).toBe(true);
      expect(usernameSchema.safeParse('JohnDoe').success).toBe(true);
      expect(usernameSchema.safeParse('john-doe').success).toBe(false); // Contains hyphen
      expect(usernameSchema.safeParse('john doe').success).toBe(false); // Contains space
    });
  });

  describe('Number Validation Rules', () => {
    it('should validate number constraints', () => {
      const schema = z.number().min(1).max(100);

      expect(schema.safeParse(1).success).toBe(true);
      expect(schema.safeParse(50).success).toBe(true);
      expect(schema.safeParse(100).success).toBe(true);
      expect(schema.safeParse(0).success).toBe(false); // Too small
      expect(schema.safeParse(101).success).toBe(false); // Too large
    });

    it('should validate positive and negative numbers', () => {
      const positiveSchema = z.number().positive();
      const negativeSchema = z.number().negative();

      expect(positiveSchema.safeParse(1).success).toBe(true);
      expect(positiveSchema.safeParse(0).success).toBe(false);
      expect(positiveSchema.safeParse(-1).success).toBe(false);

      expect(negativeSchema.safeParse(-1).success).toBe(true);
      expect(negativeSchema.safeParse(0).success).toBe(false);
      expect(negativeSchema.safeParse(1).success).toBe(false);
    });

    it('should validate integer vs float', () => {
      const integerSchema = z.number().int();

      expect(integerSchema.safeParse(42).success).toBe(true);
      expect(integerSchema.safeParse(-42).success).toBe(true);
      expect(integerSchema.safeParse(42.5).success).toBe(false);
      expect(integerSchema.safeParse(0.1).success).toBe(false);
    });
  });

  describe('Array Validation', () => {
    it('should validate array schemas', () => {
      const schema = z.array(z.string());

      expect(schema.safeParse(['a', 'b', 'c']).success).toBe(true);
      expect(schema.safeParse([]).success).toBe(true);
      expect(schema.safeParse(['a', 1, 'c']).success).toBe(false); // Mixed types
      expect(schema.safeParse('not-array').success).toBe(false);
    });

    it('should validate array length constraints', () => {
      const schema = z.array(z.string()).min(1).max(3);

      expect(schema.safeParse(['a']).success).toBe(true);
      expect(schema.safeParse(['a', 'b', 'c']).success).toBe(true);
      expect(schema.safeParse([]).success).toBe(false); // Too short
      expect(schema.safeParse(['a', 'b', 'c', 'd']).success).toBe(false); // Too long
    });

    it('should validate arrays of objects', () => {
      const itemSchema = z.object({
        id: z.number(),
        name: z.string(),
      });
      const schema = z.array(itemSchema);

      const validArray = [
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ];

      const invalidArray = [
        { id: 1, name: 'Item 1' },
        { id: 'two', name: 'Item 2' }, // Invalid id type
      ];

      expect(schema.safeParse(validArray).success).toBe(true);
      expect(schema.safeParse(invalidArray).success).toBe(false);
    });
  });

  describe('Enum Validation', () => {
    it('should validate enum values', () => {
      const schema = z.enum(['red', 'green', 'blue']);

      expect(schema.safeParse('red').success).toBe(true);
      expect(schema.safeParse('green').success).toBe(true);
      expect(schema.safeParse('blue').success).toBe(true);
      expect(schema.safeParse('yellow').success).toBe(false);
      expect(schema.safeParse('RED').success).toBe(false); // Case sensitive
    });

    it('should validate native enum values', () => {
      enum Color {
        RED = 'red',
        GREEN = 'green',
        BLUE = 'blue',
      }

      const schema = z.nativeEnum(Color);

      expect(schema.safeParse(Color.RED).success).toBe(true);
      expect(schema.safeParse('red').success).toBe(true);
      expect(schema.safeParse('yellow').success).toBe(false);
    });
  });

  describe('Coercion', () => {
    it('should coerce string to number', () => {
      const schema = z.coerce.number();

      expect(schema.parse('42')).toBe(42);
      expect(schema.parse('3.14')).toBe(3.14);
      expect(schema.parse(42)).toBe(42);
      expect(schema.safeParse('not-a-number').success).toBe(false);
    });

    it('should coerce string to boolean', () => {
      const schema = z.coerce.boolean();

      expect(schema.parse('true')).toBe(true);
      expect(schema.parse('false')).toBe(true); // Note: Zod coercion treats any non-empty string as true
      expect(schema.parse('1')).toBe(true);
      expect(schema.parse('0')).toBe(true); // Note: Zod coercion treats any non-empty string as true
      expect(schema.parse(true)).toBe(true);
      expect(schema.parse('')).toBe(false);
      expect(schema.parse(0)).toBe(false);
      expect(schema.parse(1)).toBe(true);
    });

    it('should coerce string to date', () => {
      const schema = z.coerce.date();

      const dateString = '2023-12-01T10:00:00Z';
      const result = schema.parse(dateString);

      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2023-12-01T10:00:00.000Z');
    });
  });

  describe('Custom Validation', () => {
    it('should support custom refinements', () => {
      const passwordSchema = z
        .string()
        .min(8, 'Password must be at least 8 characters')
        .refine(
          password => /[A-Z]/.test(password),
          'Password must contain at least one uppercase letter'
        )
        .refine(password => /[0-9]/.test(password), 'Password must contain at least one number');

      expect(passwordSchema.safeParse('Password123').success).toBe(true);
      expect(passwordSchema.safeParse('password123').success).toBe(false); // No uppercase
      expect(passwordSchema.safeParse('Password').success).toBe(false); // No number
      expect(passwordSchema.safeParse('Pass1').success).toBe(false); // Too short
    });

    it('should support cross-field validation', () => {
      const schema = z
        .object({
          password: z.string(),
          confirmPassword: z.string(),
        })
        .refine(data => data.password === data.confirmPassword, {
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

      expect(schema.safeParse(validData).success).toBe(true);

      const invalidResult = schema.safeParse(invalidData);
      expect(invalidResult.success).toBe(false);
      if (!invalidResult.success) {
        expect(invalidResult.error.issues[0].path).toEqual(['confirmPassword']);
        expect(invalidResult.error.issues[0].message).toBe("Passwords don't match");
      }
    });
  });

  describe('Union and Intersection Types', () => {
    it('should validate union types', () => {
      const schema = z.union([z.string(), z.number()]);

      expect(schema.safeParse('hello').success).toBe(true);
      expect(schema.safeParse(42).success).toBe(true);
      expect(schema.safeParse(true).success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
    });

    it('should validate intersection types', () => {
      const baseSchema = z.object({ id: z.number() });
      const nameSchema = z.object({ name: z.string() });
      const schema = z.intersection(baseSchema, nameSchema);

      expect(schema.safeParse({ id: 1, name: 'John' }).success).toBe(true);
      expect(schema.safeParse({ id: 1 }).success).toBe(false); // Missing name
      expect(schema.safeParse({ name: 'John' }).success).toBe(false); // Missing id
    });
  });

  describe('Error Handling', () => {
    it('should provide detailed error messages', () => {
      const schema = z.object({
        name: z.string().min(2, 'Name must be at least 2 characters'),
        age: z.number().min(18, 'Must be 18 or older'),
        email: z.string().email('Invalid email format'),
      });

      const result = schema.safeParse({
        name: 'J',
        age: 16,
        email: 'invalid',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(3);
        expect(result.error.issues[0].message).toBe('Name must be at least 2 characters');
        expect(result.error.issues[1].message).toBe('Must be 18 or older');
        expect(result.error.issues[2].message).toBe('Invalid email format');
      }
    });

    it('should provide path information for nested errors', () => {
      const schema = z.object({
        user: z.object({
          profile: z.object({
            name: z.string(),
            age: z.number(),
          }),
        }),
      });

      const result = schema.safeParse({
        user: {
          profile: {
            name: 'John',
            age: 'not-a-number',
          },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(['user', 'profile', 'age']);
      }
    });
  });
});
