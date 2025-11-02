// GraphQL System - Main exports
// These are lazy-loaded to avoid crashes when graphql is not installed

export { GraphQLCore, createGraphQLCore } from './core.js';
export {
  GraphQLSchemaBuilder,
  createSchemaBuilder,
  buildGraphQLSchema,
  GraphQLTypes,
} from './schema-builder.js';
export { GraphQLExecutor, createExecutor } from './executor.js';

// Re-export types
export type * from './types.js';
