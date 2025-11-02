// GraphQL Integration Test with Moro
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createApp } from '../../src/moro';
import type { Moro } from '../../src/moro';

describe('GraphQL Integration with Moro', () => {
  let app: Moro;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should configure GraphQL endpoint', async () => {
    app = createApp();

    app.graphql({
      typeDefs: `
        type Query {
          hello: String!
        }
      `,
      resolvers: {
        Query: {
          hello: () => 'Hello World!',
        },
      },
    });

    // Wait for GraphQL to initialize
    await new Promise(resolve => setTimeout(resolve, 100));

    const schema = app.getGraphQLSchema();
    expect(schema).toBeDefined();
    expect(schema?.getQueryType()).toBeDefined();
  });

  it('should get GraphQL stats', async () => {
    app = createApp();

    app.graphql({
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

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 100));

    const stats = app.getGraphQLStats();

    expect(stats).toBeDefined();
    expect(stats?.schema).toBeDefined();
    expect(stats?.schema.queries).toBe(1);
    expect(stats?.schema.mutations).toBe(1);
    expect(stats?.jit).toBeDefined();
  });

  it('should throw error when GraphQL configured twice', async () => {
    app = createApp();

    app.graphql({
      typeDefs: `type Query { hello: String! }`,
      resolvers: { Query: { hello: () => 'World' } },
    });

    expect(() => {
      app.graphql({
        typeDefs: `type Query { bye: String! }`,
        resolvers: { Query: { bye: () => 'Bye' } },
      });
    }).toThrow('GraphQL has already been configured');
  });

  it('should work with custom context', async () => {
    app = createApp();

    app.graphql({
      typeDefs: `
        type Query {
          currentUser: String!
        }
      `,
      resolvers: {
        Query: {
          currentUser: (_: any, __: any, context: any) => {
            return context.userId || 'anonymous';
          },
        },
      },
      context: (req, res) => ({
        request: req,
        response: res,
        userId: 'test-user-123',
      }),
    });

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 100));

    const schema = app.getGraphQLSchema();
    expect(schema).toBeDefined();
  });

  it('should enable JIT by default', async () => {
    app = createApp();

    app.graphql({
      typeDefs: `type Query { hello: String! }`,
      resolvers: { Query: { hello: () => 'World' } },
      enableJIT: true,
    });

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 100));

    const stats = app.getGraphQLStats();
    expect(stats?.jit).toBeDefined();
  });

  it('should support disabling JIT', async () => {
    app = createApp();

    app.graphql({
      typeDefs: `type Query { hello: String! }`,
      resolvers: { Query: { hello: () => 'World' } },
      enableJIT: false,
    });

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 100));

    const stats = app.getGraphQLStats();
    expect(stats?.jit?.enabled).toBe(false);
  });
});
