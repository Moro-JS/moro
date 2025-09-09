import { ZodSchema } from 'zod';
export interface OpenAPISchema {
  type?: string;
  format?: string;
  description?: string;
  example?: any;
  enum?: any[];
  items?: OpenAPISchema;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: any;
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  allOf?: OpenAPISchema[];
  nullable?: boolean;
  additionalProperties?: boolean | OpenAPISchema;
}
export interface ConversionOptions {
  includeExamples?: boolean;
  includeDescriptions?: boolean;
  strict?: boolean;
}
export declare function zodToOpenAPI(schema: ZodSchema, options?: ConversionOptions): OpenAPISchema;
export declare function generateExampleFromSchema(schema: ZodSchema): any;
