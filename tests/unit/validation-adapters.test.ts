// Unit Tests - Universal Validation Adapters
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ValidationSchema, joi, yup, customValidator, classValidator, z } from '../../src/index.js';

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

  describe('class-validator Adapter', () => {
    class CreateUser {
      name = '';
      role = 'user';

      isAdmin(): boolean {
        return this.role === 'admin';
      }
    }

    it('returns an instance of the class carrying the input values', async () => {
      const schema = classValidator(CreateUser);

      const result = await schema.parseAsync({ name: 'Ada', role: 'admin', extra: 1 });

      expect(result).toBeInstanceOf(CreateUser);
      expect(result).toEqual({ name: 'Ada', role: 'admin', extra: 1 });
      expect(result.isAdmin()).toBe(true);
    });

    it('keeps the class prototype when the input has a "__proto__" key', async () => {
      const schema = classValidator(CreateUser);
      // What a request body is after JSON.parse: "__proto__" is an own key
      const input = JSON.parse(
        '{"name":"Mallory","__proto__":{"isAdmin":"yes","role":"admin","injected":true}}'
      );

      const result = await schema.parseAsync(input);

      expect(Object.getPrototypeOf(result)).toBe(CreateUser.prototype);
      expect(result).toBeInstanceOf(CreateUser);
      expect(result.name).toBe('Mallory');
      expect(result.role).toBe('user');
      expect(result.isAdmin()).toBe(false);
      expect((result as any).injected).toBeUndefined();
      expect(Object.keys(result)).toEqual(['name', 'role']);
    });

    it('keeps the class constructor when the input has a "constructor" key', async () => {
      const schema = classValidator(CreateUser);

      const result = await schema.parseAsync(JSON.parse('{"name":"Eve","constructor":"x"}'));

      expect(result.constructor).toBe(CreateUser);
      expect(Object.keys(result)).toEqual(['name', 'role']);
    });

    it('hands the validator the instance, and reports its errors', async () => {
      const seen: unknown[] = [];
      const schema = classValidator(CreateUser, async instance => {
        seen.push(instance);
        return instance.name
          ? []
          : [{ property: 'name', constraints: { isNotEmpty: 'name should not be empty' } }];
      });

      await expect(schema.parseAsync({ name: 'Ada' })).resolves.toBeInstanceOf(CreateUser);
      expect(seen[0]).toBeInstanceOf(CreateUser);
      await expect(schema.parseAsync({})).rejects.toThrow();
      await expect(schema.parseAsync(null)).rejects.toThrow();
    });
  });

  describe('class-validator Adapter without a validate function', () => {
    class Signup {
      email = '';
    }

    afterEach(() => {
      jest.restoreAllMocks();
      jest.resetModules();
    });

    // The notice is logged once per process, so each test loads its own copy
    // of the adapters, and observes the logger that copy writes to.
    async function loadAdapters() {
      jest.resetModules();
      const { MoroLogger, logger } = await import('../../src/core/logger/index.js');
      logger.setLevel('debug');
      const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      const adapters = await import('../../src/core/validation/adapters.js');
      const warnings = () =>
        log.mock.calls.filter(call => call[0] === 'warn').map(call => String(call[1]));
      return { adapters, warnings };
    }

    it('says once that nothing is validated, and shows the working form', async () => {
      const { adapters, warnings } = await loadAdapters();

      const schema = adapters.classValidator(Signup);
      adapters.classValidator(Signup);
      new adapters.ClassValidatorAdapter(Signup);

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('classValidator(Signup) was created without a validate');
      expect(warnings()[0]).toContain('every request passes');
      expect(warnings()[0]).toContain("import { validate } from 'class-validator'");
      expect(warnings()[0]).toContain('classValidator(Signup, validate)');

      // Unchanged: the input is returned as an instance, unchecked
      await expect(schema.parseAsync({ email: 42 })).resolves.toEqual({ email: 42 });
    });

    it('says nothing when a validate function is given, and something when one is not', async () => {
      const { adapters, warnings } = await loadAdapters();

      adapters.classValidator(Signup, async () => []);
      expect(warnings()).toEqual([]);

      adapters.classValidator(Signup);
      expect(warnings()).toHaveLength(1);
    });
  });

  // `yup` is not a dependency of this repo. These stand-ins reject with the
  // error shape yup 1.x produces for validate(data, { abortEarly: false }).
  describe('Yup Adapter', () => {
    const yupError = (fields: Array<{ path: string; type: string; message: string }>) =>
      Object.assign(new Error(`${fields.length} errors occurred`), {
        name: 'ValidationError',
        path: undefined,
        type: undefined,
        errors: fields.map(field => field.message),
        inner: fields.map(field => ({
          name: 'ValidationError',
          path: field.path,
          type: field.type,
          message: field.message,
          errors: [field.message],
          inner: [],
        })),
      });

    const rejectingWith = (error: unknown) =>
      yup({
        validate: async () => {
          throw error;
        },
      });

    const issuesOf = async (schema: ValidationSchema, data: unknown) => {
      try {
        await schema.parseAsync(data);
      } catch (error: any) {
        return error.issues;
      }
      throw new Error('expected the schema to reject');
    };

    it('reports each failed field under its own name', async () => {
      const validate = jest.fn(async (_data: unknown, _options?: unknown) => {
        throw yupError([
          { path: 'name', type: 'optionality', message: 'name is a required field' },
          { path: 'age', type: 'min', message: 'age must be greater than or equal to 18' },
        ]);
      });

      expect(await issuesOf(yup({ validate }), { age: 5 })).toEqual([
        { path: ['name'], message: 'name is a required field', code: 'optionality' },
        { path: ['age'], message: 'age must be greater than or equal to 18', code: 'min' },
      ]);
      // Every failure is collected, not only the first
      expect(validate).toHaveBeenCalledWith({ age: 5 }, { abortEarly: false });

      // An error that carries its one path at the top level (what yup rejects
      // with when it stops at the first failure) reads as it always did
      const single = Object.assign(new Error('age must be greater than or equal to 18'), {
        name: 'ValidationError',
        path: 'age',
        type: 'min',
        errors: ['age must be greater than or equal to 18'],
        inner: [],
      });
      expect(await issuesOf(rejectingWith(single), { age: 5 })).toEqual([
        { path: ['age'], message: 'age must be greater than or equal to 18', code: 'min' },
      ]);
    });

    it('splits nested and array paths into segments', async () => {
      const schema = rejectingWith(
        yupError([
          { path: 'user.email', type: 'email', message: 'user.email must be a valid email' },
          { path: 'tags[1]', type: 'min', message: 'tags[1] must be at least 2 characters' },
          { path: 'meta["a.b"].c', type: 'required', message: 'required' },
          { path: 'x-api-version', type: 'oneOf', message: 'x-api-version must be 1 or 2' },
          { path: '', type: 'typeError', message: 'this must be a `object` type' },
        ])
      );

      const issues = await issuesOf(schema, {});

      expect(issues.map((issue: any) => issue.path)).toEqual([
        ['user', 'email'],
        ['tags', 1],
        ['meta', 'a.b', 'c'],
        ['x-api-version'],
        [],
      ]);
    });

    describe('input with a "__proto__" key', () => {
      // Yup looks each input key up on its plain `fields` object. For the own
      // key "__proto__" (JSON.parse makes one) that finds Object.prototype,
      // and yup fails with a TypeError of its own.
      const fields: Record<string, { resolve(): void }> = { name: { resolve() {} } };
      const likeYup = yup({
        validate: async (data: any) => {
          const walk = (value: any) => {
            for (const key of Object.keys(value)) {
              const field = fields[key];
              if (field) field.resolve();
              if (value[key] && typeof value[key] === 'object') walk(value[key]);
            }
          };
          walk(data);
          return data;
        },
      });

      it('is reported as a validation failure on that key', async () => {
        const body = JSON.parse('{"name":"a","__proto__":{"isAdmin":true}}');

        expect(await issuesOf(likeYup, body)).toEqual([
          { path: ['__proto__'], message: '"__proto__" is not allowed', code: 'invalid' },
        ]);

        // Any other failure inside the library is reported as it was
        expect(await issuesOf(rejectingWith(new TypeError('boom')), { name: 'a' })).toEqual([
          { path: [], message: 'boom', code: 'unknown' },
        ]);
      });

      it('is located inside nested objects and arrays', async () => {
        const body = JSON.parse('{"name":"a","items":[{"ok":1},{"__proto__":{"x":1}}]}');

        expect(await issuesOf(likeYup, body)).toEqual([
          {
            path: ['items', 1, '__proto__'],
            message: '"__proto__" is not allowed',
            code: 'invalid',
          },
        ]);
      });
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
