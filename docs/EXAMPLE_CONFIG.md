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
module.exports = {
  server: {
    port: 3000,
    host: 'localhost',
    environment: 'development'
  },
  logging: {
    level: 'debug'
  }
};
```

### With Environment Variables

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
module.exports = {
  server: {
    port: 3000,
    host: 'localhost',
    environment: 'development'
  },
  database: {
    type: 'sqlite',
    database: './dev.db'
  },
  logging: {
    level: 'debug',
    format: 'pretty'
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080']
    },
    helmet: {
      enabled: true
    },
    rateLimit: {
      enabled: false // Disabled for development
    }
  },
  performance: {
    compression: {
      enabled: false // Disabled for development
    },
    cache: {
      enabled: true,
      adapter: 'memory',
      ttl: 60 // Short TTL for development
    }
  }
};
```

### Development Environment Variables

```bash
# .env.development
NODE_ENV=development
PORT=3000
HOST=localhost

# Database
DATABASE_TYPE=sqlite
DATABASE_PATH=./dev.db

# Logging
LOG_LEVEL=debug
LOG_FORMAT=pretty

# Security
CORS_ORIGIN=http://localhost:3000,http://localhost:5173,http://localhost:8080

# Development tools
ENABLE_DOCS=true
DOCS_PATH=/docs
```

## Production Configuration

### Secure Production Setup

```javascript
// moro.config.js
module.exports = {
  server: {
    port: process.env.PORT || 3000,
    host: '0.0.0.0',
    environment: 'production'
  },
  database: {
    type: 'postgresql',
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    username: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: {
      rejectUnauthorized: false
    },
    pool: {
      min: 2,
      max: 10,
      acquireTimeoutMillis: 30000,
      idleTimeoutMillis: 30000
    }
  },
  logging: {
    level: 'info',
    format: 'json'
  },
  security: {
    cors: {
      enabled: true,
      origin: process.env.CORS_ORIGIN?.split(',') || ['https://myapp.com'],
      credentials: true
    },
    helmet: {
      enabled: true,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"]
        }
      }
    },
    rateLimit: {
      enabled: true,
      requests: 1000,
      window: 60000, // 1 minute
      skipSuccessfulRequests: false,
      skipFailedRequests: false
    }
  },
  performance: {
    compression: {
      enabled: true,
      level: 9,
      threshold: 1024
    },
    cache: {
      enabled: true,
      adapter: 'redis',
      redis: {
        url: process.env.REDIS_URL,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3
      },
      ttl: 3600 // 1 hour
    }
  }
};
```

### Production Environment Variables

```bash
# .env.production
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Database
DATABASE_HOST=prod-db.example.com
DATABASE_PORT=5432
DATABASE_USERNAME=myapp
DATABASE_PASSWORD=secure-production-password
DATABASE_NAME=myapp_prod

# Redis
REDIS_URL=redis://prod-redis.example.com:6379

# Security
JWT_SECRET=ultra-secure-jwt-secret-key
CORS_ORIGIN=https://myapp.com,https://api.myapp.com

# Logging
LOG_LEVEL=info
LOG_FORMAT=json

# Performance
CACHE_TTL=3600
COMPRESSION_LEVEL=9
```

## Multi-Environment Config

### Dynamic Environment Configuration

```javascript
// moro.config.js
const environment = process.env.NODE_ENV || 'development';

const baseConfig = {
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || 'localhost'
  },
  security: {
    cors: {
      enabled: true
    },
    helmet: {
      enabled: true
    }
  }
};

const environmentConfigs = {
  development: {
    ...baseConfig,
    server: {
      ...baseConfig.server,
      environment: 'development'
    },
    database: {
      type: 'sqlite',
      database: './dev.db'
    },
    logging: {
      level: 'debug',
      format: 'pretty'
    },
    security: {
      ...baseConfig.security,
      cors: {
        ...baseConfig.security.cors,
        origin: ['http://localhost:3000', 'http://localhost:5173']
      },
      rateLimit: {
        enabled: false
      }
    },
    performance: {
      compression: {
        enabled: false
      },
      cache: {
        enabled: true,
        adapter: 'memory',
        ttl: 60
      }
    }
  },

  test: {
    ...baseConfig,
    server: {
      ...baseConfig.server,
      environment: 'test'
    },
    database: {
      type: 'sqlite',
      database: ':memory:'
    },
    logging: {
      level: 'error'
    },
    security: {
      ...baseConfig.security,
      rateLimit: {
        enabled: false
      }
    },
    performance: {
      compression: {
        enabled: false
      },
      cache: {
        enabled: false
      }
    }
  },

  staging: {
    ...baseConfig,
    server: {
      ...baseConfig.server,
      environment: 'staging'
    },
    database: {
      type: 'postgresql',
      host: process.env.DATABASE_HOST || 'staging-db.example.com',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME
    },
    logging: {
      level: 'debug',
      format: 'json'
    },
    security: {
      ...baseConfig.security,
      cors: {
        ...baseConfig.security.cors,
        origin: process.env.CORS_ORIGIN?.split(',') || ['https://staging.myapp.com']
      },
      rateLimit: {
        enabled: true,
        requests: 500,
        window: 60000
      }
    },
    performance: {
      compression: {
        enabled: true,
        level: 6
      },
      cache: {
        enabled: true,
        adapter: 'redis',
        redis: {
          url: process.env.REDIS_URL
        },
        ttl: 1800
      }
    }
  },

  production: {
    ...baseConfig,
    server: {
      ...baseConfig.server,
      environment: 'production'
    },
    database: {
      type: 'postgresql',
      host: process.env.DATABASE_HOST,
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
      ssl: true,
      pool: {
        min: 5,
        max: 20
      }
    },
    logging: {
      level: 'info',
      format: 'json'
    },
    security: {
      ...baseConfig.security,
      cors: {
        ...baseConfig.security.cors,
        origin: process.env.CORS_ORIGIN?.split(',') || ['https://myapp.com']
      },
      rateLimit: {
        enabled: true,
        requests: 1000,
        window: 60000
      }
    },
    performance: {
      compression: {
        enabled: true,
        level: 9
      },
      cache: {
        enabled: true,
        adapter: 'redis',
        redis: {
          url: process.env.REDIS_URL
        },
        ttl: 3600
      }
    }
  }
};

module.exports = environmentConfigs[environment];
```

## TypeScript Configuration

### Fully Typed Configuration

```typescript
// moro.config.ts
import type { AppConfig } from 'moro';

const config: Partial<AppConfig> = {
  server: {
    port: 3000,
    host: 'localhost',
    environment: 'development'
  },
  database: {
    type: 'postgresql',
    host: 'localhost',
    port: 5432,
    username: 'myapp',
    password: 'development-password',
    database: 'myapp_dev'
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000']
    },
    helmet: {
      enabled: true
    },
    rateLimit: {
      enabled: true,
      requests: 100,
      window: 60000
    }
  },
  performance: {
    compression: {
      enabled: true,
      level: 6
    },
    cache: {
      enabled: true,
      adapter: 'memory',
      ttl: 300
    }
  },
  logging: {
    level: 'debug',
    format: 'pretty'
  }
};

export default config;
```

### TypeScript with Environment Validation

```typescript
// moro.config.ts
import type { AppConfig } from 'moro';
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
  DATABASE_NAME: z.string().optional(),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32).optional(),
  CORS_ORIGIN: z.string().optional()
});

// Validate environment variables
const env = EnvSchema.parse(process.env);

const config: Partial<AppConfig> = {
  server: {
    port: env.PORT,
    host: env.HOST,
    environment: env.NODE_ENV
  },
  database: env.DATABASE_HOST ? {
    type: 'postgresql',
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    username: env.DATABASE_USERNAME!,
    password: env.DATABASE_PASSWORD!,
    database: env.DATABASE_NAME!
  } : {
    type: 'sqlite',
    database: './dev.db'
  },
  security: {
    cors: {
      enabled: true,
      origin: env.CORS_ORIGIN?.split(',') || ['http://localhost:3000']
    }
  },
  performance: {
    cache: {
      enabled: true,
      adapter: env.REDIS_URL ? 'redis' : 'memory',
      ...(env.REDIS_URL && {
        redis: { url: env.REDIS_URL }
      }),
      ttl: 300
    }
  },
  logging: {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: env.NODE_ENV === 'production' ? 'json' : 'pretty'
  }
};

export default config;
```

## Module Configuration

### Email Module Configuration

```typescript
// modules/email/config.ts
import { createModuleConfig, z } from 'moro';

const EmailConfigSchema = z.object({
  apiKey: z.string(),
  apiUrl: z.string().url().default('https://api.sendgrid.com/v3'),
  timeout: z.number().default(5000),
  retries: z.number().default(3),
  enabled: z.boolean().default(true),
  templates: z.object({
    welcome: z.string().default('welcome-template'),
    resetPassword: z.string().default('reset-password-template'),
    verification: z.string().default('verification-template')
  }).default({})
});

export const emailConfig = createModuleConfig(
  EmailConfigSchema,
  {
    apiKey: 'dev-api-key',
    timeout: 3000,
    enabled: process.env.NODE_ENV !== 'test'
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
import { createModuleConfig, z } from 'moro';

const PaymentConfigSchema = z.object({
  stripePublicKey: z.string(),
  stripeSecretKey: z.string(),
  webhookSecret: z.string(),
  environment: z.enum(['test', 'live']).default('test'),
  currency: z.string().default('usd'),
  captureMethod: z.enum(['automatic', 'manual']).default('automatic'),
  features: z.object({
    subscriptions: z.boolean().default(true),
    multiParty: z.boolean().default(false),
    connect: z.boolean().default(false)
  }).default({})
});

export const paymentConfig = createModuleConfig(
  PaymentConfigSchema,
  {
    environment: process.env.NODE_ENV === 'production' ? 'live' : 'test',
    currency: 'usd',
    captureMethod: 'automatic'
  },
  'STRIPE_'
);
```

## Database Configurations

### PostgreSQL Configuration

```javascript
// Database-focused config
module.exports = {
  database: {
    type: 'postgresql',
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'myapp',
    ssl: process.env.NODE_ENV === 'production' ? {
      rejectUnauthorized: false
    } : false,
    pool: {
      min: 2,
      max: 10,
      acquireTimeoutMillis: 30000,
      idleTimeoutMillis: 30000
    },
    migrations: {
      directory: './migrations',
      tableName: 'migrations'
    }
  }
};
```

### MySQL Configuration

```javascript
module.exports = {
  database: {
    type: 'mysql',
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '3306'),
    username: process.env.DATABASE_USERNAME || 'root',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'myapp',
    charset: 'utf8mb4',
    timezone: '+00:00',
    pool: {
      min: 2,
      max: 10,
      acquireTimeoutMillis: 30000,
      idleTimeoutMillis: 30000
    }
  }
};
```

### MongoDB Configuration

```javascript
module.exports = {
  database: {
    type: 'mongodb',
    url: process.env.MONGODB_URL || 'mongodb://localhost:27017/myapp',
    options: {
      useUnifiedTopology: true,
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 30000
    }
  }
};
```

### Redis Configuration

```javascript
module.exports = {
  cache: {
    enabled: true,
    adapter: 'redis',
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      keepAlive: 30000,
      family: 4, // 4 for IPv4, 6 for IPv6
      keyPrefix: 'myapp:',
      db: parseInt(process.env.REDIS_DB || '0')
    },
    ttl: 3600,
    compression: true
  }
};
```

## Security Configuration

### Enhanced Security Setup

```javascript
module.exports = {
  security: {
    cors: {
      enabled: true,
      origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      credentials: true,
      optionsSuccessStatus: 200,
      maxAge: 86400 // 24 hours
    },
    helmet: {
      enabled: true,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "wss:", "https:"]
        }
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    },
    rateLimit: {
      enabled: true,
      requests: 1000,
      window: 60000,
      message: 'Too many requests from this IP',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      skipFailedRequests: false
    },
    auth: {
      jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: '24h',
        issuer: 'myapp',
        audience: 'myapp-users'
      },
      session: {
        secret: process.env.SESSION_SECRET,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'strict'
      }
    }
  }
};
```

## Performance Configuration

### Optimized Performance Setup

```javascript
module.exports = {
  performance: {
    compression: {
      enabled: true,
      level: 9,
      threshold: 1024,
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false;
        }
        return compression.filter(req, res);
      }
    },
    cache: {
      enabled: true,
      adapter: 'redis',
      redis: {
        url: process.env.REDIS_URL,
        keyPrefix: 'cache:',
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3
      },
      ttl: 3600,
      compression: true,
      strategies: {
        routes: {
          '/api/users': { ttl: 300 },
          '/api/posts': { ttl: 600 },
          '/api/static/*': { ttl: 86400 }
        }
      }
    },
    monitoring: {
      enabled: true,
      metricsInterval: 30000,
      healthCheck: {
        enabled: true,
        path: '/health',
        checks: ['database', 'redis', 'memory']
      }
    }
  }
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
  JWT_SECRET: z.string().min(32)
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
