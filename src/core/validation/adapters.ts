// Validation Library Adapters for Moro Framework
// Makes Joi, Yup, and other libraries compatible with ValidationSchema interface

import { ValidationSchema, ValidationError, normalizeValidationError } from './schema-interface';

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
      throw normalizeValidationError(error);
    }
  }
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

/**
 * Class Validator Adapter (for TypeScript decorators)
 */
export class ClassValidatorAdapter<T extends object = any> implements ValidationSchema<T> {
  constructor(
    private ClassType: new () => T,
    private validate?: (obj: any) => Promise<any[]>
  ) {
    if (typeof ClassType !== 'function') {
      throw new Error('Class constructor is required for ClassValidatorAdapter');
    }
  }

  async parseAsync(data: unknown): Promise<T> {
    try {
      const instance = Object.assign(new this.ClassType(), data as Record<string, any>);

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
