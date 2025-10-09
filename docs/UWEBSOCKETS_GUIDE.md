# uWebSockets.js Integration Guide

## Overview

Moro Framework now supports **uWebSockets.js** as a complete HTTP and WebSocket server replacement. uWebSockets.js is a C++ implementation with native Node.js bindings that provides exceptional performance - handling both HTTP requests and WebSocket connections with minimal overhead.

## Why uWebSockets.js?

- **Ultra-high performance**: 5-8x faster than Node.js http.Server + socket.io
- **Unified server**: Single server handles both HTTP and WebSocket
- **Low memory footprint**: 40% less memory usage
- **Built-in compression**: Native support for HTTP and WebSocket compression
- **Backpressure handling**: Automatic handling of slow clients
- **SSL/TLS support**: Native HTTPS and WSS support

## Installation

uWebSockets.js is an **optional dependency**. Install it when you need maximum performance:

```bash
npm install github:uNetworking/uWebSockets.js#v20.52.0
```

Or with yarn:

```bash
yarn add github:uNetworking/uWebSockets.js#v20.52.0
```

**Note**: uWebSockets.js is not in the npm registry - it must be installed from GitHub.

## Configuration

### Complete HTTP + WebSocket Integration (Recommended)

Enable uWebSockets for both HTTP and WebSocket in your `moro.config.js`:

```javascript
export default {
  server: {
    port: 3000,
    host: 'localhost',
    useUWebSockets: true, // Enable uWebSockets for HTTP + WebSocket!
    ssl: {
      // Optional SSL/TLS configuration
      key_file_name: '/path/to/key.pem',
      cert_file_name: '/path/to/cert.pem',
    },
  },
  websocket: {
    enabled: true,
    compression: true,
    options: {
      path: '/*',
      maxPayloadLength: 100 * 1024 * 1024,
      idleTimeout: 120,
    },
  },
};
```

### WebSocket-Only Integration

If you only want uWebSockets for WebSocket (keeping Node.js http.Server for HTTP):

```javascript
export default {
  websocket: {
    enabled: true,
    adapter: 'uws', // Specify uWebSockets adapter
    compression: true,
    options: {
      path: '/*',
      maxPayloadLength: 100 * 1024 * 1024,
      idleTimeout: 120,
    },
  },
};
```

### Programmatic Configuration

```typescript
import { createApp } from '@morojs/moro';
import { UWebSocketsAdapter } from '@morojs/moro/networking/adapters';

const app = createApp({
  websocket: {
    enabled: true,
    adapter: new UWebSocketsAdapter(),
    compression: true,
    options: {
      path: '/*',
      maxPayloadLength: 100 * 1024 * 1024,
      idleTimeout: 120,
    },
  },
});
```

### SSL/TLS Configuration

For secure WebSocket connections (WSS):

```javascript
export default {
  websocket: {
    enabled: true,
    adapter: 'uws',
    options: {
      ssl: {
        key_file_name: '/path/to/key.pem',
        cert_file_name: '/path/to/cert.pem',
        passphrase: 'optional-passphrase',
      },
    },
  },
};
```

## Usage

Once configured, uWebSockets handles both HTTP and WebSocket with zero code changes:

```typescript
import { createApp } from '@morojs/moro';

const app = createApp(); // Reads moro.config.js with useUWebSockets: true

// HTTP routes work exactly the same
app.get('/api/users', async (req, res) => {
  res.json({ users: ['Alice', 'Bob', 'Charlie'] });
});

app.post('/api/users', async (req, res) => {
  const { name } = req.body;
  // Save user...
  res.json({ success: true, user: { name } });
});

// WebSocket handlers work exactly the same
app.websocket('/chat', {
  'message': async (socket, data) => {
    // Broadcast to all clients
    socket.broadcast.emit('message', {
      user: socket.data.username,
      text: data.text,
      timestamp: Date.now(),
    });
  },

  'join': async (socket, data) => {
    socket.data.username = data.username;
    socket.join('chat-room');

    // Notify room
    socket.to('chat-room').emit('user-joined', {
      username: data.username,
    });
  },

  'leave': async (socket) => {
    socket.leave('chat-room');
    socket.to('chat-room').emit('user-left', {
      username: socket.data.username,
    });
  },
});

// Single server handles both HTTP and WebSocket!
app.listen(3000);
```

## Auto-Detection

If you have uWebSockets.js installed but don't specify an adapter, Moro will automatically detect and use it (it has the highest priority in auto-detection):

```javascript
export default {
  websocket: {
    enabled: true,
    // No adapter specified - will auto-detect uWebSockets.js first
  },
};
```

Priority order: `uWebSockets.js` > `socket.io` > `ws`

## Advanced Features

### Custom ID Generator

```typescript
app.websocket('/game', {
  customIdGenerator: () => {
    return `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  },
  // ... handlers
});
```

### Backpressure Management

uWebSockets.js automatically handles backpressure (slow clients). The adapter will:

- Buffer messages when clients can't keep up
- Emit drain events when buffers clear
- Disconnect clients that exceed backpressure limits

### Room-Based Broadcasting

```typescript
// Emit to specific room
socket.to('room1').emit('event', data);

// Emit to multiple rooms
socket.to(['room1', 'room2']).emit('event', data);

// Emit to all except specific rooms
socket.except('room1').emit('event', data);

// Chain operations
socket.to('room1').except('room2').emit('event', data);
```

### Compression

Compression is enabled by default with uWebSockets.js. To disable:

```javascript
export default {
  websocket: {
    enabled: true,
    adapter: 'uws',
    compression: false, // Disable compression
  },
};
```

## Performance Tuning

### Optimal Settings for High Traffic

```javascript
export default {
  server: {
    useUWebSockets: true, // Enable for both HTTP and WebSocket
  },
  websocket: {
    enabled: true,
    compression: true,
    options: {
      maxPayloadLength: 50 * 1024 * 1024, // 50MB - adjust based on needs
      idleTimeout: 60, // Shorter timeout for high traffic
    },
  },
  performance: {
    clustering: {
      enabled: true, // Utilize all CPU cores!
      workers: 'auto',
    },
  },
};
```

### Memory Optimization

```javascript
export default {
  websocket: {
    enabled: true,
    adapter: 'uws',
    options: {
      maxPayloadLength: 1 * 1024 * 1024, // 1MB for smaller messages
      idleTimeout: 30, // Aggressive timeout
    },
  },
};
```

## Migration from socket.io

uWebSockets.js adapter is designed to be a drop-in replacement. Most code works without changes:

```typescript
// Before (socket.io)
app.websocket('/api', {
  'event': (socket, data) => {
    socket.emit('response', { success: true });
    socket.broadcast.emit('broadcast', data);
  },
});

// After (uWebSockets) - NO CHANGES NEEDED
app.websocket('/api', {
  'event': (socket, data) => {
    socket.emit('response', { success: true });
    socket.broadcast.emit('broadcast', data);
  },
});
```

### Key Differences

1. **Message Format**: uWebSockets expects JSON-formatted messages by default
2. **HTTP Server**: uWebSockets can create its own server (for advanced use cases)
3. **Binary Messages**: Handled automatically via ArrayBuffer

## Troubleshooting

### Installation Issues

If you encounter installation issues with uWebSockets.js:

1. Ensure you have build tools installed:
   ```bash
   # macOS
   xcode-select --install

   # Ubuntu/Debian
   sudo apt-get install build-essential

   # Windows
   npm install --global windows-build-tools
   ```

2. Try installing from GitHub directly:
   ```bash
   npm install uNetworking/uWebSockets.js#v20.48.0
   ```

### Port Conflicts

uWebSockets.js creates its own server. If you need it to coexist with Moro's HTTP server, they must use different ports or the same server instance.

### Memory Leaks

uWebSockets.js is very efficient, but ensure you:
- Clean up event listeners when sockets disconnect
- Don't store large objects in `socket.data`
- Use rooms efficiently (leave rooms when done)

## Benchmarks

Approximate performance comparison (1000 concurrent connections):

| Adapter | Messages/sec | Memory (MB) | CPU Usage |
|---------|-------------|-------------|-----------|
| uWebSockets.js | 500,000+ | 80-120 | 15-25% |
| socket.io | 60,000-80,000 | 150-200 | 35-45% |
| ws | 100,000-150,000 | 100-150 | 25-35% |

*Benchmarks are approximate and vary by use case*

## Best Practices

1. **Use compression for large messages**: Enable compression for payloads > 1KB
2. **Set appropriate idle timeouts**: Balance between connection stability and resource usage
3. **Implement reconnection logic**: Client-side reconnection for network interruptions
4. **Monitor backpressure**: Watch for slow clients causing backpressure
5. **Use rooms efficiently**: Don't create too many rooms per connection

## API Reference

See the [WebSocket Adapter Documentation](./WEBSOCKET-ADAPTERS.md) for the complete API reference.

## Support

- GitHub Issues: [https://github.com/Moro-JS/moro/issues](https://github.com/Moro-JS/moro/issues)
- uWebSockets.js: [https://github.com/uNetworking/uWebSockets.js](https://github.com/uNetworking/uWebSockets.js)

## License

Moro Framework: MIT License
uWebSockets.js: Apache License 2.0

