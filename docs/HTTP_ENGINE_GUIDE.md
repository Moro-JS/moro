# HTTP Engine Guide

## Overview

MoroJS serves HTTP from its own native engine, `@morojs/engine`, by default. The engine is a dependency of the framework with prebuilt binaries per platform and Node version, so there is nothing to install or configure. Where it cannot load (a platform or Node ABI without a prebuilt binary), the Node.js http server takes over automatically and the app still boots.

`server.engine` selects the backend:

- `engine: 'moro'` (**default**): the native engine, with the Node.js server as its fallback
- `engine: 'node'`: the Node.js http server, no native engine

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp({
  server: {
    engine: 'moro', // the default; may be left out
  },
});

// What actually booted (also logged at startup)
app.engine;
// { server: 'engine', enginePackage: '@morojs/engine', engineVersion: '1.1.20', protocols: ['http/1.1'] }
```

- The `MORO_SERVER_ENGINE` environment variable overrides the config value.
- `app.engine.fallbackReason` says why the Node.js server is serving when the engine was expected.
- The old `'auto'` and `'native'` values map to `'moro'`.

## What the engine serves

| Feature    | On the engine                  | Notes                                                                                                                                     |
| ---------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP/1.1   | yes                            | keep-alive, pipelining, chunked bodies, limits and timeouts from `server.limits` / `server.timeouts`                                      |
| HTTP/2     | yes (`@morojs/engine` 1.1.19+) | `server.http2: true`; ALPN `h2` on TLS, prior knowledge on cleartext, HTTP/1.1 on the same port. See the [HTTP/2 Guide](./HTTP2_GUIDE.md) |
| TLS        | yes                            | `server.ssl`, one config for every backend. See the [Configuration Reference](./CONFIGURATION_REFERENCE.md)                               |
| WebSockets | yes                            | `app.websocket()`; upgrades share the HTTP port. See [WebSocket Adapters](./WEBSOCKET-ADAPTERS.md)                                        |
| Clustering | yes                            | `performance.clustering`; worker threads in one process on macOS and Linux                                                                |

An older engine that lacks a feature is detected by capability, not by version: for example, HTTP/2 with an engine before 1.1.19 is served by the Node.js HTTP/2 server instead.

## TLS

```typescript
const app = await createApp({
  server: {
    ssl: { keyFile: './key.pem', certFile: './cert.pem' }, // or inline: { key, cert, ca }
  },
});

app.engine.tls;
// { library: 'boringssl', version: '0.20261105.0', date: '2026-11-05', reason: 'default' }
```

From `@morojs/engine` 1.1.20 the engine terminates TLS with a BoringSSL it bundles, and can use the OpenSSL of the running Node.js instead (`server.ssl.library`, or the `MORO_ENGINE_TLS` environment variable). It chooses OpenSSL by itself when Node's OpenSSL is specially configured (FIPS mode, `--openssl-config`, `OPENSSL_CONF`) or when the certificate or cipher configuration is one BoringSSL has no support for. Keep `@morojs/engine` updated: its TLS fixes arrive through engine releases.

An app behind a proxy that terminates TLS (nginx, a load balancer) is not affected by any of this.

## When to choose `engine: 'node'`

- You attach something to the raw Node.js `http.Server` that the engine has no equivalent for.
- You use the `socket.io` or `ws` WebSocket adapter. Both attach to a Node.js server, so MoroJS selects it for you when one of them is configured.
- You are on an edge or serverless runtime, where no listening server is used at all (selected automatically).

Routes, middleware, validation, and request and response objects behave the same on both backends; a conformance suite in the repository holds them to identical responses.

## Coming from uWebSockets.js

MoroJS 1.8.24 removed its uWebSockets.js integration. The native engine replaced it: it is faster in our measurements, installs from npm with prebuilt binaries, and supports HTTP/2, worker-thread clustering and certificate reload, which the uWebSockets.js integration did not.

Existing configurations keep working. None of these stops an app from booting; each runs the app on the Moro engine and logs one warning:

| Old setting                   | What happens now                                              |
| ----------------------------- | ------------------------------------------------------------- |
| `server.engine: 'uws'`        | runs on the Moro engine (as `engine: 'moro'`)                 |
| `server.useUWebSockets: true` | runs on the Moro engine                                       |
| `MORO_SERVER_ENGINE=uws`      | runs on the Moro engine                                       |
| `websocket.adapter: 'uws'`    | the engine's own WebSocket support, as when no adapter is set |

To finish the migration:

1. Remove those settings.
2. Remove `uWebSockets.js` from your `package.json`; MoroJS no longer loads it.
3. If you imported `UWebSocketsHttpServer` or `UWebSocketsAdapter` from `@morojs/moro`, remove those imports. Those two exports are gone; `app.websocket()` and the default engine need neither.

## Troubleshooting

**The app runs on the Node.js server and I expected the engine.** Read `app.engine.fallbackReason`; the same text is logged at startup. The usual causes are a platform without a prebuilt binary, or npm's optional-dependency lockfile bug (`rm -rf node_modules package-lock.json && npm install`).

**`EADDRINUSE` with clustering on Windows.** Clustering on Windows uses the Node.js server and worker processes, because the engine's workers share a port through `SO_REUSEPORT`, which Windows lacks. MoroJS makes this choice itself.

## See also

- [Configuration Reference](./CONFIGURATION_REFERENCE.md)
- [HTTP/2 Guide](./HTTP2_GUIDE.md)
- [Performance](./PERFORMANCE.md)
- [WebSocket Adapters](./WEBSOCKET-ADAPTERS.md)
