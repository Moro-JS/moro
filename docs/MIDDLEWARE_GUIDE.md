# MoroJS Middleware Guide

Complete reference for all built-in middleware in MoroJS.

## Table of Contents

- [Overview](#overview)
- [Security Middleware](#security-middleware)
- [Performance Middleware](#performance-middleware)
- [HTTP Features](#http-features)
- [Authentication & Sessions](#authentication--sessions)
- [Content Delivery](#content-delivery)
- [Monitoring & Logging](#monitoring--logging)
- [Advanced Features](#advanced-features)
- [Custom Middleware](#custom-middleware)

---

## Overview

MoroJS provides 18+ built-in middleware solutions that integrate seamlessly with the intelligent routing system. All middleware supports automatic ordering and can be used globally or per-route.

### Quick Reference

| Middleware    | Purpose                                  | Phase            |
| ------------- | ---------------------------------------- | ---------------- |
| `cors`        | Cross-origin resource sharing            | Security         |
| `helmet`      | Security headers                         | Security         |
| `csrf`        | CSRF protection                          | Security         |
| `csp`         | Content Security Policy                  | Security         |
| `compression` | Response compression                     | Performance      |
| `cache`       | Response caching                         | Performance      |
| `rateLimit`   | Request rate limiting                    | Rate Limiting    |
| `auth`        | Authentication & RBAC                    | Authentication   |
| `session`     | Session management                       | Authentication   |
| `validation`  | Request validation                       | Validation       |
| `bodySize`    | Body size limiting                       | Parsing          |
| `cookie`      | Cookie parsing                           | Parsing          |
| `staticFiles` | Static file serving                      | Handler          |
| `upload`      | File upload handling                     | Handler          |
| `template`    | Template rendering                       | Handler          |
| `range`       | HTTP range requests                      | Handler          |
| `http2`       | HTTP/2 server push                       | Handler          |
| `cdn`         | CDN integration                          | Content Delivery |
| `sse`         | Server-Sent Events helpers (`res.sse()`) | Real-time        |
| `graphql`     | GraphQL endpoint                         | Handler          |

---

## Security Middleware

### CORS (Cross-Origin Resource Sharing)

Enable cross-origin requests with fine-grained control. MoroJS automatically handles OPTIONS preflight requests.

```typescript
import { middleware } from '@morojs/moro';

// Global CORS with static origins
app.use(
  middleware.cors({
    origin: ['https://example.com', 'https://app.example.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Total-Count'],
    credentials: true,
    maxAge: 86400, // 24 hours
  })
);

// Dynamic origin validation (function)
app.use(
  middleware.cors({
    origin: (requestOrigin, req) => {
      // Return the origin to allow, or false to deny
      if (requestOrigin?.endsWith('.example.com')) {
        return requestOrigin;
      }
      if (requestOrigin === 'https://example.com') {
        return requestOrigin;
      }
      return false; // Deny all other origins
    },
    credentials: true,
  })
);

// Async origin validation (e.g., database lookup)
app.use(
  middleware.cors({
    origin: async (requestOrigin, req) => {
      // Check database for allowed origin
      const isAllowed = await db.origins.findOne({ origin: requestOrigin });
      return isAllowed ? requestOrigin : false;
    },
    credentials: true,
  })
);

// Wildcard subdomain matching
app.use(
  middleware.cors({
    origin: origin => {
      const allowed = [
        'https://example.com',
        /^https:\/\/[\w-]+\.example\.com$/, // Regex support
      ];

      if (!origin) return false;

      return allowed.some(pattern => {
        if (typeof pattern === 'string') {
          return origin === pattern;
        }
        return pattern.test(origin);
      })
        ? origin
        : false;
    },
  })
);
```

**Options:**

- `origin` - String, array, boolean, or function `(origin, req) => string | string[] | boolean | Promise<...>`
  - String: Single allowed origin
  - Array: Multiple allowed origins. The response names the request's own origin when it is in the
    list. A request from any other origin, or with no `Origin` header, gets no
    `Access-Control-Allow-Origin` at all (so the browser refuses to hand the response to that
    page); with `credentials: true` a cross-origin request from an unlisted origin is answered 403. `Vary: Origin` is sent either way.
  - Boolean: `true` for wildcard, `false` to deny all
  - Function: Dynamic validation with access to request origin and req object
- `methods` - Allowed HTTP methods
- `allowedHeaders` - Headers clients can send
- `exposedHeaders` - Headers exposed to clients
- `credentials` - Allow credentials
- `maxAge` - Preflight cache duration (seconds)
- `preflightContinue` - If `true`, pass OPTIONS requests to next handler instead of responding automatically (default: `false`)

**Preflight Handling:**

MoroJS automatically responds to OPTIONS preflight requests with:

- `204 No Content` status
- All appropriate CORS headers
- Early termination (no route handler execution)

This behavior can be disabled by setting `preflightContinue: true`:

```typescript
app.use(
  middleware.cors({
    origin: 'https://example.com',
    preflightContinue: true, // Handle OPTIONS in your routes
  })
);

// Now you can handle OPTIONS manually
app.options('/api/data', (req, res) => {
  // Custom preflight logic
  res.status(200).json({ preflight: 'ok' });
});
```

**Origin Function Examples:**

```typescript
// Environment-based validation
app.use(
  middleware.cors({
    origin: origin => {
      if (process.env.NODE_ENV === 'production') {
        return origin === 'https://myapp.com' ? origin : false;
      }
      // Allow all in development
      return true;
    },
  })
);

// User authentication-based CORS
app.use(
  middleware.cors({
    origin: async (origin, req) => {
      // Check if request has valid API key
      const apiKey = req.headers['x-api-key'];
      const client = await db.clients.findOne({ apiKey, origin });
      return client ? origin : false;
    },
  })
);

// Multi-tenant origin validation
app.use(
  middleware.cors({
    origin: async (origin, req) => {
      const tenantId = req.headers['x-tenant-id'];
      const tenant = await db.tenants.findById(tenantId);

      if (tenant?.allowedOrigins.includes(origin)) {
        return origin;
      }
      return false;
    },
  })
);
```

### Helmet (Security Headers)

Add security headers to protect against common vulnerabilities.

```typescript
// Default security headers
app.use(middleware.helmet());

// Custom configuration
app.use(
  middleware.helmet({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.example.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'api.example.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com'],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
    strictTransportSecurity: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
    },
    referrerPolicy: 'strict-origin-when-cross-origin',
    xFrameOptions: 'SAMEORIGIN', // or 'DENY' (default)
    xContentTypeOptions: true,
    xXssProtection: true, // sends "X-XSS-Protection: 0"; false sends no header
  })
);

// Disable specific headers
app.use(
  middleware.helmet({
    contentSecurityPolicy: false, // Disable CSP
    strictTransportSecurity: true,
  })
);
```

**Headers added, with their default values:**

| Header                              | Default                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `Content-Security-Policy`           | `default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `Strict-Transport-Security`         | `max-age=31536000; includeSubDomains`                                             |
| `X-Frame-Options`                   | `DENY`                                                                            |
| `X-Content-Type-Options`            | `nosniff`                                                                         |
| `X-XSS-Protection`                  | `0`                                                                               |
| `Referrer-Policy`                   | `strict-origin-when-cross-origin`                                                 |
| `X-Download-Options`                | `noopen`                                                                          |
| `X-Permitted-Cross-Domain-Policies` | `none`                                                                            |

- `X-XSS-Protection: 0` switches off the XSS filter of older browsers, which is what current
  guidance asks for: the filter could itself be used against a page, and the
  Content-Security-Policy is the protection.
- In the default policy `frame-ancestors` says what `X-Frame-Options` says: `'none'` for `DENY`,
  `'self'` for `xFrameOptions: 'SAMEORIGIN'`, and it is left out with `xFrameOptions: false`. When
  you pass your own `contentSecurityPolicy` directives, exactly those directives are sent: add
  `baseUri`, `formAction` and `frameAncestors` yourself, since they do not fall back to
  `default-src`.
- The default policy's `form-action 'self'` stops a page from posting a form to another origin. If
  yours do (a payment page, an identity provider), pass your own directives.
- The rate limiter's 429, the CORS middleware's 403 and the CSRF middleware's 403 are answered
  before `app.use()` function middleware runs. They carry helmet's headers all the same when
  `middleware.helmet()` is registered with `app.use()` (or helmet is enabled in the configuration).
  The rate limiter's 429 and the CSRF middleware's 403 carry your CORS headers too, wherever CORS
  is registered and whether the two were installed with `app.use()` or from the configuration: a
  page on an allowed origin reads the answer instead of seeing a failed request. Both leave a
  preflight (`OPTIONS` with `Access-Control-Request-Method`) to CORS: it is not counted against
  the limit and is not asked for a CSRF token.
- Every request hook runs for every request, also after one of them has answered it. The built-in
  ones then leave the request alone: a request the rate limiter refused gets no CSP or CDN header,
  no session, no cache lookup, and a GraphQL operation in it is not executed. The rate limiter is
  the exception in one respect: it still counts a request that a hook registered ahead of it has
  answered (an auth hook's 401, the CORS 403), so those remain limited.

### CSRF Protection

Protect against Cross-Site Request Forgery attacks.

```typescript
// Enable CSRF protection
app.use(
  middleware.csrf({
    secret: process.env.CSRF_SECRET, // from the environment, never a literal; signs every token
    cookieName: '_csrf',
    headerName: 'x-csrf-token', // lower case, as Node reports request headers
    ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
    sameSite: true,
  })
);

// Get CSRF token endpoint
app.get('/api/csrf-token', async (req, res) => {
  return { csrfToken: await req.csrfToken() };
});

// Protected endpoint: the middleware checks the token on every request whose
// method is not in ignoreMethods, and answers 403 when it does not verify
app.post('/api/transfer').handler((req, res) => {
  // Process transfer
  return { success: true };
});
```

How a request passes: it must repeat the token of its `_csrf` cookie in the `x-csrf-token` header
or in a `_csrf` body field, and that token must be one this application issued.

- **Tokens are signed.** A token is `<random>.<signature>`, the signature an HMAC-SHA256 under
  `secret`. A value that something merely wrote into both the cookie and the request does not
  verify. Set `secret` in every deployment: without one a random secret is generated at start-up,
  so tokens stop working at a restart and do not work across instances.
- **Tokens belong to their session.** When `middleware.session()` is registered before
  `middleware.csrf()`, a token only verifies in the session it was issued in. The first
  `req.csrfToken()` of a session stores a random value in it (the `csrfSecret` field; rename it
  with `sessionKey`) and saves the session, so a visitor who is shown a form has a stored session.
  A session that is regenerated or destroyed starts without that value: after
  `req.session.regenerate()` at login, call `req.csrfToken()` again and use the new token. Pass
  `bindToSession: false` to switch this off. Registered the other way round (CSRF first), tokens
  still work but are not tied to the session, and a warning says so once.
- **The query string is not read.** A token in a URL ends up in logs, history and `Referer`
  headers. `allowQueryToken: true` reads `?_csrf=` again.
- **Tokens issued by earlier versions.** They were unsigned (64 hex characters). A
  request that still carries one in both places is accepted for this release, with one warning per
  process, so pages open during an upgrade keep working; `req.csrfToken()` replaces such a cookie
  with a signed token. `legacyTokens: false` refuses them now, and the next release will.

| Option            | Default                      |                                                                   |
| ----------------- | ---------------------------- | ----------------------------------------------------------------- |
| `secret`          | random per process           | Signs the tokens                                                  |
| `cookieName`      | `'_csrf'`                    | Cookie that carries the token (`HttpOnly`, `SameSite=Strict`)     |
| `headerName`      | `'x-csrf-token'`             | Request header the token is read from                             |
| `ignoreMethods`   | `['GET', 'HEAD', 'OPTIONS']` | Methods that are not checked                                      |
| `sameSite`        | `true`                       | `false` leaves `SameSite` off the cookie                          |
| `tokenLength`     | `32`                         | Random bytes per token                                            |
| `allowQueryToken` | `false`                      | Also read the token from `?_csrf=`                                |
| `legacyTokens`    | `true`                       | Accept unsigned tokens issued by earlier versions                 |
| `bindToSession`   | `true`                       | Tie tokens to `req.session` when there is one                     |
| `sessionKey`      | `'csrfSecret'`               | Session field holding the per-session value tokens are signed for |

The token cookie is marked `Secure` on an https connection, and when `X-Forwarded-Proto` says
`https` (once `server.trustProxy` is set, only when that header comes from a trusted proxy). On
AWS Lambda, Vercel Edge and Cloudflare Workers it follows what the platform reports.

### Content Security Policy (CSP)

Advanced CSP configuration with nonce support.

```typescript
app.use(
  middleware.csp({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
    nonce: true, // a fresh nonce per response, added to script-src and style-src
    reportOnly: false,
    reportUri: '/api/csp-violations',
  })
);

// Access nonce in templates
app.get('/page', (req, res) => {
  const nonce = req.cspNonce;
  return `<script nonce="${nonce}">alert('Safe');</script>`;
});
```

Called without `directives`, `middleware.csp()` sends this policy:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;
connect-src 'self'; font-src 'self'; object-src 'none'; media-src 'self'; frame-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'self'
```

`base-uri`, `form-action` and `frame-ancestors` do not fall back to `default-src`, so the default
names them: pages cannot be re-based, post forms to another origin, or be framed by another site.
With `directives`, exactly the directives you give are sent, so include those three in your own
policy (`baseUri`, `formAction`, `frameAncestors`).

---

## Performance Middleware

### Compression

Compress responses with brotli, gzip or deflate, negotiated per request from `Accept-Encoding`.

```typescript
// Basic compression
app.use(middleware.compression());

// Every option
app.use(
  middleware.compression({
    level: 6, // 1-9; gzip/deflate level, mapped onto brotli quality 1-11
    threshold: 1024, // bodies smaller than this are never compressed
    encodings: ['gzip', 'br'], // server preference order when the client accepts several
    maxInlineBytes: 16384, // compressed on the calling thread up to here, on the pool above
    gzip: { level: 3 }, // zlib options for gzip/deflate; a level here wins over `level`
    brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 3 } }, // brotli options; a quality here wins
    reuseEncoders: true, // default; keep one gzip encoder per setting and reset it between bodies
    filter: (req, res) => {
      // Custom filter
      if (req.headers['x-no-compression']) {
        return false;
      }
      return /json|text|javascript|css/.test(String(res.getHeader('Content-Type') || ''));
    },
  })
);
```

Where the work happens depends on the body size. A body at or below `maxInlineBytes` is
compressed on the calling thread and sent with a `Content-Length`: for a few kilobytes of
JSON that is well under a millisecond, less than the two thread handoffs a trip through the
libuv threadpool costs, and it keeps the response a single write. A larger body is compressed
on the threadpool and streamed chunked, so a big export never holds the event loop. Set
`maxInlineBytes: 0` to send every body through the pool.

The default `encodings` order prefers brotli. For API-sized JSON, gzip compresses in about half
the CPU for a body roughly a tenth larger, so a service measured on throughput may prefer
`['gzip', 'br']`; brotli stays available to a client that accepts nothing else.

`level` is one knob for both encoders: the gzip level as given, and a brotli quality it is
mapped onto (level 6 is quality 7). To pin either encoder exactly, pass its own options -
`gzip` takes zlib options (`level`, `windowBits`, `memLevel`, `strategy`), `brotli` the brotli
options object with its `params` - and what you pin wins over `level`. The brotli window is
fitted to the body unless you set `BROTLI_PARAM_LGWIN` yourself.

The encoders are reused: one per setting is kept and reset between bodies instead of being
built and torn down per response, since the encoder's state (deflate's window and hash tables,
brotli's half-megabyte hasher at quality 3) is a fair share of what compressing a few kilobytes
costs. A handle is proven once - two different bodies in a row must come out byte-identical to
the one-call API - and the one-call zlib API stands in whenever it cannot be driven that way.
Brotli's reset keeps its parameters from Node 26.11, and the kept brotli encoder runs with a
256 KiB window unless you pin `BROTLI_PARAM_LGWIN`; on an older Node the second body comes out
different and brotli falls back to the one-call API by itself. `reuseEncoders: false` turns the
reuse off. A compressed `res.json()` reply carries `Content-Type: application/json`, the
same type it carries without the middleware.

On the native engine the middleware does not wrap `res.json` and `res.send` at all: it hands
its settings to the response, and the reply takes the server's own buffered-response
compression, the path a `performance.compression` setting takes. That is one property write
per request, and the response keeps its shape for every later call. A `filter` is consulted
per response, so a middleware with one keeps the wrapping path, as the middleware does on the
other servers.

```typescript
// Per-route compression: the same factory, attached as route middleware
app
  .get('/api/large-data')
  .before(middleware.compression({ level: 9 }))
  .handler((req, res) => {
    return largeDataset;
  });
```

### Cache

Response caching with multiple backend support.

`middleware.cache()` keeps one response per URL and replays it to every later caller of that URL.
A URL here is the method, the host the request was sent to (`Host`, and `X-Forwarded-Host` when
one is sent), the path and the query string, so an application that answers for several host
names keeps their responses apart.
The lookup runs before any `app.use()` middleware, your authentication included, so the middleware
itself decides which requests may share an answer:

- **A request that carries credentials is never served from the cache and never stored.**
  Credentials are an `Authorization` header, a `Cookie` header (any cookie: a session cookie is how
  most applications know who is asking) and any header you name in `credentialHeaders`, for example
  `credentialHeaders: ['x-api-key']`. Such a response is marked `X-Cache: BYPASS` and its
  `Cache-Control` says `private`, so caches downstream do not share it either.
- **A response is not stored once the application has identified the caller**: when `req.user` or
  `req.auth.user` is set by the time the handler answers.
- `Set-Cookie` is never stored or replayed, responses with status 401, 403, 407, 429 or 5xx are
  not stored, and a response whose `Cache-Control` says `private`, `no-store` or `no-cache` is
  not stored.

What the middleware cannot see is a response that depends on something else about the caller: an
API key in a header of your own, the client address, a token in the query string. Installed with
no `strategies` and no `varyBy`, it logs one line at start-up that says what it will store and
share. Tell it about such a header in one of two ways:

```typescript
app.use(
  middleware.cache({
    // One entry per API key: each caller is answered from their own entry
    varyBy: ['x-api-key'],
  })
);

app.use(
  middleware.cache({
    // Or: a request with an API key is never cached at all
    credentialHeaders: ['x-api-key'],
  })
);
```

`varyBy` names request headers that identify the caller. Every distinct value gets an entry of its
own, and a request without the header shares the entry of the callers without one. The value is
hashed into the key, never written into it, so it does not show up in `X-Cache-Key`, in the store
or in the log. A response to a request that carries one of these headers is marked `private`, and
it is stored even after your authentication has set `req.user`, because the entry is that
caller's alone. Naming `authorization` or `cookie` in `varyBy` keys such requests instead of
bypassing the cache for them. `vary` works beside it: `vary` is for headers that select a
representation (`Accept-Language`), `varyBy` for headers that say who is asking; both select the
entry, and the `Vary` response header lists the names of both.

To cache for requests that carry credentials in another way, give the matching strategy a `key` of
its own. The key is then the whole identity of the entry, so it must tell apart every response that
differs:

```typescript
app.use(
  middleware.cache({
    strategies: {
      // The same page for everyone, whatever cookies the browser sends along
      '^/pricing$': { ttl: 300, key: req => `page:${req.path}` },
      // One entry per signed-in user
      '^/api/me$': { ttl: 30, key: req => `me:${req.headers.authorization}` },
    },
  })
);
```

`ttl` is an alias of `defaultTtl` and `strategy` an alias of `adapter` (`'memory'`, `'redis'`,
`'file'`); an option name the middleware does not know is reported in a warning at startup. The
`ETag` the middleware adds is a SHA-256 digest of the body (the first 128 bits), so it changes
exactly when the body does; pass `generateETag` to compute it your own way.

```typescript
// Memory cache (default)
app.use(
  middleware.cache({
    ttl: 300, // 5 minutes
    strategy: 'memory',
    maxEntries: 100, // Most responses kept; least recently used leave first (default 10,000)
  })
);

// Redis cache
app.use(
  middleware.cache({
    ttl: 3600,
    strategy: 'redis',
    adapterOptions: {
      host: 'localhost',
      port: 6379,
      password: 'secret',
    },
  })
);

// Per-route caching
app
  .get('/api/users')
  .cache({
    ttl: 60,
    key: req => `users:${req.query.page || 1}`,
    tags: ['users', 'public'], // sent as the X-Cache-Tags response header
  })
  .handler(async (req, res) => {
    const users = await getUsers(req.query.page);
    return users;
  });
```

Route-level `.cache()` takes `key` as a string or as a function of the request, and uses it exactly
as given. Without a `key`, the entry is keyed by method, host, path and query, plus the id of the
signed-in user (`req.user.id` or `req.auth.user.id`) when there is one, so users do not share
entries; a signed-in user without an id is not cached. The host is the `Host` header (and
`X-Forwarded-Host` when one is sent), so an application that answers for several host names keeps
one entry per host. Pass `shared: true` when the response is the same for every caller: a shared
entry is one entry for every signed-in user and under every host name, and nothing of the request
beyond its URL is read to find it. When a route's response is the same for every user but differs
by host, give it a `key` instead:

```typescript
app
  .get('/api/catalog')
  // One entry per host name, shared by every caller of that host
  .cache({ ttl: 300, key: req => `catalog:${req.hostname}` })
  .handler(() => loadCatalog());
```

On the native engine, a signed-in user's entry carries the host whenever a request header has been
read by the time the cache is consulted, which any authentication that reads a token or a cookie
has done; when the user was identified from something else (the query string, the socket), the
headers are not fetched for it and the entry is per user only. Use a `key` there too if the same
id can belong to different users on different hosts.

Responses with status 401, 403, 407, 429 or 5xx are not stored, a
stored response is replayed with its original status. The store holds at most
`modules.cache.maxSize` entries (1,000 by default; the least recently used one leaves first), and a
route that names no `ttl` is cached for `modules.cache.defaultTtl` seconds (300 by default).

The `'redis'` adapter loads the `redis` package (node-redis 4+). While Redis cannot be reached, a
lookup waits up to 5 seconds and then counts as a miss: the handler runs and its response is not
stored. To use a client you already have, pass `adapter: new RedisCacheAdapter({ client })`; the
client may be node-redis 4+ or ioredis, and the adapter never closes a client it was given.

The built-in adapters log each key they store or delete at debug level. When the keys are secrets
in themselves, pass `redactKeys: true` (`new RedisCacheAdapter({ client, redactKeys: true })`,
`new MemoryCacheAdapter({ redactKeys: true })`) and a short tag is logged in place of each key. The
session middleware does this for the store it uses.

### Rate Limiting

Protect endpoints from abuse with rate limiting.

```typescript
// Global rate limiting
app.use(
  middleware.rateLimit({
    requests: 100, // or max: 100
    window: 60000, // 1 minute; or windowMs: 60000
    message: 'Too many requests',
    statusCode: 429, // default
  })
);

// Per-route rate limiting
app
  .post('/api/login')
  .rateLimit({
    requests: 5,
    window: 900000, // 15 minutes
    skipSuccessfulRequests: false,
  })
  .handler((req, res) => {
    return login(req.body);
  });
```

A rejected request is answered immediately with the configured status and a
`Retry-After` header carrying the seconds until the window resets — it never
reaches your routes:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 47

{ "success": false, "error": "Too many requests", "retryAfter": 47 }
```

`skipSuccessfulRequests` counts the request up front and refunds it once the
response finishes below status 400, so a burst can't slip past the limit
mid-flight while successful traffic still goes uncounted. `skipFailedRequests`
is the mirror: only successful requests count.

Each client has one counter per route. A request is counted under its method and
the route it matches, as the route was registered (`POST /login/:user`), so a
different path parameter or query string does not start a new counter; a request
that matches no registered route is counted under its path. A CORS preflight
that your CORS middleware answers is not counted, and a refused request carries
your CORS headers, so a page on an allowed origin can read the `429` (add
`Retry-After` to the CORS `exposedHeaders` to let it read that header; the body
has `retryAfter` as well). The client is `req.ip`, or whatever `keyGenerator`
returns:

```typescript
app.use(
  middleware.rateLimit({
    requests: 1000,
    window: 60000,
    // Limit per API key; requests without one fall back to the client address
    keyGenerator: req => req.headers['x-api-key'] as string | undefined,
  })
);
```

Counters live in an in-memory store per process, capped at 100,000. When it is
full, expired counters go first, then the oldest counter that is not currently
refusing requests; a counter that is refusing requests is never dropped inside
its window. There is no `skip` option and no external store — a clustered
deployment limits per worker, so size the limit accordingly or terminate rate
limiting at your proxy.

---

## HTTP Features

### Body Size Limiting

Limit request body size to prevent memory issues.

```typescript
// Global body size limit
app.use(
  middleware.bodySize({
    limit: '10mb', // a size string ('500kb', '10mb') or a number of bytes
  })
);

// Per-route limit: a tighter cap on one endpoint, attached as route middleware.
// A larger body is answered with 413.
app
  .post('/api/comments')
  .before(middleware.bodySize({ limit: '100kb' }))
  .handler((req, res) => {
    return { success: true };
  });
```

### Cookie Parser

Parse and manage cookies easily.

```typescript
// Enable cookie parsing
app.use(
  middleware.cookie({
    secret: process.env.COOKIE_SECRET, // from the environment, never a literal
    signed: true,
  })
);

// Access cookies
app.get('/api/preferences', (req, res) => {
  const theme = req.cookies.theme;
  const user = req.signedCookies.user;

  return { theme, user };
});

// Set cookies
app.post('/api/preferences', (req, res) => {
  res.cookie('theme', req.body.theme, {
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year, in milliseconds
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
  });

  // Signed individually — no need for signed: true on the middleware
  res.cookie('user', user.id, { signed: true, httpOnly: true });

  return { success: true };
});
```

Signing uses HMAC-SHA256 over the value with your `secret`, and verification is
constant-time. Verified cookies arrive on `req.signedCookies`, never mixed into
`req.cookies`; a value whose signature fails appears in neither, so a tampered
cookie can't be mistaken for a valid one. `signed: true` on the middleware signs
every cookie by default and individual `res.cookie` calls can still opt out.
Setting a signed cookie without a configured `secret` throws rather than quietly
sending it in the clear, and so does `res.cookie(..., { signed: true })` when the
cookie middleware is not registered at all.

`maxAge` is in milliseconds, as in Express, and is sent as whole seconds of
`Max-Age`. A cookie name must be a valid cookie name (letters, digits and
``!#$%&'*+-.^_`|~``), `domain` a host name, `path` free of `;` and control
characters and `sameSite` one of `'strict'`, `'lax'`, `'none'`; anything else
throws a `TypeError` at the `res.cookie()` call instead of producing a header
that says something different.

With or without the middleware, `res.cookie()` and `res.clearCookie()` send the
same `Set-Cookie` for the same call: `Path` defaults to `/`, `maxAge: 0` is sent
as `Max-Age=0`, and the attributes come in one order (`Max-Age`, `Expires`,
`HttpOnly`, `Secure`, `SameSite`, `Domain`, `Path`). The only thing the
middleware adds to the value is the signature.

To change the secret without signing everyone out, pass the new one first and
keep the old one listed until the cookies it signed have expired. Cookies are
signed with the first secret and a cookie signed with any of them verifies:

```typescript
app.use(
  middleware.cookie({
    secret: [process.env.COOKIE_SECRET, process.env.COOKIE_SECRET_PREVIOUS],
  })
);
```

### Static Files

Serve static files with caching and ETags.

```typescript
// Basic static file serving
app.use(
  middleware.staticFiles({
    root: './public',
    maxAge: 3600, // seconds -> Cache-Control: public, max-age=3600
    index: ['index.html', 'index.htm'],
  })
);

// Full option surface
app.use(
  middleware.staticFiles({
    root: './public', // required; resolved to an absolute path
    prefix: '/assets', // URL mount point; defaults to the URL root
    maxAge: 86400, // seconds; 0 omits Cache-Control
    etag: true, // default true; enables conditional 304s
    lastModified: true, // default true; answers If-Modified-Since
    acceptRanges: true, // default true; serves Range requests as 206
    precompressed: true, // serve app.js.br / app.js.gz next to app.js when the client accepts it
    cache: true, // keep files in memory; see below (or { maxFileBytes, maxBytes, maxEntries, revalidateMs, watch })
    index: ['index.html', 'index.htm'],
    dotfiles: 'ignore', // 'allow' | 'deny' | 'ignore'
  })
);
```

`dotfiles` applies to every segment of the path below `root`, in the path as requested and in the
path it resolves to through links: `/.git/config` is hidden like `/.env` is. `'ignore'` (the
default) passes such a request on as if the file did not exist, `'deny'` answers 403, `'allow'`
serves it. A segment named exactly `.well-known` is never treated as hidden. A directory index is
served only when it resolves inside `root`, like any other file.

Without `cache`, every request resolves, stats and reads the file (and its sidecars) from disk:
five to eight filesystem round trips through the libuv threadpool per response, which is what
bounds a busy static route - and on the native engine's worker threads, one pool is shared by
every worker in the process. With `cache: true` a file at or below `maxFileBytes` (default 1 MiB)
is read once, together with its `.br` and `.gz` sidecars, and served from memory with its
`ETag` and `Last-Modified`; the sidecar is still negotiated per request from `Accept-Encoding`,
conditional and `HEAD` requests are answered from the entry, and `Range` requests and larger
files keep the uncached path. The disk is looked at again at most once per `revalidateMs`
(default 1000) - a stat of the file and of each sidecar position, so a same-length
replacement, a touched sidecar or one that appeared or vanished are all noticed and reloaded -
and sooner when the root directory reports a change (`watch`, default true where the platform
supports it). `maxBytes` (default 64 MiB) bounds the whole cache, each entry counted with its key
and a fixed overhead, and `maxEntries` (default 10,000) bounds the number of files held; the oldest
entries leave first. A file is held once, under its resolved path, however the request spells it.

With `precompressed: true`, a `.br` or `.gz` file beside an asset is served with the original's `Content-Type`, the matching `Content-Encoding` and `Vary: Accept-Encoding` (brotli preferred). A sidecar older than its source is ignored, so replacing an asset never serves a stale compressed body, and a sidecar must resolve inside `root`. Without sidecars, text assets still go through the server's response compression when `performance.compression` (or the compression middleware) is on.

Responses carry `ETag` and `Last-Modified`, and a conditional request on either
gets a 304 (`If-None-Match` wins when both are sent). `Range` requests are
answered with 206 and a `Content-Range` — what media seeking and resumable
downloads need — while an unsatisfiable range gets a 416. A request for several
ranges at once is answered with the whole entity rather than a multipart body,
and `If-Range` falls back to the full entity when the file has changed since.

Files above 512 KB are streamed rather than read into memory, so serving a large
asset doesn't cost its full size in RSS per request; a `Range` reads only the
requested slice. Small files keep the single-read path.

Without a `prefix`, files are served from the URL root:

```typescript
app.use(middleware.staticFiles({ root: './public' }));

// ./public/assets/app.css  ->  GET /assets/app.css
// ./public/uploads/a.png   ->  GET /uploads/a.png
```

With one, the prefix is stripped before the path is resolved against `root`, and
requests outside it fall straight through to the rest of your app:

```typescript
app.use(middleware.staticFiles({ root: './public', prefix: '/cdn' }));

// ./public/app.css   ->  GET /cdn/app.css
// ./public/index.html ->  GET /cdn
// GET /app.css       ->  not static; continues to your routes
```

Prefix matching is exact and case-sensitive, and `/cdn` never matches a sibling
path like `/cdn-backup`. Mount several roots by registering the middleware more
than once, each with its own prefix.

> Note the prefix belongs in the options object. `app.use('/cdn', middleware.staticFiles({ root: './public' }))`
> runs the middleware only for requests under `/cdn`, but the prefix is **not
> removed** from the path, so `GET /cdn/app.css` looks for `./public/cdn/app.css`.
> The `prefix` option is what maps `/cdn/app.css` to `./public/app.css`.

### File Upload

Handle multipart file uploads.

```typescript
// Basic file upload
app.use(
  middleware.upload({
    dest: './uploads',
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
  })
);

// Advanced upload with validation
app
  .post('/api/upload')
  .before(
    middleware.upload({
      dest: './uploads',
      maxFileSize: 5 * 1024 * 1024,
      maxFiles: 1,
      allowedTypes: ['image/jpeg', 'image/png', 'image/gif'],
      verifyContent: true, // the bytes must be one of those formats too
    })
  )
  .handler((req, res) => {
    const files = req.files;

    if (!files || Object.keys(files).length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    return {
      success: true,
      files: Object.values(files).map((f: any) => ({
        filename: f.filename,
        size: f.size,
        mimetype: f.mimetype,
        path: f.path, // reading it stores the file in dest and gives its path
      })),
    };
  });
```

Each uploaded file carries `filename` (sanitized to a basename), `mimetype`,
`size`, and `data` — the contents in memory. Without `dest`, nothing touches
disk. Files that fail validation are never written.

**When a file is written.** With `dest`, a file is stored when the handler asks
for it, and not before:

- reading `file.path` (or `file.destination`) writes the file, once, and returns
  where it went. The write is synchronous;
- `await file.save()` does the same without blocking and resolves to the path -
  the one to use for large files.

Stored names are randomized (`<16 hex characters>-<filename>`), so two uploads of
the same filename cannot overwrite each other. The middleware itself writes
nothing: registered with `app.use()` it runs before the request is routed, so a
request for a path that has no route, one that a guard or an auth check refused,
or one whose handler never looks at the file leaves nothing in `dest`. A handler
that wants every upload kept reads `file.path` or calls `file.save()`.

**When a file is removed again.** `cleanup` decides what happens to the files a
request stored once its response is over:

| `cleanup`            | Files the request stored are removed                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `'failed'` (default) | when the request is answered with a 4xx or 5xx                                                    |
| `'always'`           | when the response is over, whatever its status: `dest` is a staging area, move what you want kept |
| `'never'`            | never                                                                                             |

A file the handler has already moved or deleted is left alone. Under `'failed'`, a client that disconnects before the handler has answered does not count as a failure: the handler may still be running, and what it stored stays.

```typescript
import { rename } from 'node:fs/promises';

app
  .post('/api/import')
  .before(middleware.upload({ dest: './tmp/uploads', cleanup: 'always' }))
  .handler(async (req, res) => {
    const file = req.files?.data;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const staged = await file.save();
    await rename(staged, `./imports/${Date.now()}.csv`); // kept: it is no longer in dest
    return { success: true };
  });
```

**Checking the type.** `allowedTypes` compares the type the client declared for
the part, which the client chooses. `verifyContent: true` also reads the file's
first bytes: a file declared as a type that has a signature (JPEG, PNG, GIF,
WebP, BMP, TIFF, ICO, AVIF, HEIC, PDF, ZIP and the ZIP-based office formats,
gzip, MP4, QuickTime, WebM, MP3, WAV, Ogg, FLAC, WOFF, WOFF2) must carry it, and
a file of a recognisable type that `allowedTypes` does not list is refused even
when it is declared as something else. Both are answered `400`. Text formats
(HTML, SVG, CSV, JSON) have no signature, so a declared text type cannot be
confirmed this way. With `verifyContent`, a stored file also gets the extension
of its type rather than the one the client sent (`page.html` uploaded as
`image/png` is stored as `…-page.png`); `file.filename` still holds the
client's name. Serve user uploads from a directory of their own, and never from
one where a stored `.html` or `.svg` would be served as a page.

There is no per-field configuration — `maxFiles`, `maxFileSize`,
`allowedTypes` and `verifyContent` apply to the whole request.

### Template Rendering

Render `.html` templates from a views directory with the built-in engine.

```typescript
// Configure template engine
app.use(
  middleware.template({
    views: './views', // res.render('index') reads ./views/index.html
    cache: true,
    defaultLayout: 'layout', // ./views/layouts/layout.html
  })
);

// Render a template
app.get('/page', (req, res) => {
  res.render('index', {
    title: 'Welcome',
    user: req.user,
  });
});
```

**Template Syntax (Moro Engine):**

Values are **HTML-escaped by default** (Mustache/Handlebars convention). Use the triple-brace form `{{{var}}}` to emit raw HTML when you trust the source.

```html
<!-- variables (HTML-escaped) -->
<h1>{{title}}</h1>
<p>{{user.name}}</p>

<!-- raw output — only use with trusted, pre-sanitized HTML -->
<div>{{{trustedHtml}}}</div>

<!-- loops -->
{{#each items}}
<li>{{name}}</li>
{{/each}}

<!-- conditionals -->
{{#if user}}
<p>Welcome, {{user.name}}</p>
{{/if}}
```

A render that fails (a view that does not exist, a file that cannot be read) is answered `500` with `{ "success": false, "error": "Template rendering failed" }`, and the reason is written to the log. Outside production (`NODE_ENV` other than `production`) the body also carries the reason as `details`, which can include the path of the view on disk: run production with `NODE_ENV=production`.

### HTTP Range Requests

Support partial content requests for streaming.

```typescript
// Enable range requests
app.use(
  middleware.range({
    acceptRanges: 'bytes',
    maxRanges: 5,
    root: './videos', // confine sendRange() to this directory
  })
);

// Serve video with range support
app.get('/videos/:id', async (req, res) => {
  // sendRange handles partial content automatically: 206 for a Range request,
  // 416 for an unsatisfiable one, 404 if the file is missing
  await res.sendRange(`${req.params.id}.mp4`);
});

// A call can name its own root, which overrides the middleware's
app.get('/download/:file', async (req, res) => {
  await res.sendRange(`${req.params.file}`, { root: './files' });
});
```

`root` is optional. When it is set, the path is resolved against that directory
and anything that leads outside it - `../`, an absolute path, a symlink pointing
out - is answered with a 404. Route params arrive percent-decoded (`..%2F` is
`../` by the time the handler runs), so set `root` whenever a path is built from
one. Without it, `sendRange()` serves the path exactly as given.

The response carries the file's own `Content-Type` (by extension, with the table
`staticFiles` uses: `.mp4` is `video/mp4`) unless the handler set one before the
call, and `X-Content-Type-Options: nosniff`.

`dotfiles` is the policy `staticFiles` has, set on the middleware or per call
(`res.sendRange(file, { dotfiles: 'allow' })`): `'ignore'` (the default) answers
a hidden path with a 404, `'deny'` with a 403, `'allow'` serves it. With a
`root`, a path is hidden when any segment below the root starts with a dot, in
the path as given or in the path it resolves to; without one, when the file's
own name does. A segment named `.well-known` is never hidden.

### HTTP/2 Server Push

Optimize loading with HTTP/2 server push.

```typescript
// Auto-detect and push resources
app.use(
  middleware.http2.push({
    autoDetect: true, // Detect CSS/JS from HTML
    resources: [
      {
        path: '/styles/main.css',
        as: 'style',
        type: 'text/css',
        priority: 200,
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

// Manual push in route
app.get('/', (req, res) => {
  if (res.push) {
    res.push('/critical.css', {
      headers: { 'content-type': 'text/css' },
      priority: 200,
    });
  }

  return res.sendFile('./public/index.html');
});
```

See [HTTP/2 Guide](./HTTP2_GUIDE.md) for detailed documentation.

---

## Authentication & Sessions

### Authentication

`middleware.auth()` (also exported as `auth`) sets `req.auth`: from a verified `Authorization: Bearer` JWT, or from a [Better Auth](https://better-auth.com/) session when providers are configured and the `better-auth` package is installed, in which case it also serves the sign-in routes under `/api/auth`. The [Authentication Guide](./AUTH_GUIDE.md) has complete samples for each.

```typescript
import { middleware, providers } from '@morojs/moro';

// Configure authentication
app.use(
  middleware.auth({
    secret: process.env.AUTH_SECRET,
    baseURL: process.env.BASE_URL, // the public URL of the app
    providers: [
      providers.google({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      }),
    ],
    session: {
      maxAge: 30 * 24 * 60 * 60, // 30 days
    },
    // Bearer tokens for API clients: only tokens issued for this audience
    jwt: { audience: 'my-api' },
  })
);

// Protected route: any signed-in user
app
  .get('/api/profile')
  .auth({})
  .handler((req, res) => {
    return { user: req.auth.user };
  });

// Role-based access
app
  .get('/api/admin')
  .auth({
    roles: ['admin'],
  })
  .handler((req, res) => {
    return { admin: true };
  });

// Permission-based access
app
  .delete('/api/users/:id')
  .auth({
    permissions: ['users:delete'],
  })
  .handler((req, res) => {
    return deleteUser(req.params.id);
  });

// A check of the request itself: the signed-in user owns the record
app
  .get('/api/users/:id/orders')
  .auth({
    required: true,
    validator: req => req.auth.user.id === req.params.id || req.auth.user.roles.includes('admin'),
  })
  .handler((req, res) => {
    return getUserOrders(req.params.id);
  });
```

`validator(req)` runs after the sign-in, role and permission checks and may be
async. A falsy result or a throw denies the request with `403` (`401` when
nobody is signed in and the route sets `required: true`), and the handler does
not run. It runs in the auth phase, so it has decided before the route's cache
is looked up. See [Security Methods](./API.md#security-methods) for the
details.

**Auth Helpers:**

```typescript
import { requireAuth, requireRole, requirePermission } from '@morojs/moro';

// Helper functions: standard middleware, attached to the route with .before()
app
  .get('/api/profile')
  .before(requireAuth())
  .handler((req, res) => {
    return req.auth.user;
  });

app
  .get('/api/admin')
  .before(requireRole('admin'))
  .handler((req, res) => {
    return { admin: true };
  });

app
  .delete('/api/users/:id')
  .before(requirePermission('users:delete'))
  .handler((req, res) => {
    return deleteUser(req.params.id);
  });

app
  .get('/api/feed')
  .before(requireAuth({ allowUnauthenticated: true }))
  .handler((req, res) => {
    // Works with or without authentication
    return getFeed(req.auth.user?.id);
  });
```

See [Authentication Guide](./AUTH_GUIDE.md) for complete documentation.

### Session Management

Server-side session storage.

```typescript
// Memory-based sessions
app.use(
  middleware.session({
    secret: process.env.SESSION_SECRET, // from the environment, never a literal
    store: 'memory',
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
    },
  })
);

// Redis sessions
app.use(
  middleware.session({
    secret: process.env.SESSION_SECRET,
    store: 'redis',
    storeOptions: {
      host: 'localhost', // or url: process.env.REDIS_URL (node-redis 4+)
      port: 6379,
      password: process.env.REDIS_PASSWORD,
    },
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// Using sessions
app.post('/login', async (req, res) => {
  // ...verify the credentials and load `user` first...

  // Rotate the session id at login: the browser is sent the new id and the
  // old one stops working. The session starts empty, so set its data after.
  await req.session.regenerate();
  req.session.userId = user.id;
  req.session.role = user.role;
  return { success: true };
});

app.get('/profile', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return { userId: req.session.userId };
});

app.post('/logout', async (req, res) => {
  await req.session.destroy(); // removes the stored session and clears the cookie
  return { success: true };
});
```

With a `secret`, the session id is signed in the cookie and verified on the way
back in; an id that fails verification starts a fresh session instead of loading
one. Without a secret the id is stored as-is. `secret` may be an array, to rotate
keys: the id is signed with the first secret and a cookie signed with any listed
secret is still accepted.

The session cookie's defaults are `maxAge` 24 hours, `HttpOnly`, `SameSite=Lax`
and `Path=/`. What you pass in `cookie` is laid over them one key at a time, so
`cookie: { maxAge }` on its own still sends `HttpOnly` and `SameSite=Lax`; turn
one off by naming it (`httpOnly: false`). `maxAge` is in milliseconds and also
sets how long the stored session is kept; `maxAge: null` sends no `Max-Age` (the
cookie lasts until the browser closes) and keeps the stored session for 24 hours.

Any name you assign on `req.session` is a session field, except the session's
own members, which can be read but not written from a handler: `id` and
`sessionID` (the session id), `data` (all the fields, as one object), `isNew`,
`isModified`, and the methods `save()`, `destroy()`, `regenerate()` and
`touch()`. A write to one of those (`req.session.id = ...`, or
`Object.assign(req.session, req.body)` with an `id` or `data` key in the body) is
ignored with a warning and stores nothing, so request input cannot pick the
session id or replace the stored fields wholesale. Use other names for your own
fields. The signing secret and the store are not reachable from `req.session`.

Unless `cookie.secure` says otherwise, the session cookie is `Secure` when the
request arrived over TLS: a TLS connection to this server, or
`X-Forwarded-Proto: https` from a proxy named in `server.trustProxy`. Over plain
HTTP it is not. `cookie: { secure: true }` always marks it, `cookie: { secure:
false }` never does (unless `proxy` applies).

With `proxy: true` the cookie is also marked `Secure` when `X-Forwarded-Proto`
says `https`. Once `server.trustProxy` is set, that header counts only when it
comes from a trusted proxy.

A session id is never written to the log. Log lines of the session middleware
and of the store it uses name a session by a short tag such as `#1990b91c(48)`
(a hash of the id, and its length): the same session always has the same tag,
and the id cannot be read back from it.

`req.session.regenerate()` and `req.session.destroy()` write the session cookie,
so call them before the response is sent.

The `'redis'` store loads the `redis` package (node-redis 4+). While Redis cannot
be reached, a request that carries a session cookie waits up to 5 seconds for
it and is then served without session data. The browser keeps its session id
(no new cookie is issued) and nothing is written to that session during the
request, so the session is there again once Redis is. `req.session.regenerate()`
still starts a new session. A custom store gets the same treatment when its
`get()` rejects; a `get()` that resolves to `null` means "no such session" and
starts a new one. To run the store on a client you already have (node-redis 4+
or ioredis), pass `store: new RedisCacheAdapter({ client, keyPrefix: 'sess:' })`.

The memory store belongs to the process, or with `performance.clustering` to
the one worker, that created the session: a later request answered by another
worker does not find it (measured with four workers on Linux: 11 of 40 reads
found the session). With more than one worker, or more than one instance, use
the Redis store.

---

## Content Delivery

### CDN Integration

Integrate with CDN providers for asset delivery.

```typescript
// CloudFront integration
app.use(
  middleware.cdn({
    adapter: 'cloudfront', // 'cloudflare', 'cloudfront', 'azure', or a CDNAdapter instance
    adapterOptions: {
      distributionId: 'E1234567890ABC',
      region: 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    // After a successful write to a matching path, purge that path.
    // Patterns are regular expressions tested against the request path.
    autoInvalidate: true,
    invalidationPatterns: ['^/assets/'],
  })
);

// Cloudflare integration
app.use(
  middleware.cdn({
    adapter: 'cloudflare',
    adapterOptions: {
      zoneId: process.env.CLOUDFLARE_ZONE_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
    },
  })
);

// Purge cache: the middleware adds purgeCDN() to the response
app.post('/api/deploy', async (req, res) => {
  await res.purgeCDN?.(['/assets/app.js', '/assets/app.css']);
  return { success: true };
});
```

The CloudFront adapter calls AWS through an SDK installed in your application: `npm install @aws-sdk/client-cloudfront` (AWS SDK v3, 3.974.0 or later). The older `aws-sdk` package (v2) is used when that one is not installed, and the adapter then logs one warning at start-up: v2 has a published advisory ([GHSA-j965-2qgj-vjmq](https://github.com/advisories/GHSA-j965-2qgj-vjmq)) that no v2 release fixes. Without `accessKeyId` and `secretAccessKey` the v3 SDK finds credentials itself (environment, instance or task role).

### Server-Sent Events (SSE)

Real-time updates with SSE, streamed from a route handler: with the response's own `writeHead()` and `write()`, or with the helpers `middleware.sse()` adds (below).

```typescript
// Open an event stream from a route handler
const openStream = res => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 10000\n\n'); // Tell the client to reconnect after 10s
};

// One event: an optional name, then the data, then a blank line
const sendEvent = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

// SSE endpoint
app.get('/events', (req, res) => {
  openStream(res);

  // Send events
  const interval = setInterval(() => {
    sendEvent(res, 'update', { timestamp: Date.now() });
  }, 5000);

  // Cleanup on close
  req.on('close', () => {
    clearInterval(interval);
  });
});

// Broadcast to all clients
const clients = new Set();

app.get('/stream', (req, res) => {
  openStream(res);
  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

app.post('/broadcast', (req, res) => {
  clients.forEach(client => {
    sendEvent(client, 'notification', req.body);
  });

  return { sent: clients.size };
});
```

#### `middleware.sse()`

`middleware.sse()` gives every response the helpers that do this formatting for you. It opens nothing on its own: a request is answered with an event stream only when its handler asks for one, after the route's own middleware and guards have run. A request for a path that has no route still gets its 404, and one a guard refuses still gets its 401 or 403, whatever its `Accept` header says.

```typescript
app.use(middleware.sse({ heartbeat: 30000, retry: 3000 }));

app.get('/events', (req, res) => {
  // Opens the stream: 200, Content-Type: text/event-stream, the retry line,
  // and a heartbeat comment every 30 seconds until the connection closes
  const stream = res.sse!(); // installed by middleware.sse()

  const interval = setInterval(() => {
    stream.sendEvent({ timestamp: Date.now() }, 'update');
  }, 5000);

  req.on('close', () => clearInterval(interval));
});
```

| Helper                             | What it does                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `res.sse()`                        | Opens the stream and returns its connection: `{ sendEvent, sendComment, sendRetry, close }`         |
| `res.sendEvent(data, event?, id?)` | Sends one event. Objects are sent as JSON; a multi-line string is sent as one `data:` line per line |
| `res.sendComment(text)`            | Sends a comment line (`: text`), which clients ignore                                               |
| `res.sendRetry(ms)`                | Tells the client how long to wait before reconnecting                                               |
| `stream.close()`                   | Stops the heartbeat and ends the response                                                           |

`res.sendEvent()`, `res.sendComment()` and `res.sendRetry()` open the stream themselves on first use, so a handler can skip `res.sse()`. Line breaks in `event` and `id` are removed, so a value can never start a new field or a new event.

| Option      | Type      | What it does                                                             |
| ----------- | --------- | ------------------------------------------------------------------------ |
| `heartbeat` | `number`  | Milliseconds between `: heartbeat` comments on an open stream. Off unset |
| `retry`     | `number`  | Reconnection delay in milliseconds, sent when a stream opens. Off unset  |
| `cors`      | `boolean` | Adds `Access-Control-Allow-Origin: *` to the stream's response           |

The helpers are typed as optional on the response (they exist only when the middleware is installed), hence the `!` above in TypeScript.

---

## Monitoring & Logging

### Request Logger

Log every request and how long it took, through the framework logger. It takes no options.

```typescript
app.use(middleware.requestLogger());
```

### Performance Monitor

Detect slow requests: any request that takes longer than one second is logged as a warning with its method, path and duration. It takes no options.

```typescript
app.use(middleware.performanceMonitor());
```

### Error Tracker

Log request errors (message, stack, URL and method) through the framework logger, then pass the error on so your error handler still runs. To report to an external service, write an error-handling middleware (see [Custom Middleware](#custom-middleware)).

```typescript
app.use(middleware.errorTracker());
```

Query strings carry credentials (OAuth codes, password-reset tokens, signed-URL signatures), so the logged URL has the values of these parameters replaced with `REDACTED`, whatever their case: `token`, `access_token`, `refresh_token`, `id_token`, `code`, `key`, `api_key`, `apikey`, `password`, `secret`, `client_secret`, `signature`, `sig`, `AWSAccessKeyId`, `X-Amz-Signature`, `X-Amz-Security-Token` and `X-Goog-Signature`. A request for `/reset?email=ada%40example.com&token=9f8e7d` is logged as `/reset?email=ada%40example.com&token=REDACTED`.

| Option                | Type                | Default        | What it does                                                                            |
| --------------------- | ------------------- | -------------- | --------------------------------------------------------------------------------------- |
| `redactedQueryParams` | `string[] \| false` | the list above | An array replaces the list of parameter names; `false` logs the URL exactly as received |

```typescript
app.use(middleware.errorTracker({ redactedQueryParams: ['invite', 'token'] }));
```

### OpenTelemetry

`middleware.openTelemetry()` opens one server span per request and records the HTTP server metrics through the OpenTelemetry SDK your application registers (it needs the optional `@opentelemetry/api` peer dependency). The `url.query` span attribute gets the same treatment as the error tracker's URL: the values of the parameters listed above are recorded as `REDACTED`, and `redactedQueryParams` takes your own list or `false`.

```typescript
app.use(
  middleware.openTelemetry({
    ignorePaths: ['/health'],
    redactedQueryParams: ['invite', 'token'], // default: the built-in list; false records the raw query
  })
);
```

---

## Advanced Features

### GraphQL

GraphQL API support.

```typescript
// GraphQL is configured on the app (requires the `graphql` package)
app.graphqlInit({
  typeDefs: `
    type Query {
      hello: String
      user(id: ID!): User
    }

    type User {
      id: ID!
      name: String!
      email: String!
    }
  `,
  resolvers: {
    Query: {
      hello: () => 'Hello world!',
      user: (_parent, { id }) => getUser(id),
    },
  },
  path: '/graphql', // default
  enablePlayground: true, // playground at /graphql/playground, outside production
  context: (req, res) => ({
    request: req,
    response: res,
    user: req.user,
    db: req.db,
  }),
});
```

`middleware.graphql(options)` takes the same options and serves the same endpoint and playground:

```typescript
app.use(
  middleware.graphql({
    typeDefs: `
      type Query {
        hello: String
      }
    `,
    resolvers: {
      Query: {
        hello: () => 'Hello world!',
      },
    },
  })
);
```

Installed this way, the GraphQL path is answered before the `app.use()` middleware chain and the routes run, so middleware registered with `app.use()` (authentication, rate limiting) does not apply to it. Subscriptions, `app.getGraphQLSchema()` and `app.getGraphQLStats()` belong to `app.graphqlInit()`.

See [GraphQL Guide](./GRAPHQL_GUIDE.md) for detailed documentation.

### Validation

Request validation with multiple libraries.

```typescript
import { z } from 'zod';

// Zod validation
app
  .post('/api/users')
  .body(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
      age: z.number().min(18),
    })
  )
  .handler((req, res) => {
    // req.body is fully typed and validated
    return createUser(req.body);
  });

// Multiple validations
app
  .post('/api/search')
  .query(
    z.object({
      q: z.string().min(1),
      page: z.coerce.number().default(1),
    })
  )
  .body(
    z.object({
      filters: z.array(z.string()).optional(),
    })
  )
  .handler((req, res) => {
    return search(req.query.q, req.query.page, req.body.filters);
  });
```

---

## Custom Middleware

### Creating Custom Middleware

```typescript
// Simple middleware
const customLogger = (req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
};

app.use(customLogger);

// Async middleware
const loadUser = async (req, res, next) => {
  if (req.headers.authorization) {
    req.user = await getUserFromToken(req.headers.authorization);
  }
  next();
};

app.use(loadUser);

// Middleware with options
const createRateLimiter = options => {
  const requests = new Map();

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const windowStart = now - options.window;

    // Clean old entries
    const userRequests = requests.get(key) || [];
    const validRequests = userRequests.filter(time => time > windowStart);

    if (validRequests.length >= options.max) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    validRequests.push(now);
    requests.set(key, validRequests);
    next();
  };
};

app.use(createRateLimiter({ max: 100, window: 60000 }));

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  console.error(err);

  res.status(err.statusCode || 500).json({
    success: false,
    error: err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

app.use(errorHandler);
```

### Middleware for a Path Prefix

`app.use(prefix, fn)` runs a `(req, res, next)` middleware only for the
requests at or under a path prefix:

```typescript
const requireAdminToken = (req, res, next) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

app.use('/admin', requireAdminToken);

app.get('/admin/users', listUsers); // guarded
app.get('/administrator', publicPage); // not under /admin: not guarded
```

- The prefix matches whole segments: `/admin` covers `/admin`, `/admin/` and
  `/admin/users/7`. It is compared with `req.path` as the request arrived,
  case-sensitively. A request whose path has an empty segment
  (`//admin/users/7`) matches no route at all, so it cannot reach a handler
  behind the prefix.
- The request is passed on unchanged: unlike Express, `req.url` and `req.path`
  keep the prefix and there is no `req.baseUrl`.
- It is part of the global chain and runs in registration order with the
  other `app.use()` middleware, ahead of every route feature, for routes
  registered on the app and module routes alike.
- A four-parameter error middleware can be mounted the same way.

`app.use()` rejects with an error naming what it was given when it cannot
register it: a function that declares two parameters, a plain object, or a
prefix followed by anything other than a middleware function or a
`createRouter()` instance. That includes the hook-based built-ins
(`rateLimit`, `cors`, `cache`, `csrf`, ...), which install for every request:
scope those on the routes themselves, for example with `.rateLimit()`. Middleware functions are recognised by their
parameter count, so declare all three parameters (`(req, res, next)`) without
default values or rest syntax.

### Route Middleware and `next()`

There are two contracts for the middleware attached to a route (`.before()`,
`.use()`, `.after()`, `.transform()`, the `middleware` option of a route) or
listed on a module or a module route:

- **Default: the request goes on when the middleware returns.** A route's
  middleware is done when it returns, or when the promise it returns settles.
  If it has not answered the request by then, the next middleware and the
  handler run, whether or not `next()` was called. (A module's middleware
  that returns no promise is the exception: it is waited for.)
- **Strict (`routing.strictMiddleware`): the request waits for `next()`.** A
  middleware declared `(req, res, next)` passes the request on only by calling
  `next()`, now or later from a callback, as in Express.

`next(err)`, a throw and a rejected promise stop the request under both, and
a middleware that answers the request ends it there.

The default lets a guard that returns early without answering pass the
request through, and runs the handler before a callback has finished:

```typescript
const ownerOnly = async (req, res, next) => {
  if (req.user?.id !== req.params.id) return; // nothing sent: the handler still runs
  next();
};

const loadAccount = (req, res, next) => {
  accounts.find(req.params.id, (err, account) => {
    req.account = account;
    next(err); // too late by default: the handler has already run
  });
};
```

Turn the strict contract on for the app:

```typescript
const app = await createApp({ routing: { strictMiddleware: true } });
```

With it, for a middleware declared with three parameters:

- `next()` passes the request on whenever it is called: before the middleware
  returns, before its promise settles, or later from a callback. `loadAccount`
  above works as it is written;
- a middleware that answers the request ends it there, as always;
- an async middleware whose promise resolves when it has neither called
  `next()` nor answered has nowhere left to call `next()` from: the request is
  answered with a 500 and one line in the error log names the route and the
  middleware (its function name, or its place in the list). `ownerOnly` above
  answers 500 for another user's record instead of letting the request
  through. A `next()` that arrives after that is ignored;
- a middleware that returns no promise and has neither called `next()` nor
  answered is waited for, as in Express. If it never does either, the request
  stays open until the client or a server timeout ends it, and the handler
  does not run. After 30 seconds one warning in the log names the route and
  the middleware, so a forgotten `next()` can be found;
- `next(err)`, a throw and a rejected promise are what they are without it.

What it does not change:

- a function declared with fewer than three parameters has no `next()` to
  call and is treated as without the option;
- `app.use()` middleware, which already waits: on every server a
  three-parameter `app.use()` middleware that returns without calling `next()`
  and without answering is waited for, and one whose promise resolves passes
  the request on;
- the route's own `auth`, `rateLimit`, validation and cache;
- a module's or a module route's middleware that returns no promise: that one
  is waited for with the option and without it. On a module the option changes
  the async case only.

The option is read when routes are registered, so set it in `createApp()`,
the configuration file or `MORO_ROUTING_STRICT_MIDDLEWARE=true`. It is off by
default. A middleware that calls `next()` before it returns costs nothing
more with it.

### Middleware Execution Order

Route features execute in a fixed order, regardless of the order you chain
them. Global middleware (`app.use()`) runs ahead of all of it:

1. **SECURITY** - CORS, Helmet, CSRF, CSP (global middleware)
2. **PARSING** - Body parsing, Cookie parsing, Body size (global middleware)
3. **`.before()`** - your custom middleware, ahead of every route feature
4. **RATE_LIMITING** - `.rateLimit()`, keyed by client IP + method:path
5. **AUTHENTICATION** - `.auth()`
6. **VALIDATION** - `.body()` / `.query()` / `.params()` / `.headers()` / `.validate()`
7. **`.transform()`** - your custom middleware, post-validation
8. **`.after()` / `.use()`** - your custom middleware (and the `middleware` array of `app.get(path, handler, { middleware })`)
9. **CACHING** - `.cache()` lookup (a hit responds here and skips the handler)
10. **HANDLER** - `.handler()`

Rate limiting runs before authentication and validation on purpose: an
over-limit client is rejected before any token verification or schema parsing
is done on its behalf.

The cache is looked up last on purpose: a stored response is served only to a
request that every guard of the route let through, wherever the guard was
attached (`.before()`, `.auth()`, `.use()`, `.after()`). Middleware attached
with `.use()` / `.after()` therefore runs on cache hits as well.

Global middleware is in front of every route on every backend and runtime. That
includes routes whose handler is a literal body or `param()`, which the native
engine answers by itself only for an app with no global middleware and no
request hooks, and it includes the function `app.getHandler()` returns on AWS
Lambda, Vercel Edge and Cloudflare Workers (see
[Global Middleware and Hooks](./RUNTIME.md#global-middleware-and-hooks) for
what a serverless response does differently).

```typescript
// Chained in "wrong" order on purpose - execution order is unaffected.
// .handler() is terminal: it registers the route and returns nothing,
// so it must come last.
app
  .post('/api/users')
  .cache({ ttl: 30 }) // 9. Caching (ttl is in SECONDS)
  .validate({ body: UserSchema }) // 6. Validation
  .auth({ roles: ['admin'] }) // 5. Authentication
  .rateLimit({ requests: 10, window: 60_000 }) // 4. Rate limiting
  .handler(createUser); // 10. Handler - always last
```

> **Note:** CORS and other security middleware are applied globally with
> `app.use(middleware.cors({ ... }))`, not per route — there is no
> `.cors()` method on the route builder.

---

## Best Practices

### 1. Use Global Middleware for Cross-Cutting Concerns

```typescript
// Apply to all routes
app.use(middleware.helmet());
app.use(middleware.cors({ origin: process.env.ALLOWED_ORIGINS }));
app.use(middleware.compression());
app.use(middleware.requestLogger());
```

### 2. Use Per-Route Middleware for Specific Requirements

```typescript
// Only for specific routes
app
  .post('/api/upload')
  .before(middleware.upload({ maxFileSize: 10 * 1024 * 1024 }))
  .handler(handleUpload);

app
  .get('/api/admin')
  .auth({ roles: ['admin'] })
  .handler(getAdminData);
```

### 3. Configure Middleware Based on Environment

```typescript
const app = await createApp({
  cors:
    process.env.NODE_ENV === 'production'
      ? { origin: process.env.ALLOWED_ORIGINS }
      : { origin: '*' },

  compression: process.env.NODE_ENV === 'production',

  helmet: process.env.NODE_ENV === 'production',
});
```

### 4. Use Caching Strategically

```typescript
// Cache expensive queries
app
  .get('/api/reports/:id')
  .cache({ ttl: 3600, key: req => `report:${req.params.id}` })
  .handler(generateReport);
```

### 5. Combine Middleware for Complete Protection

```typescript
app
  .post('/api/payment')
  .auth({})
  .rateLimit({ requests: 5, window: 60000 })
  .validate({ body: PaymentSchema })
  .handler(processPayment);
```

---

## Performance Considerations

### Middleware Impact on Performance

| Middleware    | Overhead   | When to Use              |
| ------------- | ---------- | ------------------------ |
| `cors`        | Minimal    | Always for public APIs   |
| `helmet`      | Minimal    | Always for security      |
| `compression` | Medium     | For large responses      |
| `cache`       | Low        | For expensive operations |
| `rateLimit`   | Low        | For abuse prevention     |
| `auth`        | Medium     | For protected routes     |
| `validation`  | Low-Medium | For data validation      |
| `upload`      | High       | Only when needed         |

### Optimization Tips

1. **Use caching for expensive operations**
2. **Enable compression for large responses**
3. **Apply rate limiting to prevent abuse**
4. **Use validation to fail fast on bad input**
5. **Profile middleware impact in production**

---

## Reference

For more information, see:

- [API Reference](./API.md) - Complete API documentation
- [Authentication Guide](./AUTH_GUIDE.md) - Auth setup and RBAC
- [HTTP/2 Guide](./HTTP2_GUIDE.md) - HTTP/2 server push
- [GraphQL Guide](./GRAPHQL_GUIDE.md) - GraphQL integration
- [Performance Guide](./PERFORMANCE.md) - Optimization strategies

---

**Need help?** Join our [Discord community](https://morojs.com/discord) or [open an issue](https://github.com/Moro-JS/moro/issues).
