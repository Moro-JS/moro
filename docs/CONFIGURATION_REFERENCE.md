# MoroJS Configuration Reference

This document provides a comprehensive reference for all configuration options available in MoroJS. Configuration can be provided through environment variables, configuration files (`moro.config.js` or `moro.config.ts`), or programmatically.

## Table of Contents

- [Configuration Sources](#configuration-sources)
- [Server Configuration](#server-configuration)
- [Service Discovery](#service-discovery)
- [Database Configuration](#database-configuration)
- [Module Defaults](#module-defaults)
- [Auto-Discovery Configuration](#auto-discovery-configuration)
- [Logging Configuration](#logging-configuration)
- [Security Configuration](#security-configuration)
- [External Services](#external-services)
- [Performance Configuration](#performance-configuration)
- [Authentication Configuration](#authentication-configuration)
- [Session Configuration](#session-configuration)
- [Cache Configuration](#cache-configuration)
- [CDN Configuration](#cdn-configuration)
- [Runtime Configuration](#runtime-configuration)
- [Environment Variables](#environment-variables)

## Configuration Sources

MoroJS loads configuration from multiple sources in this order of priority:

1. **Environment Variables** (highest priority)
2. **Configuration Files** (`moro.config.js` or `moro.config.ts`)
3. **Schema Defaults** (lowest priority)

### Configuration Files

Create a `moro.config.js` or `moro.config.ts` file in your project root:

```javascript
// moro.config.js
module.exports = {
  server: {
    port: 3001,
    host: 'localhost',
    environment: 'development',
  },
  database: {
    url: 'postgresql://user:pass@localhost:5432/mydb',
  },
  logging: {
    level: 'info',
    format: 'pretty',
  },
};
```

```typescript
// moro.config.ts
import { AppConfig } from '@morojs/core';

export default {
  server: {
    port: 3001,
    host: 'localhost',
    environment: 'development',
  },
  database: {
    url: 'postgresql://user:pass@localhost:5432/mydb',
  },
  logging: {
    level: 'info',
    format: 'pretty',
  },
} as Partial<AppConfig>;
```

## Server Configuration

### `server` Section

Configure the HTTP server settings.

| Property         | Type     | Default       | Description                        |
| ---------------- | -------- | ------------- | ---------------------------------- |
| `port`           | `number` | `3001`        | Server port to listen on (1-65535) |
| `host`           | `string` | `'localhost'` | Server host to bind to             |
| `maxConnections` | `number` | `1000`        | Maximum concurrent connections     |
| `timeout`        | `number` | `30000`       | Request timeout in milliseconds    |

**Note**: Environment detection now uses `NODE_ENV` directly for consistency with the Node.js ecosystem. Use `isDevelopment()`, `isProduction()`, and `isStaging()` utility functions to check the current environment.

#### Example

```javascript
{
  server: {
    port: 8080,
    host: '0.0.0.0',
    maxConnections: 5000,
    timeout: 60000
  }
}

// Environment is now controlled by NODE_ENV
// NODE_ENV=production node your-app.js
```

#### Environment Variables

- `PORT` or `MORO_PORT`
- `HOST` or `MORO_HOST`
- `NODE_ENV` (controls environment behavior - not part of server config)
- `MAX_CONNECTIONS` or `MORO_MAX_CONNECTIONS`
- `REQUEST_TIMEOUT` or `MORO_TIMEOUT`

## Service Discovery

### `serviceDiscovery` Section

Configure service discovery for microservices architecture.

| Property              | Type                                   | Default                   | Description                                       |
| --------------------- | -------------------------------------- | ------------------------- | ------------------------------------------------- |
| `enabled`             | `boolean`                              | `false`                   | Enable service discovery                          |
| `type`                | `'memory' \| 'consul' \| 'kubernetes'` | `'memory'`                | Service discovery backend type                    |
| `consulUrl`           | `string`                               | `'http://localhost:8500'` | Consul server URL                                 |
| `kubernetesNamespace` | `string`                               | `'default'`               | Kubernetes namespace                              |
| `healthCheckInterval` | `number`                               | `30000`                   | Health check interval in milliseconds             |
| `retryAttempts`       | `number`                               | `3`                       | Number of retry attempts for failed health checks |

#### Example

```javascript
{
  serviceDiscovery: {
    enabled: true,
    type: 'consul',
    consulUrl: 'http://consul.internal:8500',
    healthCheckInterval: 15000,
    retryAttempts: 5
  }
}
```

#### Environment Variables

- `SERVICE_DISCOVERY_ENABLED` or `MORO_SERVICE_DISCOVERY`
- `DISCOVERY_TYPE` or `MORO_DISCOVERY_TYPE`
- `CONSUL_URL` or `MORO_CONSUL_URL`
- `K8S_NAMESPACE` or `MORO_K8S_NAMESPACE`
- `HEALTH_CHECK_INTERVAL` or `MORO_HEALTH_INTERVAL`
- `DISCOVERY_RETRY_ATTEMPTS` or `MORO_DISCOVERY_RETRIES`

## Database Configuration

### `database` Section

Configure database connections and adapters.

| Property | Type     | Default | Description                     |
| -------- | -------- | ------- | ------------------------------- |
| `url`    | `string` | -       | Primary database connection URL |
| `redis`  | `object` | -       | Redis configuration             |
| `mysql`  | `object` | -       | MySQL configuration             |

#### Redis Configuration

| Property     | Type     | Default                    | Description                             |
| ------------ | -------- | -------------------------- | --------------------------------------- |
| `url`        | `string` | `'redis://localhost:6379'` | Redis connection URL                    |
| `maxRetries` | `number` | `3`                        | Maximum Redis connection retry attempts |
| `retryDelay` | `number` | `1000`                     | Redis retry delay in milliseconds       |
| `keyPrefix`  | `string` | `'moro:'`                  | Redis key prefix                        |

#### MySQL Configuration

| Property          | Type     | Default       | Description                |
| ----------------- | -------- | ------------- | -------------------------- |
| `host`            | `string` | `'localhost'` | MySQL host                 |
| `port`            | `number` | `3306`        | MySQL port                 |
| `database`        | `string` | -             | Database name              |
| `username`        | `string` | -             | Database username          |
| `password`        | `string` | -             | Database password          |
| `connectionLimit` | `number` | `10`          | Connection pool limit      |
| `acquireTimeout`  | `number` | `60000`       | Connection acquire timeout |
| `timeout`         | `number` | `60000`       | Query timeout              |

#### Example

```javascript
{
  database: {
    url: 'postgresql://user:pass@localhost:5432/myapp',
    redis: {
      url: 'redis://redis.internal:6379',
      maxRetries: 5,
      retryDelay: 2000,
      keyPrefix: 'myapp:'
    },
    mysql: {
      host: 'mysql.internal',
      port: 3306,
      database: 'myapp_db',
      username: 'myapp_user',
      password: 'secure_password',
      connectionLimit: 20
    }
  }
}
```

#### Environment Variables

- `DATABASE_URL` or `MORO_DATABASE_URL`
- `REDIS_URL` or `MORO_REDIS_URL`
- `REDIS_MAX_RETRIES` or `MORO_REDIS_RETRIES`
- `REDIS_RETRY_DELAY` or `MORO_REDIS_DELAY`
- `REDIS_KEY_PREFIX` or `MORO_REDIS_PREFIX`
- `MYSQL_HOST` or `MORO_MYSQL_HOST`
- `MYSQL_PORT` or `MORO_MYSQL_PORT`
- `MYSQL_DATABASE` or `MORO_MYSQL_DB`
- `MYSQL_USERNAME` or `MORO_MYSQL_USER`
- `MYSQL_PASSWORD` or `MORO_MYSQL_PASS`
- `MYSQL_CONNECTION_LIMIT` or `MORO_MYSQL_CONNECTIONS`

## Module Defaults

### `modules` Section

Configure default behaviors for modules.

#### Cache Defaults

| Property     | Type                       | Default | Description                  |
| ------------ | -------------------------- | ------- | ---------------------------- |
| `enabled`    | `boolean`                  | `true`  | Enable caching by default    |
| `defaultTtl` | `number`                   | `300`   | Default cache TTL in seconds |
| `maxSize`    | `number`                   | `1000`  | Maximum cache entries        |
| `strategy`   | `'lru' \| 'lfu' \| 'fifo'` | `'lru'` | Cache eviction strategy      |

#### Rate Limit Defaults

| Property                 | Type      | Default | Description                                     |
| ------------------------ | --------- | ------- | ----------------------------------------------- |
| `enabled`                | `boolean` | `true`  | Enable rate limiting by default                 |
| `defaultRequests`        | `number`  | `100`   | Default requests per window                     |
| `defaultWindow`          | `number`  | `60000` | Default rate limit window in milliseconds       |
| `skipSuccessfulRequests` | `boolean` | `false` | Skip successful requests in rate limit counting |
| `skipFailedRequests`     | `boolean` | `false` | Skip failed requests in rate limit counting     |

#### Validation Defaults

| Property       | Type      | Default | Description                                  |
| -------------- | --------- | ------- | -------------------------------------------- |
| `enabled`      | `boolean` | `true`  | Enable validation by default                 |
| `stripUnknown` | `boolean` | `true`  | Strip unknown properties from validated data |
| `abortEarly`   | `boolean` | `false` | Stop validation on first error               |

#### Auto-Discovery Defaults

| Property          | Type                                         | Default                                                              | Description                                          |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| `enabled`         | `boolean`                                    | `true`                                                               | Enable automatic module discovery                    |
| `paths`           | `string[]`                                   | `['./modules', './src/modules']`                                     | Directories to search for modules                    |
| `patterns`        | `string[]`                                   | `['**/*.module.{ts,js}', '**/index.{ts,js}', '**/*.config.{ts,js}']` | File patterns to match                               |
| `recursive`       | `boolean`                                    | `true`                                                               | Search directories recursively                       |
| `loadingStrategy` | `'eager' \| 'lazy' \| 'conditional'`         | `'eager'`                                                            | Module loading strategy                              |
| `watchForChanges` | `boolean`                                    | `false`                                                              | Enable file watching for hot reloading (development) |
| `ignorePatterns`  | `string[]`                                   | `['**/*.test.{ts,js}', '**/*.spec.{ts,js}', '**/node_modules/**']`   | Patterns to ignore during discovery                  |
| `loadOrder`       | `'alphabetical' \| 'dependency' \| 'custom'` | `'dependency'`                                                       | Module loading order strategy                        |
| `failOnError`     | `boolean`                                    | `false`                                                              | Throw error if module discovery fails                |
| `maxDepth`        | `number`                                     | `5`                                                                  | Maximum directory depth to search                    |

**Loading Strategies:**

- **`eager`**: Load all modules immediately during app startup
- **`lazy`**: Load modules on first request to their routes
- **`conditional`**: Load modules based on environment or feature flags

**Load Order Strategies:**

- **`alphabetical`**: Load modules in alphabetical order by name
- **`dependency`**: Analyze and resolve module dependencies using topological sort
- **`custom`**: Use custom order specified in module configurations

#### Example

```javascript
{
  modules: {
    cache: {
      enabled: true,
      defaultTtl: 600,
      maxSize: 5000,
      strategy: 'lfu'
    },
    rateLimit: {
      enabled: true,
      defaultRequests: 200,
      defaultWindow: 60000,
      skipSuccessfulRequests: true
    },
    validation: {
      enabled: true,
      stripUnknown: false,
      abortEarly: true
    },
    autoDiscovery: {
      enabled: true,
      paths: ['./modules', './src/modules', './app/modules'],
      patterns: ['**/*.module.{ts,js}', '**/index.{ts,js}'],
      loadingStrategy: 'eager',
      watchForChanges: false, // Set to true in development
      ignorePatterns: ['**/*.test.{ts,js}', '**/node_modules/**'],
      loadOrder: 'dependency',
      failOnError: false,
      maxDepth: 5
    }
  }
}
```

#### Environment Variables

- `CACHE_ENABLED` or `MORO_CACHE_ENABLED`
- `DEFAULT_CACHE_TTL` or `MORO_CACHE_TTL`
- `CACHE_MAX_SIZE` or `MORO_CACHE_SIZE`
- `CACHE_STRATEGY` or `MORO_CACHE_STRATEGY`
- `RATE_LIMIT_ENABLED` or `MORO_RATE_LIMIT_ENABLED`
- `DEFAULT_RATE_LIMIT_REQUESTS` or `MORO_RATE_LIMIT_REQUESTS`
- `DEFAULT_RATE_LIMIT_WINDOW` or `MORO_RATE_LIMIT_WINDOW`
- `VALIDATION_ENABLED` or `MORO_VALIDATION_ENABLED`
- `AUTO_DISCOVERY_ENABLED` or `MORO_AUTO_DISCOVERY_ENABLED`
- `AUTO_DISCOVERY_PATHS` or `MORO_AUTO_DISCOVERY_PATHS` (comma-separated)
- `AUTO_DISCOVERY_PATTERNS` or `MORO_AUTO_DISCOVERY_PATTERNS` (comma-separated)
- `AUTO_DISCOVERY_LOADING_STRATEGY` or `MORO_AUTO_DISCOVERY_LOADING_STRATEGY`
- `AUTO_DISCOVERY_WATCH_FOR_CHANGES` or `MORO_AUTO_DISCOVERY_WATCH_FOR_CHANGES`
- `AUTO_DISCOVERY_LOAD_ORDER` or `MORO_AUTO_DISCOVERY_LOAD_ORDER`
- `AUTO_DISCOVERY_FAIL_ON_ERROR` or `MORO_AUTO_DISCOVERY_FAIL_ON_ERROR`
- `AUTO_DISCOVERY_MAX_DEPTH` or `MORO_AUTO_DISCOVERY_MAX_DEPTH`

## Auto-Discovery Configuration

MoroJS includes a powerful auto-discovery system that automatically finds and loads modules from your filesystem. This system supports multiple loading strategies, dependency resolution, and hot reloading for development.

### Basic Usage

```javascript
// Primary method - nested under modules
const app = createApp({
  modules: {
    autoDiscovery: {
      enabled: true,
      paths: ['./modules', './src/modules'],
      loadingStrategy: 'lazy',
      watchForChanges: true, // Development only
    },
  },
});

// Shorthand convenience method
const app = createApp({
  autoDiscover: true, // Use defaults
});

// Shorthand with options
const app = createApp({
  autoDiscover: {
    enabled: true,
    paths: ['./modules', './src/modules'],
    loadingStrategy: 'lazy',
  },
});
```

### Legacy Compatibility

```javascript
// Legacy modulesPath (still supported)
const app = createApp({
  modulesPath: './modules', // Equivalent to autoDiscover.paths: ['./modules']
});
```

### Loading Strategies

#### Eager Loading (Default)

All modules are loaded immediately during application startup.

```javascript
{
  autoDiscover: {
    loadingStrategy: 'eager';
  }
}
```

#### Lazy Loading

Modules are loaded on first request to their routes.

```javascript
{
  autoDiscover: {
    loadingStrategy: 'lazy';
  }
}
```

#### Conditional Loading

Modules are loaded based on environment or feature flags.

```javascript
{
  autoDiscover: {
    loadingStrategy: 'conditional';
  }
}
```

### Development Features

#### Hot Reloading

Enable file watching for automatic module reloading during development:

```javascript
const app = createApp({
  modules: {
    autoDiscovery: {
      watchForChanges: process.env.NODE_ENV === 'development',
      loadingStrategy: 'eager',
    },
  },
});
```

#### Custom Patterns

Configure custom file patterns for different project structures:

```javascript
const app = createApp({
  modules: {
    autoDiscovery: {
      patterns: ['**/*.module.{ts,js}', '**/modules/*.{ts,js}', '**/*-module.{ts,js}'],
      ignorePatterns: [
        '**/*.test.{ts,js}',
        '**/*.spec.{ts,js}',
        '**/node_modules/**',
        '**/dist/**',
      ],
    },
  },
});
```

### Dependency Resolution

The auto-discovery system can automatically resolve and order module dependencies:

```javascript
const app = createApp({
  modules: {
    autoDiscovery: {
      loadOrder: 'dependency', // Automatic topological sort
      failOnError: false, // Graceful degradation
    },
  },
});
```

### Production Configuration

Optimized settings for production environments:

```javascript
const app = createApp({
  modules: {
    autoDiscovery: {
      enabled: true,
      paths: ['./dist/modules'],
      patterns: ['**/*.module.js'],
      loadingStrategy: 'eager',
      watchForChanges: false,
      loadOrder: 'dependency',
      failOnError: true,
      maxDepth: 3,
    },
  },
});
```

## Logging Configuration

### `logging` Section

Configure the logging system.

| Property          | Type                                                | Default    | Description                         |
| ----------------- | --------------------------------------------------- | ---------- | ----------------------------------- |
| `level`           | `'debug' \| 'info' \| 'warn' \| 'error' \| 'fatal'` | `'info'`   | Minimum log level                   |
| `format`          | `'pretty' \| 'json' \| 'compact'`                   | `'pretty'` | Log output format                   |
| `enableColors`    | `boolean`                                           | `true`     | Enable colored log output           |
| `enableTimestamp` | `boolean`                                           | `true`     | Include timestamp in logs           |
| `enableContext`   | `boolean`                                           | `true`     | Include context information in logs |
| `outputs`         | `object`                                            | -          | Output configuration                |

#### Output Configuration

##### Console Output

| Property  | Type      | Default | Description           |
| --------- | --------- | ------- | --------------------- |
| `console` | `boolean` | `true`  | Enable console output |

##### File Output

| Property   | Type      | Default             | Description                 |
| ---------- | --------- | ------------------- | --------------------------- |
| `enabled`  | `boolean` | `false`             | Enable file logging         |
| `path`     | `string`  | `'./logs/moro.log'` | Log file path               |
| `maxSize`  | `string`  | `'10MB'`            | Maximum file size           |
| `maxFiles` | `number`  | `5`                 | Maximum number of log files |

##### Webhook Output

| Property  | Type                     | Default | Description              |
| --------- | ------------------------ | ------- | ------------------------ |
| `enabled` | `boolean`                | `false` | Enable webhook logging   |
| `url`     | `string`                 | -       | Webhook URL              |
| `headers` | `Record<string, string>` | `{}`    | HTTP headers for webhook |

#### Example

```javascript
{
  logging: {
    level: 'debug',
    format: 'json',
    enableColors: false,
    enableTimestamp: true,
    enableContext: true,
    outputs: {
      console: true,
      file: {
        enabled: true,
        path: '/var/log/myapp/app.log',
        maxSize: '50MB',
        maxFiles: 10
      },
      webhook: {
        enabled: true,
        url: 'https://logging.service.com/webhook',
        headers: {
          'Authorization': 'Bearer token123',
          'Content-Type': 'application/json'
        }
      }
    }
  }
}
```

#### Environment Variables

- `LOG_LEVEL` or `MORO_LOG_LEVEL`
- `LOG_FORMAT` or `MORO_LOG_FORMAT`
- `NO_COLOR` (disables colors if set)
- `LOG_COLORS` (set to 'false' to disable)
- `LOG_TIMESTAMP` (set to 'false' to disable)
- `LOG_CONTEXT` (set to 'false' to disable)
- `LOG_FILE_ENABLED` or `MORO_LOG_FILE`
- `LOG_FILE_PATH` or `MORO_LOG_PATH`
- `LOG_WEBHOOK_ENABLED` or `MORO_LOG_WEBHOOK`
- `LOG_WEBHOOK_URL` or `MORO_LOG_WEBHOOK_URL`

## Security Configuration

### `security` Section

Configure security features.

#### CORS Configuration

| Property            | Type                            | Default                                                | Description                                               |
| ------------------- | ------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `enabled`           | `boolean`                       | `true`                                                 | Enable CORS                                               |
| `origin`            | `string \| string[] \| boolean` | `'*'`                                                  | Allowed origins                                           |
| `methods`           | `string[]`                      | `['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']` | Allowed methods                                           |
| `allowedHeaders`    | `string[]`                      | `['Content-Type', 'Authorization']`                    | Allowed headers                                           |
| `credentials`       | `boolean`                       | `false`                                                | Allow credentials                                         |
| `maxAge`            | `number`                        | -                                                      | Preflight cache duration (seconds)                        |
| `exposedHeaders`    | `string[]`                      | -                                                      | Headers exposed to client                                 |
| `preflightContinue` | `boolean`                       | `false`                                                | Pass OPTIONS to route handlers instead of auto-responding |

**Automatic Preflight Handling:**

MoroJS automatically handles OPTIONS preflight requests by responding with `204 No Content` and appropriate CORS headers. Set `preflightContinue: true` to handle OPTIONS in your route handlers instead.

#### Helmet Configuration

| Property                | Type      | Default | Description                    |
| ----------------------- | --------- | ------- | ------------------------------ |
| `enabled`               | `boolean` | `true`  | Enable Helmet security headers |
| `contentSecurityPolicy` | `boolean` | `true`  | Enable CSP                     |
| `hsts`                  | `boolean` | `true`  | Enable HSTS                    |
| `noSniff`               | `boolean` | `true`  | Enable X-Content-Type-Options  |
| `frameguard`            | `boolean` | `true`  | Enable X-Frame-Options         |

#### Global Rate Limiting

| Property   | Type      | Default | Description                     |
| ---------- | --------- | ------- | ------------------------------- |
| `enabled`  | `boolean` | `false` | Enable global rate limiting     |
| `requests` | `number`  | `1000`  | Requests per window             |
| `window`   | `number`  | `60000` | Window duration in milliseconds |

#### Example

```javascript
{
  security: {
    cors: {
      enabled: true,
      origin: ['https://myapp.com', 'https://admin.myapp.com'],
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      credentials: true,
      maxAge: 86400 // 24 hours
    },
    helmet: {
      enabled: true,
      contentSecurityPolicy: true,
      hsts: true,
      noSniff: true,
      frameguard: true
    },
    rateLimit: {
      global: {
        enabled: true,
        requests: 5000,
        window: 60000
      }
    }
  }
}
```

**Dynamic Origin Validation:**

The `origin` option also supports functions for dynamic validation (programmatic only, not in config files):

```javascript
// In your application code (not config file)
app.use(
  middleware.cors({
    origin: async (requestOrigin, req) => {
      // Check database or perform custom validation
      const allowed = await db.origins.isAllowed(requestOrigin);
      return allowed ? requestOrigin : false;
    },
    credentials: true,
  })
);
```

#### Environment Variables

- `CORS_ENABLED` (default true)
- `CORS_ORIGIN` or `MORO_CORS_ORIGIN`
- `CORS_METHODS` or `MORO_CORS_METHODS`
- `CORS_HEADERS` or `MORO_CORS_HEADERS`
- `CORS_CREDENTIALS`
- `HELMET_ENABLED` (default true)
- `GLOBAL_RATE_LIMIT_ENABLED`
- `GLOBAL_RATE_LIMIT_REQUESTS` or `MORO_GLOBAL_RATE_REQUESTS`

## External Services

### `external` Section

Configure third-party service integrations.

#### Stripe Configuration

| Property         | Type     | Default        | Description            |
| ---------------- | -------- | -------------- | ---------------------- |
| `secretKey`      | `string` | -              | Stripe secret key      |
| `publishableKey` | `string` | -              | Stripe publishable key |
| `webhookSecret`  | `string` | -              | Stripe webhook secret  |
| `apiVersion`     | `string` | `'2023-10-16'` | Stripe API version     |

#### PayPal Configuration

| Property       | Type                        | Default     | Description          |
| -------------- | --------------------------- | ----------- | -------------------- |
| `clientId`     | `string`                    | -           | PayPal client ID     |
| `clientSecret` | `string`                    | -           | PayPal client secret |
| `webhookId`    | `string`                    | -           | PayPal webhook ID    |
| `environment`  | `'sandbox' \| 'production'` | `'sandbox'` | PayPal environment   |

#### SMTP Configuration

| Property   | Type      | Default | Description      |
| ---------- | --------- | ------- | ---------------- |
| `host`     | `string`  | -       | SMTP server host |
| `port`     | `number`  | `587`   | SMTP server port |
| `secure`   | `boolean` | `false` | Use SSL/TLS      |
| `username` | `string`  | -       | SMTP username    |
| `password` | `string`  | -       | SMTP password    |

#### Example

```javascript
{
  external: {
    stripe: {
      secretKey: 'sk_live_...',
      publishableKey: 'pk_live_...',
      webhookSecret: 'whsec_...',
      apiVersion: '2023-10-16'
    },
    paypal: {
      clientId: 'your-paypal-client-id',
      clientSecret: 'your-paypal-client-secret',
      environment: 'production'
    },
    smtp: {
      host: 'smtp.mailgun.org',
      port: 587,
      secure: false,
      username: 'postmaster@mg.yourdomain.com',
      password: 'your-smtp-password'
    }
  }
}
```

#### Environment Variables

- `STRIPE_SECRET_KEY` or `MORO_STRIPE_SECRET`
- `STRIPE_PUBLISHABLE_KEY` or `MORO_STRIPE_PUBLIC`
- `STRIPE_WEBHOOK_SECRET` or `MORO_STRIPE_WEBHOOK`
- `STRIPE_API_VERSION` or `MORO_STRIPE_VERSION`
- `PAYPAL_CLIENT_ID` or `MORO_PAYPAL_CLIENT`
- `PAYPAL_CLIENT_SECRET` or `MORO_PAYPAL_SECRET`
- `PAYPAL_ENVIRONMENT` or `MORO_PAYPAL_ENV`
- `SMTP_HOST` or `MORO_SMTP_HOST`
- `SMTP_PORT` or `MORO_SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USERNAME` or `MORO_SMTP_USER`
- `SMTP_PASSWORD` or `MORO_SMTP_PASS`

## Performance Configuration

### `performance` Section

Configure performance optimizations.

#### Compression

| Property    | Type      | Default | Description                 |
| ----------- | --------- | ------- | --------------------------- |
| `enabled`   | `boolean` | `true`  | Enable response compression |
| `level`     | `number`  | `6`     | Compression level (1-9)     |
| `threshold` | `number`  | `1024`  | Minimum bytes to compress   |

#### Circuit Breaker

| Property           | Type      | Default | Description                       |
| ------------------ | --------- | ------- | --------------------------------- |
| `enabled`          | `boolean` | `true`  | Enable circuit breaker            |
| `failureThreshold` | `number`  | `5`     | Number of failures before opening |
| `resetTimeout`     | `number`  | `60000` | Time before attempting reset      |
| `monitoringPeriod` | `number`  | `10000` | Monitoring period in milliseconds |

#### Clustering

| Property            | Type      | Default     | Description                                                           |
| ------------------- | --------- | ----------- | --------------------------------------------------------------------- |
| `enabled`           | `boolean` | `false`     | Enable clustering                                                     |
| `workers`           | `number`  | `1`         | Number of worker processes                                            |
| `memoryPerWorkerGB` | `number`  | `undefined` | Memory allocation per worker in GB (auto-calculated if not specified) |

**Note:** When `memoryPerWorkerGB` is not specified, MoroJS automatically calculates the optimal memory allocation per worker based on available system memory and CPU count, leaving headroom for the main process.

#### Example

```javascript
{
  performance: {
    compression: {
      enabled: true,
      level: 9,
      threshold: 512
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 10,
      resetTimeout: 30000,
      monitoringPeriod: 5000
    },
    clustering: {
      enabled: true,
      workers: 4,
      memoryPerWorkerGB: 2
    }
  }
}
```

#### Environment Variables

- `COMPRESSION_ENABLED` (default true)
- `COMPRESSION_LEVEL` or `MORO_COMPRESSION_LEVEL`
- `COMPRESSION_THRESHOLD` or `MORO_COMPRESSION_THRESHOLD`
- `CIRCUIT_BREAKER_ENABLED` (default true)
- `CIRCUIT_BREAKER_THRESHOLD` or `MORO_CB_THRESHOLD`
- `CLUSTERING_ENABLED`
- `CLUSTER_WORKERS` or `MORO_WORKERS`
- `MEMORY_PER_WORKER_GB` or `MORO_MEMORY_PER_WORKER_GB`

## Authentication Configuration

### Auth.js Integration

MoroJS includes built-in Auth.js integration for comprehensive authentication.

#### Basic Configuration

```javascript
import { auth, providers } from '@morojs/auth';

// In your moro.config.js
export default {
  middleware: [
    auth({
      providers: [
        providers.google({
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        }),
        providers.github({
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        }),
        providers.email({
          server: {
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS,
            },
          },
          from: process.env.EMAIL_FROM,
        }),
      ],
      secret: process.env.AUTH_SECRET,
      session: {
        strategy: 'jwt',
        maxAge: 30 * 24 * 60 * 60, // 30 days
      },
    }),
  ],
};
```

#### OAuth Provider Configuration

| Property        | Type                                            | Description            |
| --------------- | ----------------------------------------------- | ---------------------- |
| `id`            | `string`                                        | Provider identifier    |
| `name`          | `string`                                        | Display name           |
| `type`          | `'oauth' \| 'oidc' \| 'credentials' \| 'email'` | Provider type          |
| `clientId`      | `string`                                        | OAuth client ID        |
| `clientSecret`  | `string`                                        | OAuth client secret    |
| `authorization` | `string \| object`                              | Authorization endpoint |
| `token`         | `string \| object`                              | Token endpoint         |
| `userinfo`      | `string \| object`                              | User info endpoint     |
| `scope`         | `string`                                        | OAuth scopes           |

#### Session Configuration

| Property    | Type                  | Default   | Description                   |
| ----------- | --------------------- | --------- | ----------------------------- |
| `strategy`  | `'jwt' \| 'database'` | `'jwt'`   | Session strategy              |
| `maxAge`    | `number`              | `2592000` | Session max age in seconds    |
| `updateAge` | `number`              | `86400`   | Session update age in seconds |

#### JWT Configuration

| Property | Type     | Default   | Description            |
| -------- | -------- | --------- | ---------------------- |
| `secret` | `string` | -         | JWT signing secret     |
| `maxAge` | `number` | `2592000` | JWT max age in seconds |

#### Pages Configuration

| Property        | Type     | Description                |
| --------------- | -------- | -------------------------- |
| `signIn`        | `string` | Custom sign-in page path   |
| `signOut`       | `string` | Custom sign-out page path  |
| `error`         | `string` | Custom error page path     |
| `verifyRequest` | `string` | Custom verify request page |

#### Environment Variables

- `AUTH_SECRET` or `NEXTAUTH_SECRET`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`

## Session Configuration

### Session Middleware

Configure session management with various storage backends.

```javascript
import { session } from '@morojs/session';

// In your middleware array
session({
  store: 'redis', // 'memory', 'redis', 'file'
  storeOptions: {
    host: 'localhost',
    port: 6379,
    keyPrefix: 'sess:',
  },
  secret: 'your-session-secret',
  name: 'sessionId',
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
  rolling: false,
  resave: false,
  saveUninitialized: false,
});
```

#### Session Options

| Property            | Type                                            | Default                 | Description                        |
| ------------------- | ----------------------------------------------- | ----------------------- | ---------------------------------- |
| `store`             | `'memory' \| 'redis' \| 'file' \| CacheAdapter` | `'memory'`              | Session store type                 |
| `secret`            | `string`                                        | `'moro-session-secret'` | Session signing secret             |
| `name`              | `string`                                        | `'connect.sid'`         | Session cookie name                |
| `rolling`           | `boolean`                                       | `false`                 | Reset expiry on each request       |
| `resave`            | `boolean`                                       | `false`                 | Save session even if not modified  |
| `saveUninitialized` | `boolean`                                       | `false`                 | Save new but not modified sessions |

#### Cookie Configuration

| Property   | Type                          | Default    | Description                     |
| ---------- | ----------------------------- | ---------- | ------------------------------- |
| `maxAge`   | `number`                      | `86400000` | Session timeout in milliseconds |
| `httpOnly` | `boolean`                     | `true`     | Prevent XSS access              |
| `secure`   | `boolean`                     | `false`    | HTTPS only                      |
| `sameSite` | `'strict' \| 'lax' \| 'none'` | `'lax'`    | SameSite policy                 |
| `domain`   | `string`                      | -          | Cookie domain                   |
| `path`     | `string`                      | `'/'`      | Cookie path                     |

## Cache Configuration

### Cache Middleware

Configure caching with multiple adapters and strategies.

```javascript
import { cache } from '@morojs/cache';

// In your middleware array
cache({
  adapter: 'redis', // 'memory', 'redis', 'file'
  adapterOptions: {
    host: 'localhost',
    port: 6379,
  },
  defaultTtl: 300,
  keyPrefix: 'cache:',
  strategies: {
    '/api/users/*': {
      key: req => `users:${req.params.id}`,
      ttl: 600,
      condition: (req, res) => res.statusCode === 200,
    },
    '/api/posts': {
      key: 'posts:list',
      ttl: 300,
      invalidateOn: ['POST:/api/posts', 'PUT:/api/posts/*'],
    },
  },
  vary: ['Accept-Encoding', 'Accept-Language'],
  etag: 'strong',
});
```

#### Cache Options

| Property               | Type                            | Default    | Description                      |
| ---------------------- | ------------------------------- | ---------- | -------------------------------- |
| `adapter`              | `string \| CacheAdapter`        | `'memory'` | Cache adapter                    |
| `defaultTtl`           | `number`                        | `300`      | Default TTL in seconds           |
| `keyPrefix`            | `string`                        | `''`       | Key prefix for all cache entries |
| `maxAge`               | `number`                        | -          | HTTP Cache-Control max-age       |
| `staleWhileRevalidate` | `number`                        | -          | Stale-while-revalidate seconds   |
| `vary`                 | `string[]`                      | -          | HTTP Vary headers                |
| `etag`                 | `boolean \| 'weak' \| 'strong'` | -          | ETag generation                  |

#### Cache Strategies

| Property       | Type       | Description                         |
| -------------- | ---------- | ----------------------------------- |
| `key`          | `function` | Function to generate cache key      |
| `ttl`          | `number`   | TTL for this strategy               |
| `condition`    | `function` | Condition for caching               |
| `invalidateOn` | `string[]` | Patterns that invalidate this cache |

## CDN Configuration

### CDN Integration

Configure CDN integration for asset delivery and cache invalidation.

```javascript
import { cdn } from '@morojs/cdn';

// In your middleware array
cdn({
  adapter: 'cloudflare', // 'cloudflare', 'aws', 'custom'
  adapterOptions: {
    zoneId: 'your-zone-id',
    apiToken: 'your-api-token',
  },
  autoInvalidate: true,
  invalidationPatterns: ['/static/*', '/api/v*/data'],
});
```

#### CDN Options

| Property               | Type                   | Description                        |
| ---------------------- | ---------------------- | ---------------------------------- |
| `adapter`              | `string \| CDNAdapter` | CDN adapter                        |
| `adapterOptions`       | `object`               | Adapter-specific options           |
| `autoInvalidate`       | `boolean`              | Auto-invalidate on content changes |
| `invalidationPatterns` | `string[]`             | URL patterns to invalidate         |

## Runtime Configuration

### Multi-Runtime Support

Configure MoroJS to run on different runtime environments.

```javascript
// moro.config.js
export default {
  runtime: {
    type: 'node', // 'node', 'vercel-edge', 'aws-lambda', 'cloudflare-workers'
    options: {
      // Runtime-specific options
    },
  },
};
```

#### Runtime Types

| Type                   | Description              | Use Case                        |
| ---------------------- | ------------------------ | ------------------------------- |
| `'node'`               | Standard Node.js runtime | Traditional servers, containers |
| `'vercel-edge'`        | Vercel Edge Runtime      | Edge functions, serverless      |
| `'aws-lambda'`         | AWS Lambda runtime       | Serverless functions            |
| `'cloudflare-workers'` | Cloudflare Workers       | Edge computing                  |

#### MoroOptions (Legacy)

| Property       | Type                       | Description                       |
| -------------- | -------------------------- | --------------------------------- |
| `autoDiscover` | `boolean`                  | Enable automatic module discovery |
| `modulesPath`  | `string`                   | Path to modules directory         |
| `middleware`   | `any[]`                    | Middleware array                  |
| `database`     | `any`                      | Database configuration            |
| `cors`         | `boolean \| object`        | CORS configuration                |
| `compression`  | `boolean \| object`        | Compression configuration         |
| `helmet`       | `boolean \| object`        | Helmet security configuration     |
| `runtime`      | `RuntimeConfig`            | Runtime configuration             |
| `logger`       | `LoggerOptions \| boolean` | Logger configuration              |

## Environment Variables

### Standard Variables

| Variable       | Alternative         | Description             |
| -------------- | ------------------- | ----------------------- |
| `NODE_ENV`     | `MORO_ENV`          | Application environment |
| `PORT`         | `MORO_PORT`         | Server port             |
| `HOST`         | `MORO_HOST`         | Server host             |
| `DATABASE_URL` | `MORO_DATABASE_URL` | Primary database URL    |
| `REDIS_URL`    | `MORO_REDIS_URL`    | Redis connection URL    |
| `LOG_LEVEL`    | `MORO_LOG_LEVEL`    | Logging level           |

### Authentication Variables

| Variable               | Description                    |
| ---------------------- | ------------------------------ |
| `AUTH_SECRET`          | Authentication secret          |
| `NEXTAUTH_SECRET`      | Next.js Auth compatible secret |
| `GOOGLE_CLIENT_ID`     | Google OAuth client ID         |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret     |
| `GITHUB_CLIENT_ID`     | GitHub OAuth client ID         |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret     |

### External Service Variables

| Variable                 | Description            |
| ------------------------ | ---------------------- |
| `STRIPE_SECRET_KEY`      | Stripe secret key      |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `PAYPAL_CLIENT_ID`       | PayPal client ID       |
| `SMTP_HOST`              | SMTP server host       |
| `SMTP_PORT`              | SMTP server port       |
| `SMTP_USER`              | SMTP username          |
| `SMTP_PASS`              | SMTP password          |

### Prefixed Variables

All configuration options can also be set using `MORO_` prefixed environment variables:

- `MORO_PORT` instead of `PORT`
- `MORO_LOG_LEVEL` instead of `LOG_LEVEL`
- `MORO_CACHE_ENABLED` instead of `CACHE_ENABLED`

## Configuration Validation

MoroJS uses Zod for configuration validation. Invalid configurations will result in detailed error messages:

```bash
❌ Configuration validation failed
Configuration errors:
  - server.port: Expected number, received string
    Hint: PORT must be a number between 1 and 65535
  - database.redis.url: Invalid url
    Hint: URLs must include protocol (http:// or https://)
```

## Best Practices

1. **Use environment variables** for secrets and environment-specific values
2. **Use configuration files** for structure and defaults
3. **Validate early** - let MoroJS validate your config on startup
4. **Use type safety** with TypeScript configuration files
5. **Document your config** - especially custom middleware options
6. **Separate concerns** - different configs for different environments
7. **Use prefixed variables** (`MORO_*`) to avoid conflicts

## Example Complete Configuration

```javascript
// moro.config.js
module.exports = {
  server: {
    port: process.env.PORT || 3001,
    host: '0.0.0.0',
    maxConnections: 5000,
    timeout: 30000,
  },

  database: {
    url: process.env.DATABASE_URL,
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      keyPrefix: 'myapp:',
    },
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: 'json',
    outputs: {
      console: true,
      file: {
        enabled: process.env.NODE_ENV === 'production',
        path: './logs/app.log',
      },
    },
  },

  security: {
    cors: {
      origin: process.env.CORS_ORIGIN?.split(',') || '*',
      credentials: true,
    },
    helmet: {
      enabled: true,
    },
  },

  external: {
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    },
  },

  performance: {
    compression: {
      enabled: true,
      level: 6,
    },
    clustering: {
      enabled: process.env.NODE_ENV === 'production',
      workers: require('os').cpus().length,
      memoryPerWorkerGB: 1.5,
    },
  },
};
```

This configuration provides a production-ready setup with proper environment variable usage, security configurations, and performance optimizations.
