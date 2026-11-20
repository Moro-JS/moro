// Validation Library Adapters for Moro Framework
// Makes Joi, Yup, and other libraries compatible with ValidationSchema interface

import { ValidationSchema, ValidationError, normalizeValidationError } from './schema-interface.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('Validation');

/**
 * Zod Compatibility Check
 * Zod ALREADY implements ValidationSchema interface natively!
 * No adapter needed - it just works.
 */

/**
 * Joi Adapter - makes Joi schemas compatible with ValidationSchema
 */
export class JoiAdapter<T = any> implements ValidationSchema<T> {
  constructor(private joiSchema: any) {
    if (!joiSchema || typeof joiSchema.validateAsync !== 'function') {
      throw new Error('Invalid Joi schema provided to JoiAdapter');
    }
  }

  async parseAsync(data: unknown): Promise<T> {
    try {
      const result = await this.joiSchema.validateAsync(data, { abortEarly: false });
      return result as T;
    } catch (error) {
      throw normalizeValidationError(error);
    }
  }
}

/**
 * Yup Adapter - makes Yup schemas compatible with ValidationSchema
 */
export class YupAdapter<T = any> implements ValidationSchema<T> {
  constructor(private yupSchema: any) {
    if (!yupSchema || typeof yupSchema.validate !== 'function') {
      throw new Error('Invalid Yup schema provided to YupAdapter');
    }
  }

  async parseAsync(data: unknown): Promise<T> {
    try {
      const result = await this.yupSchema.validate(data, { abortEarly: false });
      return result as T;
    } catch (error) {
      // Yup's object schema fails with an internal TypeError ("field.resolve is
      // not a function") on input that has an own "__proto__" key, which is
      // what JSON.parse produces for a body containing that key. Report the
      // key instead of the library's internal message.
      if (!isYupValidationError(error)) {
        const path = findOwnProtoKey(data, [], 0);
        if (path) {
          throw new ValidationError([
            { path, message: '"__proto__" is not allowed', code: 'invalid' },
          ]);
        }
      }
      throw normalizeValidationError(error);
    }
  }
}

function isYupValidationError(error: any): boolean {
  return !!error && Array.isArray(error.errors);
}

/** Path to the first own "__proto__" key in `value`, or null. Runs only after a failure. */
function findOwnProtoKey(
  value: unknown,
  path: (string | number)[],
  depth: number
): (string | number)[] | null {
  if (value === null || typeof value !== 'object' || depth > 32) return null;
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) return [...path, '__proto__'];
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findOwnProtoKey(value[i], [...path, i], depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const found = findOwnProtoKey(
      (value as Record<string, unknown>)[key],
      [...path, key],
      depth + 1
    );
    if (found) return found;
  }
  return null;
}

/**
 * Custom Validation Function Adapter
 * Allows users to use simple validation functions
 */
export class FunctionAdapter<T = any> implements ValidationSchema<T> {
  constructor(
    private validateFn: (data: unknown) => T | Promise<T>,
    private name: string = 'custom'
  ) {
    if (typeof validateFn !== 'function') {
      throw new Error('Validation function is required for FunctionAdapter');
    }
  }

  async parseAsync(data: unknown): Promise<T> {
    try {
      return await this.validateFn(data);
    } catch (error) {
      throw new ValidationError([
        {
          path: [],
          message: error instanceof Error ? error.message : String(error),
          code: this.name,
        },
      ]);
    }
  }
}

// classValidator(Class) without a validate function checks nothing: say so once
let missingValidateWarningShown = false;

/**
 * Class Validator Adapter (for TypeScript decorators)
 *
 * The framework does not import class-validator: pass its `validate` function
 * as the second argument. Without it the input is copied onto an instance of
 * the class and returned unchecked.
 */
export class ClassValidatorAdapter<T extends object = any> implements ValidationSchema<T> {
  constructor(
    private ClassType: new () => T,
    private validate?: (obj: any) => Promise<any[]>
  ) {
    if (typeof ClassType !== 'function') {
      throw new Error('Class constructor is required for ClassValidatorAdapter');
    }
    if (typeof validate !== 'function' && !missingValidateWarningShown) {
      missingValidateWarningShown = true;
      logger.warn(
        `classValidator(${ClassType.name || 'Class'}) was created without a validate function, ` +
          'so the decorators on the class are not checked and every request passes. ' +
          "Pass class-validator's validate: " +
          "import { validate } from 'class-validator'; " +
          `classValidator(${ClassType.name || 'Class'}, validate)`,
        'ClassValidator'
      );
    }
  }

  async parseAsync(data: unknown): Promise<T> {
    try {
      // Copy the input's own keys onto a fresh instance. "__proto__" and
      // "constructor" are never copied: assigning the first would replace the
      // instance's prototype with caller-supplied data (JSON.parse makes it an
      // ordinary own key), and the second would shadow the class it belongs to.
      const instance = new this.ClassType() as Record<string, any>;
      if (data !== null && data !== undefined) {
        const source = data as Record<string, any>;
        for (const key of Object.keys(source)) {
          if (key === '__proto__' || key === 'constructor') continue;
          instance[key] = source[key];
        }
        for (const key of Object.getOwnPropertySymbols(source)) {
          if (Object.prototype.propertyIsEnumerable.call(source, key)) {
            (instance as any)[key] = (source as any)[key];
          }
        }
      }

      if (this.validate) {
        const errors = await this.validate(instance);
        if (errors && errors.length > 0) {
          throw new ValidationError(
            errors.map((error: any, index: number) => ({
              path: error.property ? [error.property] : [index],
              message: Object.values(error.constraints || {}).join(', ') || 'Validation failed',
              code: 'class_validator',
            }))
          );
        }
      }

      return instance as T;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw normalizeValidationError(error);
    }
  }
}

/**
 * Utility functions for creating adapters
 */
export function joi<T = any>(joiSchema: any): ValidationSchema<T> {
  return new JoiAdapter<T>(joiSchema);
}

export function yup<T = any>(yupSchema: any): ValidationSchema<T> {
  return new YupAdapter<T>(yupSchema);
}

export function fn<T = any>(
  validateFn: (data: unknown) => T | Promise<T>,
  name?: string
): ValidationSchema<T> {
  return new FunctionAdapter<T>(validateFn, name);
}

export function classValidator<T extends object = any>(
  ClassType: new () => T,
  validate?: (obj: any) => Promise<any[]>
): ValidationSchema<T> {
  return new ClassValidatorAdapter<T>(ClassType, validate);
}

// Type helpers
export type JoiSchema<T> = ValidationSchema<T>;
export type YupSchema<T> = ValidationSchema<T>;
export type CustomValidator<T> = ValidationSchema<T>;
