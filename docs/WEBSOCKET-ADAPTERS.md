# WebSocket Adapter Examples

MoroJS serves WebSockets from its native engine: RFC 6455 on the same port as HTTP, nothing to install. WebSockets are opt-in: they are off until you pass a `websocket` option (`websocket: { enabled: true }` is enough). Adapters for Socket.IO and the `ws` library are there when you need those libraries' protocols or features.

## Origins, Handshake Checks and Message Size

What each adapter does with a handshake, with a large message and with `websocket.compression`. `cors.origin`, `verifyClient`, `enforceHandshakeChecks` and `maxPayloadLength` are keys of `websocket.options`; `compression` is a key of `websocket` itself.

|                                                    | Native engine (default)                                             | Socket.IO adapter                                                                       | `ws` adapter                                         |
| -------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `cors.origin` not set                              | Every origin is accepted                                            | Every origin is accepted                                                                | Same origin only                                     |
| `cors.origin` set to `true` or `'*'`               | Every origin is accepted                                            | Every origin is accepted                                                                | Every origin is accepted                             |
| `cors.origin` set to anything else                 | Another origin is refused with `403`, before the upgrade            | Another origin is refused on both transports: `403` on long-polling, `400` on WebSocket | Another origin is refused with `401`                 |
| `verifyClient` set                                 | Runs before the upgrade; a refusal is answered `401`                | Runs for the handshake of both transports; a refusal is answered `403` / `400` as above | Runs before the upgrade; a refusal is answered `401` |
| `enforceHandshakeChecks: false`                    | A handshake that fails either check is logged and upgraded          | A handshake that fails either check is logged and allowed                               | Not read: a handshake that fails is always refused   |
| Largest message when `maxPayloadLength` is not set | 16 MiB (the limit is `server.limits.wsMaxMessageSize` on this path) | 1 MB (1,000,000 bytes, Socket.IO's own default)                                         | 1 MiB (1,048,576 bytes)                              |
| A message over the limit                           | Closes the connection (close code 1009)                             | Closes the connection (close code 1009 on WebSocket; `413` for a long-polling request)  | Closes the connection (close code 1009)              |
| `compression` not set, or `false`                  | Messages are sent uncompressed                                      | Messages are sent uncompressed on the WebSocket transport                               | Messages are sent uncompressed                       |
| `compression: true`                                | permessage-deflate with every client that offers it                 | permessage-deflate with every client that offers it, on the WebSocket transport         | permessage-deflate with every client that offers it  |
| A message that inflates past the limit             | Closes the connection (close code 1009)                             | Closes the connection (close code 1009)                                                 | Closes the connection (close code 1009)              |

On every adapter the origin rule lets through a request without an `Origin` header (a client that is not a page in a browser) and a same-origin request (the `Origin` header's host equals the `Host` header). Behind a reverse proxy that rewrites the `Host` header, list the site's public origin in `cors.origin`. `verifyClient(info)` runs for a handshake that passed the origin rule and may be `async`: returning `false` (or a promise that resolves to `false`), throwing, or rejecting refuses the handshake.

On the native engine and on Socket.IO a configured `cors.origin` and `verifyClient` are enforced without any further option. `enforceHandshakeChecks: false` turns the refusal into a report: each handshake that fails is logged as a warning (the first twenty, then one in every 500) and let through, and one warning at start-up says that the mode is on. It is there for the time it takes to correct an origin list or a `verifyClient` that refuses clients it should not; `enforceHandshakeChecks: true` is the same as leaving the option out. With neither `cors.origin` nor `verifyClient` configured the option has nothing to act on.

### The Address of a Connection

`socket.ip` is the address the connection comes from. Behind a reverse proxy that is the proxy, for every socket, unless [`server.trustProxy`](./CONFIGURATION_REFERENCE.md#behind-a-proxy) names the proxy: `socket.ip` is then the client the trusted proxies report in the handshake's `X-Forwarded-For`, worked out exactly as `req.ip` is for an HTTP request to the same app. That holds on the native engine (where `socket.handshake.address` says the same), the `ws` adapter and the Socket.IO adapter, and on the native engine the `req.ip` that `verifyClient` receives is that client too (`req.socket.remoteAddress` stays the proxy). With `trustProxy` not set, or `false`, `socket.ip` is the connected peer, and it stays that after the socket has closed (in a `disconnect` handler, for instance): `X-Forwarded-For` is whatever the client sent, and is read only where `trustProxy` says whose word to take.

```typescript
const app = await createApp({ server: { trustProxy: 1 }, websocket: {} });

app.websocket('/chat', {
  connection: socket => {
    console.log(socket.ip); // the client, not the proxy
  },
});
```

## Compression

```typescript
import { Moro } from '@morojs/moro';

const app = new Moro({ websocket: { enabled: true, compression: true } });

app.websocket('/feed', {
  // A reply of 1024 bytes or more is compressed for a client that negotiated
  // permessage-deflate, and sent as it is to any other client.
  latest: () => ({ items: new Array(200).fill({ kind: 'trade', symbol: 'MORO', price: 1.25 }) }),
});
```

`websocket.compression: true` turns on permessage-deflate (RFC 7692) on every adapter. Not set, or `false`, the extension is declined for every client and messages are sent uncompressed, which is the default.

What the option does is the same on the native engine, the Socket.IO adapter (its WebSocket transport) and the `ws` adapter:

- **Who gets it.** A client whose handshake offers the extension, as browsers do. A client that does not offer it is served uncompressed by the same server. No client is refused over its offer: an offer the server cannot take (an unknown parameter, a value out of range, a header that cannot be parsed) is declined and that client is served uncompressed too.
- **Inbound.** A compressed message is inflated before a handler sees it. Handlers receive the same values as on an uncompressed connection.
- **Outbound.** A message of 1024 bytes or more is compressed; a shorter one is sent as it is. That holds for a handler's reply, `socket.emit()`, `socket.send()` and every broadcast. The server compresses each message on its own, with nothing carried over from the message before (its answer to the handshake carries `server_no_context_takeover`). On the native engine and the `ws` adapter `socket.compressedEmit()` and an emitter's `.compress()` send the same frame as `emit()`: whether a frame is compressed is decided by its size, not per call.
- **Size limit.** The adapter's limit on a message also bounds a message once inflated, so compression cannot carry a larger message past it: a message that would inflate beyond the limit closes the connection with close code 1009, however small it was on the wire, and inflation stops at the limit.
- **When it is decided.** Compression is part of how the adapter's server is created, so the option is read once, from the app's configuration (`createApp()` / `new Moro()` options or the configuration file); it cannot be turned on for an app that already exists.

What differs between the adapters is the limit, who compresses, and the memory a compressed connection holds:

|                                                        | Native engine (default)                               | Socket.IO adapter                                             | `ws` adapter                                                  |
| ------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Limit on a message, as it arrives and once inflated    | `server.limits.wsMaxMessageSize`, 16 MiB when not set | `maxPayloadLength`, 1 MB when not set                         | `maxPayloadLength`, 1 MiB when not set                        |
| Enforced by                                            | The engine                                            | The `ws` library inside Socket.IO                             | The `ws` library                                              |
| The server's answer to an offer                        | `permessage-deflate; server_no_context_takeover`      | The same, with `server_max_window_bits=12`                    | The same, with `server_max_window_bits=12`                    |
| Compressor                                             | One for the server, shared by all connections         | One per connection, created with its first compressed message | One per connection, created with its first compressed message |
| Memory per connection, compressed against uncompressed | About 43 KB against 15 KB                             | About 226 KB against 49 KB                                    | About 200 KB against 32 KB                                    |
| Bytes that are not a valid compressed message          | Close code 1009 (1007 from `@morojs/engine` 1.2.0)    | Close code 1007                                               | Close code 1007                                               |

The memory figures are measured: 1,000 connections that each echoed three 2 KB JSON messages, resident memory of the server divided by the connections.

- **Native engine.** The shared compressor needs `@morojs/engine` 1.1.2 or later: 1.1.0 and 1.1.1 give each compressed connection a compressor of its own (about 230 KB from the handshake on), and their answer does not carry `server_no_context_takeover`. A client whose offer limits `server_max_window_bits` to less than 15 gets a compressor of its own on every version. On an engine build without permessage-deflate the option is not applied and a warning at start-up says so.
- **Socket.IO adapter.** The option sets Socket.IO's `perMessageDeflate`, which is off by default, with a 1024-byte threshold, no context takeover and a 4 KB window. A `perMessageDeflate` of your own in `websocket.options` is passed to Socket.IO as it is and takes the place of those settings, `false` included. Long-polling is a separate matter and not changed by the option: Socket.IO compresses a long-polling response of 1024 bytes or more for a client that accepts gzip or deflate (its `httpCompression` setting, on by default) with or without `websocket.compression`.
- **`ws` adapter.** The option sets the `ws` server's `perMessageDeflate` with the same settings. The window is 4 KB because a message is compressed on its own: JSON loses a few percent against the 32 KB default and the connection's compressor is about half the size. A client whose offer asks for a smaller window (`server_max_window_bits` under 12) is served uncompressed.
- **Both `ws`-based adapters.** `ws` compresses and inflates in Node's zlib, off the event loop, at most ten jobs at a time for the whole process; a connection's compressor and decompressor are kept from its first compressed message in each direction until it closes. A connection that never exchanges a compressed message holds no more memory than an uncompressed one on the `ws` adapter.

What it costs. One core, Node.js 24 on Apple silicon, `@morojs/engine` 1.1.13, `ws` 8.21 and Socket.IO 4.8, eight clients echoing 2 KB JSON messages through an `app.websocket()` handler; server CPU per echoed message (one message in, one reply out) and messages echoed per second:

| Adapter       | Uncompressed connection | Compressed connection   |
| ------------- | ----------------------- | ----------------------- |
| Native engine | 21 µs, 47,000 a second  | 61 µs, 15,000 a second  |
| Socket.IO     | 38 µs, 24,000 a second  | 178 µs, 11,000 a second |
| `ws`          | 34 µs, 25,000 a second  | 180 µs, 12,000 a second |

On every adapter the 2.1 KB message becomes about 0.5 KB on the way in and 0.8 KB on the way out. On the two `ws`-based adapters the CPU includes zlib's worker threads, which is why throughput halves while CPU per message rises fivefold. Larger messages cost in proportion: on the native engine a 16 KB echo takes 277 µs compressed against 92 µs, and a 0.3 KB one costs the same either way because its reply is under 1024 bytes.

Turn compression on when the bytes are what matters: large JSON pushed to browsers or to clients on slow or metered links. Leave it off when messages are short (nothing under 1024 bytes is compressed on the way out), when the payload is already compressed (images, archives, most binary formats), when the server's CPU is the limit, or when a Socket.IO or `ws` server holds many connections and memory is the limit. Connections that did not negotiate the extension cost the same with the option on as with it off.

## Usage Examples

### 1. The Native Engine (Default)

```typescript
import { Moro } from '@morojs/moro';

// WebSockets enabled, no adapter configured: the engine serves them itself,
// on the HTTP port. (On the Node.js server - engine: 'node', or where the
// engine cannot load - an installed socket.io or ws is detected and used,
// in that order.)
const app = new Moro({ websocket: { enabled: true } });

app.websocket('/chat', {
  'join-room': (socket, data) => {
    socket.join(data.room);
    return { success: true };
  },
});
```

What the native engine adapter does:

- **Handshake.** The engine answers the upgrade itself. Nothing the application registers for HTTP requests (`app.use()` middleware, hooks, guards, route handlers) runs for an upgrade request, and a valid handshake is answered `101` on any path unless the handshake checks below refuse it. The first application code that sees a connection after that is namespace middleware, then the namespace's `connection` handler; both run after the upgrade, so refusing a client there closes an open WebSocket (close code 1000) and is not an HTTP status.
- **Origins.** With `websocket.options.cors.origin` not set, or set to `true` or `'*'`, origins are not checked: a handshake is accepted from every origin.
- **Handshake checks.** A configured `websocket.options.cors.origin` and `websocket.options.verifyClient` are evaluated before the upgrade is answered. A request without an `Origin` header (not a page in a browser) and a same-origin request (the `Origin` header's host equals the `Host` header) pass the origin rule; any other origin must satisfy `cors.origin` (an origin, a list, a `RegExp`, `false` for same-origin only, or a function) or the handshake is answered `403`. `verifyClient(info)` then runs for a handshake that passed the origin rule and may be `async`; returning `false` (or a promise that resolves to `false`), throwing, or rejecting answers `401`. `info` is `{ origin, req, secure }`, and `req` carries the handshake's `method`, `url`, `headers` and `socket.remoteAddress`. A refused handshake is an ordinary HTTP response (`{"success":false,"error":"Forbidden"}` or `"Unauthorized"`): the connection is not upgraded, no namespace middleware or handler runs for it, and each refusal is logged as a warning (the first twenty, then one in every 500). With `websocket.options.enforceHandshakeChecks: false` a handshake that fails is logged and upgraded instead. While either option is configured, the upgrade is made from the server's request path instead of inside the engine; an application that configures neither keeps the engine's own upgrade.
- **Message size.** The largest accepted message is `server.limits.wsMaxMessageSize`, 16 MiB when not set; a larger message closes the connection (close code 1009). `websocket.options.maxPayloadLength` passed to `createApp()` or `new Moro()` is not applied (a warning at start-up says so); in a configuration file it is used when `server.limits.wsMaxMessageSize` is not set.
- **Compression.** Off unless `websocket.compression` is `true`; see [Compression](#compression) for what it does, what it costs and the limit on an inflated message.
- **Path and idle connections.** A namespace is served at its own path (`app.websocket('/chat', ...)` at `ws://host/chat`), and a connection that stays silent is not closed. `websocket.options.path` and `websocket.options.idleTimeout` are not applied (a warning at start-up for each one that is set).
- **Namespaces.** A connection is routed by the path of its URL to the namespace registered for that path, joins it and gets its handlers. A path with no namespace of its own is served by the default namespace `/`, as on the `ws` adapter. Each namespace has its own sockets and its own rooms: `emit()`, `to(room)`, `except(room)`, `getSockets()` and `getConnectionCount()` on a namespace, and `socket.broadcast` and `socket.to(room)` on a socket, reach only the sockets that joined that namespace, and the same room name in two namespaces is two rooms. `socket.broadcast` reaches every socket of the namespace but the sender; `socket.to(room)` reaches every member of the room, the sender too when it is one. The adapter's own `getConnectionCount()` counts the sockets of every namespace.
- **Namespace middleware.** A socket joins (receives broadcasts, is listed by `getSockets()`, has its `connection` handler run) once every middleware of its namespace has called `next()`. `next(err)`, a middleware that throws and a middleware whose promise rejects all close the socket (close code 1000) without it joining.
- **Logging.** On a namespace without `{ raw: true }`, a text frame that is not a JSON `{ event, data }` envelope is ignored. The first one on a connection is logged as a warning, and so is the first send that meets backpressure; the totals are logged when the connection closes.

Restricting the origins that may connect, and authenticating the handshake:

```typescript
import { Moro, WebSocketAdapterOptions } from '@morojs/moro';

// Your own lookup: resolves to the session a cookie belongs to, if any.
async function findSession(cookie: string | undefined): Promise<object | undefined> {
  return cookie ? { cookie } : undefined;
}

const options: WebSocketAdapterOptions = {
  // A page on any other origin is answered 403 and never upgraded
  cors: { origin: ['https://app.example.com'] },
  // Optional. Runs for a handshake that passed the origin rule; it may
  // return its verdict or a promise of it. A falsy verdict is answered 401.
  verifyClient: async info => (await findSession(info.req.headers.cookie)) !== undefined,
};

const app = new Moro({ websocket: { enabled: true, options } });

app.websocket('/chat', {
  message: (socket, data) => ({ echo: data }),
});
```

A check can also be made after the upgrade, in the `connection` handler, where the socket and what the application knows about it are at hand. The client then sees an open WebSocket that is closed, not an HTTP status:

```typescript
import { Moro } from '@morojs/moro';

const app = new Moro({ websocket: { enabled: true } });

const allowedOrigins = new Set(['https://app.example.com']);

app.websocket('/chat', {
  // Runs once per socket, after the handshake has been answered. Browsers
  // always send Origin; a client without one is not a page in a browser.
  connection: socket => {
    const origin = socket.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) socket.disconnect();
  },
  message: (socket, data) => ({ echo: data }),
});
```

The `connection` handler is called before any message handler for that socket,
also when the client sent its first frame together with the handshake, so a
socket it disconnects is never answered by a handler. It is called
synchronously and a promise it returns is not awaited: a check that decides
whether the socket may stay has to finish before the handler returns.

With `performance.clustering`, connections, rooms and broadcasts belong to
one worker: `emit()`, `to(room)` and `getSockets()` see only the sockets
connected to the worker they are called in (measured with four workers on
Linux: a room broadcast reached 4 of 11 clients). This holds for every
adapter on this page.

### 2. Explicitly Use Socket.IO

```typescript
import { Moro, SocketIOAdapter } from '@morojs/moro';

const app = new Moro({
  websocket: {
    adapter: new SocketIOAdapter(),
    compression: true, // permessage-deflate on the WebSocket transport
    options: {
      cors: { origin: 'https://app.example.com' }, // browser origins allowed to connect
      path: '/socket.io/',
      maxPayloadLength: 4 * 1000 * 1000, // largest accepted message; default 1 MB
    },
  },
});
```

Socket.IO adapter defaults:

- When `cors.origin` is not set, every origin is accepted. Socket.IO's own `cors` option only covers long-polling: it does not stop a client on another origin from opening the WebSocket transport, and it never calls `verifyClient`. The adapter therefore checks a configured `cors.origin` (anything but `true` or `'*'`) and `verifyClient` on the handshake of every transport, and refuses a handshake that fails: `403` on long-polling, `400` on the WebSocket transport. Requests without an `Origin` header and same-origin requests always pass the origin check. An `allowRequest` function passed in the options still runs after these checks.
- `enforceHandshakeChecks: false` turns the refusal into a report: a handshake that fails is logged as a warning and allowed.
- `maxPayloadLength` is passed to Socket.IO as `maxHttpBufferSize`. When it is not set, Socket.IO's own limit applies: 1 MB (1,000,000 bytes). A larger message closes the connection on the WebSocket transport (close code 1009) and is answered `413` on long-polling.
- `websocket.compression: true` turns on permessage-deflate for the WebSocket transport, and `maxPayloadLength` then also bounds a message once inflated; see [Compression](#compression). Without the option the WebSocket transport is uncompressed.

### 3. Raw Frames on the Engine

```typescript
import { Moro } from '@morojs/moro';

const app = new Moro({ websocket: { enabled: true } });

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
      maxPayloadLength: 4 * 1024 * 1024, // largest accepted message; default 1 MiB
      cors: { origin: 'https://app.example.com' }, // browser origins allowed to connect
    },
  },
});
```

`ws` adapter defaults:

- `maxPayloadLength` is 1 MiB (1048576 bytes) when not set; a larger message closes the connection (close code 1009).
- `websocket.compression: true` turns on permessage-deflate, and `maxPayloadLength` then also bounds a message once inflated; see [Compression](#compression). Without the option messages are sent uncompressed.
- When `cors.origin` is not set, browser connections are accepted from the same origin only (the `Origin` header's host must equal the request's `Host` header), and clients that send no `Origin` header (non-browser clients) are accepted. Set `cors.origin` to an origin, a list, a `RegExp`, a function, or `'*'` to allow other origins; the adapter logs one line at startup while it is unset. Behind a reverse proxy that rewrites the `Host` header, set `cors.origin` to the site's public origin.
- `verifyClient(info)` runs after the origin check and may be `async`; returning `false` (or a promise that resolves to `false`) refuses the upgrade. A refused upgrade is answered `401`.
- Each namespace has its own sockets and its own rooms, as on the native engine adapter: `socket.broadcast` reaches every other socket that joined the same namespace, `socket.to(room)` reaches the members of that room in the same namespace (the sender too when it is one), and a namespace's `emit()`, `to(room)` and `getSockets()` cover that namespace only. The adapter's base path, and a path below it with no namespace of its own, are served by the default namespace `/`.
- A namespace middleware that calls `next(err)` closes the socket (close code 1008) before it joins the namespace.
- `connection`, `disconnect`, `close` and `error` are raised by the adapter only; a client frame with one of those event names is ignored. In the other direction every name is an event for the client, as on the other adapters: `socket.emit('error', data)` and `socket.emit('close', data)` send `{ "event": "error" | "close", "data": ... }` and run no server-side handler.

### 5. Disable WebSockets Entirely

```typescript
import { Moro } from '@morojs/moro';

// No WebSocket dependencies required. This is also the default when no
// `websocket` option is passed.
const app = new Moro({
  websocket: false,
});

// With WebSockets off, registering a namespace makes the server fail to start:
// app.websocket('/chat', {}); // listen() fails: "WebSocket features require a WebSocket adapter."
```

### 6. Custom Adapter Implementation

```typescript
import {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketConnection,
  ClientAddressResolver,
} from '@morojs/moro';

class CustomWebSocketAdapter implements WebSocketAdapter {
  private resolveClientAddress?: ClientAddressResolver;

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

  // Optional. Called before the server listens when server.trustProxy is
  // set: resolve(peer, xForwardedFor) gives the client's address the way
  // req.ip is derived. Use it for socket.ip; without the method, report the peer.
  setClientAddressResolver(resolve: ClientAddressResolver): void {
    this.resolveClientAddress = resolve;
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

No additional dependencies needed! WebSockets stay off unless you enable them; `websocket: false` says so explicitly.

## Migration from Previous Versions

### Before (Required Socket.IO)

```typescript
import { Moro } from '@morojs/moro';

const app = new Moro(); // Socket.IO was always included
```

### After (Optional Adapters)

```typescript
import { Moro, SocketIOAdapter, WSAdapter } from '@morojs/moro';

// Option 1: No adapter: the native engine serves WebSockets (on the Node.js
// server, an installed socket.io or ws is detected instead)
const app = new Moro({ websocket: { enabled: true } });

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

// Option 4: Disable WebSockets (the default)
const app = new Moro({ websocket: false });
```

## Benefits

1. **Bundle Size**: Only include WebSocket dependencies if needed
2. **Performance**: The native engine serves WebSockets from the same native core as HTTP, with no extra dependency
3. **Flexibility**: Easy to switch between different implementations
4. **Future-Proof**: Easy to add new WebSocket libraries as they emerge
5. **Zero Changes**: Drop-in replacement - your code remains the same

## Adapter Comparison

| Adapter                     | Bundle Size              | Performance                | Features                                    | Use Case                                                |
| --------------------------- | ------------------------ | -------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| **Native engine** (default) | none (ships with MoroJS) | **Fastest of the three**   | Same port as HTTP, backpressure, raw frames | **Production apps, real-time, high traffic**            |
| Socket.IO                   | ~244KB                   | Good (60-80k msg/s)        | Rich features, rooms, namespaces, fallbacks | General purpose, feature-rich apps, broad compatibility |
| Native WS                   | ~8KB                     | Very Good (100-150k msg/s) | Standards-compliant, lightweight            | Performance-conscious, minimal footprint                |
| None                        | 0KB                      | N/A                        | HTTP only                                   | REST APIs, static sites                                 |

*_Performance numbers are approximate and based on 1000 concurrent connections_

## uWebSockets.js

The uWebSockets.js adapter was removed in MoroJS 1.8.24; the native engine replaced it. `websocket.adapter: 'uws'` is still accepted and now means the engine's own WebSocket support, so an existing configuration keeps working. The `UWebSocketsAdapter` export is gone; remove imports of it. See the [HTTP Engine Guide](./HTTP_ENGINE_GUIDE.md#coming-from-uwebsocketsjs).
