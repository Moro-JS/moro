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
  websocket: true, // Enable WebSocket support
});

const builder = createPothosBuilder();

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
    providers: [providers.GitHub({ clientId: '...', clientSecret: '...' })],
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
const builder = createPothosBuilder();

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

  // Features
  enableIntrospection: true, // Disabled in production
  enableSubscriptions: true, // Requires WebSocket
  enableBatching: true, // Query batching

  // Error handling
  formatError: error => ({
    message: error.message,
    // Hide internal errors in production
  }),
  debug: false, // Include stack traces

  // Security
  maxDepth: 10, // Query depth limit
  maxComplexity: 1000, // Query complexity limit

  // Rate limiting (per operation type)
  rateLimit: {
    queries: { requests: 100, window: 60000 },
    mutations: { requests: 20, window: 60000 },
  },
});
```

## API Reference

### Methods

- `app.graphqlInit(options)` - Configure GraphQL endpoint
- `app.getGraphQLSchema()` - Get the GraphQL schema
- `app.getGraphQLStats()` - Get GraphQL performance stats

### Helpers

- `createPothosBuilder(options)` - Create Pothos schema builder
- `createDataLoader(batchFn, options)` - Create DataLoader instance
- `createComplexityPlugin(options)` - Query complexity analyzer
- `createDepthLimitPlugin(options)` - Query depth limiter

## Best Practices

1. **Use Pothos for TypeScript projects** - Full type inference and safety
2. **Enable GraphQL-JIT in production** - 5-10x performance boost
3. **Use DataLoader for database queries** - Prevents N+1 queries
4. **Set depth and complexity limits** - Prevent expensive queries
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
