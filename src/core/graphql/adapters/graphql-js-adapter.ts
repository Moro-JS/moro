// GraphQL.js Adapter - Default adapter using graphql-js
import { createHash } from 'crypto';
import { resolveUserPackage } from '../../utilities/package-utils.js';
import { createFrameworkLogger } from '../../logger/index.js';
import type {
  GraphQLAdapter,
  GraphQLRequest,
  GraphQLResponse,
  GraphQLStats,
  GraphQLAdapterOptions,
} from '../adapter.js';
import type { GraphQLOptions, GraphQLContext } from '../types.js';
import type { HttpRequest, HttpResponse } from '../../../types/http.js';
import { checkQueryLimits, normalizeQueryLimit } from '../limits.js';

const logger = createFrameworkLogger('GraphQLAdapter');

/** Default cap on the number of compiled queries kept in the JIT cache. */
const DEFAULT_JIT_CACHE_MAX_SIZE = 1000;

/**
 * GraphQL.js adapter implementation
 * Uses the official graphql-js library with optional JIT compilation
 */
export class GraphQLJsAdapter implements GraphQLAdapter {
  private schema: any;
  private graphql: any;
  private jitEnabled = false;
  private jitCompiler: any = null;
  private jitCache = new Map<string, any>();
  private jitCacheTTL = 300000; // 5 minutes default
  private jitCacheTimeouts = new Map<string, NodeJS.Timeout>();
  private jitCacheMaxSize = DEFAULT_JIT_CACHE_MAX_SIZE;
  private debug = false;
  private maxDepth: number | undefined;
  private maxComplexity: number | undefined;
  private rootValue: unknown = null;
  private contextFactory?: (
    req: HttpRequest,
    res: HttpResponse
  ) => GraphQLContext | Promise<GraphQLContext>;

  async initialize(options: GraphQLAdapterOptions): Promise<void> {
    try {
      // Dynamically load graphql from user's node_modules
      const graphqlPath = resolveUserPackage('graphql');
      this.graphql = await import(graphqlPath);

      logger.info('GraphQL.js adapter loaded', 'Adapter');

      // Build schema
      await this.buildSchema(options);

      // Initialize JIT if enabled
      if (options.enableJIT !== false) {
        await this.initializeJIT(options);
      }

      // Store context factory
      if (options.context) {
        this.contextFactory = options.context;
      }

      this.jitCacheTTL = options.jitCacheTTL || 300000; // 5 minutes default
      if (
        typeof options.jitCacheMaxSize === 'number' &&
        Number.isFinite(options.jitCacheMaxSize) &&
        options.jitCacheMaxSize >= 1
      ) {
        this.jitCacheMaxSize = Math.floor(options.jitCacheMaxSize);
      }
      this.debug = options.debug === true;
      this.maxDepth = normalizeQueryLimit(options.maxDepth);
      this.maxComplexity = normalizeQueryLimit(options.maxComplexity);
      this.rootValue = options.rootValue === undefined ? null : options.rootValue;

      logger.info('GraphQL.js adapter initialized', 'Adapter', {
        jitEnabled: this.jitEnabled,
      });
    } catch (error) {
      logger.error('Failed to initialize GraphQL.js adapter', 'Adapter', { error });
      throw new Error(
        'GraphQL.js adapter initialization failed.\n' +
          'Install graphql with: npm install graphql\n' +
          `Error: ${error}`
      );
    }
  }

  async execute(request: GraphQLRequest): Promise<GraphQLResponse> {
    const { query, variables, operationName, context } = request;

    try {
      // Parse query
      const { parse, validate } = this.graphql;
      const document = parse(query);

      // Depth and complexity limits are checked first, in one walk of the
      // document: one over a limit is refused before the costlier standard
      // rules and never reaches execution.
      if (this.maxDepth !== undefined || this.maxComplexity !== undefined) {
        const limitErrors = checkQueryLimits(
          document,
          this.graphql.GraphQLError,
          { maxDepth: this.maxDepth, maxComplexity: this.maxComplexity },
          operationName
        );
        if (limitErrors.length > 0) {
          return { errors: limitErrors };
        }
      }

      // Validate query
      const errors = validate(this.schema, document);
      if (errors.length > 0) {
        return { errors };
      }

      // Execute with JIT if enabled
      if (this.jitEnabled && this.jitCompiler) {
        return await this.executeWithJIT(query, document, operationName, variables, context);
      }

      // Standard execution
      const { execute } = this.graphql;
      return await execute({
        schema: this.schema,
        document,
        rootValue: this.rootValue,
        contextValue: context,
        variableValues: variables,
        operationName,
      });
    } catch (error) {
      logger.error('GraphQL execution error', 'Execution', { error });
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Stack traces carry absolute module paths: only attach them when the
      // `debug` option was set, and never in production.
      if (this.debug && process.env.NODE_ENV !== 'production') {
        return {
          errors: [
            {
              message,
              extensions: { stack: error instanceof Error ? error.stack : undefined },
            },
          ],
        };
      }
      return { errors: [{ message }] };
    }
  }

  getIntrospection(): any {
    const { getIntrospectionQuery, graphqlSync } = this.graphql;
    const query = getIntrospectionQuery();
    return graphqlSync({
      schema: this.schema,
      source: query,
    });
  }

  getSchemaSDL(): string {
    const { printSchema } = this.graphql;
    return printSchema(this.schema);
  }

  getSchema(): any {
    return this.schema;
  }

  getStats(): GraphQLStats {
    const typeMap = this.schema.getTypeMap();
    const queryType = this.schema.getQueryType();
    const mutationType = this.schema.getMutationType();
    const subscriptionType = this.schema.getSubscriptionType();

    return {
      schema: {
        queries: queryType ? Object.keys(queryType.getFields() || {}).length : 0,
        mutations: mutationType ? Object.keys(mutationType.getFields() || {}).length : 0,
        subscriptions: subscriptionType
          ? Object.keys(subscriptionType.getFields() || {}).length
          : 0,
        types: Object.keys(typeMap).length,
      },
      jit: this.jitEnabled
        ? {
            enabled: true,
            cacheSize: this.jitCache.size,
          }
        : { enabled: false, cacheSize: 0 },
    };
  }

  async cleanup(): Promise<void> {
    // Clear JIT cache and timeouts
    for (const timeout of this.jitCacheTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.jitCacheTimeouts.clear();
    this.jitCache.clear();
    logger.info('GraphQL.js adapter cleaned up', 'Adapter');
  }

  private async buildSchema(options: GraphQLOptions): Promise<void> {
    if (options.schema) {
      this.schema = options.schema;
      return;
    }

    if (options.typeDefs) {
      const { buildSchema } = this.graphql;
      const typeDefs = Array.isArray(options.typeDefs)
        ? options.typeDefs.join('\n\n')
        : options.typeDefs;
      this.schema = buildSchema(typeDefs);

      // Apply resolvers
      if (options.resolvers) {
        this.applyResolvers(options.resolvers);
      }
      return;
    }

    if (options.pothosSchema) {
      // Handle Pothos schema
      if (typeof options.pothosSchema.toSchema === 'function') {
        this.schema = options.pothosSchema.toSchema();
      } else {
        this.schema = options.pothosSchema;
      }
      return;
    }

    throw new Error('No schema provided');
  }

  private applyResolvers(resolvers: any): void {
    const typeMap = this.schema.getTypeMap();

    for (const [typeName, typeResolvers] of Object.entries(resolvers)) {
      const type = typeMap[typeName];
      if (!type || !('getFields' in type)) continue;

      const fields = (type as any).getFields();
      for (const [fieldName, resolver] of Object.entries(typeResolvers as Record<string, any>)) {
        const field = fields[fieldName];
        if (!field) continue;

        if (typeof resolver === 'function') {
          field.resolve = resolver;
        } else if (resolver && typeof resolver === 'object' && 'subscribe' in resolver) {
          field.subscribe = resolver.subscribe;
          if (resolver.resolve) {
            field.resolve = resolver.resolve;
          }
        }
      }
    }
  }

  private async initializeJIT(_options: GraphQLOptions): Promise<void> {
    try {
      const jitPath = resolveUserPackage('graphql-jit');
      const jitModule = await import(jitPath);
      this.jitCompiler = jitModule;
      this.jitEnabled = true;
      logger.info('GraphQL-JIT enabled for 5-10x performance boost', 'JIT');
    } catch {
      logger.debug('graphql-jit not available, using standard execution', 'JIT');
    }
  }

  /**
   * Cache key for a compiled query. A compiled query is only valid for the
   * exact document it was built from, so the key is a digest of the document
   * source plus the selected operation name (never the operation name alone:
   * two different documents may share a name, or have none).
   */
  private jitCacheKey(source: string, operationName: string | null | undefined): string {
    return createHash('sha256')
      .update(String(source))
      .update('\0')
      .update(operationName ? String(operationName) : '')
      .digest('hex');
  }

  private evictJITEntry(cacheKey: string): void {
    this.jitCache.delete(cacheKey);
    const timeout = this.jitCacheTimeouts.get(cacheKey);
    if (timeout) {
      clearTimeout(timeout);
      this.jitCacheTimeouts.delete(cacheKey);
    }
  }

  private async executeWithJIT(
    source: string,
    document: any,
    operationName: string | null | undefined,
    variables: Record<string, any> | null | undefined,
    context: GraphQLContext
  ): Promise<GraphQLResponse> {
    const cacheKey = this.jitCacheKey(source, operationName);
    let compiled = this.jitCache.get(cacheKey);

    if (!compiled) {
      compiled = this.jitCompiler.compileQuery(this.schema, document, operationName || undefined);

      if (this.jitCompiler.isCompiledQuery(compiled)) {
        // Bounded cache: drop the oldest entries (Map iterates in insertion
        // order) before adding a new one.
        while (this.jitCache.size >= this.jitCacheMaxSize) {
          const oldest = this.jitCache.keys().next();
          if (oldest.done) break;
          this.evictJITEntry(oldest.value);
        }

        this.jitCache.set(cacheKey, compiled);

        // Clear any existing timeout
        const existingTimeout = this.jitCacheTimeouts.get(cacheKey);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
        }

        // Set new timeout
        const timeout = setTimeout(() => {
          this.jitCache.delete(cacheKey);
          this.jitCacheTimeouts.delete(cacheKey);
        }, this.jitCacheTTL);

        this.jitCacheTimeouts.set(cacheKey, timeout);
      }
    }

    if (this.jitCompiler.isCompiledQuery(compiled)) {
      return await compiled.query(this.rootValue, context, variables || {});
    }

    // Fallback to standard execution
    const { execute } = this.graphql;
    return await execute({
      schema: this.schema,
      document,
      rootValue: this.rootValue,
      contextValue: context,
      variableValues: variables,
      operationName,
    });
  }
}
