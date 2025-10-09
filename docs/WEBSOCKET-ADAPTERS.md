# WebSocket Adapter Examples

MoroJS now supports pluggable WebSocket adapters, allowing you to choose the best WebSocket implementation for your needs or disable WebSockets entirely.

## Usage Examples

### 1. Auto-Detection (Default)

```typescript
import { Moro } from '@morojs/moro';

// Automatically detects and uses available WebSocket adapter
// Priority: uWebSockets.js > socket.io > native ws library
const app = new Moro();

app.websocket('/chat', {
  'join-room': (socket, data) => {
    socket.join(data.room);
    return { success: true };
  }
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
      path: '/socket.io/'
    }
  }
});
```

### 3. Use uWebSockets.js for Maximum Performance

```typescript
import { Moro, UWebSocketsAdapter } from '@morojs/moro';

const app = new Moro({
  websocket: {
    adapter: new UWebSocketsAdapter(),
    compression: true,
    options: {
      path: '/*',
      maxPayloadLength: 100 * 1024 * 1024, // 100MB
      idleTimeout: 120, // 2 minutes
      cors: { origin: '*' }
    }
  }
});
```

Or via config file:

```javascript
// moro.config.js
export default {
  websocket: {
    enabled: true,
    adapter: 'uws', // String-based adapter selection
    compression: true,
    options: {
      path: '/*',
      maxPayloadLength: 100 * 1024 * 1024,
      idleTimeout: 120
    }
  }
};
```

### 4. Use Native WebSocket (ws) for Lightweight Implementation

```typescript
import { Moro, WSAdapter } from '@morojs/moro';

const app = new Moro({
  websocket: {
    adapter: new WSAdapter(),
    options: {
      path: '/ws',
      maxPayloadLength: 100 * 1024 * 1024 // 100MB
    }
  }
});
```

### 5. Disable WebSockets Entirely

```typescript
import { Moro } from '@morojs/moro';

// No WebSocket dependencies required
const app = new Moro({
  websocket: false
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
  WebSocketConnection
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
    adapter: new CustomWebSocketAdapter()
  }
});
```

## Installation

### For uWebSockets.js Users (Highest Performance)

```bash
npm install github:uNetworking/uWebSockets.js#v20.52.0
```

**Note**: uWebSockets.js is not in the npm registry - it must be installed from GitHub.

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
    adapter: new SocketIOAdapter()
  }
});

// Option 3: Explicit native ws adapter
const app = new Moro({
  websocket: {
    adapter: new WSAdapter()
  }
});

// Option 3: Disable WebSockets
const app = new Moro({ websocket: false });
```

## Benefits

1. **Bundle Size**: Only include WebSocket dependencies if needed
2. **Performance**: Choose uWebSockets.js for maximum performance (up to 8x faster than socket.io)
3. **Flexibility**: Easy to switch between different implementations
4. **Future-Proof**: Easy to add new WebSocket libraries as they emerge
5. **Zero Changes**: Drop-in replacement - your code remains the same

## Adapter Comparison

| Adapter | Bundle Size | Performance | Features | Use Case |
|---------|-------------|-------------|----------|----------|
| **uWebSockets.js** | ~1MB (native) | **Excellent** (500k+ msg/s) | High performance, backpressure, compression | **Production apps, gaming, real-time, high traffic** |
| Socket.IO | ~244KB | Good (60-80k msg/s) | Rich features, rooms, namespaces, fallbacks | General purpose, feature-rich apps, broad compatibility |
| Native WS | ~8KB | Very Good (100-150k msg/s) | Standards-compliant, lightweight | Performance-conscious, minimal footprint |
| None | 0KB | N/A | HTTP only | REST APIs, static sites |

**Performance numbers are approximate and based on 1000 concurrent connections*
