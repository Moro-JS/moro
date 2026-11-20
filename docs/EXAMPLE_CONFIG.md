# MoroJS Configuration Examples

This document provides comprehensive examples of MoroJS configuration for different use cases and environments.

## Table of Contents

- [Basic Configuration](#basic-configuration)
- [Development Setup](#development-setup)
- [Production Configuration](#production-configuration)
- [Multi-Environment Config](#multi-environment-config)
- [TypeScript Configuration](#typescript-configuration)
- [Module Configuration](#module-configuration)
- [Database Configurations](#database-configurations)
- [Security Configuration](#security-configuration)
- [Performance Configuration](#performance-configuration)

## Basic Configuration

### Simple Development Config

```javascript
// moro.config.js
export default {
  server: {
    port: 3000,
    host: 'localhost',
  },
  logging: {
    level: 'debug',
  },
};
```

### With Environment Variables

MoroJS reads `process.env` and does not load `.env` files itself: load the file before `createApp()` runs, for example with `import 'dotenv/config'` (CLI-generated projects do this) or `node --env-file=.env`.

```bash
# .env
PORT=3000
HOST=localhost
LOG_LEVEL=debug
NODE_ENV=development
```

## Development Setup

### Full Development Configuration

```javascript
// moro.config.js
// Databases and response caching are set up in application code, not in
// this file: see "Database Configurations" below and the Middleware Guide.
export default {
  server: {
    port: 3000,
    host: 'localhost',
  },
  logging: {
    level: 'debug',
    format: 'pretty',
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080'],
    },
    helmet: {
      enabled: true,
    },
  },
  performance: {
    compression: {
      enabled: false, // Disabled for development
    },
  },
};
```

### Development Environment Variables

```bash
# .env.development
NODE_ENV=development
PORT=3000
HOST=localhost

# Database (read by your own code, see "Database Configurations")
DATABASE_PATH=./dev.db

# Logging
LOG_LEVEL=debug
LOG_FORMAT=pretty

# Security (read by your config file)
CORS_ORIGIN=http://localhost:3000,http://localhost:5173,http://localhost:8080
```

## Production Configuration

### Secure Production Setup

```javascript
// moro.config.js
// The database connection (with TLS) and response caching are set up in
// application code, not in this file: see "Database Configurations" below
// and the Middleware Guide.
export default {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: '0.0.0.0',
    // One reverse proxy / ingress in front of the app: req.ip is then the
    // client, not the proxy. Leave it out when the app is reached directly.
    trustProxy: 1,
  },
  logging: {
    level: 'info',
    format: 'json',
  },
  security: {
    cors: {
      enabled: true,
      origin: process.env.CORS_ORIGIN?.split(',') || ['https://myapp.com'],
      credentials: true,
    },
    helmet: {
      enabled: true,
    },
    // 300 requests a minute per client address and route; needs trustProxy
    // above to count clients and not the proxy
    rateLimit: {
      global: { enabled: true, requests: 300, window: 60000 },
    },
  },
  performance: {
    compression: {
      enabled: true,
      level: 9,
      threshold: 1024,
    },
  },
};
```

### Production Environment Variables

```bash
# .env.production
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Database (read by your own code, see "Database Configurations")
DATABASE_HOST=prod-db.example.com
DATABASE_PORT=5432
DATABASE_USERNAME=myapp
DATABASE_PASSWORD=secure-production-password
DATABASE_NAME=myapp_prod
DATABASE_CA_CERT=/etc/ssl/certs/database-ca.pem

# Redis
REDIS_URL=redis://prod-redis.example.com:6379

# Security
JWT_SECRET=ultra-secure-jwt-secret-key
CORS_ORIGIN=https://myapp.com,https://api.myapp.com

# Logging
LOG_LEVEL=info
LOG_FORMAT=json
```

## Multi-Environment Config

### Dynamic Environment Configuration

```javascript
// moro.config.js
const environment = process.env.NODE_ENV || 'development';

const baseConfig = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || 'localhost',
  },
  security: {
    cors: {
      enabled: true,
    },
    helmet: {
      enabled: true,
    },
  },
};

const environmentConfigs = {
  development: {
    ...baseConfig,
    logging: {
      level: 'debug',
      format: 'pretty',
    },
    security: {
      ...baseConfig.security,
      cors: {
        ...baseConfig.security.cors,
        origin: ['http://localhost:3000', 'http://localhost:5173'],
      },
    },
    performance: {
      compression: {
        enabled: false,
      },
    },
  },

  test: {
    ...baseConfig,
    logging: {
      level: 'error',
    },
    performance: {
      compression: {
        enabled: false,
      },
    },
  },

  staging: {
    ...baseConfig,
    logging: {
      level: 'debug',
      format: 'json',
    },
    security: {
      ...baseConfig.security,
      cors: {
        ...baseConfig.security.cors,
        origin: process.env.CORS_ORIGIN?.split(',') || ['https://staging.myapp.com'],
      },
    },
    performance: {
      compression: {
        enabled: true,
        level: 6,
      },
    },
  },

  production: {
    ...baseConfig,
    logging: {
      level: 'info',
      format: 'json',
    },
    security: {
      ...baseConfig.security,
      cors: {
        ...baseConfig.security.cors,
        origin: process.env.CORS_ORIGIN?.split(',') || ['https://myapp.com'],
      },
    },
    performance: {
      compression: {
        enabled: true,
        level: 9,
      },
    },
  },
};

export default environmentConfigs[environment];
```

## TypeScript Configuration

### Fully Typed Configuration

```typescript
// moro.config.ts
import type { AppConfig, DeepPartial } from '@morojs/moro';

const config: DeepPartial<AppConfig> = {
  server: {
    port: 3000,
  },
  // Stored for your own code to read (app.getConfig().database):
  // MoroJS does not open a connection from it
  database: {
    postgresql: {
      host: 'localhost',
      port: 5432,
      database: 'myapp_dev',
      connectionLimit: 10, // required: a postgresql section without it fails validation
    },
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000'],
    },
    helmet: {
      enabled: true,
    },
  },
  performance: {
    compression: {
      enabled: true,
      level: 6,
    },
  },
  logging: {
    level: 'debug',
    format: 'pretty',
  },
};

export default config;
```

### TypeScript with Environment Validation

```typescript
// moro.config.ts
import type { AppConfig, DeepPartial } from '@morojs/moro';
import { z } from 'zod';

// Environment validation schema
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('localhost'),
  DATABASE_HOST: z.string().optional(),
  DATABASE_PORT: z.coerce.number().default(5432),
  DATABASE_USERNAME: z.string().optional(),
  DATABASE_PASSWORD: z.string().optional(),
  DATABASE_NAME: z.string().default('myapp'),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32).optional(),
  CORS_ORIGIN: z.string().optional(),
});

// Validate environment variables
const env = EnvSchema.parse(process.env);

const config: DeepPartial<AppConfig> = {
  server: {
    port: env.PORT,
  },
  database: env.DATABASE_HOST
    ? {
        postgresql: {
          host: env.DATABASE_HOST,
          port: env.DATABASE_PORT,
          database: env.DATABASE_NAME,
          connectionLimit: 10,
        },
      }
    : {
        sqlite: {
          filename: './dev.db',
        },
      },
  security: {
    cors: {
      enabled: true,
      origin: env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
    },
  },
  logging: {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: env.NODE_ENV === 'production' ? 'json' : 'pretty',
  },
};

export default config;
```

## Module Configuration

### Email Module Configuration

```typescript
// modules/email/config.ts
import { createModuleConfig, z } from '@morojs/moro';

const EmailConfigSchema = z.object({
  apiKey: z.string(),
  apiUrl: z.string().url().default('https://api.sendgrid.com/v3'),
  timeout: z.number().default(5000),
  retries: z.number().default(3),
  enabled: z.boolean().default(true),
  templates: z
    .object({
      welcome: z.string().default('welcome-template'),
      resetPassword: z.string().default('reset-password-template'),
      verification: z.string().default('verification-template'),
    })
    .default({
      welcome: 'welcome-template',
      resetPassword: 'reset-password-template',
      verification: 'verification-template',
    }),
});

export const emailConfig = createModuleConfig(
  EmailConfigSchema,
  {
    apiKey: 'dev-api-key',
    timeout: 3000,
    enabled: process.env.NODE_ENV !== 'test',
  },
  'EMAIL_'
);

// Environment variables:
// EMAIL_API_KEY=your-sendgrid-api-key
// EMAIL_API_URL=https://api.sendgrid.com/v3
// EMAIL_TIMEOUT=5000
// EMAIL_RETRIES=3
// EMAIL_ENABLED=true
```

### Payment Module Configuration

```typescript
// modules/payment/config.ts
import { createModuleConfig, z } from '@morojs/moro';

const PaymentConfigSchema = z.object({
  publicKey: z.string(),
  secretKey: z.string(),
  webhookSecret: z.string(),
  environment: z.enum(['test', 'live']).default('test'),
  currency: z.string().default('usd'),
  captureMethod: z.enum(['automatic', 'manual']).default('automatic'),
  features: z
    .object({
      subscriptions: z.boolean().default(true),
      multiParty: z.boolean().default(false),
      connect: z.boolean().default(false),
    })
    .default({ subscriptions: true, multiParty: false, connect: false }),
});

export const paymentConfig = createModuleConfig(
  PaymentConfigSchema,
  {
    environment: process.env.NODE_ENV === 'production' ? 'live' : 'test',
    currency: 'usd',
    captureMethod: 'automatic',
  },
  'STRIPE_'
);

// Environment variables (required: these three have no default):
// STRIPE_PUBLIC_KEY=pk_test_...
// STRIPE_SECRET_KEY=sk_test_...
// STRIPE_WEBHOOK_SECRET=whsec_...
```

## Database Configurations

MoroJS does not open database connections from `moro.config.js`. Create an adapter in application code and register it with `app.database()`; each adapter loads its driver package from your project.

### PostgreSQL Configuration

```javascript
// PostgreSQL (requires the `pg` package)
import fs from 'node:fs';
import { createApp, PostgreSQLAdapter } from '@morojs/moro';

const app = await createApp();

const db = new PostgreSQLAdapter({
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432'),
  user: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || '',
  database: process.env.DATABASE_NAME || 'myapp',
  connectionLimit: 10, // connection pool size
  // Production: TLS with certificate verification. DATABASE_CA_CERT is the
  // path to your provider's CA bundle (PEM). Do not use
  // rejectUnauthorized: false here - it disables verification.
  ssl:
    process.env.NODE_ENV === 'production'
      ? {
          rejectUnauthorized: true,
          ca: fs.readFileSync(process.env.DATABASE_CA_CERT, 'utf8'),
        }
      : false, // local development only: database on localhost without TLS
});

app.database(db);
```

### MySQL Configuration

```javascript
// MySQL (requires the `mysql2` package)
import { createApp, MySQLAdapter } from '@morojs/moro';

const app = await createApp();

const db = new MySQLAdapter({
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '3306'),
  user: process.env.DATABASE_USERNAME || 'root',
  password: process.env.DATABASE_PASSWORD || '',
  database: process.env.DATABASE_NAME || 'myapp',
  connectionLimit: 10, // connection pool size
});

app.database(db);
```

### MongoDB Configuration

```javascript
// MongoDB (requires the `mongodb` package)
import { createApp, MongoDBAdapter } from '@morojs/moro';

const app = await createApp();

const db = new MongoDBAdapter({
  url: process.env.MONGODB_URL || 'mongodb://localhost:27017/myapp',
  database: 'myapp',
  maxPoolSize: 10,
  minPoolSize: 2,
});

app.database(db);
```

### Redis Configuration

```javascript
// Redis (requires the `ioredis` package)
import { RedisAdapter } from '@morojs/moro';

const redis = new RedisAdapter({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || '0'),
  keyPrefix: 'myapp:',
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});
```

## Security Configuration

### Enhanced Security Setup

```javascript
// moro.config.js
// Each enabled section below installs the built-in middleware of that name
// with the section as its options. JWT auth is registered in application
// code (see the Authentication Guide).
export default {
  server: {
    trustProxy: ['10.0.0.0/8'], // the proxies in front of the app
  },
  security: {
    cors: {
      enabled: true,
      origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
      credentials: true,
      maxAge: 86400, // 24 hours
    },
    helmet: {
      enabled: true,
      referrerPolicy: 'no-referrer',
      strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true },
    },
    // Owns the Content-Security-Policy header (helmet then sends none)
    csp: {
      enabled: true,
      directives: {
        scriptSrc: ["'self'", 'https://cdn.example.com'],
        frameSrc: null, // leave this default directive out
      },
    },
    // Unsafe methods need the token from `await req.csrfToken()`
    csrf: {
      enabled: true,
      secret: process.env.CSRF_SECRET,
    },
    rateLimit: {
      global: { enabled: true, requests: 300, window: 60000 },
    },
  },
  modules: {
    session: {
      enabled: true,
      store: 'redis',
      storeOptions: { url: process.env.REDIS_URL },
      secret: process.env.SESSION_SECRET,
      cookie: { secure: true },
    },
  },
};
```

## Performance Configuration

### Optimized Performance Setup

```javascript
// moro.config.js
// Response caching and metrics are middleware (middleware.cache(),
// middleware.prometheus()), registered in application code.
export default {
  performance: {
    compression: {
      enabled: true,
      level: 9,
      threshold: 1024,
    },
    clustering: {
      enabled: true,
      workers: 'auto',
    },
  },
};
```

---

## Best Practices

### 1. Environment Variables for Secrets

Always use environment variables for sensitive data:

- Database passwords
- API keys
- JWT secrets
- Third-party service credentials

### 2. Different Configs per Environment

Use environment-specific configurations:

- Development: Debug logging, local databases
- Test: In-memory databases, minimal logging
- Staging: Production-like setup with test data
- Production: Optimized for performance and security

### 3. Configuration Validation

Validate your configuration at startup:

```typescript
const ConfigSchema = z.object({
  DATABASE_HOST: z.string(),
  DATABASE_PASSWORD: z.string().min(8),
  JWT_SECRET: z.string().min(32),
});

const env = ConfigSchema.parse(process.env);
```

### 4. Graceful Defaults

Provide sensible defaults in your config files:

```javascript
{
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || 'localhost'
  }
}
```

### 5. Documentation

Document all configuration options and their purposes for your team.
