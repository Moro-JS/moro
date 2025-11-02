// GraphQL Types for MoroJS
import type { HttpRequest, HttpResponse } from '../../types/http.js';

import type {
  GraphQLSchema,
  GraphQLFieldResolver,
  GraphQLTypeResolver,
  GraphQLError,
} from 'graphql';

/**
 * GraphQL context that's passed to all resolvers
 */
export interface GraphQLContext {
  request: HttpRequest;
  response: HttpResponse;
  user?: any;
  auth?: any;
  session?: any;
  [key: string]: any;
}

/**
 * GraphQL resolver function signature
 */
export type GraphQLResolver<
  TSource = any,
  TArgs = any,
  TContext = GraphQLContext,
  TResult = any,
> = GraphQLFieldResolver<TSource, TContext, TArgs, TResult>;

/**
 * GraphQL subscription resolver
 */
export interface GraphQLSubscriptionResolver<
  TSource = any,
  TArgs = any,
  TContext = GraphQLContext,
> {
  subscribe: GraphQLFieldResolver<TSource, TContext, TArgs>;
  resolve?: GraphQLFieldResolver<TSource, TContext, TArgs>;
}

/**
 * GraphQL schema builder options
 */
export interface GraphQLSchemaBuilderOptions {
  typeDefs?: string | string[];
  resolvers?: GraphQLResolvers;
  schema?: GraphQLSchema;
  context?: (req: HttpRequest, res: HttpResponse) => GraphQLContext | Promise<GraphQLContext>;
  formatError?: (error: GraphQLError) => any;
  validationRules?: any[];
  extensions?: any[];
}

/**
 * GraphQL resolvers map
 */
export interface GraphQLResolvers {
  Query?: Record<string, GraphQLResolver>;
  Mutation?: Record<string, GraphQLResolver>;
  Subscription?: Record<string, GraphQLSubscriptionResolver>;
  [key: string]: any;
}

/**
 * GraphQL execution options
 */
export interface GraphQLExecutionOptions {
  schema: GraphQLSchema;
  query: string;
  variables?: Record<string, any>;
  operationName?: string;
  context?: GraphQLContext;
  rootValue?: any;
  fieldResolver?: GraphQLFieldResolver<any, any>;
  typeResolver?: GraphQLTypeResolver<any, any>;
  subscriptionFieldResolver?: GraphQLFieldResolver<any, any>;
}

/**
 * GraphQL configuration options
 */
export interface GraphQLOptions {
  // Adapter
  adapter?: any; // GraphQLAdapter - using any to avoid circular dependency

  // Schema definition
  schema?: any; // GraphQLSchema
  typeDefs?: string | string[];
  resolvers?: GraphQLResolvers;
  pothosSchema?: any; // PothosSchemaTypes.ExtendDefaultTypes

  // Context
  context?: (req: HttpRequest, res: HttpResponse) => GraphQLContext | Promise<GraphQLContext>;

  // Endpoints
  path?: string; // Default: '/graphql'
  playgroundPath?: string; // Default: '/graphql/playground'
  enablePlayground?: boolean; // Default: true in development

  // Performance
  enableJIT?: boolean; // Enable GraphQL-JIT compilation (default: true)
  jitCacheTTL?: number; // JIT cache TTL in ms (default: 3600000 - 1 hour)

  // Features
  enableIntrospection?: boolean; // Default: true in development
  enableSubscriptions?: boolean; // Default: true if WebSocket enabled
  enableBatching?: boolean; // Enable query batching

  // Error handling
  formatError?: (error: GraphQLError) => any;
  debug?: boolean; // Include stack traces in errors

  // Validation & security
  validationRules?: any[];
  maxDepth?: number; // Query depth limit
  maxComplexity?: number; // Query complexity limit

  // Rate limiting (per operation)
  rateLimit?: {
    queries?: { requests: number; window: number };
    mutations?: { requests: number; window: number };
    subscriptions?: { requests: number; window: number };
  };

  // Caching
  enableCache?: boolean;
  cacheAdapter?: any;
  cacheTTL?: number;

  // Authentication
  requireAuth?: boolean; // Require auth for all operations
  authScopes?: string[]; // Required scopes

  // Extensions
  extensions?: any[];
  plugins?: GraphQLPlugin[];

  // Advanced
  rootValue?: any;
  fieldResolver?: GraphQLFieldResolver<any, any>;
  typeResolver?: GraphQLTypeResolver<any, any>;
  parseOptions?: any;
  validationTypeInfo?: any;
}

/**
 * GraphQL plugin interface
 */
export interface GraphQLPlugin {
  name: string;
  requestDidStart?: (context: GraphQLRequestContext) => GraphQLRequestListener | void;
}

/**
 * GraphQL request context
 */
export interface GraphQLRequestContext {
  request: GraphQLRequest;
  response?: GraphQLResponse;
  context: GraphQLContext;
  schema: GraphQLSchema;
  operation?: any;
  operationName?: string | null;
  document?: any;
  metrics?: GraphQLMetrics;
}

/**
 * GraphQL request listener (for plugins)
 */
export interface GraphQLRequestListener {
  parsingDidStart?: () => void;
  validationDidStart?: () => void;
  executionDidStart?: () => void;
  didEncounterErrors?: (errors: readonly GraphQLError[]) => void;
  willSendResponse?: (context: GraphQLRequestContext) => void;
}

/**
 * GraphQL request
 */
export interface GraphQLRequest {
  query: string;
  variables?: Record<string, any>;
  operationName?: string | null;
  extensions?: Record<string, any>;
}

/**
 * GraphQL response
 */
export interface GraphQLResponse {
  data?: any;
  errors?: readonly GraphQLError[];
  extensions?: Record<string, any>;
}

/**
 * GraphQL execution metrics
 */
export interface GraphQLMetrics {
  startTime: number;
  endTime?: number;
  duration?: number;
  parsing?: number;
  validation?: number;
  execution?: number;
  fieldResolution?: Record<string, number>;
}

/**
 * GraphQL subscription options
 */
export interface GraphQLSubscriptionOptions {
  onConnect?: (connectionParams: any, websocket: any, context: any) => any | Promise<any>;
  onDisconnect?: (websocket: any, context: any) => void | Promise<void>;
  keepAlive?: number;
}

/**
 * GraphQL DataLoader options
 */
export interface DataLoaderOptions<K, V> {
  batch?: boolean;
  maxBatchSize?: number;
  cache?: boolean;
  cacheKeyFn?: (key: K) => any;
  cacheMap?: Map<any, Promise<V>>;
}

/**
 * GraphQL field complexity calculator
 */
export type ComplexityEstimator = (options: {
  type: any;
  field: any;
  args: Record<string, any>;
  childComplexity: number;
}) => number;

/**
 * GraphQL query complexity options
 */
export interface QueryComplexityOptions {
  maximumComplexity: number;
  variables?: Record<string, any>;
  onComplete?: (complexity: number) => void;
  estimators?: ComplexityEstimator[];
}

/**
 * GraphQL depth limit options
 */
export interface DepthLimitOptions {
  maxDepth: number;
  callback?: (obj: any) => void;
}
