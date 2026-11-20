# Authentication Guide for MoroJS

Authentication in MoroJS has three parts, and an application uses the ones it needs:

1. **Sign-in** (OAuth providers, email and password, sessions) runs on [Better Auth](https://better-auth.com/). MoroJS mounts its routes and puts the signed-in user on `req.auth`.
2. **Bearer tokens** for APIs: `auth()` verifies a JWT from the `Authorization` header and puts the user from its claims on `req.auth`.
3. **Guards** (`requireAuth()`, `requireRole()`, `requirePermission()`, `requireAdmin()`) and a route's `.auth()` read `req.auth`, whoever set it, including your own middleware.

Two optional peer packages do the cryptography. Install the ones you use:

```bash
npm install better-auth     # sign-in and sessions (>=1.7.7: earlier releases have published security advisories)
npm install jsonwebtoken    # Bearer tokens (>=9)
```

| You call                                   | Sign-in routes                                                                                                                                                                        | Bearer JWT | Sets `req.auth` from                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------- |
| `app.use(createAuthMiddleware(config))`    | Yes (needs `better-auth`)                                                                                                                                                             | No         | the Better Auth session                      |
| `app.use(auth(options))`                   | Yes, when `providers`, a [feature helper](#two-factor-organizations-anonymous-users-session-tokens-account-linking-rate-limits) or `betterAuth` is set and `better-auth` is installed | Yes        | the Bearer token, or the Better Auth session |
| your own middleware (see the third sample) | Yours                                                                                                                                                                                 | Yours      | whatever you decide                          |

## Sign-in with Better Auth

A complete application: sign in with GitHub, a page that needs a signed-in user, sign out.

```typescript
import { createApp, createAuthMiddleware, requireAuth } from '@morojs/moro';

const app = await createApp();

await app.use(
  createAuthMiddleware({
    secret: process.env.AUTH_SECRET,
    // The URL the application is reached at. OAuth redirect URIs are built from it.
    baseURL: 'http://localhost:3000',
    providers: [
      {
        id: 'github',
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    ],
  })
);

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

// A public page with a sign-in link, or the user's name and a sign-out button
app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!req.auth.isAuthenticated) {
    const { url } = await req.auth.signIn('github', { callbackUrl: '/dashboard' });
    return res.send(`<a href="${escapeHtml(url)}">Sign in with GitHub</a>`);
  }

  const { url } = await req.auth.signOut({ callbackUrl: '/' });
  res.send(
    `<p>Signed in as ${escapeHtml(req.auth.user.name ?? req.auth.user.email)}</p>` +
      `<form method="post" action="${escapeHtml(url)}"><button>Sign out</button></form>`
  );
});

// Signed-in users only; anyone else is sent to sign in and comes back here
app
  .get('/dashboard')
  .before(requireAuth({ redirectTo: '/api/auth/signin' }))
  .handler(req => ({ hello: req.auth.user.name, email: req.auth.user.email }));

app.listen(3000);
```

Register `http://localhost:3000/api/auth/callback/github` as the callback URL of the GitHub OAuth app. What happens:

1. `GET /` shows the link `/api/auth/signin/github?provider=github&callbackUrl=%2Fdashboard`.
2. That URL redirects the browser to GitHub. GitHub sends it back to `/api/auth/callback/github`, where Better Auth exchanges the code, sets the session cookie and redirects to `/dashboard`.
3. On every later request `req.auth.isAuthenticated` is `true` and `req.auth.user` is the Better Auth user, so `requireAuth()` lets the request through.
4. The form posts to `/api/auth/signout?callbackUrl=%2F`, which ends the session and redirects to `/`.

Without a `database` (see [Passing options to Better Auth](#passing-options-to-better-auth)) Better Auth keeps the session in signed cookies and stores nothing on the server.

```bash
AUTH_SECRET=a-random-string-of-at-least-32-characters
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
```

`auth()` gives the same sign-in when it has providers and `better-auth` is installed, and verifies Bearer tokens as well:

```typescript
import { createApp, auth, providers, requireAuth } from '@morojs/moro';

const app = await createApp();

await app.use(
  auth({
    secret: process.env.AUTH_SECRET,
    baseURL: 'http://localhost:3000',
    providers: [
      providers.github({
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      }),
    ],
  })
);

app
  .get('/dashboard')
  .before(requireAuth({ redirectTo: '/api/auth/signin' }))
  .handler(req => ({ hello: req.auth.user.name }));

app.listen(3000);
```

When `better-auth` is not installed, `auth()` mounts no sign-in routes (requests under `/api/auth` get the application's ordinary 404) and logs one warning at start-up saying that the sign-in routes need the package. Bearer tokens and the guards work without it.

## Bearer tokens for an API

A complete API: it issues a token after checking a password its own way, and `auth()` verifies the token on every other request.

```typescript
import { createApp, auth, requireAuth, requirePermission } from '@morojs/moro';
import jwt from 'jsonwebtoken';

const SECRET = process.env.AUTH_SECRET!;
const app = await createApp();

// Verifies `Authorization: Bearer <jwt>` and sets req.auth
await app.use(auth({ secret: SECRET, jwt: { audience: 'orders-api' } }));

// Issuing tokens is yours: check the credentials, sign the claims
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== 'ada' || password !== 'correct horse battery staple') {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { sub: 'user-1', name: 'Ada', roles: ['admin'], permissions: ['orders:read'] },
    SECRET,
    { audience: 'orders-api', expiresIn: '15m' }
  );
  res.json({ token });
});

// Any valid token
app
  .get('/whoami')
  .before(requireAuth())
  .handler(req => req.auth.user);

// The `permissions` claim must contain orders:read
app
  .get('/orders')
  .before(requirePermission('orders:read'))
  .handler(req => ({ orders: [], for: req.auth.user.id }));

// The `roles` claim must contain admin
app
  .get('/admin/stats')
  .auth({ roles: ['admin'] })
  .handler(() => ({ users: 1 }));

app.listen(3000);
```

```bash
TOKEN=$(curl -s localhost:3000/login -H 'content-type: application/json' \
  -d '{"username":"ada","password":"correct horse battery staple"}' | jq -r .token)

curl localhost:3000/whoami -H "authorization: Bearer $TOKEN"
# {"id":"user-1","name":"Ada","roles":["admin"],"permissions":["orders:read"]}

curl -i localhost:3000/orders          # 401: no token
```

How a token becomes `req.auth`:

- **The user.** `sub` (or `userId`, or `id`) becomes `req.auth.user.id`; a token without one does not authenticate. Every other claim that is not a registered JWT claim (`iss`, `sub`, `aud`, `exp`, `nbf`, `iat`, `jti`) is copied onto `req.auth.user`: `name`, `email`, `roles`, `permissions` and your own. `picture` is also available as `image`.
- **Roles and permissions.** The guards read `req.auth.user.roles` and `req.auth.user.permissions`: an array of names, or one string of names separated by commas or spaces.
- **Verification.** HS256 unless `jwt.algorithms` names others (verifying with a public key requires it, for example `['RS256']`). `exp` and `nbf` are enforced. `jwt.audience` and `jwt.issuer`, when set, must match the token's `aud` and `iss`; `jwt.maxAge` (seconds) also refuses a token older than that by its `iat`.
- **`req.auth.token`** is the token, and **`await req.auth.getToken()`** its verified claims. Both are only ever set for a token that verified.
- **A token that does not verify** (expired, wrong signature, `alg: none`, wrong audience, no subject) never authenticates. A request that sent `Accept: application/json` is answered `401` at once, with the reason (`Token expired`, `Invalid token`, `Token not ready`). Any other request goes on unauthenticated, so a guard answers `401` or redirects to your sign-in page.

**Which secret.** The first of: the `jwt.secret` option, the `secret` option, the `JWT_SECRET` environment variable, `NEXTAUTH_SECRET`, `AUTH_SECRET`. An option always wins over the environment.

Every JWT signed with that secret that names a subject is accepted as an access token. If the same secret also signs other tokens (email confirmation links, password resets), set `jwt.audience` and put the matching `aud` only in access tokens, or give access tokens a `jwt.secret` of their own.

To verify tokens some other way (a JWKS endpoint, an opaque token looked up in a store), supply `jwt.decode`: it receives `{ token, secret }` and returns the claims, or `null` to refuse the token. `jsonwebtoken` is not needed then.

## Your own authentication, MoroJS guards

The guards only read `req.auth`. An application with its own way of knowing who is calling sets `req.auth` in a middleware and uses the guards unchanged:

```typescript
import { createApp, requireAuth, requireRole, authUtils } from '@morojs/moro';

const app = await createApp();

// Your authentication: here, API keys looked up in a table
const API_KEYS: Record<string, { id: string; name: string; roles: string[] }> = {
  'key-ada': { id: 'user-1', name: 'Ada', roles: ['admin'] },
  'key-bob': { id: 'user-2', name: 'Bob', roles: ['viewer'] },
};

app.use((req, res, next) => {
  const user = API_KEYS[String(req.headers['x-api-key'])];
  // What the guards need: isAuthenticated, and the user with its roles / permissions
  req.auth = { isAuthenticated: Boolean(user), user };
  next();
});

app
  .get('/profile')
  .before(requireAuth())
  .handler(req => ({ id: authUtils.getUserId(req), name: req.auth.user.name }));

app
  .get('/admin')
  .before(requireRole('admin'))
  .handler(() => ({ admin: true }));

app.listen(3000);
```

```bash
curl -i localhost:3000/profile                         # 401
curl localhost:3000/profile -H 'x-api-key: key-bob'    # {"id":"user-2","name":"Bob"}
curl -i localhost:3000/admin -H 'x-api-key: key-bob'   # 403
curl localhost:3000/admin -H 'x-api-key: key-ada'      # {"admin":true}
```

To verify JWTs in such a middleware, see [Custom JWT Middleware](#custom-jwt-middleware).

## Available Auth Routes

These exist when Better Auth serves sign-in: with `createAuthMiddleware()`, or with `auth()` given `providers`, a feature helper or `betterAuth`, and `better-auth` installed. They are under `basePath`, `/api/auth` by default. Without Better Auth there are no auth routes.

| Route                                                                                                                           | What it does                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/signin`                                                                                                          | Where to send a visitor who must sign in. With one provider it redirects to that provider's URL below; with several it answers a page of links (or JSON, to a client that does not accept HTML). Takes `callbackUrl`.                                             |
| `GET` or `POST /api/auth/signin/:provider`                                                                                      | Starts the provider's sign-in and redirects to the provider. `callbackUrl` (query, or form / JSON body) is where the visitor ends up afterwards. This is the URL `req.auth.signIn(provider, { callbackUrl })` returns.                                            |
| `GET /api/auth/callback/:provider`                                                                                              | Better Auth's callback: the provider sends the visitor back here. Sets the session cookie and redirects to the callback URL.                                                                                                                                      |
| `GET /api/auth/get-session`                                                                                                     | The session and user as JSON, or `null`.                                                                                                                                                                                                                          |
| `POST /api/auth/signout`                                                                                                        | Ends the session. Redirects a submitted form to `callbackUrl` (default `/`); answers a script `{ "success": true }`. This is the URL `req.auth.signOut({ callbackUrl })` returns. A `GET` is accepted only as a same-origin browser navigation (otherwise `405`). |
| `POST /api/auth/sign-in/social`, `POST /api/auth/sign-out`, `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`, ... | Better Auth's own API, as its client library (`better-auth/client`) calls it, and every route its plugins add. See the [Better Auth documentation](https://better-auth.com/docs).                                                                                 |

A route your application registers under the base path takes precedence over these. The routes are answered after the middleware registered before `app.use(auth(...))` / `app.use(createAuthMiddleware(...))`, so CORS and security headers apply to them.

There is no `/api/auth/session`, `/api/auth/csrf` or `/api/auth/providers` route. For a provider list of your own, `await req.auth.getProviders()` (with `auth()`) returns the configured providers without their credentials.

**Forms and scripts.** Better Auth answers some requests (starting a social sign-in; an email sign-in given a `callbackURL`) with `200`, a JSON body and a `Location` header, because its client library reads the body and navigates. MoroJS passes that answer on unchanged to a script, and turns it into a `302` for a browser that is navigating: a request with `Sec-Fetch-Mode: navigate`, or, from a client that sends no fetch metadata, a form content type. So both `fetch('/api/auth/sign-in/email', ...)` and `<form method="post" action="/api/auth/sign-in/email">` work.

**Cross-site requests.** Better Auth refuses a state-changing request that carries cookies and comes from an origin outside `trustedOrigins` (default: the origin of `baseURL`), and a `callbackUrl` that is neither a path nor on a trusted origin. Add the origin of a front end served elsewhere to `trustedOrigins`.

## Providers

Each entry of `providers` names a Better Auth social provider by `id` and carries its options. Every provider Better Auth knows can be used: `apple`, `atlassian`, `cognito`, `discord`, `dropbox`, `facebook`, `figma`, `github`, `gitlab`, `google`, `huggingface`, `kakao`, `kick`, `line`, `linear`, `linkedin`, `microsoft`, `naver`, `notion`, `paypal`, `reddit`, `roblox`, `salesforce`, `slack`, `spotify`, `tiktok`, `twitch`, `twitter`, `vercel`, `vk`, `zoom` and the others its [documentation](https://better-auth.com/docs) lists.

```typescript
import { createApp, createAuthMiddleware, providers, extendedProviders } from '@morojs/moro';

const app = await createApp();

await app.use(
  createAuthMiddleware({
    secret: process.env.AUTH_SECRET,
    baseURL: 'http://localhost:3000',
    providers: [
      // A plain entry: `id` plus the options of that Better Auth provider
      {
        id: 'gitlab',
        clientId: process.env.GITLAB_CLIENT_ID!,
        clientSecret: process.env.GITLAB_CLIENT_SECRET!,
      },

      // The helpers build the same entries
      providers.github({
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        scope: 'read:user user:email repo',
      }),

      // Only accounts of one Google Workspace domain
      extendedProviders.google({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        hostedDomain: 'yourcompany.com',
      }),

      // One Microsoft Entra ID tenant
      extendedProviders.microsoft({
        clientId: process.env.MICROSOFT_CLIENT_ID!,
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
        tenant: process.env.MICROSOFT_TENANT_ID,
      }),
    ],
  })
);

app.listen(3000);
```

What is passed on from an entry: every field except the ones that only describe the provider (`name`, `type`, `authorization`, `token`, `userinfo`, `issuer`, `wellKnown`, `profile`). A `scope` written as one string becomes Better Auth's list; `hostedDomain` becomes Google's `hd`; `tenant` becomes Microsoft's `tenantId`. Better Auth's own option names (`prompt`, `redirectURI`, `mapProfileToUser`, `disableSignUp`, ...) go through as they are.

An entry whose `id` Better Auth does not know (`okta`, `auth0`, a provider from `createCustomOAuthProvider()`, `providers.credentials()`, `providers.email()`) is not configured, and start-up logs a warning naming it. Use the pass-through below for those: Better Auth's `genericOAuth` plugin for any OAuth 2 / OpenID Connect provider, `emailAndPassword` for passwords, its `magicLink` / `emailOTP` plugins for email links and codes.

## Passing options to Better Auth

`betterAuth` hands options straight to `betterAuth()`: a database, email and password, plugins, hooks, rate limits. Both `createAuthMiddleware()` and `auth()` take it.

```typescript
import { createApp, createAuthMiddleware, requireAuth } from '@morojs/moro';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { genericOAuth } from 'better-auth/plugins';

const app = await createApp();

await app.use(
  createAuthMiddleware({
    secret: process.env.AUTH_SECRET,
    baseURL: 'http://localhost:3000',
    providers: [],
    betterAuth: {
      // Where users and sessions are stored. memoryAdapter keeps them in this
      // process, which is enough to try things out: use a real database
      // (https://better-auth.com/docs/concepts/database) for anything else.
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),

      // POST /api/auth/sign-up/email and POST /api/auth/sign-in/email
      emailAndPassword: { enabled: true },

      // Any OAuth 2 / OpenID Connect provider: sign in at /api/auth/signin/company-sso
      plugins: [
        genericOAuth({
          config: [
            {
              providerId: 'company-sso',
              clientId: process.env.SSO_CLIENT_ID!,
              clientSecret: process.env.SSO_CLIENT_SECRET!,
              discoveryUrl: 'https://sso.yourcompany.com/.well-known/openid-configuration',
            },
          ],
        }),
      ],
    },
  })
);

app
  .get('/account')
  .before(requireAuth())
  .handler(req => ({ email: req.auth.user.email }));

app.listen(3000);
```

```bash
curl -c jar -H 'content-type: application/json' localhost:3000/api/auth/sign-up/email \
  -d '{"name":"Ada","email":"ada@example.com","password":"correct horse battery staple"}'
curl -b jar localhost:3000/account     # {"email":"ada@example.com"}
```

A key given in `betterAuth` wins over the value MoroJS derives from the other options; `socialProviders` and `session` are merged with the derived ones. `req.auth.user` carries every field Better Auth returns for the user, including the ones you add with `user.additionalFields`, so a `roles` or `permissions` field on your users is what `requireRole()` and `requirePermission()` check. The single `role` field of Better Auth's `admin` plugin is also offered as `roles`.

### Auth.js-style keys that are not used

The configuration type still accepts the keys of an Auth.js configuration so that an existing object can be passed. The ones Better Auth has no equivalent for do nothing, and each is named in a warning at start-up:

| Key                                                | Use instead                                                                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `callbacks`                                        | `betterAuth: { hooks, databaseHooks }` (for example `databaseHooks.user.create.before` to refuse a sign-up); `mapProfileToUser` on a provider entry |
| `events`                                           | `betterAuth: { databaseHooks }` (`user.create.after`, `session.create.after`) or `betterAuth: { hooks: { after } }`                                 |
| `pages`                                            | Your own pages, linked to `req.auth.signIn(provider).url`; `betterAuth: { onAPIError: { errorURL } }` for the error page                            |
| `adapter`                                          | `betterAuth: { database }`                                                                                                                          |
| `session.strategy`                                 | Nothing: without a database sessions live in signed cookies, with one they are stored in it                                                         |
| `cookies`                                          | `betterAuth: { advanced: { cookies, cookiePrefix } }`                                                                                               |
| `trustHost`                                        | `baseURL`; behind a proxy `betterAuth: { advanced: { trustedProxyHeaders } }`                                                                       |
| `theme`, `logger`, `skipCSRFCheck`, `experimental` | `betterAuth: { logger }`, `betterAuth: { advanced: { disableCSRFCheck } }`, Better Auth plugins                                                     |
| `jwt.encode` (with `auth()`)                       | Nothing: `auth()` verifies Bearer tokens and does not issue them                                                                                    |

These are used: `session.maxAge` (Better Auth's `expiresIn`), `session.updateAge` and Better Auth's other session settings (`freshAge`, `cookieCache`, ...), `useSecureCookies`, `debug` (turns on Better Auth's debug logging), `trustedOrigins`, `baseURL`, `basePath`.

## Two-factor, organizations, anonymous users, session tokens, account linking, rate limits

Six helpers each turn on one Better Auth feature. Four stand for a Better Auth plugin and go in `plugins`; two stand for a Better Auth option and have a key of their own. Both `auth()` and `createAuthMiddleware()` take them, and the types refuse a helper in the wrong place.

| Helper             | Passed as                          | Better Auth feature                 |
| ------------------ | ---------------------------------- | ----------------------------------- |
| `twoFactor()`      | `plugins: [twoFactor()]`           | the `twoFactor` plugin              |
| `organization()`   | `plugins: [organization()]`        | the `organization` plugin           |
| `anonymous()`      | `plugins: [anonymous()]`           | the `anonymous` plugin              |
| `bearerToken()`    | `plugins: [bearerToken()]`         | the `bearer` plugin                 |
| `accountLinking()` | `accountLinking: accountLinking()` | the `account.accountLinking` option |
| `rateLimit()`      | `rateLimit: rateLimit()`           | the `rateLimit` option              |

A complete application with all six, on SQLite (`npm install better-auth better-sqlite3`):

```typescript
import {
  createApp,
  auth,
  MoroJSAuth,
  requireAuth,
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

const authOptions = {
  secret: process.env.AUTH_SECRET,
  baseURL: 'http://localhost:3000',
  plugins: [
    twoFactor({ issuer: 'Acme' }),
    organization({ maxOrganizationsPerUser: 3 }),
    anonymous(),
    bearerToken(),
  ],
  accountLinking: accountLinking(),
  rateLimit: rateLimit({ maxAttempts: 5, window: 300 }),
  betterAuth: {
    database: new Database('auth.db'),
    emailAndPassword: { enabled: true },
  },
};

// Create the tables this configuration writes to (see "The database" below)
const { instance } = await MoroJSAuth(authOptions);
const { runMigrations } = await getMigrations(instance.options);
await runMigrations();

await app.use(auth(authOptions));

app
  .get('/me')
  .before(requireAuth())
  .handler(req => ({
    email: req.auth.user.email,
    twoFactorEnabled: req.auth.user.twoFactorEnabled,
    isAnonymous: req.auth.user.isAnonymous,
    activeOrganizationId: req.auth.session.activeOrganizationId,
  }));

app.listen(3000);
```

```bash
curl -c jar -H 'content-type: application/json' localhost:3000/api/auth/sign-up/email \
  -d '{"name":"Ada","email":"ada@example.com","password":"correct horse battery staple"}'
curl -b jar localhost:3000/me
# {"email":"ada@example.com","twoFactorEnabled":false,"isAnonymous":false,"activeOrganizationId":null}
```

The plugin modules are loaded from your application's `better-auth`, and only for the helpers you pass: an application that passes none loads none. Each plugin's routes are served under `basePath` by the routes `auth()` and `createAuthMiddleware()` already mount: on the Node server, the native engine and the HTTP/2 server, and through `app.getHandler()` on AWS Lambda, Vercel Edge and Cloudflare Workers. When the installed `better-auth` does not have a plugin a helper needs, start-up fails with a message naming the helper and `npm install better-auth@latest`. When `better-auth` is not installed at all, `auth()` starts without the helpers and logs a warning naming them; `createAuthMiddleware()` fails with "Better Auth package not found".

Each of the four plugin helpers also takes `betterAuth`: options handed to the Better Auth plugin as they are, over the ones the helper derives. If you pass the same Better Auth plugin yourself in `betterAuth: { plugins: [...] }`, yours is the one used, the helper's options are not applied, and start-up logs one warning saying so. An option Better Auth has no equivalent for is not applied and is named in a start-up warning; the tables below say which. A start-up warning is logged once per process: a script that calls `MoroJSAuth()` and then installs `auth()` with the same configuration sees each one once.

### `twoFactor(options)`

```typescript
import { auth, twoFactor } from '@morojs/moro';
import Database from 'better-sqlite3';

const database = new Database('auth.db');

app.use(
  auth({
    secret: process.env.AUTH_SECRET,
    plugins: [
      twoFactor({ issuer: 'Acme', backupCodesCount: 8, trustDeviceDuration: 7 * 24 * 60 * 60 }),
    ],
    betterAuth: { database, emailAndPassword: { enabled: true } },
  })
);
```

| Option                | Default                                                       | Better Auth option                                                                                              |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `issuer`              | `betterAuth.appName` when you set one, otherwise `MoroJS App` | `issuer`: the name an authenticator app shows                                                                   |
| `totp`                | `true`                                                        | `false` sets `totpOptions.disable`: enabling TOTP then answers `400`                                            |
| `backupCodes`         | `true`                                                        | `false` sets `backupCodeOptions.amount: 0`: no backup codes are issued                                          |
| `backupCodesCount`    | `10`                                                          | `backupCodeOptions.amount`                                                                                      |
| `trustDevice`         | `true`                                                        | `false` sets `trustDeviceMaxAge: 0`: `trustDevice: true` in a verification is accepted but trusts nothing       |
| `trustDeviceDuration` | `2592000` (30 days)                                           | `trustDeviceMaxAge`, in seconds                                                                                 |
| `betterAuth`          | none                                                          | Handed to the plugin as it is: `otpOptions` (codes by email), `accountLockout`, `skipVerificationOnEnable`, ... |

What it adds, under `/api/auth`:

| Request                                                     | Answer                                                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /two-factor/enable` `{ "password" }` (signed in)      | `{ totpURI, backupCodes }`: show `totpURI` as a QR code                                                                                 |
| `POST /two-factor/verify-totp` `{ "code" }`                 | Confirms the set-up; `req.auth.user.twoFactorEnabled` is `true` from then on                                                            |
| `POST /sign-in/email` for a user who has it on              | `{ "twoFactorRedirect": true, "twoFactorMethods": ["totp"] }` and no session: the request stays unauthenticated until the next step     |
| `POST /two-factor/verify-totp` `{ "code", "trustDevice"? }` | Completes the sign-in and sets the session cookie. With `trustDevice: true` that device skips the second step for `trustDeviceDuration` |
| `POST /two-factor/verify-backup-code` `{ "code" }`          | Completes the sign-in with a backup code. Each code works once                                                                          |
| `POST /two-factor/disable` `{ "password" }`                 | Turns it off for the user                                                                                                               |

Stores: the table `twoFactor` and the column `user.twoFactorEnabled`.

### `organization(options)`

```typescript
import { auth, organization } from '@morojs/moro';
import Database from 'better-sqlite3';

const database = new Database('auth.db');

app.use(
  auth({
    secret: process.env.AUTH_SECRET,
    plugins: [organization({ maxOrganizationsPerUser: 3 })],
    betterAuth: { database, emailAndPassword: { enabled: true } },
  })
);

// The organization the session is working in
app.get('/projects', req => projects.list(req.auth.session.activeOrganizationId));
```

| Option                    | Default | Better Auth option                                                                                                                                         |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowUserCreate`         | `true`  | `allowUserToCreateOrganization`: `false` answers `403` to `organization/create`                                                                            |
| `maxOrganizationsPerUser` | `10`    | `organizationLimit`: a user who already belongs to that many gets `403` creating another. Better Auth on its own has no limit; this helper's default is 10 |
| `organizationRoles`       | `true`  | None. Better Auth's organizations always have member roles (owner, admin, member); `false` is not applied and start-up logs a warning                      |
| `betterAuth`              | none    | Handed to the plugin as it is: `sendInvitationEmail`, `teams`, `membershipLimit`, `creatorRole`, `ac`, `roles`, ...                                        |

What it adds: the routes under `/api/auth/organization/`, among them `POST create` `{ "name", "slug" }`, `GET list`, `GET get-full-organization`, `POST set-active` `{ "organizationId" }`, `POST invite-member`. The user who creates an organization is its `owner` and it becomes the session's active organization. `req.auth.session.activeOrganizationId` is that organization's id, or `null` when none is active.

Stores: the tables `organization`, `member` and `invitation`, and the column `session.activeOrganizationId`.

### `anonymous(options)`

```typescript
import { auth, anonymous } from '@morojs/moro';
import Database from 'better-sqlite3';

const database = new Database('auth.db');

app.use(
  auth({
    secret: process.env.AUTH_SECRET,
    plugins: [
      anonymous({
        betterAuth: {
          // Called when an anonymous visitor signs up or signs in
          onLinkAccount: async ({ anonymousUser, newUser }) => {
            await carts.move(anonymousUser.user.id, newUser.user.id);
          },
        },
      }),
    ],
    betterAuth: { database, emailAndPassword: { enabled: true } },
  })
);
```

| Option            | Default             | Better Auth option                                                                                                                                                                                                                                                            |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linkOnSignUp`    | `true`              | `true` is Better Auth's behaviour: when the visitor signs up or signs in, `onLinkAccount` is called with both users and the anonymous user is deleted. `false` sets `disableDeleteAnonymousUser`: the anonymous user is kept, and `POST /delete-anonymous-user` answers `400` |
| `sessionDuration` | `2592000` (30 days) | None. Better Auth has one session lifetime for every user (`session.maxAge`); a value that differs from it is not applied and start-up logs a warning                                                                                                                         |
| `betterAuth`      | none                | Handed to the plugin as it is: `onLinkAccount`, `emailDomainName`, `generateName`, ...                                                                                                                                                                                        |

What it adds: `POST /api/auth/sign-in/anonymous` creates a user with no credentials and signs it in, and `POST /api/auth/delete-anonymous-user` deletes it. `req.auth.user.isAnonymous` is `true` for such a user. When the same browser then signs up or signs in, the session becomes the real user's.

Stores: the column `user.isAnonymous`.

### `bearerToken(options)`

```typescript
import { auth, bearerToken } from '@morojs/moro';
import Database from 'better-sqlite3';

const database = new Database('auth.db');

app.use(
  auth({
    secret: process.env.AUTH_SECRET,
    plugins: [bearerToken()],
    betterAuth: { database, emailAndPassword: { enabled: true } },
  })
);
```

```bash
# Sign in: the session token is in the set-auth-token response header
curl -i -H 'content-type: application/json' localhost:3000/api/auth/sign-in/email \
  -d '{"email":"ada@example.com","password":"correct horse battery staple"}'
# Send it instead of the cookie
curl localhost:3000/me -H "authorization: Bearer $TOKEN"
```

With it, a request that sends a session token as `Authorization: Bearer <token>` is authenticated as that session, on the auth routes and on your own (`req.auth`), with no cookie. Signing out ends the token with the session.

It works beside `auth({ jwt })`, not instead of it. `auth()` first verifies a Bearer token as a JWT signed with your secret, exactly as it does without this helper, and a valid one authenticates the request from its claims. Only a token that is not such a JWT is offered to Better Auth as a session token. `createAuthMiddleware()` does not verify JWTs, with or without the helper.

| Option                                                | Default | Better Auth option                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expiresIn`, `refreshTokens`, `refreshTokenExpiresIn` | none    | None. The token is the session token: it lives as long as the session (`session.maxAge`), Better Auth extends a session that is in use (`session.updateAge`), and there are no refresh tokens. A value given for any of the three is not applied and start-up logs a warning |
| `betterAuth`                                          | none    | Handed to the plugin as it is: `requireSignature: true` accepts only the signed token from the `set-auth-token` header, not the bare `token` of the sign-in response body                                                                                                    |

Stores nothing of its own.

### `accountLinking(options)`

```typescript
import { auth, accountLinking, providers } from '@morojs/moro';
import Database from 'better-sqlite3';

const database = new Database('auth.db');

app.use(
  auth({
    secret: process.env.AUTH_SECRET,
    providers: [
      providers.github({
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      }),
      providers.google({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      }),
    ],
    accountLinking: accountLinking({ autoLinkSameEmail: true }),
    betterAuth: { database },
  })
);
```

| `autoLinkSameEmail` | `allowManualLink` | Better Auth's `account.accountLinking`             | Effect                                                                                                                                                                 |
| ------------------- | ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `false` (default)   | `true` (default)  | `{ enabled: true, disableImplicitLinking: true }`  | A sign-in with a second provider under the same email address is refused (`error=account_not_linked`). The user links it while signed in: `POST /api/auth/link-social` |
| `true`              | `true`            | `{ enabled: true, disableImplicitLinking: false }` | A second provider with the same address signs the same user in, when the provider reports the address as verified and the existing user's address is verified          |
| `false`             | `false`           | `{ enabled: false }`                               | No linking, automatic or by hand                                                                                                                                       |
| `true`              | `false`           | `{ enabled: true, disableImplicitLinking: false }` | Better Auth cannot turn off only linking by hand: `allowManualLink: false` is not applied here and start-up logs a warning                                             |

Better Auth on its own links automatically; passing `accountLinking()` with its defaults turns that off. A key you also set in `betterAuth: { account: { accountLinking: { ... } } }` (`trustedProviders`, `allowDifferentEmails`, ...) is the one used. `GET /api/auth/list-accounts` lists the providers linked to the signed-in user.

Stores nothing of its own: a linked provider is a row of Better Auth's `account` table.

### `rateLimit(options)`

```typescript
import { auth, rateLimit } from '@morojs/moro';
import Database from 'better-sqlite3';

const database = new Database('auth.db');

app.use(
  auth({
    secret: process.env.AUTH_SECRET,
    rateLimit: rateLimit({ maxAttempts: 5, window: 300 }),
    betterAuth: { database, emailAndPassword: { enabled: true } },
  })
);
```

| Option            | Default | Better Auth option                                                                                                                                                                                                                               |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxAttempts`     | `5`     | `max` of a rule for `/sign-in/*` (`rateLimit.customRules`)                                                                                                                                                                                       |
| `window`          | `300`   | `window` of that rule, in seconds                                                                                                                                                                                                                |
| `lockoutDuration` | `900`   | None. Better Auth's rate limiter has no separate lockout: a client that has used its attempts is refused until `window` seconds after the last attempt it counted. A value that differs from `window` is not applied and start-up logs a warning |

Passing it sets Better Auth's `rateLimit.enabled: true`, so the limiter runs in every environment (on its own Better Auth runs it in production only), and adds the rule above. Better Auth counts every request to a route under `/api/auth/sign-in/` from one client address, successful or not; once `maxAttempts` have been made within `window` seconds, the next ones are answered `429` with an `X-Retry-After` header and `{ "message": "Too many requests. Please try again later." }`, a correct password included. Better Auth's own limits for its other routes (for example three two-factor verifications in ten seconds) apply as well once the limiter is on. Your application's own routes are not limited by it; use a route's `.rateLimit()` for those.

**Which client address is counted.** Set [`server.trustProxy`](./CONFIGURATION_REFERENCE.md#behind-a-proxy) (`false` when clients connect directly, `1` for one proxy, or the proxies' addresses). The limit is then counted against `req.ip`, and an `X-Forwarded-For` header a client sends cannot change it. Without the setting Better Auth counts by `X-Forwarded-For` whenever a request carries exactly one address there, which is right behind a proxy that writes the header and lets a directly connected client step around the limit by changing it; start-up logs one warning saying so while the limiter is in force. The [adapter guide](./NATIVE_AUTH_ADAPTER.md#security-configuration) has the details, including the serverless runtimes.

A key you also set in `betterAuth: { rateLimit: { ... } }` (`enabled`, `storage`, other `customRules`) is the one used. Counts are kept in the memory of the process, per client address and route; `betterAuth: { rateLimit: { storage: 'database' } }` keeps them in the table `rateLimit` instead, which is what several processes behind one address need.

### The database

`twoFactor()`, `organization()` and `anonymous()` keep data in Better Auth's database; so do users, passwords, sessions and linked accounts. Give Better Auth one with `betterAuth: { database }` and create its tables before the application serves requests. The tables and columns depend on the configuration, so create them again after adding a helper.

- **No database.** Better Auth keeps sessions in signed cookies and everything else (users, and what the helpers store) in the memory of the process: it works, is gone at restart, and is not shared between processes. With one of the three helpers above and no database, start-up logs one warning saying so and listing what each helper stores.
- **A database Better Auth migrates itself** (a `better-sqlite3`, `pg` or `mysql2` connection passed as `database`). Better Auth's `getMigrations()` creates what is missing. `MoroJSAuth(config).instance.options` is the configuration Better Auth runs with, helpers included:

  ```typescript
  import { MoroJSAuth } from '@morojs/moro';
  import { getMigrations } from 'better-auth/db/migration';

  const { instance } = await MoroJSAuth(authOptions);
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(instance.options);
  console.log(
    'creating',
    toBeCreated.map(t => t.table),
    'altering',
    toBeAdded.map(t => t.table)
  );
  await runMigrations();
  ```

  Run it when the application starts, as the complete sample above does, or as a step of your deployment. It changes nothing when the tables are already there. On the very first run, before the tables exist, Better Auth 1.7.7 itself logs a "Database schema mismatch" error when the instance is created (1.7.25 does not); the migration that follows resolves it.

- **Drizzle, Prisma, MongoDB** (an adapter passed as `database`). The schema lives in your ORM: generate it with Better Auth's CLI and apply it with your migration tool, as the [Better Auth database guide](https://better-auth.com/docs/concepts/database) describes.

When the database is missing a table or column the configuration writes, Better Auth refuses every request. With a helper that stores data, `auth()` and `createAuthMiddleware()` say so once at start-up, in an error that lists what each helper stores and quotes what Better Auth reports missing and the command it names. The application still starts: until the tables exist, the routes under `/api/auth` answer `500` with `{ "error": "Internal server error", "message": "Authentication error" }` (the reason is in the log), and every request is unauthenticated.

## Guards and helpers

```typescript
import {
  createApp,
  auth,
  requireAuth,
  requireRole,
  requireAdmin,
  requirePermission,
  authUtils,
  authResponses,
} from '@morojs/moro';

const app = await createApp();
await app.use(auth({ secret: process.env.AUTH_SECRET }));

// Signed in
app
  .get('/dashboard')
  .before(requireAuth())
  .handler(req => authUtils.getUser(req));

// One of these roles
app
  .get('/reports')
  .before(requireRole(['admin', 'analyst']))
  .handler(() => ({ reports: [] }));

// The admin role (shorthand for requireRole('admin'))
app
  .get('/admin/users')
  .before(requireAdmin())
  .handler(() => ({ users: [] }));

// Every one of these permissions
app
  .get('/api/users')
  .before(requirePermission(['users:read', 'users:list']))
  .handler(() => ({ users: [] }));

// Your own rule on the signed-in user, and your own answers
app
  .get('/organization/:orgId/data')
  .before(
    requireAuth({
      authorize: async user => Boolean(user.organizationId),
      onUnauthorized: (req, res) => res.status(401).json({ error: 'Sign in first' }),
      onForbidden: (req, res) => res.status(403).json({ error: 'No organization' }),
    })
  )
  .handler((req, res) => {
    // `authorize` receives only the user; compare against the request here
    if (authUtils.getUser(req).organizationId !== req.params.orgId) {
      return authResponses.forbidden(res, 'Access denied to this organization');
    }
    return { organizationId: req.params.orgId };
  });

// The same checks declared on the route
app
  .get('/billing')
  .auth({ roles: ['admin'], permissions: ['billing:read'] })
  .handler(() => ({ invoices: [] }));

app.listen(3000);
```

A guard answers `401` (`{ error: 'Authentication required', message, signInUrl: '/api/auth/signin' }`) when nobody is signed in and `403` when the role, permission or `authorize` check fails. With `redirectTo` it redirects to `<redirectTo>?callbackUrl=<the requested URL>` instead of the `401`, which `/api/auth/signin` understands. The `signInUrl` in the `401` body is that same default URL: it exists when the Better Auth routes are mounted at the default base path, so with your own sign-in pass `onUnauthorized` or `redirectTo`.

Guards are standard `(req, res, next)` middleware: attach them with `.before(...)` on a route, or protect every route with `app.use(requireAuth())`, registered after `auth()` / `createAuthMiddleware()` so that the sign-in routes stay reachable. They must be called: `requireAuth()`, not `requireAuth`.

### Manual checks

```typescript
import { createApp, auth, authUtils, authResponses } from '@morojs/moro';

const app = await createApp();
await app.use(auth({ secret: process.env.AUTH_SECRET }));

app.get('/profile/settings', (req, res) => {
  if (!authUtils.isAuthenticated(req)) {
    return authResponses.unauthorized(res, 'Please sign in to access settings');
  }
  if (!authUtils.hasRole(req, ['user', 'premium'])) {
    return authResponses.forbidden(res, 'Premium access required');
  }
  if (!authUtils.hasPermission(req, 'settings:write')) {
    return authResponses.forbidden(res, 'Write permission required');
  }

  res.json({ userId: authUtils.getUserId(req) });
});

app.listen(3000);
```

```typescript
authUtils.isAuthenticated(req); // boolean
authUtils.getUser(req); // the user, or null
authUtils.getUserId(req); // the user's id, or null
authUtils.hasRole(req, 'admin'); // has the role
authUtils.hasRole(req, ['admin', 'mod']); // has any of the roles
authUtils.hasPermission(req, 'users:read'); // has every permission given
authUtils.isAdmin(req); // has the admin role
authUtils.createAuthResponse(req); // { isAuthenticated, user, session, timestamp }
authUtils.ensureAuth(req, res); // false after redirecting to /api/auth/signin?callbackUrl=...

authResponses.unauthorized(res, 'Custom message'); // 401
authResponses.forbidden(res, 'Access denied'); // 403
authResponses.authSuccess(res, user); // 200 with the user's id, name, email, roles, permissions
authResponses.authError(res, 'error_code', 'Error message'); // 400
```

## API Reference

### `auth(options)`

| Option                                                       | Default                                                   | Notes                                                                                                                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret`                                                     | `NEXTAUTH_SECRET`, then `AUTH_SECRET`                     | Signs Better Auth sessions and, unless `jwt.secret` is set, verifies Bearer tokens. With none configured a random one is generated and a warning logged: sessions and tokens then do not survive a restart. |
| `jwt.secret`                                                 | `secret`, then `JWT_SECRET`, then the defaults above      | The secret Bearer tokens are verified with.                                                                                                                                                                 |
| `jwt.audience`, `jwt.issuer`, `jwt.algorithms`, `jwt.maxAge` | not checked; `['HS256']`; no age limit                    | Verification requirements for Bearer tokens.                                                                                                                                                                |
| `jwt.decode`                                                 | none                                                      | Your own verification: `({ token, secret }) => claims \| null`.                                                                                                                                             |
| `providers`                                                  | `[]`                                                      | Social providers. With at least one (or `betterAuth`) and `better-auth` installed, sign-in is served.                                                                                                       |
| `baseURL`                                                    | `BASE_URL`, then `AUTH_URL`, then `http://localhost:3000` | The public URL of the application.                                                                                                                                                                          |
| `basePath`                                                   | `/api/auth`                                               | Where the sign-in routes are served.                                                                                                                                                                        |
| `trustedOrigins`                                             | the origin of `baseURL`                                   | Origins allowed to call the sign-in routes and to be redirected to.                                                                                                                                         |
| `session.maxAge`, `session.updateAge`                        | 30 days, 1 day (seconds)                                  | Lifetime of a Better Auth session and how often its expiry is refreshed.                                                                                                                                    |
| `betterAuth`                                                 | none                                                      | Options handed to `betterAuth()` as they are.                                                                                                                                                               |
| `plugins`                                                    | none                                                      | `twoFactor()`, `organization()`, `anonymous()`, `bearerToken()`: see [the feature helpers](#two-factor-organizations-anonymous-users-session-tokens-account-linking-rate-limits).                           |
| `accountLinking`, `rateLimit`                                | none                                                      | `accountLinking()`, `rateLimit()`: same section.                                                                                                                                                            |
| `mountRoutes`                                                | `true`                                                    | `false`: no sign-in routes are served; the session is still recognised.                                                                                                                                     |

`createAuthMiddleware(config)` takes the same keys except `jwt`; see the [adapter guide](./NATIVE_AUTH_ADAPTER.md).

### `req.auth`

Set by `auth()`:

| Member                        | Value                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAuthenticated`             | `true` for a verified Bearer token or a Better Auth session.                                                                                |
| `user`                        | The user, when authenticated.                                                                                                               |
| `session`                     | `{ user, userId, expires, sessionToken }`, when authenticated. With `organization()` a Better Auth session also has `activeOrganizationId`. |
| `token`                       | The Bearer token, when one was sent and verified.                                                                                           |
| `getToken()`                  | Resolves to the verified claims of the Bearer token, or `null`.                                                                             |
| `getSession()`                | Resolves to `session`, or `null`.                                                                                                           |
| `signIn(provider?, options?)` | Resolves to `{ url }`: `<basePath>/signin[/<provider>]`, with `options.callbackUrl` as a query.                                             |
| `signOut(options?)`           | Resolves to `{ url }`: `<basePath>/signout`, with `options.callbackUrl` as a query.                                                         |
| `getProviders()`              | Resolves to the configured providers by id, without credentials or functions.                                                               |

`signIn()` and `signOut()` build URLs; the URLs are served when Better Auth's routes are (see [Available Auth Routes](#available-auth-routes)).

`req.auth` as set by `createAuthMiddleware()` has `isAuthenticated`, `user` (or `null`), `session` (`{ user, expires }` or `null`; with `organization()` also `activeOrganizationId`), `getSession()`, `getUser()`, and `signIn()` / `signOut()` returning `{ url }` directly. `await` works on both forms.

`auth()` also recognises a user your own session code stored: with neither a Bearer token nor a Better Auth session, a request that carries a `next-auth.session-token` (or `__Secure-next-auth.session-token`) cookie is authenticated as `req.session.user` when a session middleware has put one there. This is kept for applications written against earlier releases; new code should set `req.auth` itself, as in the third sample.

### Two functions named `createAuthMiddleware`

`createAuthMiddleware` from `@morojs/moro` is the Better Auth adapter described above: `app.use(createAuthMiddleware(config))`. The framework's source also has an internal `(req, res, next)` function of that name next to `auth()` (`src/core/middleware/built-in/auth`); the package does not export it. Its public form is `auth(options)`, and both it and `auth()` run sign-in through the same adapter.

## TypeScript Support

```typescript
import { createApp, auth, type AuthUser } from '@morojs/moro';

interface AppUser extends AuthUser {
  roles: string[];
  organizationId: string;
}

const app = await createApp();
await app.use(auth({ secret: process.env.AUTH_SECRET }));

app.get('/profile', req => {
  const user = req.auth.user as AppUser;
  return { id: user.id, organizationId: user.organizationId, roles: user.roles };
});

app.listen(3000);
```

## Best Practices

1. Serve the application over HTTPS in production and set `baseURL` to that URL.
2. Use a random secret of at least 32 characters, from the environment; never commit it.
3. Keep access tokens short-lived, and set `jwt.audience` when the secret signs anything else.
4. Add only origins you control to `trustedOrigins`.
5. Give Better Auth a database before relying on features that need stored state (passwords, account linking, revoking sessions).
6. Put roles and permissions on the user (token claims, or fields of the Better Auth user) and check them with the guards rather than in each handler.

## Troubleshooting

1. **"Auth middleware not installed"** (`500` from a guard): a route used `.auth()` or `requireAuth()` but nothing set `req.auth`. Install `app.use(auth({ ... }))` or `app.use(createAuthMiddleware({ ... }))` during setup, or set `req.auth` in your own middleware.
2. **`/api/auth/...` answers 404 with `auth()`**: there are no providers, feature helpers or `betterAuth` options, or `better-auth` is not installed (start-up logs a warning in that case).
3. **"Better Auth package not found"** from `createAuthMiddleware()`: `npm install better-auth`.
4. **The provider reports a redirect URI mismatch**: `baseURL` is not the URL the application is reached at. The callback is `<baseURL><basePath>/callback/<provider>`.
5. **`403` "Invalid origin" or "Missing or null Origin"** on a sign-in or sign-out request: it carried cookies from an origin that is not in `trustedOrigins`.
6. **A valid-looking Bearer token is refused**: check which secret applies ([Which secret](#bearer-tokens-for-an-api)), the algorithm (HS256 by default) and `jwt.audience`.
7. **A warning names a configuration key at start-up**: the key does nothing; the warning and [the table above](#authjs-style-keys-that-are-not-used) say what to use.
8. **"the auth database does not have the tables and columns this configuration writes"** at start-up, and `500` from `/api/auth/...`: create the tables ([The database](#the-database)); do it again after adding `twoFactor()`, `organization()` or `anonymous()`.
9. **`429` from `/api/auth/sign-in/...`**: the client address has used its attempts ([`rateLimit()`](#ratelimitoptions)); the `X-Retry-After` header says how many seconds remain.
10. **"Better Auth's rate limit of the auth routes is in force and `server.trustProxy` is not set"** at start-up: set `server.trustProxy` so the limit is counted against `req.ip` ([which client address is counted](#ratelimitoptions)).

Set `debug: true` to turn on Better Auth's debug logging and to have session lookup errors logged.

## Custom JWT Middleware

If you're implementing custom JWT authentication middleware, MoroJS provides utilities to handle JWT errors gracefully and prevent server crashes from expired tokens.

### JWT Error Handling Utilities

```typescript
import { safeVerifyJWT, extractJWTFromHeader, createAuthErrorResponse } from '@morojs/moro';

const customAuthMiddleware = async (req: any, res: any, next: any) => {
  // Extract token from Authorization header
  const token = extractJWTFromHeader(req.headers.authorization);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Missing token',
      message: 'Authorization header with Bearer token is required',
    });
  }

  // Safely verify JWT with proper error handling
  const result = await safeVerifyJWT(token, process.env.JWT_SECRET!);

  if (!result.success) {
    // Create standardized error response
    const errorResponse = createAuthErrorResponse(result.error);
    return res.status(401).json(errorResponse);
  }

  // Token is valid - attach user info to request
  req.user = result.payload;
  req.auth = {
    user: result.payload,
    isAuthenticated: true,
    token,
  };

  next();
};

app.use(customAuthMiddleware);
```

### Error Types Handled

The `safeVerifyJWT` utility handles all JWT error types gracefully:

- **TokenExpiredError**: Returns structured error with expiration date
- **JsonWebTokenError**: Returns error for invalid token format/signature
- **NotBeforeError**: Returns error for tokens not yet active
- **Missing Dependencies**: Returns helpful installation instructions
- **Missing Secret**: Returns configuration error message

### Algorithm Pinning

`safeVerifyJWT` pins `algorithms: ['HS256']` by default to prevent algorithm-confusion attacks (e.g. an attacker forging an HS256 token signed with the server's RS256 public key). If you sign tokens with a different algorithm, override it via the `options` argument:

```typescript
const result = await safeVerifyJWT(token, publicKey, { algorithms: ['RS256'] });
```

Verifying with a public key requires `algorithms` to be passed, as above. Given a PEM public key or certificate and no `algorithms`, `safeVerifyJWT` does not verify the token: it returns `{ success: false, error: { type: 'missing_secret', message: 'JWT verification with a public key requires options.algorithms, …' } }`, because under the HS256 default the public key would be the HMAC secret and anyone who holds it could sign a token. Use `jsonwebtoken` 9 or later, which also refuses a public key for HS256 when a caller names that algorithm (version 8 does not).

### Migration from Raw JWT Verification

If you're currently using raw `jwt.verify()` and experiencing crashes from expired tokens:

```typescript
// ❌ BEFORE: Causes server crashes on expired tokens
const jwt = require('jsonwebtoken');
try {
  const decoded = jwt.verify(token, secret); // Throws TokenExpiredError
  req.user = decoded;
} catch (error) {
  // Unhandled TokenExpiredError crashes the server
  throw error;
}

// ✅ AFTER: Graceful error handling
import { safeVerifyJWT, createAuthErrorResponse } from '@morojs/moro';

const result = await safeVerifyJWT(token, secret);
if (!result.success) {
  const errorResponse = createAuthErrorResponse(result.error);
  return res.status(401).json(errorResponse);
}
req.user = result.payload;
```

### Custom Error Responses

You can customize error responses based on the error type:

```typescript
const result = await safeVerifyJWT(token, secret);

if (!result.success) {
  switch (result.error?.type) {
    case 'expired':
      return res.status(401).json({
        error: 'session_expired',
        message: 'Please sign in again',
        expiredAt: result.error.expiredAt,
        refreshUrl: '/auth/refresh',
      });

    case 'invalid':
      return res.status(401).json({
        error: 'invalid_token',
        message: 'Authentication failed',
      });

    default:
      return res.status(401).json({
        error: 'auth_failed',
        message: result.error?.message || 'Authentication required',
      });
  }
}
```
