// GraphQL Executor with JIT support
import {
  execute,
  subscribe,
  parse,
  validate,
  GraphQLError,
  GraphQLSchema,
  ExecutionResult,
  DocumentNode,
} from 'graphql';
import { createFrameworkLogger } from '../logger/index.js';
import { isPackageAvailable } from '../utilities/package-utils.js';
import type { GraphQLContext, GraphQLMetrics } from './types.js';

const logger = createFrameworkLogger('GraphQLExecutor');

/**
 * GraphQL executor with JIT compilation support
 */
export class GraphQLExecutor {
  private jitEnabled = false;
  private jitCompiler: any = null;
  private jitCache = new Map<string, any>();
  private jitCacheTTL: number;
  private jitCacheTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    private schema: GraphQLSchema,
    options: {
      enableJIT?: boolean;
      jitCacheTTL?: number;
    } = {}
  ) {
    this.jitCacheTTL = options.jitCacheTTL || 3600000; // 1 hour default

    if (options.enableJIT !== false) {
      this.initializeJIT();
    }
  }

  /**
   * Initialize GraphQL-JIT if available
   */
  private initializeJIT(): void {
    if (!isPackageAvailable('graphql-jit')) {
      logger.debug(
        'graphql-jit not available, using standard execution. Install for 5-10x performance boost.',
        'JIT'
      );
      return;
    }

    try {
      // Use dynamic import for ESM compatibility
      import('graphql-jit')
        .then(jitModule => {
          const { compileQuery, isCompiledQuery } = jitModule;
          this.jitCompiler = { compileQuery, isCompiledQuery };
          this.jitEnabled = true;
          logger.info('GraphQL-JIT enabled for optimized query execution', 'JIT');
        })
        .catch(error => {
          logger.warn('Failed to initialize GraphQL-JIT', 'JIT', { error });
        });
    } catch (error) {
      logger.warn('Failed to initialize GraphQL-JIT', 'JIT', { error });
    }
  }

  /**
   * Execute a GraphQL query
   */
  async executeQuery(
    query: string,
    variables?: Record<string, any>,
    context?: GraphQLContext,
    operationName?: string,
    rootValue?: any
  ): Promise<ExecutionResult & { metrics?: GraphQLMetrics }> {
    const metrics: GraphQLMetrics = {
      startTime: Date.now(),
    };

    try {
      // Parse query
      const parseStart = Date.now();
      const document = parse(query);
      metrics.parsing = Date.now() - parseStart;

      // Validate query
      const validationStart = Date.now();
      const validationErrors = validate(this.schema, document);
      metrics.validation = Date.now() - validationStart;

      if (validationErrors.length > 0) {
        metrics.endTime = Date.now();
        metrics.duration = metrics.endTime - metrics.startTime;
        return {
          errors: validationErrors,
          metrics,
        };
      }

      // Execute query (with or without JIT)
      const executionStart = Date.now();
      let result: ExecutionResult;

      if (this.jitEnabled && this.jitCompiler) {
        result = await this.executeWithJIT(document, variables, context, operationName, rootValue);
      } else {
        result = await this.executeStandard(document, variables, context, operationName, rootValue);
      }

      metrics.execution = Date.now() - executionStart;
      metrics.endTime = Date.now();
      metrics.duration = metrics.endTime - metrics.startTime;

      return {
        ...result,
        metrics,
      };
    } catch (error) {
      metrics.endTime = Date.now();
      metrics.duration = metrics.endTime - metrics.startTime;

      logger.error('GraphQL execution error', 'Execution', { error });

      return {
        errors: [
          error instanceof GraphQLError
            ? error
            : new GraphQLError(error instanceof Error ? error.message : String(error)),
        ],
        metrics,
      };
    }
  }

  /**
   * Execute with JIT compilation
   */
  private async executeWithJIT(
    document: DocumentNode,
    variables?: Record<string, any>,
    context?: GraphQLContext,
    operationName?: string,
    rootValue?: any
  ): Promise<ExecutionResult> {
    const cacheKey = this.getCacheKey(document, operationName);

    // Check cache
    let compiled = this.jitCache.get(cacheKey);

    if (!compiled) {
      // Compile query
      compiled = this.jitCompiler.compileQuery(this.schema, document, operationName || undefined);

      if (this.jitCompiler.isCompiledQuery(compiled)) {
        // Cache compiled query with TTL
        this.jitCache.set(cacheKey, compiled);

        // Clear any existing timeout for this key
        const existingTimeout = this.jitCacheTimeouts.get(cacheKey);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
        }

        // Set new timeout and store reference
        const timeout = setTimeout(() => {
          this.jitCache.delete(cacheKey);
          this.jitCacheTimeouts.delete(cacheKey);
        }, this.jitCacheTTL);

        this.jitCacheTimeouts.set(cacheKey, timeout);

        logger.debug('Query compiled and cached with JIT', 'JIT', {
          operationName,
          cacheSize: this.jitCache.size,
        });
      } else {
        // Compilation failed, return errors
        return compiled as ExecutionResult;
      }
    }

    // Execute compiled query
    return await compiled.query(rootValue, context, variables || {});
  }

  /**
   * Execute with standard GraphQL execution
   */
  private async executeStandard(
    document: DocumentNode,
    variables?: Record<string, any>,
    context?: GraphQLContext,
    operationName?: string,
    rootValue?: any
  ): Promise<ExecutionResult> {
    return await execute({
      schema: this.schema,
      document,
      rootValue,
      contextValue: context,
      variableValues: variables,
      operationName: operationName || undefined,
    });
  }

  /**
   * Subscribe to a GraphQL subscription
   */
  async executeSubscription(
    query: string,
    variables?: Record<string, any>,
    context?: GraphQLContext,
    operationName?: string,
    rootValue?: any
  ): Promise<AsyncIterableIterator<ExecutionResult> | ExecutionResult> {
    try {
      const document = parse(query);
      const validationErrors = validate(this.schema, document);

      if (validationErrors.length > 0) {
        return {
          errors: validationErrors,
        };
      }

      return await subscribe({
        schema: this.schema,
        document,
        rootValue,
        contextValue: context,
        variableValues: variables,
        operationName: operationName || undefined,
      });
    } catch (error) {
      logger.error('GraphQL subscription error', 'Subscription', { error });

      return {
        errors: [
          error instanceof GraphQLError
            ? error
            : new GraphQLError(error instanceof Error ? error.message : String(error)),
        ],
      };
    }
  }

  /**
   * Clear JIT cache and all pending timeouts
   */
  clearJITCache(): void {
    // Clear all pending timeouts
    for (const timeout of this.jitCacheTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.jitCacheTimeouts.clear();
    this.jitCache.clear();
    logger.debug('JIT cache cleared', 'JIT');
  }

  /**
   * Cleanup method to clear all resources
   * Should be called when executor is no longer needed
   */
  cleanup(): void {
    this.clearJITCache();
  }

  /**
   * Get JIT cache stats
   */
  getJITStats(): { enabled: boolean; cacheSize: number } {
    return {
      enabled: this.jitEnabled,
      cacheSize: this.jitCache.size,
    };
  }

  /**
   * Generate cache key for query
   */
  private getCacheKey(document: DocumentNode, operationName?: string): string {
    // Use document AST as cache key (simplified)
    return `${JSON.stringify(document)}:${operationName || 'default'}`;
  }
}

/**
 * Create GraphQL executor
 */
export function createExecutor(
  schema: GraphQLSchema,
  options?: {
    enableJIT?: boolean;
    jitCacheTTL?: number;
  }
): GraphQLExecutor {
  return new GraphQLExecutor(schema, options);
}
