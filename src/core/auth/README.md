# MoroJS Auth Adapter (Better Auth)

> **Note:** This directory holds the adapter behind `createAuthMiddleware` and `MoroJSAuth`. For MoroJS authentication as a whole, start with the [Authentication Guide](../../../docs/AUTH_GUIDE.md).

`createAuthMiddleware` takes an Auth.js-style configuration object and runs it on [Better Auth](https://better-auth.com/): it serves the sign-in, callback, session and sign-out routes under `basePath`, and adds a `req.auth` object to every request. It is exported from `@morojs/moro`; there is no separate adapter package to install.

## Installation

The adapter loads `better-auth` from your project when it is first used. It is an optional peer dependency of `@morojs/moro`:

```bash
npm install better-auth
# or
pnpm add better-auth
```

Without it, `createAuthMiddleware` rejects with `Better Auth package not found`.

## Basic Usage

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
    baseURL: 'https://yourdomain.com',
  })
);

app.get('/protected', (req, res) => {
  if (!req.auth.isAuthenticated) {
    // Where to send the browser to sign in: /api/auth/signin/github?...
    return res.status(401).json({ error: 'Unauthorized', signIn: req.auth.signIn('github').url });
  }

  res.json({ user: req.auth.user });
});

app.listen(3000);
```

`app.use()` returns a promise for this adapter because Better Auth is loaded on demand. The routes and `req.auth` take their place among the application's middleware at once, and a request that arrives while Better Auth is still loading waits for it; awaiting `app.use()` reports a failure to load at start-up.

## Configuration

The options the adapter reads:

| Option              | Default                                                   | Notes                                                                                                             |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `secret`            | `AUTH_SECRET` environment variable                        | Required in production: start-up throws without one. Elsewhere a random secret is generated and a warning logged. |
| `baseURL`           | `BASE_URL`, then `AUTH_URL`, then `http://localhost:3000` | Public URL of the app. In production a warning is logged when it falls back to `http://localhost:3000`.           |
| `basePath`          | `/api/auth`                                               | Where the auth routes are served.                                                                                 |
| `trustedOrigins`    | The origin of `baseURL`                                   | Origins Better Auth accepts for state-changing auth requests and redirect URLs.                                   |
| `providers`         | none                                                      | Entries with the `id` of a Better Auth social provider; the other fields of an entry are that provider's options. |
| `session.maxAge`    | `2592000` (30 days)                                       | Session lifetime in seconds (Better Auth's `expiresIn`).                                                          |
| `session.updateAge` | `86400` (1 day)                                           | How often a session's expiry is refreshed, in seconds.                                                            |
| `session.*`         | Better Auth's defaults                                    | Better Auth's other session settings (`freshAge`, `cookieCache`, ...) are passed on.                              |
| `useSecureCookies`  | Better Auth's default                                     | Passed on as `advanced.useSecureCookies`.                                                                         |
| `debug`             | `false`                                                   | Turns on Better Auth's debug logging, and what `morojs.debug` does.                                               |
| `betterAuth`        | none                                                      | Options handed to `betterAuth()` as they are: `database`, `emailAndPassword`, `plugins`, `hooks`, ...             |
| `plugins`           | none                                                      | `twoFactor()`, `organization()`, `anonymous()`, `bearerToken()`. See [Feature helpers](#feature-helpers).         |
| `accountLinking`    | none                                                      | `accountLinking()`. See [Feature helpers](#feature-helpers).                                                      |
| `rateLimit`         | none                                                      | `rateLimit()`. See [Feature helpers](#feature-helpers).                                                           |
| `mountRoutes`       | `true`                                                    | `false`: add `req.auth` only and serve no routes.                                                                 |
| `morojs.debug`      | `false`                                                   | Logs session lookup errors, and puts the underlying message in a `500` from the route handler.                    |

```typescript
await app.use(
  createAuthMiddleware({
    providers: [
      {
        id: 'google',
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        prompt: 'select_account',
      },
      {
        id: 'gitlab',
        clientId: process.env.GITLAB_CLIENT_ID!,
        clientSecret: process.env.GITLAB_CLIENT_SECRET!,
      },
    ],
    secret: process.env.AUTH_SECRET,
    baseURL: 'https://yourdomain.com',
    trustedOrigins: ['https://yourdomain.com'],
    session: {
      maxAge: 8 * 60 * 60, // 8 hours
      updateAge: 2 * 60 * 60, // refresh every 2 hours
    },
    morojs: { debug: process.env.NODE_ENV !== 'production' },
  })
);
```

Every field of a provider entry is passed on except the ones that only describe it (`id`, `name`, `type`, `authorization`, `token`, `userinfo`, `issuer`, `wellKnown`, `profile`). A `scope` given as one string becomes a list, `hostedDomain` becomes Google's `hd`, and `tenant` becomes Microsoft's `tenantId`.

A key given in `betterAuth` wins over the value derived from the other options; `socialProviders` and `session` are merged with the derived ones.

### Keys that are not used

The configuration type is permissive so that an existing Auth.js-style object can be passed. These have no Better Auth equivalent. Each one present is named in a warning at start-up, with what to use instead:

- `callbacks`, `events`: `betterAuth: { hooks, databaseHooks }`
- `pages`: your own pages; `betterAuth: { onAPIError: { errorURL } }`
- `adapter`: `betterAuth: { database }`
- `session.strategy`, `session.generateSessionToken`
- `cookies`, `trustHost`, `theme`, `logger`, `skipCSRFCheck`, `experimental`, `jwt`
- a provider whose `id` is not a Better Auth social provider, has no `clientId`, or that Better Auth refuses to build: it is left out and the others are still configured

## Feature helpers

`twoFactor()`, `organization()`, `anonymous()`, `bearerToken()`, `accountLinking()` and `rateLimit()` (exported from `@morojs/moro`) each stand for one Better Auth feature. `feature-helpers.ts` turns them into what is handed to `betterAuth()`:

```typescript
import {
  createAuthMiddleware,
  twoFactor,
  organization,
  anonymous,
  bearerToken,
  accountLinking,
  rateLimit,
} from '@morojs/moro';
import Database from 'better-sqlite3';

await app.use(
  createAuthMiddleware({
    secret: process.env.AUTH_SECRET,
    baseURL: 'http://localhost:3000',
    providers: [],
    plugins: [twoFactor({ issuer: 'Acme' }), organization(), anonymous(), bearerToken()],
    accountLinking: accountLinking(),
    rateLimit: rateLimit({ maxAttempts: 5, window: 300 }),
    betterAuth: { database: new Database('auth.db'), emailAndPassword: { enabled: true } },
  })
);
```

| Helper             | Better Auth                                                      | Option mapping                                                                                                                                                                                                     | Stores                                                                               |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `twoFactor()`      | plugin `twoFactor`, from `better-auth/plugins/two-factor`        | `issuer` → `issuer`; `totp: false` → `totpOptions.disable`; `backupCodesCount` → `backupCodeOptions.amount` (`backupCodes: false` → `0`); `trustDeviceDuration` → `trustDeviceMaxAge` (`trustDevice: false` → `0`) | table `twoFactor`, column `user.twoFactorEnabled`                                    |
| `organization()`   | plugin `organization`, from `better-auth/plugins/organization`   | `allowUserCreate` → `allowUserToCreateOrganization`; `maxOrganizationsPerUser` → `organizationLimit`; `organizationRoles: false`: warning, no equivalent                                                           | tables `organization`, `member`, `invitation`, column `session.activeOrganizationId` |
| `anonymous()`      | plugin `anonymous`, from `better-auth/plugins/anonymous`         | `linkOnSignUp: false` → `disableDeleteAnonymousUser`; `sessionDuration`: warning, no equivalent                                                                                                                    | column `user.isAnonymous`                                                            |
| `bearerToken()`    | plugin `bearer`, from `better-auth/plugins/bearer`               | `expiresIn`, `refreshTokens`, `refreshTokenExpiresIn`: warning, no equivalent                                                                                                                                      | nothing                                                                              |
| `accountLinking()` | option `account.accountLinking`                                  | defaults → `{ enabled: true, disableImplicitLinking: true }`; `autoLinkSameEmail: true` → `disableImplicitLinking: false`; both `false` → `{ enabled: false }`                                                     | nothing of its own                                                                   |
| `rateLimit()`      | option `rateLimit`, `enabled: true` with a rule for `/sign-in/*` | `maxAttempts` → `max`; `window` → `window`; `lockoutDuration`: warning, no equivalent                                                                                                                              | nothing by default                                                                   |

- A plugin module is imported from the application's `better-auth` only when its helper is passed: its own module first, then the `better-auth/plugins` barrel. When neither has it, `MoroJSAuth()` rejects with a message naming the helper and `npm install better-auth@latest`.
- The four plugin helpers take `betterAuth`: options handed to the plugin as they are, over the mapped ones.
- What the application sets in `betterAuth` itself wins. A plugin with the same id in `betterAuth.plugins` is the one used (one warning, and the helper's options are not applied); keys of `betterAuth.account.accountLinking` and `betterAuth.rateLimit` override the mapped ones.
- The routes of the plugins are among "any other path under `/api/auth`" below. `req.auth.session.activeOrganizationId` is set when the organization plugin is in use.
- `twoFactor()`, `organization()` and `anonymous()` store data. With no `betterAuth.database`, start-up logs a warning that Better Auth holds it in the memory of the process. With a database whose tables are missing, `createAuthMiddleware()` and `auth()` log an error at start-up that quotes what Better Auth reports; `MoroJSAuth()` on its own does not check, so that `getMigrations((await MoroJSAuth(config)).instance.options)` from `better-auth/db/migration` can create them.

The [Authentication Guide](../../../docs/AUTH_GUIDE.md#two-factor-organizations-anonymous-users-session-tokens-account-linking-rate-limits) has every option, the routes each plugin adds and the database set-up.

## Request Object

Every request gets an `auth` object:

```typescript
app.get('/api/user', async (req, res) => {
  const { isAuthenticated, user, session } = req.auth;

  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  res.json({
    user, // the Better Auth user: id, name, email, image, ...
    expires: session.expires, // ISO date string
  });
});
```

| Member                        | Value                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `isAuthenticated`             | `true` when Better Auth found a session for the request's cookies.                              |
| `user`                        | The Better Auth user (`id`, `name`, `email`, `image` and its other fields), or `null`.          |
| `session`                     | `{ user, expires }`, or `null`.                                                                 |
| `getSession()`                | Resolves to the same `session` value.                                                           |
| `getUser()`                   | Returns the same `user` value.                                                                  |
| `signIn(provider?, options?)` | Returns `{ url }`: `<basePath>/signin[/<provider>]`; `options.callbackUrl` is added as a query. |
| `signOut(options?)`           | Returns `{ url }`: `<basePath>/signout`; `options.callbackUrl` is added as a query.             |

The guards (`requireAuth()`, `requireRole()`, `requirePermission()`) read this object. A `roles` or `permissions` field on the Better Auth user is what they check; a `role` text (Better Auth's `admin` plugin) is also offered as `roles`.

A failed session lookup is treated as "not authenticated" rather than an error. Set `morojs.debug` to have the failure logged.

## Auth Routes

`createAuthMiddleware` serves these under `basePath` (`/api/auth` unless you set it):

| Request                                                                                     | Answer                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/signin`                                                                      | With one provider, a redirect to its sign-in URL; with several, a page of links (or JSON)                                                                                     |
| `GET` or `POST /api/auth/signin/<provider>` (`callbackUrl` in the query or body)            | Redirects to the provider's authorization page, and sets the OAuth state cookie                                                                                               |
| `GET /api/auth/callback/<provider>`                                                         | Where the provider sends the user back: sets the session cookies, then redirects to the callback URL                                                                          |
| `GET /api/auth/get-session`                                                                 | The session and user as JSON, or `null`                                                                                                                                       |
| `POST /api/auth/signout` (`callbackUrl` in the query or body)                               | Clears the session cookies; redirects a submitted form, answers a script `{ "success": true }`. A `GET` is accepted only as a same-origin browser navigation, otherwise `405` |
| `POST /api/auth/sign-in/social` with JSON `{ "provider": "github", "callbackURL": "/app" }` | Better Auth's own start: `200`, JSON `{ "url", "redirect": true }` and a `Location` header                                                                                    |
| `POST /api/auth/sign-out`                                                                   | `{ "success": true }`, and clears the session cookies                                                                                                                         |
| Any other path under `/api/auth`                                                            | Better Auth and its plugins                                                                                                                                                   |

A session created this way is the one `req.auth` reports on later requests. `/api/auth/signin/<provider>` and `/api/auth/signout` are the URLs `req.auth.signIn()` and `req.auth.signOut()` return.

- The routes are answered from the middleware chain, after the middleware registered before `app.use(createAuthMiddleware(...))` and before the router, for every method except `OPTIONS` and `HEAD`.
- A route the application registers itself under the base path takes precedence, so an application that mounts the handler by hand (below) is answered by its own routes, once.
- Better Auth answers a sign-in start with `200`, JSON and a `Location` header. That answer is relayed unchanged to a script and turned into a `302` for a browser that is navigating (`Sec-Fetch-Mode: navigate`, or a form content type from a client that sends no fetch metadata).

`MoroJSAuth(config)` resolves to the pieces `createAuthMiddleware` uses:

- `handler(req, res)` answers a request under `basePath`: every route in the table.
- `auth(req)` returns the session for a request, or `null`.
- `basePath`, `providers`, `signInUrl(provider?, options?)`, `signOutUrl(options?)`, and `instance`, the Better Auth instance.

To choose the routes yourself, pass `mountRoutes: false` and mount `handler`:

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
  baseURL: 'https://yourdomain.com',
};

const app = await createApp();

// req.auth on every request, no routes
await app.use(createAuthMiddleware({ ...authConfig, mountRoutes: false }));

// The routes this application exposes
const auth = await MoroJSAuth(authConfig);
app.get('/api/auth/:action', (req, res) => auth.handler(req, res));
app.post('/api/auth/:action', (req, res) => auth.handler(req, res));
app.get('/api/auth/:action/:provider', (req, res) => auth.handler(req, res));
app.post('/api/auth/:action/:provider', (req, res) => auth.handler(req, res));

app.listen(3000);
```

The two route shapes cover the routes in the table; a Better Auth route with more path segments needs a route of its own.

`morojs.transformers.request` and `morojs.transformers.response` apply to the requests the auth routes hand to Better Auth, not to the session lookup. They receive and must return the Web API `Request` and `Response`, not the MoroJS request and response. The `Request` a transformer receives has `basePath` removed from its path; it is put back before Better Auth is called, unless the transformer already did.

Better Auth rate-limits its routes per client address (in production by itself, everywhere with `rateLimit()`). With `server.trustProxy` set, the address is `req.ip`: the adapter passes it on in an `x-moro-client-ip` header it writes itself and does not hand on the `X-Forwarded-For` the request carried. Without the setting Better Auth reads `X-Forwarded-For` when that names exactly one address and `req.ip` otherwise, and with the limiter in force start-up logs one warning that a directly connected client can change that header. An application that sets `advanced.ipAddress.ipAddressHeaders` or `trustedProxies` in `betterAuth` keeps its own source. Start-up warnings are logged once per process.

## The other `createAuthMiddleware`

`src/core/middleware/built-in/auth/middleware.ts` also has a function named `createAuthMiddleware`: the `(req, res, next)` form of the built-in `auth()`. The package does not export it. `createAuthMiddleware` imported from `@morojs/moro` is always the one in this directory; the public form of the other is `auth(options)`, which uses `MoroJSAuth()` and `mountAuthRoutes()` from here for its sign-in routes.

## Environment Variables

```bash
# Read by the adapter
AUTH_SECRET=your-auth-secret-here   # used when `secret` is not set
BASE_URL=https://yourdomain.com     # used when `baseURL` is not set (AUTH_URL is the next fallback)

# Read by your own configuration, as in the samples above
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
```

## Files

```
src/core/auth/
├── morojs-adapter.ts   # MoroJSAuth() and createAuthMiddleware()
├── feature-helpers.ts  # twoFactor() ... rateLimit() mapped onto Better Auth's plugins and options
└── README.md           # This document
```

## License

MIT - See the [LICENSE](../../../LICENSE) file at the repository root.

## Links

- [Authentication Guide](../../../docs/AUTH_GUIDE.md)
- [Native adapter guide](../../../docs/NATIVE_AUTH_ADAPTER.md)
- [Better Auth documentation](https://better-auth.com/)
