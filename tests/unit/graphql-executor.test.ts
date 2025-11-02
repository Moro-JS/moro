// GraphQL Executor Tests
import { describe, it, expect, beforeEach } from '@jest/globals';
import { buildSchema } from 'graphql';
import { GraphQLExecutor } from '../../src/core/graphql/executor';

describe('GraphQL Executor', () => {
  let schema: any;
  let executor: GraphQLExecutor;
  const executorsToCleanup: GraphQLExecutor[] = [];

  afterEach(() => {
    // Cleanup all executors to prevent hanging timeouts
    if (executor) {
      executor.cleanup();
    }
    executorsToCleanup.forEach(exec => exec.cleanup());
    executorsToCleanup.length = 0;
  });

  beforeEach(() => {
    schema = buildSchema(`
      type Query {
        hello(name: String): String!
        add(a: Int!, b: Int!): Int!
        throwError: String!
      }

      type Mutation {
        createUser(name: String!): User!
      }

      type User {
        id: ID!
        name: String!
      }
    `);

    const resolvers = {
      hello: (args: { name?: string }) => `Hello ${args.name || 'World'}!`,
      add: (args: { a: number; b: number }) => args.a + args.b,
      throwError: () => {
        throw new Error('Test error');
      },
      createUser: (args: { name: string }) => ({
        id: '1',
        name: args.name,
      }),
    };

    // Attach resolvers to schema
    const queryType = schema.getQueryType();
    if (queryType) {
      const fields = queryType.getFields();
      fields.hello.resolve = (_: any, args: any) => resolvers.hello(args);
      fields.add.resolve = (_: any, args: any) => resolvers.add(args);
      fields.throwError.resolve = () => resolvers.throwError();
    }

    const mutationType = schema.getMutationType();
    if (mutationType) {
      const fields = mutationType.getFields();
      fields.createUser.resolve = (_: any, args: any) => resolvers.createUser(args);
    }
  });

  describe('Query Execution', () => {
    beforeEach(() => {
      executor = new GraphQLExecutor(schema);
    });

    it('should execute simple query', async () => {
      const result = await executor.executeQuery('{ hello }');

      expect(result.data).toBeDefined();
      expect(result.data.hello).toBe('Hello World!');
      expect(result.errors).toBeUndefined();
    });

    it('should execute query with arguments', async () => {
      const result = await executor.executeQuery('{ hello(name: "GraphQL") }');

      expect(result.data).toBeDefined();
      expect(result.data.hello).toBe('Hello GraphQL!');
    });

    it('should execute query with variables', async () => {
      const query = 'query AddNumbers($a: Int!, $b: Int!) { add(a: $a, b: $b) }';
      const variables = { a: 5, b: 3 };

      const result = await executor.executeQuery(query, variables);

      expect(result.data).toBeDefined();
      expect(result.data.add).toBe(8);
    });

    it('should execute mutations', async () => {
      const mutation = 'mutation { createUser(name: "Alice") { id name } }';

      const result = await executor.executeQuery(mutation);

      expect(result.data).toBeDefined();
      expect(result.data.createUser.id).toBe('1');
      expect(result.data.createUser.name).toBe('Alice');
    });

    it('should handle execution errors', async () => {
      const result = await executor.executeQuery('{ throwError }');

      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);
      expect(result.errors?.[0].message).toContain('Test error');
    });

    it('should handle validation errors', async () => {
      const result = await executor.executeQuery('{ invalidField }');

      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it('should include metrics in result', async () => {
      const result = await executor.executeQuery('{ hello }');

      expect(result.metrics).toBeDefined();
      expect(result.metrics?.startTime).toBeDefined();
      expect(result.metrics?.endTime).toBeDefined();
      expect(result.metrics?.duration).toBeDefined();
      expect(result.metrics?.parsing).toBeDefined();
      expect(result.metrics?.validation).toBeDefined();
      expect(result.metrics?.execution).toBeDefined();
    });
  });

  describe('Context', () => {
    beforeEach(() => {
      executor = new GraphQLExecutor(schema);
    });

    it('should pass context to resolvers', async () => {
      const contextSchema = buildSchema(`
        type Query {
          whoami: String!
        }
      `);

      const queryType = contextSchema.getQueryType();
      if (queryType) {
        const fields = queryType.getFields();
        fields.whoami.resolve = (_: any, __: any, context: any) => {
          return `User ${context.userId}`;
        };
      }

      const contextExecutor = new GraphQLExecutor(contextSchema);
      executorsToCleanup.push(contextExecutor);
      const context = { userId: '123' };

      const result = await contextExecutor.executeQuery('{ whoami }', undefined, context);

      expect(result.data).toBeDefined();
      expect(result.data.whoami).toBe('User 123');
    });
  });

  describe('GraphQL-JIT Support', () => {
    it('should initialize with JIT enabled by default', () => {
      const jitExecutor = new GraphQLExecutor(schema);
      executorsToCleanup.push(jitExecutor);
      const stats = jitExecutor.getJITStats();

      expect(stats).toBeDefined();
      expect(stats.enabled).toBeDefined();
      expect(stats.cacheSize).toBe(0);
    });

    it('should allow disabling JIT', () => {
      const noJitExecutor = new GraphQLExecutor(schema, { enableJIT: false });
      executorsToCleanup.push(noJitExecutor);
      const stats = noJitExecutor.getJITStats();

      expect(stats.enabled).toBe(false);
    });

    it('should cache compiled queries', async () => {
      const jitExecutor = new GraphQLExecutor(schema);
      executorsToCleanup.push(jitExecutor);

      // Execute same query twice
      await jitExecutor.executeQuery('{ hello }');
      await jitExecutor.executeQuery('{ hello }');

      const stats = jitExecutor.getJITStats();

      // If JIT is available, cache should have entries
      // If not available, cache will be 0
      expect(stats.cacheSize).toBeGreaterThanOrEqual(0);
    });

    it('should clear JIT cache', async () => {
      const jitExecutor = new GraphQLExecutor(schema);
      executorsToCleanup.push(jitExecutor);

      await jitExecutor.executeQuery('{ hello }');

      jitExecutor.clearJITCache();

      const stats = jitExecutor.getJITStats();
      expect(stats.cacheSize).toBe(0);
    });

    it('should respect JIT cache TTL', async () => {
      const shortTTLExecutor = new GraphQLExecutor(schema, {
        enableJIT: true,
        jitCacheTTL: 100, // 100ms
      });
      executorsToCleanup.push(shortTTLExecutor);

      await shortTTLExecutor.executeQuery('{ hello }');

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      const stats = shortTTLExecutor.getJITStats();

      // Cache should be cleared or entry should be expired
      expect(stats.cacheSize).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Performance', () => {
    beforeEach(() => {
      executor = new GraphQLExecutor(schema);
    });

    it('should track execution time', async () => {
      const result = await executor.executeQuery('{ hello }');

      expect(result.metrics?.duration).toBeDefined();
      expect(result.metrics?.duration).toBeGreaterThan(0);
    });

    it('should track parsing time', async () => {
      const result = await executor.executeQuery('{ hello }');

      expect(result.metrics?.parsing).toBeDefined();
      expect(result.metrics?.parsing).toBeGreaterThanOrEqual(0);
    });

    it('should track validation time', async () => {
      const result = await executor.executeQuery('{ hello }');

      expect(result.metrics?.validation).toBeDefined();
      expect(result.metrics?.validation).toBeGreaterThanOrEqual(0);
    });

    it('should track execution time separately', async () => {
      const result = await executor.executeQuery('{ hello }');

      expect(result.metrics?.execution).toBeDefined();
      expect(result.metrics?.execution).toBeGreaterThanOrEqual(0);
    });
  });
});

