# HTTP/2 Support in MoroJS

MoroJS now includes full native HTTP/2 support with advanced features including server push, stream prioritization, and multiplexing.

## Features

- ✅ **Native HTTP/2 Server** - Built on Node.js `http2` module
- ✅ **Server Push** - Proactively push resources to clients
- ✅ **Stream Prioritization** - Control resource loading order
- ✅ **Multiplexing** - Multiple requests over single connection
- ✅ **Header Compression** - HPACK compression built-in
- ✅ **HTTP/1.1 Fallback** - The native engine serves HTTP/1.1 clients on the same port (the Node.js HTTP/2 server answers HTTP/2 only)
- ✅ **Auto-detect Push** - Automatically detect and push CSS/JS from HTML

## Quick Start

### Basic HTTP/2 Server

```typescript
import { Moro } from '@morojs/moro';
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
    version: req.httpVersion, // '2.0'
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

Use the `http2.push` middleware with auto-detection:

```typescript
import { middleware } from '@morojs/moro';

app.use(
  middleware.http2.push({
    autoDetect: true, // Auto-detect CSS/JS from HTML
    resources: [
      {
        path: '/styles/main.css',
        as: 'style',
        type: 'text/css',
        priority: 200, // High priority
      },
      {
        path: '/scripts/app.js',
        as: 'script',
        type: 'application/javascript',
        priority: 150,
      },
    ],
    condition: req => req.path === '/' || req.path.endsWith('.html'),
  })
);
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
      weight: 256, // 1-256, higher = more important
      exclusive: true, // Exclusively process this stream
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

`app.engine.protocols` lists what the listener speaks: `['h2', 'http/1.1']` on the native engine with HTTP/2 enabled, and `['h2']` on the Node.js HTTP/2 server (`app.engine.server === 'http2'`), which answers HTTP/2 only.

## SSL Certificates

Browsers speak HTTP/2 only over TLS, so serve it with a certificate. Without one, the server takes cleartext HTTP/2 from clients that use prior knowledge (for example `curl --http2-prior-knowledge`). For development, generate self-signed certificates:

```bash
# Generate self-signed certificate
openssl req -x509 -newkey rsa:2048 -nodes -sha256 \
  -subj '/CN=localhost' \
  -keyout localhost-key.pem \
  -out localhost-cert.pem
```

For production, use certificates from a trusted CA like Let's Encrypt.

### TLS policy and client certificates

Every `server.ssl` option applies to the HTTP/2 listener exactly as it applies to the HTTPS one: `ca`, `requestCert`, `rejectUnauthorized`, `minVersion`, `maxVersion`, `ciphers`, `honorCipherOrder`, `ecdhCurve`, `sigalgs`, `crl` and `passphrase` (see [`server.ssl`](./CONFIGURATION_REFERENCE.md#server-section)). Mutual TLS, for example:

```typescript
import { createApp } from '@morojs/moro';
import { readFileSync } from 'fs';

const app = await createApp({
  server: {
    http2: true,
    ssl: {
      key: readFileSync('./server-key.pem'),
      cert: readFileSync('./server-cert.pem'),
      ca: readFileSync('./clients-ca.pem'), // the CA that issues client certificates
      requestCert: true,
      rejectUnauthorized: true, // no certificate, or one this CA did not issue: handshake refused
      minVersion: 'TLSv1.3',
    },
  },
});
```

A client that presents no certificate, or one the CA did not issue, is refused during the TLS handshake and no request reaches the app. `app.reloadTLS()` keeps these settings when it replaces the certificate.

## Best Practices

### 1. Use Server Push Wisely

Only push resources that are:

- Critical for initial render
- Small in size (< 100KB)
- Used by most users

```typescript
app.use(
  middleware.http2.push({
    autoDetect: true, // Let MoroJS detect from HTML
    resources: [
      // Only push critical resources
      { path: '/critical.css', as: 'style', type: 'text/css', priority: 200 },
    ],
  })
);
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
  https: {/* ... */},
});
```

HTTP/1.1 clients are served on the same port by the native engine. The Node.js HTTP/2 server does not serve the application to them, whatever `allowHTTP1` says: check `app.engine.protocols`, and keep HTTP/1.1 clients on the native engine.

What an HTTP/1.1 client gets from the Node.js HTTP/2 server depends on the port:

- Over TLS, a client that offers only `http/1.1` in ALPN completes the handshake (Node accepts it while `allowHTTP1` is on, the default) and is answered `505 HTTP Version Not Supported` with `Connection: close` and a one-line plain-text body, then disconnected. No route, middleware or hook runs for it. With `allowHTTP1: false` Node refuses the connection itself.
- Without TLS there is no negotiation: the server expects the HTTP/2 preface and an HTTP/1.1 request is a protocol error.

### 4. Monitor Server Push

```typescript
app.get('/', (req, res) => {
  const pushStream = res.push('/asset.css');

  if (pushStream) {
    pushStream.on('error', err => {
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
      initialWindowSize: 65535, // 64KB
      maxFrameSize: 16384, // 16KB
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
      headerTableSize: 4096, // HPACK table size
      maxHeaderListSize: 8192, // Max header size
    },
  },
});
```

### Idle Connections

An HTTP/2 connection with no request in progress is closed after `server.timeouts.idle` (75 seconds by default, `0` for never; on the native engine the default is applied by `@morojs/engine` releases after 1.1.21, and an older engine has no idle timeout unless one is set). A request a handler is still working on, a streamed response or an event stream is not cut: on the native engine the connection is not idle while a handler holds one of its requests, and the Node.js HTTP/2 server (`server.engine: 'node'`) tells the client to use a new connection (`GOAWAY`), lets the requests in progress finish and closes the connection after the last of them.

## Middleware Compatibility

All MoroJS middleware works with HTTP/2:

```typescript
import { middleware } from '@morojs/moro';

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

req.on('response', headers => {
  console.log('Status:', headers[':status']);
});

req.on('data', chunk => {
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

app.use(middleware.http2.push({ autoDetect: true }));

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
   // Browsers use HTTP/2 only over HTTPS
   https: {
     key: fs.readFileSync('key.pem'),
     cert: fs.readFileSync('cert.pem'),
   }
   ```

3. Check whether the client allows push. Server push is enabled by the
   _client's_ `SETTINGS_ENABLE_PUSH`, not the server's: RFC 9113 forbids a
   server from advertising it (nghttp2-based clients drop the connection if
   one does), so `settings.enablePush` is accepted but never sent. Moro reads
   the client's choice per stream (`stream.pushAllowed`) and `res.push()`
   returns `null` when it is off. Chrome and Firefox have disabled push,
   so expect `null` from browsers and rely on `<link rel="preload">` there.

### A handler written for HTTP/1.1

The request and response on the Node.js HTTP/2 server carry the same helpers as on the Node.js HTTP server, with the same results (`req.get()`, `req.hostname`, `req.protocol`, `req.socket`, `req.on('close')`, `res.sendFile()`, `res.download()`, `res.set()`, `res.type()`, `res.format()`, `res.write()`, `res.locals` and the rest of [Response Helpers](./RESPONSE_HELPERS.md)), so a handler does not need to know which of the two is serving. A few things are worth knowing:

- An HTTP/2 client names the host in `:authority` and sends no `Host` header. `req.headers.host` is filled from `:authority`, and `req.hostname` and `req.subdomains` follow from it.
- `Connection`, `Keep-Alive`, `Proxy-Connection`, `Transfer-Encoding` and `Upgrade` have no meaning on an HTTP/2 connection (RFC 9113 8.2.2). A handler may set them, as code written for HTTP/1.1 does for an event stream; they are left out of the response.
- A response head that cannot be sent at all (a status outside 100-599, a header name that is not a token) is answered `500` and logged at error level.
- `res.write()` sends the head on its first call and returns `false` when the caller should wait for `'drain'`. An event stream is a `res.writeHead()` followed by writes, exactly as on HTTP/1.1, and `req.on('close', ...)` fires when the client goes away.
- `res.destroy()`, and a handler that fails after its response has started, reset the stream (`RST_STREAM`, `INTERNAL_ERROR`). The client sees a failed transfer, and the connection's other streams are unaffected.
- `res.on('finish', ...)` fires once for every response that was sent in full, whatever sent it (`res.json()`, `res.send()`, `res.end()`, `res.redirect()`, `res.sendFile()`) and whether or not the request had a body, and `res.on('close', ...)` fires after it. A response that was abandoned (`res.destroy()`, a stream the client reset) gets `'close'` without `'finish'`. Request logging, metrics and a rate limit's `skipSuccessfulRequests` / `skipFailedRequests` rely on this, as on HTTP/1.1.
- `middleware.staticFiles()` and `res.sendRange()` answer from memory here rather than streaming the file; `res.sendFile()` streams files over 64 KB.
- `app.use()` middleware follows the same contract: `next(err)` or a throw stops the request and reaches `app.setErrorHandler()` (or the default `500`), and a four-parameter `(err, req, res, next)` middleware runs only for a request that failed. One difference remains: a three-parameter middleware that returns without having called `next()` or returned a promise is treated as finished on this server, where the Node.js HTTP server waits for its `next()`. Call `next()` before returning, or return a promise.
- A request body that cannot be parsed is answered `400`, one over `server.bodySizeLimit` or a multipart limit `413`, as on the other servers. A body that is not JSON, a form or multipart reaches the handler as a string, and `req.rawBody` is not set on this server.

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

#### `middleware.http2.push(options)`

Configure server push behavior.

```typescript
middleware.http2.push({
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
