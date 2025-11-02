// GraphQL Schema Builder Tests
import { describe, it, expect } from '@jest/globals';
import {
  GraphQLSchemaBuilder,
  buildGraphQLSchema,
  GraphQLTypes,
} from '../../src/core/graphql/schema-builder';

describe('GraphQL Schema Builder', () => {
  describe('Type Definitions', () => {
    it('should build schema from string type definitions', () => {
      const typeDefs = `
        type Query {
          hello: String!
          user(id: ID!): User
        }

        type User {
          id: ID!
          name: String!
          email: String!
        }
      `;

      const builder = new GraphQLSchemaBuilder({ typeDefs });
      const schema = builder.build();

      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();
      expect(schema.getType('User')).toBeDefined();
    });

    it('should build schema from array of type definitions', () => {
      const typeDefs = [
        `type Query { hello: String! }`,
        `type User { id: ID!, name: String! }`,
      ];

      const builder = new GraphQLSchemaBuilder({ typeDefs });
      const schema = builder.build();

      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();
      expect(schema.getType('User')).toBeDefined();
    });

    it('should add type definitions dynamically', () => {
      const builder = new GraphQLSchemaBuilder();

      builder.addTypeDefs('type Query { hello: String! }');
      builder.addTypeDefs('type User { id: ID!, name: String! }');

      const schema = builder.build();

      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();
      expect(schema.getType('User')).toBeDefined();
    });
  });

  describe('Resolvers', () => {
    it('should apply resolvers to schema', () => {
      const typeDefs = `
        type Query {
          hello: String!
          user(id: ID!): User
        }

        type User {
          id: ID!
          name: String!
        }
      `;

      const resolvers = {
        Query: {
          hello: () => 'Hello World!',
          user: (_: any, args: { id: string }) => ({
            id: args.id,
            name: 'Test User',
          }),
        },
      };

      const builder = new GraphQLSchemaBuilder({ typeDefs, resolvers });
      const schema = builder.build();

      expect(schema).toBeDefined();

      const queryType = schema.getQueryType();
      expect(queryType).toBeDefined();

      const helloField = queryType?.getFields()['hello'];
      expect(helloField).toBeDefined();
      expect(helloField?.resolve).toBeDefined();
    });

    it('should merge multiple resolver sets', () => {
      const typeDefs = `
        type Query {
          hello: String!
          goodbye: String!
        }
      `;

      const builder = new GraphQLSchemaBuilder({ typeDefs });

      builder.addResolvers({
        Query: {
          hello: () => 'Hello!',
        },
      });

      builder.addResolvers({
        Query: {
          goodbye: () => 'Goodbye!',
        },
      });

      const schema = builder.build();
      const queryType = schema.getQueryType();

      expect(queryType?.getFields()['hello'].resolve).toBeDefined();
      expect(queryType?.getFields()['goodbye'].resolve).toBeDefined();
    });
  });

  describe('Default Schema', () => {
    it('should create default hello world schema when no types provided', () => {
      const builder = new GraphQLSchemaBuilder();
      const schema = builder.build();

      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();

      const queryType = schema.getQueryType();
      expect(queryType?.getFields()['hello']).toBeDefined();
    });
  });

  describe('Schema SDL', () => {
    it('should generate SDL from schema', () => {
      const typeDefs = `
        type Query {
          hello: String!
        }
      `;

      const builder = new GraphQLSchemaBuilder({ typeDefs });
      builder.build();

      const sdl = builder.getSDL();

      expect(sdl).toContain('type Query');
      expect(sdl).toContain('hello');
    });
  });

  describe('Helper Functions', () => {
    it('should build schema using buildGraphQLSchema helper', () => {
      const schema = buildGraphQLSchema(
        `
          type Query {
            hello: String!
          }
        `,
        {
          Query: {
            hello: () => 'Hello World!',
          },
        }
      );

      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();
    });
  });

  describe('GraphQL Types Export', () => {
    it('should export common GraphQL types', () => {
      expect(GraphQLTypes.String).toBeDefined();
      expect(GraphQLTypes.Int).toBeDefined();
      expect(GraphQLTypes.Float).toBeDefined();
      expect(GraphQLTypes.Boolean).toBeDefined();
      expect(GraphQLTypes.ID).toBeDefined();
      expect(GraphQLTypes.List).toBeDefined();
      expect(GraphQLTypes.NonNull).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid type definitions', () => {
      const invalidTypeDefs = `
        type Query {
          hello String!  # Missing colon
        }
      `;

      const builder = new GraphQLSchemaBuilder({ typeDefs: invalidTypeDefs });

      expect(() => builder.build()).toThrow();
    });

    it('should warn about missing types in resolvers', () => {
      const typeDefs = `
        type Query {
          hello: String!
        }
      `;

      const resolvers = {
        Query: {
          hello: () => 'Hello!',
        },
        NonExistentType: {
          field: () => 'value',
        },
      };

      const builder = new GraphQLSchemaBuilder({ typeDefs, resolvers });

      // Should not throw, just warn
      expect(() => builder.build()).not.toThrow();
    });
  });
});

