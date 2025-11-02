// GraphQL Core Tests
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { GraphQLCore } from '../../src/core/graphql/core';
import { buildGraphQLSchema } from '../../src/core/graphql/schema-builder';

describe('GraphQL Core', () => {
  let graphqlCore: GraphQLCore;

  afterEach(() => {
    if (graphqlCore) {
      // Cleanup executor to prevent hanging timeouts
      const executor = graphqlCore.getExecutor();
      if (executor) {
        executor.cleanup();
      }
    }
  });

  describe('Schema Building', () => {
    it('should build schema from type definitions and resolvers', async () => {
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

      graphqlCore = new GraphQLCore({
        typeDefs,
        resolvers,
      });

      await graphqlCore.initialize();

      const schema = graphqlCore.getSchema();
      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();
    });

    it('should accept pre-built GraphQL schema', async () => {
      const schema = buildGraphQLSchema(`
        type Query {
          hello: String!
        }
      `);

      graphqlCore = new GraphQLCore({ schema });
      await graphqlCore.initialize();

      expect(graphqlCore.getSchema()).toBe(schema);
    });
  });

  describe('Query Execution', () => {
    beforeEach(async () => {
      graphqlCore = new GraphQLCore({
        typeDefs: `
          type Query {
            hello(name: String): String!
            add(a: Int!, b: Int!): Int!
          }
        `,
        resolvers: {
          Query: {
            hello: (_: any, args: { name?: string }) => `Hello ${args.name || 'World'}!`,
            add: (_: any, args: { a: number; b: number }) => args.a + args.b,
          },
        },
      });

      await graphqlCore.initialize();
    });

    it('should execute simple query', async () => {
      const mockReq = {
        method: 'POST',
        body: {
          query: '{ hello }',
        },
      };

      const mockRes = {
        status: (code: number) => ({
          json: (data: any) => {
            expect(code).toBe(200);
            expect(data.data.hello).toBe('Hello World!');
          },
        }),
      };

      await graphqlCore.handleRequest(mockReq as any, mockRes as any);
    });

    it('should execute query with arguments', async () => {
      const mockReq = {
        method: 'POST',
        body: {
          query: '{ hello(name: "GraphQL") }',
        },
      };

      const mockRes = {
        status: (code: number) => ({
          json: (data: any) => {
            expect(code).toBe(200);
            expect(data.data.hello).toBe('Hello GraphQL!');
          },
        }),
      };

      await graphqlCore.handleRequest(mockReq as any, mockRes as any);
    });

    it('should execute query with variables', async () => {
      const mockReq = {
        method: 'POST',
        body: {
          query: 'query AddNumbers($a: Int!, $b: Int!) { add(a: $a, b: $b) }',
          variables: { a: 5, b: 3 },
        },
      };

      const mockRes = {
        status: (code: number) => ({
          json: (data: any) => {
            expect(code).toBe(200);
            expect(data.data.add).toBe(8);
          },
        }),
      };

      await graphqlCore.handleRequest(mockReq as any, mockRes as any);
    });

    it('should handle validation errors', async () => {
      const mockReq = {
        method: 'POST',
        body: {
          query: '{ invalidField }',
        },
      };

      const mockRes = {
        status: (code: number) => ({
          json: (data: any) => {
            expect(code).toBe(200);
            expect(data.errors).toBeDefined();
            expect(data.errors.length).toBeGreaterThan(0);
          },
        }),
      };

      await graphqlCore.handleRequest(mockReq as any, mockRes as any);
    });

    it('should support GET requests with query params', async () => {
      const mockReq = {
        method: 'GET',
        query: {
          query: '{ hello }',
        },
      };

      const mockRes = {
        status: (code: number) => ({
          json: (data: any) => {
            expect(code).toBe(200);
            expect(data.data.hello).toBe('Hello World!');
          },
        }),
      };

      await graphqlCore.handleRequest(mockReq as any, mockRes as any);
    });
  });

  describe('Context', () => {
    it('should pass custom context to resolvers', async () => {
      const customContext = { userId: '123', isAdmin: true };

      graphqlCore = new GraphQLCore({
        typeDefs: `
          type Query {
            whoami: String!
          }
        `,
        resolvers: {
          Query: {
            whoami: (_: any, __: any, context: any) => {
              expect(context.userId).toBe('123');
              expect(context.isAdmin).toBe(true);
              return `User ${context.userId}`;
            },
          },
        },
        context: () => customContext,
      });

      await graphqlCore.initialize();

      const mockReq = {
        method: 'POST',
        body: { query: '{ whoami }' },
      };

      const mockRes = {
        status: () => ({
          json: (data: any) => {
            expect(data.data.whoami).toBe('User 123');
          },
        }),
      };

      await graphqlCore.handleRequest(mockReq as any, mockRes as any);
    });
  });

  describe('Stats', () => {
    beforeEach(async () => {
      graphqlCore = new GraphQLCore({
        typeDefs: `
          type Query {
            hello: String!
          }

          type Mutation {
            createUser: User!
          }

          type User {
            id: ID!
          }
        `,
        resolvers: {
          Query: { hello: () => 'World' },
          Mutation: { createUser: () => ({ id: '1' }) },
        },
      });

      await graphqlCore.initialize();
    });

    it('should return correct stats', () => {
      const stats = graphqlCore.getStats();

      expect(stats.schema).toBeDefined();
      expect(stats.schema.queries).toBe(1);
      expect(stats.schema.mutations).toBe(1);
      expect(stats.jit).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should format errors with custom formatter', async () => {
      graphqlCore = new GraphQLCore({
        typeDefs: `
          type Query {
            throwError: String!
          }
        `,
        resolvers: {
          Query: {
            throwError: () => {
              throw new Error('Test error');
            },
          },
        },
        formatError: (error: any) => ({
          message: `Formatted: ${error.message}`,
          customField: 'custom value',
        }),
      });

      await graphqlCore.initialize();

      const mockReq = {
        method: 'POST',
        body: { query: '{ throwError }' },
      };

      const mockRes = {
        status: () => ({
          json: (data: any) => {
            expect(data.errors).toBeDefined();
            expect(data.errors[0].message).toContain('Formatted:');
          },
        }),
      };

      await graphqlCore.handleRequest(mockReq as any, mockRes as any);
    });
  });

  describe('Introspection', () => {
    beforeEach(async () => {
      graphqlCore = new GraphQLCore({
        typeDefs: `
          type Query {
            hello: String!
          }
        `,
        resolvers: {
          Query: { hello: () => 'World' },
        },
      });

      await graphqlCore.initialize();
    });

    it('should return introspection query result', () => {
      const introspection = graphqlCore.getIntrospection();
      expect(introspection).toBeDefined();
      expect(introspection.data).toBeDefined();
    });

    it('should block introspection when disabled', async () => {
      graphqlCore = new GraphQLCore({
        typeDefs: `type Query { hello: String! }`,
        resolvers: { Query: { hello: () => 'World' } },
        enableIntrospection: false,
      });

      await graphqlCore.initialize();

      const mockReq = {
        method: 'POST',
        body: {
          query: '{ __schema { types { name } } }',
        },
      };

      const mockRes = {
        status: (code: number) => ({
          json: (data: any) => {
            expect(code).toBe(400);
            expect(data.errors).toBeDefined();
          },
        }),
      };

      await graphqlCore.handleRequest(mockReq as any, mockRes as any);
    });
  });
});

