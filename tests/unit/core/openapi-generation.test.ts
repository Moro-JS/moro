// OpenAPI generation: schema conversion (Zod 3 and Zod 4, Joi, Yup), the
// OpenAPIGenerator route -> spec generation, and the documentation system
// keeping the document in step with the routes of the app. Uses the zod
// dependency that ships with the repo, which carries both Zod generations.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { AppDocumentationManager, DocumentationSystem } from '../../../src/core/docs/index.js';
import {
  defaultSecuritySchemes,
  generateOpenAPIFromRoutes,
  OpenAPIGenerator,
} from '../../../src/core/docs/openapi-generator.js';
import {
  generateExampleFromValidationSchema,
  schemaToOpenAPI,
} from '../../../src/core/docs/schema-to-openapi.js';
import { generateExampleFromSchema, zodToOpenAPI } from '../../../src/core/docs/zod-to-openapi.js';
import { IntelligentRoutingManager } from '../../../src/core/routing/app-integration.js';
import { joi, yup } from '../../../src/core/validation/adapters.js';

// A YAML parser the document can be read back with (a dependency of the test tooling)
const yaml = require('js-yaml');

// CompiledRoute is { schema, execute }. The generator only reads `schema`, so a
// no-op execute is sufficient.
const makeRoute = (schema: any) => ({ schema, execute: async () => {} });

// A generator for the given route schemas, with the options enableDocs() uses
const generatorFor = (schemas: any[], options: Record<string, unknown> = {}) => {
  const generator = new OpenAPIGenerator({
    info: { title: 'T', version: '1' },
    includeExamples: false,
    securitySchemes: defaultSecuritySchemes,
    ...options,
  });
  generator.addRoutes(
    schemas.map(schema => makeRoute({ method: 'GET', handler: () => {}, ...schema })) as any
  );
  return generator;
};

// What Joi 17 returns from schema.describe(), on an object shaped like a Joi schema
const joiSchema = (description: Record<string, unknown>) => ({
  type: description.type,
  validateAsync: async (value: unknown) => value,
  describe: () => description,
});

// What Yup 1 returns from schema.describe(), on an object shaped like a Yup schema
const yupSchema = (description: Record<string, unknown>) => ({
  __isYupSchema__: true,
  type: description.type,
  validate: async (value: unknown) => value,
  describe: () => description,
});

// The documentation system serves Swagger UI from the optional swagger-ui-dist
// package and looks for it from the working directory. This runs `build` in a
// directory where a package of that name is installed.
const withSwaggerUiPackage = <T>(build: () => T): T => {
  const root = mkdtempSync(join(tmpdir(), 'moro-docs-'));
  mkdirSync(join(root, 'node_modules', 'swagger-ui-dist'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', 'swagger-ui-dist', 'package.json'),
    JSON.stringify({ name: 'swagger-ui-dist', version: '0.0.0' })
  );
  const cwd = jest.spyOn(process, 'cwd').mockReturnValue(root);
  try {
    return build();
  } finally {
    cwd.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
};

// The document a docs middleware serves at <basePath>/openapi.json
const servedSpec = (middleware: (req: any, res: any, next: () => void) => void): any => {
  let body: any;
  const res = {
    setHeader: () => undefined,
    json: (value: unknown) => {
      body = value;
    },
  };
  middleware({ path: '/docs/openapi.json', headers: {} }, res, () => undefined);
  return body;
};

describe('OpenAPI generation', () => {
  describe('zodToOpenAPI', () => {
    it('converts a zod object into a JSON-schema object with typed properties', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
        active: z.boolean(),
        role: z.enum(['admin', 'user']),
        tags: z.array(z.string()),
        nickname: z.string().optional(),
      });

      const result = zodToOpenAPI(schema, { includeExamples: false });

      expect(result.type).toBe('object');
      expect(result.properties?.name).toMatchObject({ type: 'string' });
      expect(result.properties?.age).toMatchObject({ type: 'number' });
      expect(result.properties?.active).toMatchObject({ type: 'boolean' });
      expect(result.properties?.role?.type).toBe('string');
      expect(result.properties?.tags).toMatchObject({
        type: 'array',
        items: { type: 'string' },
      });

      // Required list contains the non-optional fields and excludes the optional one.
      expect(result.required).toContain('name');
      expect(result.required).toContain('role');
      expect(result.required).not.toContain('nickname');
    });

    it('attaches examples for primitives when includeExamples is set', () => {
      const result = zodToOpenAPI(z.object({ name: z.string() }), { includeExamples: true });
      expect(result.properties?.name?.example).toBeDefined();
    });

    it('converts primitive schemas', () => {
      expect(zodToOpenAPI(z.string(), { includeExamples: false }).type).toBe('string');
      expect(zodToOpenAPI(z.number(), { includeExamples: false }).type).toBe('number');
      expect(zodToOpenAPI(z.boolean(), { includeExamples: false }).type).toBe('boolean');
    });

    it('reads the format schemas and metadata of Zod 4', () => {
      const convert = (schema: any) => zodToOpenAPI(schema, { includeExamples: false });

      expect(convert(z.email())).toEqual({ type: 'string', format: 'email' });
      expect(convert(z.int())).toEqual({ type: 'integer' });
      expect(convert(z.iso.datetime())).toEqual({ type: 'string', format: 'date-time' });
      expect(convert(z.enum({ Up: 0, Down: 1, 0: 'Up', 1: 'Down' } as any))).toEqual({
        type: 'number',
        enum: [0, 1],
      });
      // .describe() before a further check, and under a wrapper
      expect(convert(z.string().describe('The name').min(2).optional())).toEqual({
        type: 'string',
        minLength: 2,
        description: 'The name',
      });
      expect(zodToOpenAPI(z.string().meta({ example: 'Ann' })).example).toBe('Ann');
    });
  });

  // The same schema documents the same way whichever Zod generation built it
  describe.each([
    ['Zod 4', z as any],
    ['Zod 3', z3 as any],
  ])('zodToOpenAPI with %s', (_generation, zod) => {
    const convert = (schema: any) => zodToOpenAPI(schema, { includeExamples: false });

    it('keeps string checks', () => {
      expect(convert(zod.string().email().min(5).max(50))).toEqual({
        type: 'string',
        format: 'email',
        minLength: 5,
        maxLength: 50,
      });
      expect(convert(zod.string().regex(/^a+$/))).toEqual({ type: 'string', pattern: '^a+$' });
      expect(convert(zod.string().length(3))).toEqual({
        type: 'string',
        minLength: 3,
        maxLength: 3,
      });
      expect(convert(zod.string().url()).format).toBe('uri');
      expect(convert(zod.string().uuid()).format).toBe('uuid');
      expect(convert(zod.string().datetime()).format).toBe('date-time');
    });

    it('keeps number checks', () => {
      expect(convert(zod.number().int().min(18).max(99))).toEqual({
        type: 'integer',
        minimum: 18,
        maximum: 99,
      });
      expect(convert(zod.number().positive())).toEqual({
        type: 'number',
        minimum: 0,
        exclusiveMinimum: true,
      });
      expect(convert(zod.number().multipleOf(5).lt(100))).toEqual({
        type: 'number',
        multipleOf: 5,
        maximum: 100,
        exclusiveMaximum: true,
      });
      // Of several lower bounds the tightest is the one that holds
      expect(convert(zod.number().min(18).positive())).toEqual({ type: 'number', minimum: 18 });
    });

    it('marks a nullable schema as nullable', () => {
      expect(convert(zod.string().nullable())).toEqual({ type: 'string', nullable: true });
      expect(convert(zod.enum(['a', 'b']).nullable())).toEqual({
        type: 'string',
        enum: ['a', 'b', null],
        nullable: true,
      });
      expect(convert(zod.null())).toEqual({ type: 'string', nullable: true, enum: [null] });
    });

    it('converts the items of an array and writes its limits as minItems / maxItems', () => {
      expect(
        convert(
          zod
            .array(zod.object({ id: zod.number() }))
            .min(1)
            .max(4)
        )
      ).toEqual({
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        minItems: 1,
        maxItems: 4,
      });
      expect(convert(zod.array(zod.string()).length(2))).toEqual({
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 2,
      });
    });

    it('lists the values of an enum and of a literal', () => {
      expect(convert(zod.enum(['admin', 'user']))).toEqual({
        type: 'string',
        enum: ['admin', 'user'],
      });
      expect(convert(zod.nativeEnum({ A: 'a', B: 2 }))).toEqual({ enum: ['a', 2] });
      expect(convert(zod.literal('x'))).toEqual({ type: 'string', enum: ['x'] });
      expect(convert(zod.literal(7))).toEqual({ type: 'number', enum: [7] });
    });

    it('documents a date as a date-time string and a record by its value type', () => {
      expect(convert(zod.date())).toEqual({
        type: 'string',
        format: 'date-time',
        description: 'ISO 8601 date-time string',
      });
      expect(convert(zod.record(zod.string(), zod.number()))).toEqual({
        type: 'object',
        additionalProperties: { type: 'number' },
      });
    });

    it('carries descriptions and defaults', () => {
      expect(convert(zod.string().describe('Shown in the docs'))).toEqual({
        type: 'string',
        description: 'Shown in the docs',
      });
      expect(convert(zod.number().default(10))).toEqual({ type: 'number', default: 10 });
      expect(
        zodToOpenAPI(zod.string().describe('hidden'), {
          includeExamples: false,
          includeDescriptions: false,
        })
      ).toEqual({ type: 'string' });
    });

    it('requires the keys a request has to send', () => {
      const result = convert(
        zod.object({
          plain: zod.string(),
          nullable: zod.string().nullable(),
          optional: zod.string().optional(),
          defaulted: zod.string().default('x'),
          transformed: zod
            .string()
            .optional()
            .transform((value: unknown) => value),
        })
      );

      expect(result.required).toEqual(['plain', 'nullable']);
      expect(result.properties?.transformed).toEqual({ type: 'string' });
    });

    it('documents unions, intersections, tuples and strict objects', () => {
      expect(convert(zod.union([zod.string(), zod.number()]))).toEqual({
        oneOf: [{ type: 'string' }, { type: 'number' }],
      });
      expect(
        convert(zod.intersection(zod.object({ a: zod.string() }), zod.object({ b: zod.number() })))
          .allOf
      ).toHaveLength(2);
      expect(convert(zod.tuple([zod.string(), zod.number()]))).toEqual({
        type: 'array',
        items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        minItems: 2,
        maxItems: 2,
      });
      expect(convert(zod.object({ a: zod.string() }).strict()).additionalProperties).toBe(false);
      expect(convert(zod.object({ a: zod.string() })).additionalProperties).toBeUndefined();
      expect(convert(zod.object({}).catchall(zod.number())).additionalProperties).toEqual({
        type: 'number',
      });
    });

    it('documents the value that goes into a refinement or a transform', () => {
      expect(
        convert(
          zod
            .string()
            .min(2)
            .refine(() => true)
        )
      ).toEqual({
        type: 'string',
        minLength: 2,
      });
      expect(convert(zod.string().transform((value: string) => value.length))).toEqual({
        type: 'string',
      });
      expect(convert(zod.preprocess((value: unknown) => value, zod.number().int()))).toEqual({
        type: 'integer',
      });
    });

    it('documents what has no JSON Schema form as any value', () => {
      expect(convert(zod.any())).toEqual({});
      expect(convert(zod.unknown())).toEqual({});
      expect(convert(zod.map(zod.string(), zod.number()))).toEqual({});
      expect(convert(zod.object({ when: zod.symbol() })).properties?.when).toEqual({});
    });

    it('documents a schema that contains itself one level deep', () => {
      const node: any = zod.object({
        value: zod.string(),
        children: zod.lazy(() => zod.array(node)),
      });

      expect(convert(node)).toEqual({
        type: 'object',
        properties: { value: { type: 'string' }, children: { type: 'array', items: {} } },
        required: ['value', 'children'],
      });
    });

    it('writes examples that satisfy the limits beside them', () => {
      const withExamples = (schema: any) => zodToOpenAPI(schema, { includeExamples: true });

      expect(withExamples(zod.number().int().max(10)).example).toBe(10);
      expect(withExamples(zod.number().int()).example).toBe(42);
      expect(withExamples(zod.string().max(3)).example).toBe('str');
      expect(withExamples(zod.string().min(8)).example).toHaveLength(8);
      expect(withExamples(zod.string().url()).example).toBe('https://example.com');
      expect(withExamples(zod.array(zod.object({ id: zod.number().int() }))).example).toEqual([
        { id: 42 },
      ]);
    });

    it('builds an example value for a whole schema', () => {
      const schema = zod.object({
        email: zod.string().email(),
        age: zod.number().int().min(18),
        nick: zod.string().nullable(),
        tags: zod.array(zod.object({ id: zod.number() })).min(2),
        role: zod.enum(['admin', 'user']),
        kind: zod.literal('x'),
        when: zod.date(),
        page: zod.number().default(1),
        note: zod.string().optional(),
      });

      expect(generateExampleFromSchema(schema)).toEqual({
        email: 'user@example.com',
        age: 42,
        nick: 'string',
        tags: [{ id: 42 }, { id: 42 }],
        role: 'admin',
        kind: 'x',
        when: '2023-12-01T10:00:00Z',
        page: 1,
      });
    });
  });

  describe('schemaToOpenAPI', () => {
    const joiDescription = {
      type: 'object',
      keys: {
        name: {
          type: 'string',
          flags: { presence: 'required', description: 'the name' },
          rules: [
            { name: 'min', args: { limit: 2 } },
            { name: 'max', args: { limit: 9 } },
          ],
          examples: ['Ann'],
        },
        n: {
          type: 'number',
          rules: [{ name: 'integer' }, { name: 'greater', args: { limit: 1 } }],
        },
        email: { type: 'string', rules: [{ name: 'email' }] },
        code: { type: 'string', rules: [{ name: 'pattern', args: { regex: '/^a+$/i' } }] },
        role: { type: 'string', flags: { only: true, default: 'a' }, allow: ['a', 'b'] },
        nick: { type: 'string', allow: [null] },
        tags: {
          type: 'array',
          rules: [{ name: 'min', args: { limit: 1 } }],
          items: [{ type: 'object', keys: { id: { type: 'number' } } }],
        },
        when: { type: 'date' },
        other: {
          type: 'number',
          rules: [{ name: 'min', args: { limit: { ref: { path: ['n'] } } } }],
        },
        never: { type: 'string', flags: { presence: 'forbidden' } },
        anything: { type: 'any' },
      },
    };
    const joiExpected = {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 2,
          maxLength: 9,
          description: 'the name',
          example: 'Ann',
        },
        n: { type: 'integer', minimum: 1, exclusiveMinimum: true },
        email: { type: 'string', format: 'email' },
        code: { type: 'string', pattern: '^a+$' },
        role: { type: 'string', enum: ['a', 'b'], default: 'a' },
        nick: { type: 'string', nullable: true },
        tags: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'number' } } },
          minItems: 1,
        },
        when: { type: 'string', format: 'date-time' },
        other: { type: 'number' },
        anything: {},
      },
      required: ['name'],
    };

    it('reads the keys, rules and flags of a Joi schema', () => {
      expect(schemaToOpenAPI(joiSchema(joiDescription) as any)).toEqual(joiExpected);
    });

    it('documents a Joi schema held by the joi() adapter, as a route holds it', () => {
      const wrapped = joi(joiSchema(joiDescription));

      expect(schemaToOpenAPI(wrapped)).toEqual(joiExpected);
      expect(generateExampleFromValidationSchema(wrapped)).toEqual({ name: 'Ann', role: 'a' });
    });

    it('documents a Yup schema held by the yup() adapter', () => {
      const field = (type: string, extra: Record<string, unknown> = {}) => ({
        type,
        optional: true,
        nullable: false,
        oneOf: [],
        tests: [],
        ...extra,
      });
      const wrapped = yup(
        yupSchema(
          field('object', {
            fields: {
              name: field('string', {
                optional: false,
                tests: [{ name: 'required' }, { name: 'min', params: { min: 2 } }],
              }),
              age: field('number', {
                tests: [{ name: 'integer' }, { name: 'min', params: { more: 0 } }],
              }),
              email: field('string', { tests: [{ name: 'email', params: {} }] }),
              role: field('string', { oneOf: ['a', 'b'], default: 'a' }),
              nick: field('string', { nullable: true, meta: { description: 'Shown name' } }),
              tags: field('array', {
                innerType: field('string'),
                tests: [{ name: 'max', params: { max: 3 } }],
              }),
              free: field('mixed'),
            },
          })
        )
      );

      expect(schemaToOpenAPI(wrapped)).toEqual({
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2 },
          age: { type: 'integer', minimum: 0, exclusiveMinimum: true },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['a', 'b'], default: 'a' },
          nick: { type: 'string', nullable: true, description: 'Shown name' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          free: {},
        },
        required: ['name'],
      });
    });

    it('documents a validator it cannot read as any value, with no example', () => {
      const custom = { parseAsync: async (value: unknown) => value };

      expect(schemaToOpenAPI(custom)).toEqual({});
      expect(generateExampleFromValidationSchema(custom)).toBeUndefined();
    });
  });

  describe('generateOpenAPIFromRoutes', () => {
    const buildSpec = () =>
      generateOpenAPIFromRoutes(
        [
          makeRoute({
            method: 'GET',
            path: '/users/:id',
            handler: () => {},
            description: 'Get a user',
            tags: ['users'],
            validation: {
              params: z.object({ id: z.string() }),
              query: z.object({ verbose: z.boolean().optional() }),
            },
          }),
          makeRoute({
            method: 'POST',
            path: '/users',
            handler: () => {},
            tags: ['users'],
            validation: { body: z.object({ name: z.string(), email: z.string() }) },
            rateLimit: { requests: 10, window: 60000 },
          }),
          makeRoute({
            method: 'GET',
            path: '/secret',
            handler: () => {},
            auth: { roles: ['admin'] },
          }),
        ] as any,
        {
          info: { title: 'Test API', version: '1.2.3' },
          includeSchemas: true,
          includeExamples: false,
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        }
      );

    it('produces a valid OpenAPI 3.0 envelope', () => {
      const spec = buildSpec();
      expect(spec.openapi).toBe('3.0.3');
      expect(spec.info).toEqual({ title: 'Test API', version: '1.2.3' });
      expect(Array.isArray(spec.servers)).toBe(true);
    });

    it('registers each route method+path, converting :param to {param}', () => {
      const spec = buildSpec();
      expect(Object.keys(spec.paths).sort()).toEqual(['/secret', '/users', '/users/{id}']);
      expect(spec.paths['/users/{id}'].get).toBeDefined();
      expect(spec.paths['/users'].post).toBeDefined();
    });

    it('maps path and query parameters from validation schemas', () => {
      const spec = buildSpec();
      const params = spec.paths['/users/{id}'].get.parameters ?? [];
      const id = params.find(p => p.name === 'id');
      const verbose = params.find(p => p.name === 'verbose');

      expect(id).toMatchObject({ in: 'path', required: true });
      expect(id?.schema.type).toBe('string');
      expect(verbose).toMatchObject({ in: 'query', required: false });
    });

    it('emits a JSON request body for POST plus a 201 response', () => {
      const spec = buildSpec();
      const post = spec.paths['/users'].post;
      expect(post.requestBody).toBeDefined();

      const bodySchema = post.requestBody!.content['application/json'].schema;
      expect(bodySchema).toMatchObject({ type: 'object' });
      expect(bodySchema.required).toEqual(expect.arrayContaining(['name', 'email']));
      expect(Object.keys(post.responses)).toEqual(expect.arrayContaining(['200', '201', '500']));
    });

    it('adds a 429 response for rate-limited routes', () => {
      const spec = buildSpec();
      expect(spec.paths['/users'].post.responses['429']).toBeDefined();
    });

    it('adds security requirements and 401/403 responses for authenticated routes', () => {
      const spec = buildSpec();
      const get = spec.paths['/secret'].get;
      // An HTTP bearer scheme takes no scopes; the role is named in the 403 response
      expect(get.security).toEqual([{ bearerAuth: [] }]);
      expect(get.responses['401']).toBeDefined();
      expect(get.responses['403'].description).toBe(
        'Insufficient permissions (requires the role admin)'
      );
    });

    it('declares the security scheme its requirements name', () => {
      const spec = buildSpec();
      expect(spec.components?.securitySchemes).toEqual({
        bearerAuth: { type: 'http', scheme: 'bearer' },
      });
    });

    it('collects tags declared on routes', () => {
      const spec = buildSpec();
      expect(spec.tags).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'users' })])
      );
    });

    it('generateJSON() returns parseable JSON for the spec', () => {
      const gen = new OpenAPIGenerator({ info: { title: 'X', version: '1' } });
      gen.addRoutes([makeRoute({ method: 'GET', path: '/health', handler: () => {} })] as any);

      const parsed = JSON.parse(gen.generateJSON());
      expect(parsed.openapi).toBe('3.0.3');
      expect(parsed.paths['/health'].get).toBeDefined();
    });
  });

  describe('security', () => {
    it('declares a bearer scheme when none was configured and a route needs one', () => {
      const spec = generatorFor([{ path: '/admin', auth: {} }], {
        securitySchemes: undefined,
      }).generate();

      expect(spec.paths['/admin'].get.security).toEqual([{ bearerAuth: [] }]);
      expect(spec.components?.securitySchemes?.bearerAuth).toMatchObject({
        type: 'http',
        scheme: 'bearer',
      });

      // Nothing to authenticate, nothing declared
      const open = generatorFor([{ path: '/open' }]).generate();
      expect(open.components).toBeUndefined();
      expect(open.paths['/open'].get.security).toBeUndefined();
    });

    it('names a configured scheme when bearerAuth is not among them', () => {
      const schemes = { session: { type: 'apiKey', in: 'cookie', name: 'sid' } };
      const spec = generatorFor([{ path: '/admin', auth: {} }], {
        securitySchemes: schemes,
      }).generate();

      expect(spec.paths['/admin'].get.security).toEqual([{ session: [] }]);
      expect(spec.components?.securitySchemes).toEqual(schemes);
    });

    it('lets a request through without credentials where auth is optional', () => {
      const spec = generatorFor([{ path: '/feed', auth: { optional: true } }]).generate();

      expect(spec.paths['/feed'].get.security).toEqual([{}, { bearerAuth: [] }]);
    });

    it('names the roles and permissions a route asks for in its 403 response', () => {
      const spec = generatorFor([
        { path: '/a', auth: { roles: ['admin', 'ops'], permissions: ['orders:write'] } },
        { path: '/b', auth: {} },
      ]).generate();

      expect(spec.paths['/a'].get.responses['403'].description).toBe(
        'Insufficient permissions (requires one of the roles admin, ops and the permission orders:write)'
      );
      expect(spec.paths['/b'].get.responses['403'].description).toBe('Insufficient permissions');
    });

    it('leaves authentication out of the document with enableAuth: false', () => {
      const spec = generatorFor([{ path: '/admin', auth: { roles: ['admin'] } }], {
        enableAuth: false,
      }).generate();

      expect(spec.components).toBeUndefined();
      expect(spec.paths['/admin'].get.security).toBeUndefined();
      expect(spec.paths['/admin'].get.responses['403'].description).toBe(
        'Insufficient permissions'
      );
    });
  });

  describe('parameters', () => {
    it('declares a parameter for every path template', () => {
      const spec = generatorFor([{ path: '/users/:id/posts/:postId' }]).generate();

      expect(spec.paths['/users/{id}/posts/{postId}'].get.parameters).toEqual([
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'postId', in: 'path', required: true, schema: { type: 'string' } },
      ]);
    });

    it('types a path parameter from the params schema and declares only those in the path', () => {
      const spec = generatorFor([
        {
          path: '/users/:id/posts/:postId',
          validation: { params: z.object({ id: z.string().uuid(), elsewhere: z.string() }) },
        },
      ]).generate();
      const parameters = spec.paths['/users/{id}/posts/{postId}'].get.parameters ?? [];

      expect(parameters.map(parameter => parameter.name)).toEqual(['id', 'postId']);
      expect(parameters[0].schema.format).toBe('uuid');
      expect(parameters[1].schema).toEqual({ type: 'string' });
    });

    it('treats a colon inside a segment as part of the path', () => {
      const spec = generatorFor([{ path: '/files/a:b' }]).generate();

      expect(Object.keys(spec.paths)).toEqual(['/files/a:b']);
      expect(spec.paths['/files/a:b'].get.parameters).toBeUndefined();
    });

    // What OpenAPI asks of a path item: a required path parameter for each
    // {name} of its template, and none that the template does not have
    const expectValidPathParameters = (spec: any) => {
      for (const [path, item] of Object.entries<any>(spec.paths)) {
        const inTemplate = [...path.matchAll(/\{([^}]+)\}/g)].map(found => found[1]);
        expect(new Set(inTemplate).size).toBe(inTemplate.length);
        for (const operation of Object.values<any>(item)) {
          const declared = (operation.parameters ?? []).filter((p: any) => p.in === 'path');
          expect([path, declared.map((p: any) => p.name)]).toEqual([path, inTemplate]);
          expect(declared.every((p: any) => p.required === true)).toBe(true);
        }
      }
    };

    it('documents a route with optional parameters under each path it answers', () => {
      const spec = generatorFor([
        {
          path: '/archive/:year?/:month?',
          description: 'Archive',
          validation: { params: z.object({ year: z.string().length(4).optional() }) },
        },
      ]).generate();

      expect(Object.keys(spec.paths)).toEqual([
        '/archive',
        '/archive/{year}',
        '/archive/{year}/{month}',
      ]);
      expect(spec.paths['/archive'].get.parameters).toBeUndefined();
      expect(spec.paths['/archive/{year}'].get.parameters).toEqual([
        {
          name: 'year',
          in: 'path',
          required: true,
          schema: { type: 'string', minLength: 4, maxLength: 4 },
        },
      ]);
      expect(spec.paths['/archive/{year}/{month}'].get.parameters?.map(p => p.name)).toEqual([
        'year',
        'month',
      ]);
      for (const path of Object.keys(spec.paths)) {
        expect(spec.paths[path].get.summary).toBe('Archive');
      }
      expectValidPathParameters(spec);
    });

    it('leaves a path to the route registered for exactly it, whichever comes first', () => {
      for (const order of [
        ['/users/:id?', '/users', '/users/:id'],
        ['/users', '/users/:id', '/users/:id?'],
      ]) {
        const spec = generatorFor(order.map(path => ({ path, description: path }))).generate();

        expect(Object.keys(spec.paths).sort()).toEqual(['/users', '/users/{id}']);
        expect(spec.paths['/users'].get.summary).toBe('/users');
        expect(spec.paths['/users/{id}'].get.summary).toBe('/users/:id');
        expectValidPathParameters(spec);
      }
    });

    it('documents a wildcard as one path parameter in the last place', () => {
      const spec = generatorFor([
        { path: '/files/*' },
        {
          path: '/static/:kind/*path',
          validation: { params: z.object({ path: z.string().max(200) }) },
        },
        { path: '/odd/:wildcard/*' },
        { path: '/glob/**' },
      ]).generate();

      expect(Object.keys(spec.paths)).toEqual([
        '/files/{wildcard}',
        '/static/{kind}/{path}',
        '/odd/{wildcard}/{wildcard_}',
        '/glob/**',
      ]);
      expect(spec.paths['/files/{wildcard}'].get.parameters).toEqual([
        {
          name: 'wildcard',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            description: 'The rest of the path. It can be empty and can contain slashes.',
          },
          description: 'The rest of the path. It can be empty and can contain slashes.',
        },
      ]);
      const named = spec.paths['/static/{kind}/{path}'].get.parameters ?? [];
      expect(named.map(p => p.name)).toEqual(['kind', 'path']);
      expect(named[1].schema.maxLength).toBe(200);
      expect(spec.paths['/glob/**'].get.parameters).toBeUndefined();
      expectValidPathParameters(spec);

      // The document survives the trip through YAML
      const generator = generatorFor([{ path: '/files/*' }, { path: '/users/:id?' }]);
      expect(yaml.load(generator.generateYAML())).toEqual(JSON.parse(generator.generateJSON()));
    });

    it('lists path, query and header parameters, and no example key without an example', () => {
      const spec = generatorFor([
        {
          path: '/tenants/:tenant/search',
          validation: {
            query: z.object({ q: z.string(), limit: z.coerce.number().default(10) }),
            headers: z.object({ 'x-trace': z.string().optional() }),
          },
        },
      ]).generate();
      const parameters = spec.paths['/tenants/{tenant}/search'].get.parameters ?? [];

      expect(parameters).toEqual([
        { name: 'tenant', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'number', default: 10 } },
        { name: 'x-trace', in: 'header', required: false, schema: { type: 'string' } },
      ]);
      for (const parameter of parameters) {
        expect(Object.keys(parameter)).not.toContain('example');
      }
    });
  });

  describe('includeSchemas', () => {
    const routes = [
      {
        method: 'POST',
        path: '/users/:id',
        validation: {
          params: z.object({ id: z.string().uuid() }),
          query: z.object({ verbose: z.boolean().describe('More detail') }),
          body: z.object({ name: z.string() }),
        },
      },
    ];

    it('writes the validation schemas by default', () => {
      const post = generatorFor(routes).generate().paths['/users/{id}'].post;

      expect(post.requestBody?.content['application/json'].schema.properties).toEqual({
        name: { type: 'string' },
      });
      expect(post.parameters?.[0].schema).toMatchObject({ type: 'string', format: 'uuid' });
    });

    it('with false, documents a body as an object and a parameter by name and location', () => {
      const post = generatorFor(routes, { includeSchemas: false }).generate().paths['/users/{id}']
        .post;

      expect(post.requestBody?.content['application/json']).toEqual({ schema: { type: 'object' } });
      expect(post.parameters).toEqual([
        { name: 'id', in: 'path', required: true, schema: {} },
        { name: 'verbose', in: 'query', required: true, schema: {}, description: 'More detail' },
      ]);
    });
  });

  describe('servers', () => {
    it('defaults to the origin the document is served from; a configured list stays as given', () => {
      const servers = [{ url: 'https://api.example.com', description: 'Production' }];

      expect(generatorFor([]).generate().servers).toEqual([{ url: '/' }]);
      expect(generatorFor([], { servers }).generate().servers).toEqual(servers);
    });
  });

  describe('route list', () => {
    it('holds one entry per method and path however often a route is added', () => {
      const generator = generatorFor([]);
      const routes = [
        makeRoute({ method: 'GET', path: '/a', handler: () => {} }),
        makeRoute({ method: 'GET', path: '/b', handler: () => {} }),
      ] as any;

      generator.addRoutes(routes);
      generator.addRoutes(routes);
      generator.addRoutes(routes);

      expect((generator as any).routes).toHaveLength(2);
    });

    it('setRoutes() replaces what was documented, tags included', () => {
      const generator = generatorFor([{ path: '/old', tags: ['old'] }]);

      generator.setRoutes([
        makeRoute({ method: 'GET', path: '/new', handler: () => {}, tags: ['new'] }),
      ] as any);
      const spec = generator.generate();

      expect(Object.keys(spec.paths)).toEqual(['/new']);
      expect(spec.tags?.map(tag => tag.name)).toEqual(['new']);
    });
  });

  describe('generateYAML', () => {
    it('reads back as the document generateJSON() writes', () => {
      const generator = new OpenAPIGenerator({
        info: {
          title: 'Orders "API": v1',
          version: '1.0',
          description: 'First line\nsecond line # not a comment',
        },
        includeExamples: true,
        securitySchemes: defaultSecuritySchemes,
      });
      generator.addRoutes([
        makeRoute({
          method: 'POST',
          path: '/users/:id',
          handler: () => {},
          description: "Update a 'user': {profile}, [tags] & more\ttabbed \u2028 separated",
          tags: ['yes', 'null', '123', '- dash', ''],
          auth: { roles: ['admin'] },
          validation: {
            query: z.object({ on: z.boolean().optional(), '200': z.string().default('') }),
            body: z.object({
              name: z.string().regex(/^[a-z]+: "\w+"$/),
              ratio: z.number().default(-1.5e-7),
              none: z.string().nullable().default(null),
              tags: z.array(z.string()).default([]),
              meta: z.record(z.string(), z.unknown()).default({}),
            }),
          },
        }),
        makeRoute({ method: 'GET', path: '/health', handler: () => {} }),
      ] as any);

      const text = generator.generateYAML();

      expect(yaml.load(text)).toEqual(JSON.parse(generator.generateJSON()));
      expect(text).toContain('openapi: "3.0.3"');
    });
  });

  describe('documentation system', () => {
    const handler = () => ({});
    const config = { title: 'T', version: '1' };

    it('documents routes declared after enableDocs()', () => {
      const routing = new IntelligentRoutingManager();
      const docs = new AppDocumentationManager();
      routing.route({ method: 'GET', path: '/early', handler });
      withSwaggerUiPackage(() => docs.enableDocs(config, routing));

      routing.route({ method: 'POST', path: '/late/:id', handler });

      const paths = ['/early', '/late/{id}'];
      expect(Object.keys(docs.getOpenAPISpec().paths)).toEqual(paths);
      expect(Object.keys(JSON.parse(docs.getDocsJSON()).paths)).toEqual(paths);
      expect(Object.keys(yaml.load(docs.getDocsYAML()).paths)).toEqual(paths);
    });

    it('serves routes declared after enableDocs() at openapi.json', () => {
      const routing = new IntelligentRoutingManager();
      const docs = new AppDocumentationManager();
      withSwaggerUiPackage(() => docs.enableDocs(config, routing));
      const middleware = docs.getDocsMiddleware();

      routing.route({ method: 'GET', path: '/late', handler });

      expect(Object.keys(servedSpec(middleware).paths)).toEqual(['/late']);
    });

    it('generates again only when the routes have changed', () => {
      const routing = new IntelligentRoutingManager();
      const docs = new AppDocumentationManager();
      routing.route({ method: 'GET', path: '/a', handler });
      withSwaggerUiPackage(() => docs.enableDocs(config, routing));
      const middleware = docs.getDocsMiddleware();
      const generate = jest.spyOn(OpenAPIGenerator.prototype, 'generate');

      try {
        const first = servedSpec(middleware);
        servedSpec(middleware);
        expect(servedSpec(middleware)).toBe(first);
        expect(generate).not.toHaveBeenCalled();

        routing.route({ method: 'GET', path: '/b', handler });
        const second = servedSpec(middleware);
        servedSpec(middleware);

        expect(Object.keys(second.paths)).toEqual(['/a', '/b']);
        expect(generate).toHaveBeenCalledTimes(1);
      } finally {
        generate.mockRestore();
      }
    });

    it('refreshDocs() documents each route once however often it is called', () => {
      const routing = new IntelligentRoutingManager();
      const docs = new AppDocumentationManager();
      routing.route({ method: 'GET', path: '/a', handler });
      routing.route({ method: 'GET', path: '/b', handler });
      withSwaggerUiPackage(() => docs.enableDocs(config, routing));

      docs.refreshDocs();
      docs.refreshDocs();

      const generator = (docs as any).docSystem.generator;
      expect(generator.routes).toHaveLength(2);
      expect(Object.keys(docs.getOpenAPISpec().paths)).toEqual(['/a', '/b']);
    });

    it('generateFromRoutes() documents a route once however often it is given', () => {
      const system = withSwaggerUiPackage(() => new DocumentationSystem(config));
      const first = [makeRoute({ method: 'GET', path: '/a', handler })] as any;

      system.generateFromRoutes(first);
      system.generateFromRoutes(first);
      const spec = system.generateFromRoutes([
        makeRoute({ method: 'GET', path: '/b', handler }),
      ] as any);

      expect((system as any).generator.routes).toHaveLength(2);
      expect(Object.keys(spec.paths)).toEqual(['/a', '/b']);
    });

    it('passes enableAuth: false on to the document', () => {
      const system = withSwaggerUiPackage(
        () => new DocumentationSystem({ ...config, enableAuth: false })
      );

      const spec = system.generateFromRoutes([
        makeRoute({ method: 'GET', path: '/admin', handler, auth: { roles: ['admin'] } }),
      ] as any);

      expect(spec.components).toBeUndefined();
      expect(spec.paths['/admin'].get.security).toBeUndefined();
    });
  });
});
