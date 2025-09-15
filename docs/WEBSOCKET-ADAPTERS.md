# WebSocket Adapter Examples

MoroJS now supports pluggable WebSocket adapters, allowing you to choose the best WebSocket implementation for your needs or disable WebSockets entirely.

## Usage Examples

### 1. Auto-Detection (Default)

```typescript
import { Moro } from '@morojs/moro';

// Automatically detects and uses available WebSocket adapter
// Tries socket.io first, then native ws library
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

### 3. Use Native WebSocket (ws) for Lightweight Implementation

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

### 4. Disable WebSockets Entirely

```typescript
import { Moro } from '@morojs/moro';

// No WebSocket dependencies required
const app = new Moro({
  websocket: false
});

// This would throw an error:
// app.websocket('/chat', {}); // Error: WebSocket adapter not available
```

### 5. Custom Adapter Implementation

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
2. **Performance**: Choose uWebSockets.js for maximum performance
3. **Flexibility**: Easy to switch between different implementations
4. **Future-Proof**: Easy to add new WebSocket libraries as they emerge

## Adapter Comparison

| Adapter | Bundle Size | Performance | Features | Use Case |
|---------|-------------|-------------|----------|----------|
| Socket.IO | ~244KB | Good | Rich features, rooms, namespaces | General purpose, feature-rich apps |
| Native WS | ~8KB | Very Good | Standards-compliant, lightweight | Performance-conscious, minimal footprint |
| None | 0KB | N/A | HTTP only | REST APIs, static sites |
