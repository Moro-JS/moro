// GraphQL.js Adapter - Default adapter using graphql-js
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

const logger = createFrameworkLogger('GraphQLAdapter');

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

      // Validate query
      const errors = validate(this.schema, document);
      if (errors.length > 0) {
        return { errors };
      }

      // Execute with JIT if enabled
      if (this.jitEnabled && this.jitCompiler) {
        return await this.executeWithJIT(document, operationName, variables, context);
      }

      // Standard execution
      const { execute } = this.graphql;
      return await execute({
        schema: this.schema,
        document,
        rootValue: null,
        contextValue: context,
        variableValues: variables,
        operationName,
      });
    } catch (error) {
      logger.error('GraphQL execution error', 'Execution', { error });
      return {
        errors: [
          {
            message: error instanceof Error ? error.message : 'Unknown error',
            extensions: { stack: error instanceof Error ? error.stack : undefined },
          },
        ],
      };
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

  private async executeWithJIT(
    document: any,
    operationName: string | null | undefined,
    variables: Record<string, any> | null | undefined,
    context: GraphQLContext
  ): Promise<GraphQLResponse> {
    const cacheKey = `${operationName || 'default'}`;
    let compiled = this.jitCache.get(cacheKey);

    if (!compiled) {
      compiled = this.jitCompiler.compileQuery(this.schema, document, operationName || undefined);

      if (this.jitCompiler.isCompiledQuery(compiled)) {
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
      return await compiled.query(null, context, variables || {});
    }

    // Fallback to standard execution
    const { execute } = this.graphql;
    return await execute({
      schema: this.schema,
      document,
      rootValue: null,
      contextValue: context,
      variableValues: variables,
      operationName,
    });
  }
}
