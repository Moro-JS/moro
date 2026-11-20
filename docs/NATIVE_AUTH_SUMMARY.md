# 🚀 MoroJS Native Auth Adapter

## ✅ **What We Built**

We created an auth adapter that's **native to MoroJS**, with no `@auth/express` layer in between. It runs an Auth.js-style configuration on Better Auth, serves the sign-in routes and adds `req.auth` to every request. The full description is in the [Native Auth Adapter guide](./NATIVE_AUTH_ADAPTER.md).

### **Architecture Comparison**

| **Old Approach**               | **New Native Approach**                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `@auth/express` dependency     | ✅ **Only `better-auth` (optional peer dependency)**             |
| Express compatibility layer    | ✅ **Direct MoroJS integration**                                 |
| Routes mounted through Express | ✅ **Routes mounted by `createAuthMiddleware()` itself**         |
| Express middleware patterns    | ✅ **A MoroJS request hook and a place in the middleware chain** |

## 🔧 **Technical Implementation**

### **Files Created:**

```
src/core/auth/
├── morojs-adapter.ts          # MoroJSAuth(), createAuthMiddleware(), mountAuthRoutes()
└── README.md                  # Adapter documentation
```

### **Dependencies Removed:**

```diff
- "@auth/express": "^0.8.2"  ❌ No longer needed!
- "jose": "^5.9.6"           ❌ No longer needed!
+ "better-auth": ">=1.7.7"    ✅ Only auth package we need (optional peer dependency)
```

## 🎯 **Key Features**

### **1. Native MoroJS Integration**

```typescript
import { createApp, createAuthMiddleware, requireAuth } from '@morojs/moro';

const app = await createApp();

// Sign-in routes under /api/auth and req.auth on every request
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

app
  .get('/protected')
  .before(requireAuth({ redirectTo: '/api/auth/signin' }))
  .handler(req => ({ user: req.auth.user }));

app.listen(3000);
```

### **2. Request Object Extensions**

```typescript
// Automatic auth object on all requests
app.get('/protected', (req, res) => {
  if (!req.auth.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({ user: req.auth.user });
});
```

`req.auth.signIn(provider, { callbackUrl })` and `req.auth.signOut({ callbackUrl })` return the URLs to send the browser to: `/api/auth/signin/<provider>` and `/api/auth/signout`.

### **3. Auth.js-Style Configuration**

- ✅ `secret`, `baseURL`, `basePath`, `trustedOrigins` and the `session` settings (`maxAge`, `updateAge` and Better Auth's own) are passed on to Better Auth
- ✅ Every provider Better Auth knows, with the options of its entry (`scope`, `prompt`, `hostedDomain`, `tenant`, ...)
- ✅ `betterAuth: { ... }` hands options straight through: a database, email and password, plugins, hooks
- ✅ Feature helpers: `plugins: [twoFactor(), organization(), anonymous(), bearerToken()]`, `accountLinking: accountLinking()` and `rateLimit: rateLimit()` load the Better Auth plugin or set the Better Auth option each is named after, with the helper's options mapped onto Better Auth's. An option with no equivalent is named in a start-up warning. `twoFactor()`, `organization()` and `anonymous()` store data: they need `betterAuth.database` with its tables created. See [Feature Helpers](./NATIVE_AUTH_ADAPTER.md#feature-helpers)
- ✅ The routes are served: `GET /api/auth/signin`, `GET|POST /api/auth/signin/<provider>`, `GET /api/auth/callback/<provider>`, `GET /api/auth/get-session`, `POST /api/auth/signout`, and Better Auth's own API (`POST /api/auth/sign-in/social`, `POST /api/auth/sign-out`, ...). See [Route Handling](./NATIVE_AUTH_ADAPTER.md#route-handling)
- `callbacks`, `events`, `pages`, `adapter` and `session.strategy` have no Better Auth equivalent: they are not applied, and start-up logs a warning that names each one present and what to use instead. A provider Better Auth does not know is left out with the same kind of warning
- `mountRoutes: false` serves no routes; mount `MoroJSAuth(config).handler` on your own routes instead

### **4. MoroJS-Specific Options**

```typescript
morojs: {
  debug: true, // log session lookup errors
  transformers: {
    // applied to the requests the auth routes hand to Better Auth; Web API Request / Response in and out
    request: (request: Request) => request,
    response: (response: Response) => response,
  },
}
```

## 🚀 **Benefits**

### **Fewer moving parts**

- 📦 **Lighter** - `better-auth` is the only auth package
- 🔧 **Native** - Built for MoroJS specifically: no Express layer

### **Developer Experience**

- 🎯 **Better integration** with MoroJS patterns: the guards (`requireAuth()`, `requireRole()`, ...) read the `req.auth` it sets
- 📖 **Cleaner API** - No Express abstractions
- 🔒 **Type safety** - Typed configuration, request and response shapes

## 🔄 **Migration Path**

### **From @auth/express:**

```typescript
// Before
import { ExpressAuth } from '@auth/express';
app.use('/api/auth/*', ExpressAuth(config));

// After
import { createAuthMiddleware } from '@morojs/moro';
app.use(createAuthMiddleware(config));
```

The configuration object is not carried over unchanged: Better Auth provider entries are `{ id, clientId, clientSecret, ...options }`, and `callbacks` / `events` / `pages` / `adapter` are replaced by Better Auth's hooks and `database` (see [Keys That Are Not Used](./NATIVE_AUTH_ADAPTER.md#keys-that-are-not-used)).

### **Backwards Compatibility:**

We still export the `auth` middleware alongside the adapter. It is not deprecated: it verifies Bearer tokens, and with providers it serves sign-in through this same adapter. The [Authentication Guide](./AUTH_GUIDE.md) covers both:

```typescript
// ✅ Built-in auth middleware
import { auth } from '@morojs/moro';

// ✅ Native adapter
import { createAuthMiddleware } from '@morojs/moro';
```

## 🎉 **Summary**

We now have:

1. ✅ **Auth.js-style configuration running on Better Auth**
2. ✅ **Zero Express dependencies**
3. ✅ **Native MoroJS integration** (`req.auth` on every request)
4. ✅ **The sign-in, callback, session and sign-out routes served by `createAuthMiddleware()`**
5. ✅ **Every Better Auth provider, and Better Auth's own options through `betterAuth`**

---

**A native auth adapter for MoroJS that doesn't depend on Express. 🎯**
