// GraphQL Integration Test with Moro
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApp } from '../../src/moro.js';
import type { Moro } from '../../src/moro.js';
import { middleware } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp, createTestPort } from '../setup.js';
import { MoroLogger, logger as globalLogger } from '../../src/core/logger/index.js';

describe('GraphQL Integration with Moro', () => {
  let app: Moro;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should configure GraphQL endpoint', async () => {
    app = await createApp({ logger: { level: 'error' } });

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
    app = await createApp({ logger: { level: 'error' } });

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
    app = await createApp({ logger: { level: 'error' } });

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
    app = await createApp({ logger: { level: 'error' } });

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
      context: (req: any, res: any) => ({
        request: req,
        response: res,
        userId: 'test-user-123',
      }),
    });

    const schema = await app.getGraphQLSchema();
    expect(schema).toBeDefined();
  });

  it('should enable JIT by default', async () => {
    app = await createApp({ logger: { level: 'error' } });

    app.graphqlInit({
      typeDefs: `type Query { hello: String! }`,
      resolvers: { Query: { hello: () => 'World' } },
      enableJIT: true,
    });

    const stats = await app.getGraphQLStats();
    expect(stats?.jit).toBeDefined();
  });

  it('should support disabling JIT', async () => {
    app = await createApp({ logger: { level: 'error' } });

    app.graphqlInit({
      typeDefs: `type Query { hello: String! }`,
      resolvers: { Query: { hello: () => 'World' } },
      enableJIT: false,
    });

    const stats = await app.getGraphQLStats();
    expect(stats?.jit?.enabled).toBe(false);
  });

  describe('served over HTTP', () => {
    const typeDefs = `type Query { hello(name: String): String! }`;
    const resolvers = {
      Query: { hello: (_: any, args: any) => `Hello ${args.name ?? 'World'}!` },
    };
    const listen = (port: number) =>
      new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    const post = (port: number, path: string, query: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });

    afterEach(() => {
      resetConfig();
    });

    for (const engine of ['moro', 'node'] as const) {
      it(`answers queries on the endpoint from the first request (${engine})`, async () => {
        resetConfig();
        app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
        app.graphqlInit({ typeDefs, resolvers });
        app.get('/health', () => ({ ok: true }));

        const port = createTestPort();
        await listen(port);

        // No wait between listen() and the request
        const res = await post(port, '/graphql', '{ hello(name: "Moro") }');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: { hello: 'Hello Moro!' } });

        const get = await fetch(
          `http://127.0.0.1:${port}/graphql?query=${encodeURIComponent('{ hello }')}`
        );
        expect(await get.json()).toEqual({ data: { hello: 'Hello World!' } });

        // Other paths go on to the routes
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(await health.json()).toEqual({ ok: true });
      });
    }

    it('serves the configured path and refuses other methods on it', async () => {
      app = await createApp({ logger: { level: 'fatal' } });
      app.graphqlInit({ typeDefs, resolvers, path: '/api/graphql' });

      const port = createTestPort();
      await listen(port);

      expect((await post(port, '/api/graphql', '{ hello }')).status).toBe(200);
      expect((await post(port, '/graphql', '{ hello }')).status).toBe(404);
      const put = await fetch(`http://127.0.0.1:${port}/api/graphql`, { method: 'PUT' });
      expect(put.status).toBe(405);
    });

    it('answers 500 without the reason when the schema could not be built', async () => {
      app = await createApp({ logger: { level: 'fatal' } });
      app.graphqlInit({ typeDefs: 'type Query { broken', resolvers: {} });

      const port = createTestPort();
      await listen(port);

      const res = await post(port, '/graphql', '{ hello }');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ errors: [{ message: 'GraphQL is not available' }] });
      // The reason is available to the application itself
      await expect(app.getGraphQLSchema()).rejects.toThrow();
    });
  });

  it('logs a schema that could not be built one line per log entry', async () => {
    app = await createApp({ logger: { level: 'error' } });
    globalLogger.setLevel('error');
    const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
    try {
      app.graphqlInit({ typeDefs: 'type Query { broken', resolvers: {} });
      await expect(app.getGraphQLSchema()).rejects.toThrow(
        // The error itself keeps its line breaks
        /^GraphQL\.js adapter initialization failed\.\nInstall graphql with: npm install graphql\nError: /
      );
      await new Promise<void>(resolve =>
        app.listen(createTestPort(), '127.0.0.1', () => resolve())
      );
      await new Promise(resolve => setTimeout(resolve, 50));

      const messages = log.mock.calls
        .filter(call => call[0] === 'error')
        .map(call => String(call[1]));
      expect(messages.filter(message => /[\r\n]/.test(message))).toEqual([]);
      expect(messages).toContain(
        'Failed to initialize GraphQL: Error: GraphQL.js adapter initialization failed.'
      );
      expect(messages).toContain('Install graphql with: npm install graphql');
      expect(messages.some(message => message.startsWith('Error: '))).toBe(true);
    } finally {
      log.mockRestore();
      resetConfig();
    }
  });

  it('looks for the graphql package where the application runs', async () => {
    app = await createApp({ logger: { level: 'error' } });
    const original = process.cwd();
    const elsewhere = mkdtempSync(join(tmpdir(), 'moro-no-graphql-'));

    try {
      // A directory with no node_modules above it: the adapter, which loads
      // graphql from the application's directory, could not load it either.
      process.chdir(elsewhere);
      expect(() =>
        app.graphqlInit({
          typeDefs: `type Query { hello: String! }`,
          resolvers: { Query: { hello: () => 'World' } },
        })
      ).toThrow('GraphQL support requires the graphql package to be installed');
    } finally {
      process.chdir(original);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('middleware.graphql()', () => {
  let app: any;

  afterEach(async () => {
    resetConfig();
    if (app) await closeApp(app);
    app = null;
  });

  const schema = {
    typeDefs: `
      type Query {
        hello: String!
      }
    `,
    resolvers: { Query: { hello: () => 'Hello World!' } },
  };

  const query = (port: number, path = '/graphql') =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ hello }' }),
    });

  for (const engine of ['moro', 'node'] as const) {
    it(`installs with app.use() and serves the endpoint from the first request (${engine})`, async () => {
      app = await createApp({ logger: { level: 'fatal' }, server: { engine } });

      await expect(app.use(middleware.graphql(schema))).resolves.toBe(app);
      app.get('/health', () => ({ ok: true }));

      const port = createTestPort();
      await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));

      // No wait between listen() and the request: the endpoint must already exist
      const res = await query(port);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { hello: 'Hello World!' } });

      // Requests for other paths go on to the routes
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    });
  }

  it('serves the configured path and refuses other methods on it', async () => {
    app = await createApp({ logger: { level: 'fatal' } });
    await app.use(middleware.graphql({ ...schema, path: '/api/graphql' }));

    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));

    expect((await query(port, '/api/graphql')).status).toBe(200);
    expect((await query(port)).status).toBe(404);

    const put = await fetch(`http://127.0.0.1:${port}/api/graphql`, { method: 'PUT' });
    expect(put.status).toBe(405);
  });

  // The endpoint answers in a request hook, and request hooks run for every
  // request, also one a hook ahead of them has answered already
  for (const engine of ['moro', 'node'] as const) {
    it(`leaves a request the rate limit has already answered alone (${engine})`, async () => {
      app = await createApp({
        logger: { level: 'error' },
        server: { engine },
        security: { rateLimit: { global: { enabled: true, requests: 1, window: 60000 } } },
      });
      // Both ways of serving GraphQL: app.graphqlInit() and the middleware
      let resolved = 0;
      const counted = {
        typeDefs: schema.typeDefs,
        resolvers: {
          Query: {
            hello: () => {
              resolved++;
              return 'Hello World!';
            },
          },
        },
      };
      app.graphqlInit(counted);
      await app.use(middleware.graphql({ ...counted, path: '/graph' }));

      const logged: string[] = [];
      globalLogger.addOutput({
        name: 'graphql-after-refusal',
        write: (entry: any) => {
          logged.push(String(entry.message));
        },
      } as any);
      try {
        const port = createTestPort();
        await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));

        for (const endpoint of ['/graphql', '/graph']) {
          expect((await query(port, endpoint)).status).toBe(200);
          const before = resolved;
          const limited = await query(port, endpoint);
          expect(`${endpoint} ${limited.status}`).toBe(`${endpoint} 429`);
          expect(((await limited.json()) as { error?: string }).error).toBe('Too many requests');
          // The operation of a refused request is not executed
          expect(`${endpoint} ran ${resolved - before}`).toBe(`${endpoint} ran 0`);
        }
      } finally {
        globalLogger.removeOutput('graphql-after-refusal');
      }
      expect(logged).toEqual([]);
    });
  }
});
