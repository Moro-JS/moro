// OpenAPI Specification Generator for Moro Framework
// Extracts route information from intelligent routing and generates OpenAPI 3.0 specs

import { CompiledRoute, RouteSchema } from '../routing/index.js';
import { ValidationSchema } from '../validation/schema-interface.js';
import { OpenAPISchema } from './zod-to-openapi.js';
import { schemaToOpenAPI, generateExampleFromValidationSchema } from './schema-to-openapi.js';
import { createFrameworkLogger } from '../logger/index.js';
import {
  parseExtendedPath,
  optionalPathForms,
  type ExtendedPath,
} from '../routing/path-matcher.js';

const logger = createFrameworkLogger('OpenAPIGenerator');

// OpenAPI 3.0 specification structure
export interface OpenAPISpec {
  openapi: string;
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  paths: Record<string, OpenAPIPath>;
  components?: OpenAPIComponents;
  tags?: OpenAPITag[];
}

export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
  contact?: {
    name?: string;
    url?: string;
    email?: string;
  };
  license?: {
    name: string;
    url?: string;
  };
}

export interface OpenAPIServer {
  url: string;
  description?: string;
}

export interface OpenAPIPath {
  [method: string]: OpenAPIOperation;
}

export interface OpenAPIOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses: Record<string, OpenAPIResponse>;
  security?: OpenAPISecurityRequirement[];
}

export interface OpenAPIParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema: OpenAPISchema;
  example?: any;
}

export interface OpenAPIRequestBody {
  description?: string;
  required?: boolean;
  content: Record<string, OpenAPIMediaType>;
}

export interface OpenAPIMediaType {
  schema: OpenAPISchema;
  example?: any;
  examples?: Record<string, OpenAPIExample>;
}

export interface OpenAPIResponse {
  description: string;
  content?: Record<string, OpenAPIMediaType>;
  headers?: Record<string, OpenAPIHeader>;
}

export interface OpenAPIHeader {
  description?: string;
  schema: OpenAPISchema;
}

export interface OpenAPIExample {
  summary?: string;
  description?: string;
  value: any;
}

export interface OpenAPIComponents {
  schemas?: Record<string, OpenAPISchema>;
  responses?: Record<string, OpenAPIResponse>;
  parameters?: Record<string, OpenAPIParameter>;
  examples?: Record<string, OpenAPIExample>;
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
}

export interface OpenAPISecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  description?: string;
  name?: string;
  in?: 'query' | 'header' | 'cookie';
  scheme?: string;
  bearerFormat?: string;
  flows?: Record<string, any>;
  openIdConnectUrl?: string;
}

export interface OpenAPISecurityRequirement {
  [name: string]: string[];
}

export interface OpenAPITag {
  name: string;
  description?: string;
}

// Generation options
export interface GenerationOptions {
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  includeExamples?: boolean;
  /**
   * Write the validation schemas of request bodies and parameters into the
   * document (default true). With false a body is documented as a plain object
   * and a parameter by its name and location only.
   */
  includeSchemas?: boolean;
  groupByTags?: boolean;
  /**
   * Document authentication (default true): routes with `auth` carry a security
   * requirement and the scheme it names is declared. With false neither is written.
   */
  enableAuth?: boolean;
  /**
   * The schemes authenticated routes may use. They are declared when a route
   * requires authentication; the requirement names `bearerAuth` when it is
   * among them, otherwise the first one. Left out, an HTTP bearer scheme named
   * `bearerAuth` is declared.
   */
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
}

// OpenAPI generator class
export class OpenAPIGenerator {
  private routes: CompiledRoute[] = [];

  constructor(private options: GenerationOptions) {
    logger.debug('OpenAPI Generator initialized', 'Initialization', {
      includeExamples: options.includeExamples,
      includeSchemas: options.includeSchemas,
    });
  }

  // Add routes to the generator. A route already held (the same method and
  // path) is replaced by the one given, so passing a list again adds nothing.
  addRoutes(routes: CompiledRoute[]): void {
    const positions = new Map<string, number>();
    this.routes.forEach((route, index) => positions.set(routeKey(route), index));

    for (const route of routes) {
      const key = routeKey(route);
      const position = positions.get(key);
      if (position === undefined) {
        positions.set(key, this.routes.length);
        this.routes.push(route);
      } else {
        this.routes[position] = route;
      }
    }

    logger.debug(`Added ${routes.length} routes to documentation`, 'RouteAddition', {
      totalRoutes: this.routes.length,
    });
  }

  // Make the given routes the whole of what is documented
  setRoutes(routes: CompiledRoute[]): void {
    this.routes = [];
    this.addRoutes(routes);
  }

  // Generate complete OpenAPI specification
  generate(): OpenAPISpec {
    logger.info('Generating OpenAPI specification', 'Generation', {
      routeCount: this.routes.length,
    });

    const spec: OpenAPISpec = {
      openapi: '3.0.3',
      info: this.options.info,
      // With no server configured the API is at the origin the document was
      // served from, whichever host and port that is
      servers: this.options.servers || [{ url: '/' }],
      paths: this.generatePaths(),
      tags: this.generateTags(),
    };

    // Every scheme a security requirement names has to be declared
    const securitySchemes = this.declaredSecuritySchemes();
    if (
      securitySchemes !== undefined &&
      Object.keys(securitySchemes).length > 0 &&
      this.routes.some(route => route.schema.auth)
    ) {
      spec.components = { securitySchemes };
    }

    logger.info('OpenAPI specification generated successfully', 'Generation', {
      pathCount: Object.keys(spec.paths).length,
      tagCount: spec.tags?.length || 0,
    });

    return spec;
  }

  // Generate paths from routes
  private generatePaths(): Record<string, OpenAPIPath> {
    const paths: Record<string, OpenAPIPath> = {};

    // Routes with optional parameters, documented once every other route is
    const optionalRoutes: Array<[CompiledRoute, ExtendedPath]> = [];

    for (const route of this.routes) {
      const extended = extendedSyntaxOf(route.schema.path);
      if (extended !== null && extended.optional.length > 0) {
        optionalRoutes.push([route, extended]);
        continue;
      }

      // A wildcard is documented as one path parameter in the last place
      const template: PathTemplate =
        extended !== null && extended.wildcard !== undefined
          ? wildcardTemplate(extended, extended.wildcard)
          : { path: route.schema.path };
      const path = this.convertPathToOpenAPI(template.path);
      const method = route.schema.method.toLowerCase();

      if (!paths[path]) {
        paths[path] = {};
      }

      paths[path][method] = this.generateOperation(route.schema, template);
    }

    // A path parameter is always required in OpenAPI, so a route with
    // optional parameters is documented under each path it answers:
    // '/users/:id?' under /users and under /users/{id}. A path that another
    // route answers (that route is the one the router prefers) keeps it.
    for (const [route, extended] of optionalRoutes) {
      const method = route.schema.method.toLowerCase();
      for (const form of optionalPathForms(extended)) {
        const path = this.convertPathToOpenAPI(form);
        const documented = (paths[path] ??= {});
        if (documented[method] === undefined) {
          documented[method] = this.generateOperation(route.schema, { path: form });
        }
      }
    }

    return paths;
  }

  // Generate OpenAPI operation from route schema. `template` is the path the
  // operation is documented under, when that is not the route's own.
  private generateOperation(
    route: RouteSchema,
    template: PathTemplate = { path: route.path }
  ): OpenAPIOperation {
    const operation: OpenAPIOperation = {
      summary: route.description || `${route.method} ${route.path}`,
      ...(route.description !== undefined ? { description: route.description } : {}),
      ...(route.tags !== undefined ? { tags: route.tags } : {}),
      responses: this.generateResponses(route),
    };

    // Add parameters (query and path)
    const parameters = this.generateParameters(route, template);
    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    // Add request body (for POST, PUT, PATCH)
    if (['POST', 'PUT', 'PATCH'].includes(route.method) && route.validation?.body) {
      operation.requestBody = this.generateRequestBody(route);
    }

    // Add security if auth is required
    if (route.auth) {
      const security = this.generateSecurity(route);
      if (security.length > 0) operation.security = security;
    }

    return operation;
  }

  // The OpenAPI form of a validation schema
  private convertSchema(schema: ValidationSchema): OpenAPISchema {
    return schemaToOpenAPI(schema, this.options);
  }

  private createParameter(
    name: string,
    location: OpenAPIParameter['in'],
    required: boolean,
    schema: OpenAPISchema
  ): OpenAPIParameter {
    const includeSchema = this.options.includeSchemas !== false;
    return {
      name,
      in: location,
      required,
      schema: includeSchema ? schema : {},
      ...(schema.description !== undefined ? { description: schema.description } : {}),
      ...(includeSchema && this.options.includeExamples && schema.example !== undefined
        ? { example: schema.example }
        : {}),
    };
  }

  // Generate parameters from validation schemas
  private generateParameters(
    route: RouteSchema,
    template: PathTemplate = { path: route.path }
  ): OpenAPIParameter[] {
    const parameters: OpenAPIParameter[] = [];

    // Path parameters: one for every {name} in the path template, which is what
    // OpenAPI requires. The params schema types them; without one a path
    // segment is a string.
    const pathNames = pathParameterNames(template.path);
    if (pathNames.length > 0) {
      const paramSchema = route.validation?.params
        ? this.convertSchema(route.validation.params)
        : undefined;
      for (const name of pathNames) {
        if (template.wildcard !== undefined && name === template.wildcard.documentedAs) {
          // The wildcard, under the key its value has in req.params
          const schema = paramSchema?.properties?.[template.wildcard.key] ?? { type: 'string' };
          parameters.push(
            this.createParameter(name, 'path', true, {
              ...schema,
              description: schema.description ?? WILDCARD_DESCRIPTION,
            })
          );
          continue;
        }
        const schema = paramSchema?.properties?.[name] ?? { type: 'string' };
        parameters.push(this.createParameter(name, 'path', true, schema));
      }
    }

    // Query parameters
    if (route.validation?.query) {
      const querySchema = this.convertSchema(route.validation.query);
      if (querySchema.properties) {
        for (const [name, schema] of Object.entries(querySchema.properties)) {
          const isRequired = querySchema.required?.includes(name) || false;
          parameters.push(this.createParameter(name, 'query', isRequired, schema));
        }
      }
    }

    // Header parameters
    if (route.validation?.headers) {
      const headerSchema = this.convertSchema(route.validation.headers);
      if (headerSchema.properties) {
        for (const [name, schema] of Object.entries(headerSchema.properties)) {
          const isRequired = headerSchema.required?.includes(name) || false;
          parameters.push(this.createParameter(name, 'header', isRequired, schema));
        }
      }
    }

    return parameters;
  }

  // Generate request body from validation schema
  private generateRequestBody(route: RouteSchema): OpenAPIRequestBody {
    if (!route.validation?.body || this.options.includeSchemas === false) {
      return {
        description: 'Request body',
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object' },
          },
        },
      };
    }

    const bodySchema = this.convertSchema(route.validation.body);
    const example = this.options.includeExamples
      ? generateExampleFromValidationSchema(route.validation.body)
      : undefined;

    return {
      description: 'Request body',
      required: true,
      content: {
        'application/json': {
          schema: bodySchema,
          // No example for a schema that says nothing about its value
          ...(example !== undefined && example !== null ? { example } : {}),
        },
      },
    };
  }

  // Generate responses
  private generateResponses(route: RouteSchema): Record<string, OpenAPIResponse> {
    const responses: Record<string, OpenAPIResponse> = {};

    // Success response
    responses['200'] = {
      description: 'Successful response',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: { type: 'object', description: 'Response data' },
              message: { type: 'string', example: 'Operation successful' },
            },
          },
        },
      },
    };

    // Add 201 for POST requests
    if (route.method === 'POST') {
      responses['201'] = {
        description: 'Resource created successfully',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean', example: true },
                data: { type: 'object', description: 'Created resource' },
                message: {
                  type: 'string',
                  example: 'Resource created successfully',
                },
              },
            },
          },
        },
      };
    }

    // Validation error response
    if (route.validation) {
      responses['400'] = {
        description: 'Validation error',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean', example: false },
                error: { type: 'string', example: 'Validation failed' },
                details: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      field: { type: 'string', example: 'email' },
                      message: {
                        type: 'string',
                        example: 'Invalid email address',
                      },
                      code: { type: 'string', example: 'invalid_format' },
                    },
                  },
                },
                requestId: { type: 'string', example: 'req_123456' },
              },
            },
          },
        },
      };
    }

    // Auth error response
    if (route.auth) {
      responses['401'] = {
        description: 'Authentication required',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean', example: false },
                error: { type: 'string', example: 'Authentication required' },
                requestId: { type: 'string', example: 'req_123456' },
              },
            },
          },
        },
      };

      responses['403'] = {
        description: this.describeAccess(route.auth),
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean', example: false },
                error: { type: 'string', example: 'Insufficient permissions' },
                requestId: { type: 'string', example: 'req_123456' },
              },
            },
          },
        },
      };
    }

    // Rate limit error response
    if (route.rateLimit) {
      responses['429'] = {
        description: 'Rate limit exceeded',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean', example: false },
                error: { type: 'string', example: 'Rate limit exceeded' },
                retryAfter: { type: 'number', example: 60 },
                requestId: { type: 'string', example: 'req_123456' },
              },
            },
          },
        },
      };
    }

    // Server error response
    responses['500'] = {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Internal server error' },
              requestId: { type: 'string', example: 'req_123456' },
            },
          },
        },
      },
    };

    return responses;
  }

  // The schemes the document declares, or undefined when authentication is
  // left out of it
  private declaredSecuritySchemes(): Record<string, OpenAPISecurityScheme> | undefined {
    if (this.options.enableAuth === false) return undefined;
    return (
      this.options.securitySchemes ?? {
        bearerAuth: defaultSecuritySchemes.bearerAuth as OpenAPISecurityScheme,
      }
    );
  }

  // Generate security requirements
  private generateSecurity(route: RouteSchema): OpenAPISecurityRequirement[] {
    const schemes = this.declaredSecuritySchemes();
    if (!route.auth || schemes === undefined) return [];

    const name = 'bearerAuth' in schemes ? 'bearerAuth' : Object.keys(schemes)[0];
    if (name === undefined) return [];

    // The list after a scheme name holds OAuth scopes and has to be empty for
    // every other kind of scheme. A route's roles are not scopes; they are
    // written into its 403 response.
    const requirement: OpenAPISecurityRequirement = { [name]: [] };

    // The empty requirement lets a request through without credentials
    return route.auth.optional ? [{}, requirement] : [requirement];
  }

  // What a caller needs to hold to get past a route's auth: any one of its
  // roles and every one of its permissions
  private describeAccess(auth: NonNullable<RouteSchema['auth']>): string {
    const needs: string[] = [];
    if (this.options.enableAuth !== false) {
      const roles = auth.roles ?? [];
      const permissions = auth.permissions ?? [];
      if (roles.length === 1) needs.push(`the role ${roles[0]}`);
      else if (roles.length > 1) needs.push(`one of the roles ${roles.join(', ')}`);
      if (permissions.length === 1) needs.push(`the permission ${permissions[0]}`);
      else if (permissions.length > 1) needs.push(`the permissions ${permissions.join(', ')}`);
    }
    return needs.length > 0
      ? `Insufficient permissions (requires ${needs.join(' and ')})`
      : 'Insufficient permissions';
  }

  // Generate tags: those of the routes documented now, in route order
  private generateTags(): OpenAPITag[] {
    const tags = new Set<string>();
    for (const route of this.routes) {
      route.schema.tags?.forEach(tag => tags.add(tag));
    }
    return Array.from(tags).map(tag => ({
      name: tag,
      description: `Operations related to ${tag}`,
    }));
  }

  // Convert Moro path format to OpenAPI path format
  private convertPathToOpenAPI(path: string): string {
    // A segment that starts with ':' is a parameter: /users/:id -> /users/{id}
    return path.replace(/(^|\/):([^/]+)/g, '$1{$2}');
  }

  // Generate JSON representation
  generateJSON(): string {
    return JSON.stringify(this.generate(), null, 2);
  }

  // Generate YAML representation: the same document generateJSON() writes
  generateYAML(): string {
    // Through JSON first, so both forms agree on what is left out (undefined)
    // and on how values such as dates are written
    const document = JSON.parse(this.generateJSON());
    return yamlLines(document, 0).join('\n') + '\n';
  }
}

// Method and path identify a documented route
function routeKey(route: CompiledRoute): string {
  return `${route.schema.method} ${route.schema.path}`;
}

// The path a route is documented under, written as a route path
interface PathTemplate {
  path: string;
  // The route's wildcard: its key in req.params ('*' unless it was named) and
  // the parameter name it has in `path`
  wildcard?: { key: string; documentedAs: string };
}

const WILDCARD_DESCRIPTION = 'The rest of the path. It can be empty and can contain slashes.';

// What a route path has beyond fixed text and required parameters. Routes
// handed to the generator directly were not checked by a router: a path the
// router would refuse is documented as it is written.
function extendedSyntaxOf(path: string): ExtendedPath | null {
  try {
    return parseExtendedPath(path);
  } catch {
    return null;
  }
}

// '/files/*' as '/files/:wildcard', '/files/*path' as '/files/:path': a path
// template names every parameter, and '*' is not a name a client generator
// can use.
function wildcardTemplate(extended: ExtendedPath, key: string): PathTemplate {
  const taken = pathParameterNames(extended.base);
  let documentedAs = key === '*' ? 'wildcard' : key;
  while (taken.includes(documentedAs)) documentedAs += '_';
  return { path: `${extended.base}/:${documentedAs}`, wildcard: { key, documentedAs } };
}

// The parameter names of a route path, in order: /users/:id/posts/:postId
function pathParameterNames(path: string): string[] {
  const names: string[] = [];
  for (const segment of path.split('/')) {
    if (segment.length > 1 && segment.startsWith(':') && !names.includes(segment.slice(1))) {
      names.push(segment.slice(1));
    }
  }
  return names;
}

// ---- YAML output ------------------------------------------------------------
// Writes a JSON value as block-style YAML. Every string is double-quoted with
// JSON escapes, which YAML reads the same way, so a value can never be taken
// for another type (yes, 1.0, null) or break the structure (": ", "#", a
// newline). Keys are quoted unless they are plain identifiers.

const YAML_PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// Plain words YAML parsers read as booleans or null
const YAML_RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);
// Characters JSON leaves as they are and YAML does not allow in a quoted
// scalar, or treats as a line break
const YAML_UNSAFE = /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g;

function yamlString(value: string): string {
  return JSON.stringify(value).replace(
    YAML_UNSAFE,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function yamlKey(key: string): string {
  return YAML_PLAIN_KEY.test(key) && !YAML_RESERVED.has(key.toLowerCase()) ? key : yamlString(key);
}

// The one-line form of a value, or undefined for a collection with members
function yamlInline(value: unknown): string | undefined {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return yamlString(value);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '[]' : undefined;
  return Object.keys(value).length === 0 ? '{}' : undefined;
}

function yamlLines(value: unknown, indent: number): string[] {
  const pad = '  '.repeat(indent);
  const inline = yamlInline(value);
  if (inline !== undefined) return [`${pad}${inline}`];

  const lines: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      // The item is written one level in, then its first line takes the dash
      const itemLines = yamlLines(item, indent + 1);
      itemLines[0] = `${pad}- ${(itemLines[0] as string).slice(pad.length + 2)}`;
      lines.push(...itemLines);
    }
    return lines;
  }

  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const memberInline = yamlInline(member);
    if (memberInline !== undefined) {
      lines.push(`${pad}${yamlKey(key)}: ${memberInline}`);
    } else {
      lines.push(`${pad}${yamlKey(key)}:`, ...yamlLines(member, indent + 1));
    }
  }
  return lines;
}

// Convenience function to generate OpenAPI from routes
export function generateOpenAPIFromRoutes(
  routes: CompiledRoute[],
  options: GenerationOptions
): OpenAPISpec {
  const generator = new OpenAPIGenerator(options);
  generator.addRoutes(routes);
  return generator.generate();
}

// Default security schemes
export const defaultSecuritySchemes: Record<string, OpenAPISecurityScheme> = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Bearer token authentication',
  },
  apiKey: {
    type: 'apiKey',
    in: 'header',
    name: 'X-API-Key',
    description: 'API key authentication',
  },
};
