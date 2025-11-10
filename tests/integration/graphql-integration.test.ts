/* eslint-disable */
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
    app = createApp({ logger: { level: 'error' } });

    app.graphqlInit({
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

    const schema = await app.getGraphQLSchema();
    expect(schema).toBeDefined();
    expect(schema?.getQueryType()).toBeDefined();
  });

  it('should get GraphQL stats', async () => {
    app = createApp({ logger: { level: 'error' } });

    app.graphqlInit({
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

    const stats = await app.getGraphQLStats();

    expect(stats).toBeDefined();
    expect(stats?.schema).toBeDefined();
    expect(stats?.schema.queries).toBe(1);
    expect(stats?.schema.mutations).toBe(1);
    expect(stats?.jit).toBeDefined();
  });

  it('should throw error when GraphQL configured twice', async () => {
    app = createApp({ logger: { level: 'error' } });

    app.graphqlInit({
      typeDefs: `type Query { hello: String! }`,
      resolvers: { Query: { hello: () => 'World' } },
    });

    expect(() => {
      app.graphqlInit({
        typeDefs: `type Query { bye: String! }`,
        resolvers: { Query: { bye: () => 'Bye' } },
      });
    }).toThrow('GraphQL has already been configured');
  });

  it('should work with custom context', async () => {
    app = createApp({ logger: { level: 'error' } });

    app.graphqlInit({
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

    const schema = await app.getGraphQLSchema();
    expect(schema).toBeDefined();
  });

  it('should enable JIT by default', async () => {
    app = createApp({ logger: { level: 'error' } });

    app.graphqlInit({
      typeDefs: `type Query { hello: String! }`,
      resolvers: { Query: { hello: () => 'World' } },
      enableJIT: true,
    });

    const stats = await app.getGraphQLStats();
    expect(stats?.jit).toBeDefined();
  });

  it('should support disabling JIT', async () => {
    app = createApp({ logger: { level: 'error' } });

    app.graphqlInit({
      typeDefs: `type Query { hello: String! }`,
      resolvers: { Query: { hello: () => 'World' } },
      enableJIT: false,
    });

    const stats = await app.getGraphQLStats();
    expect(stats?.jit?.enabled).toBe(false);
  });
});
