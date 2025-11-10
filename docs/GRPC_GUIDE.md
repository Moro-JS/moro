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

### Features

- **Proto-based Services** - Define services using Protocol Buffers
- **Streaming** - Unary, server streaming, client streaming, bidirectional
- **Middleware** - Authentication, validation, logging
- **Health Checks** - Built-in health check service
- **Reflection** - Server reflection for debugging
- **TLS/SSL** - Secure communication support
- **Interceptors** - Request/response interception

### gRPC Call Types

| Type | Description | Use Case |
|------|-------------|----------|
| Unary | Single request/response | REST-like operations |
| Server Streaming | Single request, stream responses | Data feeds, file downloads |
| Client Streaming | Stream requests, single response | File uploads, batch operations |
| Bidirectional | Stream both directions | Chat, real-time collaboration |

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

const app = createApp();

// Configure gRPC - synchronous, no await needed!
app.grpcInit({
  port: 50051,
  host: '0.0.0.0',
  adapter: 'grpc-js',
  enableHealthCheck: true,
  enableReflection: true
});

// Register a service
await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: async (call, callback) => {
    const user = await db.users.findById(call.request.id);
    callback(null, user);
  },
  ListUsers: async (call) => {
    const users = await db.users.findAll();
    for (const user of users) {
      call.write(user);
    }
    call.end();
  }
});

// Start both HTTP and gRPC servers
app.listen(3000, () => {
  console.log('HTTP: http://localhost:3000');
  console.log('gRPC: localhost:50051');
});
```

### Low-Level API (Advanced)

For more control, you can use the `GrpcManager` directly:

```typescript
import { GrpcManager } from '@morojs/moro';

const grpcManager = new GrpcManager({
  port: 50051,
  host: '0.0.0.0'
});

// Initialize
await grpcManager.initialize();

// Register a service
await grpcManager.registerService(
  './protos/user.proto',
  'UserService',
  {
    GetUser: async (call, callback) => {
      const user = await db.users.findById(call.request.id);
      callback(null, user);
    }
  }
);

// Start server
await grpcManager.start();
```

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

---

## Server Implementation

### Unary RPC

Single request, single response.

**Using MoroJS Integration:**

```typescript
import { createApp } from '@morojs/moro';

const app = createApp();

app.grpcInit({
  port: 50051,
  enableHealthCheck: true
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
          message: 'User not found'
        });
      }

      callback(null, user);
    } catch (error) {
      callback({
        code: grpc.status.INTERNAL,
        message: error.message
      });
    }
  }
});

app.listen(3000);
```

**Using Low-Level API:**

```typescript
await grpcManager.registerService(
  './protos/user.proto',
  'UserService',
  {
    GetUser: async (call, callback) => {
      try {
        const { id } = call.request;

        const user = await db.users.findOne({ id });

        if (!user) {
          return callback({
            code: grpc.status.NOT_FOUND,
            message: 'User not found'
          });
        }

        callback(null, {
          id: user.id,
          name: user.name,
          email: user.email,
          age: user.age
        });
      } catch (error) {
        callback({
          code: grpc.status.INTERNAL,
          message: error.message
        });
      }
    }
  }
);
```

### Server Streaming RPC

Single request, stream of responses.

```typescript
{
  ListUsers: async (call) => {
    const { page, limit } = call.request;

    try {
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
          age: user.age
        });
      }

      // End stream
      call.end();
    } catch (error) {
      call.destroy(error);
    }
  }
}
```

### Client Streaming RPC

Stream of requests, single response.

```typescript
{
  CreateUsers: async (call, callback) => {
    const users = [];

    // Receive user data stream
    call.on('data', (userData) => {
      users.push(userData);
    });

    call.on('end', async () => {
      try {
        // Bulk insert
        const result = await db.users.insertMany(users);

        callback(null, {
          created: result.length,
          ids: result.map(u => u.id)
        });
      } catch (error) {
        callback({
          code: grpc.status.INTERNAL,
          message: error.message
        });
      }
    });

    call.on('error', (error) => {
      console.error('Stream error:', error);
    });
  }
}
```

### Bidirectional Streaming RPC

Stream both requests and responses.

```typescript
{
  Chat: async (call) => {
    const userId = call.metadata.get('user-id');

    // Receive messages
    call.on('data', (message) => {
      console.log(`User ${userId}: ${message.message}`);

      // Broadcast to other clients
      broadcastToRoom(message);

      // Echo back confirmation
      call.write({
        user_id: 'system',
        message: `Message received: ${message.message}`,
        timestamp: Date.now()
      });
    });

    call.on('end', () => {
      call.end();
    });

    call.on('error', (error) => {
      console.error('Chat error:', error);
    });
  }
}
```

---

## Client Usage

### Creating a Client

**Using MoroJS Integration:**

```typescript
import { createApp } from '@morojs/moro';

const app = createApp();

// Create a gRPC client
const client = await app.createGrpcClient(
  './proto/users.proto',
  'UserService',
  'localhost:50051',
  {
    credentials: 'insecure' // or provide TLS credentials
  }
);

// Use the client
const user = await new Promise((resolve, reject) => {
  client.GetUser({ id: '123' }, (error, response) => {
    if (error) reject(error);
    else resolve(response);
  });
});

console.log(user.name);
```

**Using Low-Level API:**

```typescript
const client = await grpcManager.createClient(
  './protos/user.proto',
  'UserService',
  'localhost:50051',
  {
    credentials: grpc.credentials.createInsecure()
  }
);
```

### Unary Call

```typescript
const response = await new Promise((resolve, reject) => {
  client.GetUser({ id: '123' }, (error, response) => {
    if (error) return reject(error);
    resolve(response);
  });
});

console.log(response.name);
```

### Server Streaming Call

```typescript
const call = client.ListUsers({ page: 0, limit: 10 });

call.on('data', (user) => {
  console.log('Received user:', user.name);
});

call.on('end', () => {
  console.log('Stream ended');
});

call.on('error', (error) => {
  console.error('Stream error:', error);
});
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
  timestamp: Date.now()
});

// Receive messages
call.on('data', (message) => {
  console.log(`${message.user_id}: ${message.message}`);
});

call.on('end', () => {
  console.log('Chat ended');
});
```

---

## Middleware

### Authentication Middleware

```typescript
import { grpcAuth, grpcRequireRole } from '@morojs/moro';

await grpcManager.registerService(
  './protos/user.proto',
  'UserService',
  {
    GetUser: grpcAuth()(async (call, callback) => {
      // call.user is now available
      const user = await db.users.findOne({ id: call.request.id });
      callback(null, user);
    }),

    DeleteUser: grpcRequireRole('admin')(async (call, callback) => {
      // Only admins can delete users
      await db.users.deleteOne({ id: call.request.id });
      callback(null, { success: true });
    })
  }
);
```

### Validation Middleware

```typescript
import { grpcValidate } from '@morojs/moro';
import { z } from 'zod';

const GetUserSchema = z.object({
  id: z.string().uuid()
});

await grpcManager.registerService(
  './protos/user.proto',
  'UserService',
  {
    GetUser: grpcValidate(GetUserSchema)(async (call, callback) => {
      // Request is validated
      const user = await db.users.findOne({ id: call.request.id });
      callback(null, user);
    })
  }
);
```

### Logging Middleware

```typescript
import { grpcLogger } from '@morojs/moro';

await grpcManager.registerService(
  './protos/user.proto',
  'UserService',
  {
    GetUser: grpcLogger({
      logRequest: true,
      logResponse: true,
      logMetadata: true
    })(async (call, callback) => {
      const user = await db.users.findOne({ id: call.request.id });
      callback(null, user);
    })
  }
);
```

---

## Authentication

### Token-Based Auth

```typescript
import { grpcAuth, extractTokenFromMetadata } from '@morojs/moro';

// Server side
await grpcManager.registerService(
  './protos/user.proto',
  'UserService',
  {
    GetUser: grpcAuth({
      extractToken: extractTokenFromMetadata,
      verifyToken: async (token) => {
        return await verifyJWT(token, process.env.JWT_SECRET);
      }
    })(async (call, callback) => {
      console.log('Authenticated user:', call.user);
      const user = await db.users.findOne({ id: call.request.id });
      callback(null, user);
    })
  }
);

// Client side
const metadata = new grpc.Metadata();
metadata.add('authorization', `Bearer ${token}`);

client.GetUser({ id: '123' }, metadata, (error, response) => {
  // ...
});
```

### Role-Based Access

```typescript
import { grpcRequireRole, grpcRequirePermission } from '@morojs/moro';

await grpcManager.registerService(
  './protos/user.proto',
  'UserService',
  {
    // Requires 'admin' role
    DeleteUser: grpcRequireRole('admin')(async (call, callback) => {
      await db.users.deleteOne({ id: call.request.id });
      callback(null, { success: true });
    }),

    // Requires specific permission
    UpdateUser: grpcRequirePermission('users:write')(async (call, callback) => {
      const updated = await db.users.updateOne(
        { id: call.request.id },
        call.request.updates
      );
      callback(null, updated);
    })
  }
);
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
          message: 'User not found'
        });
      }

      callback(null, user);
    } catch (error) {
      callback({
        code: grpc.status.INTERNAL,
        message: 'Internal server error'
      });
    }
  }
}
```

### Common Status Codes

| Code | Use Case |
|------|----------|
| `OK` | Successful response |
| `CANCELLED` | Operation cancelled |
| `INVALID_ARGUMENT` | Invalid request parameters |
| `NOT_FOUND` | Resource not found |
| `ALREADY_EXISTS` | Resource already exists |
| `PERMISSION_DENIED` | Insufficient permissions |
| `UNAUTHENTICATED` | Authentication required |
| `RESOURCE_EXHAUSTED` | Rate limit exceeded |
| `FAILED_PRECONDITION` | Precondition not met |
| `INTERNAL` | Server error |
| `UNAVAILABLE` | Service unavailable |
| `UNIMPLEMENTED` | Method not implemented |

### Error with Metadata

```typescript
callback({
  code: grpc.status.INVALID_ARGUMENT,
  message: 'Invalid user ID',
  metadata: new grpc.Metadata({
    'error-code': 'USER_ID_INVALID',
    'field': 'id'
  })
});
```

---

## Advanced Features

### Health Checks

```typescript
const grpcManager = new GrpcManager({
  port: 50051,
  enableHealthCheck: true
});

// Health check is automatically available at:
// grpc://localhost:50051/grpc.health.v1.Health/Check
```

### Server Reflection

```typescript
const grpcManager = new GrpcManager({
  port: 50051,
  enableReflection: true
});

// Allows tools like grpcurl to discover services
// grpcurl -plaintext localhost:50051 list
```

### TLS/SSL

```typescript
import * as fs from 'fs';

const grpcManager = new GrpcManager({
  port: 50051,
  credentials: {
    privateKey: fs.readFileSync('./key.pem'),
    certChain: fs.readFileSync('./cert.pem')
  }
});

// Client
const credentials = grpc.credentials.createSsl(
  fs.readFileSync('./ca.pem'),
  fs.readFileSync('./client-key.pem'),
  fs.readFileSync('./client-cert.pem')
);

const client = await grpcManager.createClient(
  './protos/user.proto',
  'UserService',
  'localhost:50051',
  { credentials }
);
```

### Compression

```typescript
const grpcManager = new GrpcManager({
  port: 50051,
  compression: true
});

// Messages are automatically compressed using gzip
```

### Message Size Limits

```typescript
const grpcManager = new GrpcManager({
  port: 50051,
  maxReceiveMessageLength: 10 * 1024 * 1024, // 10MB
  maxSendMessageLength: 10 * 1024 * 1024      // 10MB
});
```

### Interceptors

```typescript
const loggingInterceptor = (options, nextCall) => {
  return new grpc.InterceptingCall(nextCall(options), {
    start: (metadata, listener, next) => {
      console.log('Request started');
      next(metadata, {
        ...listener,
        onReceiveMessage: (message, next) => {
          console.log('Received message:', message);
          next(message);
        }
      });
    }
  });
};

client.GetUser(
  { id: '123' },
  { interceptors: [loggingInterceptor] },
  callback
);
```

---

## Integration with MoroJS

### With HTTP Server

```typescript
import { createApp, GrpcManager } from '@morojs/moro';

const app = createApp();
const grpcManager = new GrpcManager({ port: 50051 });

// Initialize both
await grpcManager.initialize();

// HTTP endpoints
app.get('/api/users/:id', async (req, res) => {
  // Use gRPC internally
  const user = await grpcClient.GetUser({ id: req.params.id });
  return user;
});

// Start both servers
await grpcManager.start();
app.listen(3000);

console.log('HTTP server on port 3000');
console.log('gRPC server on port 50051');
```

### Service Discovery

```typescript
// Register with service discovery
await grpcManager.registerService(
  './protos/user.proto',
  'UserService',
  implementation
);

// Get service info
const services = grpcManager.getRegisteredServices();
console.log('Available services:', services);
```

### Metrics

```typescript
// Get gRPC metrics
const stats = await grpcManager.getStats();

console.log(`Total Calls: ${stats.totalCalls}`);
console.log(`Active Calls: ${stats.activeCalls}`);
console.log(`Failed Calls: ${stats.failedCalls}`);
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
          message: `User ${call.request.id} not found`
        });
      }

      callback(null, user);
    } catch (error) {
      callback({
        code: grpc.status.INTERNAL,
        message: 'Failed to fetch user',
        metadata: new grpc.Metadata({ 'internal-error': error.message })
      });
    }
  }
}
```

### 3. Use Streaming for Large Data

```typescript
// Instead of returning large arrays
{
  ListAllUsers: async (call) => {
    const stream = db.users.find().stream();

    stream.on('data', (user) => {
      call.write(user);
    });

    stream.on('end', () => {
      call.end();
    });
  }
}
```

### 4. Implement Health Checks

```typescript
const grpcManager = new GrpcManager({
  port: 50051,
  enableHealthCheck: true
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
// Reuse clients
const clientPool = new Map();

function getClient(service) {
  if (!clientPool.has(service)) {
    clientPool.set(service, createClient(service));
  }
  return clientPool.get(service);
}
```

---

## MoroJS API Reference

### `app.grpcInit(options)`

Configure gRPC server (synchronous, lazy initialization).

**Parameters:**
- `options.port` (number) - gRPC server port (default: 50051)
- `options.host` (string) - Server host (default: '0.0.0.0')
- `options.adapter` (string) - gRPC adapter ('grpc-js' or 'google-cloud-grpc')
- `options.enableHealthCheck` (boolean) - Enable health check service (default: true)
- `options.enableReflection` (boolean) - Enable server reflection (default: false)
- `options.maxReceiveMessageLength` (number) - Max message size
- `options.maxSendMessageLength` (number) - Max message size
- `options.credentials` - TLS credentials

**Returns:** `this` (chainable)

**Example:**
```typescript
app.grpcInit({
  port: 50051,
  host: '0.0.0.0',
  adapter: 'grpc-js',
  enableHealthCheck: true,
  enableReflection: true,
  maxReceiveMessageLength: 4 * 1024 * 1024, // 4MB
  maxSendMessageLength: 4 * 1024 * 1024
});
```

### `app.grpcService(protoPath, serviceName, implementation, packageName?)`

Register a gRPC service from a proto file.

**Parameters:**
- `protoPath` (string) - Path to .proto file
- `serviceName` (string) - Name of the service
- `implementation` (object) - Service method implementations
- `packageName` (string, optional) - Package name if not in proto

**Returns:** `Promise<void>`

**Example:**
```typescript
await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: async (call, callback) => {
    const user = await db.users.findById(call.request.id);
    callback(null, user);
  },
  ListUsers: async (call) => {
    const users = await db.users.findAll();
    for (const user of users) {
      call.write(user);
    }
    call.end();
  }
});
```

### `app.createGrpcClient(protoPath, serviceName, address, options?)`

Create a gRPC client for calling remote services.

**Parameters:**
- `protoPath` (string) - Path to .proto file
- `serviceName` (string) - Name of the service
- `address` (string) - Server address (host:port)
- `options` (object, optional) - Client options
  - `credentials` - TLS credentials or 'insecure'
  - `maxReceiveMessageLength` (number)
  - `maxSendMessageLength` (number)

**Returns:** `Promise<GrpcClient>`

**Example:**
```typescript
const client = await app.createGrpcClient(
  './proto/users.proto',
  'UserService',
  'localhost:50051',
  {
    credentials: 'insecure'
  }
);

// Call methods
client.GetUser({ id: '123' }, (error, response) => {
  if (error) {
    console.error(error);
  } else {
    console.log(response);
  }
});
```

### `app.startGrpc()`

Start the gRPC server manually. Called automatically by `app.listen()`.

**Returns:** `Promise<void>`

### `app.stopGrpc()`

Stop the gRPC server gracefully.

**Returns:** `Promise<void>`

### `app.getGrpcServices()`

Get list of registered gRPC services.

**Returns:** `string[]`

---

## Troubleshooting

### Connection Refused

Check server is running and port is correct:

```bash
# Test with grpcurl
grpcurl -plaintext localhost:50051 list
```

### Proto Loading Errors

Verify proto file path and syntax:

```typescript
const protoOptions = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
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
call.on('error', (error) => {
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
