// GraphQL Core - Main integration point
import { GraphQLSchema, GraphQLError, getIntrospectionQuery, graphqlSync } from 'graphql';
import { createFrameworkLogger } from '../logger/index.js';
import { GraphQLSchemaBuilder } from './schema-builder.js';
import { GraphQLExecutor } from './executor.js';
import { isPackageAvailable } from '../utilities/package-utils.js';
import type { HttpRequest, HttpResponse } from '../../types/http.js';
import type { GraphQLOptions, GraphQLContext, GraphQLRequest } from './types.js';

const logger = createFrameworkLogger('GraphQL');

/**
 * GraphQL Core - Handles schema management and execution
 */
export class GraphQLCore {
  private schema!: GraphQLSchema;
  private executor!: GraphQLExecutor;
  private schemaBuilder?: GraphQLSchemaBuilder;
  private pothosSchema?: any;
  private contextFactory?: (
    req: HttpRequest,
    res: HttpResponse
  ) => GraphQLContext | Promise<GraphQLContext>;

  constructor(private options: GraphQLOptions) {
    // Validate options
    if (!options.schema && !options.typeDefs && !options.pothosSchema) {
      throw new Error(
        'GraphQL requires either schema, typeDefs, or pothosSchema option to be provided'
      );
    }
  }

  /**
   * Initialize GraphQL system
   */
  async initialize(): Promise<void> {
    logger.info('Initializing GraphQL system', 'Initialization');

    // Build schema
    if (this.options.pothosSchema) {
      await this.initializePothosSchema();
    } else if (this.options.schema) {
      this.schema = this.options.schema;
    } else if (this.options.typeDefs) {
      this.schemaBuilder = new GraphQLSchemaBuilder({
        typeDefs: this.options.typeDefs,
        resolvers: this.options.resolvers,
      });
      this.schema = this.schemaBuilder.build();
    }

    if (!this.schema) {
      throw new Error('Failed to build GraphQL schema');
    }

    // Initialize executor
    this.executor = new GraphQLExecutor(this.schema, {
      enableJIT: this.options.enableJIT !== false,
      jitCacheTTL: this.options.jitCacheTTL,
    });

    // Set context factory
    this.contextFactory = this.options.context || this.defaultContextFactory;

    logger.info('GraphQL system initialized successfully', 'Initialization', {
      jitEnabled: this.executor.getJITStats().enabled,
      introspectionEnabled: this.options.enableIntrospection !== false,
      playgroundEnabled: this.options.enablePlayground !== false,
    });
  }

  /**
   * Initialize Pothos schema
   */
  private async initializePothosSchema(): Promise<void> {
    if (!isPackageAvailable('@pothos/core')) {
      throw new Error(
        'Pothos support requires @pothos/core to be installed. Run: npm install @pothos/core'
      );
    }

    logger.info('Using Pothos schema builder', 'Pothos');

    // Pothos schema should already be built by user
    this.pothosSchema = this.options.pothosSchema;
    this.schema = this.pothosSchema.toSchema ? this.pothosSchema.toSchema() : this.pothosSchema;

    if (!this.schema) {
      throw new Error('Failed to extract GraphQL schema from Pothos schema');
    }
  }

  /**
   * Handle GraphQL HTTP request
   */
  async handleRequest(req: HttpRequest, res: HttpResponse): Promise<void> {
    try {
      // Parse GraphQL request
      const graphqlRequest = await this.parseRequest(req);

      if (!graphqlRequest) {
        (res as any).status(400).json({
          errors: [{ message: 'Invalid GraphQL request' }],
        });
        return;
      }

      // Check introspection
      if (!this.isIntrospectionEnabled() && this.isIntrospectionQuery(graphqlRequest.query)) {
        (res as any).status(400).json({
          errors: [{ message: 'GraphQL introspection is disabled' }],
        });
        return;
      }

      // Create context
      const context = await this.createContext(req, res);

      // Execute query
      const result = await this.executor.executeQuery(
        graphqlRequest.query,
        graphqlRequest.variables,
        context,
        graphqlRequest.operationName || undefined
      );

      // Format errors if needed
      if (result.errors && this.options.formatError) {
        result.errors = result.errors.map(this.options.formatError);
      }

      // Add debug info if enabled
      if (this.options.debug && result.errors) {
        result.errors = result.errors.map(error => {
          const errorObj = error.toJSON ? error.toJSON() : error;
          return new GraphQLError(error.message, {
            ...errorObj,
            extensions: {
              ...error.extensions,
              stack: (error as any).stack,
            },
          });
        });
      }

      // Send response
      (res as any).status(200).json(result);
    } catch (error) {
      logger.error('GraphQL request handler error', 'Handler', { error });

      (res as any).status(500).json({
        errors: [
          {
            message: error instanceof Error ? error.message : 'Internal server error',
          },
        ],
      });
    }
  }

  /**
   * Get GraphQL Playground HTML
   */
  getPlaygroundHTML(endpoint: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>GraphQL Playground</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="https://unpkg.com/graphql-playground-react/build/static/css/index.css" />
  <link rel="shortcut icon" href="https://unpkg.com/graphql-playground-react/build/favicon.png" />
  <script src="https://unpkg.com/graphql-playground-react/build/static/js/middleware.js"></script>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    window.addEventListener('load', function (event) {
      GraphQLPlayground.init(document.getElementById('root'), {
        endpoint: '${endpoint}',
        settings: {
          'request.credentials': 'same-origin',
        },
      })
    })
  </script>
</body>
</html>
    `.trim();
  }

  /**
   * Get schema introspection result
   */
  getIntrospection(): any {
    const query = getIntrospectionQuery();
    const queryType = this.schema.getQueryType();
    if (!queryType) {
      return { data: null };
    }
    return graphqlSync({
      schema: this.schema,
      source: query,
    });
  }

  /**
   * Get schema SDL
   */
  getSchemaSDL(): string {
    return this.schemaBuilder?.getSDL() || '';
  }

  /**
   * Parse GraphQL request from HTTP request
   */
  private async parseRequest(req: HttpRequest): Promise<GraphQLRequest | null> {
    if (req.method === 'GET') {
      // GET request with query params
      const query = (req.query as any)?.query;
      const variables = (req.query as any)?.variables;
      const operationName = (req.query as any)?.operationName;

      if (!query) {
        return null;
      }

      return {
        query,
        variables: variables ? JSON.parse(variables) : undefined,
        operationName: operationName || undefined,
      };
    }

    if (req.method === 'POST') {
      // POST request with body
      const body = req.body;

      if (!body || !body.query) {
        return null;
      }

      return {
        query: body.query,
        variables: body.variables,
        operationName: body.operationName,
      };
    }

    return null;
  }

  /**
   * Create GraphQL context
   */
  private async createContext(req: HttpRequest, res: HttpResponse): Promise<GraphQLContext> {
    if (this.contextFactory) {
      return await this.contextFactory(req, res);
    }

    return this.defaultContextFactory(req, res);
  }

  /**
   * Default context factory
   */
  private defaultContextFactory(req: HttpRequest, res: HttpResponse): GraphQLContext {
    return {
      request: req,
      response: res,
      user: (req as any).user,
      auth: (req as any).auth,
      session: (req as any).session,
    };
  }

  /**
   * Check if introspection is enabled
   */
  private isIntrospectionEnabled(): boolean {
    if (this.options.enableIntrospection !== undefined) {
      return this.options.enableIntrospection;
    }

    // Enable in development by default
    return process.env.NODE_ENV !== 'production';
  }

  /**
   * Check if query is an introspection query
   */
  private isIntrospectionQuery(query: string): boolean {
    return query.includes('__schema') || query.includes('__type');
  }

  /**
   * Get schema
   */
  getSchema(): GraphQLSchema {
    return this.schema;
  }

  /**
   * Get executor
   */
  getExecutor(): GraphQLExecutor {
    return this.executor;
  }

  /**
   * Get executor stats
   */
  getStats() {
    return {
      jit: this.executor.getJITStats(),
      schema: {
        types: Object.keys(this.schema.getTypeMap()).length,
        queries: this.schema.getQueryType()
          ? Object.keys(this.schema.getQueryType()?.getFields() || {}).length
          : 0,
        mutations: this.schema.getMutationType()
          ? Object.keys(this.schema.getMutationType()?.getFields() || {}).length
          : 0,
        subscriptions: this.schema.getSubscriptionType()
          ? Object.keys(this.schema.getSubscriptionType()?.getFields() || {}).length
          : 0,
      },
    };
  }
}

/**
 * Create GraphQL core instance
 */
export function createGraphQLCore(options: GraphQLOptions): GraphQLCore {
  return new GraphQLCore(options);
}
