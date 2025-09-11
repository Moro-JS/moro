# @auth/morojs - Auth.js Adapter for MoroJS

A native Auth.js adapter for the [MoroJS](https://github.com/MoroJS/moro) framework, providing seamless authentication integration without external dependencies.

## Overview

This adapter allows Auth.js to work natively with MoroJS applications, providing:

- ✅ **Native MoroJS Integration** - Built specifically for MoroJS middleware patterns
- ✅ **Zero External Dependencies** - No reliance on Express adapters
- ✅ **Full Auth.js Compatibility** - Supports all Auth.js features and providers
- ✅ **Custom Transformers** - MoroJS-specific request/response handling
- ✅ **TypeScript First** - Complete type safety throughout

## Installation

```bash
npm install @auth/core @auth/morojs
# or
pnpm add @auth/core @auth/morojs
```

## Basic Usage

```typescript
import { Moro } from '@morojs/moro';
import { createAuthMiddleware } from '@auth/morojs';
import GitHub from '@auth/core/providers/github';

const app = new Moro();

app.use(
  createAuthMiddleware({
    providers: [
      GitHub({
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
      }),
    ],
    secret: process.env.AUTH_SECRET,
  })
);

app.get('/protected', (req, res) => {
  if (!req.auth.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({ user: req.auth.user });
});

app.listen(3000);
```

## Configuration

### Basic Configuration

```typescript
import { createAuthMiddleware } from '@auth/morojs';

app.use(
  createAuthMiddleware({
    providers: [
      // Your Auth.js providers
    ],
    secret: process.env.AUTH_SECRET,
    basePath: '/api/auth', // Default auth routes path

    // Standard Auth.js options
    session: {
      strategy: 'jwt',
      maxAge: 30 * 24 * 60 * 60, // 30 days
    },

    callbacks: {
      // Auth.js callbacks
    },

    events: {
      // Auth.js events
    },
  })
);
```

### MoroJS-Specific Options

```typescript
app.use(
  createAuthMiddleware({
    // ... standard Auth.js config

    morojs: {
      debug: true, // Enable MoroJS-specific logging
      transformers: {
        // Custom request transformer
        request: req => {
          // Transform MoroJS request for Auth.js
          return req;
        },

        // Custom response transformer
        response: res => {
          // Transform Auth.js response for MoroJS
          return res;
        },
      },
    },
  })
);
```

## Request Object Extensions

The adapter automatically adds an `auth` object to the MoroJS request:

```typescript
app.get('/api/user', (req, res) => {
  // Auth status
  const isAuthenticated = req.auth.isAuthenticated;
  const user = req.auth.user;
  const session = req.auth.session;

  // Helper methods
  const currentSession = await req.auth.getSession();
  const currentUser = req.auth.getUser();

  // Navigation helpers
  const signInUrl = req.auth.signIn('github', { callbackUrl: '/dashboard' });
  const signOutUrl = req.auth.signOut({ callbackUrl: '/' });
});
```

## Auth Routes

The adapter automatically handles standard Auth.js routes:

- `GET /api/auth/signin` - Sign in page
- `POST /api/auth/signin/:provider` - Sign in with provider
- `GET /api/auth/signout` - Sign out page
- `POST /api/auth/signout` - Sign out action
- `GET /api/auth/session` - Get current session
- `GET /api/auth/providers` - List available providers
- `GET /api/auth/csrf` - Get CSRF token
- `GET /api/auth/callback/:provider` - OAuth callbacks

## Advanced Usage

### Custom Provider Configuration

```typescript
import { createAuthMiddleware } from '@auth/morojs';

app.use(
  createAuthMiddleware({
    providers: [
      {
        id: 'custom-oauth',
        name: 'Custom OAuth',
        type: 'oauth',
        authorization: 'https://provider.com/oauth/authorize',
        token: 'https://provider.com/oauth/token',
        userinfo: 'https://provider.com/oauth/userinfo',
        clientId: process.env.CUSTOM_CLIENT_ID,
        clientSecret: process.env.CUSTOM_CLIENT_SECRET,
      },
    ],
    secret: process.env.AUTH_SECRET,
  })
);
```

### Session Management

```typescript
app.get('/dashboard', async (req, res) => {
  // Get current session
  const session = await req.auth.getSession();

  if (!session) {
    const signInUrl = req.auth.signIn();
    return res.redirect(signInUrl.url);
  }

  res.json({
    user: session.user,
    expires: session.expires,
  });
});
```

### Error Handling

```typescript
app.use((error, req, res, next) => {
  if (error.message?.includes('auth')) {
    console.error('Auth error:', error);
    return res.status(401).json({
      error: 'Authentication error',
      signInUrl: '/api/auth/signin',
    });
  }

  next(error);
});
```

## TypeScript Support

The adapter provides complete TypeScript support:

```typescript
import type { MoroJSAuthConfig, MoroJSRequest, MoroJSResponse } from '@auth/morojs';

// Extend MoroJS request type
declare module '@morojs/moro' {
  interface HttpRequest {
    auth: {
      isAuthenticated: boolean;
      user: User | null;
      session: Session | null;
      getSession(): Promise<Session | null>;
      getUser(): User | null;
      signIn(provider?: string, options?: any): { url: string };
      signOut(options?: any): { url: string };
    };
  }
}
```

## Environment Variables

```bash
# Required
AUTH_SECRET=your-auth-secret-here

# OAuth Providers (as needed)
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret

GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

## Migration from Other Frameworks

### From Express + NextAuth.js

```typescript
// Before (Express + NextAuth.js)
import NextAuth from 'next-auth';
import { expressWrapper } from 'some-wrapper';

app.use('/api/auth/*', expressWrapper(NextAuth(config)));

// After (MoroJS + @auth/morojs)
import { createAuthMiddleware } from '@auth/morojs';

app.use(createAuthMiddleware(config));
```

### From Other Auth Solutions

The adapter maintains Auth.js compatibility, so existing Auth.js configurations work with minimal changes.

## Examples

See the [examples directory](./examples/) for complete working examples:

- [Basic OAuth](./examples/basic-oauth.ts)
- [Multiple Providers](./examples/multiple-providers.ts)
- [Custom Callbacks](./examples/custom-callbacks.ts)
- [Database Sessions](./examples/database-sessions.ts)

## Contributing to Auth.js

This adapter is designed to be contributed to the Auth.js project as an official framework adapter.

### Contribution Steps

1. **Test thoroughly** with various Auth.js features
2. **Add comprehensive tests** covering all functionality
3. **Update documentation** to match Auth.js standards
4. **Submit PR** to [nextauthjs/next-auth](https://github.com/nextauthjs/next-auth)
5. **Follow Auth.js** contribution guidelines

### Package Structure for Auth.js

When contributing to Auth.js, the package structure should be:

```
packages/adapter-morojs/
├── src/
│   ├── index.ts          # Main adapter export
│   ├── types.ts          # TypeScript definitions
│   └── utils.ts          # Helper utilities
├── tests/
│   ├── basic.test.ts     # Basic functionality tests
│   ├── providers.test.ts # Provider-specific tests
│   └── edge-cases.test.ts # Edge case handling
├── package.json          # Package configuration
├── README.md             # This documentation
└── tsconfig.json         # TypeScript configuration
```

## Comparison with Other Adapters

| Feature                | @auth/express    | @auth/morojs   | Benefits           |
| ---------------------- | ---------------- | -------------- | ------------------ |
| **Framework**          | Express          | MoroJS         | Native integration |
| **Dependencies**       | Express required | Zero external  | Lighter bundle     |
| **Request/Response**   | Express objects  | MoroJS objects | Better performance |
| **Middleware Pattern** | Express style    | MoroJS hooks   | More flexible      |
| **TypeScript**         | Good             | Excellent      | Better DX          |

## Performance

The MoroJS adapter provides excellent performance characteristics:

- **Zero Express overhead** - Direct MoroJS integration
- **Efficient request handling** - Native object transformation
- **Optimized middleware** - Uses MoroJS hook system
- **Minimal memory footprint** - No unnecessary abstractions

## License

MIT - See [LICENSE](./LICENSE) file for details.

## Links

- [Auth.js Documentation](https://authjs.dev)
- [MoroJS Framework](https://github.com/MoroJS/moro)
- [Auth.js GitHub](https://github.com/nextauthjs/next-auth)
- [Report Issues](https://github.com/nextauthjs/next-auth/issues)

---

**Ready to contribute this adapter to Auth.js and get MoroJS recognized as an official framework! 🚀**
