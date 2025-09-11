# Native Auth.js Adapter for MoroJS (`@auth/morojs`)

MoroJS includes a custom, native Auth.js adapter that provides seamless integration with Auth.js without external dependencies. This adapter is designed for contribution to the official Auth.js project to provide first-class MoroJS support.

## Overview

The native adapter provides:
- **Zero Dependencies**: No reliance on `@auth/express` or other framework adapters
- **Full Auth.js Compatibility**: Complete feature parity with Auth.js core
- **Native MoroJS Integration**: Built specifically for MoroJS request/response handling
- **Custom Transformers**: Request/response transformation between Auth.js and MoroJS
- **Production Ready**: Thoroughly tested and optimized for production use

## Quick Start

### Basic Setup

```typescript
import { Moro } from '../src/moro';
import { createAuthMiddleware } from '../src/core/auth/morojs-adapter';

const app = new Moro();

app.use(createAuthMiddleware({
  providers: [
    {
      id: 'github',
      name: 'GitHub',
      type: 'oauth',
      authorization: 'https://github.com/login/oauth/authorize',
      token: 'https://github.com/login/oauth/access_token',
      userinfo: 'https://api.github.com/user',
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  ],
  secret: process.env.AUTH_SECRET!,
}));

app.get('/', (req, res) => {
  res.json({
    message: 'MoroJS with Native Auth.js Integration!',
    auth: {
      isAuthenticated: req.auth.isAuthenticated,
      user: req.auth.user,
      session: req.auth.session,
    },
  });
});

app.listen(3000);
```

## Configuration

### Provider Configuration

The adapter supports all standard Auth.js providers with native configuration:

```typescript
app.use(createAuthMiddleware({
  providers: [
    // GitHub Provider
    {
      id: 'github',
      name: 'GitHub',
      type: 'oauth',
      authorization: 'https://github.com/login/oauth/authorize',
      token: 'https://github.com/login/oauth/access_token',
      userinfo: 'https://api.github.com/user',
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },

    // Google Provider
    {
      id: 'google',
      name: 'Google',
      type: 'oauth',
      authorization: 'https://accounts.google.com/oauth/authorize',
      token: 'https://oauth2.googleapis.com/token',
      userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo',
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },

    // Custom OIDC Provider
    {
      id: 'custom-oidc',
      name: 'Custom OIDC',
      type: 'oidc',
      issuer: 'https://accounts.example.com',
      clientId: process.env.CUSTOM_CLIENT_ID!,
      clientSecret: process.env.CUSTOM_CLIENT_SECRET!,
    },
  ],
  secret: process.env.AUTH_SECRET!,
}));
```

### Callbacks and Events

Full Auth.js callback and event support:

```typescript
app.use(createAuthMiddleware({
  providers: [/* your providers */],
  secret: process.env.AUTH_SECRET!,

  // Custom callbacks
  callbacks: {
    async signIn({ user, account, profile }: any) {
      console.log(`🔐 User ${user.email} signing in via ${account?.provider}`);

      // Custom business logic
      if (user.email?.endsWith('@blockedcompany.com')) {
        return false; // Block this user
      }

      return true;
    },

    async session({ session, token }: any) {
      // Add custom data to session
      session.customData = {
        loginTime: new Date(),
        provider: token.provider,
      };
      return session;
    },

    async jwt({ token, user, account }: any) {
      if (user) {
        token.provider = account?.provider;
        token.userId = user.id;
      }
      return token;
    },
  },

  // Auth.js events
  events: {
    async signIn({ user, account, isNewUser }: any) {
      console.log(`✅ Sign in event: ${user.email} (new: ${isNewUser})`);
    },

    async signOut({ session }: any) {
      console.log(`👋 Sign out event: ${session.user.email}`);
    },
  },
}));
```

## Request Enhancement

The adapter automatically enhances MoroJS requests with an `auth` object:

```typescript
interface RequestAuth {
  session: Session | null;
  user: User | null;
  isAuthenticated: boolean;

  // Helper methods
  getSession(): Promise<Session | null>;
  getUser(): User | null;
  signIn(provider?: string, options?: any): { url: string };
  signOut(options?: any): { url: string };
}

// Usage in routes
app.get('/api/user', (req, res) => {
  const { isAuthenticated, user, session } = req.auth;

  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  res.json({
    user,
    session,
    lastActivity: session?.customData?.loginTime,
  });
});
```

## Route Handling

The adapter automatically handles all Auth.js routes:

### Authentication Routes

- `GET /api/auth/signin` - Sign in page
- `POST /api/auth/signin/:provider` - Sign in with provider
- `GET /api/auth/signout` - Sign out page
- `POST /api/auth/signout` - Sign out action
- `GET /api/auth/session` - Get current session
- `GET /api/auth/providers` - List available providers
- `GET /api/auth/csrf` - Get CSRF token
- `GET /api/auth/callback/:provider` - OAuth callbacks

### Example Auth Route Usage

```typescript
// The adapter handles these automatically, but you can customize:
app.get('/api/auth/custom-signin', (req, res) => {
  const providers = [
    { id: 'github', name: 'GitHub' },
    { id: 'google', name: 'Google' },
  ];

  res.json({
    message: 'Choose your authentication method',
    providers,
    csrfToken: req.auth.getCsrfToken?.(),
  });
});
```

## Advanced Features

### Custom Request/Response Transformers

```typescript
app.use(createAuthMiddleware({
  providers: [/* your providers */],
  secret: process.env.AUTH_SECRET!,

  // Custom transformers
  morojs: {
    debug: true,
    transformers: {
      // Transform MoroJS request for Auth.js
      request: (req) => {
        // Add custom headers or modify request
        return {
          ...req,
          headers: {
            ...req.headers,
            'x-forwarded-proto': 'https',
          },
        };
      },

      // Transform Auth.js response for MoroJS
      response: (res) => {
        // Add custom response handling
        return res;
      },
    },
  },
}));
```

### Security Configuration

```typescript
app.use(createAuthMiddleware({
  providers: [/* your providers */],
  secret: process.env.AUTH_SECRET!,

  // Security settings
  session: {
    strategy: 'jwt',
    maxAge: 8 * 60 * 60, // 8 hours
    updateAge: 2 * 60 * 60, // Update every 2 hours
  },

  useSecureCookies: process.env.NODE_ENV === 'production',
  trustHost: true,
  debug: process.env.NODE_ENV === 'development',

  // CSRF protection
  skipCSRFCheck: ['/api/webhook'],
}));
```

## Request/Response Types

### MoroJS Request Interface

```typescript
interface MoroJSRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
  query?: Record<string, string>;

  // Auth.js extensions
  auth: RequestAuth;
}
```

### MoroJS Response Interface

```typescript
interface MoroJSResponse {
  status(code: number): MoroJSResponse;
  json(data: any): Promise<void>;
  redirect(url: string, status?: number): void;
  setHeader(name: string, value: string): void;
  send(data: string | Buffer): void;
  end(data?: string | Buffer): void;
  headersSent: boolean;
}
```

## Architecture

### Adapter Structure

```
src/core/auth/morojs-adapter.ts
├── MoroJSAuth()              # Main auth function
├── createAuthMiddleware()    # Middleware factory
├── toWebRequest()           # MoroJS -> Web API transformer
├── fromWebResponse()        # Web API -> MoroJS transformer
└── Request/Response Types   # TypeScript interfaces
```

### Integration Flow

1. **Request Reception**: MoroJS receives HTTP request
2. **Request Transformation**: Convert to Web API Request
3. **Auth.js Processing**: Handle authentication with Auth.js core
4. **Response Transformation**: Convert back to MoroJS Response
5. **Request Enhancement**: Add `auth` object to request
6. **Route Handling**: Continue with normal MoroJS routing

## Comparison with Express Adapter

| Feature | Native MoroJS | @auth/express |
|---------|---------------|---------------|
| Dependencies | Zero external | Requires Express |
| Performance | Optimized for MoroJS | Express overhead |
| Integration | Native hooks system | Middleware chain |
| TypeScript | Full MoroJS types | Express types |
| Customization | MoroJS-specific | Express-specific |

## Production Deployment

### Environment Variables

```bash
# Required
AUTH_SECRET=your-32-character-secret-minimum
GITHUB_CLIENT_ID=your-github-oauth-app-id
GITHUB_CLIENT_SECRET=your-github-oauth-app-secret

# Optional
AUTH_URL=https://yourdomain.com
NODE_ENV=production

# Provider-specific
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
```

### Production Configuration

```typescript
app.use(createAuthMiddleware({
  providers: [/* your providers */],
  secret: process.env.AUTH_SECRET!,

  // Production settings
  useSecureCookies: true,
  trustHost: true,
  debug: false,

  session: {
    strategy: 'jwt',
    maxAge: 8 * 60 * 60, // 8 hours for security
  },

  callbacks: {
    async signIn({ user, account }: any) {
      // Production sign-in validation
      const isAllowed = await validateUserAccess(user.email);

      if (!isAllowed) {
        await logSecurityEvent('blocked_signin_attempt', {
          email: user.email,
          provider: account?.provider,
        });
        return false;
      }

      return true;
    },
  },
}));
```

## Contributing to Auth.js

This adapter is designed for contribution to the official Auth.js project. The goal is to provide first-class MoroJS support alongside Express, Fastify, and other frameworks.

### Contribution Process

1. **Testing**: Comprehensive test coverage with real Auth.js providers
2. **Documentation**: Complete integration guide and examples
3. **API Compatibility**: 100% feature parity with Auth.js core
4. **Performance**: Optimized for production workloads
5. **Types**: Full TypeScript support with proper type inference

### Future Integration

Once contributed to Auth.js, the adapter will be available as:

```typescript
// Future Auth.js integration
import { MoroJS } from '@auth/morojs';
import { GitHub, Google } from '@auth/core/providers';

app.use(MoroJS({
  providers: [GitHub, Google],
  secret: process.env.AUTH_SECRET!,
}));
```

## Examples

See the `examples/` directory for complete implementations:

- **`examples/native-auth-example.ts`** - Complete native adapter setup
- **`examples/advanced-auth-example.ts`** - Enterprise patterns with RBAC
- **`examples/working-auth-test.ts`** - Standard Auth.js middleware comparison

## Troubleshooting

### Common Issues

1. **"Auth.js middleware installed successfully!"** but routes not working
   - Ensure the middleware is installed before route definitions
   - Check that Auth.js routes are accessible at `/api/auth/*`

2. **Provider configuration errors**
   - Verify OAuth app configuration in provider dashboard
   - Check redirect URIs match `${your-domain}/api/auth/callback/{provider}`

3. **Session not persisting**
   - Ensure `AUTH_SECRET` is set and consistent across deployments
   - Check cookie settings for your deployment environment

### Debug Mode

```typescript
app.use(createAuthMiddleware({
  debug: true, // Enable debug logging
  // ... other config
}));
```

This will log detailed information about:
- Request transformations
- Auth.js handler execution
- Response transformations
- Session management

## Conclusion

The native MoroJS Auth.js adapter provides a production-ready, zero-dependency solution for authentication in MoroJS applications. With full Auth.js compatibility and native MoroJS integration, it represents the future of authentication for the MoroJS ecosystem.

For questions or contributions, see the [Contributing Guide](./CONTRIBUTING.md) or join our [Discord Community](https://morojs.com/discord).
