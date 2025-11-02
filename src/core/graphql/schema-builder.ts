// GraphQL Schema Builder
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  buildSchema,
  printSchema,
} from 'graphql';
import { createFrameworkLogger } from '../logger/index.js';
import type {
  GraphQLSchemaBuilderOptions,
  GraphQLResolvers,
  GraphQLResolver,
  GraphQLSubscriptionResolver,
} from './types.js';

const logger = createFrameworkLogger('GraphQLSchema');

/**
 * Build GraphQL schema from type definitions and resolvers
 */
export class GraphQLSchemaBuilder {
  private schema?: GraphQLSchema;
  private typeDefs: string[] = [];
  private resolvers: GraphQLResolvers = {};

  constructor(private options: GraphQLSchemaBuilderOptions = {}) {
    if (options.schema) {
      this.schema = options.schema;
    } else if (options.typeDefs) {
      this.typeDefs = Array.isArray(options.typeDefs) ? options.typeDefs : [options.typeDefs];
    }

    if (options.resolvers) {
      this.resolvers = options.resolvers;
    }
  }

  /**
   * Add type definitions
   */
  addTypeDefs(typeDefs: string | string[]): this {
    const defs = Array.isArray(typeDefs) ? typeDefs : [typeDefs];
    this.typeDefs.push(...defs);
    return this;
  }

  /**
   * Add resolvers
   */
  addResolvers(resolvers: GraphQLResolvers): this {
    this.resolvers = this.mergeResolvers(this.resolvers, resolvers);
    return this;
  }

  /**
   * Build the schema
   */
  build(): GraphQLSchema {
    if (this.schema) {
      return this.schema;
    }

    if (this.typeDefs.length === 0) {
      // Create default schema
      return this.buildDefaultSchema();
    }

    try {
      // Build schema from type definitions
      const schemaString = this.typeDefs.join('\n\n');
      const baseSchema = buildSchema(schemaString);

      // Apply resolvers
      this.schema = this.applyResolvers(baseSchema, this.resolvers);

      logger.info('GraphQL schema built successfully', 'Schema');
      return this.schema;
    } catch (error) {
      logger.error('Failed to build GraphQL schema', 'Schema', { error });
      throw error;
    }
  }

  /**
   * Get schema SDL (Schema Definition Language)
   */
  getSDL(): string {
    const schema = this.build();
    return printSchema(schema);
  }

  /**
   * Merge resolvers
   */
  private mergeResolvers(target: GraphQLResolvers, source: GraphQLResolvers): GraphQLResolvers {
    const merged: GraphQLResolvers = { ...target };

    for (const [typeName, typeResolvers] of Object.entries(source)) {
      if (!merged[typeName]) {
        merged[typeName] = typeResolvers;
      } else {
        merged[typeName] = {
          ...merged[typeName],
          ...typeResolvers,
        };
      }
    }

    return merged;
  }

  /**
   * Apply resolvers to schema
   */
  private applyResolvers(schema: GraphQLSchema, resolvers: GraphQLResolvers): GraphQLSchema {
    const typeMap = schema.getTypeMap();

    for (const [typeName, typeResolvers] of Object.entries(resolvers)) {
      const type = typeMap[typeName];

      if (!type) {
        logger.warn(`Type ${typeName} not found in schema`, 'Resolvers');
        continue;
      }

      if ('getFields' in type) {
        const fields = (type as any).getFields();

        for (const [fieldName, resolver] of Object.entries(typeResolvers as Record<string, any>)) {
          const field = fields[fieldName];

          if (!field) {
            logger.warn(`Field ${typeName}.${fieldName} not found in schema`, 'Resolvers');
            continue;
          }

          // Handle subscription resolvers
          if (
            typeName === 'Subscription' &&
            typeof resolver === 'object' &&
            'subscribe' in resolver
          ) {
            const subResolver = resolver as GraphQLSubscriptionResolver;
            field.subscribe = subResolver.subscribe;
            if (subResolver.resolve) {
              field.resolve = subResolver.resolve;
            }
          } else if (typeof resolver === 'function') {
            field.resolve = resolver as GraphQLResolver;
          }
        }
      }
    }

    return schema;
  }

  /**
   * Build default schema with hello world
   */
  private buildDefaultSchema(): GraphQLSchema {
    const queryType = new GraphQLObjectType({
      name: 'Query',
      fields: {
        hello: {
          type: GraphQLString,
          args: {
            name: { type: GraphQLString },
          },
          resolve: (_source, args) => {
            return `Hello ${args.name || 'World'}!`;
          },
        },
      },
    });

    return new GraphQLSchema({
      query: queryType,
    });
  }
}

/**
 * Create schema builder
 */
export function createSchemaBuilder(options?: GraphQLSchemaBuilderOptions): GraphQLSchemaBuilder {
  return new GraphQLSchemaBuilder(options);
}

/**
 * Helper: Build schema from type definitions and resolvers
 */
export function buildGraphQLSchema(
  typeDefs: string | string[],
  resolvers?: GraphQLResolvers
): GraphQLSchema {
  const builder = new GraphQLSchemaBuilder({ typeDefs, resolvers });
  return builder.build();
}

/**
 * Export GraphQL scalar types for convenience
 */
export const GraphQLTypes = {
  String: GraphQLString,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  ID: GraphQLID,
  List: GraphQLList,
  NonNull: GraphQLNonNull,
};
