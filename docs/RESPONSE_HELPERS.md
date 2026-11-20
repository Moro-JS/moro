# MoroJS Response Helpers

Complete reference for standardized API response helpers in MoroJS.

## Table of Contents

- [Overview](#overview)
- [Types](#types)
- [HttpResponse Methods](#httpresponse-methods)
  - [Core Methods](#core-methods)
  - [Success Responses](#success-responses)
  - [Error Responses](#error-responses)
  - [Header & State Utilities](#header--state-utilities)
- [Standalone Helper Functions](#standalone-helper-functions)
- [ResponseBuilder](#responsebuilder)
- [Important: Return Values vs HTTP Status Codes](#important-return-values-vs-http-status-codes)

---

## Overview

MoroJS provides three layers of response helpers:

| Layer                | Sets HTTP Status? | Sends Response? | Import                                           |
| -------------------- | ----------------- | --------------- | ------------------------------------------------ |
| `res.*` methods      | Yes               | Yes             | Available on every `res` object                  |
| Standalone functions | No                | No              | `import { response } from '@morojs/moro'`        |
| `ResponseBuilder`    | No                | No              | `import { ResponseBuilder } from '@morojs/moro'` |

All responses follow a consistent shape:

```typescript
// Success
{ success: true, data: T, message?: string }

// Error
{ success: false, error: string, code?: string, message?: string }
```

---

## Types

All handler signatures use `HttpRequest` and `HttpResponse` from `@morojs/moro`:

```typescript
import { HttpRequest, HttpResponse } from '@morojs/moro';
```

### HttpRequest

Extends Node's `IncomingMessage` with parsed properties:

```typescript
interface HttpRequest extends IncomingMessage {
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  path: string;
  headers: Record<string, string>;
  ip: string;
  requestId: string;
  cookies?: Record<string, string>;
  files?: Record<string, any>;
  [key: string]: any;
}
```

### HttpResponse

Extends Node's `ServerResponse` with all the methods documented below:

```typescript
type HttpResponse = ServerResponse & MoroResponseMethods;
```

### Handler Signatures

```typescript
type HttpHandler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;

type Middleware = (req: HttpRequest, res: HttpResponse, next: () => void) => Promise<void> | void;
```

### CookieOptions

```typescript
interface CookieOptions {
  maxAge?: number | null; // lifetime in milliseconds; sent as whole seconds of Max-Age
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  domain?: string;
  path?: string;
  signed?: boolean; // sign the value; needs middleware.cookie({ secret })
  critical?: boolean;
  throwOnLateSet?: boolean;
}
```

### ResponseState

```typescript
interface ResponseState {
  headersSent: boolean;
  statusCode: number;
  headers: Record<string, any>;
  finished: boolean;
  writable: boolean;
}
```

---

## HttpResponse Methods

Every `res` object has the following methods. They are all part of the `MoroResponseMethods` interface merged onto Node's `ServerResponse`, and are available on every server: the native engine, the Node.js HTTP server and the Node.js HTTP/2 server.

### Core Methods

#### res.json(data)

Serializes `data` as JSON and sends it. Sets `Content-Type: application/json`.

```typescript
handler: (req, res) => {
  res.json({ hello: 'world' });
};
```

`res.json(undefined)` sends an empty body with the JSON content type and the status that was set. With status `204` nothing is sent after the head, and the head carries no `Content-Length`.

---

#### res.status(code)

Sets the HTTP status code. Returns `res` for chaining.

```typescript
handler: (req, res) => {
  res.status(201).json({ success: true, data: newUser });
};
```

---

#### res.send(data)

Sends a string or Buffer response.

```typescript
handler: (req, res) => {
  res.send('Hello, world');
};
```

---

#### res.cookie(name, value, options?)

Sets a cookie on the response. Returns `res` for chaining.

| Parameter | Type                       |
| --------- | -------------------------- |
| `name`    | `string`                   |
| `value`   | `string`                   |
| `options` | `CookieOptions` (optional) |

```typescript
handler: (req, res) => {
  res
    .cookie('session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours, in milliseconds
    })
    .json({ success: true });
};
// Set-Cookie: session=...; Max-Age=86400; HttpOnly; Secure; SameSite=strict; Path=/
```

- `maxAge` is the cookie's lifetime in **milliseconds**, as in Express. It is sent as whole seconds
  of `Max-Age` (`maxAge: 1500` becomes `Max-Age=1`); `maxAge: 0` expires the cookie at once and
  `maxAge: null` sends no `Max-Age`. No `Expires` is derived from it: pass `expires` when you want
  that attribute as well. A lifetime written in seconds (`maxAge: 3600`) is read as 3.6 seconds, so
  check values carried over from code written for earlier versions, where the number was sent as
  `Max-Age` unchanged.
- `Path` defaults to `/`.
- The same call sends the same `Set-Cookie` value on every server (the native engine, the Node.js
  HTTP/1 and HTTP/2 servers, the serverless runtimes) and through the cookie middleware: the
  attributes come in one order (`Max-Age`, `Expires`, `HttpOnly`, `Secure`, `SameSite`, `Domain`,
  `Path`), and `res.clearCookie(name, options)` sends `Max-Age=0` and an `Expires` in the past with
  the `path`, `domain`, `httpOnly`, `secure` and `sameSite` you pass. `expires` is a `Date`.
- `secure` left out follows the connection: the cookie is `Secure` when the request arrived over
  TLS, and is not when it arrived over plain HTTP. "Over TLS" is a TLS connection to this server
  (`server.ssl`), or `X-Forwarded-Proto: https` from a proxy named in `server.trustProxy`; a
  forwarded header from anyone else does not count, so behind a proxy that terminates TLS either
  set `server.trustProxy` or pass `secure: true`. `secure: true` and `secure: false` are taken as
  written. `res.clearCookie()` follows the same rule. `sameSite: 'none'` on a cookie that is not
  `Secure` logs one warning, because browsers drop such a cookie.
- The value is URL-encoded. The name and the attribute values are checked instead, because they are
  written into the header as given: a name that is not a valid cookie name (letters, digits and
  ``!#$%&'*+-.^_`|~``), a `domain` that is not a host name, a `path` holding `;` or a control
  character, or a `sameSite` other than `'strict'`, `'lax'` or `'none'` throws a `TypeError` at the
  call.
- `signed: true` needs the cookie middleware, which holds the secret:
  `app.use(middleware.cookie({ secret }))`. Without it the call throws instead of sending the value
  unsigned. (On AWS Lambda, Vercel Edge and Cloudflare Workers cookies are not signed and the call
  warns once; sign the value yourself there.)

---

#### res.clearCookie(name, options?)

Clears a cookie. Returns `res` for chaining.

```typescript
handler: (req, res) => {
  res.clearCookie('session').json({ success: true });
};
```

Pass the `path` and `domain` the cookie was set with; a browser only removes a cookie whose path
and domain match.

---

#### res.redirect(url, status?)

Redirects to the given URL. Defaults to `302`.

```typescript
handler: (req, res) => {
  res.redirect('/login');
  // or with a specific status
  res.redirect('/new-location', 301);
};
```

The URL is written to the `Location` header, and a printable ASCII URL is sent exactly as given. Line breaks are removed from it, any other control character (a NUL from decoded user input, for example) is percent-encoded (`%00`), and a URL with characters outside Latin-1 has its non-ASCII characters percent-encoded as UTF-8, so `res.redirect('/日本')` sends `Location: /%E6%97%A5%E6%9C%AC`. `res.location(url)` sets the same header without ending the response.

---

#### res.sendFile(filePath, options?)

Streams a file as the response. Returns a `Promise<void>`.

```typescript
handler: async (req, res) => {
  await res.sendFile('/uploads/report.pdf');
};
```

The response carries the file's `Content-Type` (from its extension), `Content-Length`, `Last-Modified` and `X-Content-Type-Options: nosniff`. A path that is missing or not a regular file is answered `404` with a JSON body. The promise never rejects.

No `Cache-Control` is sent unless you ask for one: how long a file may be cached, and whether a shared cache may keep it, depends on what the file is and who may see it. A `Cache-Control` the handler set before the call is left as it is.

| Option         | Type                            | What it does                                                                                                                                                                             |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAge`       | `number` (**seconds**)          | Sends `Cache-Control: public, max-age=<maxAge>`. The unit is seconds, as for `staticFiles` (cookie `maxAge` is a different option with its own unit).                                    |
| `immutable`    | `boolean`                       | Adds `immutable` to the header `maxAge` produces. Has no effect without `maxAge`.                                                                                                        |
| `cacheControl` | `string \| boolean`             | A string is sent as the header value as written, for example `'private, max-age=600'`. `true` sends `public, max-age=<maxAge or 0>`; `false` sends none, whatever `maxAge` says.         |
| `root`         | `string`                        | Directory the path is resolved against and confined to. A path that leads outside it (`../`, an absolute path, a symlink pointing out) is answered `404`.                                |
| `dotfiles`     | `'ignore' \| 'deny' \| 'allow'` | What to do with a hidden path: `'ignore'` answers `404`, `'deny'` `403`, `'allow'` serves it. Default `'ignore'` when `root` is set, `'allow'` otherwise. `.well-known` is never hidden. |

```typescript
handler: async (req, res) => {
  // A fingerprinted asset: cache for a year
  await res.sendFile('./public/app.3f9a1c.js', { maxAge: 31536000, immutable: true });
};
```

```typescript
handler: async (req, res) => {
  // A per-user file: the browser may keep it, a shared cache may not.
  // `root` keeps a path built from a route parameter inside the directory
  // (route params arrive percent-decoded, so `..%2F` is `../` in the handler).
  await res.sendFile(`${req.params.name}.pdf`, {
    root: './invoices',
    cacheControl: 'private, max-age=600',
  });
};
```

With `root`, the dotfile policy covers every segment of the path below the root, in the path as given and in the path it resolves to, as it does for `staticFiles`. Without `root`, `sendFile()` serves the path exactly as given, so confine it yourself or pass `root`.

Files up to 64 KB are sent in one write; larger files are streamed, so memory use does not grow with the size of the file.

---

#### res.attachment(filename?)

Sets `Content-Disposition: attachment`, with the file name when one is given, so the browser saves the response instead of displaying it. Returns `res` for chaining.

```typescript
handler: (req, res) => {
  res.attachment('report.csv').type('text/csv').send('id,total\n1,42\n');
};
```

An ASCII or Latin-1 name is sent as `filename="report.csv"`. Any other name is sent twice (RFC 6266): an ASCII stand-in for old clients and the real name, UTF-8 percent-encoded, which current browsers use. `res.attachment('报告.pdf')` sends `attachment; filename="__.pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf`.

---

#### res.download(filePath, filename?, options?)

`res.attachment()` followed by `res.sendFile()`: sends the file as a download named `filename`, or after the file itself when no name is given. Returns a `Promise<void>` that never rejects.

```typescript
handler: async (req, res) => {
  await res.download('/uploads/2026-q3.pdf', 'Quarterly report.pdf');
};
```

The download name only goes into `Content-Disposition`. The `Content-Type` is the file's own, taken from the path that is sent: `res.download('export.json', 'report.pdf')` is sent as `application/json`. (On the native engine a `Content-Type` the handler set before the call is kept; the Node.js servers always send the file's.)

`options` are the ones `res.sendFile()` takes (`maxAge` in seconds, `immutable`, `cacheControl`, `root`, `dotfiles`), as the third argument or in place of the name. Like `sendFile()`, `download()` sends no `Cache-Control` unless asked.

```typescript
handler: async (req, res) => {
  await res.download(`${req.params.id}.zip`, 'export.zip', { root: './exports' });
};
```

A missing file is answered `404` with a JSON body and no `Content-Disposition`, so the browser shows the error instead of saving it under the file's name.

---

#### res.render(template, data?)

Renders a template (if a template engine is configured). Returns a `Promise<void>`.

```typescript
handler: async (req, res) => {
  await res.render('dashboard', { user: req.user });
};
```

---

### Success Responses

These methods set the HTTP status code and send the response in a single call. After calling any of these, the response is finished -- do not return a value from your handler.

#### res.success(data, message?)

Sends a `200 OK` response with the provided data.

```typescript
handler: async (req, res) => {
  const users = await getUsers();
  res.success(users);
};

// With message
handler: async (req, res) => {
  const user = await createUser(req.body);
  res.success(user, 'User created successfully');
};
```

**Response body:**

```json
{
  "success": true,
  "data": { "id": 1, "name": "Alice" },
  "message": "User created successfully"
}
```

---

#### res.created(data, location?)

Sends a `201 Created` response. Optionally sets the `Location` header.

```typescript
handler: async (req, res) => {
  const user = await createUser(req.body);
  res.created(user, `/api/users/${user.id}`);
};
```

**Response body:**

```json
{ "success": true, "data": { "id": 1, "name": "Alice" } }
```

**Headers:** `Location: /api/users/1` (when provided)

---

#### res.noContent()

Sends a `204 No Content` response with an empty body.

```typescript
handler: async (req, res) => {
  await deleteUser(req.params.id);
  res.noContent();
};
```

---

#### res.paginated(data, pagination)

Sends a `200 OK` response with pagination metadata automatically calculated.

| Parameter    | Type                                             |
| ------------ | ------------------------------------------------ |
| `data`       | `T[]`                                            |
| `pagination` | `{ page: number; limit: number; total: number }` |

```typescript
handler: async (req, res) => {
  const { users, total } = await getUsers({ page: 1, limit: 20 });
  res.paginated(users, { page: 1, limit: 20, total });
};
```

**Response body:**

```json
{
  "success": true,
  "data": [{ "id": 1, "name": "Alice" }],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5,
    "hasNext": true,
    "hasPrev": false
  }
}
```

---

### Error Responses

All error methods set the appropriate HTTP status code automatically.

#### res.error(error, code?, message?)

Sends a `200 OK` response (does **not** set a status code) with an error body. Use `res.status()` beforehand if you need a specific HTTP code, or use one of the specific error helpers below.

```typescript
handler: (req, res) => {
  res.status(500).json({ success: false, error: 'Something went wrong' });
  // or
  res.error('Something went wrong', 'CUSTOM_ERROR', 'Additional details');
};
```

---

#### res.badRequest(message?)

Sends a `400 Bad Request` response.

| Parameter | Type     | Default             |
| --------- | -------- | ------------------- |
| `message` | `string` | `'Invalid request'` |

```typescript
handler: (req, res) => {
  if (!req.body.email) {
    res.badRequest('Email is required');
    return;
  }
};
```

**Response body:**

```json
{
  "success": false,
  "error": "Bad Request",
  "code": "BAD_REQUEST",
  "message": "Email is required"
}
```

---

#### res.unauthorized(message?)

Sends a `401 Unauthorized` response.

| Parameter | Type     | Default                     |
| --------- | -------- | --------------------------- |
| `message` | `string` | `'Authentication required'` |

```typescript
handler: (req, res) => {
  if (!req.user) {
    res.unauthorized();
    return;
  }
};
```

**Response body:**

```json
{
  "success": false,
  "error": "Unauthorized",
  "code": "UNAUTHORIZED",
  "message": "Authentication required"
}
```

---

#### res.forbidden(message?)

Sends a `403 Forbidden` response.

| Parameter | Type     | Default                      |
| --------- | -------- | ---------------------------- |
| `message` | `string` | `'Insufficient permissions'` |

```typescript
handler: (req, res) => {
  if (!req.user.roles.includes('admin')) {
    res.forbidden('Admin access required');
    return;
  }
};
```

**Response body:**

```json
{
  "success": false,
  "error": "Forbidden",
  "code": "FORBIDDEN",
  "message": "Admin access required"
}
```

---

#### res.notFound(resource?)

Sends a `404 Not Found` response.

| Parameter  | Type     | Default      |
| ---------- | -------- | ------------ |
| `resource` | `string` | `'Resource'` |

```typescript
handler: async (req, res) => {
  const user = await getUser(req.params.id);
  if (!user) {
    res.notFound('User');
    return;
  }
};
```

**Response body:**

```json
{
  "success": false,
  "error": "Not Found",
  "code": "NOT_FOUND",
  "message": "User not found"
}
```

---

#### res.conflict(message)

Sends a `409 Conflict` response.

| Parameter | Type     | Default      |
| --------- | -------- | ------------ |
| `message` | `string` | _(required)_ |

```typescript
handler: async (req, res) => {
  const existing = await getUserByEmail(req.body.email);
  if (existing) {
    res.conflict('Email already in use');
    return;
  }
};
```

**Response body:**

```json
{
  "success": false,
  "error": "Conflict",
  "code": "CONFLICT",
  "message": "Email already in use"
}
```

---

#### res.validationError(errors)

Sends a `422 Unprocessable Entity` response with field-level error details.

| Parameter | Type                                                       |
| --------- | ---------------------------------------------------------- |
| `errors`  | `Array<{ field: string; message: string; code?: string }>` |

```typescript
handler: (req, res) => {
  const errors = validateUser(req.body);
  if (errors.length > 0) {
    res.validationError([
      { field: 'email', message: 'Invalid email format', code: 'INVALID_FORMAT' },
      { field: 'age', message: 'Must be at least 18' },
    ]);
    return;
  }
};
```

**Response body:**

```json
{
  "success": false,
  "error": "Validation Failed",
  "code": "VALIDATION_ERROR",
  "errors": [
    { "field": "email", "message": "Invalid email format", "code": "INVALID_FORMAT" },
    { "field": "age", "message": "Must be at least 18" }
  ]
}
```

---

#### res.rateLimited(retryAfter?)

Sends a `429 Too Many Requests` response. When `retryAfter` is provided, the `Retry-After` header is set automatically.

| Parameter    | Type               | Default     |
| ------------ | ------------------ | ----------- |
| `retryAfter` | `number` (seconds) | `undefined` |

```typescript
handler: async (req, res) => {
  const limited = await checkRateLimit(req.ip);
  if (limited) {
    res.rateLimited(60);
    return;
  }
};
```

**Response body:**

```json
{
  "success": false,
  "error": "Rate Limit Exceeded",
  "code": "RATE_LIMITED",
  "message": "Too many requests. Retry after 60 seconds.",
  "retryAfter": 60
}
```

**Headers:** `Retry-After: 60`

---

#### res.internalError(message?)

Sends a `500 Internal Server Error` response.

| Parameter | Type     | Default                   |
| --------- | -------- | ------------------------- |
| `message` | `string` | `'Internal server error'` |

```typescript
handler: async (req, res) => {
  try {
    const data = await fetchExternalService();
    res.success(data);
  } catch (err) {
    res.internalError('Failed to fetch data from external service');
  }
};
```

**Response body:**

```json
{
  "success": false,
  "error": "Internal Server Error",
  "code": "INTERNAL_ERROR",
  "message": "Failed to fetch data from external service"
}
```

---

### Header & State Utilities

#### res.hasHeader(name)

Returns `true` if the given header has been set.

```typescript
if (!res.hasHeader('X-Request-Id')) {
  res.setHeader('X-Request-Id', req.requestId);
}
```

---

#### res.setBulkHeaders(headers)

Sets multiple headers at once. Returns `res` for chaining.

```typescript
res
  .setBulkHeaders({
    'X-Request-Id': req.requestId,
    'X-Response-Time': 42,
    'Cache-Control': 'no-store',
  })
  .json(data);
```

---

#### res.appendHeader(name, value)

Appends a value to an existing header (or creates it). Returns `res` for chaining.

```typescript
res.appendHeader('Set-Cookie', 'a=1').appendHeader('Set-Cookie', 'b=2');
```

---

#### res.canSetHeaders()

Returns `true` if headers have not been sent yet and can still be modified.

```typescript
if (res.canSetHeaders()) {
  res.setHeader('X-Custom', 'value');
}
```

---

#### res.getResponseState()

Returns the current `ResponseState` object.

```typescript
const state = res.getResponseState();
// { headersSent: false, statusCode: 200, headers: {...}, finished: false, writable: true }
```

---

## Standalone Helper Functions

These functions build response **body objects only**. They do not set HTTP status codes or send the response. Use them with `res.status().json()` for full control, or return them directly from a handler (which sends a `200` by default).

```typescript
import { response } from '@morojs/moro';
```

### Quick Reference

| Function                                      | Returns                                                   |
| --------------------------------------------- | --------------------------------------------------------- |
| `response.success(data, message?)`            | `{ success: true, data, message? }`                       |
| `response.error(error, code?, message?)`      | `{ success: false, error, code?, message? }`              |
| `response.validationError(details, message?)` | `{ success: false, error: 'Validation failed', ... }`     |
| `response.unauthorized(message?)`             | `{ success: false, error: 'Unauthorized', ... }`          |
| `response.forbidden(message?)`                | `{ success: false, error: 'Forbidden', ... }`             |
| `response.notFound(resource?)`                | `{ success: false, error: 'Not Found', ... }`             |
| `response.conflict(message)`                  | `{ success: false, error: 'Conflict', ... }`              |
| `response.badRequest(message?)`               | `{ success: false, error: 'Bad Request', ... }`           |
| `response.internalError(message?)`            | `{ success: false, error: 'Internal Server Error', ... }` |
| `response.rateLimited(retryAfter?)`           | `{ success: false, error: 'Too Many Requests', ... }`     |

### Usage

```typescript
import { response } from '@morojs/moro';

// Return directly (sends 200 with body)
handler: async (req, res) => {
  const users = await getUsers();
  return response.success(users);
};

// Pair with res.status() for proper HTTP codes
handler: async (req, res) => {
  const user = await getUser(req.params.id);
  if (!user) {
    return res.status(404).json(response.notFound('User'));
  }
  return response.success(user);
};
```

---

## ResponseBuilder

A fluent API for building complex responses. Returns body objects only (no HTTP status or send).

```typescript
import { ResponseBuilder } from '@morojs/moro';
```

### Methods

| Method                                | Description                      |
| ------------------------------------- | -------------------------------- |
| `ResponseBuilder.success(data)`       | Start a success response         |
| `ResponseBuilder.error(error, code?)` | Start an error response          |
| `.message(msg)`                       | Add a message                    |
| `.details(details)`                   | Add details (error responses)    |
| `.code(code)`                         | Add an error code                |
| `.build()`                            | Return the final response object |

### Usage

```typescript
handler: async (req, res) => {
  const users = await getUsers();
  return ResponseBuilder.success(users).message('Retrieved all active users').build();
};

handler: (req, res) => {
  return res.status(404).json(
    ResponseBuilder.error('User not found', 'USER_NOT_FOUND')
      .details({ id: req.params.id, searched: ['db', 'cache'] })
      .build()
  );
};
```

---

## Important: Return Values vs HTTP Status Codes

When a handler returns a plain object, the framework serializes it as JSON with a **200 OK** status:

```typescript
// THIS SENDS HTTP 200 -- the "status" field is just data in the JSON body
handler: (req, res) => {
  return { error: 'Forbidden', status: 403 };
};
```

To send an actual HTTP 403, use one of these approaches:

```typescript
// Option 1: res.* helper (recommended)
handler: (req, res) => {
  res.forbidden('You do not have access');
  return;
};

// Option 2: res.status().json() with standalone helper
handler: (req, res) => {
  return res.status(403).json(response.forbidden('You do not have access'));
};

// Option 3: res.status().json() manually
handler: (req, res) => {
  return res.status(403).json({ success: false, error: 'Forbidden' });
};
```

**Rule of thumb:** If you need an HTTP status other than 200, always use a `res.*` method or `res.status()` explicitly.
