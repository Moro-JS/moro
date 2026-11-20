// GraphQL Core - Adapter-based GraphQL system
import { createFrameworkLogger } from '../logger/index.js';
import { GraphQLJsAdapter } from './adapters/graphql-js-adapter.js';
import type { GraphQLAdapter, GraphQLRequest } from './adapter.js';
import type { HttpRequest, HttpResponse } from '../../types/http.js';
import type { GraphQLOptions, GraphQLContext } from './types.js';
import { toScriptLiteral } from '../docs/html-escape.js';

const logger = createFrameworkLogger('GraphQL');

/**
 * The files the playground page loads from the CDN: exact versions, each with
 * the digest of the published file, so a browser refuses anything else that is
 * served under the same address.
 *
 * @internal Exported for unit testing; not part of the public API.
 */
export const PLAYGROUND_ASSETS = {
  graphiqlCss: {
    url: 'https://unpkg.com/graphiql@2.4.7/graphiql.min.css',
    integrity: 'sha384-486GcFFVcFN0yj7LIp/vn7DVsuf2CTytJlNuqjHg0zF2g72zra2gWCNV2HBxJgC6',
  },
  react: {
    url: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
    integrity: 'sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z',
  },
  reactDom: {
    url: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
    integrity: 'sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1',
  },
  graphiqlJs: {
    url: 'https://unpkg.com/graphiql@2.4.7/graphiql.min.js',
    integrity: 'sha384-8da92RVD56z/pbOOnJ4Ud5qlhqEzDtJI6qVZjN88SCbOatpo4xVDeP3T0nmfTf+9',
  },
} as const;

/**
 * GraphQL Core - Manages GraphQL adapter and handles HTTP requests
 */
export class GraphQLCore {
  private adapter!: GraphQLAdapter;
  private options: GraphQLOptions;
  private contextFactory?:
    ((req: HttpRequest, res: HttpResponse) => GraphQLContext | Promise<GraphQLContext>) | undefined;

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

    // Only queries may be executed from a GET request. A mutation reachable
    // from a URL can be triggered by a link, an image tag or a cross-site
    // navigation carrying the user's cookies.
    if (req.method === 'GET' && this.isNonQueryOperation(graphqlRequest)) {
      const response = res as any;
      if (typeof response.setHeader === 'function') {
        response.setHeader('Allow', 'POST');
      }
      res.status(405).json({
        errors: [{ message: 'GraphQL mutations and subscriptions must be sent with POST' }],
      });
      return;
    }

    // Build context
    if (this.contextFactory) {
      const customContext = await this.contextFactory(req, res);
      // Ensure request/response are present without mutating original (only add if missing)
      if (customContext.request && customContext.response) {
        graphqlRequest.context = customContext;
      } else {
        graphqlRequest.context = customContext;
        graphqlRequest.context.request = req;
        graphqlRequest.context.response = res;
      }
    } else {
      graphqlRequest.context = {
        request: req,
        response: res,
      };
    }

    // Check introspection: on by default except in production; an explicit
    // `enableIntrospection` always wins.
    const introspectionEnabled =
      typeof this.options.enableIntrospection === 'boolean'
        ? this.options.enableIntrospection
        : process.env.NODE_ENV !== 'production';
    if (!introspectionEnabled && this.isIntrospectionQuery(graphqlRequest.query)) {
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
    const assets = PLAYGROUND_ASSETS;
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>GraphQL Playground</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${assets.graphiqlCss.url}" integrity="${assets.graphiqlCss.integrity}" crossorigin="anonymous" />
</head>
<body style="margin: 0;">
  <div id="graphiql" style="height: 100vh;"></div>
  <script src="${assets.react.url}" integrity="${assets.react.integrity}" crossorigin="anonymous"></script>
  <script src="${assets.reactDom.url}" integrity="${assets.reactDom.integrity}" crossorigin="anonymous"></script>
  <script src="${assets.graphiqlJs.url}" integrity="${assets.graphiqlJs.integrity}" crossorigin="anonymous"></script>
  <script>
    const fetcher = GraphiQL.createFetcher({ url: ${toScriptLiteral(path)} });
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

      // Avoid JSON.parse if already an object or undefined
      let parsedVariables = undefined;
      if (variables) {
        if (typeof variables === 'string') {
          try {
            parsedVariables = JSON.parse(variables);
          } catch {
            return null;
          }
        } else {
          parsedVariables = variables;
        }
      }

      return {
        query,
        variables: parsedVariables,
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

  /**
   * True when the request would execute a mutation or subscription.
   *
   * When the selected operation cannot be determined (several operations and
   * no matching `operationName`) the request cannot execute successfully
   * anyway, so it is treated as non-query if the document contains any
   * mutation or subscription.
   */
  private isNonQueryOperation(request: GraphQLRequest): boolean {
    if (typeof request.query !== 'string') return false;
    const operations = listGraphQLOperations(request.query);
    if (!operations) return false; // malformed document: the adapter rejects it

    const operationName =
      typeof request.operationName === 'string' && request.operationName
        ? request.operationName
        : undefined;
    const selected = operationName
      ? operations.find(operation => operation.name === operationName)
      : operations.length === 1
        ? operations[0]
        : undefined;

    if (selected) return selected.type !== 'query';
    return operations.some(operation => operation.type !== 'query');
  }
}

/**
 * An operation definition found in a GraphQL document.
 */
export interface GraphQLOperationInfo {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
}

/**
 * List the operation definitions of a GraphQL document without executing or
 * validating it. Follows the GraphQL lexical grammar (comments, strings, block
 * strings, punctuators, names) so that keywords inside strings, comments,
 * arguments or selection sets are never mistaken for an operation.
 *
 * Returns `null` when the document is lexically malformed (unterminated
 * string or unbalanced braces); such a document cannot be executed.
 *
 * @internal Exported for unit testing; not part of the public API.
 */
export function listGraphQLOperations(source: string): GraphQLOperationInfo[] | null {
  const operations: GraphQLOperationInfo[] = [];
  const length = source.length;
  let braces = 0;
  let parens = 0;
  // At the top level, waiting for the first token of a definition
  let expectDefinition = true;
  // The previous token was an operation keyword; a name here is its name
  let pending: GraphQLOperationInfo | null = null;
  let i = 0;

  while (i < length) {
    const code = source.charCodeAt(i);

    // Ignored tokens: whitespace, line terminators, commas, BOM
    if (
      code === 0x20 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x2c ||
      code === 0xfeff
    ) {
      i++;
      continue;
    }

    // Comment: runs to the end of the line
    if (code === 0x23) {
      while (i < length && source.charCodeAt(i) !== 0x0a && source.charCodeAt(i) !== 0x0d) i++;
      continue;
    }

    // Strings
    if (code === 0x22) {
      if (source.startsWith('"""', i)) {
        i += 3;
        let closed = false;
        while (i < length) {
          if (source.startsWith('\\"""', i)) {
            i += 4;
          } else if (source.startsWith('"""', i)) {
            i += 3;
            closed = true;
            break;
          } else {
            i++;
          }
        }
        if (!closed) return null;
      } else {
        i++;
        let closed = false;
        while (i < length) {
          const ch = source.charCodeAt(i);
          if (ch === 0x0a || ch === 0x0d) return null;
          if (ch === 0x5c) {
            i += 2;
          } else if (ch === 0x22) {
            i++;
            closed = true;
            break;
          } else {
            i++;
          }
        }
        if (!closed) return null;
      }
      // A string before a definition is its description: the definition
      // keyword is still to come, so `expectDefinition` is left untouched.
      pending = null;
      continue;
    }

    // Names
    if (isNameStart(code)) {
      const start = i;
      i++;
      while (i < length && isNameContinue(source.charCodeAt(i))) i++;
      if (braces === 0 && parens === 0) {
        const name = source.slice(start, i);
        if (pending) {
          pending.name = name;
          pending = null;
        } else if (expectDefinition) {
          if (name === 'query' || name === 'mutation' || name === 'subscription') {
            pending = { type: name };
            operations.push(pending);
          }
        }
        expectDefinition = false;
      }
      continue;
    }

    // Punctuators
    if (code === 0x7b) {
      // '{'
      if (braces === 0 && parens === 0 && expectDefinition) {
        operations.push({ type: 'query' }); // shorthand query
      }
      braces++;
      expectDefinition = false;
    } else if (code === 0x7d) {
      // '}'
      braces--;
      if (braces < 0) return null;
      if (braces === 0 && parens === 0) expectDefinition = true;
    } else if (code === 0x28) {
      parens++;
    } else if (code === 0x29) {
      parens--;
      if (parens < 0) return null;
    }
    pending = null;
    i++;
  }

  if (braces !== 0 || parens !== 0) return null;
  return operations;
}

function isNameStart(code: number): boolean {
  return (
    code === 0x5f || // _
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) // a-z
  );
}

function isNameContinue(code: number): boolean {
  return isNameStart(code) || (code >= 0x30 && code <= 0x39);
}

/**
 * Create GraphQL core instance
 */
export function createGraphQLCore(options: GraphQLOptions): GraphQLCore {
  return new GraphQLCore(options);
}
