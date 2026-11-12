# WebSocket Adapter Examples

MoroJS serves WebSockets from its native engine by default: RFC 6455 on the same port as HTTP, nothing to install. Adapters for Socket.IO and the `ws` library are there when you need those libraries' protocols or features, and WebSockets can be turned off entirely.

## Usage Examples

### 1. The Native Engine (Default)

```typescript
import { Moro } from '@morojs/moro';

// No adapter configured: the engine serves WebSockets itself, on the HTTP port.
// (On the Node.js server - engine: 'node', or where the engine cannot load -
// an installed socket.io or ws is detected and used, in that order.)
const app = new Moro();

app.websocket('/chat', {
  'join-room': (socket, data) => {
    socket.join(data.room);
    return { success: true };
  },
});
```

### 2. Explicitly Use Socket.IO

```typescript
import { Moro, SocketIOAdapter } from '@morojs/moro';

const app = new Moro({
  websocket: {
    adapter: new SocketIOAdapter(),
    compression: true,
    options: {
      cors: { origin: '*' },
      path: '/socket.io/',
    },
  },
});
```

### 3. Raw Frames on the Engine

```typescript
import { Moro } from '@morojs/moro';

const app = new Moro({ websocket: { enabled: true, compression: true } });

// { raw: true }: frames reach the handlers as they arrived instead of as
// JSON { event, data } envelopes - text frames as strings on `message`,
// binary frames as bytes on `binary` - and socket.send() writes one frame.
app.websocket(
  '/echo',
  {
    message: (socket, text) => socket.send(text),
    binary: (socket, bytes) => socket.send(bytes, true),
  },
  { raw: true }
);
```

### 4. Use the `ws` Library

```typescript
import { Moro, WSAdapter } from '@morojs/moro';

const app = new Moro({
  websocket: {
    adapter: new WSAdapter(),
    options: {
      path: '/ws',
      maxPayloadLength: 100 * 1024 * 1024, // 100MB
    },
  },
});
```

### 5. Disable WebSockets Entirely

```typescript
import { Moro } from '@morojs/moro';

// No WebSocket dependencies required
const app = new Moro({
  websocket: false,
});

// This would throw an error:
// app.websocket('/chat', {}); // Error: WebSocket adapter not available
```

### 6. Custom Adapter Implementation

```typescript
import {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketConnection,
} from '@morojs/moro';

class CustomWebSocketAdapter implements WebSocketAdapter {
  async initialize(httpServer: any, options?: WebSocketAdapterOptions): Promise<void> {
    // Your custom implementation
  }

  createNamespace(namespace: string): WebSocketNamespace {
    // Your custom implementation
  }

  // ... implement other required methods

  getAdapterName(): string {
    return 'custom-adapter';
  }
}

const app = new Moro({
  websocket: {
    adapter: new CustomWebSocketAdapter(),
  },
});
```

## Installation

### For the Native Engine (Default)

Nothing to install: `@morojs/engine` comes with MoroJS.

### For Socket.IO Users

```bash
npm install socket.io
```

### For Native WebSocket (ws) Users

```bash
npm install ws @types/ws
```

### For HTTP-Only Applications

No additional dependencies needed! Just set `websocket: false`.

## Migration from Previous Versions

### Before (Required Socket.IO)

```typescript
import { Moro } from '@morojs/moro';

const app = new Moro(); // Socket.IO was always included
```

### After (Optional Adapters)

```typescript
import { Moro, SocketIOAdapter } from '@morojs/moro';

// Option 1: Auto-detection (works if socket.io is installed)
const app = new Moro();

// Option 2: Explicit Socket.IO adapter
const app = new Moro({
  websocket: {
    adapter: new SocketIOAdapter(),
  },
});

// Option 3: Explicit native ws adapter
const app = new Moro({
  websocket: {
    adapter: new WSAdapter(),
  },
});

// Option 3: Disable WebSockets
const app = new Moro({ websocket: false });
```

## Benefits

1. **Bundle Size**: Only include WebSocket dependencies if needed
2. **Performance**: The native engine serves WebSockets from the same C++ core as HTTP, with no extra dependency
3. **Flexibility**: Easy to switch between different implementations
4. **Future-Proof**: Easy to add new WebSocket libraries as they emerge
5. **Zero Changes**: Drop-in replacement - your code remains the same

## Adapter Comparison

| Adapter                     | Bundle Size              | Performance                | Features                                                        | Use Case                                                |
| --------------------------- | ------------------------ | -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| **Native engine** (default) | none (ships with MoroJS) | **Fastest of the three**   | Same port as HTTP, backpressure, permessage-deflate, raw frames | **Production apps, real-time, high traffic**            |
| Socket.IO                   | ~244KB                   | Good (60-80k msg/s)        | Rich features, rooms, namespaces, fallbacks                     | General purpose, feature-rich apps, broad compatibility |
| Native WS                   | ~8KB                     | Very Good (100-150k msg/s) | Standards-compliant, lightweight                                | Performance-conscious, minimal footprint                |
| None                        | 0KB                      | N/A                        | HTTP only                                                       | REST APIs, static sites                                 |

*_Performance numbers are approximate and based on 1000 concurrent connections_

## uWebSockets.js

The uWebSockets.js adapter was removed in MoroJS 1.8.24; the native engine replaced it. `websocket.adapter: 'uws'` is still accepted and now means the engine's own WebSocket support, so an existing configuration keeps working. The `UWebSocketsAdapter` export is gone; remove imports of it. See the [HTTP Engine Guide](./HTTP_ENGINE_GUIDE.md#coming-from-uwebsocketsjs).
