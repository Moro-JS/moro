// Universal Schema to OpenAPI Converter
// Converts ValidationSchema (Zod, Joi, etc.) to OpenAPI 3.0 schema definitions

import { ValidationSchema } from '../validation/schema-interface';
import { OpenAPISchema } from './zod-to-openapi';
import { createFrameworkLogger } from '../logger';

const logger = createFrameworkLogger('SchemaToOpenAPI');

// Check if a schema is a Zod schema
function isZodSchema(schema: any): boolean {
  return (
    schema && typeof schema === 'object' && schema._def && typeof schema.parseAsync === 'function'
  );
}

// Check if schema is Joi
function isJoiSchema(schema: any): boolean {
  return (
    schema &&
    typeof schema === 'object' &&
    schema.type &&
    typeof schema.validateAsync === 'function'
  );
}

// Convert any ValidationSchema to OpenAPI
export function schemaToOpenAPI(
  schema: ValidationSchema,
  options: { includeExamples?: boolean; includeDescriptions?: boolean } = {}
): OpenAPISchema {
  // If it's a Zod schema, use the existing zod converter
  if (isZodSchema(schema)) {
    try {
      // Import zod converter dynamically
      const { zodToOpenAPI } = require('./zod-to-openapi');
      return zodToOpenAPI(schema, options);
    } catch (error) {
      logger.warn('Zod converter not available, using fallback', String(error));
    }
  }

  // If it's a Joi schema, convert from Joi
  if (isJoiSchema(schema)) {
    return convertJoiToOpenAPI(schema as any, options);
  }

  // For other schemas (custom validators, etc.), return a generic object schema
  logger.debug('Using generic schema conversion for unknown validation type');
  return {
    type: 'object',
    description: options.includeDescriptions ? 'Validated object' : undefined,
    additionalProperties: true,
  };
}

// Generate example from any ValidationSchema
export function generateExampleFromValidationSchema(schema: ValidationSchema): any {
  // If it's a Zod schema, use existing example generator
  if (isZodSchema(schema)) {
    try {
      const { generateExampleFromSchema } = require('./zod-to-openapi');
      return generateExampleFromSchema(schema);
    } catch (error) {
      logger.warn('Zod example generator not available', String(error));
    }
  }

  // For other schemas, return a generic example
  return {
    example: 'Validated data structure',
  };
}

// Convert Joi schema to OpenAPI (basic implementation)
function convertJoiToOpenAPI(
  joiSchema: any,
  options: { includeDescriptions?: boolean }
): OpenAPISchema {
  const schemaType = joiSchema.type;

  switch (schemaType) {
    case 'string':
      return {
        type: 'string',
        description: options.includeDescriptions ? joiSchema._description : undefined,
        minLength: joiSchema._rules?.find((r: any) => r.name === 'min')?.args?.limit,
        maxLength: joiSchema._rules?.find((r: any) => r.name === 'max')?.args?.limit,
        pattern: joiSchema._rules?.find((r: any) => r.name === 'pattern')?.args?.regex?.source,
      };

    case 'number':
      return {
        type: 'number',
        description: options.includeDescriptions ? joiSchema._description : undefined,
        minimum: joiSchema._rules?.find((r: any) => r.name === 'min')?.args?.limit,
        maximum: joiSchema._rules?.find((r: any) => r.name === 'max')?.args?.limit,
      };

    case 'boolean':
      return {
        type: 'boolean',
        description: options.includeDescriptions ? joiSchema._description : undefined,
      };

    case 'object': {
      const properties: Record<string, OpenAPISchema> = {};
      const required: string[] = [];

      if (joiSchema._inner?.children) {
        for (const child of joiSchema._inner.children) {
          const key = child.key;
          properties[key] = convertJoiToOpenAPI(child.schema, options);

          if (child.schema._flags?.presence === 'required') {
            required.push(key);
          }
        }
      }

      return {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
        description: options.includeDescriptions ? joiSchema._description : undefined,
      };
    }

    case 'array':
      return {
        type: 'array',
        items: joiSchema._inner?.items?.[0]
          ? convertJoiToOpenAPI(joiSchema._inner.items[0], options)
          : { type: 'object' },
        description: options.includeDescriptions ? joiSchema._description : undefined,
        minItems: joiSchema._rules?.find((r: any) => r.name === 'min')?.args?.limit,
        maxItems: joiSchema._rules?.find((r: any) => r.name === 'max')?.args?.limit,
      };

    default:
      logger.warn(`Unsupported Joi schema type: ${schemaType}`);
      return {
        type: 'object',
        additionalProperties: true,
        description: options.includeDescriptions ? 'Complex validation schema' : undefined,
      };
  }
}
