// Universal Schema to OpenAPI Converter
// Converts ValidationSchema (Zod, Joi, Yup) to OpenAPI 3.0 schema definitions

import { ValidationSchema } from '../validation/schema-interface.js';
import {
  OpenAPISchema,
  zodToOpenAPI,
  generateExampleFromSchema,
  exampleFromOpenAPISchema,
} from './zod-to-openapi.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('SchemaToOpenAPI');

interface SchemaOptions {
  includeExamples?: boolean;
  includeDescriptions?: boolean;
}

// Check if a schema is a Zod schema (Zod 3 `_def`, Zod 4 `_zod`)
function isZodSchema(schema: any): boolean {
  return (
    schema &&
    typeof schema === 'object' &&
    (schema._def || schema._zod) &&
    typeof schema.parseAsync === 'function'
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

// Check if schema is Yup
function isYupSchema(schema: any): boolean {
  return (
    schema &&
    typeof schema === 'object' &&
    schema.__isYupSchema__ === true &&
    typeof schema.describe === 'function'
  );
}

// The library schema behind the joi() / yup() adapters, which is what a route
// holds when it validates with one of those libraries
function unwrapAdapter(schema: any): any {
  if (schema && typeof schema === 'object') {
    if (isJoiSchema(schema.joiSchema)) return schema.joiSchema;
    if (isYupSchema(schema.yupSchema)) return schema.yupSchema;
  }
  return schema;
}

// Convert any ValidationSchema to OpenAPI
export function schemaToOpenAPI(
  schema: ValidationSchema,
  options: SchemaOptions = {}
): OpenAPISchema {
  const source = unwrapAdapter(schema);

  // If it's a Zod schema, use the existing zod converter
  if (isZodSchema(source)) {
    try {
      return zodToOpenAPI(source, options);
    } catch (error) {
      logger.warn(`Zod converter not available, using fallback: ${String(error)}`);
    }
  }

  // Joi and Yup both describe their schemas as plain data
  try {
    if (isJoiSchema(source) && typeof source.describe === 'function') {
      return convertJoiToOpenAPI(source.describe(), options);
    }
    if (isYupSchema(source)) {
      return convertYupToOpenAPI(source.describe(), options);
    }
  } catch (error) {
    logger.warn(`Schema description could not be read: ${String(error)}`);
  }

  // Custom validators say nothing about the value they accept: the empty
  // schema, which stands for any value
  logger.debug('No OpenAPI form for this validation schema; documented as any value');
  return {};
}

// Generate example from any ValidationSchema. `undefined` when the schema says
// nothing about the value it accepts.
export function generateExampleFromValidationSchema(schema: ValidationSchema): any {
  const source = unwrapAdapter(schema);

  // If it's a Zod schema, use existing example generator
  if (isZodSchema(source)) {
    try {
      return generateExampleFromSchema(source);
    } catch (error) {
      logger.warn(`Zod example generator not available: ${String(error)}`);
    }
  }

  return exampleFromOpenAPISchema(schemaToOpenAPI(schema, { includeDescriptions: false }));
}

// Only plain numbers are limits; Joi also allows references to other keys
function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// '/^a+$/i' (how Joi describes a pattern) or a RegExp, as a pattern source
function patternSource(value: unknown): string | undefined {
  if (value instanceof RegExp) return value.source;
  if (typeof value !== 'string') return undefined;
  const match = /^\/(.*)\/[a-z]*$/s.exec(value);
  return match ? match[1] : value;
}

function isJsonValue(value: unknown): boolean {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return false;
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

// A value from a Joi description as the literal it stands for. References to
// other keys and Joi's own markers have no literal form.
function joiLiteral(value: any, wrapped: boolean): any {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('ref' in value || 'special' in value || 'override' in value) return undefined;
    // An object in a list of values is described as { value: {...} }
    if (wrapped && 'value' in value) return value.value;
  }
  return isJsonValue(value) ? value : undefined;
}

// A schema being put together: a limit that is not set is written as undefined
// and dropped at the end
type SchemaDraft = { [Key in keyof OpenAPISchema]: OpenAPISchema[Key] | undefined };

function withoutUndefined(draft: SchemaDraft): OpenAPISchema {
  for (const key of Object.keys(draft) as Array<keyof SchemaDraft>) {
    if (draft[key] === undefined) delete draft[key];
  }
  return draft as OpenAPISchema;
}

// Convert a Joi description (the result of `schema.describe()`) to OpenAPI
function convertJoiToOpenAPI(description: any, options: SchemaOptions): OpenAPISchema {
  if (!description || typeof description !== 'object') return {};

  const flags = description.flags ?? {};
  const rules: any[] = Array.isArray(description.rules) ? description.rules : [];
  const rule = (name: string) => rules.find(candidate => candidate.name === name);
  const limit = (name: string) => numeric(rule(name)?.args?.limit);

  let schema: SchemaDraft;

  switch (description.type) {
    case 'string': {
      schema = { type: 'string', minLength: limit('min'), maxLength: limit('max') };
      const length = limit('length');
      if (length !== undefined) {
        schema.minLength = length;
        schema.maxLength = length;
      }
      if (rule('email')) schema.format = 'email';
      else if (rule('uri')) schema.format = 'uri';
      else if (rule('guid')) schema.format = 'uuid';
      else if (rule('isoDate')) schema.format = 'date-time';
      else if (rule('hostname')) schema.format = 'hostname';
      schema.pattern = patternSource(rule('pattern')?.args?.regex);
      break;
    }

    case 'number': {
      schema = { type: rule('integer') ? 'integer' : 'number' };
      schema.minimum = limit('min');
      schema.maximum = limit('max');
      const greater = limit('greater');
      if (greater !== undefined) {
        schema.minimum = greater;
        schema.exclusiveMinimum = true;
      }
      const less = limit('less');
      if (less !== undefined) {
        schema.maximum = less;
        schema.exclusiveMaximum = true;
      }
      schema.multipleOf = numeric(rule('multiple')?.args?.base);
      // positive() / negative()
      const sign = rule('sign')?.args?.sign;
      if (sign === 'positive' && (schema.minimum === undefined || schema.minimum < 0)) {
        schema.minimum = 0;
        schema.exclusiveMinimum = true;
      } else if (sign === 'negative' && (schema.maximum === undefined || schema.maximum > 0)) {
        schema.maximum = 0;
        schema.exclusiveMaximum = true;
      }
      break;
    }

    case 'boolean':
      schema = { type: 'boolean' };
      break;

    case 'date':
      schema = { type: 'string', format: 'date-time' };
      break;

    case 'binary':
      schema = { type: 'string', format: 'binary' };
      break;

    case 'object': {
      const properties: Record<string, OpenAPISchema> = {};
      const required: string[] = [];

      for (const [key, child] of Object.entries<any>(description.keys ?? {})) {
        // A forbidden key is one the request may not carry
        if (child?.flags?.presence === 'forbidden') continue;
        properties[key] = convertJoiToOpenAPI(child, options);
        if (child?.flags?.presence === 'required') required.push(key);
      }

      schema = {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
      break;
    }

    case 'array': {
      const items: any[] = Array.isArray(description.items) ? description.items : [];
      const converted = items.map(item => convertJoiToOpenAPI(item, options));
      let itemSchema: OpenAPISchema = {};
      if (converted.length === 1) itemSchema = converted[0] as OpenAPISchema;
      else if (converted.length > 1) itemSchema = { oneOf: converted };

      schema = {
        type: 'array',
        items: itemSchema,
        minItems: limit('min'),
        maxItems: limit('max'),
      };
      const length = limit('length');
      if (length !== undefined) {
        schema.minItems = length;
        schema.maxItems = length;
      }
      break;
    }

    case 'alternatives': {
      const matches: any[] = Array.isArray(description.matches) ? description.matches : [];
      const alternatives = matches
        .filter(match => match && match.schema)
        .map(match => convertJoiToOpenAPI(match.schema, options));
      schema = alternatives.length > 0 ? { oneOf: alternatives } : {};
      break;
    }

    // 'any', and types with no JSON form (function, symbol, link): any value
    default:
      schema = {};
  }

  // valid(...) lists the only accepted values; allow(null) adds null to the type
  const allowed: any[] = Array.isArray(description.allow) ? description.allow : [];
  const listed = allowed.map(value => joiLiteral(value, true)).filter(value => value !== undefined);
  if (flags.only && listed.length > 0) {
    schema.enum = listed;
  }
  if (listed.includes(null) && Object.keys(schema).length > 0) {
    schema.nullable = true;
  }

  const fallback = joiLiteral(flags.default, false);
  if (fallback !== undefined) schema.default = fallback;
  if (options.includeDescriptions !== false && typeof flags.description === 'string') {
    schema.description = flags.description;
  }
  if (
    options.includeExamples !== false &&
    Array.isArray(description.examples) &&
    isJsonValue(description.examples[0])
  ) {
    schema.example = description.examples[0];
  }

  return withoutUndefined(schema);
}

// Convert a Yup description (the result of `schema.describe()`) to OpenAPI
function convertYupToOpenAPI(description: any, options: SchemaOptions): OpenAPISchema {
  if (!description || typeof description !== 'object') return {};

  const tests: any[] = Array.isArray(description.tests) ? description.tests : [];
  const test = (name: string) => tests.find(candidate => candidate.name === name);

  let schema: SchemaDraft;

  switch (description.type) {
    case 'string': {
      schema = {
        type: 'string',
        minLength: numeric(test('min')?.params?.min),
        maxLength: numeric(test('max')?.params?.max),
      };
      const length = numeric(test('length')?.params?.length);
      if (length !== undefined) {
        schema.minLength = length;
        schema.maxLength = length;
      }
      if (test('email')) schema.format = 'email';
      else if (test('url')) schema.format = 'uri';
      else if (test('uuid')) schema.format = 'uuid';
      else if (test('datetime')) schema.format = 'date-time';
      schema.pattern = patternSource(test('matches')?.params?.regex);
      break;
    }

    case 'number': {
      schema = { type: test('integer') ? 'integer' : 'number' };
      // min(n) and moreThan(n) share the test name; the parameter tells them apart
      const min = test('min')?.params ?? {};
      if (numeric(min.min) !== undefined) {
        schema.minimum = min.min;
      } else if (numeric(min.more) !== undefined) {
        schema.minimum = min.more;
        schema.exclusiveMinimum = true;
      }
      const max = test('max')?.params ?? {};
      if (numeric(max.max) !== undefined) {
        schema.maximum = max.max;
      } else if (numeric(max.less) !== undefined) {
        schema.maximum = max.less;
        schema.exclusiveMaximum = true;
      }
      break;
    }

    case 'boolean':
      schema = { type: 'boolean' };
      break;

    case 'date':
      schema = { type: 'string', format: 'date-time' };
      break;

    case 'object': {
      const properties: Record<string, OpenAPISchema> = {};
      const required: string[] = [];

      for (const [key, field] of Object.entries<any>(description.fields ?? {})) {
        properties[key] = convertYupToOpenAPI(field, options);
        // required() on Yup; `optional: false` alone is defined(), which still
        // refuses a missing key
        if (field && field.optional === false) required.push(key);
      }

      schema = {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
      break;
    }

    case 'array':
      schema = {
        type: 'array',
        items:
          description.innerType && !Array.isArray(description.innerType)
            ? convertYupToOpenAPI(description.innerType, options)
            : {},
        minItems: numeric(test('min')?.params?.min),
        maxItems: numeric(test('max')?.params?.max),
      };
      if (numeric(test('length')?.params?.length) !== undefined) {
        schema.minItems = test('length').params.length;
        schema.maxItems = test('length').params.length;
      }
      break;

    case 'tuple': {
      const positions: any[] = Array.isArray(description.innerType) ? description.innerType : [];
      const members = positions.map(position => convertYupToOpenAPI(position, options));
      schema = {
        type: 'array',
        items: members.length > 0 ? { oneOf: members } : {},
        minItems: positions.length,
        maxItems: positions.length,
      };
      break;
    }

    // 'mixed', 'lazy': any value
    default:
      schema = {};
  }

  const listed = (Array.isArray(description.oneOf) ? description.oneOf : []).filter(isJsonValue);
  if (listed.length > 0) schema.enum = listed;

  if (description.nullable === true && Object.keys(schema).length > 0) {
    schema.nullable = true;
    if (schema.enum && !schema.enum.includes(null)) schema.enum = [...schema.enum, null];
  }

  // An object's default is the defaults of its fields put together, which the
  // fields already document
  if (description.type !== 'object' && isJsonValue(description.default)) {
    schema.default = description.default;
  }
  // Yup has no description of its own: meta({ description }) by convention,
  // otherwise the label it uses in messages
  const meta = description.meta && typeof description.meta === 'object' ? description.meta : {};
  const text = typeof meta.description === 'string' ? meta.description : description.label;
  if (options.includeDescriptions !== false && typeof text === 'string') {
    schema.description = text;
  }
  if (options.includeExamples !== false && isJsonValue(meta.example)) {
    schema.example = meta.example;
  }

  return withoutUndefined(schema);
}
