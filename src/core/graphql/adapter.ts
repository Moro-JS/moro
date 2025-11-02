// GraphQL Adapter Interface
import type { GraphQLOptions, GraphQLContext } from './types.js';

/**
 * GraphQL adapter interface
 * Adapters handle schema building, query execution, and introspection
 */
export interface GraphQLAdapter {
  /**
   * Initialize the adapter with schema and options
   */
  initialize(options: GraphQLOptions): Promise<void>;

  /**
   * Execute a GraphQL query/mutation
   */
  execute(request: GraphQLRequest): Promise<GraphQLResponse>;

  /**
   * Get schema introspection data
   */
  getIntrospection(): any;

  /**
   * Get schema SDL (Schema Definition Language)
   */
  getSchemaSDL(): string;

  /**
   * Get the underlying schema object
   */
  getSchema(): any;

  /**
   * Get adapter statistics
   */
  getStats(): GraphQLStats;

  /**
   * Cleanup resources
   */
  cleanup(): Promise<void>;
}

/**
 * GraphQL request
 */
export interface GraphQLRequest {
  query: string;
  variables?: Record<string, any>;
  operationName?: string;
  context: GraphQLContext;
}

/**
 * GraphQL response
 */
export interface GraphQLResponse {
  data?: any;
  errors?: any[];
  extensions?: Record<string, any>;
}

/**
 * GraphQL adapter statistics
 */
export interface GraphQLStats {
  schema: {
    queries: number;
    mutations: number;
    subscriptions: number;
    types: number;
  };
  jit?: {
    enabled: boolean;
    cacheSize: number;
  };
}

/**
 * GraphQL adapter options
 * Can be extended by specific adapter implementations
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GraphQLAdapterOptions extends GraphQLOptions {}
