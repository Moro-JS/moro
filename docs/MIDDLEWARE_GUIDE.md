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

| Middleware | Purpose | Phase |
|------------|---------|-------|
| `cors` | Cross-origin resource sharing | Security |
| `helmet` | Security headers | Security |
| `csrf` | CSRF protection | Security |
| `csp` | Content Security Policy | Security |
| `compression` | Response compression | Performance |
| `cache` | Response caching | Performance |
| `rateLimit` | Request rate limiting | Rate Limiting |
| `auth` | Authentication & RBAC | Authentication |
| `session` | Session management | Authentication |
| `validation` | Request validation | Validation |
| `bodySize` | Body size limiting | Parsing |
| `cookie` | Cookie parsing | Parsing |
| `staticFiles` | Static file serving | Handler |
| `upload` | File upload handling | Handler |
| `template` | Template rendering | Handler |
| `range` | HTTP range requests | Handler |
| `http2` | HTTP/2 server push | Handler |
| `cdn` | CDN integration | Content Delivery |
| `sse` | Server-Sent Events | Real-time |
| `graphql` | GraphQL support | Handler |

---

## Security Middleware

### CORS (Cross-Origin Resource Sharing)

Enable cross-origin requests with fine-grained control.

```typescript
import { middleware } from '@morojs/moro';

// Global CORS
app.use(middleware.cors({
  origin: ['https://example.com', 'https://app.example.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Total-Count'],
  credentials: true,
  maxAge: 86400 // 24 hours
}));

// Per-route CORS
app.get('/api/public')
  .cors({ origin: '*' })
  .handler((req, res) => {
    return { public: true };
  });

// Dynamic origin validation
app.use(middleware.cors({
  origin: (origin) => {
    return origin?.endsWith('.example.com') || origin === 'https://example.com';
  },
  credentials: true
}));
```

**Options:**
- `origin` - String, array, function, or `true`/`false`
- `methods` - Allowed HTTP methods
- `allowedHeaders` - Headers clients can send
- `exposedHeaders` - Headers exposed to clients
- `credentials` - Allow credentials
- `maxAge` - Preflight cache duration (seconds)

### Helmet (Security Headers)

Add security headers to protect against common vulnerabilities.

```typescript
// Default security headers
app.use(middleware.helmet());

// Custom configuration
app.use(middleware.helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.example.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'api.example.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com'],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"]
    }
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true
}));

// Disable specific headers
app.use(middleware.helmet({
  contentSecurityPolicy: false, // Disable CSP
  hsts: true
}));
```

**Headers Added:**
- Content-Security-Policy
- Strict-Transport-Security (HSTS)
- X-Frame-Options
- X-Content-Type-Options
- X-XSS-Protection
- Referrer-Policy
- Permissions-Policy

### CSRF Protection

Protect against Cross-Site Request Forgery attacks.

```typescript
// Enable CSRF protection
app.use(middleware.csrf({
  cookie: {
    name: '_csrf',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  },
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
  headerName: 'X-CSRF-Token'
}));

// Get CSRF token endpoint
app.get('/api/csrf-token', (req, res) => {
  return { csrfToken: req.csrfToken() };
});

// Protected endpoint
app.post('/api/transfer')
  .csrf() // Validate CSRF token
  .handler((req, res) => {
    // Process transfer
    return { success: true };
  });
```

### Content Security Policy (CSP)

Advanced CSP configuration with nonce and hash support.

```typescript
app.use(middleware.csp({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'nonce-{NONCE}'"],
    styleSrc: ["'self'", "'nonce-{NONCE}'"],
    imgSrc: ["'self'", 'data:', 'https:']
  },
  reportOnly: false,
  reportUri: '/api/csp-violations'
}));

// Access nonce in templates
app.get('/page', (req, res) => {
  const nonce = req.cspNonce;
  return `<script nonce="${nonce}">alert('Safe');</script>`;
});
```

---

## Performance Middleware

### Compression

Compress responses with gzip, deflate, or brotli.

```typescript
// Basic compression
app.use(middleware.compression());

// Advanced configuration
app.use(middleware.compression({
  level: 6, // Compression level (0-9)
  threshold: 1024, // Minimum size to compress (bytes)
  filter: (req, res) => {
    // Custom filter
    if (req.headers['x-no-compression']) {
      return false;
    }
    return /json|text|javascript|css/.test(res.getHeader('Content-Type') || '');
  },
  brotli: true, // Enable brotli for modern browsers
  brotliOptions: {
    params: {
      [require('zlib').constants.BROTLI_PARAM_QUALITY]: 4
    }
  }
}));

// Per-route compression
app.get('/api/large-data')
  .compression({ level: 9 })
  .handler((req, res) => {
    return largeDataset;
  });
```

### Cache

Response caching with multiple backend support.

```typescript
// Memory cache (default)
app.use(middleware.cache({
  ttl: 300, // 5 minutes
  strategy: 'memory',
  maxSize: 100 // Maximum cache entries
}));

// Redis cache
app.use(middleware.cache({
  ttl: 3600,
  strategy: 'redis',
  redis: {
    host: 'localhost',
    port: 6379,
    password: 'secret'
  }
}));

// Per-route caching
app.get('/api/users')
  .cache({
    ttl: 60,
    key: (req) => `users:${req.query.page || 1}`,
    tags: ['users', 'public'],
    vary: ['Authorization'] // Vary cache by header
  })
  .handler(async (req, res) => {
    const users = await getUsers(req.query.page);
    return users;
  });

// Cache invalidation
app.post('/api/users')
  .handler(async (req, res) => {
    const user = await createUser(req.body);

    // Invalidate cache
    await req.cache.invalidate(['users']);

    return user;
  });
```

### Rate Limiting

Protect endpoints from abuse with rate limiting.

```typescript
// Global rate limiting
app.use(middleware.rateLimit({
  requests: 100,
  window: 60000, // 1 minute
  message: 'Too many requests',
  statusCode: 429
}));

// Per-route rate limiting
app.post('/api/login')
  .rateLimit({
    requests: 5,
    window: 900000, // 15 minutes
    keyGenerator: (req) => req.ip,
    skipSuccessfulRequests: false,
    skipFailedRequests: true
  })
  .handler((req, res) => {
    return login(req.body);
  });

// Advanced rate limiting with Redis
app.use(middleware.rateLimit({
  requests: 1000,
  window: 60000,
  store: 'redis',
  redis: {
    host: 'localhost',
    port: 6379
  },
  keyGenerator: (req) => {
    // Rate limit by user or IP
    return req.user?.id || req.ip;
  },
  skip: (req) => {
    // Skip rate limiting for admins
    return req.user?.role === 'admin';
  }
}));
```

---

## HTTP Features

### Body Size Limiting

Limit request body size to prevent memory issues.

```typescript
// Global body size limit
app.use(middleware.bodySize({
  limit: '10mb',
  message: 'Request body too large'
}));

// Per-route limits
app.post('/api/upload')
  .bodySize({ limit: '50mb' })
  .handler((req, res) => {
    // Handle large upload
    return { success: true };
  });

// JSON-specific limit
app.use(middleware.bodySize({
  limit: '1mb',
  jsonLimit: '100kb'
}));
```

### Cookie Parser

Parse and manage cookies easily.

```typescript
// Enable cookie parsing
app.use(middleware.cookie({
  secret: 'your-secret-key',
  signed: true
}));

// Access cookies
app.get('/api/preferences', (req, res) => {
  const theme = req.cookies.theme;
  const user = req.signedCookies.user;

  return { theme, user };
});

// Set cookies
app.post('/api/preferences', (req, res) => {
  res.cookie('theme', req.body.theme, {
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
    httpOnly: true,
    secure: true,
    sameSite: 'strict'
  });

  return { success: true };
});
```

### Static Files

Serve static files with caching and ETags.

```typescript
// Basic static file serving
app.use(middleware.staticFiles({
  root: './public',
  maxAge: 3600000, // 1 hour
  index: ['index.html', 'index.htm']
}));

// Advanced configuration
app.use(middleware.staticFiles({
  root: './public',
  maxAge: 86400000, // 24 hours
  etag: true,
  lastModified: true,
  dotfiles: 'ignore', // 'allow' | 'deny' | 'ignore'
  extensions: ['html', 'htm'],
  fallthrough: true,
  redirect: true, // Redirect to trailing slash for directories
  setHeaders: (res, path, stat) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Multiple static directories
app.use('/assets', middleware.staticFiles({ root: './assets' }));
app.use('/uploads', middleware.staticFiles({ root: './uploads', maxAge: 0 }));
```

### File Upload

Handle multipart file uploads.

```typescript
// Basic file upload
app.use(middleware.upload({
  dest: './uploads',
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5
}));

// Advanced upload with validation
app.post('/api/upload')
  .upload({
    dest: './uploads',
    maxFileSize: 5 * 1024 * 1024,
    maxFiles: 1,
    allowedTypes: ['image/jpeg', 'image/png', 'image/gif']
  })
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
        mimetype: f.mimetype
      }))
    };
  });

// Multiple file fields
app.post('/api/profile')
  .upload({
    dest: './uploads',
    fields: {
      avatar: { maxFiles: 1, maxFileSize: 1024 * 1024 },
      documents: { maxFiles: 5, maxFileSize: 5 * 1024 * 1024 }
    }
  })
  .handler((req, res) => {
    return {
      avatar: req.files.avatar,
      documents: req.files.documents
    };
  });
```

### Template Rendering

Render templates with built-in or external engines.

```typescript
// Configure template engine
app.use(middleware.template({
  views: './views',
  engine: 'moro', // 'moro' | 'handlebars' | 'ejs'
  cache: true,
  defaultLayout: 'layout'
}));

// Render a template
app.get('/page', (req, res) => {
  res.render('index', {
    title: 'Welcome',
    user: req.user
  });
});

// Using Handlebars
app.use(middleware.template({
  views: './views',
  engine: 'handlebars',
  cache: process.env.NODE_ENV === 'production',
  helpers: {
    uppercase: (str: string) => str.toUpperCase(),
    formatDate: (date: Date) => date.toLocaleDateString()
  }
}));

// EJS templates
app.use(middleware.template({
  views: './views',
  engine: 'ejs',
  cache: true
}));
```

**Template Syntax (Moro Engine):**

```html
<!-- variables -->
<h1>{{title}}</h1>
<p>{{user.name}}</p>

<!-- loops -->
{{#each items}}
  <li>{{name}}</li>
{{/each}}

<!-- conditionals -->
{{#if user}}
  <p>Welcome, {{user.name}}</p>
{{else}}
  <p>Please log in</p>
{{/if}}
```

### HTTP Range Requests

Support partial content requests for streaming.

```typescript
// Enable range requests
app.use(middleware.range({
  acceptRanges: 'bytes',
  maxRanges: 5
}));

// Serve video with range support
app.get('/videos/:id', async (req, res) => {
  const videoPath = `./videos/${req.params.id}.mp4`;
  const stats = await fs.stat(videoPath);

  // sendRange handles partial content automatically
  res.sendRange(videoPath, stats);
});

// Range support for custom data
app.get('/api/data', (req, res) => {
  const data = getLargeData();

  if (req.headers.range) {
    const range = parseRange(req.headers.range, data.length);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${data.length}`);
    return data.slice(range.start, range.end + 1);
  }

  return data;
});
```

### HTTP/2 Server Push

Optimize loading with HTTP/2 server push.

```typescript
// Auto-detect and push resources
app.use(middleware.http2({
  autoDetect: true, // Detect CSS/JS from HTML
  resources: [
    {
      path: '/styles/main.css',
      as: 'style',
      type: 'text/css',
      priority: 200
    },
    {
      path: '/scripts/app.js',
      as: 'script',
      type: 'application/javascript',
      priority: 150
    }
  ],
  condition: (req) => req.path === '/' || req.path.endsWith('.html')
}));

// Manual push in route
app.get('/', (req, res) => {
  if (res.push) {
    res.push('/critical.css', {
      headers: { 'content-type': 'text/css' },
      priority: 200
    });
  }

  return res.sendFile('./public/index.html');
});
```

See [HTTP/2 Guide](./HTTP2_GUIDE.md) for detailed documentation.

---

## Authentication & Sessions

### Authentication

Complete authentication with Auth.js integration.

```typescript
import { middleware } from '@morojs/moro';

// Configure authentication
app.use(middleware.auth({
  providers: [
    {
      type: 'oauth',
      provider: 'google',
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: '/auth/google/callback'
    },
    {
      type: 'credentials',
      authorize: async (credentials) => {
        const user = await validateCredentials(credentials);
        return user;
      }
    }
  ],
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60 // 30 days
  },
  callbacks: {
    jwt: async ({ token, user }) => {
      if (user) {
        token.userId = user.id;
        token.role = user.role;
      }
      return token;
    }
  }
}));

// Protected route
app.get('/api/profile')
  .auth({ required: true })
  .handler((req, res) => {
    return { user: req.user };
  });

// Role-based access
app.get('/api/admin')
  .auth({
    required: true,
    roles: ['admin']
  })
  .handler((req, res) => {
    return { admin: true };
  });

// Permission-based access
app.delete('/api/users/:id')
  .auth({
    required: true,
    permissions: ['users:delete']
  })
  .handler((req, res) => {
    return deleteUser(req.params.id);
  });
```

**Auth Helpers:**

```typescript
import {
  requireAuth,
  requireRole,
  requirePermission,
  optionalAuth
} from '@morojs/moro';

// Helper functions
app.get('/api/profile', requireAuth(), (req, res) => {
  return req.user;
});

app.get('/api/admin', requireRole('admin'), (req, res) => {
  return { admin: true };
});

app.delete('/api/users/:id', requirePermission('users:delete'), (req, res) => {
  return deleteUser(req.params.id);
});

app.get('/api/feed', optionalAuth(), (req, res) => {
  // Works with or without authentication
  return getFeed(req.user?.id);
});
```

See [Authentication Guide](./AUTH_GUIDE.md) for complete documentation.

### Session Management

Server-side session storage.

```typescript
// Memory-based sessions
app.use(middleware.session({
  secret: 'your-secret-key',
  store: 'memory',
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: true,
    sameSite: 'strict'
  }
}));

// Redis sessions
app.use(middleware.session({
  secret: process.env.SESSION_SECRET,
  store: 'redis',
  redis: {
    host: 'localhost',
    port: 6379,
    password: process.env.REDIS_PASSWORD
  },
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Using sessions
app.post('/login', (req, res) => {
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

app.post('/logout', (req, res) => {
  req.session.destroy();
  return { success: true };
});
```

---

## Content Delivery

### CDN Integration

Integrate with CDN providers for asset delivery.

```typescript
// CloudFront integration
app.use(middleware.cdn({
  provider: 'cloudfront',
  config: {
    distributionId: 'E1234567890ABC',
    region: 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  pathPrefix: '/assets',
  invalidateOnChange: true
}));

// Cloudflare integration
app.use(middleware.cdn({
  provider: 'cloudflare',
  config: {
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
    apiKey: process.env.CLOUDFLARE_API_KEY,
    email: process.env.CLOUDFLARE_EMAIL
  }
}));

// Purge cache
app.post('/api/deploy', async (req, res) => {
  await req.cdn.purge(['/assets/*']);
  return { success: true };
});
```

### Server-Sent Events (SSE)

Real-time updates with SSE.

```typescript
// Enable SSE
app.use(middleware.sse());

// SSE endpoint
app.get('/events', (req, res) => {
  res.sse({
    retry: 10000, // Reconnect after 10s
    keepAlive: 30000 // Keep-alive every 30s
  });

  // Send events
  const interval = setInterval(() => {
    res.sse.send({
      event: 'update',
      data: { timestamp: Date.now() }
    });
  }, 5000);

  // Cleanup on close
  req.on('close', () => {
    clearInterval(interval);
  });
});

// Broadcast to all clients
const clients = new Set();

app.get('/stream', (req, res) => {
  res.sse();
  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

app.post('/broadcast', (req, res) => {
  clients.forEach(client => {
    client.sse.send({
      event: 'notification',
      data: req.body
    });
  });

  return { sent: clients.size };
});
```

---

## Monitoring & Logging

### Request Logger

Log all requests with configurable output.

```typescript
// Basic logging
app.use(middleware.requestLogger());

// Custom format
app.use(middleware.requestLogger({
  format: ':method :url :status :response-time ms',
  skip: (req) => req.path === '/health',
  stream: process.stdout
}));

// JSON logging
app.use(middleware.requestLogger({
  format: 'json',
  fields: ['method', 'url', 'status', 'responseTime', 'userAgent']
}));
```

### Performance Monitor

Monitor endpoint performance and detect slow requests.

```typescript
// Enable performance monitoring
app.use(middleware.performanceMonitor({
  threshold: 1000, // Warn if request takes > 1s
  sampleRate: 1.0, // Monitor 100% of requests
  onSlow: (req, duration) => {
    console.warn(`Slow request: ${req.method} ${req.path} - ${duration}ms`);
  }
}));

// Access metrics
app.get('/api/metrics', (req, res) => {
  return req.metrics.getStats();
});
```

### Error Tracker

Track and report errors to monitoring services.

```typescript
// Sentry integration
app.use(middleware.errorTracker({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.APP_VERSION,
  beforeSend: (event) => {
    // Filter sensitive data
    delete event.request?.cookies;
    return event;
  }
}));

// Custom error handler
app.use(middleware.errorTracker({
  handler: (error, req) => {
    // Send to custom service
    logService.error({
      error: error.message,
      stack: error.stack,
      url: req.url,
      method: req.method,
      user: req.user?.id
    });
  }
}));
```

---

## Advanced Features

### GraphQL

GraphQL API support.

```typescript
import { middleware } from '@morojs/moro';
import { buildSchema } from 'graphql';

const schema = buildSchema(`
  type Query {
    hello: String
    user(id: ID!): User
  }

  type User {
    id: ID!
    name: String!
    email: String!
  }
`);

app.use('/graphql', middleware.graphql({
  schema,
  rootValue: {
    hello: () => 'Hello world!',
    user: ({ id }) => getUser(id)
  },
  graphiql: true, // Enable GraphiQL interface
  context: (req) => ({
    user: req.user,
    db: req.db
  })
}));
```

See [GraphQL Guide](./GRAPHQL_GUIDE.md) for detailed documentation.

### Validation

Request validation with multiple libraries.

```typescript
import { z } from 'zod';

// Zod validation
app.post('/api/users')
  .body(z.object({
    name: z.string().min(2),
    email: z.string().email(),
    age: z.number().min(18)
  }))
  .handler((req, res) => {
    // req.body is fully typed and validated
    return createUser(req.body);
  });

// Multiple validations
app.post('/api/search')
  .query(z.object({
    q: z.string().min(1),
    page: z.coerce.number().default(1)
  }))
  .body(z.object({
    filters: z.array(z.string()).optional()
  }))
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
const createRateLimiter = (options) => {
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
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

app.use(errorHandler);
```

### Middleware Execution Order

MoroJS automatically orders middleware in the following phases:

1. **SECURITY** - CORS, Helmet, CSRF, CSP
2. **PARSING** - Body parsing, Cookie parsing, Body size
3. **RATE_LIMITING** - Rate limit checks
4. **AUTHENTICATION** - Auth and session
5. **VALIDATION** - Request validation
6. **CACHING** - Cache lookup
7. **HANDLER** - Route handler
8. **AFTER** - Response processing

```typescript
// Middleware executes in this order regardless of definition order
app.post('/api/users')
  .handler(createUser)           // 7. Handler
  .validate({ body: UserSchema }) // 5. Validation
  .auth({ required: true })       // 4. Authentication
  .rateLimit({ requests: 10 })    // 3. Rate limiting
  .cors({ origin: '*' });         // 1. Security
```

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
app.post('/api/upload')
  .upload({ maxFileSize: 10 * 1024 * 1024 })
  .handler(handleUpload);

app.get('/api/admin')
  .auth({ required: true, roles: ['admin'] })
  .handler(getAdminData);
```

### 3. Configure Middleware Based on Environment

```typescript
const app = createApp({
  cors: process.env.NODE_ENV === 'production'
    ? { origin: process.env.ALLOWED_ORIGINS }
    : { origin: '*' },

  compression: process.env.NODE_ENV === 'production',

  helmet: process.env.NODE_ENV === 'production'
});
```

### 4. Use Caching Strategically

```typescript
// Cache expensive queries
app.get('/api/reports/:id')
  .cache({ ttl: 3600, key: (req) => `report:${req.params.id}` })
  .handler(generateReport);

// Invalidate on updates
app.put('/api/reports/:id')
  .handler(async (req, res) => {
    const report = await updateReport(req.params.id, req.body);
    await req.cache.invalidate([`report:${req.params.id}`]);
    return report;
  });
```

### 5. Combine Middleware for Complete Protection

```typescript
app.post('/api/payment')
  .auth({ required: true })
  .rateLimit({ requests: 5, window: 60000 })
  .validation({ body: PaymentSchema })
  .csrf()
  .handler(processPayment);
```

---

## Performance Considerations

### Middleware Impact on Performance

| Middleware | Overhead | When to Use |
|------------|----------|-------------|
| `cors` | Minimal | Always for public APIs |
| `helmet` | Minimal | Always for security |
| `compression` | Medium | For large responses |
| `cache` | Low | For expensive operations |
| `rateLimit` | Low | For abuse prevention |
| `auth` | Medium | For protected routes |
| `validation` | Low-Medium | For data validation |
| `upload` | High | Only when needed |

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

