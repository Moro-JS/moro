// GraphQL Core - Adapter-based GraphQL system
import { createFrameworkLogger } from '../logger/index.js';
import { GraphQLJsAdapter } from './adapters/graphql-js-adapter.js';
import type { GraphQLAdapter, GraphQLRequest } from './adapter.js';
import type { HttpRequest, HttpResponse } from '../../types/http.js';
import type { GraphQLOptions, GraphQLContext } from './types.js';

const logger = createFrameworkLogger('GraphQL');

/**
 * GraphQL Core - Manages GraphQL adapter and handles HTTP requests
 */
export class GraphQLCore {
  private adapter!: GraphQLAdapter;
  private options: GraphQLOptions;
  private contextFactory?: (
    req: HttpRequest,
    res: HttpResponse
  ) => GraphQLContext | Promise<GraphQLContext>;

  constructor(options: GraphQLOptions) {
    this.options = options;
    this.contextFactory = options.context;
  }

  /**
   * Initialize GraphQL system with adapter
   */
  async initialize(): Promise<void> {
    logger.info('Initializing GraphQL system', 'Initialization');

    // Create adapter (default to GraphQL.js)
    this.adapter = this.options.adapter || new GraphQLJsAdapter();

    // Initialize adapter
    await this.adapter.initialize(this.options);

    logger.info('GraphQL system initialized successfully', 'Initialization');
  }

  /**
   * Handle HTTP request for GraphQL endpoint
   */
  async handleRequest(req: HttpRequest, res: HttpResponse): Promise<void> {
    // Parse request
    const graphqlRequest = await this.parseRequest(req);
    if (!graphqlRequest) {
      res.status(400).json({ errors: [{ message: 'Invalid GraphQL request' }] });
      return;
    }

    // Build context
    const baseContext: GraphQLContext = {
      request: req,
      response: res,
    };

    const context = this.contextFactory ? await this.contextFactory(req, res) : baseContext;

    // Merge contexts
    graphqlRequest.context = { ...baseContext, ...context };

    // Check introspection
    if (
      this.options.enableIntrospection === false &&
      this.isIntrospectionQuery(graphqlRequest.query)
    ) {
      res.status(400).json({
        errors: [{ message: 'GraphQL introspection is disabled' }],
      });
      return;
    }

    // Execute query
    const result = await this.adapter.execute(graphqlRequest);

    // Send response
    res.status(200).json(result);
  }

  /**
   * Get GraphQL Playground HTML
   */
  getPlaygroundHTML(): string {
    const path = this.options.path || '/graphql';
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>GraphQL Playground</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/graphiql@2/graphiql.min.css" />
</head>
<body style="margin: 0;">
  <div id="graphiql" style="height: 100vh;"></div>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/graphiql@2/graphiql.min.js"></script>
  <script>
    const fetcher = GraphiQL.createFetcher({ url: '${path}' });
    const root = ReactDOM.createRoot(document.getElementById('graphiql'));
    root.render(React.createElement(GraphiQL, { fetcher: fetcher }));
  </script>
</body>
</html>
    `.trim();
  }

  /**
   * Get schema introspection
   */
  getIntrospection(): any {
    return this.adapter.getIntrospection();
  }

  /**
   * Get schema SDL
   */
  getSchemaSDL(): string {
    return this.adapter.getSchemaSDL();
  }

  /**
   * Get schema
   */
  getSchema(): any {
    return this.adapter.getSchema();
  }

  /**
   * Get adapter
   */
  getAdapter(): GraphQLAdapter {
    return this.adapter;
  }

  /**
   * Get statistics
   */
  getStats() {
    return this.adapter.getStats();
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    await this.adapter.cleanup();
  }

  /**
   * Parse GraphQL request from HTTP request
   */
  private async parseRequest(req: HttpRequest): Promise<GraphQLRequest | null> {
    if (req.method === 'GET') {
      const query = (req.query as any)?.query;
      const variables = (req.query as any)?.variables;
      const operationName = (req.query as any)?.operationName;

      if (!query) return null;

      return {
        query,
        variables: variables ? JSON.parse(variables) : undefined,
        operationName,
        context: {} as GraphQLContext,
      };
    }

    if (req.method === 'POST') {
      const body = req.body as any;
      if (!body || !body.query) return null;

      return {
        query: body.query,
        variables: body.variables,
        operationName: body.operationName,
        context: {} as GraphQLContext,
      };
    }

    return null;
  }

  /**
   * Check if query is introspection
   */
  private isIntrospectionQuery(query: string): boolean {
    return query.includes('__schema') || query.includes('__type');
  }
}

/**
 * Create GraphQL core instance
 */
export function createGraphQLCore(options: GraphQLOptions): GraphQLCore {
  return new GraphQLCore(options);
}
