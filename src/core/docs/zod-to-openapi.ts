// Zod to OpenAPI Schema Converter
// Transforms Zod schemas into OpenAPI 3.0 schema definitions.
//
// Both Zod generations are read: Zod 3 describes a schema as `_def.typeName`
// ('ZodString') with plain check records, Zod 4 as `_zod.def.type` ('string')
// with check objects. Each is normalised to the Zod 4 names below and converted
// by one set of rules, so a schema documents the same way on either version.

import { createFrameworkLogger } from '../logger/index.js';
import { createUserRequire, isPackageAvailable } from '../utilities/package-utils.js';
import { warnIfPackageAffected } from '../utilities/package-notices.js';

const logger = createFrameworkLogger('ZodToOpenAPI');

// Dynamic Zod imports (optional dependency)
let zodModule: any = null;
let zodLoadAttempted = false;

// Lazy synchronous initialization for Zod
function loadZodSync() {
  if (zodLoadAttempted) {
    return zodModule;
  }

  zodLoadAttempted = true;

  try {
    if (!isPackageAvailable('zod')) {
      zodModule = null;
      return zodModule;
    }

    // Use synchronous require for immediate availability
    const userRequire = createUserRequire();
    zodModule = userRequire('zod');
    warnIfPackageAffected('zod', userRequire.resolve('zod'));
  } catch {
    // Zod not available - that's fine!
    zodModule = null;
  }

  return zodModule;
}

// OpenAPI schema types
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
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  default?: any;
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  allOf?: OpenAPISchema[];
  nullable?: boolean;
  additionalProperties?: boolean | OpenAPISchema;
}

// Conversion options
export interface ConversionOptions {
  includeExamples?: boolean;
  includeDescriptions?: boolean;
  strict?: boolean;
}

// Which examples a conversion writes: generated ones plus those the schema
// carries ('all'), only those the schema carries ('provided'), or none.
type ExampleMode = 'all' | 'provided' | 'none';

interface ConversionContext {
  examples: ExampleMode;
  descriptions: boolean;
  /** Definitions being converted right now; a repeat means a recursive schema. */
  active: Set<object>;
}

// Zod 3 class names, as the type names Zod 4 uses for the same schema
const ZOD3_KINDS: Record<string, string> = {
  ZodString: 'string',
  ZodNumber: 'number',
  ZodBigInt: 'bigint',
  ZodBoolean: 'boolean',
  ZodDate: 'date',
  ZodObject: 'object',
  ZodArray: 'array',
  ZodTuple: 'tuple',
  ZodRecord: 'record',
  ZodEnum: 'enum',
  ZodNativeEnum: 'enum',
  ZodLiteral: 'literal',
  ZodUnion: 'union',
  ZodDiscriminatedUnion: 'union',
  ZodIntersection: 'intersection',
  ZodOptional: 'optional',
  ZodNullable: 'nullable',
  ZodDefault: 'default',
  ZodCatch: 'catch',
  ZodReadonly: 'readonly',
  ZodBranded: 'branded',
  ZodEffects: 'effects',
  ZodPipeline: 'pipe',
  ZodLazy: 'lazy',
  ZodPromise: 'promise',
  ZodAny: 'any',
  ZodUnknown: 'unknown',
  ZodNever: 'never',
  ZodNull: 'null',
};

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

// OpenAPI `format` for a Zod string format (Zod 3 check kind or Zod 4 format)
const STRING_FORMATS: Record<string, string> = {
  email: 'email',
  url: 'uri',
  uuid: 'uuid',
  guid: 'uuid',
  datetime: 'date-time',
  date: 'date',
  time: 'time',
  duration: 'duration',
  ipv4: 'ipv4',
  ipv6: 'ipv6',
  hostname: 'hostname',
  base64: 'byte',
};

// The definition of a schema, or the value itself when a definition was passed
function definitionOf(node: any): any {
  if (!node || typeof node !== 'object') return undefined;
  return node._zod?.def ?? node._def ?? node.def ?? node;
}

// The schema kind in Zod 4 terms, whichever generation built the definition
function kindOf(def: any): string | undefined {
  if (!def || typeof def !== 'object') return undefined;
  if (typeof def.typeName === 'string') return ZOD3_KINDS[def.typeName] ?? def.typeName;
  return typeof def.type === 'string' ? def.type : undefined;
}

// A check on a string, number or array, in one shape for both generations
interface NormalisedCheck {
  kind: string;
  value?: any;
  inclusive?: boolean;
  regex?: RegExp;
  version?: string;
}

function normaliseCheck(check: any): NormalisedCheck | undefined {
  // Zod 3: { kind: 'min', value: 5 }
  if (check && typeof check.kind === 'string') return check as NormalisedCheck;

  // Zod 4: a check object whose definition is { check: 'min_length', minimum: 5 }
  const def = check?._zod?.def ?? check?.def ?? check;
  if (!def || typeof def.check !== 'string') return undefined;

  switch (def.check) {
    case 'min_length':
      return { kind: 'min', value: def.minimum };
    case 'max_length':
      return { kind: 'max', value: def.maximum };
    case 'length_equals':
      return { kind: 'length', value: def.length };
    case 'greater_than':
      return { kind: 'min', value: def.value, inclusive: def.inclusive };
    case 'less_than':
      return { kind: 'max', value: def.value, inclusive: def.inclusive };
    case 'multiple_of':
      return { kind: 'multipleOf', value: def.value };
    case 'number_format':
      return { kind: 'numberFormat', value: def.format };
    case 'string_format':
      return { kind: String(def.format), regex: def.pattern };
    default:
      return undefined;
  }
}

function checksOf(def: any): NormalisedCheck[] {
  const checks: NormalisedCheck[] = [];
  // A Zod 4 format schema (z.email(), z.int()) is its own first check
  if (typeof def.check === 'string') {
    const own = normaliseCheck(def);
    if (own) checks.push(own);
  }
  if (Array.isArray(def.checks)) {
    for (const check of def.checks) {
      const normalised = normaliseCheck(check);
      if (normalised) checks.push(normalised);
    }
  }
  return checks;
}

// A value as it would appear in the JSON document, or undefined when it has no
// JSON form (a function, a symbol, a bigint, a cyclic object)
function toJsonValue(value: unknown): any {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : JSON.parse(json);
  } catch {
    return undefined;
  }
}

// Main conversion function
export function zodToOpenAPI(schema: any, options: ConversionOptions = {}): OpenAPISchema {
  // Check if Zod is available
  const zod = loadZodSync();
  if (!zod) {
    throw new Error('Zod is not installed. Please install zod to use zodToOpenAPI function.');
  }

  const opts = {
    includeExamples: true,
    includeDescriptions: true,
    strict: false,
    ...options,
  };

  try {
    return convertZodType(schema, {
      examples: opts.includeExamples ? 'all' : 'none',
      descriptions: opts.includeDescriptions !== false,
      active: new Set(),
    });
  } catch (error) {
    logger.error('Failed to convert Zod schema to OpenAPI', 'Conversion', {
      error: error instanceof Error ? error.message : String(error),
    });

    // Nothing is known about the schema: the empty schema accepts any value
    return {};
  }
}

// Convert a Zod schema to an OpenAPI schema
function convertZodType(node: any, context: ConversionContext): OpenAPISchema {
  const def = definitionOf(node);
  const kind = kindOf(def);

  if (!kind) {
    logger.debug('Not a Zod schema; documented as any value', 'Conversion');
    return {};
  }

  // A schema that contains itself (z.lazy, a getter in a Zod 4 object) is
  // documented one level deep
  if (context.active.has(def)) return {};

  context.active.add(def);
  try {
    const schema = convertKind(kind, def, context);
    annotate(schema, node, context);
    return schema;
  } finally {
    context.active.delete(def);
  }
}

// Description and example a schema carries (.describe(), and .meta() on Zod 4)
function annotate(schema: OpenAPISchema, node: any, context: ConversionContext): void {
  if (node === null || typeof node !== 'object') return;

  if (context.descriptions && typeof node.description === 'string' && node.description !== '') {
    schema.description = node.description;
  }

  if (context.examples === 'none' || !node._zod || typeof node.meta !== 'function') return;

  let meta: any;
  try {
    meta = node.meta();
  } catch {
    return;
  }
  if (!meta || typeof meta !== 'object') return;

  const provided = meta.example !== undefined ? meta.example : meta.examples?.[0];
  const example = toJsonValue(provided);
  if (example !== undefined) schema.example = example;
}

function convertKind(kind: string, def: any, context: ConversionContext): OpenAPISchema {
  switch (kind) {
    case 'string':
      return convertZodString(def, context);

    case 'number':
      return convertZodNumber(def, context);

    case 'bigint':
      return withExample({ type: 'integer', format: 'int64' }, 42, context);

    case 'boolean':
      return withExample({ type: 'boolean' }, true, context);

    case 'date':
      return withExample(
        {
          type: 'string',
          format: 'date-time',
          ...(context.descriptions ? { description: 'ISO 8601 date-time string' } : {}),
        },
        '2023-12-01T10:00:00Z',
        context
      );

    case 'object':
      return convertZodObject(def, context);

    case 'array':
      return convertZodArray(def, context);

    case 'tuple':
      return convertZodTuple(def, context);

    case 'record':
      return convertZodRecord(def, context);

    case 'enum':
      return convertZodEnum(def, context);

    case 'literal':
      return convertZodLiteral(def, context);

    case 'union':
      return { oneOf: optionsOf(def).map(option => convertZodType(option, context)) };

    case 'intersection':
      return {
        allOf: [convertZodType(def.left, context), convertZodType(def.right, context)],
      };

    case 'nullable':
      return makeNullable(convertZodType(def.innerType, context));

    case 'default':
    case 'prefault':
      return convertZodDefault(def, context);

    // Wrappers that leave the accepted JSON value as it is
    case 'optional':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return convertZodType(def.innerType, context);

    case 'branded':
      return convertZodType(def.type, context);

    case 'promise':
      return convertZodType(def.innerType ?? def.type, context);

    // Zod 3 refinements, transforms and preprocessors wrap the schema they apply to
    case 'effects':
      return convertZodType(def.schema, context);

    // The request carries what goes into a pipe. A Zod 4 preprocess is a pipe
    // whose input is the transform, so there the output schema is the described one.
    case 'pipe':
      return convertZodType(
        kindOf(definitionOf(def.in)) === 'transform' ? def.out : def.in,
        context
      );

    case 'lazy':
      return typeof def.getter === 'function' ? convertZodType(def.getter(), context) : {};

    case 'null':
      return nullOnly();

    case 'template_literal':
      return withExample({ type: 'string' }, 'string', context);

    case 'file':
      return { type: 'string', format: 'binary' };

    // 'any', 'unknown', and every type with no JSON Schema form (a transform's
    // output, a custom check, a Map, a Set, a function...): any value
    default:
      if (kind !== 'any' && kind !== 'unknown') {
        logger.debug(`No OpenAPI form for Zod type: ${kind}`, 'Conversion');
      }
      return {};
  }
}

function withExample(
  schema: OpenAPISchema,
  example: unknown,
  context: ConversionContext
): OpenAPISchema {
  if (context.examples === 'all') schema.example = example;
  return schema;
}

// Convert ZodString
function convertZodString(def: any, context: ConversionContext): OpenAPISchema {
  const schema: OpenAPISchema = { type: 'string' };

  for (const check of checksOf(def)) {
    switch (check.kind) {
      case 'min':
        schema.minLength = check.value;
        break;
      case 'max':
        schema.maxLength = check.value;
        break;
      case 'length':
        schema.minLength = check.value;
        schema.maxLength = check.value;
        break;
      case 'regex':
        if (check.regex instanceof RegExp) schema.pattern = check.regex.source;
        break;
      case 'uuid':
        schema.format = 'uuid';
        schema.pattern = UUID_PATTERN;
        break;
      case 'ip':
        // Zod 3: one check for both families
        if (check.version === 'v4') schema.format = 'ipv4';
        else if (check.version === 'v6') schema.format = 'ipv6';
        break;
      default: {
        const format = STRING_FORMATS[check.kind];
        if (format) schema.format = format;
      }
    }
  }

  return withExample(schema, stringExample(schema), context);
}

function stringExample(schema: OpenAPISchema): string {
  let example: string;
  switch (schema.format) {
    case 'email':
      return 'user@example.com';
    case 'uuid':
      return '123e4567-e89b-12d3-a456-426614174000';
    case 'date-time':
      return '2023-12-01T10:00:00Z';
    case 'date':
      return '2023-12-01';
    case 'time':
      return '10:00:00';
    case 'uri':
      return 'https://example.com';
    default:
      example = 'string';
  }

  // Keep the placeholder inside the declared length limits
  const { minLength, maxLength } = schema;
  if (typeof maxLength === 'number' && maxLength >= 0 && example.length > maxLength) {
    return example.slice(0, maxLength);
  }
  if (typeof minLength === 'number' && example.length < minLength && minLength <= 1024) {
    return example.repeat(Math.ceil(minLength / example.length)).slice(0, minLength);
  }
  return example;
}

// Convert ZodNumber
function convertZodNumber(def: any, context: ConversionContext): OpenAPISchema {
  const schema: OpenAPISchema = { type: 'number' };

  for (const check of checksOf(def)) {
    switch (check.kind) {
      case 'int':
        schema.type = 'integer';
        break;
      case 'numberFormat':
        applyNumberFormat(schema, String(check.value));
        break;
      case 'min':
        raiseMinimum(schema, check.value, check.inclusive !== false);
        break;
      case 'max':
        lowerMaximum(schema, check.value, check.inclusive !== false);
        break;
      case 'multipleOf':
        if (typeof check.value === 'number') schema.multipleOf = check.value;
        break;
    }
  }

  return withExample(schema, numberExample(schema, schema.type === 'integer' ? 42 : 3.14), context);
}

function applyNumberFormat(schema: OpenAPISchema, format: string): void {
  if (format === 'safeint' || format === 'int32' || format === 'uint32') {
    schema.type = 'integer';
    if (format === 'int32') schema.format = 'int32';
  } else if (format === 'float32') {
    schema.format = 'float';
  } else if (format === 'float64') {
    schema.format = 'double';
  }
}

// Several lower bounds on one number (.min(18).positive()): the tightest holds
function raiseMinimum(schema: OpenAPISchema, value: unknown, inclusive: boolean): void {
  if (typeof value !== 'number') return;
  const current = schema.minimum;
  if (current !== undefined && (value < current || (value === current && inclusive))) return;
  schema.minimum = value;
  if (inclusive) delete schema.exclusiveMinimum;
  else schema.exclusiveMinimum = true;
}

function lowerMaximum(schema: OpenAPISchema, value: unknown, inclusive: boolean): void {
  if (typeof value !== 'number') return;
  const current = schema.maximum;
  if (current !== undefined && (value > current || (value === current && inclusive))) return;
  schema.maximum = value;
  if (inclusive) delete schema.exclusiveMaximum;
  else schema.exclusiveMaximum = true;
}

// The preferred sample value, moved inside the declared range when it falls outside
function numberExample(schema: OpenAPISchema, preferred: number): number {
  const { minimum, maximum } = schema;
  const tooLow = (value: number) =>
    minimum !== undefined && (value < minimum || (value === minimum && schema.exclusiveMinimum));
  const tooHigh = (value: number) =>
    maximum !== undefined && (value > maximum || (value === maximum && schema.exclusiveMaximum));

  let example = preferred;
  if (tooLow(example)) {
    example = schema.exclusiveMinimum ? (minimum as number) + 1 : (minimum as number);
  }
  if (tooHigh(example)) {
    example = schema.exclusiveMaximum ? (maximum as number) - 1 : (maximum as number);
  }
  if (tooLow(example) && minimum !== undefined && maximum !== undefined) {
    example = (minimum + maximum) / 2;
  }
  return example;
}

// Whether an object key may be left out of the input
function acceptsMissing(node: any, depth: number = 0): boolean {
  // Zod 4 records it on the schema
  if (node?._zod) {
    return node._zod.optin === 'optional' || node._zod.optin === 'defaulted';
  }

  // Zod 3: look through the wrappers
  const def = definitionOf(node);
  if (depth > 32) return false;
  switch (kindOf(def)) {
    case 'optional':
    case 'default':
    case 'catch':
    case 'any':
    case 'unknown':
      return true;
    case 'nullable':
    case 'readonly':
      return acceptsMissing(def.innerType, depth + 1);
    case 'branded':
      return acceptsMissing(def.type, depth + 1);
    case 'effects':
      return acceptsMissing(def.schema, depth + 1);
    case 'pipe':
      return acceptsMissing(def.in, depth + 1);
    case 'lazy':
      return typeof def.getter === 'function' && acceptsMissing(def.getter(), depth + 1);
    default:
      return false;
  }
}

// Convert ZodObject
function convertZodObject(def: any, context: ConversionContext): OpenAPISchema {
  const schema: OpenAPISchema = {
    type: 'object',
    properties: {},
    required: [],
  };

  // Zod 3 keeps the shape behind a function, Zod 4 as an object
  let shape;
  if (typeof def.shape === 'function') {
    shape = def.shape();
  } else if (def.shape && typeof def.shape === 'object') {
    shape = def.shape;
  } else {
    logger.warn('Could not extract shape from Zod object', 'Conversion');
    return { type: 'object' };
  }

  for (const [key, value] of Object.entries(shape)) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    schema.properties![key] = convertZodType(value, context);

    if (!acceptsMissing(value)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      schema.required!.push(key);
    }
  }

  // Remove required array if empty
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  if (schema.required!.length === 0) {
    delete schema.required;
  }

  // Keys beyond the shape: refused by a strict object, typed by a catchall.
  // Zod 3 names the mode in `unknownKeys`; Zod 4 writes strict as a catchall of
  // `never` and loose as a catchall of `unknown`.
  const catchall = kindOf(definitionOf(def.catchall));
  if (def.unknownKeys === 'strict' || (def.unknownKeys === undefined && catchall === 'never')) {
    schema.additionalProperties = false;
  } else if (catchall && catchall !== 'never' && catchall !== 'any' && catchall !== 'unknown') {
    schema.additionalProperties = convertZodType(def.catchall, context);
  }

  return schema;
}

// Convert ZodArray
function convertZodArray(def: any, context: ConversionContext): OpenAPISchema {
  // The element schema: `element` on Zod 4, `type` on Zod 3
  const element = def.element ?? (def.type && typeof def.type === 'object' ? def.type : undefined);
  const schema: OpenAPISchema = {
    type: 'array',
    items: element ? convertZodType(element, context) : {},
  };

  // Zod 3 keeps the limits on the definition
  const limit = (value: any) => (value && typeof value === 'object' ? value.value : value);
  const exact = limit(def.exactLength);
  const min = exact ?? limit(def.minLength);
  const max = exact ?? limit(def.maxLength);
  if (typeof min === 'number') schema.minItems = min;
  if (typeof max === 'number') schema.maxItems = max;

  // Zod 4 keeps them as checks
  for (const check of checksOf(def)) {
    if (typeof check.value !== 'number') continue;
    if (check.kind === 'min' || check.kind === 'length') schema.minItems = check.value;
    if (check.kind === 'max' || check.kind === 'length') schema.maxItems = check.value;
  }

  if (context.examples === 'all') {
    const example = arrayExample(schema);
    if (example !== undefined) schema.example = example;
  }

  return schema;
}

// One sample item, repeated to the declared minimum; undefined when the item
// schema says nothing about its values
function arrayExample(schema: OpenAPISchema, depth: number = 0): any[] | undefined {
  const item = schema.items ? exampleFromOpenAPISchema(schema.items, depth + 1) : undefined;
  if (item === undefined) return undefined;
  const length = Math.min(Math.max(schema.minItems ?? 1, 1), schema.maxItems ?? 10, 10);
  return Array.from({ length }, () => item);
}

// A tuple has no OpenAPI 3.0 form of its own: an array of the position types
function convertZodTuple(def: any, context: ConversionContext): OpenAPISchema {
  const positions: any[] = Array.isArray(def.items) ? def.items : [];
  const members = positions.map(item => convertZodType(item, context));
  if (def.rest) members.push(convertZodType(def.rest, context));

  const keys = members.map(member => JSON.stringify(member));
  const distinct = members.filter(
    (_member, index) => keys.indexOf(keys[index] as string) === index
  );

  let items: OpenAPISchema = {};
  if (distinct.length === 1) items = distinct[0] as OpenAPISchema;
  else if (distinct.length > 1) items = { oneOf: distinct };

  const schema: OpenAPISchema = { type: 'array', items, minItems: positions.length };
  if (!def.rest) schema.maxItems = positions.length;
  return schema;
}

function convertZodRecord(def: any, context: ConversionContext): OpenAPISchema {
  const values = def.valueType ? convertZodType(def.valueType, context) : {};
  return {
    type: 'object',
    additionalProperties: Object.keys(values).length > 0 ? values : true,
  };
}

// The JSON type shared by a list of values, if they share one
function commonType(values: any[]): string | undefined {
  const types = new Set(values.filter(value => value !== null).map(value => typeof value));
  if (types.size !== 1) return undefined;
  const [type] = [...types];
  return type === 'string' || type === 'number' || type === 'boolean' ? type : undefined;
}

// OpenAPI 3.0 has no null type, and `nullable` only counts beside a `type`:
// the one-value enum on a nullable string is how "null and nothing else" is written
function nullOnly(): OpenAPISchema {
  return { type: 'string', nullable: true, enum: [null] };
}

function convertValueList(values: any[], context: ConversionContext): OpenAPISchema {
  const listed = values.map(toJsonValue).filter(value => value !== undefined);
  if (listed.length === 0) return {};
  if (listed.every(value => value === null)) return nullOnly();

  const type = commonType(listed);
  const schema: OpenAPISchema = { ...(type !== undefined ? { type } : {}), enum: listed };
  if (type !== undefined && listed.includes(null)) schema.nullable = true;
  return withExample(schema, listed[0], context);
}

// Convert ZodEnum (and a native enum)
function convertZodEnum(def: any, context: ConversionContext): OpenAPISchema {
  let values: any[];
  if (Array.isArray(def.values)) {
    // Zod 3 z.enum([...])
    values = def.values;
  } else {
    // Zod 4 `entries`, or a Zod 3 native enum object. A TypeScript numeric enum
    // also maps each number back to its name; those reverse entries are not values.
    const entries = def.entries ?? def.values ?? {};
    values = Object.keys(entries)
      .filter(key => typeof entries[entries[key]] !== 'number')
      .map(key => entries[key]);
  }

  // `enum` may not be empty in OpenAPI; with nothing listed only the type is left
  const schema = convertValueList(values, context);
  return schema.enum ? schema : { type: 'string' };
}

// Convert ZodLiteral
function convertZodLiteral(def: any, context: ConversionContext): OpenAPISchema {
  // Zod 4 holds a list of values, Zod 3 a single one
  return convertValueList(Array.isArray(def.values) ? def.values : [def.value], context);
}

function optionsOf(def: any): any[] {
  if (Array.isArray(def.options)) return def.options;
  // Early Zod 3 discriminated unions keep their options in a Map
  if (def.options instanceof Map) return Array.from(def.options.values());
  return [];
}

function makeNullable(schema: OpenAPISchema): OpenAPISchema {
  // The empty schema already accepts null
  if (Object.keys(schema).length === 0) return schema;
  schema.nullable = true;
  // OpenAPI 3.0: a nullable enum has to list null itself
  if (schema.enum && !schema.enum.includes(null)) schema.enum = [...schema.enum, null];
  return schema;
}

// Convert ZodDefault
function convertZodDefault(def: any, context: ConversionContext): OpenAPISchema {
  const schema = convertZodType(def.innerType, context);

  // Zod 3 holds a function that returns the default, Zod 4 the value
  let value = def.defaultValue;
  if (typeof value === 'function') {
    try {
      value = value();
    } catch (error) {
      logger.warn('Failed to get default value from function', 'Conversion', {
        error,
      });
      value = undefined;
    }
  }

  const json = toJsonValue(value);
  if (json !== undefined) schema.default = json;

  return schema;
}

// Generate example data from Zod schema
export function generateExampleFromSchema(schema: any): any {
  // Check if Zod is available
  const zod = loadZodSync();
  if (!zod) {
    throw new Error(
      'Zod is not installed. Please install zod to use generateExampleFromSchema function.'
    );
  }

  try {
    const converted = convertZodType(schema, {
      examples: 'provided',
      descriptions: false,
      active: new Set(),
    });
    const example = exampleFromOpenAPISchema(converted);
    return example === undefined ? null : example;
  } catch (error) {
    logger.warn('Failed to generate example from schema', 'ExampleGeneration', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * A sample value for an OpenAPI schema: the schema's own example or default
 * when it has one, otherwise a placeholder of the declared type that respects
 * the declared limits. `undefined` when the schema says nothing about the value.
 */
export function exampleFromOpenAPISchema(schema: OpenAPISchema, depth: number = 0): any {
  if (!schema || typeof schema !== 'object' || depth > 32) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  const alternative = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (alternative) return exampleFromOpenAPISchema(alternative, depth + 1);

  if (schema.allOf) {
    const parts = schema.allOf.map(part => exampleFromOpenAPISchema(part, depth + 1));
    const objects = parts.filter(part => part && typeof part === 'object' && !Array.isArray(part));
    return objects.length > 0 ? Object.assign({}, ...objects) : parts[0];
  }

  switch (schema.type) {
    case 'string':
      return stringExample(schema);

    case 'integer':
    case 'number':
      return numberExample(schema, 42);

    case 'boolean':
      return true;

    case 'array':
      return arrayExample(schema, depth) ?? [];

    case 'object': {
      // The keys a request has to send, and those that document a default
      const example: Record<string, any> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        if (!required.has(key) && property.default === undefined) continue;
        const value = exampleFromOpenAPISchema(property, depth + 1);
        example[key] = value === undefined ? null : value;
      }
      return example;
    }

    default:
      return undefined;
  }
}
