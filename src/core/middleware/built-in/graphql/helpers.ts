// GraphQL Helpers - Pothos integration and utilities
import { createFrameworkLogger } from '../../../logger/index.js';
import { isPackageAvailable } from '../../../utilities/package-utils.js';
import type { GraphQLSchema } from 'graphql';

const logger = createFrameworkLogger('GraphQLHelpers');

/**
 * Check if Pothos is available
 */
export function isPothosAvailable(): boolean {
  return isPackageAvailable('@pothos/core');
}

/**
 * Create Pothos schema builder instance
 * Users should use this to create their schema builder
 *
 * @example
 * ```ts
 * import { createPothosBuilder } from '@morojs/moro';
 *
 * const builder = createPothosBuilder({
 *   plugins: ['relay', 'errors'],
 * });
 *
 * builder.queryType({
 *   fields: (t) => ({
 *     hello: t.string({
 *       resolve: () => 'Hello World!'
 *     })
 *   })
 * });
 *
 * const schema = builder.toSchema();
 * ```
 */
export async function createPothosBuilder(options: any = {}): Promise<any> {
  if (!isPothosAvailable()) {
    throw new Error(
      'Pothos support requires @pothos/core to be installed.\n' +
        'Install it with: npm install @pothos/core\n' +
        'For TypeScript-first GraphQL, also consider: @pothos/plugin-relay @pothos/plugin-errors'
    );
  }

  try {
    // Use dynamic import for ESM compatibility
    const pothosModule = await import('@pothos/core');
    const SchemaBuilder = pothosModule.default;
    logger.info('Creating Pothos schema builder', 'Pothos', { plugins: options.plugins || [] });
    return new SchemaBuilder(options);
  } catch (error) {
    logger.error('Failed to create Pothos schema builder', 'Pothos', { error });
    throw error;
  }
}

/**
 * Helper to check if value is a Pothos schema
 */
export function isPothosSchema(value: any): boolean {
  return value && typeof value === 'object' && typeof value.toSchema === 'function';
}

/**
 * Extract GraphQL schema from Pothos builder
 */
export function pothosToSchema(pothosBuilder: any): GraphQLSchema {
  if (!pothosBuilder) {
    throw new Error('Pothos builder is required');
  }

  if (typeof pothosBuilder.toSchema !== 'function') {
    throw new Error('Invalid Pothos builder - missing toSchema() method');
  }

  return pothosBuilder.toSchema();
}

/**
 * GraphQL query complexity calculator
 * Helps prevent expensive queries from overloading the server
 *
 * Note: This is a basic implementation. For production use, consider
 * installing graphql-query-complexity package for full features.
 */
export function createComplexityPlugin(
  options: {
    maximumComplexity: number;
    onComplete?: (complexity: number) => void;
    estimators?: any[];
  } = { maximumComplexity: 1000 }
): any {
  logger.info('Creating query complexity plugin', 'Complexity', {
    maxComplexity: options.maximumComplexity,
  });

  return {
    name: 'complexity',
    requestDidStart: () => ({
      didResolveOperation({ document, operationName }: any) {
        // Basic complexity check - counts fields in query
        let complexity = 0;

        const visit = (node: any) => {
          if (node.kind === 'Field') {
            complexity++;
          }
          if (node.selectionSet) {
            node.selectionSet.selections.forEach(visit);
          }
        };

        if (document.definitions) {
          document.definitions.forEach((def: any) => {
            if (def.selectionSet) {
              def.selectionSet.selections.forEach(visit);
            }
          });
        }

        logger.debug('Query complexity calculated', 'Complexity', {
          operationName,
          complexity,
          maxComplexity: options.maximumComplexity,
        });

        if (options.onComplete) {
          options.onComplete(complexity);
        }

        if (complexity > options.maximumComplexity) {
          throw new Error(
            `Query complexity of ${complexity} exceeds maximum allowed complexity of ${options.maximumComplexity}`
          );
        }
      },
    }),
  };
}

/**
 * GraphQL depth limit validator
 * Prevents deeply nested queries
 *
 * Note: This is a basic implementation. For production use, consider
 * installing graphql-depth-limit package for full features.
 */
export function createDepthLimitPlugin(
  options: {
    maxDepth: number;
    callback?: (depth: number) => void;
  } = { maxDepth: 10 }
): any {
  logger.info('Creating depth limit plugin', 'DepthLimit', {
    maxDepth: options.maxDepth,
  });

  return {
    name: 'depthLimit',
    requestDidStart: () => ({
      didResolveOperation({ document, operationName }: any) {
        // Basic depth check - traverses query tree
        let maxDepthFound = 0;

        const calculateDepth = (node: any, currentDepth: number = 0): number => {
          if (!node) return currentDepth;

          let depth = currentDepth;

          if (node.kind === 'Field') {
            depth = currentDepth + 1;
            maxDepthFound = Math.max(maxDepthFound, depth);
          }

          if (node.selectionSet?.selections) {
            for (const selection of node.selectionSet.selections) {
              calculateDepth(selection, depth);
            }
          }

          return depth;
        };

        if (document.definitions) {
          document.definitions.forEach((def: any) => {
            if (def.selectionSet) {
              def.selectionSet.selections.forEach((selection: any) => {
                calculateDepth(selection, 0);
              });
            }
          });
        }

        logger.debug('Query depth calculated', 'DepthLimit', {
          operationName,
          depth: maxDepthFound,
          maxDepth: options.maxDepth,
        });

        if (options.callback) {
          options.callback(maxDepthFound);
        }

        if (maxDepthFound > options.maxDepth) {
          throw new Error(
            `Query depth of ${maxDepthFound} exceeds maximum allowed depth of ${options.maxDepth}`
          );
        }
      },
    }),
  };
}

/**
 * DataLoader helper for batching
 * Prevents N+1 query problems
 */
export async function createDataLoader<K, V>(
  batchFn: (keys: readonly K[]) => Promise<(V | Error)[]>,
  options: {
    batch?: boolean;
    maxBatchSize?: number;
    cache?: boolean;
  } = {}
): Promise<any> {
  if (!isPackageAvailable('dataloader')) {
    throw new Error(
      'DataLoader support requires dataloader package.\n' +
        'Install it with: npm install dataloader'
    );
  }

  // Use dynamic import for ESM compatibility
  const DataLoaderModule = await import('dataloader');
  const DataLoader = DataLoaderModule.default;
  return new DataLoader(batchFn, options);
}
