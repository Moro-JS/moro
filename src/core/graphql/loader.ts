// GraphQL Dynamic Loader - Lazy loads graphql package
import { resolveUserPackage } from '../utilities/package-utils.js';

let graphqlModule: any = null;

/**
 * Dynamically load graphql package from user's node_modules
 * This ensures graphql is only required when actually used
 */
export async function loadGraphQL() {
  if (graphqlModule) {
    return graphqlModule;
  }

  try {
    const graphqlPath = resolveUserPackage('graphql');
    graphqlModule = await import(graphqlPath);
    return graphqlModule;
  } catch {
    throw new Error(
      'GraphQL package not found. Install it with: npm install graphql\n' +
        'For TypeScript-first GraphQL: npm install @pothos/core\n' +
        'For performance boost: npm install graphql-jit'
    );
  }
}

/**
 * Get cached graphql module (must call loadGraphQL first)
 */
export function getGraphQL() {
  if (!graphqlModule) {
    throw new Error('GraphQL not loaded. Call loadGraphQL() first.');
  }
  return graphqlModule;
}
