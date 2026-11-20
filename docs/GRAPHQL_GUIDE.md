# GraphQL Integration for MoroJS

MoroJS includes powerful built-in GraphQL support that is **completely optional**:

- **Pothos support** for TypeScript-first, code-first schema building
- **GraphQL-JIT** for 5-10x query execution performance boost
- **WebSocket subscriptions** for real-time data
- **GraphQL Playground** for interactive API exploration
- **Gracefully optional** - only loads if you use it and have the packages installed

## Installation

GraphQL support is **optional**. The framework will work perfectly without it.

```bash
# Install MoroJS (no GraphQL dependencies required)
npm install @morojs/moro

# Only install GraphQL if you want to use it
npm install graphql

# Optional: Install Pothos for TypeScript-first schemas
npm install @pothos/core

# Optional: Install GraphQL-JIT for performance (auto-detected)
npm install graphql-jit

# Optional: Install DataLoader for batching
npm install dataloader
```

**Note:** If you try to use `app.graphqlInit()` without having `graphql` installed, you'll get a helpful error message with installation instructions.

## Quick Start

### Basic GraphQL with Type Definitions

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

app.graphqlInit({
  typeDefs: `
    type Query {
      hello(name: String): String!
      users: [User!]!
    }

    type User {
      id: ID!
      name: String!
      email: String!
    }

    type Mutation {
      createUser(name: String!, email: String!): User!
    }
  `,
  resolvers: {
    Query: {
      hello: (_parent, args) => `Hello ${args.name || 'World'}!`,
      users: async () => {
        // Fetch from database
        return [
          { id: '1', name: 'Alice', email: 'alice@example.com' },
          { id: '2', name: 'Bob', email: 'bob@example.com' },
        ];
      },
    },
    Mutation: {
      createUser: async (_parent, args) => {
        // Create user in database
        return {
          id: '3',
          name: args.name,
          email: args.email,
        };
      },
    },
  },
  // Optional: Custom context
  context: async (req, res) => ({
    request: req,
    response: res,
    user: req.auth?.user,
  }),
});

app.listen(3000, () => {
  console.log('GraphQL API: http://localhost:3000/graphql');
  console.log('GraphQL Playground: http://localhost:3000/graphql/playground');
});
```

`graphqlInit()` returns at once and builds the schema in the background. The
endpoint answers `GET` and `POST` on `path` (default `/graphql`) on the native
engine and on the Node.js server alike, from the first request: a request
that arrives while the schema is still being built waits for it. Other
methods on that path get `405`. The playground is served on `playgroundPath`
unless `enablePlayground` is `false` or `NODE_ENV` is `production`.

The playground page loads GraphiQL and React from `unpkg.com` at exact versions
(`graphiql@2.4.7`, `react@18.3.1`, `react-dom@18.3.1`), each with a
subresource-integrity digest, so the browser runs those files or nothing. A
browser that cannot reach the CDN shows an empty page; the GraphQL endpoint
itself does not depend on it.

If the schema cannot be built (a syntax error in `typeDefs`, a missing
resolver package), the error is logged, the app keeps running and the
endpoint answers `500 {"errors":[{"message":"GraphQL is not available"}]}`.
`await app.getGraphQLSchema()` rejects with the original error, which makes
it a convenient start-up check.

The `graphql` package is loaded from the application's working directory
(the project that depends on `@morojs/moro`), the same place every optional
package is loaded from.

### TypeScript-First with Pothos

```typescript
import { createApp } from '@morojs/moro';
// Import Pothos directly for full TypeScript support
import SchemaBuilder from '@pothos/core';

const app = await createApp();

// Create Pothos schema builder
const builder = new SchemaBuilder<{
  Context: {
    user?: { id: string; name: string };
  };
}>({});

// Define User type with full TypeScript inference
const User = builder.objectRef<{ id: string; name: string; email: string }>('User');

User.implement({
  fields: t => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    email: t.exposeString('email'),
  }),
});

// Define Query type
builder.queryType({
  fields: t => ({
    hello: t.string({
      args: {
        name: t.arg.string(),
      },
      resolve: (_parent, args) => `Hello ${args.name || 'World'}!`,
    }),
    users: t.field({
      type: [User],
      resolve: async () => [
        { id: '1', name: 'Alice', email: 'alice@example.com' },
        { id: '2', name: 'Bob', email: 'bob@example.com' },
      ],
    }),
    me: t.field({
      type: User,
      nullable: true,
      resolve: (_parent, _args, ctx) => {
        if (!ctx.user) return null;
        return {
          id: ctx.user.id,
          name: ctx.user.name,
          email: 'user@example.com',
        };
      },
    }),
  }),
});

// Define Mutation type
builder.mutationType({
  fields: t => ({
    createUser: t.field({
      type: User,
      args: {
        name: t.arg.string({ required: true }),
        email: t.arg.string({ required: true }),
      },
      resolve: async (_parent, args) => ({
        id: '3',
        name: args.name,
        email: args.email,
      }),
    }),
  }),
});

// Configure GraphQL with Pothos schema
app.graphqlInit({
  pothosSchema: builder,
  context: async (req, res) => ({
    request: req,
    response: res,
    user: req.auth?.user,
  }),
});

app.listen(3000);
```

## WebSocket Subscriptions

```typescript
import { createApp, createPothosBuilder } from '@morojs/moro';

const app = await createApp({
  websocket: { enabled: true }, // Enable WebSocket support
});

const builder = await createPothosBuilder();

// Define subscription type
builder.subscriptionType({
  fields: t => ({
    messageAdded: t.field({
      type: 'String',
      subscribe: async function* () {
        // Simulate real-time events
        let count = 0;
        while (true) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          yield `Message ${++count}`;
        }
      },
    }),
  }),
});

app.graphqlInit({
  pothosSchema: builder,
  enableSubscriptions: true, // Enable subscriptions
});

app.listen(3000);

// Client usage:
// ws://localhost:3000/graphql/subscriptions
```

## Performance with GraphQL-JIT

GraphQL-JIT provides 5-10x performance boost by compiling queries to JavaScript functions:

```typescript
app.graphqlInit({
  typeDefs: '...',
  resolvers: {},
  enableJIT: true, // Enabled by default if graphql-jit is installed
  jitCacheTTL: 3600000, // Cache compiled queries for 1 hour
});
```

## Authentication Integration

```typescript
import { createApp, auth, providers } from '@morojs/moro';

const app = await createApp();

// Setup authentication
app.use(
  auth({
    providers: [providers.github({ clientId: '...', clientSecret: '...' })],
    secret: process.env.AUTH_SECRET,
  })
);

// GraphQL with auth context
app.graphqlInit({
  typeDefs: `
    type Query {
      me: User
      privateData: String!
    }

    type User {
      id: ID!
      name: String!
    }
  `,
  resolvers: {
    Query: {
      me: (_parent, _args, ctx) => {
        return ctx.user || null;
      },
      privateData: (_parent, _args, ctx) => {
        if (!ctx.user) {
          throw new Error('Authentication required');
        }
        return 'Secret data';
      },
    },
  },
  context: async (req, res) => ({
    request: req,
    response: res,
    user: req.auth?.user,
    isAuthenticated: req.auth?.isAuthenticated || false,
  }),
});

app.listen(3000);
```

## DataLoader for Batching (N+1 Prevention)

```typescript
import { createApp, createPothosBuilder, createDataLoader } from '@morojs/moro';

const app = await createApp();
const builder = await createPothosBuilder();

// Create DataLoader for batching user queries
const createUserLoader = () =>
  createDataLoader(async (userIds: readonly string[]) => {
    // Batch fetch users from database
    const users = await db.users.findMany({
      where: { id: { in: [...userIds] } },
    });

    // Return in same order as requested
    return userIds.map(id => users.find(u => u.id === id) || new Error('Not found'));
  });

builder.queryType({
  fields: t => ({
    posts: t.field({
      type: [Post],
      resolve: async () => db.posts.findMany(),
    }),
  }),
});

const Post = builder.objectRef<{ id: string; authorId: string; title: string }>('Post');

Post.implement({
  fields: t => ({
    id: t.exposeID('id'),
    title: t.exposeString('title'),
    author: t.field({
      type: User,
      resolve: (post, _args, ctx) => {
        // Uses DataLoader to batch user queries
        return ctx.loaders.user.load(post.authorId);
      },
    }),
  }),
});

app.graphqlInit({
  pothosSchema: builder,
  context: async (req, res) => ({
    request: req,
    response: res,
    loaders: {
      user: createUserLoader(),
    },
  }),
});
```

## Configuration Options

```typescript
app.graphqlInit({
  // Schema definition (choose one)
  schema: myGraphQLSchema, // Pre-built GraphQL schema
  typeDefs: '...', // GraphQL SDL
  pothosSchema: builder, // Pothos schema builder

  // Context
  context: async (req, res) => ({
    request: req,
    response: res,
    user: req.auth?.user,
  }),

  // Endpoints
  path: '/graphql', // Default endpoint
  playgroundPath: '/graphql/playground',
  enablePlayground: true, // Disabled in production

  // Performance
  enableJIT: true, // GraphQL-JIT compilation
  jitCacheTTL: 3600000, // 1 hour
  jitCacheMaxSize: 1000, // Max compiled queries cached (oldest evicted)

  // Features
  enableIntrospection: true, // Default: on, except when NODE_ENV=production; an explicit value always wins
  enableSubscriptions: true, // Requires WebSocket

  // Error handling
  debug: false, // Include stack traces in error responses (never when NODE_ENV=production)

  // Query limits (none unless set)
  maxDepth: 10, // Deepest nesting of fields an operation may have
  maxComplexity: 1000, // Most fields an operation may select

  // Value the root resolvers receive as their first argument (default: null)
  rootValue: { version: '1.0.0' },
});
```

### Query depth and complexity limits

`maxDepth` and `maxComplexity` are checked on the parsed document before
anything runs. Neither is set by default.

- **Depth** is the number of nested field levels: `{ user }` is 1,
  `{ user { posts { title } } }` is 3.
- **Complexity** is the number of fields the operation selects. A fragment
  counts every time it is spread.
- Introspection fields (`__typename`, `__schema`, `__type` and what is selected
  under them) are not counted, so the playground's schema query is not affected
  by a low limit. Introspection has its own switch, `enableIntrospection`.
- When a request names an operation (`operationName`), only that operation is
  measured; otherwise every operation in the document is.

A document over a limit is answered like any other invalid document: status
`200` with an `errors` array and no `data`, and no resolver runs.

```json
{
  "errors": [
    {
      "message": "Query depth of 12 exceeds maximum allowed depth of 10",
      "locations": [{ "line": 1, "column": 1 }],
      "extensions": { "code": "QUERY_TOO_DEEP" }
    }
  ]
}
```

The complexity error reads `Query complexity of 1204 exceeds maximum allowed
complexity of 1000` with `extensions.code` `QUERY_TOO_COMPLEX`.

The limits are enforced by the built-in `graphql-js` adapter. A custom
`adapter` receives the same options in `initialize()` and applies its own.

`enableBatching`, `formatError`, `validationRules`, `plugins` and the
per-operation `rateLimit` are accepted by the options type and are not applied
by the built-in endpoint.

## API Reference

### Methods

- `app.graphqlInit(options)` - Configure GraphQL endpoint
- `app.getGraphQLSchema()` - Get the GraphQL schema
- `app.getGraphQLStats()` - Get GraphQL performance stats

### Helpers

- `createPothosBuilder(options)` - Create Pothos schema builder
- `createDataLoader(batchFn, options)` - Create DataLoader instance
- `createComplexityPlugin(options)` / `createDepthLimitPlugin(options)` - plugin
  objects in the `requestDidStart` shape, for a GraphQL server that runs such
  plugins. The built-in endpoint does not run plugins: set `maxDepth` and
  `maxComplexity` instead.

## Best Practices

1. **Use Pothos for TypeScript projects** - Full type inference and safety
2. **Enable GraphQL-JIT in production** - 5-10x performance boost
3. **Use DataLoader for database queries** - Prevents N+1 queries
4. **Set `maxDepth` and `maxComplexity`** - Prevent expensive queries
5. **Disable playground in production** - Security best practice
6. **Use context for auth and request data** - Clean resolver signatures

## Examples

See the `/examples/graphql` directory for complete examples:

- Basic GraphQL server
- Pothos TypeScript-first schema
- Authentication with GraphQL
- Real-time subscriptions
- DataLoader integration
- Production-ready setup
