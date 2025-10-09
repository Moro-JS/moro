// OpenAPI Specification Generator for Moro Framework
// Extracts route information from intelligent routing and generates OpenAPI 3.0 specs

import { CompiledRoute, RouteSchema } from '../routing/index.js';
import { OpenAPISchema } from './zod-to-openapi.js';
import { schemaToOpenAPI, generateExampleFromValidationSchema } from './schema-to-openapi.js';
import { createFrameworkLogger } from '../logger/index.js';

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
  includeSchemas?: boolean;
  groupByTags?: boolean;
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
}

// OpenAPI generator class
export class OpenAPIGenerator {
  private routes: CompiledRoute[] = [];
  private schemas = new Map<string, OpenAPISchema>();
  private tags = new Set<string>();

  constructor(private options: GenerationOptions) {
    logger.debug('OpenAPI Generator initialized', 'Initialization', {
      includeExamples: options.includeExamples,
      includeSchemas: options.includeSchemas,
    });
  }

  // Add routes to the generator
  addRoutes(routes: CompiledRoute[]): void {
    this.routes.push(...routes);

    // Extract tags from routes
    routes.forEach(route => {
      if (route.schema.tags) {
        route.schema.tags.forEach(tag => this.tags.add(tag));
      }
    });

    logger.debug(`Added ${routes.length} routes to documentation`, 'RouteAddition', {
      totalRoutes: this.routes.length,
      uniqueTags: this.tags.size,
    });
  }

  // Generate complete OpenAPI specification
  generate(): OpenAPISpec {
    logger.info('Generating OpenAPI specification', 'Generation', {
      routeCount: this.routes.length,
      tagCount: this.tags.size,
    });

    const spec: OpenAPISpec = {
      openapi: '3.0.3',
      info: this.options.info,
      servers: this.options.servers || [
        { url: 'http://localhost:3000', description: 'Development server' },
      ],
      paths: this.generatePaths(),
      tags: this.generateTags(),
    };

    // Add components if schemas are included
    if (this.options.includeSchemas && this.schemas.size > 0) {
      spec.components = {
        schemas: Object.fromEntries(this.schemas),
        securitySchemes: this.options.securitySchemes,
      };
    }

    logger.info('OpenAPI specification generated successfully', 'Generation', {
      pathCount: Object.keys(spec.paths).length,
      schemaCount: this.schemas.size,
      tagCount: spec.tags?.length || 0,
    });

    return spec;
  }

  // Generate paths from routes
  private generatePaths(): Record<string, OpenAPIPath> {
    const paths: Record<string, OpenAPIPath> = {};

    for (const route of this.routes) {
      const path = this.convertPathToOpenAPI(route.schema.path);
      const method = route.schema.method.toLowerCase();

      if (!paths[path]) {
        paths[path] = {};
      }

      paths[path][method] = this.generateOperation(route.schema);
    }

    return paths;
  }

  // Generate OpenAPI operation from route schema
  private generateOperation(route: RouteSchema): OpenAPIOperation {
    const operation: OpenAPIOperation = {
      summary: route.description || `${route.method} ${route.path}`,
      description: route.description,
      tags: route.tags,
      responses: this.generateResponses(route),
    };

    // Add parameters (query and path)
    const parameters = this.generateParameters(route);
    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    // Add request body (for POST, PUT, PATCH)
    if (['POST', 'PUT', 'PATCH'].includes(route.method) && route.validation?.body) {
      operation.requestBody = this.generateRequestBody(route);
    }

    // Add security if auth is required
    if (route.auth) {
      operation.security = this.generateSecurity(route);
    }

    return operation;
  }

  // Generate parameters from validation schemas
  private generateParameters(route: RouteSchema): OpenAPIParameter[] {
    const parameters: OpenAPIParameter[] = [];

    // Path parameters
    if (route.validation?.params) {
      const paramSchema = schemaToOpenAPI(route.validation.params, this.options);
      if (paramSchema.properties) {
        for (const [name, schema] of Object.entries(paramSchema.properties)) {
          parameters.push({
            name,
            in: 'path',
            required: true,
            schema,
            description: schema.description,
            example: this.options.includeExamples ? schema.example : undefined,
          });
        }
      }
    }

    // Query parameters
    if (route.validation?.query) {
      const querySchema = schemaToOpenAPI(route.validation.query, this.options);
      if (querySchema.properties) {
        for (const [name, schema] of Object.entries(querySchema.properties)) {
          const isRequired = querySchema.required?.includes(name) || false;
          parameters.push({
            name,
            in: 'query',
            required: isRequired,
            schema,
            description: schema.description,
            example: this.options.includeExamples ? schema.example : undefined,
          });
        }
      }
    }

    // Header parameters
    if (route.validation?.headers) {
      const headerSchema = schemaToOpenAPI(route.validation.headers, this.options);
      if (headerSchema.properties) {
        for (const [name, schema] of Object.entries(headerSchema.properties)) {
          const isRequired = headerSchema.required?.includes(name) || false;
          parameters.push({
            name,
            in: 'header',
            required: isRequired,
            schema,
            description: schema.description,
            example: this.options.includeExamples ? schema.example : undefined,
          });
        }
      }
    }

    return parameters;
  }

  // Generate request body from validation schema
  private generateRequestBody(route: RouteSchema): OpenAPIRequestBody {
    if (!route.validation?.body) {
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

    const bodySchema = schemaToOpenAPI(route.validation.body, this.options);
    const example = this.options.includeExamples
      ? generateExampleFromValidationSchema(route.validation.body)
      : undefined;

    return {
      description: 'Request body',
      required: true,
      content: {
        'application/json': {
          schema: bodySchema,
          example,
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
        description: 'Insufficient permissions',
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

  // Generate security requirements
  private generateSecurity(route: RouteSchema): OpenAPISecurityRequirement[] {
    if (!route.auth) return [];

    const security: OpenAPISecurityRequirement[] = [];

    // Default to bearer token if no specific scheme is defined
    security.push({
      bearerAuth: route.auth.roles || [],
    });

    return security;
  }

  // Generate tags
  private generateTags(): OpenAPITag[] {
    return Array.from(this.tags).map(tag => ({
      name: tag,
      description: `Operations related to ${tag}`,
    }));
  }

  // Convert Moro path format to OpenAPI path format
  private convertPathToOpenAPI(path: string): string {
    // Convert :param to {param} format
    return path.replace(/:([^/]+)/g, '{$1}');
  }

  // Generate JSON representation
  generateJSON(): string {
    return JSON.stringify(this.generate(), null, 2);
  }

  // Generate YAML representation (basic implementation)
  generateYAML(): string {
    const spec = this.generate();
    return this.objectToYAML(spec, 0);
  }

  // Simple YAML converter (basic implementation)
  private objectToYAML(obj: any, indent: number = 0): string {
    const spaces = '  '.repeat(indent);
    let yaml = '';

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;

      yaml += `${spaces}${key}:`;

      if (typeof value === 'object' && !Array.isArray(value)) {
        yaml += '\n' + this.objectToYAML(value, indent + 1);
      } else if (Array.isArray(value)) {
        yaml += '\n';
        for (const item of value) {
          if (typeof item === 'object') {
            yaml += `${spaces}  -\n` + this.objectToYAML(item, indent + 2);
          } else {
            yaml += `${spaces}  - ${item}\n`;
          }
        }
      } else if (typeof value === 'string') {
        yaml += ` "${value}"\n`;
      } else {
        yaml += ` ${value}\n`;
      }
    }

    return yaml;
  }
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
