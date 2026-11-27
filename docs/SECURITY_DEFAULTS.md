# Defaults and what they mean

What an app created with `createApp()` and no options does for its own protection, and what it leaves to you. MoroJS starts small and fast: most protections are one line to turn on, and apart from the size limits and timeouts below, none of them is on until you do. This page lists the defaults in one place, so nothing is assumed to be on.

Everything here describes a default app on the native engine (the default HTTP server), started with `NODE_ENV` unset. What changes with `NODE_ENV=production` is at the [end](#what-changes-in-production-mode).

## At a glance

| Area                     | What a default app does                                                                                                  | How to change it                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Security headers         | Sends none                                                                                                               | `createApp({ helmet: true })` or `app.use(middleware.helmet())`            |
| CORS                     | Off: no `Access-Control-*` headers                                                                                       | `createApp({ cors: true })` or `app.use(middleware.cors({ origin }))`      |
| CSRF protection          | Off                                                                                                                      | `app.use(middleware.csrf({ secret }))`                                     |
| Rate limiting            | None                                                                                                                     | `.rateLimit()` on a route, or `app.use(middleware.rateLimit())`            |
| Connections and timeouts | No connection cap; a request must arrive within 5 minutes; an idle connection is closed after 75 s (engine after 1.1.21) | `server.maxConnections`, `server.timeouts.idle`, `server.timeouts.request` |
| Request bodies           | 10 MB limit; 100 MB for multipart uploads                                                                                | `server.bodySizeLimit`, `server.maxUploadSize`                             |
| Client address           | No trusted proxy: `req.ip` is the connected peer                                                                         | `server.trustProxy`                                                        |
| WebSockets               | Off. When enabled, origin checks depend on the adapter                                                                   | `websocket.options.cors.origin`                                            |
| Cookies                  | Parsed and set unsigned; `Secure` when the request arrived over TLS                                                      | `app.use(middleware.cookie({ secret }))`, the `secure` option              |
| Response cache           | Off. `middleware.cache()` shares every `GET` response that carries no `Cookie` or `Authorization`                        | `varyBy`, `credentialHeaders`, `strategies`                                |
| gRPC                     | Off. `app.grpcInit()` listens on every interface, in plaintext                                                           | `host`, `credentials`                                                      |
| Files found at start-up  | The configuration file, modules and route files are looked up in the working directory                                   | `MORO_CONFIG_FILE`, absolute `modules.autoDiscovery.paths`                 |
| Order of execution       | `request` hooks and hook-based built-in middleware run before every `app.use()` function, whatever the order you wrote   | Declare guards on the route, or register them as hooks                     |
| Logs and telemetry       | Sensitive metadata keys and credential query parameters are redacted                                                     | `logger.redact`, `redactedQueryParams`                                     |
| Listen address           | `app.listen(port)` listens on every network interface                                                                    | `app.listen(port, host)`, or `app.listen()` with `server.host`             |

## Security headers

A default app adds no security headers to the responses your handlers send, or to its own error responses: no `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Strict-Transport-Security`, `Content-Security-Policy` or `Referrer-Policy`. The one exception is a file sent with `res.sendFile()` or served by `middleware.range()`, which carries `X-Content-Type-Options: nosniff`. No `X-Powered-By` header is sent either.

```typescript
import { createApp, middleware } from '@morojs/moro';

const app = await createApp({ helmet: true }); // or security: { helmet: { enabled: true } }

// or, on an existing app:
app.use(middleware.helmet());
```

## CORS and CSRF

CORS is off. No `Access-Control-*` header is sent, so browsers keep cross-origin pages from reading responses, and a preflight `OPTIONS` request for a path that has no `OPTIONS` route is answered `404`. `createApp({ cors: true })` allows every origin (`Access-Control-Allow-Origin: *`); pass `security.cors.origin` or `middleware.cors({ origin })` to name the origins you mean.

CSRF protection is off. An app that authenticates browsers with cookies needs `middleware.csrf({ secret })` or an equivalent check.

## Rate limiting

There is no rate limit, global or per route. Add one where it matters:

```typescript
app
  .post('/login')
  .rateLimit({ requests: 5, window: 60000 })
  .handler(req => signIn(req.body));

// or for every request:
app.use(middleware.rateLimit({ requests: 300, window: 60000 }));
```

## Connections and timeouts

On the native engine, a default app has:

- no cap on open connections (`server.maxConnections` is `0`);
- a request timeout of 5 minutes (`server.timeouts.request`): a client has that long to deliver one complete request, headers and body, however steadily it sends, and is answered `408` otherwise;
- an idle timeout of 75 seconds (`server.timeouts.idle`) with `@morojs/engine` after 1.1.21: a connection that sends nothing, and a keep-alive connection between requests, is closed after that long. With an engine up to 1.1.21 there is no idle timeout unless you set one, because those engines would also close a slow client in the middle of a large response; the start-up log says when the default is not applied. The request timeout still closes a connection that starts a request and does not finish it; one that never sends a byte stays open, so cap the connections (below) or set `server.timeouts.idle` on such an engine if the app faces the internet directly;
- no limit on the response data queued for one connection (`server.limits.responseBackpressureLimit` is not set): a client that asks for large responses and does not read them holds them in memory until the engine closes it after 5 minutes without progress, or, with `@morojs/engine` 1.2.4 or later, sooner when the buffer budget below runs short;
- with `@morojs/engine` 1.2.4 or later, a budget for what all connections hold in buffers together (`server.limits.memoryBudget`): request bodies still arriving, WebSocket messages being reassembled and response data clients have not taken. Not set, it is an eighth of the memory the process may use (its container's cgroup limit when there is one, the machine's memory otherwise), divided evenly among the threads that serve and never below the largest single request or WebSocket message a thread accepts; `false` switches it off. On a thread over its part, a connection that has just grown what it holds, and holds more than 16 KiB, is closed at once: an HTTP/1 request still arriving is answered `503` with `Connection: close` (closed without a response when one of that connection's responses is still ahead of it), a WebSocket whose message is being reassembled is closed with code `1013`, an HTTP/2 connection is sent `GOAWAY`, and a client that is not reading its responses is closed without a status. A connection holding 16 KiB or less is never closed for the budget, so small requests are served while it is full. While less than an eighth of a thread's part is free, a connection holding more than 4 KiB that has moved nothing for a sweep interval (a second with the default timeouts) is closed as well, unless a handler holds its request and nothing is queued for its client. An engine before 1.2.4 has no such budget and ignores the setting, and there the per-connection limits are the only bound. The details are in the [Configuration Reference](./CONFIGURATION_REFERENCE.md#server-section).

Neither timeout limits a request a handler is working on: a slow handler, a streamed response, server-sent events and WebSockets are not closed by them. What each timeout covers on each server, and the one kind of large response that `idle` can cut short for a slow client on an engine up to 1.1.21, is in the [Configuration Reference](./CONFIGURATION_REFERENCE.md#server-section).

An app that faces the internet directly should also cap its connections, and may want a shorter request timeout than the default; behind a reverse proxy or load balancer, its limits usually do this job.

```typescript
const app = await createApp({
  server: {
    maxConnections: 10000,
    timeouts: { request: 30000 }, // milliseconds
    // More than the largest response the app writes in one piece
    limits: { responseBackpressureLimit: '16mb' },
  },
});
```

`0` switches a timeout off. An app that keeps connections open and idle for longer than 75 seconds on purpose, or takes uploads that last longer than 5 minutes, sets the value it needs.

On the Node.js server (`server.engine: 'node'`) the request timeout is the same 5 minutes; idle connections are closed by `server.timeouts.keepAlive` (5 seconds between requests) and `server.timeouts.headers` (6 seconds to send the headers), and `server.timeouts.idle` is not set. Behind a load balancer, see [Idle connections behind a load balancer](./CONFIGURATION_REFERENCE.md#behind-a-proxy).

## Request bodies

| Limit                                                                 | Default |
| --------------------------------------------------------------------- | ------- |
| `server.bodySizeLimit`                                                | `10mb`  |
| `server.maxUploadSize`                                                | `100mb` |
| `server.limits.multipart.maxParts` (parts in one upload)              | 1000    |
| `server.limits.multipart.maxPartHeaderBytes` (header block of a part) | `16kb`  |
| `server.limits.form.maxFields` (fields in one urlencoded form)        | 1000    |

A request over a limit is answered `413` and does not reach its route. On the native engine `app.setErrorHandler()` is given that `413` first and may answer it differently (a body over both `bodySizeLimit` and `maxUploadSize` excepted: the engine answers that one itself); the Node.js and HTTP/2 servers answer it without calling the handler and run the `error` hooks instead. [Request bodies](./API.md#request-bodies) has the details.

`server.bodySizeLimit` applies to JSON, form, text and binary bodies; `multipart/form-data` uploads are bounded by `server.maxUploadSize` instead. Lower both to what your routes need, or give a single route a tighter limit with `middleware.bodySize({ limit })`.

The two counts bound what a body costs to parse, which its size does not: a urlencoded form of 100,000 one-byte fields is under a megabyte. A form with more fields than `server.limits.form.maxFields` (`MORO_FORM_MAX_FIELDS` in the environment) is refused before any of it is decoded; the fields are the segments between `&` separators, and an empty one counts.

## Client address and proxies

No proxy is trusted by default. With `server.trustProxy` not set:

- `req.ip` is the address of the connected peer. Behind a reverse proxy or load balancer, that is the proxy, for every request.
- `req.ips` lists whatever `X-Forwarded-For` the request carried, and `req.protocol` / `req.secure` follow `X-Forwarded-Proto`. Any client can send those headers, so do not base a decision on them unless a proxy you control overwrites them.
- `req.hostname` comes from the `Host` header.

An app that clients reach directly should set `server.trustProxy: false`, so the forwarded headers are ignored. Behind a proxy, say which hops to believe:

```typescript
const app = await createApp({
  server: { trustProxy: 1 }, // one proxy in front of the app
});
```

`server.trustProxy` takes `false` (trust nothing: `req.ips` is empty and `req.protocol` describes the connection itself), a number of hops, `true` (every hop: only safe when the proxy replaces `X-Forwarded-For` instead of appending to it), or an address, CIDR range or list of them. With it set, `req.ip` is the client as the trusted proxies report it, and rate limiting and logging by address see real clients instead of the proxy. The full table is under [Behind a proxy](./CONFIGURATION_REFERENCE.md#behind-a-proxy).

## WebSockets

WebSockets are off (`websocket.enabled` is `false`). Once enabled, what happens to a browser page on another origin depends on the adapter while `websocket.options.cors.origin` is not set:

| Adapter                     | `cors.origin` not set                                            |
| --------------------------- | ---------------------------------------------------------------- |
| Native engine (the default) | Origins are not checked: a page on any origin can connect        |
| Socket.IO                   | Origins are not checked: a page on any origin can connect        |
| `ws`                        | Same-origin only: the `Origin` host must equal the `Host` header |

Set `websocket.options.cors.origin` (a string, a list, a `RegExp`, `false` for same-origin only, or a function) and every adapter refuses a handshake from an origin the value does not allow. A request without an `Origin` header (a client that is not a browser page) and a same-origin request are always accepted, so an origin rule is not authentication: check credentials in `verifyClient` or in the connection handler.

## Cookies

`req.cookies` is parsed and `res.cookie()` works without any middleware, and cookies are set as you describe them: unsigned, with the attributes you pass. A client can therefore change any cookie value. To sign cookies, register the cookie middleware with a secret:

```typescript
app.use(middleware.cookie({ secret: process.env.COOKIE_SECRET, signed: true }));
```

Asking for a signed cookie with no secret configured throws instead of quietly setting an unsigned one.

The `Secure` attribute follows the connection when you do not pass `secure`: a cookie set while answering a request that arrived over TLS is `Secure`, and one set over plain HTTP is not. "Over TLS" means a TLS connection to this server (`server.ssl`), or `X-Forwarded-Proto: https` from a proxy named in [`server.trustProxy`](#client-address-and-proxies). The same rule covers `res.cookie()`, `res.clearCookie()`, the session cookie and the CSRF cookie, on every server and runtime adapter (on Lambda, Edge and Workers it is what the platform reports).

Behind a proxy that terminates TLS, set `server.trustProxy`: until you do, the app sees plain HTTP and the cookies it sets are not `Secure` unless you pass `secure: true`. `secure: true` and `secure: false` are always taken as written. A cookie with `SameSite=None` and no `Secure` is logged once as a warning, because browsers drop it.

## Response cache

`middleware.cache()` with no options stores every `GET` response for an hour and replays it to any caller of the same host, path and query. Its lookup runs before `app.use()` middleware, your authentication included, so the cache decides from the request alone who may share an answer:

- a request that carries `Cookie` or `Authorization` is never served from the cache and never stored;
- nothing is stored once the application has set `req.user`, for a `401`, `403`, `407`, `429` or `5xx`, or for a response whose `Cache-Control` says `private`, `no-store` or `no-cache`; `Set-Cookie` is never stored.

What the cache cannot see is a response that depends on something else about the caller: an API key in a header of your own, the client address, a token in the query. Name such a header in `varyBy` (one entry per caller) or in `credentialHeaders` (never cached), or give those paths a strategy with a `key` or a `condition`. Installed with no strategies and no `varyBy`, the middleware says what it will share in one start-up log line. See the [Middleware Guide](./MIDDLEWARE_GUIDE.md#cache).

## Order of execution

A request passes through three stages, in this order:

1. `request` hooks: `app.hooks.before('request', ...)` and the built-in middleware that are implemented as hooks (`auth`, `cache`, `cdn`, `cookie`, `cors`, `csp`, `csrf`, `graphql`, `rateLimit`, `session`, `sse`, `validation`).
2. Function middleware registered with `app.use(fn)`, in registration order (`bodySize`, `compression`, `helmet`, `staticFiles`, `requestLogger` and the other built-ins that are plain functions belong here, as does your own middleware).
3. The route: what it declares on its builder, always in the order `before`, rate limit, auth, validation, `transform`, `after`, cache, then the handler.

The first stage runs before the second whatever order the `app.use()` calls were written in. A guard written as a function and registered first does not run before `middleware.cors()` registered after it:

```typescript
app.use(requireApiKey); // function middleware: stage 2
app.use(middleware.cors()); // hook: stage 1, runs first
```

Every request hook runs for every request, also after one of them has answered it. The built-in ones then leave the request alone (no CSP or CDN header, no session, no cache lookup, no GraphQL execution); the rate limiter still counts a request that a hook registered ahead of it answered, such as an auth `401`.

What a route declares is ordered for you (rate limiting before auth, auth before the cache), so put a guard that must come before caching or rate limiting on the route with `.auth()` or `.before()`, or register it with `app.hooks.before('request', ...)`.

## Listen address

`app.listen(3000)` listens on every network interface, so the app is reachable from other machines on the network. Pass a host to choose one: `app.listen(3000, 'localhost')` accepts local connections only. `app.listen()` with no arguments takes both values from the configuration, `server.port` (`3001`) and `server.host` (`localhost`).

## gRPC

gRPC is off until `app.grpcInit()` is called. Started with no options, the gRPC server listens on every interface (`host: '0.0.0.0'`, port `50051`) and without TLS, and logs a warning that says so. There are two ways out: `host: '127.0.0.1'` to accept local connections only, or `credentials` to serve TLS; with `rootCerts` and `requireClientCert: true`, only clients holding a certificate you issued can connect. See the [gRPC Guide](./GRPC_GUIDE.md#tlsssl).

An error a handler throws is answered with its message unless `NODE_ENV=production` (see [below](#what-changes-in-production-mode)).

## Files found at start-up

A default app looks in the working directory of the process for three things and loads what it finds:

- the configuration file: `moro.config.cjs`, `moro.config.js` or `moro.config.ts`;
- modules: `./modules` and `./src/modules` (in production `./dist/modules`, `./dist/src/modules`, `./modules`);
- route files: `./src/routes` (in production `./dist/routes`, `./dist/src/routes`).

Optional packages (database drivers, validation libraries, SDKs) are resolved from the working directory's `node_modules` as well. Started the usual way, from the project root, that directory is the project. Started from somewhere else, the process loads what that other directory holds, so start a service from a directory only its owner can write to (set `WorkingDirectory=` in a systemd unit, `WORKDIR` in a container image).

To pin the paths so the working directory does not matter:

| What               | How to pin it                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| Configuration file | `MORO_CONFIG_FILE=/srv/app/moro.config.cjs` (no other file is looked for; a missing one is an error) |
| Modules            | absolute paths in `modules.autoDiscovery.paths`, or `autoDiscover: false`                            |
| Route files        | absolute paths in `routing.paths`, or `routing: false`                                               |

The loaded configuration file is logged at `info` level with its full path; the module and route directories that are scanned are logged at `debug` level. When a configuration file, a module directory or a route directory was found through the working directory and the application was not started from there (the script the process was started with is elsewhere, and so is the installed framework), one `info` line per kind says which path was used and how to pin it.

The native engine's `MORO_ENGINE_BINARY` environment variable makes it load the native binary at that path in place of the installed one. It exists for instrumented builds and A/B runs, and is not something a deployment sets. When it is in force, the start-up lines that name the engine (`HTTP engine: ...`) carry the path, and `app.engine.engineBinary` holds it.

## Routing details worth knowing

- `HEAD` is not routed to `GET` handlers: a `HEAD` request for a path that only has a `GET` route is answered `404`.
- A request with a method that has no route for the path is answered `404`, not `405`.
- Route parameters are percent-decoded once: `/files/a%2Fb` gives `req.params.name === 'a/b'`, and `%2e%2e` gives `'..'`. A handler that builds a file path or a URL from a parameter must validate it.

## Logs and telemetry

- Wherever the logger prints metadata (the `json` format, and `pretty` with `enableMetadata`), the values of sensitive keys such as `password`, `token`, `secret`, `authorization`, `cookie` and `apiKey` are replaced with `[REDACTED]`. Message text is not rewritten.
- In the `pretty` and `compact` formats, control characters in a logged message are written as visible escapes, so a request value cannot forge a log line.
- The configuration dump logged at `debug` level masks secrets and the credentials inside connection URLs, in every environment.
- `middleware.errorTracker()` and `middleware.openTelemetry()` record URLs with the values of credential-carrying query parameters (`token`, `code`, `signature`, ...) replaced with `REDACTED`.
- Request logging (one line per request: method, path, status, duration) is on outside production.

See [Logging](./API.md#logging) and the [Middleware Guide](./MIDDLEWARE_GUIDE.md#monitoring--logging).

## Optional packages

- Validation libraries, database drivers and SDKs are your application's own packages; the versions Moro supports are the `peerDependencies` ranges in its `package.json`.
- Two supported lines have a published advisory that no release of the same major fixes: Zod 3 (and Zod 4 before 4.6.6), and the `aws-sdk` v2 package the CloudFront CDN adapter falls back to. Moro still loads them, and logs one warning at start-up when it does, naming what to move to: Zod 4.6.6 or later, and `@aws-sdk/client-cloudfront`.

## What changes in production mode

With `NODE_ENV=production`:

- Request logging is off unless `server.requestLogging.enabled` is set.
- Error responses carry less: a validation failure omits its `details`, a failed template render omits the reason, and the `500` a runtime adapter (`createAppLambda`, `createAppEdge`, `createAppWorker`) answers when a request could not be served omits the error's message. The full error still goes to the log.
- A configuration file that fails to load stops start-up; elsewhere the app starts on environment variables and defaults with a warning.
- A gRPC handler's thrown error reaches the client without its message: the status code stays, the text becomes the status's standard text (`Internal server error`, `Not found`, ...), and the error is logged. An error that carries a gRPC status code of its own (an integer `code` from 1 to 16) keeps its message.
- Route files are loaded from `./dist/routes` or `./dist/src/routes` instead of `./src/routes`, and modules from `./dist/modules`, `./dist/src/modules` or `./modules` instead of `./modules` or `./src/modules`.
- GraphQL introspection and the playground are off unless turned on explicitly.
- `createAuthMiddleware()` refuses to start without a secret; elsewhere it generates a random one and warns. It also warns when no base URL is configured, and Better Auth rate-limits its sign-in routes per client address.

Nothing else is tightened by `NODE_ENV=production`: security headers, CORS, rate limits, timeouts and the trusted-proxy setting are the same in every environment, and stay as described above until you configure them.
