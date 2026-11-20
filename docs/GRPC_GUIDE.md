# gRPC Guide

Complete guide to gRPC support in MoroJS.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Service Definition](#service-definition)
- [Server Implementation](#server-implementation)
- [Client Usage](#client-usage)
- [Middleware](#middleware)
- [Authentication](#authentication)
- [Error Handling](#error-handling)
- [Advanced Features](#advanced-features)

---

## Overview

MoroJS includes native gRPC support for building high-performance microservices.

Messages travel as standard protobuf: each method uses the serialisers that `@grpc/proto-loader` builds from your `.proto` file. A MoroJS gRPC server therefore answers any gRPC client that has the same `.proto` (stubs generated for other languages, a plain `@grpc/grpc-js` client, health probes), and a client created with `app.createGrpcClient()` calls any gRPC server.

### Features

- **Proto-based Services** - Define services using Protocol Buffers
- **Streaming** - Unary, server streaming, client streaming, bidirectional
- **Middleware** - Authentication, validation, logging
- **Health Checks** - Built-in health check service
- **TLS/SSL** - Secure communication support
- **Interceptors** - grpc-js client interceptors, passed per call

### gRPC Call Types

| Type             | Description                      | Use Case                       |
| ---------------- | -------------------------------- | ------------------------------ |
| Unary            | Single request/response          | REST-like operations           |
| Server Streaming | Single request, stream responses | Data feeds, file downloads     |
| Client Streaming | Stream requests, single response | File uploads, batch operations |
| Bidirectional    | Stream both directions           | Chat, real-time collaboration  |

---

## Getting Started

### Installation

```bash
# Install gRPC dependencies
npm install @grpc/grpc-js @grpc/proto-loader
```

### Quick Start with MoroJS (Recommended)

The easiest way to use gRPC in MoroJS is with the built-in `app.grpcInit()` method:

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

// Configure gRPC - synchronous, no await needed!
app.grpcInit({
  port: 50051,
  host: '0.0.0.0',
  adapter: 'grpc-js',
  enableHealthCheck: true,
});

// Register a service
await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: async (call, callback) => {
    const user = await db.users.findById(call.request.id);
    callback(null, user);
  },
  ListUsers: async call => {
    const users = await db.users.findAll();
    for (const user of users) {
      call.write(user);
    }
    call.end();
  },
});

// Start both HTTP and gRPC servers
app.listen(3000, () => {
  console.log('HTTP: http://localhost:3000');
  console.log('gRPC: localhost:50051');
});
```

The gRPC server listens on every interface (`host: '0.0.0.0'`) and in plaintext unless you say
otherwise. Started that way it logs a warning: calls and their metadata, tokens included, are
unencrypted, and any host that can reach the port can call the services. There are two ways out,
and either one removes the warning: set `host: '127.0.0.1'` to accept local connections only, or
set `credentials` to serve TLS (see [TLS/SSL](#tlsssl)). TLS encrypts the calls; to also decide
who may connect, give `rootCerts` and `requireClientCert: true`, and only clients holding a
certificate you issued are let in.

---

## Service Definition

### Proto File Structure

Create a `.proto` file defining your service:

```protobuf
syntax = "proto3";

package user;

service UserService {
  // Unary call
  rpc GetUser (GetUserRequest) returns (User) {}

  // Server streaming
  rpc ListUsers (ListUsersRequest) returns (stream User) {}

  // Client streaming
  rpc CreateUsers (stream CreateUserRequest) returns (CreateUsersResponse) {}

  // Bidirectional streaming
  rpc Chat (stream ChatMessage) returns (stream ChatMessage) {}
}

message GetUserRequest {
  string id = 1;
}

message User {
  string id = 1;
  string name = 2;
  string email = 3;
  int32 age = 4;
}

message ListUsersRequest {
  int32 page = 1;
  int32 limit = 2;
}

message CreateUserRequest {
  string name = 1;
  string email = 2;
}

message CreateUsersResponse {
  int32 created = 1;
  repeated string ids = 2;
}

message ChatMessage {
  string user_id = 1;
  string message = 2;
  int64 timestamp = 3;
}
```

### Messages in JavaScript

Handlers and clients exchange plain objects. Their shape follows the `.proto`:

- Field names are the ones in the `.proto` (`user_id`, not `userId`).
- `int64` and the other 64-bit integer types arrive as strings (`'9007199254740993'`), so that values beyond `Number.MAX_SAFE_INTEGER` survive. When sending, a number or a string is accepted.
- Enum values arrive as their names (`'ACTIVE'`).
- `bytes` fields are `Buffer`s, `repeated` fields are arrays and `map` fields are objects.
- A field that was not set arrives with its default (`''`, `0`, `'0'`, `[]`, the first enum value), except a nested message, which is `null`.

```typescript
// rpc Chat (stream ChatMessage) returns (stream ChatMessage) {}
call.on('data', message => {
  message.user_id; // '123'
  message.timestamp; // '1767225600000' (int64: a string)
});
```

---

## Server Implementation

Handlers are registered under the method's name in the `.proto` (`GetUser`) or its lower-camel-case form (`getUser`). A key that matches no method of the service is reported in a start-up warning and never called; a method without a handler answers `UNIMPLEMENTED`.

### Unary RPC

Single request, single response.

```typescript
import { createApp } from '@morojs/moro';
import * as grpc from '@grpc/grpc-js';

const app = await createApp();

app.grpcInit({
  port: 50051,
  enableHealthCheck: true,
});

await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: async (call, callback) => {
    try {
      const { id } = call.request;

      // Fetch from database
      const user = await db.users.findById(id);

      if (!user) {
        return callback({
          code: grpc.status.NOT_FOUND,
          message: 'User not found',
        });
      }

      callback(null, user);
    } catch (error) {
      callback({
        code: grpc.status.INTERNAL,
        message: error.message,
      });
    }
  },
});

app.listen(3000);
```

### Server Streaming RPC

Single request, stream of responses.

```typescript
{
  ListUsers: async call => {
    const { page, limit } = call.request;

    // If this throws, the stream ends with an error status
    // (the error's gRPC `code` when it has one, normally INTERNAL otherwise)
    const users = await db.users
      .find()
      .skip(page * limit)
      .limit(limit);

    // Stream each user
    for (const user of users) {
      call.write({
        id: user.id,
        name: user.name,
        email: user.email,
        age: user.age,
      });
    }

    // End stream
    call.end();
  };
}
```

### Client Streaming RPC

Stream of requests, single response.

```typescript
{
  CreateUsers: async (call, callback) => {
    const users = [];

    // Receive user data stream
    call.on('data', userData => {
      users.push(userData);
    });

    call.on('end', async () => {
      try {
        // Bulk insert
        const result = await db.users.insertMany(users);

        callback(null, {
          created: result.length,
          ids: result.map(u => u.id),
        });
      } catch (error) {
        callback({
          code: grpc.status.INTERNAL,
          message: error.message,
        });
      }
    });

    call.on('error', error => {
      console.error('Stream error:', error);
    });
  };
}
```

### Bidirectional Streaming RPC

Stream both requests and responses.

```typescript
{
  Chat: async call => {
    const userId = call.metadata.get('user-id');

    // Receive messages
    call.on('data', message => {
      console.log(`User ${userId}: ${message.message}`);

      // Broadcast to other clients
      broadcastToRoom(message);

      // Echo back confirmation
      call.write({
        user_id: 'system',
        message: `Message received: ${message.message}`,
        timestamp: Date.now(),
      });
    });

    call.on('end', () => {
      call.end();
    });

    call.on('error', error => {
      console.error('Chat error:', error);
    });
  };
}
```

---

## Client Usage

### Creating a Client

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

app.grpcInit({ port: 50051 });

// Create a gRPC client. Without `credentials` the connection is plaintext;
// for TLS pass { credentials: { rootCerts, privateKey, certChain } } (see TLS/SSL).
const client = await app.createGrpcClient('./proto/users.proto', 'UserService', 'localhost:50051');

// Use the client
const user = await client.GetUser({ id: '123' });

console.log(user.name);
```

The client has one method per RPC, under its name in the `.proto` (`client.GetUser`) and its lower-camel-case form (`client.getUser`). The service name may be given with its package (`'user.UserService'`).

### Unary Call

A unary method called without a callback returns a promise. It resolves to the response and rejects with the grpc-js error, which carries the status `code`, the `details` text and the trailing `metadata`.

```typescript
import * as grpc from '@grpc/grpc-js';

try {
  const response = await client.GetUser({ id: '123' });
  console.log(response.name);
} catch (error) {
  if (error.code === grpc.status.NOT_FOUND) {
    console.log('No such user:', error.details);
  }
}

// Metadata and call options follow the request, as in grpc-js
const metadata = new grpc.Metadata();
metadata.add('x-request-id', 'abc-123');
const user = await client.GetUser({ id: '123' }, metadata, { deadline: Date.now() + 5000 });
```

With a callback as the last argument the method behaves exactly as in grpc-js, and returns the call object (which can be cancelled) instead of a promise:

```typescript
const call = client.GetUser({ id: '123' }, (error, response) => {
  if (error) return console.error(error.code, error.details);
  console.log(response.name);
});
```

Streaming methods return the grpc-js call stream, not a promise.

### Server Streaming Call

```typescript
const call = client.ListUsers({ page: 0, limit: 10 });

call.on('data', user => {
  console.log('Received user:', user.name);
});

call.on('end', () => {
  console.log('Stream ended');
});

call.on('error', error => {
  console.error('Stream error:', error);
});
```

The stream is also async-iterable; a failed call rejects the loop:

```typescript
for await (const user of client.ListUsers({ page: 0, limit: 10 })) {
  console.log('Received user:', user.name);
}
```

### Client Streaming Call

```typescript
const call = client.CreateUsers((error, response) => {
  if (error) {
    console.error('Error:', error);
  } else {
    console.log(`Created ${response.created} users`);
  }
});

// Send user data
call.write({ name: 'Alice', email: 'alice@example.com' });
call.write({ name: 'Bob', email: 'bob@example.com' });
call.write({ name: 'Charlie', email: 'charlie@example.com' });

// End stream
call.end();
```

### Bidirectional Streaming Call

```typescript
const call = client.Chat();

// Send messages
call.write({
  user_id: '123',
  message: 'Hello!',
  timestamp: Date.now(),
});

// Receive messages
call.on('data', message => {
  console.log(`${message.user_id}: ${message.message}`);
});

call.on('end', () => {
  console.log('Chat ended');
});
```

---

## Middleware

Each middleware factory returns an `async (call, callback?)` function. To attach middleware to a method, register an array: every element before the last runs in order as middleware, and the last element is the handler. A middleware stops the call by throwing or by answering through `callback`, and the handler then never runs. A middleware also receives `next` as a third argument: one that wraps the rest of the call (a logger, a timer) awaits `next()`, which runs the remaining middleware and the handler; one that does not call it is simply followed by the next element.

### Authentication Middleware

```typescript
import { grpcAuth, grpcRequireRole } from '@morojs/moro';

// `verify` receives the bearer token from the `authorization` metadata and
// resolves to the user. A rejection or a falsy result is UNAUTHENTICATED.
const auth = grpcAuth({
  verify: async token => verifyJWT(token, process.env.JWT_SECRET),
});

await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: [
    auth,
    async (call, callback) => {
      // The verified user is attached to the call as `user`
      const user = await db.users.findOne({ id: call.request.id });
      callback(null, user);
    },
  ],

  DeleteUser: [
    auth,
    grpcRequireRole('admin'),
    async (call, callback) => {
      // Only admins can delete users
      await db.users.deleteOne({ id: call.request.id });
      callback(null, { success: true });
    },
  ],
});
```

### Validation Middleware

```typescript
import { grpcValidate } from '@morojs/moro';
import { z } from 'zod';

const GetUserSchema = z.object({
  id: z.string().uuid(),
});

await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: [
    grpcValidate({ request: GetUserSchema }),
    async (call, callback) => {
      // call.request is the parsed value; an invalid request is answered
      // with INVALID_ARGUMENT and never reaches this handler
      const user = await db.users.findOne({ id: call.request.id });
      callback(null, user);
    },
  ],
});
```

### Logging Middleware

`grpcLogger` wraps the rest of the call, so put it first in the array: it logs when the call arrives and again when the remaining middleware and the handler have finished, with the elapsed time, or the failure if one of them throws.

```typescript
import { grpcLogger } from '@morojs/moro';

await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: [
    grpcLogger({
      logRequest: true, // request message, at debug level
      logResponse: true, // response of unary and client-streaming calls, at debug level
      logMetadata: true, // call metadata, at debug level (credential values are redacted)
    }),
    async (call, callback) => {
      const user = await db.users.findOne({ id: call.request.id });
      callback(null, user);
    },
  ],
});
```

`logRequest` and `logResponse` do not write messages whole:

- the value of a field whose name contains `authorization`, `cookie`, `token`, `secret`,
  `password` or `api-key` / `apiKey` / `api_key`, at any depth, is logged as `[REDACTED]`;
- a `bytes` field is logged as its size (`[4096 bytes]`);
- the text is cut at `maxBodyLength` characters (default 2048), followed by how many were left out.

Pass `fullBodies: true` to log messages whole and as they are, for example while debugging
locally. `grpcDetailedLogger()` is `grpcLogger()` with the three `log*` options on and the same
redaction and length limit.

```typescript
grpcLogger({ logRequest: true, maxBodyLength: 500 }); // shorter
grpcLogger({ logRequest: true, logResponse: true, fullBodies: true }); // everything, unredacted
```

---

## Authentication

### Token-Based Auth

```typescript
import { grpcAuth } from '@morojs/moro';

// Server side
await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: [
    // The token is read from the `authorization` metadata ("Bearer <token>").
    // `verify` is required: without it every call is rejected as UNAUTHENTICATED.
    grpcAuth({
      verify: async token => {
        return await verifyJWT(token, process.env.JWT_SECRET);
      },
    }),
    async (call, callback) => {
      console.log('Authenticated user:', call.user);
      const user = await db.users.findOne({ id: call.request.id });
      callback(null, user);
    },
  ],
});

// Client side
const metadata = new grpc.Metadata();
metadata.add('authorization', `Bearer ${token}`);

client.GetUser({ id: '123' }, metadata, (error, response) => {
  // ...
});
```

### Role-Based Access

`grpcRequireRole` and `grpcRequirePermission` check the user that `grpcAuth` attached, so `grpcAuth` goes before them. Roles are read from `user.roles` (or `user.role`) and permissions from `user.permissions`, and are matched exactly.

```typescript
import { grpcAuth, grpcRequireRole, grpcRequirePermission } from '@morojs/moro';

const auth = grpcAuth({
  verify: async token => verifyJWT(token, process.env.JWT_SECRET),
});

await app.grpcService('./proto/users.proto', 'UserService', {
  // Requires 'admin' role
  DeleteUser: [
    auth,
    grpcRequireRole('admin'),
    async (call, callback) => {
      await db.users.deleteOne({ id: call.request.id });
      callback(null, { success: true });
    },
  ],

  // Requires specific permission
  UpdateUser: [
    auth,
    grpcRequirePermission('users:write'),
    async (call, callback) => {
      const updated = await db.users.updateOne({ id: call.request.id }, call.request.updates);
      callback(null, updated);
    },
  ],
});
```

---

## Error Handling

### Standard Error Codes

```typescript
import * as grpc from '@grpc/grpc-js';

{
  GetUser: async (call, callback) => {
    try {
      const user = await db.users.findOne({ id: call.request.id });

      if (!user) {
        return callback({
          code: grpc.status.NOT_FOUND,
          message: 'User not found',
        });
      }

      callback(null, user);
    } catch (error) {
      callback({
        code: grpc.status.INTERNAL,
        message: 'Internal server error',
      });
    }
  };
}
```

### Thrown Errors

A handler or middleware that throws ends the call with an error status: the error's own `code` when it is a gRPC status code (1 to 16), normally `INTERNAL` otherwise. The error's message becomes the status details, and a `metadata` property (a `grpc.Metadata`) is sent as trailing metadata. In a streaming handler the stream ends with that status.

```typescript
{
  GetUser: async (call, callback) => {
    const user = await db.users.findOne({ id: call.request.id });

    if (!user) {
      throw Object.assign(new Error('User not found'), { code: grpc.status.NOT_FOUND });
    }

    callback(null, user);
  };
}
```

With `NODE_ENV=production`, a thrown error that carries no gRPC status code of its own reaches the client without its message: the status code is the one it would have had, the details are that status's standard text (`Internal server error` for `INTERNAL`), and the error is logged on the server with its message and stack. An exception's text can hold a file path, a query or a connection string, which a client has no use for. An error you gave a `code`, as above, and a status object passed to `callback()` keep their message in every environment: that text is yours, written for the client. Outside production the message of every thrown error is sent.

### Common Status Codes

| Code                  | Use Case                   |
| --------------------- | -------------------------- |
| `OK`                  | Successful response        |
| `CANCELLED`           | Operation cancelled        |
| `INVALID_ARGUMENT`    | Invalid request parameters |
| `NOT_FOUND`           | Resource not found         |
| `ALREADY_EXISTS`      | Resource already exists    |
| `PERMISSION_DENIED`   | Insufficient permissions   |
| `UNAUTHENTICATED`     | Authentication required    |
| `RESOURCE_EXHAUSTED`  | Rate limit exceeded        |
| `FAILED_PRECONDITION` | Precondition not met       |
| `INTERNAL`            | Server error               |
| `UNAVAILABLE`         | Service unavailable        |
| `UNIMPLEMENTED`       | Method not implemented     |

### Error with Metadata

```typescript
const metadata = new grpc.Metadata();
metadata.set('error-code', 'USER_ID_INVALID');
metadata.set('field', 'id');

callback({
  code: grpc.status.INVALID_ARGUMENT,
  message: 'Invalid user ID',
  metadata,
});
```

---

## Advanced Features

### Health Checks

```typescript
app.grpcInit({
  port: 50051,
  enableHealthCheck: true, // the default
});

// The Health service is registered automatically. It is the standard
// grpc.health.v1.Health service (Check and Watch), so gRPC health probes can
// call it. It always reports SERVING, whatever service name is asked for.
```

### TLS/SSL

```typescript
import * as fs from 'fs';

// Server
app.grpcInit({
  port: 50051,
  credentials: {
    privateKey: fs.readFileSync('./key.pem'),
    certChain: fs.readFileSync('./cert.pem'),
  },
});

// Server that only accepts clients with a certificate signed by ca.pem (mutual TLS)
app.grpcInit({
  port: 50051,
  credentials: {
    privateKey: fs.readFileSync('./key.pem'),
    certChain: fs.readFileSync('./cert.pem'),
    rootCerts: fs.readFileSync('./ca.pem'),
    requireClientCert: true,
  },
});

// Client: `credentials` takes the PEM contents
const client = await app.createGrpcClient('./proto/users.proto', 'UserService', 'localhost:50051', {
  credentials: {
    rootCerts: fs.readFileSync('./ca.pem'),
    privateKey: fs.readFileSync('./client-key.pem'),
    certChain: fs.readFileSync('./client-cert.pem'),
  },
});
```

A server without `credentials` listens in plaintext, and a client without `credentials` opens a plaintext connection; the two sides have to agree. On the client, `rootCerts` is the CA that signed the server's certificate (leave it out to use the system's root certificates), and `privateKey` and `certChain` are only needed when the server asks for a client certificate.

On the server, `requireClientCert: true` makes the server ask every client for a certificate and refuse one that presents none, or one that `rootCerts` did not sign. It is off by default: with `rootCerts` alone a client certificate is not asked for. The option was first named `checkServerIdentity`; that name is still read when `requireClientCert` is not set, and `requireClientCert` wins when both are.

From JavaScript, where the option is not type-checked, the client also takes `credentials: 'insecure'` (plaintext) and a grpc-js channel credentials object such as `grpc.credentials.createSsl(...)`, which is used as given.

### Message Size Limits

```typescript
app.grpcInit({
  port: 50051,
  maxReceiveMessageLength: 10 * 1024 * 1024, // 10MB
  maxSendMessageLength: 10 * 1024 * 1024, // 10MB
});
```

### Interceptors

```typescript
const loggingInterceptor = (options, nextCall) => {
  return new grpc.InterceptingCall(nextCall(options), {
    start: (metadata, listener, next) => {
      console.log('Request started');
      next(metadata, {
        onReceiveMessage: (message, next) => {
          console.log('Received message:', message);
          next(message);
        },
      });
    },
  });
};

client.GetUser({ id: '123' }, { interceptors: [loggingInterceptor] }, callback);
```

---

## Integration with MoroJS

### With HTTP Server

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

app.grpcInit({ port: 50051 });

// gRPC endpoints
await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: async (call, callback) => {
    const user = await db.users.findById(call.request.id);
    callback(null, user);
  },
});

// HTTP endpoints
app.get('/api/users/:id', async (req, res) => {
  const user = await db.users.findById(req.params.id);
  return user;
});

// Starts the HTTP server, and the gRPC server with it
app.listen(3000, () => {
  console.log('HTTP server on port 3000');
  console.log('gRPC server on port 50051');
});
```

### Service Discovery

```typescript
// Register a service
await app.grpcService('./proto/users.proto', 'UserService', implementation);

// List what is registered: [{ serviceName, methods }]
const services = app.getGrpcServices();
console.log('Available services:', services);
```

### Metrics

```typescript
// Get gRPC metrics (null until the gRPC server has started)
const stats = app.getGrpcStats();

if (stats) {
  console.log(`Total Calls: ${stats.totalCalls}`);
  console.log(`Active Calls: ${stats.activeCalls}`);
  console.log(`Failed Calls: ${stats.failedCalls}`);
}
```

---

## Best Practices

### 1. Proto File Organization

```
protos/
  ├── user/
  │   ├── user.proto
  │   └── user_service.proto
  ├── auth/
  │   └── auth.proto
  └── common/
      ├── types.proto
      └── errors.proto
```

### 2. Error Handling

Always handle errors properly:

```typescript
{
  GetUser: async (call, callback) => {
    try {
      const user = await db.users.findOne({ id: call.request.id });

      if (!user) {
        return callback({
          code: grpc.status.NOT_FOUND,
          message: `User ${call.request.id} not found`,
        });
      }

      callback(null, user);
    } catch (error) {
      console.error('GetUser failed:', error);

      callback({
        code: grpc.status.INTERNAL,
        message: 'Failed to fetch user',
      });
    }
  };
}
```

### 3. Use Streaming for Large Data

```typescript
// Instead of returning large arrays
{
  ListAllUsers: async call => {
    const stream = db.users.find().stream();

    stream.on('data', user => {
      call.write(user);
    });

    stream.on('end', () => {
      call.end();
    });
  };
}
```

### 4. Implement Health Checks

```typescript
app.grpcInit({
  port: 50051,
  enableHealthCheck: true,
});

// Monitor health
setInterval(async () => {
  const healthy = await checkServiceHealth();
  if (!healthy) {
    await alertOps('gRPC service unhealthy');
  }
}, 60000);
```

### 5. Use Connection Pooling

```typescript
// Reuse clients: create each one once and keep it
const clientPool = new Map();

async function getClient(protoPath, serviceName, address) {
  const key = `${serviceName}@${address}`;
  if (!clientPool.has(key)) {
    clientPool.set(key, await app.createGrpcClient(protoPath, serviceName, address));
  }
  return clientPool.get(key);
}
```

---

## MoroJS API Reference

### `app.grpcInit(options)`

Configure gRPC server (synchronous, lazy initialization).

**Parameters:**

- `options.port` (number) - gRPC server port (default: 50051)
- `options.host` (string) - Server host (default: '0.0.0.0'; a warning is logged when the server listens on an address other than loopback without `credentials`)
- `options.adapter` (string) - gRPC adapter (`'grpc-js'`, the only one shipped)
- `options.enableHealthCheck` (boolean) - Enable health check service (default: true)
- `options.maxReceiveMessageLength` (number) - Max received message size in bytes (default: 4 MB)
- `options.maxSendMessageLength` (number) - Max sent message size in bytes (default: 4 MB)
- `options.credentials` - TLS credentials `{ privateKey, certChain, rootCerts, requireClientCert }` (PEM buffers); omit to listen in plaintext
- `options.enableReflection`, `options.compression` - Accepted but not implemented: setting either logs a warning at start-up and has no effect

**Returns:** `this` (chainable)

**Example:**

```typescript
app.grpcInit({
  port: 50051,
  host: '0.0.0.0',
  adapter: 'grpc-js',
  enableHealthCheck: true,
  maxReceiveMessageLength: 4 * 1024 * 1024, // 4MB
  maxSendMessageLength: 4 * 1024 * 1024,
});
```

### `app.grpcService(protoPath, serviceName, implementation, packageName?)`

Register a gRPC service from a proto file.

**Parameters:**

- `protoPath` (string) - Path to .proto file
- `serviceName` (string) - Name of the service, with or without its package (`'UserService'` or `'user.UserService'`)
- `implementation` (object) - Service method implementations, keyed by method name (`GetUser` or `getUser`)
- `packageName` (string, optional) - Package name if not in proto. When the file defines a service of that name in more than one package, the package to take it from

**Returns:** `Promise<void>`

**Example:**

```typescript
await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: async (call, callback) => {
    const user = await db.users.findById(call.request.id);
    callback(null, user);
  },
  ListUsers: async call => {
    const users = await db.users.findAll();
    for (const user of users) {
      call.write(user);
    }
    call.end();
  },
});
```

### `app.createGrpcClient(protoPath, serviceName, address, options?)`

Create a gRPC client for calling remote services.

**Parameters:**

- `protoPath` (string) - Path to .proto file
- `serviceName` (string) - Name of the service, with or without its package
- `address` (string) - Server address (host:port)
- `options` (object, optional) - Client options
  - `credentials` - TLS credentials `{ rootCerts, privateKey, certChain }` (PEM buffers); omit for a plaintext connection
  - `maxReceiveMessageLength` (number) - defaults to the value given to `app.grpcInit()`
  - `maxSendMessageLength` (number) - defaults to the value given to `app.grpcInit()`
  - `channelOptions` (object) - grpc-js channel arguments, such as `{ 'grpc.keepalive_time_ms': 30000 }`
  - `deadline`, `interceptors` - Accepted but not implemented: setting either logs a warning and has no effect. Pass them per call instead: `client.GetUser(request, { deadline })`

**Returns:** `Promise<GrpcClient>`

**Example:**

```typescript
const client = await app.createGrpcClient('./proto/users.proto', 'UserService', 'localhost:50051');

// Unary call: a promise without a callback
const user = await client.GetUser({ id: '123' });

// ...or grpc-js style, with a callback
client.GetUser({ id: '123' }, (error, response) => {
  if (error) {
    console.error(error);
  } else {
    console.log(response);
  }
});

// Release the connection when the client is no longer needed
client.close();
```

### `app.startGrpc()`

Start the gRPC server manually. Called automatically by `app.listen()`.

**Returns:** `Promise<void>`

### `app.stopGrpc()`

Stop the gRPC server gracefully: it stops accepting new calls and waits for the calls in progress to finish, open streams included. `app.close()` calls it.

**Returns:** `Promise<void>`

### `app.getGrpcServices()`

Get list of registered gRPC services.

**Returns:** `ServiceRegistration[]` (`{ serviceName, methods }`)

---

## Troubleshooting

### Connection Refused

Check server is running and port is correct. Server reflection is not implemented, so `grpcurl ... list` cannot discover the services; check the port instead:

```bash
# Is anything listening on the gRPC port?
nc -z localhost 50051 && echo "port open"
```

### Proto Loading Errors

Verify proto file path and syntax. Proto files are loaded with these `@grpc/proto-loader` options, which `app.grpcService()` does not let you change (see [Messages in JavaScript](#messages-in-javascript) for what they mean for your handlers):

```typescript
const protoOptions = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};
```

### Authentication Failures

Check metadata is properly set:

```typescript
const metadata = new grpc.Metadata();
metadata.add('authorization', `Bearer ${token}`);
```

### Stream Errors

Handle stream lifecycle properly:

```typescript
call.on('error', error => {
  console.error('Stream error:', error);
});

call.on('end', () => {
  console.log('Stream completed');
});
```

---

## API Reference

For complete type definitions and API details, see:

- [API Reference](./API.md) - Complete API documentation
- [Types Reference](../src/core/grpc/types.ts) - TypeScript type definitions

---

**Need help?** Join our [Discord community](https://morojs.com/discord) or [open an issue](https://github.com/Moro-JS/moro/issues).
