# Init Pattern - Configuration Methods

## Overview

MoroJS uses a consistent `Init` pattern for all system configuration methods. This provides better DX with synchronous, chainable configuration and lazy initialization.

## Pattern

### Before (Old Pattern)

```typescript
// Required await - poor DX
await app.grpc({ port: 50051 });
await app.mail({ adapter: 'console' });
await app.queue('emails', { adapter: 'bull' });
```

### After (Init Pattern)

```typescript
// Synchronous, chainable - great DX!
app.grpcInit({ port: 50051 });
app.mailInit({ adapter: 'console' });
app.queueInit('emails', { adapter: 'bull' });
```

## Benefits

1. **Synchronous**: No `await` needed for configuration
2. **Chainable**: Returns `this` for method chaining
3. **Lazy Initialization**: Systems initialize on first use
4. **Clear Intent**: `Init` suffix makes it obvious this is configuration
5. **Consistent**: All init methods follow the same pattern
6. **Moro-like**: Matches framework patterns like `use()`, `get()`, `post()`

## Configuration Methods

### `app.mailInit(config)`

Configure the email system.

```typescript
app.mailInit({
  adapter: 'nodemailer',
  from: 'noreply@myapp.com',
  connection: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  },
});

// System initializes automatically on first email send
await app.sendMail({ to: 'user@example.com', subject: 'Hi', text: 'Hello!' });
```

### `app.graphqlInit(options)`

Configure GraphQL endpoint.

```typescript
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

// GraphQL initializes on server start
app.listen(3000);
// Access at http://localhost:3000/graphql
```

### `app.grpcInit(options)`

Configure gRPC server.

```typescript
app.grpcInit({
  port: 50051,
  host: '0.0.0.0',
  adapter: 'grpc-js',
  enableHealthCheck: true,
  enableReflection: true,
});

// Register services
await app.grpcService('./proto/users.proto', 'UserService', {
  getUser: async (call, callback) => {
    callback(null, { id: '1', name: 'Alice' });
  },
});

// gRPC starts with HTTP server
app.listen(3000);
```

### `app.queueInit(name, options)`

Configure a queue.

```typescript
app.queueInit('emails', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379,
  },
  concurrency: 5,
});

// Process queue
await app.processQueue('emails', async job => {
  await sendEmail(job.data);
});

// Add jobs
await app.addToQueue('emails', {
  to: 'user@example.com',
  subject: 'Welcome',
});
```

## Lazy Initialization

All init methods store configuration and defer actual initialization:

- **`mailInit()`**: Initializes on first `sendMail()` call
- **`graphqlInit()`**: Initializes when server starts via `listen()`
- **`grpcInit()`**: Initializes when server starts via `listen()`
- **`queueInit()`**: Initializes on first queue operation (`addToQueue()`, `processQueue()`)

This approach:

- Reduces startup time
- Only loads dependencies you actually use
- Provides better error messages (knows what you're trying to do)
- Maintains clean, synchronous configuration API

## Migration from Old Pattern

If you have existing code using the old pattern, you can migrate easily:

```typescript
// Old
await app.grpc({ port: 50051 });
await app.mail({ adapter: 'console' });
await app.queue('emails', { adapter: 'memory' });

// New
app.grpcInit({ port: 50051 });
app.mailInit({ adapter: 'console' });
app.queueInit('emails', { adapter: 'memory' });
```

The old methods are marked as `@deprecated` but still work for backwards compatibility.

## Complete Example

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

// Configure all systems - synchronous, no await!
app.mailInit({
  adapter: 'sendgrid',
  from: 'noreply@myapp.com',
  connection: { apiKey: process.env.SENDGRID_API_KEY },
});

app.graphqlInit({
  typeDefs: `type Query { hello: String! }`,
  resolvers: { Query: { hello: () => 'Hello!' } },
});

app.grpcInit({
  port: 50051,
  enableHealthCheck: true,
});

app.queueInit('jobs', {
  adapter: 'bull',
  connection: { host: 'localhost', port: 6379 },
});

// Define routes
app.get('/').handler(async (req, res) => {
  // Send email - mail system initializes automatically
  await app.sendMail({
    to: 'user@example.com',
    subject: 'Welcome',
    text: 'Hello!',
  });

  // Add to queue - queue system initializes automatically
  await app.addToQueue('jobs', { type: 'process-data' });

  return { message: 'Done!' };
});

// Start server - GraphQL and gRPC initialize automatically
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
  console.log('GraphQL: http://localhost:3000/graphql');
  console.log('gRPC: localhost:50051');
});
```

## Benefits Summary

✅ **Better DX**: No `await` clutter in configuration
✅ **Faster Startup**: Lazy initialization only loads what you use
✅ **Clear Intent**: `Init` suffix makes purpose obvious
✅ **Consistent**: All systems use the same pattern
✅ **Type-Safe**: Full TypeScript support
✅ **Error-Friendly**: Better error messages when misconfigured
✅ **Chainable**: Can chain methods (though not required)
✅ **Moro-like**: Matches framework's API design philosophy
