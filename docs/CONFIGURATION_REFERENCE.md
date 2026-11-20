# MoroJS Configuration Reference

This document provides a comprehensive reference for all configuration options available in MoroJS. Configuration can be provided through environment variables, configuration files (`moro.config.js` or `moro.config.ts`), or programmatically.

## Table of Contents

- [Configuration Sources](#configuration-sources)
- [Server Configuration](#server-configuration)
- [Service Discovery](#service-discovery)
- [Database Configuration](#database-configuration)
- [Module Defaults](#module-defaults)
- [Auto-Discovery Configuration](#auto-discovery-configuration)
- [Routing Configuration](#routing-configuration)
- [Logging Configuration](#logging-configuration)
- [Security Configuration](#security-configuration)
- [External Services](#external-services)
- [Performance Configuration](#performance-configuration)
- [WebSocket Configuration](#websocket-configuration)
- [Authentication Configuration](#authentication-configuration)
- [Session Configuration](#session-configuration)
- [Cache Configuration](#cache-configuration)
- [CDN Configuration](#cdn-configuration)
- [Runtime Configuration](#runtime-configuration)
- [Environment Variables](#environment-variables)

## Configuration Sources

MoroJS loads configuration from multiple sources in this order of priority:

1. **`createApp()` Options** (highest priority)
2. **Environment Variables**
3. **Configuration Files** (`moro.config.js` or `moro.config.ts`)
4. **Schema Defaults** (lowest priority)

### Configuration Files

Create a `moro.config.js` or `moro.config.ts` file in your project root. MoroJS loads the first of `moro.config.cjs`, `moro.config.js` and `moro.config.ts` that exists:

```javascript
// moro.config.js
export default {
  server: {
    port: 3001,
    host: 'localhost',
  },
  database: {
    url: 'postgresql://user:pass@localhost:5432/mydb',
  },
  logging: {
    level: 'info',
    format: 'pretty',
  },
};
```

```typescript
// moro.config.ts
import type { AppConfig, DeepPartial } from '@morojs/moro';

const config: DeepPartial<AppConfig> = {
  server: {
    port: 3001,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  logging: {
    level: 'info',
    format: 'pretty',
  },
};

export default config;
```

**Note:** Use `DeepPartial<AppConfig>` instead of `Partial<AppConfig>` to properly handle nested configuration objects. `DeepPartial` makes all nested properties optional, while `Partial` only makes top-level properties optional.

**Note:** MoroJS is an ES module package, so in a project with `"type": "module"` a `moro.config.js` must use `export default`; a CommonJS config (`module.exports = { ... }`) goes in `moro.config.cjs`. A `moro.config.ts` is imported as it is and needs a runtime that loads TypeScript (for example `tsx` or `ts-node`).

**A config file that exists but cannot be loaded** (a syntax error, an import that cannot be resolved, a TypeScript file with no loader) is logged as an error. When `NODE_ENV` is `production` the app then does not start: `createApp()` rejects with an error named `ConfigFileLoadError`, whose `file` is the path and whose `cause` is the original error. An app that started anyway would run on defaults: the default port, no TLS, the security sections off. Outside production the app starts from environment variables, `createApp()` options and defaults. Having no config file at all is not an error in any mode.

**Where the file is looked for.** In the working directory of the process, which is the project root when the app is started from there. The file that was loaded is logged at `info` level with its full path. To load one particular file whatever the working directory is, name it in the `MORO_CONFIG_FILE` environment variable:

```bash
MORO_CONFIG_FILE=/srv/app/moro.config.cjs node /srv/app/dist/index.js
```

The path is absolute, or relative to the working directory, and the file may have any name. Nothing else is looked for then; a file that does not exist is reported like one that cannot be loaded (start-up stops in production). When a configuration file is found through the working directory and the application was not started from there (neither the script the process was started with nor the installed framework is under it), one `info` line names the file and the directory, so a service started from an unexpected place shows what it loaded. The same line is logged for a module directory and a route directory found that way; see [Files found at start-up](./SECURITY_DEFAULTS.md#files-found-at-start-up).

## Server Configuration

### `server` Section

Configure the HTTP server settings.

| Property           | Type               | Default       | Description                                                                     |
| ------------------ | ------------------ | ------------- | ------------------------------------------------------------------------------- |
| `port`             | `number`           | `3001`        | Server port to listen on (1-65535)                                              |
| `host`             | `string`           | `'localhost'` | Server host to bind to                                                          |
| `engine`           | `string`           | `'moro'`      | `'moro' \| 'node'`; unset ⇒ moro with Node fallback                             |
| `bodySizeLimit`    | `string \| number` | `'10mb'`      | Non-multipart body cap (413 over): a size string or a number of bytes           |
| `maxUploadSize`    | `string \| number` | `'100mb'`     | Multipart body cap (413 over): a size string or a number of bytes               |
| `maxConnections`   | `number`           | `0`           | Max concurrent connections; `0` = unlimited (**was `1000`**, see below)         |
| `timeout`          | `number`           | `0`           | **Deprecated.** The old name of `timeouts.request` (see below)                  |
| `gracefulShutdown` | `boolean`          | `true`        | Drain and close on SIGINT/SIGTERM; `false` leaves the signals to your app       |
| `handleUncaught`   | `boolean`          | `false`       | Also drain and exit(1) on an uncaught exception or unhandled rejection          |
| `backlog`          | `number`           | (unset)       | TCP listen backlog; unset ⇒ `512` on the native engine, Node's `511` otherwise  |
| `ssl`              | `object`           | (none)        | Unified TLS config (both shapes)                                                |
| `trustProxy`       | `bool\|num\|list`  | (unset)       | Which proxies may say who the client is (see [Behind a proxy](#behind-a-proxy)) |
| `timeouts`         | `object`           | see below     | Request and idle timeouts (ms)                                                  |
| `limits`           | `object`           | see below     | Fine-grained size/count limits                                                  |
| `http2`            | `bool\|obj`        | (off)         | ALPN h2 + http/1.1 (requires TLS)                                               |

**SSL/TLS** (`server.ssl`) — one config, both shapes, flows to every runtime:

```javascript
// inline PEM (node-style)
await createApp({ server: { ssl: { key, cert, ca, passphrase } } });
// file paths (works everywhere)
await createApp({ server: { ssl: { keyFile, certFile, caFile, passphrase } } });
// also: minVersion / maxVersion 'TLSv1.2'|'TLSv1.3', requestCert, rejectUnauthorized,
//   ciphers, honorCipherOrder, ecdhCurve, sigalgs, crl
// watch: true | { debounceMs } - reload the certificate when the files change
//   (file-path shape; same as calling app.reloadTLS() after a rotation)
// library: 'boringssl' | 'openssl' | 'auto' - the native engine's TLS library
```

The Moro engine terminates TLS in-process; Node uses
`https.createServer`; HTTP/2 uses it too. `options.https` remains a supported
alias.

**TLS policy.** The keys beyond the certificate material mean what they mean
to Node's `tls.createSecureContext()` / `tls.createServer()`:

| Key                  | Type                     | Node.js HTTPS and HTTP/2 servers | Native engine            |
| -------------------- | ------------------------ | -------------------------------- | ------------------------ |
| `ca`                 | PEM, or a list           | applied                          | applied (the whole list) |
| `requestCert`        | `boolean`                | applied                          | applied                  |
| `rejectUnauthorized` | `boolean`                | applied                          | applied                  |
| `minVersion`         | `'TLSv1.2' \| 'TLSv1.3'` | applied                          | applied                  |
| `maxVersion`         | `'TLSv1.2' \| 'TLSv1.3'` | applied                          | not applied (warning)    |
| `ciphers`            | `string`                 | applied                          | applied                  |
| `honorCipherOrder`   | `boolean`                | applied                          | not applied (warning)    |
| `ecdhCurve`          | `string`                 | applied                          | applied                  |
| `sigalgs`            | `string`                 | applied                          | not applied (warning)    |
| `crl`                | PEM, or a list           | applied                          | not applied (warning)    |

Mutual TLS is `requestCert: true` with `rejectUnauthorized: true` and the
issuing CA in `ca`: a client without a certificate, or with one that `ca` did
not issue, is refused during the handshake on every server. In `ciphers`, names
that start with `TLS_` choose the TLS 1.3 suites and the rest is the cipher
list for TLS 1.2; on the native engine the two parts are handed over
separately, with the same result. When a key in the "not applied" column is set
and the app runs on the native engine, one start-up warning names it: the
listener runs without it. Use `server.engine: 'node'` where that key is
required. Any other key under `server.ssl` (`dhparam`, `secureOptions`, a
misspelling) is not read by any server and is named in a start-up warning too.
`app.reloadTLS()` keeps the policy and the CA unless the update names them.

**TLS library** (`server.ssl.library`, `@morojs/engine` 1.1.20+). The engine
ships with BoringSSL bundled and uses it by default; `'openssl'` uses the
OpenSSL of the running Node.js instead. `'auto'` (the default) is BoringSSL
unless Node's OpenSSL is specially configured — FIPS mode, `--openssl-config`
and its relatives, `OPENSSL_CONF` — in which case it is OpenSSL, so a FIPS or
provider setup keeps working with nothing to change. The choice is per
process (the first app started decides); the environment variable
`MORO_ENGINE_TLS` sets it without a code change, and `app.engine.tls` reports
the library in use and why:

```javascript
app.engine.tls;
// { library: 'boringssl', version: '0.20261105.0', date: '2026-11-05', reason: 'default' }
```

The bundled BoringSSL is updated through engine releases, which follow
upstream's snapshots automatically (about every three weeks). Keep
`@morojs/engine` updated as you keep Node.js updated; a TLS server on a build
more than 180 days old logs a `MORO_ENGINE_TLS_STALE` process warning. The
Node.js server has one TLS library and ignores `library`.

#### Behind a proxy

Behind a reverse proxy, a load balancer or a Kubernetes ingress, the
connection the app sees comes from the proxy. The proxy passes the client on
in `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`, and any
client can send those headers as well, so they are believed only from the
proxies named in `server.trustProxy`:

| `trustProxy`                     | Meaning                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| not set (default)                | As in earlier releases, see below                                                                                                      |
| `false`, `0`                     | No proxy is trusted: the forwarded headers are ignored                                                                                 |
| `true`                           | Every hop is trusted: `req.ip` is the left-most `X-Forwarded-For` entry. Only safe when the proxy replaces that header                 |
| a number `n`                     | The `n` hops nearest the app are trusted (`1` = the proxy connected to the app)                                                        |
| an address, a CIDR range, a name | A hop is trusted when its address matches: `'10.0.0.0/8'`, `'192.168.1.7'`, `'fd00::/8'`, `'loopback'`, `'linklocal'`, `'uniquelocal'` |
| a list of those                  | An array, or one string with commas: `['loopback', '10.0.0.0/8']`                                                                      |

With `trustProxy` set, on every server (Node.js, HTTP/2, native engine):

- `req.ip` is the client: walking from the connection outwards through
  `X-Forwarded-For`, the first address that is not a trusted proxy (the
  left-most entry when every hop is trusted).
- `req.ips` is that client followed by the trusted proxies it came through,
  and empty when the connected peer is not trusted.
- `req.protocol` and `req.secure` come from `X-Forwarded-Proto`, and
  `req.hostname` from `X-Forwarded-Host`, when the connected peer is trusted.
  Otherwise they describe the connection itself and the `Host` header.
- `req.socket.remoteAddress` stays the connected peer.
- A WebSocket connection reports the same client: `socket.ip` (and
  `socket.handshake.address` on the native engine) is derived from the
  handshake request the way `req.ip` is, on the native engine, `ws` and
  Socket.IO adapters. Without `trustProxy` it is the connected peer, as before.

The meaning of each form is that of Express's `trust proxy`. Not supported: a
function, and the netmask spelling of a range (`10.0.0.0/255.0.0.0`). The names
stand for `127.0.0.0/8` and `::1` (`loopback`), `169.254.0.0/16` and
`fe80::/10` (`linklocal`), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and
`fc00::/7` (`uniquelocal`). An IPv4 peer reported as `::ffff:10.0.0.1` matches
IPv4 ranges. A value that is none of these forms stops start-up with a
`ConfigValidationError`.

```javascript
// One ingress in front of the app
export default { server: { trustProxy: 1 } };

// Only the cluster's own address ranges
export default { server: { trustProxy: ['10.0.0.0/8', '172.16.0.0/12'] } };
```

**Not set.** The behaviour of earlier releases is kept exactly: `req.ip` is
the connected peer (the proxy, when there is one), while `req.ips`,
`req.protocol` and `req.secure` read `X-Forwarded-For` and `X-Forwarded-Proto`
from any client, and `X-Forwarded-Host` is not read. An app that is reached
directly should set `trustProxy: false` so those headers are ignored; an app
behind a proxy should name the proxy, so that `req.ip`, and with it the rate
limit, the logs and anything else keyed on the client address, is the client
and not the proxy. `middleware.session({ proxy: true })` and the CSRF
middleware read `X-Forwarded-Proto` themselves when they decide whether a
cookie is `Secure`; `trustProxy` does not change that. Every other cookie
(`res.cookie()` with no `secure` option, the session cookie without `proxy`)
is `Secure` only for a TLS connection to this server while `trustProxy` is not
set: a forwarded header nobody was told to trust does not make it so.

**Idle connections behind a load balancer.** A proxy that keeps connections
to the app open for reuse has to be the side that closes them when they go
idle. If the app closes one first, the proxy can send the next request down a
connection that is already gone, and the client gets a `502`. So the app's
idle timeout must be longer than the proxy's:

| Proxy                                  | Keeps an idle connection to the app for | On the native engine (`idle` is 75 s) |
| -------------------------------------- | --------------------------------------- | ------------------------------------- |
| AWS Application Load Balancer          | 60 s (the default idle timeout)         | Nothing to set                        |
| nginx with `keepalive` to the upstream | 60 s (the default `keepalive_timeout`)  | Nothing to set                        |
| Google Cloud Application Load Balancer | 600 s (fixed)                           | `timeouts: { idle: 620000 }`          |

The 75 s default is applied by `@morojs/engine` releases after 1.1.21. With
1.1.21 or older the engine applies no idle timeout unless you set one (see
`idle` below), so it never closes an idle connection before the proxy does,
and the table holds as it stands: set the Google Cloud value now, and it is
already right when the engine is updated.

On the Node.js server (`server.engine: 'node'`) the setting that matters here
is `timeouts.keepAlive`, and its 5 s default is shorter than every proxy in
the table: set it above the proxy's value there.

```javascript
// Node.js server behind an AWS Application Load Balancer or nginx
export default { server: { engine: 'node', timeouts: { keepAlive: 75000 } } };

// Native engine behind a Google Cloud Application Load Balancer
export default { server: { timeouts: { idle: 620000 } } };
```

The proxy's idle timeout also applies to a response that is silent: a
server-sent event stream with no event for 60 s is closed by such a load
balancer, whatever the app's timeouts are. `middleware.sse({ heartbeat: 30000 })`
sends a comment line every 30 s and keeps the stream open.

**Timeouts** (`server.timeouts`, milliseconds; `0` disables that timeout):

| Key         | Default                                                                                                                                           | Server                               | What it bounds                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| `request`   | `300000` (5 minutes)                                                                                                                              | Native engine, Node.js HTTP/1 server | The time a client may take to deliver one complete request          |
| `idle`      | `75000` on the HTTP/2 server and on the native engine (`@morojs/engine` after 1.1.21); not set on an older engine or on the Node.js HTTP/1 server | All                                  | The time a connection may stay open with nothing happening on it    |
| `keepAlive` | `5000`                                                                                                                                            | Node.js HTTP/1 server                | The time a keep-alive connection is kept between two requests       |
| `headers`   | `6000`                                                                                                                                            | Node.js HTTP/1 server                | The time a client may take to send the request line and the headers |

`request` is counted from the first byte of a request to its last, headers
and body, and does not start again when more bytes arrive, so a client that
sends one byte at a time is bounded too. It covers receiving the request, not
answering it: a handler may take longer than this, and so may the response. On
the native engine a request that is still arriving when the time is up is
answered `408` and the connection is closed. An upload that legitimately takes
more than five minutes (a large file on a slow link) needs a higher value.
The default is Node's own `requestTimeout`, so the native engine and the
Node.js server behave alike; on the Node.js server `0` leaves Node's 300 s in
place. The dedicated HTTP/2 server does not apply `request`.

`idle` depends on the server:

- **Native engine.** A connection is closed when no bytes have arrived on it
  for this long and no request is in progress: a connection that never sends
  a request, and a keep-alive connection between requests. The responses
  already sent are delivered in full first, and the connection is closed in an
  orderly way. A request a handler is working on is not idle, however long it
  takes: a slow handler, a response streamed with `res.write()`, server-sent
  events and a file sent with `res.sendFile()` are not closed by `idle` or by
  `request`, with or without a heartbeat. WebSocket connections are exempt
  from both.

  The 75 s default is applied only by an engine that also leaves a
  connection alone while a response is still being delivered to it:
  `@morojs/engine` releases after 1.1.21, which report
  `capabilities.idleSparesDrainingResponse`. On an engine up to 1.1.21 one
  case is counted as idle although the response is not delivered yet: a
  response written in full as soon as the request arrives, before the handler
  has waited for anything such as a database, a file or a timer (a value
  returned straight away, `res.json()` or `res.end(body)` with nothing awaited
  first). If the client then takes longer than `idle` to read it and sends
  nothing meanwhile, the connection is closed with the body cut short. That
  takes a body too large for the socket's send buffer and a slow client: 5 MB
  at 0.5 Mbit/s needs 80 s, for example. So on those engines an app that does
  not set `timeouts.idle` gets no idle timeout, as in the releases before the
  default existed: an idle connection stays open until the client or a proxy
  closes it, and a line in the start-up log says that the default is not
  applied. A value you set is handed to every engine version as given, `0`
  included. On an engine up to 1.1.21, choose it longer than your slowest
  client needs for your largest response written in one piece, or send such
  responses as a stream or with `res.sendFile()`; a response sent after the
  handler has waited for I/O is not affected either.

  Separately, a client that stops reading a response altogether is closed by
  the engine after 300 s without progress; that limit has no setting here.
  `limits.responseBackpressureLimit` (below) bounds how much may wait for
  such a client in the meantime.

- **HTTP/2 server** (`server.engine: 'node'` with `http2`). `idle` is counted
  per connection, over frames in either direction. A connection on which
  nothing has moved for this long is told to go away (`GOAWAY`): requests in
  progress on it finish, new requests use a new connection, and the connection
  closes after the last response.
- **Node.js HTTP/1 server.** `idle` is Node's socket inactivity timeout
  (`server.timeout`) and is off unless you set it. Idle connections are closed
  without it: `keepAlive` closes a connection between requests, and `headers`
  one that never sends a request (Node checks every 30 s). When set, `idle`
  also closes a connection whose handler or stream is silent for that long,
  and it does not shorten `keepAlive`.

`server.timeout` is the old name of `timeouts.request`. A value above `0` is
used as the request timeout when `timeouts.request` is not given in the
configuration file, the environment or `createApp()`, and a start-up warning
names the new key. When both are given, `timeouts.request` wins, an explicit
`0` included. Write `timeouts: { request: 30000 }`.

**Sizes** (`bodySizeLimit`, `maxUploadSize` and the size values under
`limits`): a number of bytes, or digits followed by `b`, `kb`, `mb` or `gb`
(`'512kb'`, `'10mb'`, `'1.5 mb'`; a bare `'1024'` is bytes). Nothing may
follow the unit. `bodySizeLimit` and `maxUploadSize` accept any other string
too, and the size parser then falls back to 10 MB; so does a `limits` value
with a space before or after it (`'16kb '`). Each such value is named in a
start-up warning together with the size in force.

**Process signals.** With `gracefulShutdown` on (the default) the first
SIGINT/SIGTERM closes the app through `app.close()` and a second one exits at
once. Requests in flight get 2 seconds to finish; with
`performance.clustering` the workers get 3 seconds to close before the
primary ends them. Set `gracefulShutdown: false` when your own code handles
the signals.
`handleUncaught: true` additionally drains and exits with code 1 on an
uncaught exception or unhandled promise rejection.

**Limits** (`server.limits`) — every one a documented default, not a hard cap;
passed through to the engine: `maxHeaderSize`, `maxHeaders` (100),
`wsMaxMessageSize` ('16mb'), `wsBackpressureLimit` ('1mb', 0=unlimited),
`writeHighWaterMark` ('256kb'), `maxPendingBytes`,
`responseBackpressureLimit` (not set), and
`multipart: { maxParts (1000), maxPartHeaderBytes ('16kb'), maxFiles, maxFileSize }`.

`responseBackpressureLimit` (native engine; a size such as `'16mb'` or a
number of bytes) is how much response data one connection may have queued and
not yet sent. A connection that goes over it is closed at once. It is not set
by default, and `0` means the same: nothing bounds the queue then, and a
client that requests large responses and does not read them holds them in the
server's memory until the engine's other bound applies, which closes a
connection whose queue has made no progress for 300 s. A response written in
one piece (`res.json()`, `res.send()`, a returned value) is queued whole
while the client reads it, so the limit has to be larger than the largest
response the app writes that way: a smaller one cuts that response off for
every client, not only for a slow one. A response sent with `res.sendFile()`,
or with `res.write()` by a handler that waits for `'drain'`, only ever queues
what the client has not taken yet.

```javascript
// No response of this app is larger than a few megabytes
export default { server: { limits: { responseBackpressureLimit: '16mb' } } };
```

**HTTP/2** (`server.http2`): `true`, or `{ allowHTTP1, maxSessionMemory,
settings: { maxConcurrentStreams, initialWindowSize, maxFrameSize,
maxHeaderListSize, ... } }`. `settings.enablePush` is accepted but never sent
(RFC 9113 forbids a server from advertising it; push is the client's setting).
When `engine: 'moro'` and the engine build supports h2, it is served natively;
otherwise Moro's dedicated HTTP/2 server is used.

> **Migration:** `maxConnections` (1000→0) and `timeout` (30000→0) were
> previously validated but **never applied to any server**. `maxConnections`
> keeps its `0` default (unlimited), and an explicit value is applied. The
> request and idle timeouts now have the defaults in the table above (the
> idle default on the native engine needs `@morojs/engine` after 1.1.21), and
> `timeout` is applied as `timeouts.request` when that key is not given. An
> app that keeps connections open and idle for longer than 75 s, or accepts
> uploads that take longer than five minutes, sets `timeouts.idle` or
> `timeouts.request` to what it needs (`0` for no timeout, as before).

**Note**: Environment detection now uses `NODE_ENV` directly for consistency with the Node.js ecosystem. Use `isDevelopment()`, `isProduction()`, and `isStaging()` utility functions to check the current environment.

#### Example

```javascript
{
  server: {
    port: 8080,
    host: '0.0.0.0',
    maxConnections: 5000,
    timeouts: { request: 60000 },
    bodySizeLimit: 5 * 1024 * 1024 // bytes; '5mb' is the same
  }
}

// Environment is now controlled by NODE_ENV
// NODE_ENV=production node your-app.js
```

#### Environment Variables

- `PORT` or `MORO_PORT`
- `HOST` or `MORO_HOST`
- `NODE_ENV` (controls environment behavior - not part of server config)
- `MAX_CONNECTIONS` or `MORO_MAX_CONNECTIONS`
- `REQUEST_TIMEOUT` or `MORO_TIMEOUT` (writes `timeouts.request`)
- `MORO_IDLE_TIMEOUT`, `MORO_KEEPALIVE_TIMEOUT`, `MORO_HEADERS_TIMEOUT`
- `MORO_BACKLOG`, `MORO_MAX_HEADER_SIZE`, `MORO_MAX_HEADERS`, `MORO_WS_MAX_MESSAGE_SIZE`
- `MORO_MULTIPART_MAX_PARTS`, `MORO_MULTIPART_MAX_FILES`, `MORO_MULTIPART_MAX_FILE_SIZE`
- `MORO_SSL_KEY_FILE`, `MORO_SSL_CERT_FILE`, `MORO_SSL_CA_FILE`, `MORO_SSL_PASSPHRASE`
- `MORO_HTTP2`, `MORO_SERVER_ENGINE`

## Service Discovery

### `serviceDiscovery` Section

Configure service discovery for microservices architecture.

These settings are accepted and validated, but the framework does not start service discovery from them today. To register and look up services, create a `ServiceRegistry` (exported from `@morojs/moro`) with `type`, `consulUrl`, `kubernetesNamespace` and `healthCheckInterval`.

| Property              | Type                                   | Default                   | Description                                       |
| --------------------- | -------------------------------------- | ------------------------- | ------------------------------------------------- |
| `enabled`             | `boolean`                              | `false`                   | Enable service discovery                          |
| `type`                | `'memory' \| 'consul' \| 'kubernetes'` | `'memory'`                | Service discovery backend type                    |
| `consulUrl`           | `string`                               | `'http://localhost:8500'` | Consul server URL                                 |
| `kubernetesNamespace` | `string`                               | `'default'`               | Kubernetes namespace                              |
| `healthCheckInterval` | `number`                               | `30000`                   | Health check interval in milliseconds             |
| `retryAttempts`       | `number`                               | `3`                       | Number of retry attempts for failed health checks |

#### Example

```javascript
{
  serviceDiscovery: {
    enabled: true,
    type: 'consul',
    consulUrl: 'http://consul.internal:8500',
    healthCheckInterval: 15000,
    retryAttempts: 5
  }
}
```

#### Environment Variables

This section has no environment variable mappings: set it in `moro.config.js` / `moro.config.ts` or in `createApp()` options.

## Database Configuration

### `database` Section

Connection settings for your application to read. The section is validated and returned by `app.getConfig().database`, but MoroJS does not open a connection from it: create an adapter and register it with `app.database()` (see [Database Configurations](./EXAMPLE_CONFIG.md#database-configurations)).

| Property     | Type     | Default | Description                     |
| ------------ | -------- | ------- | ------------------------------- |
| `url`        | `string` | -       | Primary database connection URL |
| `redis`      | `object` | -       | Redis configuration             |
| `mysql`      | `object` | -       | MySQL configuration             |
| `postgresql` | `object` | -       | PostgreSQL configuration        |

#### Redis Configuration

| Property     | Type     | Default                    | Description                             |
| ------------ | -------- | -------------------------- | --------------------------------------- |
| `url`        | `string` | `'redis://localhost:6379'` | Redis connection URL                    |
| `maxRetries` | `number` | `3`                        | Maximum Redis connection retry attempts |
| `retryDelay` | `number` | `1000`                     | Redis retry delay in milliseconds       |
| `keyPrefix`  | `string` | `'moro:'`                  | Redis key prefix                        |

#### MySQL Configuration

| Property          | Type     | Default       | Description                |
| ----------------- | -------- | ------------- | -------------------------- |
| `host`            | `string` | `'localhost'` | MySQL host                 |
| `port`            | `number` | `3306`        | MySQL port                 |
| `database`        | `string` | -             | Database name              |
| `username`        | `string` | -             | Database username          |
| `password`        | `string` | -             | Database password          |
| `connectionLimit` | `number` | `10`          | Connection pool limit      |
| `acquireTimeout`  | `number` | `60000`       | Connection acquire timeout |
| `timeout`         | `number` | `60000`       | Query timeout              |

#### PostgreSQL Configuration

| Property          | Type      | Default       | Description           |
| ----------------- | --------- | ------------- | --------------------- |
| `host`            | `string`  | `'localhost'` | PostgreSQL host       |
| `port`            | `number`  | `5432`        | PostgreSQL port       |
| `database`        | `string`  | -             | Database name         |
| `user`            | `string`  | -             | Database user         |
| `password`        | `string`  | -             | Database password     |
| `connectionLimit` | `number`  | `10`          | Connection pool limit |
| `ssl`             | `boolean` | -             | Connect over TLS      |

A `redis`, `mysql` or `postgresql` object may leave properties out: each missing one takes the default from its table, whether the section comes from a config file, `createApp()` or environment variables. A property that is present is validated as written, and an invalid value stops the app at startup with a `ConfigValidationError`. None of the three sections exists until you write it (or set `REDIS_URL` / `MYSQL_HOST`).

#### Example

```javascript
{
  database: {
    url: 'postgresql://user:pass@localhost:5432/myapp',
    redis: {
      url: 'redis://redis.internal:6379',
      maxRetries: 5,
      retryDelay: 2000,
      keyPrefix: 'myapp:'
    },
    mysql: {
      host: 'mysql.internal',
      port: 3306,
      database: 'myapp_db',
      username: 'myapp_user',
      password: 'secure_password',
      connectionLimit: 20,
      acquireTimeout: 60000,
      timeout: 60000
    }
  }
}
```

#### Environment Variables

- `DATABASE_URL` or `MORO_DATABASE_URL`
- `REDIS_URL` or `MORO_REDIS_URL`
- `REDIS_MAX_RETRIES`
- `REDIS_RETRY_DELAY`
- `REDIS_KEY_PREFIX`
- `MYSQL_HOST` or `MORO_MYSQL_HOST`
- `MYSQL_PORT` or `MORO_MYSQL_PORT`
- `MYSQL_DATABASE` or `MORO_MYSQL_DB`
- `MYSQL_USERNAME` or `MORO_MYSQL_USER`
- `MYSQL_PASSWORD` or `MORO_MYSQL_PASS`
- `MYSQL_CONNECTION_LIMIT` or `MORO_MYSQL_CONNECTIONS`

The `REDIS_*` variables are read only when `REDIS_URL` (or `MORO_REDIS_URL`) is set, and the `MYSQL_*` variables only when `MYSQL_HOST` (or `MORO_MYSQL_HOST`) is set.

## Module Defaults

### `modules` Section

Configure default behaviors for modules.

#### API Prefix

| Property    | Type     | Default   | Description                                                       |
| ----------- | -------- | --------- | ----------------------------------------------------------------- |
| `apiPrefix` | `string` | `'/api/'` | Prefix for all module routes. Set to empty string `''` to disable |

The `apiPrefix` is prepended to all module routes. The final URL structure is:

```
{apiPrefix}/v{version}/{moduleName}{routePath}
```

**Examples:**

- Default (`'/api/'`): `/api/v1.0.0/user/list`
- No prefix (`''`): `/v1.0.0/user/list`
- Custom (`'/services/'`): `/services/v1.0.0/user/list`

```typescript
// moro.config.ts
export default {
  modules: {
    apiPrefix: '/api/', // Default. Use '' for no prefix, or a custom one such as '/v1/'
  },
};
```

#### Cache Defaults

Settings of the store behind route-level caching: `.cache()` on a route, the `cache` option of the direct form, and a module route's `cache`. Nothing is cached because of this section. Only a route that declares caching is cached, and `middleware.cache()` has options of its own.

| Property     | Type                       | Default | Description                                                                                                          |
| ------------ | -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `enabled`    | `boolean`                  | `false` | Accepted but not applied: it does not switch caching on or off for any route                                         |
| `defaultTtl` | `number`                   | `300`   | Lifetime in seconds of a cached route that names no `ttl` of its own (`.cache({})`). A route's own `ttl` always wins |
| `maxSize`    | `number`                   | `1000`  | Most responses the route cache keeps at once; past it the least recently used one leaves                             |
| `strategy`   | `'lru' \| 'lfu' \| 'fifo'` | `'lru'` | Accepted but not applied: the route cache always evicts the least recently used entry, whatever is set here          |

Each app has its own route cache, shared by every route of that app that declares caching and sized by that app's `maxSize` and `defaultTtl`. Several apps in one process neither share cached responses nor set each other's limits.

#### Rate Limit Defaults

These values are accepted but not applied by the framework today. To limit requests, register `middleware.rateLimit()` or call `.rateLimit()` on a route.

| Property                 | Type      | Default | Description                                     |
| ------------------------ | --------- | ------- | ----------------------------------------------- |
| `enabled`                | `boolean` | `false` | Enable rate limiting by default                 |
| `defaultRequests`        | `number`  | `100`   | Default requests per window                     |
| `defaultWindow`          | `number`  | `60000` | Default rate limit window in milliseconds       |
| `skipSuccessfulRequests` | `boolean` | `false` | Skip successful requests in rate limit counting |
| `skipFailedRequests`     | `boolean` | `false` | Skip failed requests in rate limit counting     |

#### Session (`modules.session`)

With `enabled: true` the session middleware is installed with this section as its options: the same as `app.use(middleware.session({ ... }))` before any middleware of your own. Every key is passed on: `store`, `storeOptions`, `secret`, `name`, `rolling`, `resave`, `saveUninitialized`, `cookie`, `proxy` and `unset`; what each does is described under [Session Middleware](#session-middleware) (`unset` is accepted and has no effect in the session middleware). `cookie` is laid over the default cookie key by key, so naming one flag keeps the others. Set `secret` from the environment. An app that also calls `app.use(middleware.session(...))` keeps its own registration and the configured one is not installed (a start-up warning says so).

| Property  | Type                            | Default    | Description                    |
| --------- | ------------------------------- | ---------- | ------------------------------ |
| `enabled` | `boolean`                       | `false`    | Install the session middleware |
| `store`   | `'memory' \| 'redis' \| 'file'` | `'memory'` | Session store                  |

```javascript
export default {
  modules: {
    session: {
      enabled: true,
      store: 'redis',
      storeOptions: { url: process.env.REDIS_URL },
      secret: process.env.SESSION_SECRET,
      name: 'sid',
      cookie: { secure: true, maxAge: 8 * 60 * 60 * 1000 },
    },
  },
};
```

#### Validation Defaults

| Property       | Type      | Default | Description                                  |
| -------------- | --------- | ------- | -------------------------------------------- |
| `enabled`      | `boolean` | `false` | Enable validation by default                 |
| `stripUnknown` | `boolean` | `true`  | Strip unknown properties from validated data |
| `abortEarly`   | `boolean` | `false` | Stop validation on first error               |

#### Auto-Discovery Defaults

| Property          | Type                                         | Default                                                              | Description                                                                                                                           |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | `boolean`                                    | `true`                                                               | Enable automatic module discovery                                                                                                     |
| `paths`           | `string[]`                                   | `['./modules', './src/modules']`                                     | Directories to search for modules (with `NODE_ENV=production`: `['./dist/modules', './dist/src/modules', './modules']`)               |
| `patterns`        | `string[]`                                   | `['**/*.module.{ts,js}', '**/index.{ts,js}', '**/*.config.{ts,js}']` | File patterns, matched against the path below each directory in `paths` ([what they match](#which-files-are-found-and-in-what-order)) |
| `recursive`       | `boolean`                                    | `true`                                                               | Not applied: a pattern with `**` reaches every directory down to `maxDepth`. `false` logs a warning at start-up                       |
| `loadingStrategy` | `'eager' \| 'lazy' \| 'conditional'`         | `'eager'`                                                            | Module loading strategy                                                                                                               |
| `watchForChanges` | `boolean`                                    | `false`                                                              | Watch module files and emit `modules:changed` when one changes. Modules are not reloaded                                              |
| `ignorePatterns`  | `string[]`                                   | `['**/*.test.{ts,js}', '**/*.spec.{ts,js}', '**/node_modules/**']`   | Patterns for files to leave out, matched against the file's path from the working directory                                           |
| `loadOrder`       | `'alphabetical' \| 'dependency' \| 'custom'` | `'dependency'`                                                       | Module loading order strategy                                                                                                         |
| `failOnError`     | `boolean`                                    | `false`                                                              | Throw error if module discovery fails                                                                                                 |
| `maxDepth`        | `number`                                     | `5`                                                                  | How many directories below a path a module file may be in. `0`: only the files directly in it                                         |

**Loading Strategies:**

- **`eager`**: Load all modules immediately during app startup
- **`lazy`**: Not applied. Modules are discovered but never loaded, so none of their routes is served; the app logs a warning at start-up
- **`conditional`**: Load modules based on environment or feature flags

**Load Order Strategies:**

- **`alphabetical`**: Load modules in alphabetical order by name
- **`dependency`**: Load modules in the order their files are found (below), with a module moved ahead of the modules that name it in `dependencies`
- **`custom`**: Use custom order specified in module configurations

##### Which files are found, and in what order

Each directory in `paths` is walked once, the same way on every Node.js version, operating system and file system, in CI and out of it. A pattern is matched against a file's path below that directory, with `/` between segments: `*` and `?` stay inside one segment, `[abc]` is one character of a set (`[!abc]` for none of them), `{a,b}` is either alternative and `**` is any number of directories.

- Matching is case-sensitive everywhere: `Index.js` is not `index.js`, on macOS and Windows too.
- A file or directory whose name starts with a dot is matched only by a pattern segment that starts with a dot, so `**/*.module.js` leaves `.cache/` and `.draft.module.js` alone.
- A symbolic link to a file is loaded like a file. A linked directory is entered only when a pattern names it (`shared/**/*.js`), never through `*` or `**`.
- `maxDepth` counts the directories between the path and the file. An ignore pattern is tested against the file's path from the working directory (`modules/users/users.test.js`), in any letter case.

The files of one directory in `paths` load in the order of their paths below it. Paths are compared one segment at a time, each pair of segments by UTF-16 code unit: no locale takes part, upper case comes before lower case (`Users/index.js` before `admin/index.js`), and `a/index.js` comes before `a-b/index.js`. The directories are taken in the order `paths` lists them, and the order of `patterns` makes no difference.

> **Changed in the release after 1.8.25.** Discovery used to depend on where it ran. Node.js 22 and later loaded the files one pattern after the other, in the order the platform's own glob returned them; Node.js 20, and any process with `CI=true` or `GITHUB_ACTIONS=true`, walked the directories instead, which also matched dot-files and names in any letter case, entered linked directories, applied `recursive: false` and stopped one directory level short of `maxDepth`. There is one walk now, with the matching Node.js 22 and later had on Linux and the order above. An application whose modules depended on the previous order (overlapping routes, or one module's set-up relying on another's) should make that dependency explicit with `dependencies`.

#### Example

```javascript
{
  modules: {
    cache: {
      enabled: true,
      defaultTtl: 600,
      maxSize: 5000,
      strategy: 'lfu'
    },
    rateLimit: {
      enabled: true,
      defaultRequests: 200,
      defaultWindow: 60000,
      skipSuccessfulRequests: true
    },
    validation: {
      enabled: true,
      stripUnknown: false,
      abortEarly: true
    },
    autoDiscovery: {
      enabled: true,
      paths: ['./modules', './src/modules', './app/modules'],
      patterns: ['**/*.module.{ts,js}', '**/index.{ts,js}'],
      loadingStrategy: 'eager',
      watchForChanges: false, // Set to true in development
      ignorePatterns: ['**/*.test.{ts,js}', '**/node_modules/**'],
      loadOrder: 'dependency',
      failOnError: false,
      maxDepth: 5
    }
  }
}
```

#### Environment Variables

- `CACHE_ENABLED` or `MORO_CACHE_ENABLED`
- `DEFAULT_CACHE_TTL` or `MORO_CACHE_TTL`
- `CACHE_MAX_SIZE` or `MORO_CACHE_SIZE`
- `CACHE_STRATEGY` or `MORO_CACHE_STRATEGY`
- `RATE_LIMIT_ENABLED` or `MORO_RATE_LIMIT_ENABLED`
- `DEFAULT_RATE_LIMIT_REQUESTS` or `MORO_RATE_LIMIT_REQUESTS`
- `DEFAULT_RATE_LIMIT_WINDOW` or `MORO_RATE_LIMIT_WINDOW`
- `VALIDATION_ENABLED` or `MORO_VALIDATION_ENABLED`
- `AUTO_DISCOVERY_ENABLED` or `MORO_AUTO_DISCOVERY_ENABLED`
- `AUTO_DISCOVERY_PATHS` or `MORO_AUTO_DISCOVERY_PATHS` (comma-separated)
- `AUTO_DISCOVERY_PATTERNS` or `MORO_AUTO_DISCOVERY_PATTERNS` (comma-separated)
- `AUTO_DISCOVERY_LOADING_STRATEGY` or `MORO_AUTO_DISCOVERY_LOADING_STRATEGY`
- `AUTO_DISCOVERY_WATCH_FOR_CHANGES` or `MORO_AUTO_DISCOVERY_WATCH_FOR_CHANGES`
- `AUTO_DISCOVERY_LOAD_ORDER` or `MORO_AUTO_DISCOVERY_LOAD_ORDER`
- `AUTO_DISCOVERY_FAIL_ON_ERROR` or `MORO_AUTO_DISCOVERY_FAIL_ON_ERROR`
- `AUTO_DISCOVERY_MAX_DEPTH` or `MORO_AUTO_DISCOVERY_MAX_DEPTH`

## Auto-Discovery Configuration

MoroJS includes a powerful auto-discovery system that automatically finds and loads modules from your filesystem. This system supports eager and conditional loading, dependency resolution, and a file watcher that reports changed module files.

### Basic Usage

```javascript
// Primary method - nested under modules
const app = await createApp({
  modules: {
    autoDiscovery: {
      enabled: true,
      paths: ['./modules', './src/modules'],
      loadingStrategy: 'eager',
      watchForChanges: true, // Emits modules:changed; modules are not reloaded
    },
  },
});

// Shorthand convenience method
const app = await createApp({
  autoDiscover: true, // Use defaults
});

// Shorthand with options
const app = await createApp({
  autoDiscover: {
    enabled: true,
    paths: ['./modules', './src/modules'],
    loadingStrategy: 'eager',
  },
});
```

### Legacy Compatibility

```javascript
// Legacy modulesPath (still supported)
const app = await createApp({
  modulesPath: './modules', // Equivalent to autoDiscover.paths: ['./modules']
});
```

### Loading Strategies

#### Eager Loading (Default)

All modules are loaded immediately during application startup.

```javascript
const app = await createApp({ autoDiscover: { loadingStrategy: 'eager' } });
```

#### Lazy Loading

Not applied: with `'lazy'` the modules are discovered but never loaded, so none of their routes is served, and the app logs a warning at start-up saying so. Use `'eager'` or `'conditional'`.

```javascript
const app = await createApp({ autoDiscover: { loadingStrategy: 'lazy' } });
```

#### Conditional Loading

Modules are loaded based on environment or feature flags.

```javascript
const app = await createApp({ autoDiscover: { loadingStrategy: 'conditional' } });
```

### Development Features

#### Hot Reloading

`watchForChanges` watches the module directories and emits a `modules:changed` event when a module file changes. It does not reload the module, and the app logs a warning at start-up saying so: restart the process to pick up the change (for example run it under `node --watch`).

```javascript
const app = await createApp({
  modules: {
    autoDiscovery: {
      watchForChanges: process.env.NODE_ENV === 'development',
      loadingStrategy: 'eager',
    },
  },
});
```

#### Custom Patterns

Configure custom file patterns for different project structures:

```javascript
const app = await createApp({
  modules: {
    autoDiscovery: {
      patterns: ['**/*.module.{ts,js}', '**/modules/*.{ts,js}', '**/*-module.{ts,js}'],
      ignorePatterns: [
        '**/*.test.{ts,js}',
        '**/*.spec.{ts,js}',
        '**/node_modules/**',
        '**/dist/**',
      ],
    },
  },
});
```

### Dependency Resolution

The auto-discovery system can automatically resolve and order module dependencies:

```javascript
const app = await createApp({
  modules: {
    autoDiscovery: {
      loadOrder: 'dependency', // Automatic topological sort
      failOnError: false, // Graceful degradation
    },
  },
});
```

### Where modules are looked for

Each entry of `paths` is a directory. A relative entry (`./modules`) is looked up in the working directory of the process; an absolute entry is that directory itself, wherever the process was started. Every directory that is scanned is logged at `debug` level with its full path.

```javascript
import { fileURLToPath } from 'node:url';

const app = await createApp({
  modules: {
    autoDiscovery: {
      // Next to this file, whatever the working directory is
      paths: [fileURLToPath(new URL('./modules', import.meta.url))],
    },
  },
});
```

`MORO_AUTO_DISCOVERY_PATHS=/srv/app/dist/modules` does the same from the environment.

### Production Configuration

Optimized settings for production environments:

```javascript
const app = await createApp({
  modules: {
    autoDiscovery: {
      enabled: true,
      paths: ['./dist/modules'],
      patterns: ['**/*.module.js'],
      loadingStrategy: 'eager',
      watchForChanges: false,
      loadOrder: 'dependency',
      failOnError: true,
      maxDepth: 3,
    },
  },
});
```

## Routing Configuration

### `routing` Section

Route files and route middleware. `routing` is `true` by default; `false`
turns the loading of route files off, and an object sets the keys below.

| Key                | Type       | Default                                                                 | Description                                                                                                                                                                                                            |
| ------------------ | ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`          | `boolean`  | `true`                                                                  | Import the route files under `paths` when the app starts listening. A directory that does not exist is skipped                                                                                                         |
| `paths`            | `string[]` | `['./src/routes']` (`./dist/routes`, `./dist/src/routes` in production) | Directories the route files are loaded from                                                                                                                                                                            |
| `strictMiddleware` | `boolean`  | `false`                                                                 | Off: a route's middleware passes the request on when it returns. On: route and module middleware declared `(req, res, next)` passes a request on only by calling `next()`, and the request waits for it, as in Express |

`strictMiddleware` is described under "Route Middleware and `next()`" in the
[Middleware Guide](./MIDDLEWARE_GUIDE.md): with it, an async middleware that
finishes without `next()` and without answering gets the request a 500 and an
error log line, and one that returns no promise and does neither is waited
for and named in a warning after 30 seconds. It is read when routes are
registered, and it does not apply to `app.use()` middleware, which already
waits for `next()`.

#### Example

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp({
  routing: {
    paths: ['./src/routes', './src/admin-routes'],
    strictMiddleware: true,
  },
});

// No route files for this app
const worker = await createApp({ routing: false });
```

#### Environment Variables

- `MORO_ROUTING` (or `MORO_AUTO_ROUTING`): `false` turns the loading of route files off
- `MORO_ROUTING_PATHS`: directories to load route files from (comma-separated)
- `MORO_ROUTING_STRICT_MIDDLEWARE`: `true` or `false`; sets `routing.strictMiddleware`

## Logging Configuration

### `logging` Section

Configure the logging system.

| Property            | Type                                                | Default    | Description                                                                         |
| ------------------- | --------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `level`             | `'debug' \| 'info' \| 'warn' \| 'error' \| 'fatal'` | `'info'`   | Minimum log level                                                                   |
| `format`            | `'pretty' \| 'json' \| 'compact'`                   | `'pretty'` | Log output format                                                                   |
| `enableColors`      | `boolean`                                           | `true`     | Enable colored log output                                                           |
| `enableTimestamp`   | `boolean`                                           | `true`     | Include timestamp in logs                                                           |
| `enableContext`     | `boolean`                                           | `true`     | Include context information in logs                                                 |
| `enableMetadata`    | `boolean`                                           | `false`    | Append the metadata object to `pretty` lines (the `json` format always includes it) |
| `enablePerformance` | `boolean`                                           | `false`    | Collect and print memory usage per entry                                            |
| `outputs`           | `object`                                            | -          | Output configuration                                                                |

Two more logger settings are read from the `logger` option of `createApp()` and from the environment, not from this section of a config file:

| `createApp({ logger })` option | Environment variable       | Default                         | Description                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redact`                       | `LOG_REDACT`               | on wherever metadata is printed | Replace the values of sensitive metadata keys (`password`, `token`, `secret`, `authorization`, `cookie`, `apiKey`, ...) with `[REDACTED]`. On by default in the `json` format and in `pretty` with `enableMetadata`; `true` forces it on for every format, `false` turns it off, an array of key names (option only) turns it on and adds to the built-in list |
| `escapeControlChars`           | `LOG_ESCAPE_CONTROL_CHARS` | `true`                          | In the `pretty` and `compact` formats, write control characters in a message or context (CR, LF, ESC, ...) as visible escapes so a logged value cannot forge a log line or drive the terminal                                                                                                                                                                  |

See [Logging](./API.md#logging) in the API reference for the key list and the details.

#### Output Configuration

`outputs` is accepted but not applied by the framework today: logs go to the console. To send them somewhere else as well, register an output with `logger.addOutput({ name, write(entry) { ... } })` (`logger` is exported from `@morojs/moro`).

##### Console Output

| Property  | Type      | Default | Description           |
| --------- | --------- | ------- | --------------------- |
| `console` | `boolean` | `true`  | Enable console output |

##### File Output

| Property   | Type      | Default             | Description                 |
| ---------- | --------- | ------------------- | --------------------------- |
| `enabled`  | `boolean` | `false`             | Enable file logging         |
| `path`     | `string`  | `'./logs/moro.log'` | Log file path               |
| `maxSize`  | `string`  | `'10MB'`            | Maximum file size           |
| `maxFiles` | `number`  | `5`                 | Maximum number of log files |

##### Webhook Output

| Property  | Type                     | Default | Description              |
| --------- | ------------------------ | ------- | ------------------------ |
| `enabled` | `boolean`                | `false` | Enable webhook logging   |
| `url`     | `string`                 | -       | Webhook URL              |
| `headers` | `Record<string, string>` | `{}`    | HTTP headers for webhook |

#### Example

```javascript
{
  logging: {
    level: 'debug',
    format: 'json',
    enableColors: false,
    enableTimestamp: true,
    enableContext: true,
    outputs: {
      console: true,
      file: {
        enabled: true,
        path: '/var/log/myapp/app.log',
        maxSize: '50MB',
        maxFiles: 10
      },
      webhook: {
        enabled: true,
        url: 'https://logging.service.com/webhook',
        headers: {
          'Authorization': 'Bearer token123',
          'Content-Type': 'application/json'
        }
      }
    }
  }
}
```

#### Environment Variables

- `LOG_LEVEL` or `MORO_LOG_LEVEL`
- `LOG_FORMAT` or `MORO_LOG_FORMAT`
- `NO_COLOR` (when set and not empty, colours are off by default, as described at [no-color.org](https://no-color.org); an explicit `logging.enableColors: true` in the config file or `createApp()`, or `LOG_COLORS=true`, still turns them on)
- `LOG_COLORS` (set to 'false' to disable)
- `LOG_TIMESTAMP` (set to 'false' to disable)
- `LOG_CONTEXT` (set to 'false' to disable)
- `LOG_METADATA` (set to 'true' to append metadata to `pretty` lines)
- `LOG_PERFORMANCE` (set to 'true' to print memory usage per entry)
- `LOG_REDACT` (set to 'true' to redact sensitive metadata keys in every format, 'false' to turn redaction off)
- `LOG_ESCAPE_CONTROL_CHARS` (set to 'false' to write control characters in messages as they are)

## Security Configuration

### `security` Section

Configure security features.

#### CORS Configuration

| Property            | Type                                        | Default                                                | Description                                               |
| ------------------- | ------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `enabled`           | `boolean`                                   | `false`                                                | Enable CORS                                               |
| `origin`            | `string \| string[] \| boolean \| function` | `'*'`                                                  | Allowed origins, or a function that decides per request   |
| `methods`           | `string[]`                                  | `['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']` | Allowed methods                                           |
| `allowedHeaders`    | `string[]`                                  | `['Content-Type', 'Authorization']`                    | Allowed headers                                           |
| `credentials`       | `boolean`                                   | `false`                                                | Allow credentials                                         |
| `maxAge`            | `number`                                    | `86400`                                                | Preflight cache duration (seconds)                        |
| `exposedHeaders`    | `string[]`                                  | `[]`                                                   | Headers exposed to client                                 |
| `preflightContinue` | `boolean`                                   | `false`                                                | Pass OPTIONS to route handlers instead of auto-responding |

**Automatic Preflight Handling:**

MoroJS automatically handles OPTIONS preflight requests by responding with `204 No Content` and appropriate CORS headers. Set `preflightContinue: true` to handle OPTIONS in your route handlers instead.

#### Helmet Configuration

`enabled: true` installs the helmet middleware with the rest of this section as its options. With only `enabled` set, the default headers are sent.

| Property                        | Type                                       | Default                             | Description                                                                       |
| ------------------------------- | ------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------- |
| `enabled`                       | `boolean`                                  | `false`                             | Install the helmet middleware                                                     |
| `contentSecurityPolicy`         | `boolean \| { directives }`                | `true`                              | `Content-Security-Policy`: the default policy, none (`false`), or your directives |
| `hsts`                          | `boolean`                                  | `true`                              | `false` sends no `Strict-Transport-Security`                                      |
| `noSniff`                       | `boolean`                                  | `true`                              | `false` sends no `X-Content-Type-Options`                                         |
| `frameguard`                    | `boolean`                                  | `true`                              | `false` sends no `X-Frame-Options`                                                |
| `xFrameOptions`                 | `'DENY' \| 'SAMEORIGIN' \| boolean`        | `'DENY'`                            | Value of `X-Frame-Options`                                                        |
| `xContentTypeOptions`           | `boolean`                                  | `true`                              | `X-Content-Type-Options: nosniff`                                                 |
| `xXssProtection`                | `boolean`                                  | `true`                              | `X-XSS-Protection: 0`                                                             |
| `referrerPolicy`                | `string \| boolean`                        | `'strict-origin-when-cross-origin'` | Value of `Referrer-Policy`                                                        |
| `strictTransportSecurity`       | `{ maxAge, includeSubDomains } \| boolean` | one year, with subdomains           | Value of `Strict-Transport-Security`                                              |
| `xDownloadOptions`              | `boolean`                                  | `true`                              | `X-Download-Options: noopen`                                                      |
| `xPermittedCrossDomainPolicies` | `boolean`                                  | `true`                              | `X-Permitted-Cross-Domain-Policies: none`                                         |

A header is sent unless its switch (`hsts`, `noSniff`, `frameguard`) or its own key is `false`. When `security.csp` is enabled, the `Content-Security-Policy` header is that section's and helmet sends none of its own.

#### CSRF Configuration (`security.csrf`)

`enabled: true` installs the CSRF middleware with this section as its options: the same as `app.use(middleware.csrf({ ... }))` before any middleware of your own. Every request with a method outside `ignoreMethods` must then carry the token (in the header named by `headerName`, or the `_csrf` body field) that matches its cookie, or it is answered `403`; `await req.csrfToken()` gives a page its token. Set `secret` from the environment: without one a random secret is generated at start-up, with a warning.

| Property        | Type       | Default                      | Description                             |
| --------------- | ---------- | ---------------------------- | --------------------------------------- |
| `enabled`       | `boolean`  | `false`                      | Install the CSRF middleware             |
| `secret`        | `string`   | `''`                         | Signs the tokens                        |
| `tokenLength`   | `number`   | `32`                         | Token length in bytes                   |
| `cookieName`    | `string`   | `'_csrf'`                    | Name of the token cookie                |
| `headerName`    | `string`   | `'x-csrf-token'`             | Request header that carries the token   |
| `ignoreMethods` | `string[]` | `['GET', 'HEAD', 'OPTIONS']` | Methods that are not checked            |
| `sameSite`      | `boolean`  | `true`                       | Mark the token cookie `SameSite=Strict` |

#### Content Security Policy (`security.csp`)

`enabled: true` installs the CSP middleware with this section as its options: the same as `app.use(middleware.csp({ ... }))`.

| Property     | Type      | Default            | Description                                                                 |
| ------------ | --------- | ------------------ | --------------------------------------------------------------------------- |
| `enabled`    | `boolean` | `false`            | Install the CSP middleware                                                  |
| `directives` | `object`  | the default policy | Directives by camelCase name, each a list of sources                        |
| `reportOnly` | `boolean` | `false`            | Send `Content-Security-Policy-Report-Only` instead                          |
| `reportUri`  | `string`  | (none)             | Adds `report-uri`                                                           |
| `nonce`      | `boolean` | `false`            | Add a per-request nonce to `script-src` / `style-src`; it is `req.cspNonce` |

The default policy is `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; media-src 'self'; frame-src 'none'`. The `directives` you write are laid over it one directive at a time: a directive you name replaces the default one, the others stay. Set a directive to `null` to leave it out.

```javascript
export default {
  security: {
    csp: {
      enabled: true,
      directives: {
        scriptSrc: ["'self'", 'https://cdn.example.com'],
        frameSrc: null, // no frame-src directive
      },
    },
  },
};
```

#### Global Rate Limiting

| Property   | Type      | Default | Description                     |
| ---------- | --------- | ------- | ------------------------------- |
| `enabled`  | `boolean` | `false` | Enable global rate limiting     |
| `requests` | `number`  | `1000`  | Requests per window             |
| `window`   | `number`  | `60000` | Window duration in milliseconds |

`enabled: true` installs the rate limit middleware with `requests` and `window`: the same as `app.use(middleware.rateLimit({ requests, window }))` before any middleware of your own. Each client address (`req.ip`) has one counter per route; a request past the limit is answered `429` with a `Retry-After` header and does not reach the route. The counters are kept in the process: with clustering, or several instances behind a load balancer, each process counts for itself.

`req.ip` is the connected peer unless [`server.trustProxy`](#behind-a-proxy) says otherwise. Behind a proxy that is not named there, every client shares the proxy's address and one counter; the first request that arrives with `X-Forwarded-For` while `trustProxy` is not set logs a warning saying so. An app that also calls `app.use(middleware.rateLimit(...))` keeps its own registration and the configured one is not installed (a start-up warning says so).

`modules.rateLimit` is a different section and is still not applied. For a limit on one route, call `.rateLimit({ requests, window })` on it.

#### Order

The middleware installed from the configuration always runs in the same order. The global rate limit, CSP, session and CSRF are request hooks: they run first, in that order, ahead of the application's own hooks. Helmet, CORS and compression are function middleware: they run next, in that order, ahead of the functions the application passes to `app.use()`. (Request hooks always run before function middleware.)

A request the rate limit refuses goes no further: it is not given a session and the CSRF check does not run for it. The `429` of the rate limit and the `403` of the CSRF check are sent by a hook, before helmet and CORS have run. They carry the helmet headers all the same, and the CORS headers your CORS (`security.cors`, or `app.use(middleware.cors({ ... }))`) gives any other response to that request: the same allowed origin, `Access-Control-Allow-Credentials`, `Access-Control-Expose-Headers` and `Vary: Origin`. A page on an allowed origin therefore reads the status and the body; an origin that is not allowed is named no CORS headers, as on every other response. For a page to read the `Retry-After` header too, list it in `security.cors.exposedHeaders` (the seconds are also in the body, as `retryAfter`).

A preflight (`OPTIONS` with `Access-Control-Request-Method`) is your CORS's to answer: the rate limit does not count it and the CSRF check does not ask it for a token. With `preflightContinue: true` preflights are the application's, and both apply to them like to any other request. All of this holds for `app.use(middleware.rateLimit(...))` and `app.use(middleware.csrf(...))` as well, and on every server and runtime (Node.js, HTTP/2, the native engine, AWS Lambda, Vercel Edge, Cloudflare Workers).

#### Example

```javascript
{
  security: {
    cors: {
      enabled: true,
      origin: ['https://myapp.com', 'https://admin.myapp.com'],
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      credentials: true,
      maxAge: 86400 // 24 hours
    },
    helmet: {
      enabled: true,
      contentSecurityPolicy: true,
      hsts: true,
      noSniff: true,
      frameguard: true
    },
    rateLimit: {
      global: {
        enabled: true,
        requests: 5000,
        window: 60000
      }
    }
  }
}
```

**Dynamic Origin Validation:**

`origin` can also be a function, `(requestOrigin, req) => ...`, called for every request with its `Origin` header (`undefined` when there is none) and the request. It returns the origin to allow, a list or `true`, or `false` to answer `403`, and may be async. A configuration file is code, so the function can be written there (`moro.config.js`, `moro.config.cjs`, `moro.config.ts`, or an `.mjs` file named by `MORO_CONFIG_FILE`) as well as in `createApp()` options or `middleware.cors()`. It cannot come from an environment variable: this section has no environment mappings, and a JSON file is not loaded as a configuration file.

```javascript
// moro.config.js
const allowed = new Set(['https://myapp.com', 'https://admin.myapp.com']);

export default {
  security: {
    cors: {
      // No Origin header, or one that is not on the list: 403
      origin: (requestOrigin, req) =>
        requestOrigin && allowed.has(requestOrigin) ? requestOrigin : false,
      credentials: true,
    },
  },
};
```

```javascript
// Or in application code, here with a lookup
app.use(
  middleware.cors({
    origin: async (requestOrigin, req) => {
      // Check database or perform custom validation
      const allowed = await db.origins.isAllowed(requestOrigin);
      return allowed ? requestOrigin : false;
    },
    credentials: true,
  })
);
```

#### Environment Variables

This section has no environment variable mappings: set it in `moro.config.js` / `moro.config.ts` or in `createApp()` options.

## External Services

### `external` Section

Configure third-party service integrations.

These values are accepted and returned by `app.getConfig().external`, but the framework does not create Stripe, PayPal or SMTP clients from them today: read them in your own code.

#### Stripe Configuration

| Property         | Type     | Default        | Description            |
| ---------------- | -------- | -------------- | ---------------------- |
| `secretKey`      | `string` | -              | Stripe secret key      |
| `publishableKey` | `string` | -              | Stripe publishable key |
| `webhookSecret`  | `string` | -              | Stripe webhook secret  |
| `apiVersion`     | `string` | `'2023-10-16'` | Stripe API version     |

#### PayPal Configuration

| Property       | Type                        | Default     | Description          |
| -------------- | --------------------------- | ----------- | -------------------- |
| `clientId`     | `string`                    | -           | PayPal client ID     |
| `clientSecret` | `string`                    | -           | PayPal client secret |
| `webhookId`    | `string`                    | -           | PayPal webhook ID    |
| `environment`  | `'sandbox' \| 'production'` | `'sandbox'` | PayPal environment   |

#### SMTP Configuration

| Property   | Type      | Default | Description      |
| ---------- | --------- | ------- | ---------------- |
| `host`     | `string`  | -       | SMTP server host |
| `port`     | `number`  | `587`   | SMTP server port |
| `secure`   | `boolean` | `false` | Use SSL/TLS      |
| `username` | `string`  | -       | SMTP username    |
| `password` | `string`  | -       | SMTP password    |

#### Example

```javascript
{
  external: {
    stripe: {
      secretKey: 'sk_live_...',
      publishableKey: 'pk_live_...',
      webhookSecret: 'whsec_...',
      apiVersion: '2023-10-16'
    },
    paypal: {
      clientId: 'your-paypal-client-id',
      clientSecret: 'your-paypal-client-secret',
      environment: 'production'
    },
    smtp: {
      host: 'smtp.mailgun.org',
      port: 587,
      secure: false,
      username: 'postmaster@mg.yourdomain.com',
      password: 'your-smtp-password'
    }
  }
}
```

#### Environment Variables

- `STRIPE_SECRET_KEY` or `MORO_STRIPE_SECRET`
- `STRIPE_PUBLISHABLE_KEY` or `MORO_STRIPE_PUBLIC`
- `STRIPE_WEBHOOK_SECRET` or `MORO_STRIPE_WEBHOOK`
- `STRIPE_API_VERSION` or `MORO_STRIPE_VERSION`
- `PAYPAL_CLIENT_ID` or `MORO_PAYPAL_CLIENT`
- `PAYPAL_CLIENT_SECRET` or `MORO_PAYPAL_SECRET`
- `PAYPAL_ENVIRONMENT` or `MORO_PAYPAL_ENV`
- `SMTP_HOST` or `MORO_SMTP_HOST`
- `SMTP_PORT` or `MORO_SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USERNAME` or `MORO_SMTP_USER`
- `SMTP_PASSWORD` or `MORO_SMTP_PASS`

Each service is read only when its first variable is set: `STRIPE_SECRET_KEY`, `PAYPAL_CLIENT_ID` or `SMTP_HOST` (or its `MORO_` alternative).

## Performance Configuration

### `performance` Section

Configure performance optimizations.

#### Compression

| Property         | Type       | Default                     | Description                                                                                                                                 |
| ---------------- | ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | `boolean`  | `false`                     | Enable response compression (opt-in)                                                                                                        |
| `level`          | `number`   | `6`                         | Compression level (1-9); mapped onto brotli quality                                                                                         |
| `threshold`      | `number`   | `1024`                      | Minimum bytes to compress                                                                                                                   |
| `encodings`      | `string[]` | `['br', 'gzip', 'deflate']` | Server preference order among the encodings the client accepts                                                                              |
| `maxInlineBytes` | `number`   | `16384`                     | Bodies up to this size compress on the calling thread with a Content-Length; larger ones on the threadpool, streamed. `0` = always the pool |

#### Circuit Breaker

Off by default. With `enabled: true`, every module route handler and every module WebSocket handler (`defineModule({ routes, sockets })`) runs behind a circuit breaker of its own with these settings. Only server-side failures count: an error the handler throws (unless it carries a `4xx` `status` / `statusCode`) or a `5xx` response it sends. An open route breaker answers `503` with `Retry-After` without running the handler. Routes registered on the app are not wrapped: use the exported `CircuitBreaker` class for those and for your own calls (see the [Circuit Breaker guide](./CIRCUIT_BREAKER.md)).

| Property           | Type      | Default | Description                                                            |
| ------------------ | --------- | ------- | ---------------------------------------------------------------------- |
| `enabled`          | `boolean` | `false` | Put module route and module WebSocket handlers behind circuit breakers |
| `failureThreshold` | `number`  | `5`     | Failures within `monitoringPeriod` that open a breaker (minimum 1)     |
| `resetTimeout`     | `number`  | `60000` | Milliseconds a breaker stays open before a trial call (minimum 1000)   |
| `monitoringPeriod` | `number`  | `10000` | Milliseconds a failure keeps counting (minimum 1000)                   |

#### Clustering

| Property            | Type      | Default     | Description                                                                                                                                                 |
| ------------------- | --------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`           | `boolean` | `false`     | Enable clustering                                                                                                                                           |
| `workers`           | `number`  | `1`         | Number of workers (or `'auto'`). Worker threads in one process with the native engine on macOS/Linux; worker processes on Windows and with `engine: 'node'` |
| `memoryPerWorkerGB` | `number`  | `undefined` | Divisor for the `'auto'` worker count, in GB. Nothing is allocated or limited                                                                               |

**`workers: 'auto'`** is `min(CPUs, floor(memory / memoryPerWorkerGB))`. That is the only use of `memoryPerWorkerGB`: no memory is reserved for a worker and none is capped. When it is not set, the divisor is the memory left after 4 GB of headroom, divided by the CPU count (never below 0.5).

**With more than one worker:**

- Connections are spread over the workers by the operating system. Linux spreads them; macOS gives every connection to one worker thread, so clustering on macOS adds memory, not throughput.
- The in-memory session store, WebSocket rooms and broadcasts, and rate-limit counters are per worker. Use the Redis session store ([Session Management](./MIDDLEWARE_GUIDE.md#session-management)) and size rate limits per worker.
- A worker that dies is started again after 200 ms; the delay doubles with each further restart of that worker up to 5 seconds and returns to 200 ms once a worker has stayed up for a minute. A worker that exits with code 0 is not restarted.
- On SIGINT/SIGTERM every worker runs its own `app.close()` (requests in flight get 2 seconds) and the primary waits up to 3 seconds for the workers before it ends them.
- `app.listen(0)` is refused: every worker would be given a different port.

The measurements behind these are in the [Performance Guide](./PERFORMANCE.md#what-clustering-shares-and-what-it-does-not).

#### Example

```javascript
{
  performance: {
    compression: {
      enabled: true,
      level: 9,
      threshold: 512
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 10,
      resetTimeout: 30000,
      monitoringPeriod: 5000
    },
    clustering: {
      enabled: true,
      workers: 4,
      memoryPerWorkerGB: 2
    }
  }
}
```

#### Environment Variables

This section has no environment variable mappings: set it in `moro.config.js` / `moro.config.ts` or in `createApp()` options.

## WebSocket Configuration

### `websocket` Section

WebSockets are off until this section is given. The native engine serves them itself; `adapter` selects Socket.IO or the `ws` library on the Node.js server. The adapters are described in [WebSocket Adapters](./WEBSOCKET-ADAPTERS.md).

| Property            | Type                 | Default     | Description                                                                                                                                                        |
| ------------------- | -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`           | `boolean`            | `false`     | Serve WebSockets                                                                                                                                                   |
| `adapter`           | `string` or instance | `undefined` | `'socket.io'` or `'ws'` (both serve from the Node.js server), or an adapter instance in `createApp()` options. Not set: the native engine serves WebSockets itself |
| `compression`       | `boolean`            | `undefined` | `true`: permessage-deflate with every client that offers it, on every adapter. Not set, or `false`: messages are sent uncompressed                                 |
| `customIdGenerator` | `function`           | `undefined` | Returns the id of a new connection                                                                                                                                 |
| `options`           | `object`             | `undefined` | The adapter options below                                                                                                                                          |

#### `websocket.options`

| Property                 | Type                                                    | Default     | Description                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cors.origin`            | `string`, `string[]`, `boolean`, `RegExp` or `function` | `undefined` | Origins that may connect. Not set: every origin on the native engine and Socket.IO adapters, same origin only on the `ws` adapter. Set to anything but `true` / `'*'`: a handshake from another origin is refused on every adapter. A list may mix exact origins and `RegExp` entries |
| `cors.credentials`       | `boolean`                                               | `undefined` | Passed to Socket.IO's CORS handling for long-polling                                                                                                                                                                                                                                  |
| `verifyClient`           | `(info) => boolean \| Promise<boolean>`                 | `undefined` | Decides a handshake that passed the origin rule; `info` is `{ origin, req, secure }`. A falsy verdict, a throw or a rejection refuses the handshake on every adapter                                                                                                                  |
| `enforceHandshakeChecks` | `boolean`                                               | `true`      | Native engine and Socket.IO adapters. `false`: a handshake that fails `cors.origin` or `verifyClient` is logged as a warning and let through instead of refused, and a warning at start-up says so. The `ws` adapter does not read it                                                 |
| `maxPayloadLength`       | `number` (bytes, at least 1024)                         | `undefined` | Largest accepted message. Not set: 1 MB on Socket.IO (its own default), 1 MiB on `ws`. On the native engine the limit is `server.limits.wsMaxMessageSize` (16 MiB when not set); a configuration file's `maxPayloadLength` is used there when that key is not set                     |
| `path`                   | `string`                                                | `undefined` | Base path: `/socket.io/` on Socket.IO, `/ws` on `ws`. Not applied by the native engine adapter, where a namespace is served at its own path                                                                                                                                           |

With neither `cors.origin` nor `verifyClient` set, `enforceHandshakeChecks` has nothing to act on. The status a refused handshake is answered with, per adapter, is in [Origins, Handshake Checks and Message Size](./WEBSOCKET-ADAPTERS.md#origins-handshake-checks-and-message-size).

With `compression: true`, a message of 1024 bytes or more is compressed for a client that negotiated permessage-deflate, and what such a client sends is inflated; clients that did not offer the extension are served uncompressed. The adapter's message limit is then also the limit on a message once inflated (`server.limits.wsMaxMessageSize` on the native engine, 16 MiB when not set; `maxPayloadLength` on the Socket.IO and `ws` adapters, 1 MB and 1 MiB when not set): one that would inflate past it closes the connection with close code 1009. The option is read when the app is created. What it costs in CPU and memory on each adapter, and when it pays, is in [Compression](./WEBSOCKET-ADAPTERS.md#compression).

#### Example

```javascript
{
  websocket: {
    enabled: true,
    options: {
      cors: { origin: ['https://app.example.com'] },
      verifyClient: info => info.req.headers.cookie !== undefined
    }
  }
}
```

#### Environment Variables

This section has no environment variable mappings: set it in `moro.config.js` / `moro.config.ts` or in `createApp()` options.

## Authentication Configuration

### Better Auth Integration

`auth()` verifies Bearer tokens and, given providers, serves sign-in on [Better Auth](https://better-auth.com/) (the optional `better-auth` package). The [Authentication Guide](./AUTH_GUIDE.md) covers it in full.

#### Basic Configuration

```javascript
import { createApp, auth, providers } from '@morojs/moro';

const app = await createApp();

// Auth is middleware, registered in application code (not in moro.config.js)
app.use(
  auth({
    providers: [
      providers.google({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      }),
      providers.github({
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
      }),
    ],
    secret: process.env.AUTH_SECRET,
    baseURL: process.env.BASE_URL, // the public URL; OAuth redirect URIs are built from it
    session: {
      maxAge: 30 * 24 * 60 * 60, // 30 days
    },
  })
);
```

#### OAuth Provider Configuration

| Property       | Type                 | Description                                                                              |
| -------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| `id`           | `string`             | The id of a Better Auth social provider (`github`, `google`, `gitlab`, `microsoft`, ...) |
| `clientId`     | `string`             | OAuth client ID                                                                          |
| `clientSecret` | `string`             | OAuth client secret                                                                      |
| `scope`        | `string \| string[]` | Scopes to ask for in addition to the provider's defaults                                 |
| anything else  |                      | Passed on as that Better Auth provider's option (`prompt`, `tenantId`, `hd`, ...)        |

The descriptive fields the `providers` helpers add to an entry (`name`, `type`, `authorization`, `token`, `userinfo`) are not passed on: Better Auth knows the endpoints of its providers. An entry whose `id` Better Auth does not know is left out with a warning at start-up.

#### Session Configuration

| Property    | Type     | Default   | Description                                                     |
| ----------- | -------- | --------- | --------------------------------------------------------------- |
| `maxAge`    | `number` | `2592000` | Session max age in seconds                                      |
| `updateAge` | `number` | `86400`   | Session update age in seconds                                   |
| other keys  |          |           | Better Auth's session settings (`freshAge`, `cookieCache`, ...) |

Where sessions are stored follows from Better Auth's `database` (`betterAuth: { database }`): without one they are kept in signed cookies. `session.strategy` is not used and draws a warning at start-up.

#### JWT Configuration

How `auth()` verifies an `Authorization: Bearer` token (it does not issue tokens):

| Property     | Type                                    | Default                     | Description                                       |
| ------------ | --------------------------------------- | --------------------------- | ------------------------------------------------- |
| `secret`     | `string`                                | `secret`, then `JWT_SECRET` | The secret tokens are verified with               |
| `audience`   | `string \| string[]`                    | not checked                 | Accepted `aud` claim                              |
| `issuer`     | `string \| string[]`                    | not checked                 | Accepted `iss` claim                              |
| `algorithms` | `string[]`                              | `['HS256']`                 | Accepted signing algorithms                       |
| `maxAge`     | `number`                                | no limit                    | Oldest accepted token, in seconds since its `iat` |
| `decode`     | `({ token, secret }) => claims \| null` | none                        | Your own verification, in place of `jsonwebtoken` |

#### Pages

There are no built-in sign-in pages to configure: `pages` is not used and draws a warning at start-up. `GET /api/auth/signin` redirects to the provider (or lists the providers when there are several); link your own page to `req.auth.signIn(provider).url`.

#### Environment Variables

- `AUTH_SECRET` or `NEXTAUTH_SECRET`; `JWT_SECRET` for Bearer tokens when no option names a secret
- `BASE_URL` or `AUTH_URL`: the public URL, when `baseURL` is not set
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: read by your own configuration, as in the sample above

## Session Configuration

### Session Middleware

Configure session management with various storage backends. The same options, written as `modules.session` with `enabled: true` in the configuration, install the middleware without the `app.use()` call (see [Session (`modules.session`)](#session-modulessession)).

```javascript
import { createApp, middleware } from '@morojs/moro';

const app = await createApp();

app.use(
  middleware.session({
    store: 'redis', // 'memory', 'redis', 'file', or a CacheAdapter instance
    storeOptions: {
      host: 'localhost', // or url: process.env.REDIS_URL (node-redis 4+)
      port: 6379,
      keyPrefix: 'sess:',
    },
    secret: process.env.SESSION_SECRET, // from the environment, never a literal
    name: 'sessionId',
    // A `cookie` object replaces the default one as a whole: set every flag you rely on
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    },
    rolling: false,
    resave: false,
    saveUninitialized: false,
  })
);
```

#### Session Options

| Property            | Type                                            | Default         | Description                                                                                        |
| ------------------- | ----------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| `store`             | `'memory' \| 'redis' \| 'file' \| CacheAdapter` | `'memory'`      | Session store type                                                                                 |
| `storeOptions`      | `object`                                        | -               | Redis: `url` or `host`/`port`/`password`, `keyPrefix` (default `'sess:'`). File: `path`            |
| `secret`            | `string`                                        | _(none)_        | Signs the session id cookie; without it the id is sent unsigned                                    |
| `name`              | `string`                                        | `'connect.sid'` | Session cookie name                                                                                |
| `genid`             | `() => string`                                  | random hex id   | Session id generator                                                                               |
| `rolling`           | `boolean`                                       | `false`         | Reset expiry on each request                                                                       |
| `resave`            | `boolean`                                       | `false`         | Save session even if not modified                                                                  |
| `saveUninitialized` | `boolean`                                       | `false`         | Save new but not modified sessions                                                                 |
| `proxy`             | `boolean`                                       | `false`         | Mark the cookie `Secure` when the request arrived with `X-Forwarded-Proto: https` (behind a proxy) |

#### Cookie Configuration

| Property   | Type                          | Default     | Description                                                             |
| ---------- | ----------------------------- | ----------- | ----------------------------------------------------------------------- |
| `maxAge`   | `number`                      | `86400000`  | Session timeout in milliseconds                                         |
| `httpOnly` | `boolean`                     | `true`      | Prevent XSS access                                                      |
| `secure`   | `boolean`                     | _(not set)_ | `Secure` attribute. Not set: `Secure` when the request arrived over TLS |
| `sameSite` | `'strict' \| 'lax' \| 'none'` | `'lax'`     | SameSite policy                                                         |
| `domain`   | `string`                      | -           | Cookie domain                                                           |
| `path`     | `string`                      | `'/'`       | Cookie path                                                             |

#### Redis Store

`store: 'redis'` loads the `redis` package (node-redis 4+) and connects with `storeOptions`. To run
the store on a client you already have, node-redis 4+ or ioredis, pass
`store: new RedisCacheAdapter({ client, keyPrefix: 'sess:' })`; the adapter never closes a client it
was given.

While Redis cannot be reached, a request that carries a session cookie waits up to 5 seconds and is
then served without session data. The browser keeps its session id (no new cookie) and the request
writes nothing to that session, so the session is there again once Redis is.

## Cache Configuration

### Cache Middleware

Configure caching with multiple adapters and strategies.

```javascript
import { createApp, middleware } from '@morojs/moro';

const app = await createApp();

app.use(
  middleware.cache({
    adapter: 'redis', // 'memory', 'redis', 'file', or a CacheAdapter instance
    adapterOptions: {
      host: 'localhost',
      port: 6379,
    },
    defaultTtl: 300,
    keyPrefix: 'cache:',
    // Each pattern is a regular expression tested against the request path
    strategies: {
      '^/api/products/': {
        key: req => `products:${req.path}`,
        ttl: 600,
        condition: req => !req.query.preview, // evaluated before the handler runs
      },
      '^/api/posts$': {
        key: () => 'posts:list',
        ttl: 300,
      },
    },
    vary: ['Accept-Language'], // one cached entry per Accept-Language value; also sent as the Vary header
    etag: 'strong',
  })
);
```

#### Cache Options

| Property            | Type                            | Default         | Description                                                                                                                                 |
| ------------------- | ------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter`           | `string \| CacheAdapter`        | `'memory'`      | Cache adapter                                                                                                                               |
| `defaultTtl`        | `number`                        | `3600`          | Default TTL in seconds                                                                                                                      |
| `keyPrefix`         | `string`                        | `'moro:cache:'` | Key prefix for all cache entries                                                                                                            |
| `maxAge`            | `number`                        | `300`           | HTTP Cache-Control max-age                                                                                                                  |
| `vary`              | `string[]`                      | -               | Request headers that separate cached entries: each distinct value gets its own entry, and the names are sent as the `Vary` response header  |
| `varyBy`            | `string[]`                      | -               | Request headers that identify the caller (`['x-api-key']`): one entry per value, keyed by a hash of it; such responses are marked `private` |
| `credentialHeaders` | `string[]`                      | -               | Request headers, besides `Authorization` and `Cookie`, whose presence keeps a request out of the cache                                      |
| `etag`              | `boolean \| 'weak' \| 'strong'` | `'strong'`      | ETag generation                                                                                                                             |

Without a strategy `key`, an entry is keyed by method, host (`Host`, and `X-Forwarded-Host` when one
is sent), path and query string. With no `strategies` and no `varyBy` the middleware logs one line
at start-up that says what it stores and shares; see the
[Middleware Guide](./MIDDLEWARE_GUIDE.md#cache) for which requests never share an entry.

#### Cache Strategies

| Property    | Type       | Description                                                                   |
| ----------- | ---------- | ----------------------------------------------------------------------------- |
| `key`       | `function` | Function of the request that returns the cache key                            |
| `ttl`       | `number`   | TTL for this strategy                                                         |
| `condition` | `function` | Called with `(req, res)` before the handler; return `false` to skip the cache |

#### Redis Adapter

`adapter: 'redis'` loads the `redis` package (node-redis 4+) and connects with `adapterOptions`
(`url`, or `host` / `port` / `password` / `db`). To use a client you already have, node-redis 4+ or
ioredis, pass `adapter: new RedisCacheAdapter({ client })`. While Redis cannot be reached, a lookup
waits up to 5 seconds and then counts as a miss: the handler runs and its response is not stored.

## CDN Configuration

### CDN Integration

Configure CDN integration for asset delivery and cache invalidation.

```javascript
import { createApp, middleware } from '@morojs/moro';

const app = await createApp();

app.use(
  middleware.cdn({
    adapter: 'cloudflare', // 'cloudflare', 'cloudfront', 'azure', or a CDNAdapter instance
    adapterOptions: {
      zoneId: process.env.CLOUDFLARE_ZONE_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
    },
    autoInvalidate: true,
    invalidationPatterns: ['^/static/', '^/api/v\\d+/data'], // regular expressions tested against the path
  })
);
```

#### CDN Options

| Property               | Type                   | Description                                          |
| ---------------------- | ---------------------- | ---------------------------------------------------- |
| `adapter`              | `string \| CDNAdapter` | CDN adapter                                          |
| `adapterOptions`       | `object`               | Adapter-specific options                             |
| `autoInvalidate`       | `boolean`              | Auto-invalidate on content changes                   |
| `invalidationPatterns` | `string[]`             | Regular expressions matched against the request path |

## Runtime Configuration

### Multi-Runtime Support

Configure MoroJS to run on different runtime environments.

```javascript
// The runtime is chosen in application code, not in moro.config.js
import { createApp, createAppEdge, createAppLambda, createAppWorker } from '@morojs/moro';

const app = await createApp(); // 'node'
// const app = await createAppEdge(); // 'vercel-edge'
// const app = await createAppLambda(); // 'aws-lambda'
// const app = await createAppWorker(); // 'cloudflare-workers'
```

#### Runtime Types

| Type                   | Description              | Use Case                        |
| ---------------------- | ------------------------ | ------------------------------- |
| `'node'`               | Standard Node.js runtime | Traditional servers, containers |
| `'vercel-edge'`        | Vercel Edge Runtime      | Edge functions, serverless      |
| `'aws-lambda'`         | AWS Lambda runtime       | Serverless functions            |
| `'cloudflare-workers'` | Cloudflare Workers       | Edge computing                  |

#### MoroOptions (Legacy)

| Property       | Type                       | Description                                                    |
| -------------- | -------------------------- | -------------------------------------------------------------- |
| `autoDiscover` | `boolean \| object`        | Enable automatic module discovery, or its options              |
| `modulesPath`  | `string`                   | Path to modules directory                                      |
| `middleware`   | `any[]`                    | Accepted but not applied: register middleware with `app.use()` |
| `database`     | `object`                   | Database configuration (the `database` section)                |
| `cors`         | `boolean \| object`        | CORS configuration                                             |
| `compression`  | `boolean \| object`        | Compression configuration                                      |
| `helmet`       | `boolean \| object`        | Helmet security configuration                                  |
| `runtime`      | `RuntimeConfig`            | Runtime configuration                                          |
| `logger`       | `LoggerOptions \| boolean` | Logger configuration                                           |

## Environment Variables

### Standard Variables

| Variable           | Alternative         | Description                                                                                      |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------ |
| `NODE_ENV`         | -                   | Application environment                                                                          |
| `PORT`             | `MORO_PORT`         | Server port                                                                                      |
| `HOST`             | `MORO_HOST`         | Server host                                                                                      |
| `DATABASE_URL`     | `MORO_DATABASE_URL` | Primary database URL                                                                             |
| `REDIS_URL`        | `MORO_REDIS_URL`    | Redis connection URL                                                                             |
| `LOG_LEVEL`        | `MORO_LOG_LEVEL`    | Logging level                                                                                    |
| `MORO_CONFIG_FILE` | -                   | Path of the configuration file to load, in place of the `moro.config.*` in the working directory |

### Authentication Variables

| Variable               | Description                    |
| ---------------------- | ------------------------------ |
| `AUTH_SECRET`          | Authentication secret          |
| `NEXTAUTH_SECRET`      | Next.js Auth compatible secret |
| `GOOGLE_CLIENT_ID`     | Google OAuth client ID         |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret     |
| `GITHUB_CLIENT_ID`     | GitHub OAuth client ID         |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret     |

### External Service Variables

| Variable                 | Description            |
| ------------------------ | ---------------------- |
| `STRIPE_SECRET_KEY`      | Stripe secret key      |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `PAYPAL_CLIENT_ID`       | PayPal client ID       |
| `SMTP_HOST`              | SMTP server host       |
| `SMTP_PORT`              | SMTP server port       |
| `SMTP_USERNAME`          | SMTP username          |
| `SMTP_PASSWORD`          | SMTP password          |

### Prefixed Variables

Many environment variables also have a `MORO_` prefixed alternative, as listed in each section above:

- `MORO_PORT` instead of `PORT`
- `MORO_LOG_LEVEL` instead of `LOG_LEVEL`
- `MORO_CACHE_ENABLED` instead of `CACHE_ENABLED`

## Configuration Validation

MoroJS checks the configuration at startup with its own validator (no schema library is involved). It stops at the first invalid value: the error is logged (with a hint for port, URL and log-level fields), and a `ConfigValidationError` naming the field is thrown, so the app does not start. The error has `field`, `expectedType` and `value` (the rejected value as it was given). `value` is not enumerable, so it is not printed with an uncaught error or serialised by `JSON.stringify`: it can be a key, a passphrase or a password.

```bash
ERROR ❌ Configuration validation failed for 'server.port': Must be a number between 1 and 65535
ERROR   💡 Hint: Ports must be numbers between 1 and 65535
```

### Start-up warnings

Some configurations are accepted but do not mean what was written, or use a name that has been replaced. Each of these is reported once at start-up, as a warning, and changes nothing else:

| Warning                                                      | When                                                                                                                                       | What is in force                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Unknown configuration keys are ignored                       | A key inside a known section that the validator does not know (`server.prot`, `security.cors.orgin`)                                       | The key is dropped; the real setting keeps its value        |
| Size settings that cannot be read as a size                  | `bodySizeLimit: '500k'`, `maxUploadSize: '2 megabytes'`, `limits.maxHeaderSize: '16kb '`                                                   | 10 MB                                                       |
| Numeric settings given as null, an empty string or a boolean | `maxConnections: null`, `timeouts: { request: '' }`, `port: true`                                                                          | `0`, `0`, `1` (converted with `Number()`)                   |
| `server.timeout` is deprecated                               | `server.timeout` is set and `server.timeouts.request` is not                                                                               | `server.timeout`, as the request timeout                    |
| `server.ssl.<key>` is NOT applied by the native engine       | `maxVersion`, `honorCipherOrder`, `sigalgs` or `crl` is set and the app runs on the native engine                                          | The engine's listener runs without that key                 |
| The rate limit counts requests per connecting address        | `security.rateLimit.global` is enabled, `server.trustProxy` is not set, a request carries `X-Forwarded-For` (logged once, on that request) | Every client behind the proxy shares one limit              |
| The application's own registration is used                   | A section that installs a built-in is enabled and the app also registers that built-in with `app.use()`                                    | The app's registration; the configured one is not installed |

Free-form parts of the configuration are never called unknown: a module's own section under `modules`, `modules.session.storeOptions` and `cookie`, `security.csp.directives`, `performance.compression.gzip` / `brotli`, `websocket.options`, `queue`, and `server.ssl`, where each key that is set but not applied is named in a warning of its own.

### Shorthands

`createApp()` accepts `cors`, `helmet`, `compression`, `autoDiscover`, `validation` and `modulesPath` as short forms of `security.cors`, `security.helmet`, `performance.compression`, `modules.autoDiscovery` and `modules.validation`. A shorthand sets only what it names:

- `true` or `false` sets `enabled` and nothing else.
- An object sets the keys it contains and nothing else. It does not set `enabled`, with one exception: a CORS `origin` (below).
- `modulesPath: './mods'` sets `paths: ['./mods']` and `enabled: true`.

Every other key of the section keeps the value it got from the config file, from the environment or from the schema default, in that order of priority. Given in the same call, a shorthand is applied over the long form key by key (`cors: true` over `security: { cors: { ... } }`).

```typescript
import { createApp } from '@morojs/moro';

// moro.config.js: security.cors = { enabled: false, origin: ['https://app.example'], credentials: true }

// CORS on, with the origin list and credentials from the file
const app = await createApp({ cors: true });
```

With nothing else configured the result is the schema defaults plus what the shorthand names, so `createApp({ cors: true })` alone still answers with `origin: '*'`.

**A CORS origin switches CORS on.** When `origin` is set, in the `cors` shorthand, in `security.cors` or in the config file, and `enabled` is not set anywhere, CORS is enabled: `createApp({ cors: { origin: 'https://app.example' } })` answers with that origin. An `enabled` that is written down wins, `false` included, wherever it is written; `origin: false` does not switch CORS on.

> **Changed in the release after 1.8.25.** A shorthand used to be expanded over the schema defaults for its whole section and merged over the config file and the environment, so `cors: true` in code reset a config file's `origin` to `'*'`. Values from the config file and the environment now survive.

## Best Practices

1. **Use environment variables** for secrets and environment-specific values
2. **Use configuration files** for structure and defaults
3. **Validate early** - let MoroJS validate your config on startup
4. **Use type safety** with TypeScript configuration files
5. **Document your config** - especially custom middleware options
6. **Separate concerns** - different configs for different environments
7. **Use prefixed variables** (`MORO_*`) to avoid conflicts

## Example Complete Configuration

```javascript
// moro.config.js
import os from 'node:os';

export default {
  server: {
    port: process.env.PORT || 3001,
    host: '0.0.0.0',
    maxConnections: 5000,
    timeouts: { request: 30000 },
  },

  database: {
    url: process.env.DATABASE_URL,
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      maxRetries: 3,
      retryDelay: 1000,
      keyPrefix: 'myapp:',
    },
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: 'json',
    outputs: {
      console: true,
      file: {
        enabled: process.env.NODE_ENV === 'production',
        path: './logs/app.log',
      },
    },
  },

  security: {
    cors: {
      enabled: true, // required: without it no CORS middleware is installed
      origin: process.env.CORS_ORIGIN?.split(',') || ['https://myapp.com'],
      credentials: true,
    },
    helmet: {
      enabled: true,
    },
  },

  external: {
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    },
  },

  performance: {
    compression: {
      enabled: true,
      level: 6,
    },
    clustering: {
      enabled: process.env.NODE_ENV === 'production',
      workers: os.cpus().length,
      memoryPerWorkerGB: 1.5,
    },
  },
};
```

This configuration provides a production-ready setup with proper environment variable usage, security configurations, and performance optimizations.
