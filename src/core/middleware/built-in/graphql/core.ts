// GraphQL Core - Shared instance and utilities
import { GraphQLCore } from '../../../graphql/core.js';
import type { GraphQLOptions } from '../../../graphql/types.js';

/**
 * Shared GraphQL core instance
 */
let sharedGraphQLCore: GraphQLCore | null = null;

/**
 * Get or create shared GraphQL core
 */
export function getSharedGraphQLCore(options?: GraphQLOptions): GraphQLCore | null {
  if (options && !sharedGraphQLCore) {
    sharedGraphQLCore = new GraphQLCore(options);
  }
  return sharedGraphQLCore;
}

/**
 * Reset shared GraphQL core (for testing)
 */
export function resetSharedGraphQLCore(): void {
  sharedGraphQLCore = null;
}

// Re-export core
export { GraphQLCore };
