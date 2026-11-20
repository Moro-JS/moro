# Native Auth Adapter for MoroJS

MoroJS includes a native adapter that runs sign-in and sessions on [Better Auth](https://better-auth.com/), without `@auth/express` or any other framework adapter in between. It takes an Auth.js-style configuration (`providers`, `secret`, `session`, `basePath`), translates what Better Auth has an option for, and hands anything else straight through with `betterAuth`. It needs the optional `better-auth` peer dependency (`npm install better-auth`, `>=1.7.7`). It is exported from `@morojs/moro` as `createAuthMiddleware` and `MoroJSAuth`; there is no separate adapter package to install.

For authentication as a whole (Bearer tokens, the guards, your own authentication) see the [Authentication Guide](./AUTH_GUIDE.md).

## Overview

The native adapter provides:

- **The auth routes**: `createAuthMiddleware()` serves Better Auth's routes under `basePath` (sign-in, the provider callback, the session, sign-out, and whatever the configured plugins add), with nothing to mount by hand
- **Request Enhancement**: Every request gets a `req.auth` object with the session, the user and an `isAuthenticated` flag, which is what the guards (`requireAuth()`, `requireRole()`, ...) read
- **Sign-in and sign-out URLs**: `req.auth.signIn(provider, options)` and `req.auth.signOut(options)` return URLs the browser can be sent to
- **Auth.js-Style Configuration**: `secret`, `basePath`, `baseURL`, `trustedOrigins`, the `session` settings and every provider Better Auth knows are passed on; a key Better Auth has no equivalent for is named in a warning at start-up
- **Feature helpers**: `twoFactor()`, `organization()`, `anonymous()`, `bearerToken()`, `accountLinking()` and `rateLimit()` each turn on the Better Auth feature they are named after
- **No ceiling**: `betterAuth` hands options to Better Auth as they are: a database, email and password, plugins, hooks
- **No Framework Adapter**: No reliance on `@auth/express` or other framework adapters; the only package it loads is `better-auth`

## Quick Start

### Basic Setup

```typescript
import { createApp, createAuthMiddleware, requireAuth } from '@morojs/moro';

const app = await createApp();

await app.use(
  createAuthMiddleware({
    providers: [
      {
        id: 'github',
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    ],
    secret: process.env.AUTH_SECRET,
    baseURL: 'http://localhost:3000',
  })
);

app.get('/', async (req, res) => {
  res.json({
    auth: {
      isAuthenticated: req.auth.isAuthenticated,
      user: req.auth.user,
    },
    signIn: (await req.auth.signIn('github', { callbackUrl: '/me' })).url,
    signOut: (await req.auth.signOut({ callbackUrl: '/' })).url,
  });
});

app
  .get('/me')
  .before(requireAuth())
  .handler(req => req.auth.user);

app.listen(3000);
```

Open the `signIn` URL (`/api/auth/signin/github?provider=github&callbackUrl=%2Fme`) in a browser: it redirects to GitHub, GitHub sends the browser back to `/api/auth/callback/github`, and the session cookie is set. `/me` then answers the user. Register `http://localhost:3000/api/auth/callback/github` as the OAuth app's callback URL.

`app.use()` returns a promise for this adapter because Better Auth is loaded on demand. The routes and `req.auth` take their place among the application's middleware at once, and a request that arrives while Better Auth is still loading waits for it; awaiting `app.use()` reports a failure to load (for example a missing `better-auth` package) at start-up.

## Configuration

| Option                | Default                                                   | Notes                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret`              | `AUTH_SECRET` environment variable                        | Required in production: start-up throws without one. Elsewhere a random secret is generated and a warning logged.                                                                 |
| `baseURL`             | `BASE_URL`, then `AUTH_URL`, then `http://localhost:3000` | Public URL of the app. OAuth redirect URIs are built from it. In production a warning is logged when it falls back to `http://localhost:3000`.                                    |
| `basePath`            | `/api/auth`                                               | Where the auth routes are served.                                                                                                                                                 |
| `trustedOrigins`      | The origin of `baseURL`                                   | Origins Better Auth accepts for state-changing auth requests and redirect URLs.                                                                                                   |
| `providers`           | none                                                      | Entries with the `id` of a Better Auth social provider; the other fields of an entry are that provider's options.                                                                 |
| `session.maxAge`      | `2592000` (30 days)                                       | Session lifetime in seconds (Better Auth's `expiresIn`).                                                                                                                          |
| `session.updateAge`   | `86400` (1 day)                                           | How often a session's expiry is refreshed, in seconds.                                                                                                                            |
| `session.*`           | Better Auth's defaults                                    | Better Auth's other session settings (`freshAge`, `cookieCache`, `disableSessionRefresh`, ...) are passed on.                                                                     |
| `useSecureCookies`    | Better Auth's default                                     | Passed on as `advanced.useSecureCookies`.                                                                                                                                         |
| `debug`               | `false`                                                   | Turns on Better Auth's debug logging and what `morojs.debug` does.                                                                                                                |
| `betterAuth`          | none                                                      | Options handed to `betterAuth()` as they are. A key given here wins over the value derived from the keys above; `socialProviders` and `session` are merged with the derived ones. |
| `plugins`             | none                                                      | `twoFactor()`, `organization()`, `anonymous()`, `bearerToken()`. See [Feature Helpers](#feature-helpers).                                                                         |
| `accountLinking`      | none                                                      | `accountLinking()`. See [Feature Helpers](#feature-helpers).                                                                                                                      |
| `rateLimit`           | none                                                      | `rateLimit()`. See [Feature Helpers](#feature-helpers).                                                                                                                           |
| `mountRoutes`         | `true`                                                    | `false`: `createAuthMiddleware()` adds `req.auth` only and serves no routes.                                                                                                      |
| `morojs.debug`        | `false`                                                   | Logs session lookup errors, and puts the underlying message in a `500` from the route handler.                                                                                    |
| `morojs.transformers` | none                                                      | See [Request/Response Transformers](#requestresponse-transformers).                                                                                                               |

### Provider Configuration

Every provider Better Auth knows can be configured (`apple`, `discord`, `facebook`, `github`, `gitlab`, `google`, `linkedin`, `microsoft`, `slack`, `spotify`, `twitch`, `twitter` and the rest of its list). The fields of an entry other than the ones that only describe it (`id`, `name`, `type`, `authorization`, `token`, `userinfo`, `issuer`, `wellKnown`, `profile`) are passed on as the provider's options. A `scope` written as one string becomes a list, `hostedDomain` becomes Google's `hd` and `tenant` becomes Microsoft's `tenantId`, so the entries the `providers` and `extendedProviders` helpers build work as they are:

```typescript
import { createApp, createAuthMiddleware, providers } from '@morojs/moro';

const app = await createApp();

await app.use(
  createAuthMiddleware({
    providers: [
      // GitHub Provider, asking for one more scope
      {
        id: 'github',
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        scope: ['repo'],
      },

      // Google Provider, always showing the account chooser
      {
        id: 'google',
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        prompt: 'select_account',
      },

      // A helper builds the same kind of entry
      providers.discord({
        clientId: process.env.DISCORD_CLIENT_ID!,
        clientSecret: process.env.DISCORD_CLIENT_SECRET!,
      }),
    ],
    secret: process.env.AUTH_SECRET,
    baseURL: 'http://localhost:3000',
  })
);

app.listen(3000);
```

With more than one provider, `GET /api/auth/signin` answers a page of sign-in links (JSON to a client that does not accept HTML); with one it redirects straight to that provider.

An entry is left out, with a warning at start-up that names it, when its `id` is not a Better Auth social provider, when it has no `clientId`, or when Better Auth refuses to build it (Cognito without `domain`, `region` and `userPoolId`, for example). The other providers are still configured.

### Passing Options to Better Auth

```typescript
import { createApp, createAuthMiddleware } from '@morojs/moro';
import { memoryAdapter } from 'better-auth/adapters/memory';

const app = await createApp();

await app.use(
  createAuthMiddleware({
    providers: [],
    secret: process.env.AUTH_SECRET,
    baseURL: 'http://localhost:3000',
    betterAuth: {
      // Users and sessions in this process's memory: enough to try things out.
      // Use a real database (https://better-auth.com/docs/concepts/database) otherwise.
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: true, window: 60, max: 30 },
    },
  })
);

app.get('/me', req => ({ user: req.auth.user }));

app.listen(3000);
```

`POST /api/auth/sign-up/email` and `POST /api/auth/sign-in/email` then exist, as JSON or as a submitted form. For OAuth 2 / OpenID Connect providers Better Auth has no built-in entry for, add its `genericOAuth` plugin to `betterAuth.plugins`; a provider it defines signs in at `/api/auth/signin/<providerId>` like any other. The [Authentication Guide](./AUTH_GUIDE.md#passing-options-to-better-auth) has a sample.

### Feature Helpers

Six helpers exported from `@morojs/moro` each configure one Better Auth feature. The adapter loads the plugin from your application's `better-auth` (only for the helpers you pass) and maps the helper's options onto the plugin's own.

```typescript
import {
  createApp,
  createAuthMiddleware,
  MoroJSAuth,
  twoFactor,
  organization,
  anonymous,
  bearerToken,
  accountLinking,
  rateLimit,
} from '@morojs/moro';
import Database from 'better-sqlite3';
import { getMigrations } from 'better-auth/db/migration';

const app = await createApp();

const config = {
  secret: process.env.AUTH_SECRET,
  baseURL: 'http://localhost:3000',
  providers: [],
  plugins: [twoFactor({ issuer: 'Acme' }), organization(), anonymous(), bearerToken()],
  accountLinking: accountLinking(),
  rateLimit: rateLimit({ maxAttempts: 5, window: 300 }),
  betterAuth: {
    database: new Database('auth.db'),
    emailAndPassword: { enabled: true },
  },
};

// Create the tables this configuration writes to
const { instance } = await MoroJSAuth(config);
const { runMigrations } = await getMigrations(instance.options);
await runMigrations();

await app.use(createAuthMiddleware(config));

app.get('/me', req => ({
  user: req.auth.user,
  activeOrganizationId: req.auth.session?.activeOrganizationId ?? null,
}));

app.listen(3000);
```

| Helper             | Passed as        | Becomes                                                                | Its options → Better Auth's                                                                                                                                                                                        | Stores                                                                               |
| ------------------ | ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `twoFactor()`      | `plugins`        | the `twoFactor` plugin (`better-auth/plugins/two-factor`)              | `issuer` → `issuer`; `totp: false` → `totpOptions.disable`; `backupCodesCount` → `backupCodeOptions.amount` (`backupCodes: false` → `0`); `trustDeviceDuration` → `trustDeviceMaxAge` (`trustDevice: false` → `0`) | table `twoFactor`, column `user.twoFactorEnabled`                                    |
| `organization()`   | `plugins`        | the `organization` plugin (`better-auth/plugins/organization`)         | `allowUserCreate` → `allowUserToCreateOrganization`; `maxOrganizationsPerUser` (default 10) → `organizationLimit`; `organizationRoles: false` has no equivalent (warning)                                          | tables `organization`, `member`, `invitation`, column `session.activeOrganizationId` |
| `anonymous()`      | `plugins`        | the `anonymous` plugin (`better-auth/plugins/anonymous`)               | `linkOnSignUp: false` → `disableDeleteAnonymousUser`; `sessionDuration` has no equivalent (warning when it differs from `session.maxAge`)                                                                          | column `user.isAnonymous`                                                            |
| `bearerToken()`    | `plugins`        | the `bearer` plugin (`better-auth/plugins/bearer`)                     | `expiresIn`, `refreshTokens`, `refreshTokenExpiresIn` have no equivalent (warning when given): the token is the session token                                                                                      | nothing                                                                              |
| `accountLinking()` | `accountLinking` | `account.accountLinking`                                               | defaults → `{ enabled: true, disableImplicitLinking: true }`; `autoLinkSameEmail: true` → `disableImplicitLinking: false`; both `false` → `{ enabled: false }`                                                     | nothing of its own                                                                   |
| `rateLimit()`      | `rateLimit`      | `rateLimit: { enabled: true, customRules: { '/sign-in/*': { ... } } }` | `maxAttempts` → `max`; `window` → `window`; `lockoutDuration` has no equivalent (warning when it differs from `window`)                                                                                            | nothing, unless `betterAuth.rateLimit.storage` is `'database'`                       |

The four plugin helpers also take `betterAuth`, options handed to the plugin as they are, over the derived ones: `twoFactor({ betterAuth: { otpOptions } })`, `anonymous({ betterAuth: { onLinkAccount } })`. What you set yourself in `betterAuth` wins: a plugin with the same id in `betterAuth.plugins` replaces the helper's (with one warning), and keys of `betterAuth.account.accountLinking` and `betterAuth.rateLimit` override the derived ones. A helper in the wrong place (`plugins: [rateLimit()]`) is a compile error.

The routes the plugins add (`/two-factor/...`, `/organization/...`, `/sign-in/anonymous`, `/link-social`, ...) are served under `basePath` with the others, and `req.auth` shows what they keep on the user and the session: `req.auth.user.twoFactorEnabled`, `req.auth.user.isAnonymous`, `req.auth.session.activeOrganizationId`. With `bearerToken()` a session token sent as `Authorization: Bearer` authenticates the request.

`twoFactor()`, `organization()` and `anonymous()` store data. Without `betterAuth.database` Better Auth keeps it in the memory of the process and start-up logs a warning. With a database, its tables have to exist: `createAuthMiddleware()` logs an error at start-up when they do not, quoting what Better Auth reports missing, and until they exist the auth routes answer `500` and no session is recognised. `MoroJSAuth(config)` on its own makes no such check, so that its `instance.options` can be handed to `getMigrations()` as above. The [Authentication Guide](./AUTH_GUIDE.md#two-factor-organizations-anonymous-users-session-tokens-account-linking-rate-limits) documents each helper, its routes and the database in full.

### Keys That Are Not Used

The configuration type is permissive so that an existing Auth.js-style object can be passed. These keys have no Better Auth equivalent: they do nothing, and each one present is named in a warning at start-up together with what to use instead.

| Key                                                                               | Use instead                                                                                                                                        |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `callbacks`                                                                       | `betterAuth: { hooks, databaseHooks }`; `mapProfileToUser` on a provider entry                                                                     |
| `events`                                                                          | `betterAuth: { databaseHooks }` or `betterAuth: { hooks: { after } }`                                                                              |
| `pages`                                                                           | Your own pages, linked to `req.auth.signIn(provider).url`; `betterAuth: { onAPIError: { errorURL } }` for the error page                           |
| `adapter`                                                                         | `betterAuth: { database }`                                                                                                                         |
| `session.strategy`, `session.generateSessionToken`                                | Nothing: sessions live in signed cookies without a database and in the database with one; `betterAuth: { advanced: { database: { generateId } } }` |
| `cookies`, `trustHost`, `theme`, `logger`, `skipCSRFCheck`, `experimental`, `jwt` | `betterAuth: { advanced }`, `baseURL`, `betterAuth: { logger }`, Better Auth plugins; for API tokens `auth({ jwt })`                               |

## Request Enhancement

The adapter automatically enhances MoroJS requests with an `auth` object:

```typescript
interface RequestAuth {
  session: Session | null; // { user, expires }
  user: User | null; // the Better Auth user
  isAuthenticated: boolean;

  // Helper methods
  getSession(): Promise<Session | null>;
  getUser(): User | null;
  signIn(provider?: string, options?: { callbackUrl?: string }): { url: string };
  signOut(options?: { callbackUrl?: string }): { url: string };
}
```

| Member                        | Value                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAuthenticated`             | `true` when Better Auth found a session for the request's cookies.                                                                                                      |
| `user`                        | The Better Auth user: `id`, `name`, `email`, `image`, `emailVerified`, `createdAt`, `updatedAt` and any field added with `betterAuth.user.additionalFields`; or `null`. |
| `session`                     | `{ user, expires }` (`expires` is an ISO date string), or `null`. With the organization plugin it also has `activeOrganizationId` (the id, or `null`).                  |
| `getSession()`                | Resolves to the same `session` value.                                                                                                                                   |
| `getUser()`                   | Returns the same `user` value.                                                                                                                                          |
| `signIn(provider?, options?)` | Returns `{ url }`: `<basePath>/signin/<provider>`, or `<basePath>/signin` without a provider; `options.callbackUrl` is added as a query.                                |
| `signOut(options?)`           | Returns `{ url }`: `<basePath>/signout`; `options.callbackUrl` is added as a query.                                                                                     |

The guards check `user.roles` and `user.permissions`, so a `roles` field on your users (see `betterAuth.user.additionalFields`) is what `requireRole()` reads. When the user has no `roles` but a `role` text, as with Better Auth's `admin` plugin, `roles` is set to it.

A failed session lookup is treated as "not authenticated" rather than an error. Set `morojs.debug` (or `debug`) to have the failure logged.

## Route Handling

`createAuthMiddleware()` serves these under `basePath` (`/api/auth` unless you set it):

| Request                                                                                     | Answer                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/signin`                                                                      | With one provider, a redirect to its sign-in URL; with several, a page of links (or JSON)                                                                                                                                                               |
| `GET` or `POST /api/auth/signin/<provider>` (`callbackUrl` in the query or body)            | Redirects to the provider's authorization page, and sets the OAuth state cookie                                                                                                                                                                         |
| `GET /api/auth/callback/<provider>`                                                         | Where the provider sends the user back: sets the session cookies, then redirects to the callback URL                                                                                                                                                    |
| `GET /api/auth/get-session`                                                                 | The session and user as JSON, or `null`                                                                                                                                                                                                                 |
| `POST /api/auth/signout` (`callbackUrl` in the query or body)                               | Clears the session cookies; a submitted form is redirected to `callbackUrl` (default `/`), a script gets `{ "success": true }`. A `GET` is accepted only as a same-origin browser navigation (`Sec-Fetch-Site: same-origin` or `none`), otherwise `405` |
| `POST /api/auth/sign-in/social` with JSON `{ "provider": "github", "callbackURL": "/app" }` | Better Auth's own start: `200`, JSON `{ "url", "redirect": true }`, a `Location` header and the state cookie                                                                                                                                            |
| `POST /api/auth/sign-out`                                                                   | Better Auth's own sign-out: `{ "success": true }`, and clears the session cookies                                                                                                                                                                       |
| Any other path under `/api/auth`                                                            | Better Auth and its plugins (`/sign-up/email`, `/sign-in/email`, ...); `404` from Better Auth for a path it does not have                                                                                                                               |

How they are served:

- From the application's middleware chain: after the middleware registered before `app.use(createAuthMiddleware(...))` (so CORS and security headers apply), before the router, for every method except `OPTIONS` and `HEAD`.
- A route the application registers itself under the base path takes precedence. An application that already mounts `MoroJSAuth(config).handler` on routes keeps being answered by those routes, once.
- A request the routes answer is handed to Better Auth once; no separate session lookup runs for it.
- They are served the same way by every server and runtime: the Node server, the native engine, the HTTP/2 server, and `app.getHandler()` on AWS Lambda (REST API, HTTP API and Function URL events), Vercel Edge and Cloudflare Workers. Cookies, redirects and query strings (a provider's `?code=...&state=...`, a `callbackUrl`) are carried on each. A request object that has its query only in `req.query` and not in `req.url` (from a custom runtime adapter, or built by hand for `MoroJSAuth().handler`) has it written back for Better Auth.

**Redirect or JSON.** Better Auth answers some requests (the social sign-in start; an email sign-in given a `callbackURL`) with `200`, a JSON body and a `Location` header: its client library reads the body and navigates. The adapter relays that answer unchanged to a script and sends a `302` to a browser that is navigating. A request is a navigation when it says so (`Sec-Fetch-Mode: navigate`), or, from a client that sends no fetch metadata, when it posts a form (`application/x-www-form-urlencoded` or `multipart/form-data`). `fetch()` in a browser and in Node sends `Sec-Fetch-Mode: cors`. A `3xx` from Better Auth is always relayed as a redirect.

### Mounting the Handler Yourself

`MoroJSAuth(config)` resolves to the pieces `createAuthMiddleware()` is made of:

- `handler(req, res)` answers a request under `basePath`: the routes in the table above.
- `auth(req)` returns the session for a request, or `null`.
- `basePath`, `providers` (the ids configured), `signInUrl(provider?, options?)`, `signOutUrl(options?)`.
- `instance`: the Better Auth instance, for its server API (`instance.api.*`).

To decide yourself which routes exist, turn the mounting off and put `handler` on the routes you want:

```typescript
import { createApp, createAuthMiddleware, MoroJSAuth } from '@morojs/moro';

const authConfig = {
  providers: [
    {
      id: 'github',
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  ],
  secret: process.env.AUTH_SECRET,
  baseURL: 'http://localhost:3000',
};

const app = await createApp();

// req.auth on every request, no routes
await app.use(createAuthMiddleware({ ...authConfig, mountRoutes: false }));

// The routes this application wants to expose
const auth = await MoroJSAuth(authConfig);
app.get('/api/auth/:action', (req, res) => auth.handler(req, res));
app.post('/api/auth/:action', (req, res) => auth.handler(req, res));
app.get('/api/auth/:action/:provider', (req, res) => auth.handler(req, res));
app.post('/api/auth/:action/:provider', (req, res) => auth.handler(req, res));

app.get('/me', req => ({ user: req.auth.user }));

app.listen(3000);
```

The two route shapes cover every route in the table; a Better Auth route with more path segments needs a route of its own.

## Advanced Features

### Request/Response Transformers

`morojs.transformers.request` and `morojs.transformers.response` apply to every request the auth routes hand to Better Auth; the session lookup that fills `req.auth` does not call them. They receive and must return the Web API `Request` and `Response`, not the MoroJS request and response. The `Request` a transformer receives has `basePath` removed from its path; it is put back before Better Auth is called, unless the transformer already did:

```typescript
import { createApp, createAuthMiddleware } from '@morojs/moro';

const app = await createApp();

await app.use(
  createAuthMiddleware({
    providers: [
      {
        id: 'github',
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    ],
    secret: process.env.AUTH_SECRET,
    baseURL: 'http://localhost:3000',

    morojs: {
      debug: true,
      transformers: {
        // Web API Request in, Web API Request out
        request: (request: Request) => {
          const headers = new Headers(request.headers);
          headers.set('x-tenant', 'acme');
          return new Request(request, { headers });
        },

        // Web API Response in, Web API Response out
        response: (response: Response) => {
          const headers = new Headers(response.headers);
          headers.set('x-auth-handled', 'yes');
          return new Response(response.body, { status: response.status, headers });
        },
      },
    },
  })
);

app.listen(3000);
```

### Security Configuration

```typescript
import { createApp, createAuthMiddleware } from '@morojs/moro';

const app = await createApp();

await app.use(
  createAuthMiddleware({
    providers: [
      {
        id: 'github',
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    ],
    secret: process.env.AUTH_SECRET,

    // Security settings
    session: {
      maxAge: 8 * 60 * 60, // 8 hours
      updateAge: 2 * 60 * 60, // Update every 2 hours
    },

    // Public URL of the app (falls back to BASE_URL, AUTH_URL, then http://localhost:3000)
    baseURL: 'http://localhost:3000',

    // Origin/CSRF protection: the origins allowed to call the auth routes
    // (defaults to the origin of baseURL)
    trustedOrigins: ['http://localhost:3000', 'https://app.yourdomain.com'],
  })
);

app.get('/me', req => ({ user: req.auth.user }));

app.listen(3000);
```

What protects the routes:

- Better Auth refuses a state-changing request that carries cookies when its `Origin` is not in `trustedOrigins`, and a callback URL that is neither a path nor on a trusted origin.
- `GET <basePath>/signout` ends the session only for a navigation the browser itself reports as same-origin; a link on another site cannot sign a visitor out.
- After sign-out a visitor is only redirected to a path on the application or to a URL on a trusted origin; anything else becomes `/`.
- The session cookie is `HttpOnly` and `SameSite=Lax`, and `Secure` when `baseURL` is `https`.
- Better Auth rate-limits its routes per client address, in production by itself (by default three sign-in attempts in ten seconds) and everywhere with [`rateLimit()`](#feature-helpers). Which address it counts depends on [`server.trustProxy`](./CONFIGURATION_REFERENCE.md#behind-a-proxy):
  - **Set** (`false` when clients connect directly, a hop count, addresses, `true`): the address is `req.ip`, the connected peer or the client as the trusted proxies report it. The adapter hands it over in an `x-moro-client-ip` request header that it writes itself (a value a client sends under that name is discarded) and does not hand Better Auth the `X-Forwarded-For` the request carried, so nothing a client sends changes who it is counted as.
  - **Not set**: as before, Better Auth reads `X-Forwarded-For` when that header names exactly one address, and `req.ip` otherwise. Behind a proxy that writes the header this counts real clients; on a server clients reach directly, a client can send a different header with every request and is never limited. When the limiter is in force, start-up logs one warning that says so and names `server.trustProxy`.
  - An application that names the source itself, with `betterAuth: { advanced: { ipAddress: { ipAddressHeaders } } }` or `trustedProxies`, keeps exactly that: nothing is removed from its requests and nothing is logged.
  - Through `getHandler()` on a serverless runtime there is no connection to read, and `req.ip` is what the platform reports: the event's `sourceIp` on AWS Lambda, `CF-Connecting-IP` on Cloudflare Workers, the first `X-Forwarded-For` entry on Vercel Edge (the platform writes these). `server.trustProxy` set makes that address the one Better Auth counts there too.

## Request/Response Types

These are the shapes `handler(req, res)` and `auth(req)` ask of their arguments. The request and response of a MoroJS route handler satisfy them as they are, so `(req, res) => auth.handler(req, res)` needs no cast.

### MoroJS Request Interface

```typescript
interface MoroJSRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  query?: Record<string, string>;
  cookies?: Record<string, string>;
}
```

### MoroJS Response Interface

```typescript
interface MoroJSResponse {
  status(code: number): MoroJSResponse;
  json(data: any): void | Promise<void>;
  redirect(url: string): void;
  setHeader(name: string, value: string): void;
  cookie(name: string, value: string, options?: any): void;
  send(data: any): void;
  end(data?: any): void;
  headersSent: boolean;
}
```

## Architecture

### Adapter Structure

```
src/core/auth/morojs-adapter.ts
├── MoroJSAuth()              # Better Auth instance, handler, session lookup, URLs
├── createAuthMiddleware()    # Mounts the routes and sets req.auth
├── mountAuthRoutes()         # The routes' place in the middleware chain (also used by auth())
├── toBetterAuthOptions()     # Auth.js-style configuration -> betterAuth() options
├── toWebRequest()            # MoroJS -> Web API transformer
├── fromWebResponse()         # Web API -> MoroJS transformer
└── Request/Response Types    # TypeScript interfaces
```

`auth(options)` from the built-in middleware uses the same `MoroJSAuth()` and `mountAuthRoutes()` when it is given providers, so both entry points serve the same routes in the same way.

### Integration Flow

1. **Request Reception**: MoroJS receives HTTP request
2. **Request hook**: for a request the auth routes will not answer, the request's headers and cookies are converted to a Web API `Request`, Better Auth looks up the session for those cookies, and the `auth` object is added to the request
3. **Middleware chain**: the application's global middleware runs; at the adapter's place in it, a request under `basePath` that no route of the application matches is converted to a Web API `Request`, answered by Better Auth, and the answer relayed
4. **Route Handling**: every other request continues with normal MoroJS routing

## Comparison with Express Adapter

| Feature       | Native MoroJS                         | @auth/express    |
| ------------- | ------------------------------------- | ---------------- |
| Dependencies  | `better-auth` only                    | Requires Express |
| Integration   | Request hook and middleware chain     | Middleware chain |
| TypeScript    | Full MoroJS types                     | Express types    |
| Customization | MoroJS-specific, `betterAuth` options | Express-specific |

## Production Deployment

### Environment Variables

```bash
# Required
AUTH_SECRET=your-32-character-secret-minimum
GITHUB_CLIENT_ID=your-github-oauth-app-id
GITHUB_CLIENT_SECRET=your-github-oauth-app-secret

# The public URL, when `baseURL` is not set in code (BASE_URL is read first;
# without either the base URL is http://localhost:3000)
BASE_URL=https://yourdomain.com
NODE_ENV=production

# Provider-specific
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
```

### Production Configuration

```typescript
import { createApp, createAuthMiddleware } from '@morojs/moro';

const app = await createApp();

await app.use(
  createAuthMiddleware({
    providers: [
      {
        id: 'github',
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    ],
    secret: process.env.AUTH_SECRET,

    // Production settings: the public URL comes from BASE_URL
    session: {
      maxAge: 8 * 60 * 60, // 8 hours for security
    },
  })
);

app.listen(3000);
```

In production, start-up throws when no secret is configured, and logs a warning when no base URL is configured. Without a `betterAuth.database` sessions are kept in signed cookies, which works across several instances as long as they share the secret.

## Troubleshooting

### Common Issues

1. **"Better Auth package not found"**
   - `npm install better-auth`; the adapter loads it from the application's `node_modules`

2. **The provider reports a redirect URI mismatch**
   - `baseURL` (or `BASE_URL` / `AUTH_URL`) is not the URL the application is reached at; the callback URL to register is `<baseURL><basePath>/callback/<provider>`

3. **`403` with "Invalid origin" or "Missing or null Origin"**
   - The request carried cookies and came from an origin that is not in `trustedOrigins`; add the origin of a front end served elsewhere

4. **A warning at start-up names a configuration key or a provider**
   - The key has no effect, or the provider was left out; the warning says what to use (see [Keys That Are Not Used](#keys-that-are-not-used))

5. **"the auth database does not have the tables and columns this configuration writes"**, and `500` from the auth routes
   - Create the tables Better Auth needs; see [Feature Helpers](#feature-helpers). Do it again after adding `twoFactor()`, `organization()` or `anonymous()`

6. **Session not persisting**
   - Ensure `AUTH_SECRET` is set and consistent across deployments
   - Check cookie settings for your deployment environment

### Debug Mode

```typescript
import { createApp, createAuthMiddleware } from '@morojs/moro';

const app = await createApp();

await app.use(
  createAuthMiddleware({
    providers: [
      {
        id: 'github',
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    ],
    secret: process.env.AUTH_SECRET,
    baseURL: 'http://localhost:3000',
    debug: true, // Better Auth's debug logging, and morojs.debug
  })
);

app.listen(3000);
```

With `morojs.debug` (or `debug`) enabled:

- Session lookup errors are logged (without it they are swallowed and the request is treated as unauthenticated)
- A `500` from the auth handler carries the underlying error message instead of `Authentication error`

## Conclusion

The native MoroJS adapter gives MoroJS applications sign-in and sessions on Better Auth from an Auth.js-style configuration, with the routes mounted, `req.auth` set for the guards, and no Express layer.

For questions or contributions, see the [Contributing Guide](./CONTRIBUTING.md) or join our [Discord Community](https://morojs.com/discord).
