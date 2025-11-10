# HTTP/2 Support in MoroJS

MoroJS now includes full native HTTP/2 support with advanced features including server push, stream prioritization, and multiplexing.

## Features

- ✅ **Native HTTP/2 Server** - Built on Node.js `http2` module
- ✅ **Server Push** - Proactively push resources to clients
- ✅ **Stream Prioritization** - Control resource loading order
- ✅ **Multiplexing** - Multiple requests over single connection
- ✅ **Header Compression** - HPACK compression built-in
- ✅ **HTTP/1.1 Fallback** - Automatic fallback support
- ✅ **Auto-detect Push** - Automatically detect and push CSS/JS from HTML

## Quick Start

### Basic HTTP/2 Server

```typescript
import { Moro } from 'moro';
import * as fs from 'fs';

const app = new Moro({
  http2: true,
  https: {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem'),
  },
});

app.get('/', (req, res) => {
  res.json({
    message: 'Hello HTTP/2!',
    version: req.httpVersion // '2.0'
  });
});

app.listen(3000);
```

### Advanced Configuration

```typescript
const app = new Moro({
  http2: {
    allowHTTP1: true, // Support HTTP/1.1 fallback
    settings: {
      enablePush: true,
      maxConcurrentStreams: 100,
      initialWindowSize: 65535,
      maxFrameSize: 16384,
    },
  },
  https: {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem'),
  },
});
```

## Server Push

### Automatic Push (Recommended)

Use the `http2Push` middleware with auto-detection:

```typescript
import { middleware } from 'moro';

app.use(middleware.http2Push({
  autoDetect: true, // Auto-detect CSS/JS from HTML
  resources: [
    {
      path: '/styles/main.css',
      as: 'style',
      type: 'text/css',
      priority: 200 // High priority
    },
    {
      path: '/scripts/app.js',
      as: 'script',
      type: 'application/javascript',
      priority: 150
    },
  ],
  condition: (req) => req.path === '/' || req.path.endsWith('.html'),
}));
```

### Manual Push

Push resources manually within route handlers:

```typescript
app.get('/', (req, res) => {
  // Check if push is available
  if (res.push) {
    // Push CSS with high priority
    const cssStream = res.push('/styles/main.css', {
      headers: { 'content-type': 'text/css' },
      priority: 200,
    });

    if (cssStream) {
      cssStream.end('body { font-family: Arial; }');
    }

    // Push JavaScript
    res.push('/scripts/app.js', {
      headers: { 'content-type': 'application/javascript' },
      priority: 150,
    });
  }

  res.send('<html>...</html>');
});
```

## Stream Prioritization

Control the priority of your responses:

```typescript
// Critical API endpoint - highest priority
app.get('/api/critical', (req, res) => {
  if (res.setPriority) {
    res.setPriority({
      weight: 256,      // 1-256, higher = more important
      exclusive: true   // Exclusively process this stream
    });
  }

  res.json({ critical: 'data' });
});

// Background data - low priority
app.get('/api/background', (req, res) => {
  if (res.setPriority) {
    res.setPriority({ weight: 1 });
  }

  res.json({ background: 'data' });
});
```

## Priority Values

Priority weight ranges from 1-256:

- **256** - Critical resources (HTML, critical API data)
- **200** - High priority (CSS, fonts)
- **150** - Medium priority (JavaScript)
- **100** - Normal priority (images)
- **50** - Low priority (analytics, tracking)
- **1** - Lowest priority (background tasks)

## Checking HTTP Version

```typescript
app.get('/', (req, res) => {
  const httpVersion = req.httpVersion; // '2.0' or '1.1'

  if (httpVersion === '2.0') {
    // Use HTTP/2 features
    res.push('/assets/critical.css');
  }

  res.json({ version: httpVersion });
});
```

## SSL Certificates

HTTP/2 requires SSL/TLS. For development, generate self-signed certificates:

```bash
# Generate self-signed certificate
openssl req -x509 -newkey rsa:2048 -nodes -sha256 \
  -subj '/CN=localhost' \
  -keyout localhost-key.pem \
  -out localhost-cert.pem
```

For production, use certificates from a trusted CA like Let's Encrypt.

## Best Practices

### 1. Use Server Push Wisely

Only push resources that are:
- Critical for initial render
- Small in size (< 100KB)
- Used by most users

```typescript
app.use(middleware.http2Push({
  autoDetect: true, // Let MoroJS detect from HTML
  resources: [
    // Only push critical resources
    { path: '/critical.css', type: 'text/css', priority: 200 },
  ],
}));
```

### 2. Set Appropriate Priorities

```typescript
// Critical path
res.setPriority({ weight: 256, exclusive: true });

// Important but not critical
res.setPriority({ weight: 200 });

// Background/analytics
res.setPriority({ weight: 1 });
```

### 3. Enable HTTP/1.1 Fallback

```typescript
const app = new Moro({
  http2: {
    allowHTTP1: true, // Clients without HTTP/2 support
  },
  https: { /* ... */ },
});
```

### 4. Monitor Server Push

```typescript
app.get('/', (req, res) => {
  const pushStream = res.push('/asset.css');

  if (pushStream) {
    pushStream.on('error', (err) => {
      console.log('Push failed:', err.message);
    });
  }
});
```

## Performance Tuning

### Adjust Concurrent Streams

```typescript
const app = new Moro({
  http2: {
    settings: {
      maxConcurrentStreams: 100, // Default: 100
      initialWindowSize: 65535,   // 64KB
      maxFrameSize: 16384,        // 16KB
    },
  },
});
```

### Connection Settings

```typescript
const app = new Moro({
  http2: {
    maxSessionMemory: 10, // MB per session
    settings: {
      headerTableSize: 4096,      // HPACK table size
      maxHeaderListSize: 8192,    // Max header size
    },
  },
});
```

## Middleware Compatibility

All MoroJS middleware works with HTTP/2:

```typescript
import { middleware } from 'moro';

app.use(middleware.cors());
app.use(middleware.helmet());
app.use(middleware.compression()); // Works alongside HTTP/2 compression
app.use(middleware.requestLogger());
```

## Testing HTTP/2

### Using curl

```bash
# Test HTTP/2 endpoint
curl -k --http2 https://localhost:3000/

# Check protocol version
curl -k --http2 -I https://localhost:3000/ | grep HTTP
```

### Using Node.js

```javascript
const http2 = require('http2');

const client = http2.connect('https://localhost:3000', {
  rejectUnauthorized: false, // For self-signed certs
});

const req = client.request({ ':path': '/' });

req.on('response', (headers) => {
  console.log('Status:', headers[':status']);
});

req.on('data', (chunk) => {
  console.log('Data:', chunk.toString());
});

req.end();
```

### Browser Testing

Open Chrome DevTools → Network tab → Protocol column shows `h2` for HTTP/2.

## Migration from HTTP/1.1

### Before (HTTP/1.1)

```typescript
const app = new Moro();

app.get('/', (req, res) => {
  res.send('<html>...</html>');
});

app.listen(3000);
```

### After (HTTP/2)

```typescript
const app = new Moro({
  http2: true,
  https: {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem'),
  },
});

app.use(middleware.http2Push({ autoDetect: true }));

app.get('/', (req, res) => {
  // Optionally use HTTP/2 features
  if (res.push) {
    res.push('/critical.css');
  }

  res.send('<html>...</html>');
});

app.listen(3000);
```

## Troubleshooting

### Server Push Not Working

1. Check if client supports HTTP/2:
   ```typescript
   if (req.httpVersion === '2.0' && res.push) {
     // Push is available
   }
   ```

2. Ensure SSL is configured:
   ```typescript
   // HTTP/2 requires HTTPS
   https: {
     key: fs.readFileSync('key.pem'),
     cert: fs.readFileSync('cert.pem'),
   }
   ```

3. Check if push is enabled:
   ```typescript
   http2: {
     settings: {
       enablePush: true, // Must be true
     },
   }
   ```

### Connection Issues

1. Verify certificates are valid
2. Check `maxConcurrentStreams` setting
3. Monitor memory usage with `maxSessionMemory`

### Performance Issues

1. Don't over-push resources
2. Set appropriate priorities
3. Monitor stream counts
4. Adjust `initialWindowSize` if needed

## Examples

See `/examples/http2-server.ts` for a complete working example with:
- Server push configuration
- Stream prioritization
- Auto-detection of resources
- Manual push examples
- Priority testing endpoints

## API Reference

### Response Methods (HTTP/2)

#### `res.push(path, options)`
Push a resource to the client.

```typescript
res.push(path: string, options?: {
  headers?: Record<string, string>;
  priority?: number; // 1-256
});
```

#### `res.setPriority(options)`
Set stream priority for current response.

```typescript
res.setPriority(options?: {
  parent?: number;
  weight?: number; // 1-256
  exclusive?: boolean;
});
```

### Middleware

#### `middleware.http2Push(options)`
Configure server push behavior.

```typescript
middleware.http2Push({
  autoDetect?: boolean;
  resources?: Array<{
    path: string;
    as: string;
    type?: string;
    priority?: number;
  }>;
  condition?: (req) => boolean;
});
```

## Further Reading

- [HTTP/2 Specification (RFC 7540)](https://tools.ietf.org/html/rfc7540)
- [Server Push Guide](https://www.smashingmagazine.com/2017/04/guide-http2-server-push/)
- [HTTP/2 Best Practices](https://developers.google.com/web/fundamentals/performance/http2)

