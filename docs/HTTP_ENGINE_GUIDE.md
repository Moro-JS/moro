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

- The `MORO_SERVER_ENGINE` environment variable overrides a config-file value; a `server.engine` passed to `createApp()` overrides both.
- `app.engine.fallbackReason` says why the Node.js server is serving when the engine was expected.
- `app.engine.engineBinary` is set only when the `MORO_ENGINE_BINARY` environment variable made the engine load the native binary at that path in place of the installed one (instrumented builds, A/B runs). The `HTTP engine: ...` lines logged at start-up then name the path, so a process running on another binary says so every time it starts.
- The old `'auto'` and `'native'` values map to `'moro'`.

## What the engine serves

| Feature    | On the engine                  | Notes                                                                                                                                                |
| ---------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP/1.1   | yes                            | keep-alive, pipelining, chunked bodies, limits and timeouts from `server.limits` / `server.timeouts`                                                 |
| HTTP/2     | yes (`@morojs/engine` 1.1.19+) | `server.http2: true`; ALPN `h2` on TLS, prior knowledge on cleartext, HTTP/1.1 on the same port. See the [HTTP/2 Guide](./HTTP2_GUIDE.md)            |
| TLS        | yes                            | `server.ssl`, one config for every backend. See the [Configuration Reference](./CONFIGURATION_REFERENCE.md)                                          |
| WebSockets | yes                            | `app.websocket()`, once enabled with `websocket: { enabled: true }`; upgrades share the HTTP port. See [WebSocket Adapters](./WEBSOCKET-ADAPTERS.md) |
| Clustering | yes                            | `performance.clustering`; worker threads in one process on macOS and Linux. Linux spreads connections over the workers; macOS sends them all to one  |

An older engine that lacks a feature is detected by capability, not by version: for example, HTTP/2 with an engine before 1.1.19 is served by the Node.js HTTP/2 server instead (unless `engine: 'moro'` is set explicitly, which keeps the engine on HTTP/1.1 and logs a warning). The same goes for combinations: a WebSocket handshake is upgraded inside the engine only when the engine reports that as safe together with its batching of pipelined requests, and by the framework otherwise. An application sees no difference between the two.

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

The engine applies these `server.ssl` keys: the certificate material (`key` / `cert` / `ca` or their file forms, `passphrase`; every certificate of a `ca` list is trusted), `minVersion`, `requestCert`, `rejectUnauthorized`, `ciphers` and `ecdhCurve`. `ciphers` is read as Node.js reads it: names that start with `TLS_` choose the TLS 1.3 suites, the rest is the TLS 1.2 cipher list. The engine has no option for `maxVersion`, `honorCipherOrder`, `sigalgs` or `crl`: when one of them is set, a start-up warning names it and the listener runs without it. Use `engine: 'node'` where one of those four is required; the Node.js HTTPS and HTTP/2 servers apply every `server.ssl` key.

An app behind a proxy that terminates TLS (nginx, a load balancer) is not affected by any of this.

## Behind a proxy

The engine reads `server.trustProxy` like the Node.js servers do, with the same results: when it names the proxy in front of the app, `req.ip` is the client, `req.ips` the client and the trusted proxies, and `req.protocol`, `req.secure` and `req.hostname` follow `X-Forwarded-Proto` and `X-Forwarded-Host`; `req.socket.remoteAddress` stays the connected peer. Nothing is read or computed for it until a handler or a middleware asks for one of these properties. See [Behind a proxy](./CONFIGURATION_REFERENCE.md#behind-a-proxy) for the accepted forms and for what happens when the setting is left out.

The engine closes a connection that has been idle for 75 s (`server.timeouts.idle`; the default is applied by `@morojs/engine` releases after 1.1.21, see [Timeouts](#timeouts)), which is longer than an AWS Application Load Balancer or nginx keeps an idle connection to the app (60 s), so the proxy is the side that closes it and never sends a request down a connection the app has just closed. A Google Cloud Application Load Balancer keeps them for 600 s: set `timeouts: { idle: 620000 }` behind one. See [Idle connections behind a load balancer](./CONFIGURATION_REFERENCE.md#behind-a-proxy).

## Timeouts

The engine has two timeouts (`server.timeouts`, milliseconds, `0` disables):

| Setting   | Default                                                    | Closes                                                                                                                      |
| --------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `idle`    | `75000` with `@morojs/engine` after 1.1.21; not set before | A connection with no request in progress on which nothing has arrived for that long, after delivering what was already sent |
| `request` | `300000` (5 minutes)                                       | A request that is still arriving that long after its first byte, however steadily; it is answered `408`                     |

What they leave alone:

- A request a handler is working on. Neither timeout limits how long a handler takes, and a response streamed with `res.write()`, a server-sent event stream or a file sent with `res.sendFile()` runs for as long as it needs, with or without a heartbeat.
- WebSocket connections.
- An HTTP/2 connection while a handler holds one of its requests.

`request` covers the body as well as the headers, so an upload that takes longer than five minutes needs a higher value.

The `idle` default depends on the engine version, because engines up to 1.1.21 count one kind of connection as idle that is not: one whose response was written in full as soon as the request arrived, before the handler had waited for anything (a value returned straight away, `res.json()`, `res.end(body)`), and is still being read by the client. If the client needs longer than `idle` for it and sends nothing meanwhile, such an engine closes the connection before the body is complete. That takes a body too large for the socket's send buffer and a slow client (5 MB at 0.5 Mbit/s is 80 s). So:

- With `@morojs/engine` after 1.1.21 (it reports `capabilities.idleSparesDrainingResponse`), a connection with a response still to deliver is left alone, and an app that sets nothing gets the 75 s idle timeout.
- With an engine up to 1.1.21, an app that sets nothing gets no idle timeout, which is what every earlier release did, and the start-up log has one line saying so. Idle connections then stay open until the client or the proxy in front closes them.
- A `timeouts.idle` you set is applied as given on every engine version, `0` included. On an engine up to 1.1.21, choose it longer than your slowest client needs for your largest response written in one piece, or send large bodies as a stream or with `res.sendFile()`.

A third limit is the engine's own and has no setting in `server.timeouts`: a client that stops reading a response is closed after 300 s without any progress. A client that reads slowly but steadily is not. How much may be queued for one connection in the meantime is unbounded unless you set `server.limits.responseBackpressureLimit` (for example `'16mb'`): a connection with more than that queued and unsent is closed at once. Set it above the largest response your app writes in one piece, because that response is queued whole while the client reads it. See the [Configuration Reference](./CONFIGURATION_REFERENCE.md#server-section).

The `keepAlive` and `headers` timeouts belong to the Node.js server and do nothing on the engine. The full table is in the [Configuration Reference](./CONFIGURATION_REFERENCE.md).

## When to choose `engine: 'node'`

- You attach something to the raw Node.js `http.Server` that the engine has no equivalent for.
- You use the `socket.io` or `ws` WebSocket adapter. Both attach to a Node.js server, so MoroJS selects it for you when one of them is configured.
- You are on an edge or serverless runtime, where no listening server is used at all (selected automatically).

Routes, middleware, validation, and request and response objects behave the same on both backends; a conformance suite in the repository holds them to identical responses.

## Coming from uWebSockets.js

MoroJS 1.8.24 removed its uWebSockets.js integration. The native engine replaced it: it is faster in our measurements, installs from npm with prebuilt binaries, and supports HTTP/2, worker-thread clustering and certificate reload, which the uWebSockets.js integration did not.

Existing configurations keep working. None of these stops an app from booting; each runs the app on the Moro engine, and the first three log one warning:

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

**A response header I set is not in the response.** The engine leaves out a header whose value contains a control character (a line break, a NUL, anything below a space except a tab) or whose name is not a valid header name, because such a header could otherwise split the response in two. The usual cause is a value written over several lines in the source, such as a `Content-Security-Policy` in a template literal: join it into one line. The app logs a warning naming the header (`Response header "content-security-policy" was not sent: ...`), once per header name. To keep this free for every other response, the check looks at each response that carries headers while the process is young and at a sample of them afterwards, so a header that is wrong on every response of a route is reported at once or shortly after, while one that is wrong only occasionally (a value copied from a request) may go unreported; the header is left out either way. The Node.js server (`engine: 'node'`) throws `ERR_INVALID_CHAR` from `res.setHeader()` for the same value.

**A request line with a whole URL.** A request whose target is a URL (`GET http://example.com/users/7 HTTP/1.1`, the form a client sends to a proxy) is routed by the path of that URL. `req.path` and `req.url` hold the path and query, and `req.headers.host` and `req.hostname` hold the host of the URL, whatever the `Host` header said (RFC 9112, section 3.2.2). The Node.js HTTP/1 server leaves such a target as it was sent, so no route matches it there (`404`).

**`EADDRINUSE` with clustering on Windows.** Clustering on Windows uses the Node.js server and worker processes, because the engine's workers share a port through `SO_REUSEPORT`, which Windows lacks. MoroJS makes this choice itself.

## See also

- [Configuration Reference](./CONFIGURATION_REFERENCE.md)
- [HTTP/2 Guide](./HTTP2_GUIDE.md)
- [Performance](./PERFORMANCE.md)
- [WebSocket Adapters](./WEBSOCKET-ADAPTERS.md)
