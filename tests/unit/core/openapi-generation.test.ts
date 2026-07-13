// OpenAPI generation: zodToOpenAPI schema conversion and OpenAPIGenerator route
// -> spec generation. Uses the zod dependency that ships with the repo.
import { z } from 'zod';
import {
  generateOpenAPIFromRoutes,
  OpenAPIGenerator,
} from '../../../src/core/docs/openapi-generator.js';
import { zodToOpenAPI } from '../../../src/core/docs/zod-to-openapi.js';

// CompiledRoute is { schema, execute }. The generator only reads `schema`, so a
// no-op execute is sufficient.
const makeRoute = (schema: any) => ({ schema, execute: async () => {} });

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
      expect(get.security).toEqual([{ bearerAuth: ['admin'] }]);
      expect(get.responses['401']).toBeDefined();
      expect(get.responses['403']).toBeDefined();
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
});
