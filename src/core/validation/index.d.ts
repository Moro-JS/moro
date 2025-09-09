import { ZodSchema } from 'zod';
import { HttpRequest, HttpResponse } from '../http';
export interface ValidationConfig {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
  headers?: ZodSchema;
}
export interface ValidationResult<T = any> {
  success: boolean;
  data?: T;
  errors?: ValidationError[];
}
export interface ValidationError {
  field: string;
  message: string;
  code: string;
}
export interface ValidatedRequest<T = any> extends HttpRequest {
  validatedBody?: T;
  validatedQuery?: any;
  validatedParams?: any;
  validatedHeaders?: any;
}
export declare function validate<TBody = any, TQuery = any, TParams = any>(
  config: ValidationConfig,
  handler: (req: ValidatedRequest<TBody>, res: HttpResponse) => any | Promise<any>
): (req: HttpRequest, res: HttpResponse) => Promise<any>;
export declare function body<T>(
  schema: ZodSchema<T>
): (
  handler: (req: ValidatedRequest<T>, res: HttpResponse) => any | Promise<any>
) => (req: HttpRequest, res: HttpResponse) => Promise<any>;
export declare function query<T>(
  schema: ZodSchema<T>
): (
  handler: (req: ValidatedRequest<any>, res: HttpResponse) => any | Promise<any>
) => (req: HttpRequest, res: HttpResponse) => Promise<any>;
export declare function params<T>(
  schema: ZodSchema<T>
): (
  handler: (req: ValidatedRequest<any>, res: HttpResponse) => any | Promise<any>
) => (req: HttpRequest, res: HttpResponse) => Promise<any>;
export declare function combineSchemas(schemas: ValidationConfig): ValidationConfig;
export { z } from 'zod';
