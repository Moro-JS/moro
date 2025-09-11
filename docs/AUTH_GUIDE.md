# Authentication Guide for MoroJS

MoroJS includes comprehensive authentication support powered by [Auth.js](https://authjs.dev/), providing secure, production-ready authentication with support for multiple providers, JWT tokens, sessions, and more.

## Overview

The authentication middleware supports:
- **OAuth Providers** (Google, GitHub, Discord, Microsoft, LinkedIn, and more)
- **Enterprise SSO** (Okta, Auth0, AWS Cognito)
- **OIDC (OpenID Connect)** providers
- **Email/Magic Link** authentication
- **Credentials** (username/password) authentication
- **JWT** and **Database** session strategies
- **Role-Based Access Control (RBAC)**
- **Permission-based authorization**
- **CSRF** protection
- **Custom callbacks** and events
- **Security audit logging**
- **TypeScript** support throughout

## Quick Start

### Basic OAuth Setup (GitHub)

```typescript
import { Moro } from '../src/moro';
import { auth, providers } from '../src/core/middleware/built-in';

const app = new Moro();

app.use(auth({
  providers: [
    providers.github({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  secret: process.env.AUTH_SECRET,
}));

app.get('/protected', (req, res) => {
  if (!req.auth.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({
    message: 'Protected resource',
    user: req.auth.user
  });
});

app.listen(3000);
```

### Environment Variables

```bash
# Required
AUTH_SECRET=your-secret-key-here-32-characters-minimum
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret

# Optional
AUTH_URL=http://localhost:3000 # Base URL for your app
```

## Providers

### Basic OAuth Providers

#### Google
```typescript
import { auth, providers } from '../src/core/middleware/built-in';

app.use(auth({
  providers: [
    providers.google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
}));
```

#### GitHub
```typescript
app.use(auth({
  providers: [
    providers.github({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
}));
```

#### Discord
```typescript
app.use(auth({
  providers: [
    providers.discord({
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    }),
  ],
}));
```

### Extended OAuth Providers

```typescript
import { auth, extendedProviders } from '../src/core/middleware/built-in';

app.use(auth({
  providers: [
    // Enhanced GitHub with additional options
    extendedProviders.github({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      scope: 'read:user user:email public_repo',
      allowSignup: true,
    }),

    // Google with hosted domain restriction
    extendedProviders.google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      hostedDomain: 'yourcompany.com',
    }),

    // Microsoft/Azure AD
    extendedProviders.microsoft({
      clientId: process.env.MICROSOFT_CLIENT_ID!,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
      tenant: process.env.MICROSOFT_TENANT_ID,
    }),

    // LinkedIn
    extendedProviders.linkedin({
      clientId: process.env.LINKEDIN_CLIENT_ID!,
      clientSecret: process.env.LINKEDIN_CLIENT_SECRET!,
    }),
  ],
}));
```

### Enterprise SSO Providers

```typescript
import { auth, enterpriseProviders } from '../src/core/middleware/built-in';

app.use(auth({
  providers: [
    // Okta
    enterpriseProviders.okta({
      clientId: process.env.OKTA_CLIENT_ID!,
      clientSecret: process.env.OKTA_CLIENT_SECRET!,
      domain: process.env.OKTA_DOMAIN!,
    }),

    // Auth0
    enterpriseProviders.auth0({
      clientId: process.env.AUTH0_CLIENT_ID!,
      clientSecret: process.env.AUTH0_CLIENT_SECRET!,
      domain: process.env.AUTH0_DOMAIN!,
    }),

    // AWS Cognito
    enterpriseProviders.cognito({
      clientId: process.env.COGNITO_CLIENT_ID!,
      clientSecret: process.env.COGNITO_CLIENT_SECRET!,
      domain: process.env.COGNITO_DOMAIN!,
      region: 'us-east-1',
    }),
  ],
}));
```

### Credentials Provider

```typescript
app.use(auth({
  providers: [
    providers.credentials({
      name: 'credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' }
      },
      authorize: async (credentials) => {
        // Implement your credential validation logic
        const user = await validateUser(credentials.username, credentials.password);

        if (user) {
          return {
            id: user.id,
            name: user.name,
            email: user.email,
          };
        }
        return null;
      },
    }),
  ],
}));
```

### Email Provider

```typescript
app.use(auth({
  providers: [
    providers.email({
      server: {
        host: process.env.EMAIL_SERVER_HOST,
        port: parseInt(process.env.EMAIL_SERVER_PORT!),
        auth: {
          user: process.env.EMAIL_SERVER_USER,
          pass: process.env.EMAIL_SERVER_PASSWORD,
        },
      },
      from: process.env.EMAIL_FROM,
    }),
  ],
}));
```

## Authentication Middleware and Helpers

### Route Protection Middleware

```typescript
import {
  requireAuth,
  requireRole,
  requireAdmin,
  requirePermission,
  authUtils
} from '../src/core/middleware/built-in';

// Helper function to compose middleware with route handlers
function withMiddleware(middleware: any, handler: any) {
  return async (req: any, res: any) => {
    return new Promise((resolve, reject) => {
      middleware(req, res, (error?: any) => {
        if (error) {
          reject(error);
        } else {
          resolve(handler(req, res));
        }
      });
    });
  };
}

// Require authentication
app.get('/dashboard', withMiddleware(requireAuth(), (req, res) => {
  res.json({
    message: 'Welcome to your dashboard',
    user: authUtils.getUser(req),
  });
}));

// Require specific role
app.get('/admin', withMiddleware(requireRole(['admin']), (req, res) => {
  res.json({ message: 'Admin panel' });
}));

// Require admin role (shorthand)
app.get('/admin/users', withMiddleware(requireAdmin(), (req, res) => {
  res.json({ users: getUserList() });
}));

// Require specific permissions
app.get('/api/users', withMiddleware(requireAuth({
  permissions: ['users:read'],
  onForbidden: (req, res) => {
    res.status(403).json({ error: 'Insufficient permissions' });
  },
}), (req, res) => {
  res.json({ users: getUsers() });
}));

// Custom authorization logic
app.get('/organization/:orgId/data', withMiddleware(requireAuth({
  authorize: async (user) => {
    // Custom logic - user can only access their organization's data
    return user.organizationId === req.params.orgId;
  },
  onForbidden: (req, res) => {
    res.status(403).json({ error: 'Access denied to this organization' });
  },
}), (req, res) => {
  res.json({
    organizationId: req.params.orgId,
    data: getOrganizationData(req.params.orgId),
  });
}));
```

### Manual Authentication Checks

```typescript
import { authUtils, authResponses } from '../src/core/middleware/built-in';

app.get('/profile/settings', (req, res) => {
  // Manual authentication check
  if (!authUtils.isAuthenticated(req)) {
    return authResponses.unauthorized(res, 'Please sign in to access settings');
  }

  // Manual role check
  if (!authUtils.hasRole(req, ['user', 'premium'])) {
    return authResponses.forbidden(res, 'Premium access required');
  }

  // Manual permission check
  if (!authUtils.hasPermission(req, 'settings:write')) {
    return authResponses.forbidden(res, 'Write permission required');
  }

  const userId = authUtils.getUserId(req);

  res.json({
    message: 'User settings',
    userId,
    settings: getUserSettings(userId),
  });
});
```

### Auth Utilities

```typescript
import { authUtils } from '../src/core/middleware/built-in';

// Available utility functions:
authUtils.isAuthenticated(req)           // Check if user is authenticated
authUtils.getUser(req)                   // Get current user object
authUtils.getUserId(req)                 // Get current user ID
authUtils.hasRole(req, 'admin')          // Check if user has specific role
authUtils.hasRole(req, ['admin', 'mod']) // Check if user has any of the roles
authUtils.hasPermission(req, 'users:read') // Check specific permission
authUtils.isAdmin(req)                   // Check if user is admin
authUtils.createAuthResponse(req)        // Create standardized auth response
authUtils.ensureAuth(req, res)           // Force auth check with redirect
```

### Auth Response Helpers

```typescript
import { authResponses } from '../src/core/middleware/built-in';

// Standardized auth responses:
authResponses.unauthorized(res, 'Custom message')
authResponses.forbidden(res, 'Access denied')
authResponses.authSuccess(res, data)
authResponses.authError(res, 'error_code', 'Error message')
```

## Advanced Configuration

### Custom Callbacks

```typescript
app.use(auth({
  providers: [/* your providers */],
  callbacks: {
    signIn: async ({ user, account, profile }: any) => {
      // Custom sign-in logic
      console.log(`User ${user.email} signed in with ${account?.provider}`);

      // Business logic - block certain domains
      if (user.email?.endsWith('@blockedcompany.com')) {
        return false;
      }

      // Log for audit
      await logSecurityEvent('user_signin', {
        userId: user.id,
        email: user.email,
        provider: account?.provider,
      });

      return true;
    },

    jwt: async ({ token, user, account }: any) => {
      // Add custom claims to JWT
      if (user) {
        token.userId = user.id;
        token.provider = account?.provider;

        // Fetch user roles and permissions from database
        token.roles = await getUserRoles(user.id);
        token.permissions = await getUserPermissions(user.id);
        token.organizationId = await getUserOrganization(user.id);
      }
      return token;
    },

    session: async ({ session, token }: any) => {
      // Add custom fields to session
      session.user.roles = token.roles as string[];
      session.user.permissions = token.permissions as string[];
      session.user.organizationId = token.organizationId as string;
      session.customData = {
        lastActivity: new Date(),
        sessionId: token.jti,
      };
      return session;
    },
  },
}));
```

### Security Events

```typescript
app.use(auth({
  providers: [/* your providers */],
  events: {
    signIn: async ({ user, account, isNewUser }: any) => {
      await logSecurityEvent('signin_success', {
        userId: user.id,
        provider: account?.provider,
        isNewUser,
      });
    },

    signOut: async ({ session }: any) => {
      await logSecurityEvent('signout', {
        userId: session.user.id,
        sessionDuration: Date.now() - new Date(session.customData.lastActivity).getTime(),
      });
    },
  },
}));
```

### Session Configuration

```typescript
app.use(auth({
  providers: [/* your providers */],
  session: {
    strategy: 'jwt', // or 'database'
    maxAge: 8 * 60 * 60, // 8 hours
    updateAge: 2 * 60 * 60, // Update every 2 hours
  },
  useSecureCookies: process.env.NODE_ENV === 'production',
  trustHost: true,
  debug: process.env.NODE_ENV === 'development',
}));
```

## Native Auth.js Adapter

MoroJS includes a native Auth.js adapter for maximum compatibility and zero external dependencies:

```typescript
import { createAuthMiddleware } from '../src/core/auth/morojs-adapter';

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
  callbacks: {
    async signIn({ user, account }: any) {
      console.log(`🔐 User ${user.email} signing in via ${account?.provider}`);
      return true;
    },
  },
}));
```

## API Reference

### Auth Request Object

The `req.auth` object is automatically added to all requests:

```typescript
interface AuthRequest {
  user?: AuthUser;
  session?: AuthSession;
  token?: string;
  isAuthenticated: boolean;

  // Helper methods
  signIn(provider?: string, options?: SignInOptions): Promise<any>;
  signOut(options?: SignOutOptions): Promise<any>;
  getSession(): Promise<AuthSession | null>;
  getToken(): Promise<AuthJWT | null>;
  getCsrfToken(): Promise<string>;
  getProviders(): Promise<Record<string, AuthProvider>>;
}
```

### Available Auth Routes

MoroJS automatically handles these Auth.js routes:

- `GET /api/auth/signin` - Sign in page
- `POST /api/auth/signin/:provider` - Sign in with provider
- `GET /api/auth/signout` - Sign out page
- `POST /api/auth/signout` - Sign out action
- `GET /api/auth/session` - Get current session
- `GET /api/auth/csrf` - Get CSRF token
- `GET /api/auth/providers` - Get available providers
- `GET /api/auth/callback/:provider` - OAuth callback

## TypeScript Support

### Request Type Extensions

```typescript
// The auth object is automatically typed
app.get('/profile', (req, res) => {
  const user = req.auth.user; // Fully typed AuthUser
  const session = req.auth.session; // Fully typed AuthSession
  const isAuth = req.auth.isAuthenticated; // boolean
});
```

### Custom User Type

```typescript
import { AuthUser } from '../src/types/auth';

interface CustomUser extends AuthUser {
  role: 'admin' | 'user' | 'manager';
  permissions: string[];
  organizationId: string;
}

// Use in your callbacks
app.use(auth({
  callbacks: {
    session: async ({ session, token }: any) => {
      session.user = {
        ...session.user,
        role: token.role as 'admin' | 'user' | 'manager',
        permissions: token.permissions as string[],
        organizationId: token.organizationId as string,
      };
      return session;
    },
  },
}));
```

## Best Practices

1. **Always use HTTPS in production**
2. **Set strong, unique secrets** (minimum 32 characters)
3. **Implement proper CSRF protection**
4. **Use secure cookie settings in production**
5. **Validate user input in callbacks**
6. **Handle errors gracefully with authResponses helpers**
7. **Log authentication events for security audit**
8. **Implement rate limiting for auth routes**
9. **Use role-based access control (RBAC)**
10. **Regularly rotate secrets and tokens**
11. **Use the withMiddleware helper for route protection**
12. **Leverage authUtils for manual checks**

## Examples

See the `examples/` directory for complete working examples:

- `examples/working-auth-test.ts` - Basic Auth.js integration
- `examples/native-auth-example.ts` - Native adapter usage
- `examples/advanced-auth-example.ts` - Enterprise patterns with RBAC

## Troubleshooting

### Common Issues

1. **"Auth middleware must be installed"** - Ensure the `auth()` middleware is properly installed with `app.use()`
2. **"AUTH_SECRET is not set"** - Set the `AUTH_SECRET` environment variable (minimum 32 characters)
3. **OAuth redirect mismatch** - Check your provider's redirect URI configuration
4. **Session not persisting** - Verify cookie settings and domain configuration
5. **Middleware signature errors** - Use the `withMiddleware()` helper for route protection
6. **"res.status is not a function"** - This has been resolved in the latest version

### Debug Mode

Enable debug logging in development:

```typescript
app.use(auth({
  debug: process.env.NODE_ENV === 'development',
  // ... other options
}));
```

This guide covers the complete authentication system implemented in MoroJS. For more advanced use cases, see the API documentation and example applications.
