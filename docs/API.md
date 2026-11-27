# MoroJS API Reference

Complete API documentation for the MoroJS framework.

## Table of Contents

- [Core API](#core-api)
- [Runtime System](#runtime-system)
- [Application Class](#application-class)
- [Intelligent Routing](#intelligent-routing)
- [Module System](#module-system)
- [Validation System](#validation-system)
- [Middleware](#middleware)
- [Database Integration](#database-integration)
- [Message Queues](#message-queues)
- [gRPC Support](#grpc-support)
- [WebSocket Support](#websocket-support)
- [Configuration](#configuration)
- [Events](#events)
- [Worker Threads](#worker-threads)
- [Performance](#performance)
- [Error Handling](#error-handling)

---

## Core API

### createApp(options?)

Creates a new MoroJS application instance.

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp({
  cors: true,
  compression: true,
  helmet: true,
  autoDiscover: true,
  modulesPath: './modules',
});
```

**Options:**

- `cors` (boolean | object): Enable CORS middleware
- `compression` (boolean | object): Enable compression middleware
- `helmet` (boolean | object): Enable security headers
- `autoDiscover` (boolean): Auto-discover modules in modulesPath
- `modulesPath` (string): Path to modules directory
- `runtime` (RuntimeConfig): Runtime configuration for multi-environment deployment

**Returns:** `Moro` - Application instance

### Several apps in one process

A process can create more than one app: a public API and an admin app on another port, an app and a test double, several apps in one test file. Each app is separate from the others:

```typescript
import { createApp } from '@morojs/moro';

const api = await createApp({ server: { bodySizeLimit: '1mb' } });
const admin = await createApp({ server: { bodySizeLimit: '100kb' } });

api.get('/products', () => ({ products: [] }));
admin.get('/users', () => ({ users: [] }));

api.listen(3000);
admin.listen(3001, '127.0.0.1');

// GET http://localhost:3000/users    -> 404: the route is the admin app's
// GET http://127.0.0.1:3001/products -> 404: the route is the API's
```

What each app owns:

| Owned by the app                                                                                                                                             | Notes                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its routes: `app.get()` and the other method calls, the route builder, `app.route(schema)`, groups, a `createRouter()` mounted on it, module routes it loads | A path registered on one app is a 404 on the others. Two apps may register the same path with different handlers                                                        |
| The rate-limit counters of its routes (`.rateLimit()`, a module route's `rateLimit`) and of a configured `security.rateLimit.global`                         | Requests served by one app never count against a limit on another                                                                                                       |
| The responses cached for its routes (`.cache()`, a module route's `cache`)                                                                                   | Sized by that app's `modules.cache.maxSize` and `modules.cache.defaultTtl`                                                                                              |
| Its middleware, hooks and error handler (`app.use()`, `app.hooks`, `app.setErrorHandler()`)                                                                  |                                                                                                                                                                         |
| Its API documentation (`app.enableDocs()`)                                                                                                                   | Lists that app's routes only                                                                                                                                            |
| Its WebSocket namespaces, its dependency-injection container and its event bus                                                                               |                                                                                                                                                                         |
| Its configuration (`app.getConfig()`)                                                                                                                        | Built from the options that `createApp()` call was given, on top of the environment, the config file and the defaults. Options given to one app do not apply to another |

Closing one app (`await app.close()`) leaves the others serving.

What the process has one of, whatever the number of apps:

- The logger. `createApp({ logger })` and an app's `logging` configuration set the level of the one framework logger, so the app created last decides it.
- The worker-thread pool (`createApp({ workers })`, `executeOnWorker()`). The first app that configures or uses it creates it, and it runs until the last app that has used it is closed. An app created after that point, or one that first reaches for the pool then, gets a new pool, which is its own until it is closed in turn. A bare `getWorkerManager()` or `workerTasks` call made when no app holds a pool also starts one and its tasks run, but that pool's threads do not keep the process alive.
- The cluster workers. Clustered apps (`performance.clustering`) share one set of workers: the first one to listen starts them and each later one adds its listener to them, so two clustered apps of four workers run four workers, not eight. An app is served by the number of workers it is configured for, and the set is as large as the largest count. Closing one app closes its port in every worker and leaves the others serving; the workers stop when the last clustered app is closed. Nothing has to be configured for this. If one of the apps can only cluster as worker processes (`engine: 'node'`), all of them do.
- The native engine, including which TLS library it was loaded with (`server.ssl.library`): the first app that starts on the engine decides it.
- The environment and the config file (`moro.config.js` / `moro.config.ts`): every app reads the same ones, and applies its own `createApp()` options on top.

#### The current app

Some functions are not called on an app: `getApp()`, the standalone route builders `createRoute()` and `defineRoute()`, and the configuration readers `getGlobalConfig()`, `getConfigValue()` and `createModuleConfig()`. They act on the current app:

1. While an app is loading route files (`app.loadRoutes(dir)`, or the directories of the `routing` option when it starts listening), the current app is that app. A route file that registers through `getApp()` or `createRoute()` therefore registers on the app that loads it.
2. Otherwise it is the app created most recently that has not been closed.
3. Once every app has been closed, it is the app created most recently.

With one app in the process, the current app is that app.

```typescript
// routes/health.ts, loaded by app.loadRoutes('./routes') or by file-based routing
import { getApp, createRoute } from '@morojs/moro';

getApp().get('/health', () => ({ status: 'ok' }));

createRoute('GET', '/version').handler(() => ({ version: '1.0.0' }));
```

- `getApp()` returns the current app. It throws when no app has been created with `createApp()` (or `createAppNode()`, `createAppEdge()`, `createAppLambda()`, `createAppWorker()`) yet.
- `createRoute(method, path)` returns a route builder and `defineRoute(schema)` registers a schema-first route, both on the current app. Called before any app exists, the route waits, and the first app created serves it; apps created after that one do not.
- `getGlobalConfig()`, `getConfigValue(path)` and `createModuleConfig()` read the current app's configuration. `app.getConfig()` is the way to read one particular app's.

Where the app is at hand, register on it (`app.get(path, handler)`, `app.route(schema)`): that never depends on which app is current.

A route file is evaluated once per process, however many apps load its directory, so the routes it registers belong to the first app that loads it. Every app loads `./src/routes` by default (`./dist/routes` or `./dist/src/routes` in production): with several apps, give each its own directories (`createApp({ routing: { paths: ['./src/admin-routes'] } })`) or turn file-based routing off for the apps that have none (`routing: false`). Route files are loaded for one app at a time.

---

## Runtime System

MoroJS supports multiple runtime environments with the same API. Choose the appropriate function for your deployment target.

### createApp(options?)

Creates a Node.js application (default runtime).

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();
app.listen(3000); // Traditional HTTP server
```

### createAppEdge(options?)

Creates a Vercel Edge Functions application.

```typescript
import { createAppEdge } from '@morojs/moro';

const app = await createAppEdge();

app.get('/api/hello', (req, res) => {
  return { message: 'Hello from the Edge!' };
});

export default app.getHandler(); // Export for Vercel
```

### createAppLambda(options?)

Creates an AWS Lambda application.

```typescript
import { createAppLambda } from '@morojs/moro';

const app = await createAppLambda();

app.get('/api/users/:id', (req, res) => {
  return { userId: req.params.id, lambda: true };
});

export const handler = app.getHandler(); // Export for Lambda
```

### createAppWorker(options?)

Creates a Cloudflare Workers application.

```typescript
import { createAppWorker } from '@morojs/moro';

const app = await createAppWorker();

app.get('/api/geo', (req, res) => {
  return {
    country: req.headers['cf-ipcountry'],
    ray: req.headers['cf-ray'],
  };
});

export default {
  async fetch(request, env, ctx) {
    return app.getHandler()(request, env, ctx);
  },
};
```

### Runtime Configuration

You can also specify runtime configuration explicitly:

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp({
  runtime: {
    type: 'vercel-edge', // 'node' | 'vercel-edge' | 'aws-lambda' | 'cloudflare-workers'
    options: {
      // Runtime-specific options
    },
  },
});
```

### Runtime Methods

#### app.getRuntimeType()

Returns the current runtime type.

```typescript
const app = await createAppEdge();
console.log(app.getRuntimeType()); // 'vercel-edge'
```

#### app.getRuntime()

Returns the runtime adapter instance.

```typescript
const app = await createAppLambda();
const adapter = app.getRuntime();
console.log(adapter.type); // 'aws-lambda'
```

#### app.getHandler()

Returns a runtime-specific handler function. Only available for non-Node.js runtimes.

```typescript
const app = await createAppEdge();
const handler = app.getHandler(); // Function for Vercel Edge

const nodeApp = await createApp();
// nodeApp.getHandler() // Available but use listen() instead
```

The handler runs a request through the same steps as `listen()` does: `request` hooks, then the global middleware chain (config-driven helmet, CORS, compression and request logging, then everything registered with `app.use()`), then the router. A middleware that answers the request ends it, and `next(err)` reaches error middleware and the handler set with `app.setErrorHandler()` as on Node.js. See [Global Middleware and Hooks](./RUNTIME.md#global-middleware-and-hooks) for what differs on a serverless response.

#### app.listen(port, [host], [callback])

Starts the HTTP server. Only available for Node.js runtime.

```typescript
const app = await createApp();
app.listen(3000, () => {
  console.log('Server running on port 3000');
});

const edgeApp = await createAppEdge();
// edgeApp.listen(3000); // Throws error - use getHandler() instead
```

### Runtime-Specific Features

#### Node.js Runtime

- Full HTTP server capabilities
- WebSocket support
- File system access
- Process management
- Traditional `listen()` method

#### Vercel Edge Runtime

- Web API Request/Response objects
- Global edge deployment
- Fast cold starts
- Streaming responses
- Geographic routing

#### AWS Lambda Runtime

- Event/Context handling
- Auto-scaling
- Pay-per-request pricing
- VPC integration
- Event-driven architecture

#### Cloudflare Workers Runtime

- Global edge network
- KV storage integration
- Durable Objects support
- Environment variables access
- Instant deployment

---

## Application Class

### HTTP Methods

Routes are registered with `app.get`, `post`, `put`, `delete`, `patch`,
`head` and `options`. A request that no route and no middleware answers gets:

- **A `HEAD` request: the GET route's answer without the body.** When no
  `head()` route is registered for the path, the GET route runs, middleware
  included, and the response carries the status and headers the GET would
  have, `Content-Length` among them, and no body. `req.method` is `'HEAD'`,
  so a handler that must not do its work for a HEAD can tell. Register
  `app.head(path, ...)` to answer it differently.
- **`OPTIONS *`: `204` with `Allow: GET, HEAD, POST, PUT, DELETE, PATCH,
OPTIONS`**, the methods routes can be registered for.
- **Any other method (`TRACE`, `PROPFIND`, a made-up one): `501 Not
Implemented`** on the native engine. The Node server's parser refuses a
  method it does not know with a 400 before the app sees it. Middleware that
  serves such a method (`app.use()` answering `PURGE`, say) runs first.
- **Otherwise `404`.**

#### app.get(path, handler?, options?)

Register a GET route.

```typescript
// Chainable API (Recommended)
app
  .get('/users')
  .query(z.object({ limit: z.coerce.number().default(10) }))
  .cache({ ttl: 60 })
  .handler(async (req, res) => {
    return { users: await getUsers(req.query) };
  });

// Direct API
app.get('/users', async (req, res) => {
  return { users: await getUsers() };
});

// Direct API with route options
app.get(
  '/users/search',
  async (req, res) => {
    return { users: await getUsers(req.query) };
  },
  {
    validation: { query: z.object({ q: z.string().min(1) }) },
    rateLimit: { requests: 30, window: 60000 },
    cache: { ttl: 60 },
  }
);
```

The options object takes `validation`, `rateLimit`, `auth`, `cache`, `middleware`, `description` and `tags`. Each is applied exactly as the builder method of the same name applies it, in the same fixed order (see [Execution Phases](#execution-phases)), and on the route's URL with a trailing slash as well where the server routes that form. `validation` is the `{ body, query, params, headers }` object `.validate()` takes; a schema passed on its own validates the body. `middleware` is an array of `(req, res, next)` functions. An option with any other name is not applied, and is named in a warning when the route is registered. The form takes one handler: in `app.get(path, fn1, fn2)` the second function sits where the options go and does not run (a warning says so); pass middleware as `{ middleware: [fn1] }`, with `.before(fn1)` on the builder, or on a `createRouter()` route.

#### app.post(path, handler?, options?)

#### app.put(path, handler?, options?)

#### app.delete(path, handler?, options?)

#### app.patch(path, handler?, options?)

Same pattern as `get()` but for different HTTP methods.

#### How request paths are matched

A route path is made of fixed segments and parameters:

| In the path                 | Matches                                      | In `req.params`                                  |
| --------------------------- | -------------------------------------------- | ------------------------------------------------ |
| `:id`                       | one whole segment                            | `id`                                             |
| `:id?` as the last segment  | that segment, or the path without it         | `id`, or no `id` key when the path leaves it out |
| `*` as the last segment     | everything after the slash, slashes included | `'*'`: the rest of the path, which can be empty  |
| `*name` as the last segment | the same                                     | `name`                                           |

```typescript
// An optional parameter: /posts and /posts/7
app.get('/posts/:id?', req => {
  if (req.params.id === undefined) return listPosts();
  return getPost(req.params.id);
});

// More than one, at the end of the path: /archive, /archive/2026, /archive/2026/11
app.get('/archive/:year?/:month?', req => ({
  year: req.params.year,
  month: req.params.month,
}));

// A wildcard: /files/, /files/report.pdf, /files/reports/2026/q1.pdf (not /files)
app.get('/files/*', req => ({ file: req.params['*'] })); // '', 'report.pdf', 'reports/2026/q1.pdf'

// A named wildcard, after a parameter
app.get('/static/:kind/*path', req => ({ kind: req.params.kind, path: req.params.path }));
```

**Optional parameters** are the last segment of the path, or the last few (`/a/:b?/:c?`, where `:c` can only be there when `:b` is). The parameter is called `id`, not `id?`. `/posts/:id?` also answers `/posts/`.

**A wildcard** takes what follows the slash after its path: `/files/*` answers `/files/` (with an empty value) and everything below it, and does not answer `/files`. A slash at the end of the URL is part of the value (`/files/a/` gives `a/`). `/*` answers every path no other route answers.

**Which route answers** does not depend on the order of registration:

1. a fixed segment before a parameter, at every position (`/users/me` before `/users/:id`);
2. a route registered for exactly the path before a route that reaches it through an optional parameter (`/users/:id` before `/users/:id?` for `/users/7`, and `/users` before `/users/:id?` for `/users`);
3. a wildcard last, when no other route answers the path; among wildcards, the one with the longest path in front of it (`/files/img/*` before `/files/*`).

A parameter route also answers its URL with one trailing slash (`/users/7/`), and that counts as an answer in rule 3: with `/users/:id` and `/users/:id/*` registered, `/users/7/` is answered by `/users/:id`. Registering the same method and path again replaces the earlier route.

**Values.** A parameter value is percent-decoded once (`/users/a%2Fb` gives `a/b`; a malformed escape is left as it was sent), and so is a wildcard's value, as a whole (`/files/a%2Fb/c` gives `a/b/c`). The request path itself is matched as it was sent: an encoded slash does not start a new segment, and dot segments are not resolved. `/files/../admin` is answered by `/files/*` with the value `../admin`, never by a route for `/admin`. The value of a wildcard is therefore text from the client that can contain `..`, and after decoding a leading `/`: resolve it against the directory you serve from and check that the result is still inside it (or use `middleware.staticFiles()`, which does) before opening a file. The serverless runtimes hand the app a path their platform has already resolved, so there a dot segment never arrives.

**Empty segments.** A path with an empty segment (`//users`, `/users//7`) is not matched by any route, and that holds inside a wildcard too: `/files//x` and `/files/a//b` are answered 404, so a prefix check such as `app.use('/files/private', guard)` sees every path the wildcard route can receive.

**What is refused.** An optional parameter that is followed by anything but another optional parameter (`/users/:id?/posts`, `/a/:b?/*`), a `?` anywhere else in a parameter's segment (`/users/:id?.json`) and a wildcard that is not the last segment (`/files/*/meta`) throw when the route is registered, naming the route. Register a route for each shape instead:

```typescript
app.get('/users/posts', listAllPosts);
app.get('/users/:id/posts', listUserPosts);
```

**Regex parameters are not supported** (`/users/:id(\d+)`, `/tags/:name+`): those characters are part of the parameter's name. A route with parameters whose path contains `+`, `(`, `)`, `[`, `]`, `{`, `}`, `|`, `^`, `$` or `\`, or a `*` or `?` that is neither of the forms above (`/proxy/:name/.*`, `/q/:a/b?x`), keeps answering what it answered before and logs one warning when it is registered: in the fixed text of such a path those characters are not matched the same way by the Node.js server and the native engine, so the route should be replaced. A path without parameters is matched as its own text (`/c++` is the URL `/c++`, and a dot is always a dot: `/v1.0/users/:id` does not answer `/v1x0/users/7`); it logs a warning when it contains a `*` that is not a wildcard (`/files/**`) or a `?` (`/search?debug`: a route path is matched against the request path, which never includes the query string). To require a shape of a parameter, validate it. A value that does not pass is answered 400; the request is not offered to another route:

```typescript
app
  .get('/orders/:id')
  .params(z.object({ id: z.string().regex(/^\d+$/) }))
  .handler(getOrder);
```

Validation, rate limiting (one counter for the route, whichever path reached it), `auth`, caching and route middleware apply to a route with an optional parameter or a wildcard as to any other, and `app.use('/files', fn)` runs in front of `/files/*`. In the OpenAPI document a route with optional parameters is listed under each path it answers (`/posts` and `/posts/{id}`), and a wildcard as a path parameter in the last place (`/files/{wildcard}`, or the name it was given).

A request path is matched as it was sent, case-sensitively, and `req.path` always holds it exactly as it was sent.

- A route with parameters also answers its URL with one trailing slash (`/users/7/`). Whether a route without parameters does depends on the server: the Node servers route `/users/` to `/users`, the native engine answers `404`.
- A path with an empty segment (`//admin/users/7`, `/admin//users/7`, `/admin/users/7//`) matches no route and is answered `404`.
- A request target with no leading slash (`admin/users/7`) is refused with `400` (a stream error on HTTP/2).
- A request target that is a whole URL (`GET http://example.com/users/7 HTTP/1.1`, the form a client sends to a proxy) is routed by its path on the native engine: `req.path` is `/users/7`, and `req.headers.host` and `req.hostname` are the host of that URL, whatever the `Host` header said (RFC 9112, section 3.2.2). The Node.js HTTP/1 server keeps the target as it was sent, which matches no route (`404`).

So a check on the path in middleware, such as `req.path.startsWith('/admin')` or `app.use('/admin', fn)`, sees every request that the routes under `/admin` can receive.

#### Request bodies

`req.body` is parsed before the handler runs, by Content-Type, identically on the Node and native-engine servers:

| Content-Type                                                                               | `req.body`                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `application/json`                                                                         | parsed value (`null` for an empty body)     |
| `application/x-www-form-urlencoded`                                                        | `{ field: value }`                          |
| `multipart/form-data`                                                                      | `{ fields, files }` (file data as `Buffer`) |
| `text/*`, JSON/XML/JavaScript/YAML families, anything with a `charset`, or no Content-Type | `string` (UTF-8)                            |
| anything else (`application/octet-stream`, `image/*`, `application/pdf`, protobuf, ...)    | `Buffer` with the exact bytes               |

Bodies above `server.bodySizeLimit` (10 MB by default; `server.maxUploadSize` for multipart) are rejected with 413 before parsing.

A urlencoded body is also held to a number of fields: `server.limits.form.maxFields`, 1000 by default (`MORO_FORM_MAX_FIELDS` in the environment). The fields are the segments between `&` separators, counted before anything is decoded, so an empty segment (`a=1&&b=2`, a trailing `&`) counts and a name sent five times is five fields. A body with more is answered `413` and its handler does not run, on the native engine, the Node.js server and the HTTP/2 server alike, as is a multipart body with more parts than `server.limits.multipart.maxParts` (1000). The serverless runtimes do not apply the cap: on Cloudflare Workers a form is parsed into an object without it, and on AWS Lambda and Vercel Edge it reaches the handler as a string (see [Runtimes](./RUNTIME.md)).

A body refused for one of these limits, or one that cannot be parsed, never reaches global middleware, error middleware or the route, on any server. Whether `app.setErrorHandler()` is called for it, and whether the `error` hooks run, differs between the servers:

| The request body                                                                                               | Native engine                                                                                                                                                                                                 | Node.js server and HTTP/2 server (`engine: 'node'`)                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| over its size limit (`bodySizeLimit`, or `maxUploadSize` for multipart), a multipart limit or `form.maxFields` | `app.setErrorHandler()` is called with the error (`statusCode` 413) and may answer it; left unanswered, `413` with `{ "success": false, "error": "Request entity too large" }`. The `error` hooks do not run. | The `error` hooks run with the error, and the answer is `413` with `{ "success": false, "error": "Request entity too large" }`; `app.setErrorHandler()` is not called. |
| larger than both `bodySizeLimit` and `maxUploadSize`                                                           | `413` from the engine itself, with an empty body (and `Connection: close` on HTTP/1.1). Neither the error handler nor the hooks see it.                                                                       | As in the row above.                                                                                                                                                   |
| cannot be parsed (`400`)                                                                                       | `app.setErrorHandler()` is called; the `error` hooks do not run.                                                                                                                                              | The `error` hooks run, then `app.setErrorHandler()` is called.                                                                                                         |

An error handler that does not answer a `413` leaves it to the default answer, which is the same on every server; one that answers every error with its own status replaces these `413`s on the native engine only.

```typescript
app.post('/upload/raw').handler((req, res) => {
  const bytes: Buffer = req.body; // Content-Type: application/octet-stream
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(bytes);
});
```

`req.rawBody` is the body exactly as it arrived, before any parsing, or `null` when there was none. It is what webhook signature checks need (an HMAC over the wire bytes of a JSON payload) and is available on every backend, bounded by the same size limits:

```typescript
app.post('/webhooks/stripe').handler(req => {
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody!).digest('hex');
  if (expected !== req.headers['x-signature']) throw new Error('bad signature');
  return handle(req.body); // still parsed JSON
});
```

For code written in the Express idiom, `json()`, `urlencoded()`, `raw({ type })` and `text({ type })` are exported and behave as pass-throughs that convert `req.body` to the shape that parser would have produced for the matching content types.

Each takes a `limit` (a number of bytes, or a string such as `'100kb'` or `'1mb'`). A body of a type that parser handles and larger than its limit is answered `413` with `{ "success": false, "error": "Request entity too large" }`, the answer the server-level limit gives. The body has already been read under `server.bodySizeLimit` by then, so the parser limit can only be the smaller of the two; set `server.bodySizeLimit` to bound what the server reads. Without `limit`, the parsers limit nothing.

```typescript
import { json, urlencoded } from '@morojs/moro';

app.use(json({ limit: '100kb' })); // JSON bodies over 100 KB -> 413
app.use(urlencoded({ limit: '20kb' })); // form bodies over 20 KB -> 413
```

#### Client address, protocol and host

| Property                   | Value                                                                            |
| -------------------------- | -------------------------------------------------------------------------------- |
| `req.ip`                   | The client's address                                                             |
| `req.ips`                  | The addresses in `X-Forwarded-For`, client first                                 |
| `req.protocol`             | `'http'` or `'https'`                                                            |
| `req.secure`               | `req.protocol === 'https'`                                                       |
| `req.hostname`             | The host the request was sent to, without the port                               |
| `req.socket.remoteAddress` | The address of the peer the connection comes from (the proxy, when there is one) |

Behind a reverse proxy the connection comes from the proxy, which reports the client in `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`. Whether those headers are believed is decided by [`server.trustProxy`](./CONFIGURATION_REFERENCE.md#behind-a-proxy), identically on the Node.js, HTTP/2 and native-engine servers:

- **`trustProxy` names the proxy** (`1`, `'10.0.0.0/8'`, `'loopback'`, a list, `true`): `req.ip` is the client as the trusted proxies report it, `req.ips` is the client followed by those proxies, `req.protocol` / `req.secure` follow `X-Forwarded-Proto` and `req.hostname` follows `X-Forwarded-Host`. A request that does not come from a trusted proxy gets the values of the next case.
- **`trustProxy: false`**: the headers are ignored. `req.ip` is the connected peer, `req.ips` is `[]`, `req.protocol` says whether this connection is TLS and `req.hostname` comes from `Host`.
- **`trustProxy` not set** (the default, unchanged from earlier releases): `req.ip` is the connected peer and `req.hostname` comes from `Host`, but `req.ips`, `req.protocol` and `req.secure` read `X-Forwarded-For` and `X-Forwarded-Proto` from whoever sent them. Set `trustProxy` before relying on any of the three.

```typescript
const app = await createApp({ server: { trustProxy: 1 } }); // one proxy in front of the app

app.get('/whoami', req => ({ ip: req.ip, https: req.secure, host: req.hostname }));
```

### Schema-First Routes

#### app.route(schema)

Define a route using a schema-first approach.

```typescript
app.route({
  method: 'POST',
  path: '/users',
  validation: {
    body: z.object({
      name: z.string().min(2).max(50),
      email: z.string().email(),
    }),
    query: z.object({
      notify: z.coerce.boolean().default(true),
    }),
  },
  rateLimit: { requests: 10, window: 60000 },
  cache: { ttl: 300 },
  description: 'Create a new user',
  tags: ['users', 'create'],
  handler: async (req, res) => {
    const user = await createUser(req.body);
    return { success: true, data: user };
  },
});
```

**Schema Properties:**

- `method` (HttpMethod): HTTP method
- `path` (string): Route path
- `validation` (ValidationConfig): Request validation
- `rateLimit` (RateLimitConfig): Rate limiting config
- `cache` (CacheConfig): Caching config
- `auth` (AuthConfig): Authentication config
- `middleware` (Middleware[]): Custom middleware
- `description` (string): Route description for docs
- `tags` (string[]): Tags for documentation
- `handler` (RouteHandler): Route handler function

### Module Management

#### app.loadModule(module)

Load a module into the application.

```typescript
import UsersModule from './modules/users';

await app.loadModule(UsersModule);

// Or load from path
await app.loadModule('./modules/users');
```

### Database Integration

#### app.database(adapter)

Register a database adapter.

```typescript
import { MySQLAdapter } from '@morojs/moro';

const db = new MySQLAdapter({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'myapp',
});

app.database(db);
```

### WebSocket Support

#### app.websocket(namespace, handlers)

Register WebSocket handlers. WebSockets are opt-in: create the app with a `websocket` option (`createApp({ websocket: { enabled: true } })` is enough), otherwise `listen()` fails with `WebSocket features require a WebSocket adapter.`

```typescript
app.websocket('/chat', {
  message: (socket, data) => {
    socket.broadcast.emit('message', data);
    return { success: true };
  },
  join: (socket, data) => {
    const { room } = z.object({ room: z.string() }).parse(data);
    socket.join(room);
    return { joined: room };
  },
});
```

A handler's return value is the reply. When a handler throws (or its promise rejects), the server logs the error, emits it on the app as `websocket:error` (`app.on('websocket:error', ({ namespace, event, error }) => ...)`), and answers the client with `{ success: false, error }`: as the reply when the message asked for one (it carried a callback id), otherwise as an `error` event, on every adapter (`{ "event": "error", "data": { "success": false, "error": "..." } }` on the native engine and the `ws` adapter, an `error` event on Socket.IO). Outside production `error` is the thrown error's message. With `NODE_ENV=production` it is always `'Internal server error'`, so a driver message, a file path or a query never reaches a client: to tell a client what was wrong with its message, return that answer from the handler instead of throwing. A raw namespace (`{ raw: true }`) sends no error frame at all.

### Middleware

#### app.use(middleware, config?)

Add global middleware.

```typescript
// Standard middleware
app.use((req, res, next) => {
  req.timestamp = Date.now();
  next();
});

// Async middleware
app.use(async (req, res, next) => {
  req.user = await authenticateUser(req);
  next();
});

// Function-style middleware
app.use(async app => {
  app.addGlobalValidator(customValidator);
});
```

#### app.use(prefix, middleware)

Run a `(req, res, next)` middleware (or an `(err, req, res, next)` error middleware) only for the requests at or under a path prefix.

```typescript
app.use('/admin', (req, res, next) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});
```

- The prefix matches whole path segments: `/admin` covers `/admin`, `/admin/` and `/admin/users/7`, and not `/administrator`. It is compared with `req.path` as the request arrived, case-sensitively, like route paths. `/` covers every path.
- The request is passed on unchanged. Unlike Express, the prefix is **not** removed from `req.url` or `req.path` inside the middleware, and there is no `req.baseUrl`.
- It runs in the global chain, in registration order with the other `app.use()` middleware, for routes registered on the app and module routes alike.
- `app.use(prefix, router)` mounts a `createRouter()` instance at the prefix.
- A built-in that is a `(req, res, next)` function (`helmet`, `compression`, `bodySize`, `staticFiles`, ...) can be mounted the same way. Because the prefix is not removed, `app.use('/cdn', middleware.staticFiles({ root: './public' }))` serves `./public/cdn/app.css` at `/cdn/app.css`; to serve `./public/app.css` there, pass the prefix in its options instead: `middleware.staticFiles({ root: './public', prefix: '/cdn' })`. A hook-based built-in (`rateLimit`, `cors`, `cache`, `csrf`, ...) installs for every request and is refused at a prefix: scope those on the routes themselves.

#### What app.use() refuses

`app.use()` takes a function with three parameters (middleware), four (error middleware) or at most one (a plugin, called once with the app), a middleware object from the `middleware` namespace, or a `createRouter()` instance. Anything else cannot be registered and the call rejects with an error that says what it was given: a function that declares two parameters (for example `(req, res) => ...`, or `(req, res, next = noop)`, which counts as two), a plain options object, `null`, an array, or a prefix followed by anything other than a middleware function or a router. `await` the call, or let the rejection stop start-up; nothing is registered for a refused argument.

### Server

#### app.listen(port, callback?)

#### app.listen(port, host, callback?)

Start the HTTP server.

```typescript
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Server running on all interfaces');
});
```

`app.listen(0)` binds any free port, which is what a test wants; read the port from `app.address()`. It is refused when `performance.clustering` is enabled, because every worker would be given a different port. A second `listen()` on an app that is already listening is ignored with a warning.

#### app.address()

The address the HTTP server is bound to, in the shape of Node's `server.address()` (`{ address, family, port }`), or `null` while the app is not listening: before the listen callback, after `close()`, and in the primary of a cluster, where the workers hold the port.

```typescript
app.listen(0, () => {
  const bound = app.address();
  if (bound) console.log(`Listening on port ${bound.port}`);
});
```

#### app.close()

Stops the app and resolves when it has stopped. `onClose` hooks run first, then cluster workers (if any) are closed, then the job scheduler, the gRPC server and the HTTP server, then queues and mail. Requests in flight get 2 seconds to finish before their connections are closed; cluster workers get 3 seconds before the primary ends them. SIGINT and SIGTERM call it for you (`server.gracefulShutdown`).

```typescript
app.onClose(async () => {
  console.log('closing');
});

await app.close();
```

#### app.reloadTLS(ssl?)

Rotate the TLS certificate and key on the running listener without a restart. With no argument the `server.ssl` key/cert files are re-read; with one, the given material (either `ssl` shape) replaces them. The new pair is validated first (file readable, PEM parses, key matches certificate), so a bad or half-written file rejects and the current certificate keeps serving. Connections that already handshaked are untouched. Works on the native engine (`@morojs/engine` 1.1.8+), the Node https server and HTTP/2.

```typescript
await app.reloadTLS(); // re-read server.ssl.keyFile / certFile
await app.reloadTLS({ keyFile: '/etc/tls/new.key', certFile: '/etc/tls/new.crt' });
```

`server.ssl.watch: true` does this automatically when the files change on disk (the directory is watched, so an ACME client's rename or a Kubernetes secret's symlink swap is caught; changes are debounced and unchanged bytes ignored). With clustering, each worker watches and reloads its own listener.

### Documentation

#### app.enableDocs(config)

Enable automatic API documentation: an OpenAPI 3.0.3 document generated from the app's routes, served with Swagger UI. Requires the optional `swagger-ui-dist` package (`npm install swagger-ui-dist`); `enableDocs()` throws when it is not installed.

```typescript
app.enableDocs({
  basePath: '/docs',
  title: 'My API',
  version: '1.0.0',
  description: 'API documentation',
  contact: {
    name: 'API Support',
    email: 'support@example.com',
  },
});
```

The page is served at `basePath` (default `/docs`) and the document at `<basePath>/openapi.json`. The docs middleware answers only those two paths and the Swagger UI files it serves (`swagger-ui.css`, `swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`, the two favicons, `oauth2-redirect.html` and `oauth2-redirect.js`); every other path under `basePath`, such as an application route `GET /docs/guide`, reaches the application.

`enableDocs()` can be called before or after the routes are declared. The document follows the route list: routes declared later, and routes loaded from files while the server starts, are in it the next time it is asked for. It is generated again only when the route list has changed, not on every request.

| Option            | Default          | Effect                                                                                                                                                                                                                                                                                      |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | required         | `info.title`                                                                                                                                                                                                                                                                                |
| `version`         | required         | `info.version`                                                                                                                                                                                                                                                                              |
| `description`     | none             | `info.description`                                                                                                                                                                                                                                                                          |
| `basePath`        | `'/docs'`        | Where the page and `openapi.json` are served                                                                                                                                                                                                                                                |
| `servers`         | `[{ url: '/' }]` | The `servers` list. The default is relative, so "Try it out" calls the host and port the page was loaded from; a configured list is written as given                                                                                                                                        |
| `contact`         | none             | `info.contact`                                                                                                                                                                                                                                                                              |
| `license`         | none             | `info.license`                                                                                                                                                                                                                                                                              |
| `includeExamples` | `true`           | Write example values for parameters and request bodies                                                                                                                                                                                                                                      |
| `includeSchemas`  | `true`           | Write the validation schemas of request bodies and parameters. With `false` a body is documented as a plain object and a parameter by its name and location only                                                                                                                            |
| `enableAuth`      | `true`           | Document authentication. A route with `.auth()` carries a security requirement and the document declares the scheme it names (`bearerAuth`, an HTTP bearer scheme). With `false` neither is written                                                                                         |
| `swaggerUI`       | see below        | `title`, `favicon`, `customCss`, the flags `enableTryItOut`, `enableFilter` and `enableDeepLinking` (default `true`), and `swaggerOptions`: further [Swagger UI configuration](https://swagger.io/docs/open-source-tools/swagger-ui/usage/configuration/) passed to the page as JSON values |

```typescript
app.enableDocs({
  title: 'My API',
  version: '1.0.0',
  servers: [{ url: 'https://api.example.com', description: 'Production' }],
  swaggerUI: {
    title: 'My API - Reference',
    swaggerOptions: { docExpansion: 'none', persistAuthorization: true },
  },
});
```

`swaggerOptions` holds JSON values only (functions cannot be passed). The settings the page makes itself keep their own options: the document URL, presets, plugins, and `enableTryItOut` / `enableFilter` / `enableDeepLinking`. `swaggerOptions.layout` replaces the default `'StandaloneLayout'`.

`swaggerUI.customCss` is CSS text added to the page's own `<style>` element; whatever it contains stays inside that element. `swaggerUI.customJs` is accepted and not applied: the page runs no script but Swagger UI's and its own start-up script, and a warning is logged when the option is set. Configure Swagger UI through `swaggerOptions` instead.

The page is served with this `Content-Security-Policy`:

```text
default-src 'self'; script-src 'self' 'sha256-<digest of the page's start-up script>';
style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:;
connect-src 'self'; object-src 'none'; base-uri 'self'
```

Scripts run from the app's own origin only, plus the one inline start-up script, which the policy names by its SHA-256 digest; there is no `'unsafe-inline'` or `'unsafe-eval'` for scripts. Inline styles stay allowed because Swagger UI adds `<style>` elements while it runs. `connect-src 'self'` means "Try it out" can call the origin the page was loaded from.

What a route contributes to the document:

- `.describe()` and `.tag()` become the operation's summary, description and tags.
- Every `:name` in the path becomes a required path parameter, typed by the `.params()` schema when there is one and as a string otherwise. `.query()` and `.headers()` schemas become query and header parameters; `.body()` becomes the JSON request body of a `POST`, `PUT` or `PATCH`.
- `.auth()` adds the security requirement and `401` / `403` responses. The roles and permissions the route asks for are named in the `403` response description. With `auth: { optional: true }` the requirement also allows a request without credentials.
- `.rateLimit()` adds a `429` response.

Schemas are converted from Zod 3 and Zod 4 schemas, and from Joi and Yup schemas passed through the `joi()` and `yup()` adapters. A validator that cannot be read (a custom function, `classValidator()`) is documented as accepting any value. Types with no JSON Schema form (`z.map()`, `z.custom()`, the output of a transform) are documented the same way.

#### app.getOpenAPISpec()

Get the OpenAPI specification as an object, generated from the routes the app has now.

```typescript
const spec = app.getOpenAPISpec();
```

#### app.getDocsJSON()

Get documentation as JSON string.

#### app.getDocsYAML()

Get documentation as YAML string. It is the same document as `getDocsJSON()`: parsing either gives the same value.

#### app.refreshDocs()

Generate the document again from the current routes. The getters above and the served `openapi.json` already do this when a route has been added, so it is only needed after changing the metadata of a route that is already registered.

---

## Intelligent Routing

### RouteBuilder

The RouteBuilder provides a chainable API for defining routes with automatic middleware ordering.

#### Execution Phases

Route features execute in this fixed order, whatever order you chain them in:

1. **SECURITY** - CORS, Helmet, CSRF protection (global middleware)
2. **PARSING** - Body parsing, query parsing (global middleware)
3. **BEFORE** - `.before()` custom middleware
4. **RATE_LIMITING** - `.rateLimit()`, before auth so floods are shed early
5. **AUTHENTICATION** - `.auth()`
6. **VALIDATION** - `.body()` / `.query()` / `.params()` / `.headers()` / `.validate()`
7. **TRANSFORM** - `.transform()` custom middleware
8. **AFTER** - `.after()` custom middleware (`.use()` is an alias), and the `middleware` array of the direct form
9. **CACHING** - `.cache()` lookup; a hit responds here and skips the handler
10. **HANDLER** - `.handler()`, terminal and always chained last

The cache is looked up last: every guard the route declares, in any of the phases above, has let the request through before a stored response is served. Middleware in `.after()` / `.use()` therefore runs on cache hits too.

#### Literal Handlers

`.handler()` also takes the response body itself, a string or a Buffer, in
place of a function. The route answers with exactly that body, as
`res.send(body)` would: status 200 and the content-type `send()` implies
(`text/plain`, `application/json` for a JSON-looking string,
`application/octet-stream` for a Buffer). An empty body goes out as
`res.end()` would - `Content-Length: 0` and no content-type, since there is
nothing for one to describe.

It also takes `param(name)`: the route answers with that path parameter as
the body, declared as `text/plain; charset=utf-8` on every server, so a
reflected segment is never read as markup.

```typescript
import { createApp, param } from '@morojs/moro';

app.get('/user/:id').handler(param('id')); // GET /user/42 -> "42"
app.get('/users/:id/name', param('id')); // GET /users/42/name -> "42"
```

The parameter must be a whole segment of the path, as the router names
parameters after their segment (`/files/:name.json` is a parameter called
`name.json`, and `param('name')` on it throws at registration).

On Moro's native engine (`@morojs/engine` >= 1.1.9) a bare route with exactly
that one parameter is answered inside the engine, no JS per request, with the
segment as it is on the wire (undecoded), declared as
`text/plain; charset=utf-8`. A parameter that needs decoding, a route with two
parameters, any configured middleware, or an app with global middleware or
request hooks (see below) keeps the handler in JS, where `req.params` is what
the router produced.

```typescript
app.get('/health').handler('ok');
app.get('/').handler(''); // 200, empty body
app.get('/version').handler('{"version":"1.8"}'); // application/json
app.get('/ping', 'pong'); // the two-argument form takes a body too
app.route({ method: 'GET', path: '/ready', handler: 'ready' }); // and the schema form
```

When the route has nothing else configured - no `.auth()`, `.rateLimit()`,
`.cache()`, validation or custom middleware, and a literal path - Moro's
native engine (`@morojs/engine` >= 1.1.6) answers it itself: no call into JS,
no routing and no header building per request. With any of those configured,
or on the Node and HTTP/2 servers, an equivalent handler sends
the same bytes after that configuration has run. HEAD against a literal GET
still reaches the router, which answers it from that route (see below). Routes registered
after `listen()` keep working through the handler until the next `listen()`.

The engine answers a literal or `param()` route itself only while the app has
nothing a request must pass first. Once the app has global middleware
(`app.use()`, or the config-driven kind: helmet, CORS, compression, request
logging, the documentation routes) or a `request` / `response` hook, these
routes are dispatched like every other one: the hooks and the middleware run,
then the route's handler sends the reply. It makes no difference when the
middleware or hook is registered, before or after the route, before or after
`listen()`; if the last such hook is removed again, the engine answers again.
Request logging is on by default outside production, so in development these
routes run in JS (a `param()` reply is then the decoded value); set
`server.requestLogging.enabled: false` to see the production behaviour.

#### Validation Methods

```typescript
app
  .post('/users')
  // Body validation
  .body(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
    })
  )
  // Query parameter validation
  .query(
    z.object({
      notify: z.coerce.boolean().default(true),
    })
  )
  // Path parameter validation
  .params(
    z.object({
      id: z.string().uuid(),
    })
  )
  // Header validation
  .headers(
    z.object({
      'x-api-key': z.string(),
    })
  )
  // Combined validation
  .validate({
    body: UserSchema,
    query: QuerySchema,
    params: ParamsSchema,
  });
```

#### Security Methods

```typescript
app
  .get('/admin')
  // Authentication
  .auth({
    roles: ['admin'],
    permissions: ['users:read'],
  })
  // Rate limiting
  .rateLimit({
    requests: 100,
    window: 60000, // 1 minute
    skipSuccessfulRequests: false,
    skipFailedRequests: true,
  });
```

`auth` takes `roles`, `permissions`, `optional`, `required` and `validator`, in every registration form (builder, direct form, `app.route()`, module routes):

```typescript
app
  .get('/users/:id/orders')
  .auth({
    required: true,
    // Users see their own orders; admins see anyone's
    validator: req => req.auth.user.id === req.params.id || req.auth.user.roles.includes('admin'),
  })
  .handler(req => getUserOrders(req.params.id));
```

- `validator(req)` is called with the request once the sign-in, role and permission checks have passed. It may return a promise. A falsy result, a rejection or a throw denies the request, and the handler does not run.
- A denial is a `403`. It is a `401` when the request has no authenticated user and the route sets `required: true`.
- Sign-in is required unless `optional: true`, so `required: true` changes nothing without a validator. `required: false` does **not** make sign-in optional (a warning says so when the route is registered): use `optional: true`.
- With no auth middleware installed (no `req.auth`), a route whose `auth` has only a validator (no `roles` or `permissions`) is checked by the validator alone, for example against an API key header.
- The validator runs in the auth phase, before validation, the cache and the handler. An `auth` key other than these five is not applied and is named in a warning at registration; a `validator` that is not a function is an error.

#### Caching

```typescript
app.get('/data').cache({
  ttl: 300, // 5 minutes (kept in process memory)
  key: req => `data:${req.query.id}`,
  tags: ['data', 'public'],
});
```

#### Custom Middleware

```typescript
app
  .get('/custom')
  // Before handler middleware
  .before(logRequest, validateApiKey, enrichRequest)
  // After handler middleware
  .after(logResponse, cleanupResources);
```

#### Handler

```typescript
app
  .post('/users')
  .body(UserSchema)
  .handler(async (req, res) => {
    // req.body is fully typed and validated
    const user = await createUser(req.body);
    return { success: true, data: user };
  });
```

### Intelligent Routing Examples

#### Complex Route with Full Middleware Chain

```typescript
app
  .post('/api/orders')
  .body(
    z.object({
      userId: z.string().uuid(),
      items: z
        .array(
          z.object({
            productId: z.string().uuid(),
            quantity: z.number().min(1),
            price: z.number().positive(),
          })
        )
        .min(1),
      shippingAddress: z.object({
        street: z.string().min(1),
        city: z.string().min(1),
        zipCode: z.string().regex(/^\d{5}$/),
      }),
    })
  )
  .auth({
    roles: ['customer'],
    permissions: ['orders:create'],
  })
  .rateLimit({
    requests: 5,
    window: 60000,
  })
  .before(validateInventory, calculateTotals, checkPaymentMethod)
  .after(sendOrderConfirmation, updateInventory, triggerFulfillment)
  .describe('Create a new order with full validation and processing')
  .tag('orders', 'create', 'ecommerce')
  .handler(async (req, res) => {
    const order = await createOrder({
      ...req.body,
      userId: req.auth.user.id,
      status: 'pending',
      createdAt: new Date(),
    });

    app.events.emit('order:created', {
      order,
      user: req.auth.user,
      timestamp: new Date(),
    });

    return {
      success: true,
      data: order,
      message: 'Order created successfully',
    };
  });
```

#### Schema-First Approach

```typescript
app.route({
  method: 'GET',
  path: '/api/users/:id/orders',
  validation: {
    params: z.object({
      id: z.string().uuid('Invalid user ID format'),
    }),
    query: z.object({
      status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'cancelled']).optional(),
      limit: z.coerce.number().min(1).max(100).default(20),
      offset: z.coerce.number().min(0).default(0),
      sortBy: z.enum(['createdAt', 'total', 'status']).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    }),
  },
  auth: {
    required: true,
    // Users can only see their own orders, admins can see any. The validator
    // runs in the auth phase, so it has decided before the cache is looked up.
    validator: req => req.auth.user.id === req.params.id || req.auth.user.roles.includes('admin'),
  },
  cache: {
    ttl: 60, // 1 minute cache
    key: req => `user-orders:${req.params.id}:${JSON.stringify(req.query)}`,
    tags: ['user-data', 'orders'],
  },
  rateLimit: {
    requests: 100,
    window: 60000,
  },
  description: 'Get paginated orders for a specific user',
  tags: ['users', 'orders', 'pagination'],
  handler: async (req, res) => {
    const orders = await getUserOrders(req.params.id, {
      status: req.query.status,
      limit: req.query.limit,
      offset: req.query.offset,
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
    });

    const total = await getUserOrdersCount(req.params.id, {
      status: req.query.status,
    });

    return {
      success: true,
      data: orders,
      pagination: {
        limit: req.query.limit,
        offset: req.query.offset,
        total,
        hasMore: req.query.offset + req.query.limit < total,
      },
    };
  },
});
```

---

## Module System

### defineModule(definition)

Create a module definition.

```typescript
import { defineModule, z } from '@morojs/moro';

export default defineModule({
  name: 'users',
  version: '1.0.0',
  dependencies: ['auth@1.0.0'],
  config: {
    database: { table: 'users' },
    features: { pagination: true },
  },
  routes: [
    {
      method: 'GET',
      path: '/users',
      validation: {
        query: z.object({
          limit: z.coerce.number().min(1).max(100).default(10),
          search: z.string().optional(),
        }),
      },
      handler: async (req, res) => {
        return { users: await getUsers(req.query) };
      },
    },
  ],
  sockets: [
    {
      event: 'user-status',
      validation: z.object({
        userId: z.string().uuid(),
        status: z.enum(['online', 'offline']),
      }),
      handler: async (socket, data) => {
        socket.broadcast.emit('user-status-changed', data);
        return { success: true };
      },
    },
  ],
});
```

**Module Definition Properties:**

- `name` (string): Module name
- `version` (string): Module version
- `dependencies` (string[]): Module dependencies
- `config` (object): Module configuration
- `routes` (ModuleRoute[]): HTTP routes
- `sockets` (ModuleSocket[]): WebSocket handlers

### ModuleRoute

```typescript
interface ModuleRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: RouteHandler;
  validation?: ValidationConfig;
  onValidationError?: ValidationErrorHandler;
  auth?: AuthConfig; // roles, permissions, optional, required, validator
  middleware?: Middleware[]; // functions, or names of built-ins
  rateLimit?: RateLimitConfig; // { requests, window }
  cache?: CacheConfig; // { ttl, key?, shared? }
}
```

A module route runs, in this order: the module's `middleware`, the route's `middleware`, `rateLimit`, `auth` (sign-in, roles, permissions, then `validator`), `validation`, `cache`, the handler. `rateLimit` and `cache` behave as they do on a route registered on the app: the limit is per client and answers `429` with `Retry-After`; the cache stores the handler's JSON reply for `GET` requests, keeps a separate entry per host name and per signed-in user unless `shared: true` (a shared entry is one entry for every caller, under every host name; give the route a `key` that includes `req.hostname` when the response differs by host), and serves a hit only to a request that passed everything before it.

### ModuleSocket

```typescript
interface ModuleSocket {
  event: string;
  handler: SocketHandler;
  validation?: ZodSchema;
  rateLimit?: RateLimitConfig;
  rooms?: string[];
  broadcast?: boolean;
}
```

### Enterprise Module Example

```typescript
// modules/orders/index.ts
import { defineModule, z } from '@morojs/moro';
import {
  createOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder,
} from './services/OrderService';

const OrderSchema = z.object({
  userId: z.string().uuid(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().min(1),
        price: z.number().positive(),
      })
    )
    .min(1),
  shippingAddress: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    zipCode: z.string().regex(/^\d{5}$/),
  }),
  paymentMethodId: z.string().uuid(),
});

const OrderUpdateSchema = z.object({
  status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'cancelled']),
  trackingNumber: z.string().optional(),
  estimatedDelivery: z.string().datetime().optional(),
});

export default defineModule({
  name: 'orders',
  version: '2.1.0',
  dependencies: ['users@1.0.0', 'payments@1.5.0', 'inventory@2.0.0'],
  config: {
    database: {
      table: 'orders',
      indexes: ['userId', 'status', 'createdAt'],
    },
    features: {
      realTimeTracking: true,
      automaticInventoryUpdate: true,
      emailNotifications: true,
    },
    limits: {
      maxItemsPerOrder: 50,
      maxOrdersPerUser: 10,
    },
  },
  routes: [
    // Create Order
    {
      method: 'POST',
      path: '/orders',
      validation: { body: OrderSchema },
      auth: {
        roles: ['customer'],
      },
      handler: async (req, res) => {
        const order = await createOrder({
          ...req.body,
          userId: req.auth.user.id,
        });

        // Emit module-scoped event
        req.events.emit('order:created', {
          order,
          user: req.auth.user,
        });

        return {
          success: true,
          data: order,
          message: 'Order created successfully',
        };
      },
    },

    // Get Orders
    {
      method: 'GET',
      path: '/orders',
      validation: {
        query: z.object({
          status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'cancelled']).optional(),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
          sortBy: z.enum(['createdAt', 'total', 'status']).default('createdAt'),
          sortOrder: z.enum(['asc', 'desc']).default('desc'),
        }),
      },
      auth: {},
      handler: async (req, res) => {
        const orders = await getOrders(req.auth.user.id, req.query);
        return { success: true, data: orders };
      },
    },

    // Get Order by ID
    {
      method: 'GET',
      path: '/orders/:id',
      validation: {
        params: z.object({
          id: z.string().uuid(),
        }),
      },
      auth: {},
      handler: async (req, res) => {
        const order = await getOrderById(req.params.id);

        if (!order) {
          return res.status(404).json({
            success: false,
            error: 'Order not found',
          });
        }

        // Owners and admins only
        if (order.userId !== req.auth.user.id && !req.auth.user.roles.includes('admin')) {
          return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        return { success: true, data: order };
      },
    },

    // Update Order Status (Admin only)
    {
      method: 'PUT',
      path: '/orders/:id/status',
      validation: {
        params: z.object({ id: z.string().uuid() }),
        body: OrderUpdateSchema,
      },
      auth: {
        roles: ['admin', 'fulfillment'],
      },
      handler: async (req, res) => {
        const order = await updateOrderStatus(req.params.id, req.body);

        req.events.emit('order:status_updated', {
          order,
          updatedBy: req.auth.user,
          previousStatus: order.previousStatus,
          newStatus: req.body.status,
        });

        return { success: true, data: order };
      },
    },

    // Cancel Order
    {
      method: 'DELETE',
      path: '/orders/:id',
      validation: {
        params: z.object({ id: z.string().uuid() }),
      },
      auth: {},
      handler: async (req, res) => {
        // Owners may cancel a pending order; admins may cancel any
        const existing = await getOrderById(req.params.id);
        const mayCancel =
          (existing?.userId === req.auth.user.id && existing?.status === 'pending') ||
          req.auth.user.roles.includes('admin');
        if (!mayCancel) {
          return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const order = await cancelOrder(req.params.id, req.auth.user.id);

        req.events.emit('order:cancelled', {
          order,
          cancelledBy: req.auth.user,
          reason: 'user_cancelled',
        });

        return {
          success: true,
          message: 'Order cancelled successfully',
        };
      },
    },
  ],

  // WebSocket handlers for real-time order tracking
  sockets: [
    {
      event: 'track-order',
      validation: z.object({
        orderId: z.string().uuid(),
      }),
      rateLimit: { requests: 20, window: 60000 },
      handler: async (socket, data) => {
        const order = await getOrderById(data.orderId);

        if (!order) {
          return { success: false, error: 'Order not found' };
        }

        // Join order-specific room for updates
        socket.join(`order-${data.orderId}`);

        return {
          success: true,
          data: order,
          message: 'Now tracking order updates',
        };
      },
    },

    {
      event: 'stop-tracking',
      validation: z.object({
        orderId: z.string().uuid(),
      }),
      handler: async (socket, data) => {
        socket.leave(`order-${data.orderId}`);
        return { success: true, message: 'Stopped tracking order' };
      },
    },
  ],
});
```

---

## Validation System

MoroJS uses Zod for runtime validation with full TypeScript integration.

### ValidationConfig

```typescript
interface ValidationConfig {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
  headers?: ZodSchema;
}
```

### Validation Functions

#### validate(config, handler)

Create a validation wrapper for handlers.

```typescript
import { validate, z } from '@morojs/moro';

const validateUser = validate(
  {
    body: z.object({
      name: z.string().min(2),
      email: z.string().email(),
    }),
  },
  async (req, res) => {
    // req.body is validated and typed
    return { user: req.body };
  }
);
```

#### Convenience Functions

```typescript
import { body, query, params } from '@morojs/moro';

// Body validation
const bodyValidator = body(UserSchema);

// Query validation
const queryValidator = query(QuerySchema);

// Params validation
const paramsValidator = params(ParamsSchema);
```

### Common Validation Patterns

#### User Input

```typescript
const UserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  age: z.number().min(18).max(120).optional(),
  tags: z.array(z.string()).max(10).default([]),
});
```

#### Query Parameters

```typescript
const PaginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  sort: z.enum(['name', 'date', 'priority']).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
```

#### Path Parameters

```typescript
const ParamsSchema = z.object({
  id: z.string().uuid(),
  category: z.enum(['users', 'posts', 'comments']),
});
```

#### Custom Validation

```typescript
const PasswordSchema = z
  .object({
    password: z.string().min(8),
    confirmPassword: z.string(),
  })
  .refine(data => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });
```

#### Advanced Validation Examples

```typescript
// Complex nested validation
const OrderSchema = z
  .object({
    customer: z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      phone: z
        .string()
        .regex(/^\+?[\d\s-()]+$/)
        .optional(),
    }),
    items: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantity: z.number().min(1).max(99),
          price: z.number().positive(),
          options: z.record(z.string(), z.unknown()).optional(),
        })
      )
      .min(1)
      .max(50),
    shipping: z.object({
      method: z.enum(['standard', 'express', 'overnight']),
      address: z.object({
        line1: z.string().min(1),
        line2: z.string().optional(),
        city: z.string().min(1),
        state: z.string().length(2),
        zipCode: z.string().regex(/^\d{5}(-\d{4})?$/),
        country: z.string().length(2).default('US'),
      }),
      instructions: z.string().max(500).optional(),
    }),
    payment: z.object({
      method: z.enum(['card', 'paypal', 'bank_transfer']),
      token: z.string().min(1),
    }),
  })
  .refine(
    data => {
      // Business rule: overnight shipping only for orders under $500
      const total = data.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      return data.shipping.method !== 'overnight' || total <= 500;
    },
    {
      message: 'Overnight shipping not available for orders over $500',
      path: ['shipping', 'method'],
    }
  );

// Conditional validation based on environment
const ConfigSchema = z.object({
  database: z.object({
    url:
      process.env.NODE_ENV === 'production'
        ? z.string().url().startsWith('postgres://')
        : z.string().min(1),
    ssl: z.boolean().default(process.env.NODE_ENV === 'production'),
    poolSize: z.number().min(1).max(50).default(10),
  }),
  redis: z
    .object({
      url: z.string().url().optional(),
      enabled: z.boolean().default(true),
    })
    .optional(),
  auth: z.object({
    jwtSecret: z.string().min(32),
    expiresIn: z.string().default('7d'),
    issuer: z.string().default('moro-app'),
  }),
});

// Transform and preprocess data
const UserRegistrationSchema = z.object({
  email: z
    .string()
    .email()
    .transform(email => email.toLowerCase()),
  name: z
    .string()
    .min(2)
    .transform(name => name.trim()),
  birthDate: z
    .string()
    .datetime()
    .transform(date => new Date(date)),
  preferences: z
    .object({
      newsletter: z.boolean().default(false),
      notifications: z.boolean().default(true),
      theme: z.enum(['light', 'dark']).default('light'),
    })
    .default({}),
});
```

---

## Middleware

### Built-in Middleware

MoroJS includes 18+ built-in middleware options. For complete documentation, see the [Middleware Guide](./MIDDLEWARE_GUIDE.md).

#### Security Middleware

**CORS** - Cross-origin resource sharing

MoroJS automatically handles OPTIONS preflight requests.

```typescript
// Static origins
app.use(
  middleware.cors({
    origin: ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    maxAge: 86400, // Cache preflight for 24 hours
  })
);

// Dynamic origin validation
app.use(
  middleware.cors({
    origin: async (requestOrigin, req) => {
      // Database lookup or custom logic
      const isAllowed = await checkOrigin(requestOrigin);
      return isAllowed ? requestOrigin : false;
    },
    credentials: true,
  })
);

// Disable automatic preflight handling
app.use(
  middleware.cors({
    origin: 'https://example.com',
    preflightContinue: true, // Handle OPTIONS manually
  })
);
```

**Helmet** - Security headers

```typescript
app.use(
  middleware.helmet({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  })
);
```

With no options helmet sends `Content-Security-Policy: default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`, `X-XSS-Protection: 0` (the legacy XSS filter switched off), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, HSTS, `Referrer-Policy`, `X-Download-Options` and `X-Permitted-Cross-Domain-Policies`. The 429 of the rate limiter and the 403 of the CORS and CSRF middleware carry the same headers. See the [Middleware Guide](./MIDDLEWARE_GUIDE.md#helmet-security-headers).

**CSRF** - CSRF protection

```typescript
app.use(
  middleware.csrf({
    secret: process.env.CSRF_SECRET, // from the environment; without one a random secret is generated per process
    cookieName: '_csrf',
    headerName: 'x-csrf-token',
  })
);
```

Tokens are signed with `secret` and, when `middleware.session()` is registered first, tied to the session they were issued in (ask for a new token after `req.session.regenerate()`). The token is read from the header or a `_csrf` body field; the query string is read only with `allowQueryToken: true`. Unsigned tokens issued by earlier versions are accepted for this release unless `legacyTokens: false`.

**CSP** - Content Security Policy

```typescript
app.use(
  middleware.csp({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
    },
    nonce: true, // a fresh nonce per response, added to script-src and style-src; also on req.cspNonce
  })
);
```

Exactly the directives given are sent. Without `directives` the default policy applies, which also names `base-uri 'self'`, `form-action 'self'` and `frame-ancestors 'self'`.

#### Performance Middleware

**Compression** - Response compression

```typescript
app.use(
  middleware.compression({
    level: 6, // 1-9: the gzip level, and the brotli quality it maps to
    threshold: 1024,
    encodings: ['br', 'gzip', 'deflate'], // server preference order
    gzip: { level: 3 }, // pin the gzip encoder; wins over `level`
    brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 3 } }, // pin brotli; wins over `level`
  })
);
```

The same options go under `performance.compression` in the app config, where they apply to
every response (`gzip`, `brotli` and `reuseEncoders` included). On the native engine the
middleware hands its settings to the response instead of wrapping `res.json`/`res.send`, so a
route-level `compression()` costs one property write per request; a `filter` keeps the
wrapping path.

**Cache** - Response caching

```typescript
app.use(
  middleware.cache({
    ttl: 300,
    strategy: 'memory', // 'memory' | 'redis' | 'file'
  })
);
```

A request that carries `Authorization`, a `Cookie` or a header named in `credentialHeaders` is neither served from the cache nor stored, unless the matching strategy has a `key` of its own. An entry belongs to a method, host, path and query; `varyBy: ['x-api-key']` adds one entry per value of a header that identifies the caller. With no `strategies` and no `varyBy`, one start-up log line says what will be stored and shared. See the [Middleware Guide](./MIDDLEWARE_GUIDE.md#cache).

**Rate Limiting** - Request rate limiting

```typescript
app.use(
  middleware.rateLimit({
    requests: 100,
    window: 60000,
    skipSuccessfulRequests: true,
  })
);
```

Each client (`req.ip`, or the result of `keyGenerator(req)`) has one counter per registered route: `/users/1` and `/users/2?x=1` both count against `/users/:id`.

#### HTTP Features

**Body Size Limiting**

```typescript
app.use(
  middleware.bodySize({
    limit: '10mb',
  })
);
```

**Cookie Parser**

```typescript
app.use(
  middleware.cookie({
    secret: process.env.COOKIE_SECRET, // from the environment, never a literal; required before any cookie can be signed
    signed: true, // sign every cookie by default
  })
);

// Verified signed cookies arrive separately from plain ones
app.get('/me', (req, res) => ({ theme: req.cookies.theme, user: req.signedCookies.user }));
```

`secret` may be an array for key rotation: cookies are signed with the first secret and verify against any of them. `res.cookie()` takes `maxAge` in milliseconds.

**Static Files** - Static file serving with caching

```typescript
app.use(
  middleware.staticFiles({
    root: './public',
    prefix: '/assets', // optional; defaults to the URL root
    maxAge: 3600, // seconds
    etag: true,
    lastModified: true, // If-Modified-Since -> 304
    acceptRanges: true, // Range -> 206 with Content-Range
    precompressed: true, // serve app.js.br / app.js.gz beside app.js when accepted
    cache: true, // files in memory, revalidated once a second and on directory changes
  })
);
```

**File Upload** - Multipart file uploads

```typescript
app
  .post('/upload')
  .before(
    middleware.upload({
      dest: './uploads', // stored when the handler reads `file.path` or calls `file.save()`
      maxFileSize: 10 * 1024 * 1024,
      allowedTypes: ['image/jpeg', 'image/png'],
      verifyContent: true, // the bytes must be a JPEG or a PNG, not only the declared type
    })
  )
  .handler(async (req, res) => {
    const file = req.files?.avatar;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    const stored = await file.save(); // writes the file; resolves to its path in ./uploads
    return { stored };
  });
```

Nothing is written before the handler asks for the file, so a request with no route, or one a guard refused, leaves nothing in `dest`; a file stored by a request that is then answered with a 4xx or 5xx is removed again (`cleanup: 'failed'`, the default; `'always'` and `'never'` are the other choices). See the [Middleware Guide](./MIDDLEWARE_GUIDE.md#file-upload).

**Template Rendering** - Template engine support

```typescript
app.use(
  middleware.template({
    views: './views', // res.render('index') reads ./views/index.html
    cache: true,
  })
);

app.get('/page', (req, res) => {
  res.render('index', { title: 'Welcome' });
});
```

**HTTP Range Requests** - Partial content for streaming

```typescript
// `root` confines sendRange() to a directory: "../", an absolute path or a
// symlink that leads outside it gets a 404. Route params arrive
// percent-decoded ("..%2F" is "../" in the handler), so set it whenever a
// path is built from one. Without `root`, the path is served as given.
// Hidden paths (a segment starting with a dot) get a 404 unless
// `dotfiles: 'allow'`; the response carries the file's Content-Type and
// X-Content-Type-Options: nosniff.
app.use(middleware.range({ root: './videos' }));

app.get('/video/:id', async (req, res) => {
  // 206 for a Range request, 416 for an unsatisfiable one, 404 if the file is missing
  await res.sendRange(`${req.params.id}.mp4`);
});

// Or per call, which overrides the middleware's root
app.get('/download/:file', async (req, res) => {
  await res.sendRange(`${req.params.file}`, { root: './files' });
});
```

**HTTP/2 Server Push** - Optimize with HTTP/2 push

```typescript
app.use(
  middleware.http2.push({
    autoDetect: true,
    resources: [{ path: '/styles/main.css', as: 'style', priority: 200 }],
  })
);
```

See [HTTP/2 Guide](./HTTP2_GUIDE.md) for detailed documentation.

#### Authentication & Sessions

**Authentication** - Bearer tokens, Better Auth sign-in and RBAC

```typescript
app.use(
  middleware.auth({
    providers: [
      providers.google({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      }),
    ],
  })
);

app
  .get('/api/profile')
  .auth({ roles: ['admin'] })
  .handler((req, res) => {
    return { user: req.auth.user };
  });
```

Two-factor authentication, organizations, anonymous users, session tokens as Bearer tokens, account linking and a rate limit on sign-in are turned on with a helper each. Every helper configures the Better Auth feature it is named after:

```typescript
import {
  middleware,
  twoFactor,
  organization,
  anonymous,
  bearerToken,
  accountLinking,
  rateLimit,
} from '@morojs/moro';
import Database from 'better-sqlite3';

app.use(
  middleware.auth({
    plugins: [twoFactor({ issuer: 'Acme' }), organization(), anonymous(), bearerToken()],
    accountLinking: accountLinking(),
    rateLimit: rateLimit({ maxAttempts: 5, window: 300 }),
    betterAuth: { database: new Database('auth.db'), emailAndPassword: { enabled: true } },
  })
);
```

`twoFactor()`, `organization()` and `anonymous()` store data in Better Auth's database, whose tables have to be created first. The [Authentication Guide](./AUTH_GUIDE.md#two-factor-organizations-anonymous-users-session-tokens-account-linking-rate-limits) has each helper's options, the routes it adds and the database set-up.

See [Authentication Guide](./AUTH_GUIDE.md) for complete documentation.

**Session Management**

```typescript
app.use(
  middleware.session({
    secret: process.env.SESSION_SECRET, // from the environment, never a literal; signs the session id cookie
    store: 'redis',
    cookie: { maxAge: 24 * 60 * 60 * 1000 }, // milliseconds; HttpOnly and SameSite=Lax stay on
  })
);
```

`cookie` options are laid over the defaults (24 hours, `HttpOnly`, `SameSite=Lax`, `Path=/`). `secret` may be an array for key rotation. On `req.session`, `id`, `data` and the session's methods are read-only; every other name is a session field.

#### Real-time & Advanced

**Server-Sent Events (SSE)**

```typescript
app.get('/events', (req, res) => {
  // Open the stream, then write one event at a time
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const interval = setInterval(() => {
    res.write(`event: update\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
  }, 1000);

  req.on('close', () => clearInterval(interval));
});
```

`middleware.sse()` adds helpers that do the formatting: `res.sse()` opens the stream and returns `{ sendEvent, sendComment, sendRetry, close }`. The stream opens when the handler calls it, never on its own.

```typescript
app.use(middleware.sse({ heartbeat: 30000, retry: 3000 }));

app.get('/ticks', (req, res) => {
  const stream = res.sse!(); // installed by middleware.sse()
  const interval = setInterval(() => stream.sendEvent({ time: Date.now() }, 'update'), 1000);
  req.on('close', () => clearInterval(interval));
});
```

**CDN Integration**

```typescript
app.use(
  middleware.cdn({
    adapter: 'cloudfront', // 'cloudflare', 'cloudfront', 'azure', or a CDNAdapter instance
    adapterOptions: {
      distributionId: 'E1234567890ABC',
      region: 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  })
);
```

The CloudFront adapter needs `@aws-sdk/client-cloudfront` in your application (the older `aws-sdk` v2 package still works, with a start-up warning). See the [Middleware Guide](./MIDDLEWARE_GUIDE.md#cdn-integration).

**GraphQL**

```typescript
app.graphqlInit({
  schema,
  path: '/graphql',
  enablePlayground: true, // served at /graphql/playground outside production
  maxDepth: 10, // refuse operations nested deeper than 10 fields
  maxComplexity: 1000, // refuse operations that select more than 1000 fields
});
```

Neither limit is set by default. An operation over a limit gets a GraphQL error
response (`extensions.code` `QUERY_TOO_DEEP` / `QUERY_TOO_COMPLEX`) and no
resolver runs.

See [GraphQL Guide](./GRAPHQL_GUIDE.md) for detailed documentation.

#### Monitoring

**Request Logger**

```typescript
// Logs each request and how long it took; takes no options
app.use(middleware.requestLogger());
```

**Performance Monitor**

```typescript
// Logs a warning for any request slower than one second; takes no options
app.use(middleware.performanceMonitor());
```

**Error Tracker**

```typescript
// Logs request errors and passes them on to the error handler. Credential-carrying
// query parameters (token, code, signature, ...) are redacted in the logged URL;
// redactedQueryParams takes your own list, or false to log the URL as received
app.use(middleware.errorTracker());
```

### Middleware Reference

For complete middleware documentation including all options and examples, see:

- **[Middleware Guide](./MIDDLEWARE_GUIDE.md)** - Comprehensive reference for all built-in middleware

### Custom Middleware

#### Standard Middleware

```typescript
const loggerMiddleware = (req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
};

app.use(loggerMiddleware);
```

#### Async Middleware

```typescript
const authMiddleware = async (req, res, next) => {
  try {
    req.user = await authenticateUser(req.headers.authorization);
    next();
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

app.use(authMiddleware);
```

#### Error Handling Middleware

```typescript
const errorHandler = (err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
};

app.use(errorHandler);
```

---

## Database Integration

### Database Adapters

#### MySQL Adapter

```typescript
import { MySQLAdapter } from '@morojs/moro';

const db = new MySQLAdapter({
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: 'password',
  database: 'myapp',
  connectionLimit: 10,
});

app.database(db);
```

#### PostgreSQL Adapter

```typescript
import { PostgreSQLAdapter } from '@morojs/moro';

const db = new PostgreSQLAdapter({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'password',
  database: 'myapp',
});

app.database(db);
```

#### SQLite Adapter

```typescript
import { SQLiteAdapter } from '@morojs/moro';

const db = new SQLiteAdapter({
  filename: './database.sqlite',
});

app.database(db);
```

#### MongoDB Adapter

```typescript
import { MongoDBAdapter } from '@morojs/moro';

const db = new MongoDBAdapter({
  url: 'mongodb://localhost:27017/myapp',
});

app.database(db);
```

#### Redis Adapter

```typescript
import { RedisAdapter } from '@morojs/moro';

const redis = new RedisAdapter({
  host: 'localhost',
  port: 6379,
  password: 'password',
});

app.database(redis);
```

#### Adapter Options and Behaviour

- **Drivers.** Each adapter loads its driver from your project (`mysql2`, `pg`, `better-sqlite3`,
  `mongodb`, `ioredis`). A driver that is not installed is reported as
  `<name> package is required ...`; any other start-up failure is reported with the driver's own
  error.
- **TLS.** `PostgreSQLAdapter` and `MySQLAdapter` take `ssl`: `true`, or an options object (`ca`,
  `cert`, `key`, `passphrase`, `rejectUnauthorized`, `servername`). `RedisAdapter` takes the same
  object as `tls`. On MySQL, `ssl: true` means `{ rejectUnauthorized: true }`: an encrypted
  connection to a server whose certificate verifies against the trusted CAs.
- **`checkServerIdentity`.** In those objects, `checkServerIdentity: false` accepts a certificate
  whose host name does not match the server (the certificate chain is still verified), and `true`
  keeps the default check. mysql2 verifies the chain but not the host name, with or without it.
- **MongoDB.** With `host` / `port` / `username` / `password`, a username or password that contains
  one of `: / ? # [ ] @` is percent-encoded for you; inside a `url` you encode it yourself.
  A `tls` object turns TLS on: `ca`, `cert` and `key` are file paths or PEM text (`key` may be a
  file that holds both the client key and its certificate), plus `passphrase`,
  `allowInvalidCertificates`, `allowInvalidHostnames`, `insecure` and `checkServerIdentity`.
  `update()` resolves to the updated document, or `null` when no document matched.
- **SQLite.** `query()` and `queryOne()` run any statement; one that returns no rows (`CREATE`,
  `UPDATE`, `DELETE`, an `INSERT` without `RETURNING`) resolves to `[]` / `null`. `transaction()`
  commits when its async callback resolves and rolls back when it throws; transactions on one
  adapter run one after another.
- **Drizzle.** `query(sql, params)` and `queryOne(sql, params)` bind `params` to the `$1`, `$2`, ...
  or `?` placeholders of the text, whichever the text uses.

### Database Usage in Handlers

```typescript
app
  .post('/users')
  .body(UserSchema)
  .handler(async (req, res) => {
    // Use the adapter you registered with app.database(db)
    const user = await db.insert('users', req.body);
    return { success: true, data: user };
  });
```

### Transaction Support

```typescript
app
  .post('/transfer')
  .body(TransferSchema)
  .handler(async (req, res) => {
    // Commits when the callback resolves, rolls back when it throws
    await db.transaction(async tx => {
      await tx.query('UPDATE accounts SET balance = balance - ? WHERE id = ?', [
        req.body.amount,
        req.body.fromAccount,
      ]);

      await tx.query('UPDATE accounts SET balance = balance + ? WHERE id = ?', [
        req.body.amount,
        req.body.toAccount,
      ]);
    });

    return { success: true };
  });
```

---

## Message Queues

MoroJS includes a production-ready message queue system with multiple backend adapters. For complete documentation, see the [Queue Guide](./QUEUE_GUIDE.md).

### Overview

The queue system supports:

- Multiple adapters (Memory, Bull, RabbitMQ, AWS SQS, Kafka)
- Job scheduling and delays
- Retry logic with configurable backoff
- Dead letter queues
- Priority queues
- Bulk operations
- Monitoring and metrics

### Quick Start

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

// Register a queue
app.queueInit('emails', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379,
  },
  concurrency: 10,
});

// Add a job
await app.addToQueue('emails', {
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Welcome to our platform!',
});

// Process jobs
await app.processQueue('emails', async job => {
  await sendEmail(job.data);
  return { sent: true };
});
```

### Queue Adapters

#### Memory Adapter

```typescript
app.queueInit('tasks', {
  adapter: 'memory',
  concurrency: 5,
});
```

#### Bull Adapter (Redis)

```typescript
app.queueInit('tasks', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
});
```

#### RabbitMQ Adapter

```typescript
app.queueInit('tasks', {
  adapter: 'rabbitmq',
  connection: {
    host: 'localhost',
    port: 5672,
    username: 'guest',
    password: 'guest',
  },
});
```

#### AWS SQS Adapter

```typescript
app.queueInit('tasks', {
  adapter: 'sqs',
  connection: {
    region: 'us-east-1',
    queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue',
  },
});
```

#### Kafka Adapter

```typescript
app.queueInit('events', {
  adapter: 'kafka',
  connection: {
    brokers: ['localhost:9092'],
    groupId: 'my-consumer-group',
  },
});
```

Each adapter also takes its transport options in `connection`: `vhost`, `amqps` and `tls` for
RabbitMQ; `clientId`, `ssl` and `sasl` for Kafka; `endpoint` and `credentials` for SQS; `username`
and `tls` for Bull. See the [Queue Guide](./QUEUE_GUIDE.md#queue-adapters).

### Retention of Finished Jobs

Every queue keeps the last 1000 completed and the last 5000 failed jobs and removes older ones
(the RabbitMQ, Kafka and SQS adapters also keep at most 10000 records of jobs the process added
and has not seen finish). Change the numbers with `retention`; a job's own `removeOnComplete` /
`removeOnFail` takes their place for that job.

```typescript
app.queueInit('emails', {
  adapter: 'bull',
  connection: { host: 'localhost', port: 6379 },
  retention: { completed: 200, failed: 2000 },
});
```

### Job Options

```typescript
await app.addToQueue(
  'reports',
  { reportId: 123, format: 'pdf' },
  {
    priority: 10,
    delay: 60000, // 1 minute delay
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    timeout: 30000,
  }
);
```

### Job Processing

```typescript
// Basic processor
await app.processQueue('emails', async job => {
  await sendEmail(job.data);
  return { sent: true };
});

// With progress tracking
await app.processQueue('video-encoding', async job => {
  await job.updateProgress(0);
  const video = await loadVideo(job.data.videoId);

  await job.updateProgress(50);
  const encoded = await encodeVideo(video);

  await job.updateProgress(100);
  return { encoded: true };
});
```

### Queue Monitoring

```typescript
// Get metrics
const { metrics } = await app.getQueueStatus('emails');
console.log(`Waiting: ${metrics.waiting}`);
console.log(`Active: ${metrics.active}`);
console.log(`Completed: ${metrics.completed}`);

// Listen to events (delivered on the app event bus as { context, data })
app.events.on('queue:job:completed', ({ data }) => {
  console.log(`Job ${data.jobId} completed`);
});

app.events.on('queue:job:failed', ({ data }) => {
  console.error(`Job ${data.jobId} failed:`, data.error);
});
```

See [Queue Guide](./QUEUE_GUIDE.md) for complete documentation.

---

## gRPC Support

MoroJS includes native gRPC support for building high-performance microservices. For complete documentation, see the [gRPC Guide](./GRPC_GUIDE.md).

### Overview

Features:

- Proto-based service definitions, standard protobuf on the wire
- All call types (unary, streaming, bidirectional)
- Middleware (auth, validation, logging)
- Health checks
- TLS/SSL support

### Quick Start

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

app.grpcInit({
  port: 50051,
  host: '0.0.0.0',
});

// Register service
await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: async (call, callback) => {
    const user = await db.users.findById(call.request.id);
    callback(null, user);
  },
});

// Starts the HTTP server, and the gRPC server with it
app.listen(3000);
```

Without `credentials` the gRPC server is plaintext, and with the default `host` it listens on
every interface; started that way it logs a warning. Pass
`credentials: { privateKey, certChain }` to serve TLS, add `rootCerts` and
`requireClientCert: true` to accept only clients with a certificate that CA signed, or set
`host: '127.0.0.1'` for local connections only. See the
[gRPC Guide](./GRPC_GUIDE.md#tlsssl).

### Service Implementation

#### Unary RPC

```typescript
{
  GetUser: async (call, callback) => {
    try {
      const user = await db.users.findOne({ id: call.request.id });

      if (!user) {
        return callback({
          code: grpc.status.NOT_FOUND,
          message: 'User not found',
        });
      }

      callback(null, user);
    } catch (error) {
      callback({
        code: grpc.status.INTERNAL,
        message: error.message,
      });
    }
  };
}
```

#### Server Streaming

```typescript
{
  ListUsers: async call => {
    const users = await db.users.find().limit(100);

    for (const user of users) {
      call.write(user);
    }

    call.end();
  };
}
```

#### Client Streaming

```typescript
{
  CreateUsers: async (call, callback) => {
    const users = [];

    call.on('data', userData => {
      users.push(userData);
    });

    call.on('end', async () => {
      const result = await db.users.insertMany(users);
      callback(null, {
        created: result.length,
        ids: result.map(u => u.id),
      });
    });
  };
}
```

#### Bidirectional Streaming

```typescript
{
  Chat: async call => {
    call.on('data', message => {
      // Broadcast message
      broadcastToRoom(message);

      // Echo confirmation
      call.write({
        user_id: 'system',
        message: 'Received',
        timestamp: Date.now(),
      });
    });

    call.on('end', () => {
      call.end();
    });
  };
}
```

### gRPC Middleware

Register an array to attach middleware to a method: every element before the last is middleware, the last is the handler.

```typescript
import { grpcAuth, grpcRequireRole } from '@morojs/moro';

// `verify` receives the bearer token from the `authorization` metadata and
// resolves to the user. A rejection or a falsy result is UNAUTHENTICATED.
const auth = grpcAuth({
  verify: async token => verifyJWT(token, process.env.JWT_SECRET),
});

await app.grpcService('./proto/users.proto', 'UserService', {
  GetUser: [
    auth,
    async (call, callback) => {
      // The verified user is attached to the call as `user`
      const user = await db.users.findOne({ id: call.request.id });
      callback(null, user);
    },
  ],

  DeleteUser: [
    auth,
    grpcRequireRole('admin'),
    async (call, callback) => {
      await db.users.deleteOne({ id: call.request.id });
      callback(null, { success: true });
    },
  ],
});
```

### gRPC Client

```typescript
const client = await app.createGrpcClient('./proto/users.proto', 'UserService', 'localhost:50051');

// Unary call: resolves to the response, rejects with the gRPC error (code, details)
const response = await client.GetUser({ id: '123' });

// Streaming methods return the grpc-js call stream
for await (const user of client.ListUsers({ page: 0, limit: 10 })) {
  console.log(user.name);
}
```

See [gRPC Guide](./GRPC_GUIDE.md) for complete documentation.

---

## WebSocket Support

### Basic WebSocket Setup

```typescript
// WebSockets are opt-in: enable them when the app is created
const app = await createApp({ websocket: { enabled: true } });

app.websocket('/chat', {
  connection: socket => {
    console.log('User connected:', socket.id);
  },

  disconnect: socket => {
    console.log('User disconnected:', socket.id);
  },

  message: (socket, data) => {
    socket.broadcast.emit('message', {
      id: socket.id,
      message: data.message,
      timestamp: new Date(),
    });
    return { success: true };
  },
});
```

### Raw WebSocket frames

By default every frame is a JSON `{ event, data }` envelope and each handler key is an event name. A plain WebSocket peer (a browser using `WebSocket.send('hello')`, a load tester, a non-Moro service) speaks raw frames instead. Register the namespace with `{ raw: true }`: every text frame reaches `message` as a string, every binary frame reaches `binary` as a `Buffer`, and replies go out through `socket.send()` or by returning a string/Buffer from the handler.

```typescript
app.websocket(
  '/ws',
  {
    connection: socket => console.log('open', socket.id),
    message: (socket, text) => socket.send(text), // text in, text out
    binary: (socket, bytes) => socket.send(bytes, true), // binary in, binary out
    disconnect: socket => console.log('closed', socket.id),
  },
  { raw: true }
);
```

`socket.send(data, isBinary?)` exists on every built-in adapter: a string is sent as a text frame, a Buffer/ArrayBuffer/Uint8Array as a binary frame unless `isBinary` says otherwise. Raw namespaces are supported by the native engine and the `ws` adapter; the Socket.IO adapter speaks its own protocol and ignores `raw`. Ping/pong, the close handshake and message size limits are unchanged.

Namespaces are routed by the upgrade URL. On the native engine that is the path itself (`ws://host/ws`); the `ws` adapter mounts under its base path (`websocket.options.path`, default `/ws`), so the same namespace is `ws://host/ws/ws` there and the base path alone reaches the `/` namespace.

On the native engine and on the `ws` adapter each namespace has its own sockets and its own rooms. `socket.broadcast`, `socket.to(room)` and a namespace's `emit()`, `to(room)` and `getSockets()` reach only the sockets that joined that namespace, and the same room name in two namespaces is two rooms. `socket.broadcast` leaves the sender out; `socket.to(room)` reaches every member of the room, the sender too when it is one. A connection to a path with no namespace of its own is served by the default namespace `/`.

On the native engine and on the Socket.IO adapter every origin may connect while `websocket.options.cors.origin` is not set (the `ws` adapter is same-origin only then). A configured `websocket.options.cors.origin` (anything but `true` or `'*'`) and `websocket.options.verifyClient` (which may be `async`) are evaluated before the connection is established, and a handshake that fails is refused: on the native engine with `403` for the origin and `401` from `verifyClient`, before the upgrade is answered. `websocket.options.enforceHandshakeChecks: false` turns the refusal into a logged warning on those two adapters. The Socket.IO adapter accepts messages up to 1 MB unless `websocket.options.maxPayloadLength` sets another limit. The table in [WebSocket Adapters](./WEBSOCKET-ADAPTERS.md#origins-handshake-checks-and-message-size) has every adapter's defaults.

Messages are sent uncompressed unless the app is created with `websocket.compression: true`. Every adapter then negotiates permessage-deflate with each client that offers it (browsers do): what such a client sends is inflated, a message of 1024 bytes or more sent to it is compressed, and the adapter's message limit also bounds a message once inflated (a larger one closes the connection with close code 1009). A client that does not offer the extension is served uncompressed. [Compression](./WEBSOCKET-ADAPTERS.md#compression) has each adapter's limit and the cost in CPU and memory.

### WebSocket with Validation

```typescript
const JoinSchema = z.object({
  room: z.string().min(1),
  username: z.string().min(2),
});

const MessageSchema = z.object({
  room: z.string(),
  content: z.string().min(1).max(500),
});

// Handlers are plain functions: validate the payload inside them. A thrown
// error reaches the client as { success: false, error }, with the error's
// message outside production and 'Internal server error' in production.
app.websocket('/chat', {
  join: (socket, payload) => {
    const data = JoinSchema.parse(payload);
    socket.join(data.room);
    socket.username = data.username;

    socket.to(data.room).emit('user-joined', {
      username: data.username,
      timestamp: new Date(),
    });

    return { success: true, room: data.room };
  },

  message: (socket, payload) => {
    const data = MessageSchema.parse(payload);
    socket.to(data.room).emit('message', {
      username: socket.username,
      content: data.content,
      timestamp: new Date(),
    });

    return { success: true };
  },
});
```

### WebSocket in Modules

```typescript
export default defineModule({
  name: 'chat',
  version: '1.0.0',
  sockets: [
    {
      event: 'join-room',
      validation: z.object({
        room: z.string(),
        username: z.string(),
      }),
      handler: async (socket, data) => {
        socket.join(data.room);
        return { joined: data.room };
      },
    },
    {
      event: 'send-message',
      validation: z.object({
        room: z.string(),
        message: z.string().max(500),
      }),
      rateLimit: { requests: 5, window: 60000 },
      handler: async (socket, data) => {
        socket.to(data.room).emit('new-message', {
          username: socket.username,
          message: data.message,
          timestamp: new Date(),
        });
        return { success: true };
      },
    },
  ],
});
```

---

## Configuration

MoroJS provides a flexible configuration system that supports multiple methods for defining your application settings.

### Configuration Methods

MoroJS supports configuration through:

1. **Configuration Files** (`moro.config.js` or `moro.config.ts`) - **Recommended**
2. **Environment Variables** - For deployment and sensitive data
3. **Schema Defaults** - Fallback values

**Configuration Priority (highest to lowest):**

- Environment Variables
- Configuration File
- Schema Defaults

### Configuration Files

#### moro.config.js (Recommended)

Create a `moro.config.js` file in your project root:

```javascript
// moro.config.js
module.exports = {
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  database: {
    postgresql: {
      host: 'localhost',
      port: 5432,
      user: 'myapp',
      password: 'development-password',
      database: 'myapp_dev',
    },
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000', 'http://localhost:3001'],
    },
    helmet: {
      enabled: true,
    },
  },
  performance: {
    compression: {
      enabled: true,
      level: 6,
    },
  },
  logging: {
    level: 'info',
    format: 'json',
  },
};
```

#### moro.config.ts (TypeScript)

For TypeScript projects, you can use a `.ts` config file:

```typescript
// moro.config.ts
import type { AppConfig, DeepPartial } from '@morojs/moro';

const config: DeepPartial<AppConfig> = {
  server: {
    port: 3000,
  },
  database: {
    postgresql: {
      host: 'localhost',
      port: 5432,
      database: 'myapp_dev',
    },
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000'],
    },
  },
};

export default config;
```

**Note:** Use `DeepPartial<AppConfig>` instead of `Partial<AppConfig>` for proper nested type support.

### Environment Variables

Environment variables take precedence over config files, making them perfect for deployment and sensitive data:

```bash
# .env
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Database
DATABASE_URL=postgresql://myapp:secure-production-password@db.example.com:5432/myapp_prod
REDIS_URL=redis://localhost:6379

# Logging
LOG_LEVEL=warn
LOG_FORMAT=json
```

### Logging

`logger` is the framework's logger, exported from `@morojs/moro`. Configure it with the `logger` option of `createApp()` or with environment variables:

```typescript
import { createApp, logger } from '@morojs/moro';

const app = await createApp({
  logger: { level: 'info', format: 'json' },
});

// message, optional context, optional metadata
logger.info('Order placed', 'Orders', { orderId: 'o_1', accessToken: 'tok_live_abc' });
// {"timestamp":"2026-01-05T10:15:00.123Z","level":"info","message":"Order placed",
//  "context":"Orders","metadata":{"orderId":"o_1","accessToken":"[REDACTED]"}}
```

`format` is `'pretty'` (the default: one coloured line per entry), `'compact'` (level, context and message only) or `'json'` (one JSON object per line, with an ISO 8601 `timestamp`; a `Date` in the metadata is written the same way and an `Error` as `{ name, message, stack }`). The format applies to every entry, with or without metadata, and so do the outputs added with `logger.addOutput()` and the filters added with `logger.addFilter()`.

**Redaction.** Wherever the logger prints metadata, the values of sensitive keys are replaced with `[REDACTED]`: always in the `json` format, and in the `pretty` format when `enableMetadata` is on. Outputs and filters receive the redacted copy; the object you passed is never modified.

- Masked whatever the value: `authorization`, `proxy-authorization`, `cookie`, `cookies`, `set-cookie`, `password`, `passwd`, `secret`, `token`, `passphrase`, `apiKey` / `api_key` / `api-key`.
- Masked unless the value is a number or a boolean: any key containing `token`, `secret`, `password`, `passwd`, `passphrase`, `apiKey`, `privateKey` or `credential` (`accessToken`, `client_secret`, `x-api-key`; `promptTokens: 512` and `hasPassword: true` are left alone).
- Keys are compared case-insensitively at any depth of plain objects and arrays, down to 8 levels (anything deeper becomes `[MaxDepth]`). Fields of class instances are masked when the logger prints them. Empty strings, `null` and `undefined` are left as they are.
- A bare `key` is not masked (it is usually a cache or object key). Add names of your own with an array.
- Only metadata is redacted. The message text is written as you built it, so pass secrets-bearing values as metadata, not inside the message.

| `logger` option      | Default                         | What it does                                                                                                                                                                 |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redact`             | on wherever metadata is printed | `true` redacts in every format (use it with a custom output in the `pretty` or `compact` format), `false` turns redaction off, an array turns it on and adds those key names |
| `escapeControlChars` | `true`                          | In the `pretty` and `compact` formats, control characters in a message or context are written as visible escapes; `false` writes messages as passed                          |

```typescript
const app = await createApp({
  logger: { format: 'json', redact: ['pin', 'ssn'] }, // the built-in list plus these
});
```

**Control characters.** In the `pretty` and `compact` formats, a carriage return, line feed, escape or other control character in a message or context is written as a visible escape (`\n`, `\r`, `\x1b`), so a logged request value cannot start a new log line or send a sequence to the terminal. The frames of a stack trace keep their own lines. The `json` format escapes these characters by construction. A message that is meant to span several lines is therefore printed on one; log the parts separately, or set `escapeControlChars: false`.

Environment variables: `LOG_REDACT` (`true` / `false`) and `LOG_ESCAPE_CONTROL_CHARS` (`true` / `false`), each also read with a `MORO_` prefix. The `logger` option of `createApp()` takes precedence. Both settings are read from `createApp({ logger })` and the environment, not from the `logging` section of a config file.

### Configuration Examples

#### Development Environment

```javascript
// moro.config.js
module.exports = {
  server: {
    port: 3000,
  },
  database: {
    sqlite: {
      filename: './dev.db',
    },
  },
  logging: {
    level: 'debug',
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000', 'http://localhost:5173'],
    },
  },
};
```

#### Production Environment

```javascript
// moro.config.js
module.exports = {
  server: {
    port: Number(process.env.PORT) || 3000,
    host: '0.0.0.0',
  },
  database: {
    postgresql: {
      host: process.env.DATABASE_HOST,
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
      ssl: true,
    },
    redis: {
      url: process.env.REDIS_URL,
    },
  },
  security: {
    cors: {
      enabled: true,
      origin: process.env.CORS_ORIGIN?.split(',') || [],
    },
    helmet: {
      enabled: true,
    },
  },
  performance: {
    compression: {
      enabled: true,
      level: 9,
    },
  },
  logging: {
    level: 'info',
    format: 'json',
  },
};
```

#### Multi-Environment Config

```javascript
// moro.config.js
const environment = process.env.NODE_ENV || 'development';

const baseConfig = {
  server: {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || 'localhost',
  },
  security: {
    cors: {
      enabled: true,
    },
  },
};

const environmentConfigs = {
  development: {
    ...baseConfig,
    database: {
      sqlite: {
        filename: './dev.db',
      },
    },
    logging: {
      level: 'debug',
    },
  },

  test: {
    ...baseConfig,
    database: {
      sqlite: {
        filename: ':memory:',
      },
    },
    logging: {
      level: 'error',
    },
  },

  production: {
    ...baseConfig,
    database: {
      postgresql: {
        host: process.env.DATABASE_HOST,
        port: parseInt(process.env.DATABASE_PORT || '5432'),
        user: process.env.DATABASE_USERNAME,
        password: process.env.DATABASE_PASSWORD,
        database: process.env.DATABASE_NAME,
        ssl: true,
      },
    },
    logging: {
      level: 'info',
      format: 'json',
    },
  },
};

module.exports = environmentConfigs[environment];
```

### Module Configuration

MoroJS also supports module-specific configuration using `createModuleConfig`:

```typescript
import { createModuleConfig, z } from '@morojs/moro';

// Define module schema
const EmailModuleSchema = z.object({
  apiKey: z.string(),
  timeout: z.number().default(5000),
  retries: z.number().default(3),
  enabled: z.boolean().default(true),
});

// Create module config with environment override support
const emailConfig = createModuleConfig(
  EmailModuleSchema,
  {
    apiKey: 'default-key',
    timeout: 3000,
  },
  'EMAIL_' // Environment prefix
);

// Now emailConfig will merge:
// 1. Environment variables (EMAIL_API_KEY, EMAIL_TIMEOUT, etc.)
// 2. Global app config
// 3. Default values passed above
// 4. Schema defaults
```

### Configuration Usage

```typescript
const app = await createApp();

// Access configuration
const config = app.getConfig();
console.log('Server port:', config.server.port);
console.log('Server host:', config.server.host);
console.log('Database URL:', config.database.url);

// Configuration is fully typed!
// TypeScript will provide intellisense and type checking
if (isDevelopment()) {
  console.log('Development mode enabled');
}

// Environment-specific config (isDevelopment / isProduction are exported by '@morojs/moro')
if (isProduction()) {
  app.enableDocs({ title: 'My API', version: '1.0.0', basePath: '/internal/docs' });
} else {
  app.enableDocs({ title: 'My API', version: '1.0.0', basePath: '/docs' });
}
```

---

## Events

### Application Events

MoroJS provides an event system for application lifecycle and custom events.

```typescript
// Listen to framework events. Every listener receives { context, data }:
// `data` is the event's own payload, `context` carries timestamp and source.
app.events.on('framework:initialized', ({ data }) => {
  console.log('Framework initialized with options:', data.options);
});

app.events.on('server:started', ({ data }) => {
  console.log(`Server started on port ${data.port}`);
});

app.events.on('module:loaded', ({ data }) => {
  console.log(`Module ${data.moduleId}@${data.version} loaded`);
});

app.events.on('database:connected', ({ data }) => {
  console.log(`Database connected using ${data.adapter}`);
});
```

### Custom Events in Handlers

```typescript
app
  .post('/users')
  .body(UserSchema)
  .handler(async (req, res) => {
    const user = await createUser(req.body);

    // Emit custom event
    app.events.emit('user:created', {
      user,
      timestamp: new Date(),
      ip: req.ip,
    });

    return { success: true, data: user };
  });

// Listen to custom events
app.events.on('user:created', ({ data: { user, timestamp, ip } }) => {
  console.log(`New user ${user.name} created from ${ip} at ${timestamp}`);

  // Send welcome email, update analytics, etc.
  sendWelcomeEmail(user);
  updateAnalytics('user_created', { userId: user.id });
});
```

### Module Events

Events are scoped to modules for better isolation:

```typescript
export default defineModule({
  name: 'orders',
  version: '1.0.0',
  routes: [
    {
      method: 'POST',
      path: '/orders',
      handler: async (req, res) => {
        const order = await createOrder(req.body);

        // Module-scoped event
        req.events.emit('order:created', { order });

        return { success: true, data: order };
      },
    },
  ],
});

// Listen to module events: the name is prefixed with `module:<module name>:`
app.events.on('module:orders:order:created', ({ data }) => {
  console.log('New order created:', data.order.id);
});
```

### Event Types

```typescript
// The `data` of each framework event
interface FrameworkEvents {
  'framework:initialized': { options: MoroOptions; config: AppConfig };
  'server:starting': { port: number };
  'server:started': { port: number };
  'module:loading': { moduleId: string };
  'module:loaded': { moduleId: string; version: string };
  'database:connected': { adapter: string };
}
```

---

## Worker Threads

MoroJS includes built-in Worker Threads support for offloading CPU-intensive operations. For complete documentation, see the [Workers Guide](./WORKERS_GUIDE.md).

### Overview

Worker threads execute CPU-intensive operations in separate threads, preventing main thread blocking.

**Suitable for:**

- JWT signing/verification
- Password hashing
- Data encryption/decryption
- Image/video processing
- Large data transformations
- Complex calculations

**Not suitable for:**

- Database queries (already async)
- HTTP requests (already async)
- File I/O (already async)

### Quick Start

```typescript
import { getWorkerManager, workerTasks } from '@morojs/moro';

const workers = getWorkerManager();

// Verify JWT on worker thread (resolves to the decoded payload, rejects if invalid)
app.post('/api/auth/verify', async (req, res) => {
  try {
    const payload = await workerTasks.verifyJWT(req.body.token, process.env.JWT_SECRET);
    return { user: payload };
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Fingerprint a document on worker thread (a fast digest: not for passwords)
app.post('/api/documents', async (req, res) => {
  const checksum = await workerTasks.hash(req.body.content, 'sha256');

  const document = await saveDocument({
    content: req.body.content,
    checksum,
  });

  return document;
});
```

### Built-in Worker Tasks

#### JWT Operations

```typescript
import { workerTasks } from '@morojs/moro';

// Sign JWT
const token = await workerTasks.signJWT(
  { userId: user.id, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

// Verify JWT (resolves to the decoded payload, rejects if the token is invalid)
const payload = await workerTasks.verifyJWT(token, process.env.JWT_SECRET);
```

#### Cryptographic Operations

```typescript
// Hash data (fast digest for checksums and fingerprints: not for passwords)
const hash = await workerTasks.hash(data, 'sha256');

// Encryption has no helper: run the built-in task types through the manager.
// The default algorithm is aes-256-cbc, so the key must be 32 bytes.
const encrypted = await workers.executeTask<string>({
  id: 'encrypt-1',
  type: 'crypto:encrypt',
  data: { data: sensitiveData, key: process.env.ENCRYPTION_KEY },
}); // "<iv hex>:<ciphertext hex>"

// Decrypt data
const decrypted = await workers.executeTask<string>({
  id: 'decrypt-1',
  type: 'crypto:decrypt',
  data: { data: encrypted, key: process.env.ENCRYPTION_KEY },
});
```

#### Data Compression

```typescript
// Compress data ('gzip' by default; also 'deflate' and 'brotli'). Resolves to a Buffer.
const compressed = await workerTasks.compress(JSON.stringify(largeData));

// Decompress data (takes a Buffer or Uint8Array, resolves to a Buffer)
const decompressed = await workerTasks.decompress(compressed);
const restored = JSON.parse(decompressed.toString('utf8'));
```

#### Heavy Computation

```typescript
// Run the built-in CPU-bound routine: { iterations } resolves to { result, iterations }
const result = await workerTasks.heavyComputation({ iterations: 1_000_000 });

// Transform large JSON. The transformer is sent to the worker as source text:
// it receives the whole value and cannot use anything defined outside its own
// body. Requires the optional `isolated-vm` package: without it the call is
// rejected at once and the transformer is not run.
const transformed = await workerTasks.transformJSON(data, (rows: any[]) =>
  rows.map(row => ({
    ...row,
    total: row.price * row.quantity,
  }))
);
```

### Configuration

```typescript
import { WorkerManager } from '@morojs/moro';

// Configure worker pool
const workers = new WorkerManager({
  workerCount: 4, // Number of worker threads
  maxQueueSize: 1000, // Maximum queued tasks
});

// Or use with createApp
const app = await createApp({
  workers: {
    count: 4,
    maxQueueSize: 1000,
    // Optional V8 limits per worker thread, passed to new Worker(). Not set by
    // default: each worker then has the same heap ceiling as the main thread.
    resourceLimits: { maxOldGenerationSizeMb: 512 },
  },
});
```

A worker that reaches a limit is terminated by Node: its task is rejected and
the pool starts a replacement. See the
[Workers Guide](./WORKERS_GUIDE.md#memory-limits-per-worker).

### Task Priority

```typescript
import { getWorkerManager } from '@morojs/moro';

const workers = getWorkerManager();

// High priority task
await workers.executeTask({
  id: 'critical-task',
  type: 'crypto:hash',
  data: { data: 'critical-data', algorithm: 'sha256' },
  priority: 'high', // 'high' | 'normal' | 'low'
  timeout: 10000, // Optional timeout
});
```

### Execution Model

Worker threads use message passing:

1. Task is serialized and sent to worker thread
2. Worker executes task in separate V8 isolate
3. Result is serialized and returned to main thread
4. Promise resolves with result

**Overhead considerations:**

- Data serialization cost
- Thread communication overhead
- Task complexity vs overhead tradeoff

### Worker Stats

```typescript
const workers = getWorkerManager();
const stats = workers.getStats();

console.log(stats);
// {
//   workerCount: 4,
//   busyWorkers: 4,
//   idleWorkers: 0,
//   activeTasks: 27,
//   queuedTasks: 23,
//   isShuttingDown: false
// }
```

For complete documentation, examples, and best practices, see the [Workers Guide](./WORKERS_GUIDE.md).

---

## Performance

### Caching Strategies

```typescript
// Route-level caching (kept in process memory)
app
  .get('/popular-posts')
  .cache({
    ttl: 300, // 5 minutes
  })
  .handler(getPopularPosts);

// With a custom key (for Redis-backed caching use middleware.cache({ adapter: 'redis' }))
app
  .get('/user-profile/:id')
  .cache({
    ttl: 600, // 10 minutes
    key: req => `profile:${req.params.id}`,
  })
  .handler(getUserProfile);

// Custom cache key generation
app
  .get('/search')
  .cache({
    ttl: 120,
    key: req => `search:${JSON.stringify(req.query)}`,
  })
  .handler(searchContent);
```

Without a `key`, a route's entry is keyed by method, host, path and query (plus the signed-in user's id), so an app that answers for several host names keeps one entry per host. `shared: true` makes one entry for every caller, under every host name; a `key` that includes `req.hostname` shares an entry between the callers of one host. Details are in the [Middleware Guide](./MIDDLEWARE_GUIDE.md#cache).

### Rate Limiting

```typescript
// Global rate limiting
app.use(
  middleware.rateLimit({
    requests: 1000,
    window: 60000, // 1 minute
    skipSuccessfulRequests: false,
  })
);

// Route-specific rate limiting
app
  .post('/api/upload')
  .rateLimit({
    requests: 5,
    window: 60000,
    skipSuccessfulRequests: true,
  })
  .handler(handleUpload);

// Tighter limit on a costly endpoint (one counter per client per registered route)
app
  .post('/api/send-email')
  .rateLimit({
    requests: 10,
    window: 3600000, // 1 hour
  })
  .handler(sendEmail);
```

### Circuit Breaker

```typescript
import { CircuitBreaker } from '@morojs/moro';

// Jobs are wrapped automatically, and module route handlers when
// performance.circuitBreaker.enabled is set; for other HTTP routes, wrap the
// call yourself
const breaker = new CircuitBreaker({
  failureThreshold: 5, // open after 5 failures
  resetTimeout: 30000, // try again after 30s
});

app.get('/external-api').handler(async (req, res) => {
  const data = await breaker.execute(() => callExternalAPI());
  return { success: true, data };
});
```

### Performance Benchmarks

Measured comparisons (vs Fastify, Express, Koa, Elysia, and raw baselines),
methodology, and saved results files live in the
**[MoroJS Benchmark repo](https://github.com/Moro-JS/benchmark)**.

---

## Error Handling

### Global Error Handling

```typescript
// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
    requestId: req.requestId,
  });
});
```

### Route-Specific Error Handling

```typescript
app
  .get('/users/:id')
  .params(z.object({ id: z.string().uuid() }))
  .handler(async (req, res) => {
    try {
      const user = await getUserById(req.params.id);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found',
        });
      }

      return { success: true, data: user };
    } catch (error) {
      console.error('Error fetching user:', error);
      throw error; // Will be caught by global error handler
    }
  });
```

### Custom Error Classes

```typescript
class ValidationError extends Error {
  constructor(
    message: string,
    public field: string
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

class NotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = 'NotFoundError';
  }
}

// Use in handlers
app.get('/users/:id').handler(async (req, res) => {
  const user = await getUserById(req.params.id);

  if (!user) {
    throw new NotFoundError('User');
  }

  return { success: true, data: user };
});
```

---

This API reference covers the core functionality of MoroJS. For more examples and advanced usage patterns, see the [examples repository](https://github.com/Moro-JS/examples) and other documentation in this `/docs` folder.
