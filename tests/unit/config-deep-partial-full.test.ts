// Comprehensive test for DeepPartial configuration type
import type { AppConfig, DeepPartial } from '../../src/index.js';

describe('DeepPartial Configuration Type - Comprehensive Tests', () => {
  describe('Basic Partial Configuration', () => {
    it('should allow partial server configuration', () => {
      const config: DeepPartial<AppConfig> = {
        server: {
          port: 3000,
        },
      };

      expect(config.server?.port).toBe(3000);
    });

    it('should allow partial database configuration', () => {
      const config: DeepPartial<AppConfig> = {
        database: {
          url: 'postgresql://localhost:5432/testdb',
        },
      };

      expect(config.database?.url).toBe('postgresql://localhost:5432/testdb');
    });

    it('should allow partial logging configuration', () => {
      const config: DeepPartial<AppConfig> = {
        logging: {
          level: 'debug',
          format: 'json',
        },
      };

      expect(config.logging?.level).toBe('debug');
      expect(config.logging?.format).toBe('json');
    });
  });

  describe('Nested Partial Configuration', () => {
    it('should allow partial nested database.redis configuration', () => {
      const config: DeepPartial<AppConfig> = {
        database: {
          redis: {
            url: 'redis://localhost:6379',
            // Don't need maxRetries, retryDelay, keyPrefix
          },
        },
      };

      expect(config.database?.redis?.url).toBe('redis://localhost:6379');
    });

    it('should allow partial nested database.postgresql configuration', () => {
      const config: DeepPartial<AppConfig> = {
        database: {
          postgresql: {
            host: 'localhost',
            port: 5432,
            database: 'myapp',
            // Don't need connectionLimit, ssl
          },
        },
      };

      expect(config.database?.postgresql?.host).toBe('localhost');
      expect(config.database?.postgresql?.port).toBe(5432);
    });

    it('should allow partial nested database.mysql configuration', () => {
      const config: DeepPartial<AppConfig> = {
        database: {
          mysql: {
            host: 'localhost',
            port: 3306,
            // Don't need all properties
          },
        },
      };

      expect(config.database?.mysql?.host).toBe('localhost');
    });

    it('should allow partial nested database.mongodb configuration', () => {
      const config: DeepPartial<AppConfig> = {
        database: {
          mongodb: {
            url: 'mongodb://localhost:27017',
            // Don't need host, port, database, etc.
          },
        },
      };

      expect(config.database?.mongodb?.url).toBe('mongodb://localhost:27017');
    });

    it('should allow partial nested database.sqlite configuration', () => {
      const config: DeepPartial<AppConfig> = {
        database: {
          sqlite: {
            filename: './dev.db',
            // Don't need memory, verbose
          },
        },
      };

      expect(config.database?.sqlite?.filename).toBe('./dev.db');
    });
  });

  describe('Deeply Nested Configuration', () => {
    it('should allow partial nested server.ssl configuration', () => {
      const config: DeepPartial<AppConfig> = {
        server: {
          port: 3000,
          ssl: {
            key_file_name: '/path/to/key.pem',
            cert_file_name: '/path/to/cert.pem',
            // Don't need passphrase
          },
        },
      };

      expect(config.server?.ssl?.key_file_name).toBe('/path/to/key.pem');
    });

    it('should allow partial nested modules.session configuration', () => {
      const config: DeepPartial<AppConfig> = {
        modules: {
          session: {
            enabled: true,
            store: 'memory',
            secret: 'my-secret',
            // Don't need all session properties
          },
        },
      };

      expect(config.modules?.session?.enabled).toBe(true);
      expect(config.modules?.session?.store).toBe('memory');
    });

    it('should allow partial nested modules.session.cookie configuration', () => {
      const config: DeepPartial<AppConfig> = {
        modules: {
          session: {
            enabled: true,
            store: 'memory',
            cookie: {
              maxAge: 86400000,
              httpOnly: true,
              secure: true,
              // Don't need sameSite, domain, path
            },
          },
        },
      };

      expect(config.modules?.session?.cookie?.maxAge).toBe(86400000);
      expect(config.modules?.session?.cookie?.httpOnly).toBe(true);
    });

    it('should allow partial nested modules.session.storeOptions configuration', () => {
      const config: DeepPartial<AppConfig> = {
        modules: {
          session: {
            enabled: true,
            store: 'redis',
            storeOptions: {
              host: 'localhost',
              port: 6379,
              // Don't need password, keyPrefix, path, max
            },
          },
        },
      };

      expect(config.modules?.session?.storeOptions?.host).toBe('localhost');
    });
  });

  describe('Security Configuration', () => {
    it('should allow partial security.cors configuration', () => {
      const config: DeepPartial<AppConfig> = {
        security: {
          cors: {
            enabled: true,
            origin: '*',
            // Don't need methods, allowedHeaders, etc.
          },
        },
      };

      expect(config.security?.cors?.enabled).toBe(true);
      expect(config.security?.cors?.origin).toBe('*');
    });

    it('should allow partial security.helmet configuration', () => {
      const config: DeepPartial<AppConfig> = {
        security: {
          helmet: {
            enabled: true,
            contentSecurityPolicy: true,
            // Don't need all helmet options
          },
        },
      };

      expect(config.security?.helmet?.enabled).toBe(true);
    });

    it('should allow partial security.csrf configuration', () => {
      const config: DeepPartial<AppConfig> = {
        security: {
          csrf: {
            enabled: true,
            secret: 'my-csrf-secret',
            // Don't need tokenLength, cookieName, etc.
          },
        },
      };

      expect(config.security?.csrf?.enabled).toBe(true);
    });

    it('should allow partial security.csp configuration', () => {
      const config: DeepPartial<AppConfig> = {
        security: {
          csp: {
            enabled: true,
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              // Don't need all directives
            },
          },
        },
      };

      expect(config.security?.csp?.enabled).toBe(true);
      expect(config.security?.csp?.directives?.defaultSrc).toEqual(["'self'"]);
    });

    it('should allow partial security.rateLimit configuration', () => {
      const config: DeepPartial<AppConfig> = {
        security: {
          rateLimit: {
            global: {
              enabled: true,
              requests: 100,
              window: 60000,
            },
          },
        },
      };

      expect(config.security?.rateLimit?.global?.enabled).toBe(true);
    });
  });

  describe('Performance Configuration', () => {
    it('should allow partial performance.compression configuration', () => {
      const config: DeepPartial<AppConfig> = {
        performance: {
          compression: {
            enabled: true,
            level: 6,
            // Don't need threshold
          },
        },
      };

      expect(config.performance?.compression?.enabled).toBe(true);
      expect(config.performance?.compression?.level).toBe(6);
    });

    it('should allow partial performance.circuitBreaker configuration', () => {
      const config: DeepPartial<AppConfig> = {
        performance: {
          circuitBreaker: {
            enabled: true,
            failureThreshold: 5,
            // Don't need resetTimeout, monitoringPeriod
          },
        },
      };

      expect(config.performance?.circuitBreaker?.enabled).toBe(true);
    });

    it('should allow partial performance.clustering configuration', () => {
      const config: DeepPartial<AppConfig> = {
        performance: {
          clustering: {
            enabled: true,
            workers: 4,
            // Don't need memoryPerWorkerGB
          },
        },
      };

      expect(config.performance?.clustering?.workers).toBe(4);
    });
  });

  describe('Module Defaults Configuration', () => {
    it('should allow partial modules.cache configuration', () => {
      const config: DeepPartial<AppConfig> = {
        modules: {
          cache: {
            enabled: true,
            defaultTtl: 300,
            // Don't need maxSize, strategy
          },
        },
      };

      expect(config.modules?.cache?.enabled).toBe(true);
      expect(config.modules?.cache?.defaultTtl).toBe(300);
    });

    it('should allow partial modules.rateLimit configuration', () => {
      const config: DeepPartial<AppConfig> = {
        modules: {
          rateLimit: {
            enabled: true,
            defaultRequests: 100,
            // Don't need defaultWindow, skipSuccessfulRequests, etc.
          },
        },
      };

      expect(config.modules?.rateLimit?.enabled).toBe(true);
    });

    it('should allow partial modules.validation configuration', () => {
      const config: DeepPartial<AppConfig> = {
        modules: {
          validation: {
            enabled: true,
            stripUnknown: true,
            // Don't need abortEarly
          },
        },
      };

      expect(config.modules?.validation?.enabled).toBe(true);
    });

    it('should allow partial modules.autoDiscovery configuration', () => {
      const config: DeepPartial<AppConfig> = {
        modules: {
          autoDiscovery: {
            enabled: true,
            paths: ['./modules', './src/modules'],
            // Don't need patterns, recursive, etc.
          },
        },
      };

      expect(config.modules?.autoDiscovery?.enabled).toBe(true);
      expect(config.modules?.autoDiscovery?.paths).toHaveLength(2);
    });
  });

  describe('Logging Configuration', () => {
    it('should allow partial logging.outputs configuration', () => {
      const config: DeepPartial<AppConfig> = {
        logging: {
          level: 'info',
          outputs: {
            console: true,
            file: {
              enabled: true,
              path: './logs/app.log',
              // Don't need maxSize, maxFiles
            },
          },
        },
      };

      expect(config.logging?.outputs?.console).toBe(true);
      expect(config.logging?.outputs?.file?.enabled).toBe(true);
    });

    it('should allow partial logging.outputs.webhook configuration', () => {
      const config: DeepPartial<AppConfig> = {
        logging: {
          outputs: {
            webhook: {
              enabled: true,
              url: 'https://example.com/webhook',
              // Don't need headers
            },
          },
        },
      };

      expect(config.logging?.outputs?.webhook?.enabled).toBe(true);
    });
  });

  describe('WebSocket Configuration', () => {
    it('should allow partial websocket configuration', () => {
      const config: DeepPartial<AppConfig> = {
        websocket: {
          enabled: true,
          adapter: 'socket.io',
          // Don't need compression, customIdGenerator, options
        },
      };

      expect(config.websocket?.enabled).toBe(true);
      expect(config.websocket?.adapter).toBe('socket.io');
    });

    it('should allow partial websocket.options configuration', () => {
      const config: DeepPartial<AppConfig> = {
        websocket: {
          enabled: true,
          options: {
            path: '/ws',
            maxPayloadLength: 16384,
            // Don't need idleTimeout, ssl
          },
        },
      };

      expect(config.websocket?.options?.path).toBe('/ws');
    });

    it('should allow partial websocket.options.cors configuration', () => {
      const config: DeepPartial<AppConfig> = {
        websocket: {
          enabled: true,
          options: {
            cors: {
              origin: 'https://example.com',
              // Don't need credentials
            },
          },
        },
      };

      expect(config.websocket?.options?.cors?.origin).toBe('https://example.com');
    });
  });

  describe('Jobs Configuration', () => {
    it('should allow partial jobs configuration', () => {
      const config: DeepPartial<AppConfig> = {
        jobs: {
          enabled: true,
          maxConcurrentJobs: 5,
          // Don't need gracefulShutdownTimeout, leaderElection, etc.
        },
      };

      expect(config.jobs?.enabled).toBe(true);
      expect(config.jobs?.maxConcurrentJobs).toBe(5);
    });

    it('should allow partial jobs.leaderElection configuration', () => {
      const config: DeepPartial<AppConfig> = {
        jobs: {
          enabled: true,
          leaderElection: {
            enabled: true,
            strategy: 'redis',
            // Don't need lockPath, lockTimeout, heartbeatInterval
          },
        },
      };

      expect(config.jobs?.leaderElection?.enabled).toBe(true);
    });

    it('should allow partial jobs.executor configuration', () => {
      const config: DeepPartial<AppConfig> = {
        jobs: {
          enabled: true,
          executor: {
            maxRetries: 3,
            retryDelay: 1000,
            // Don't need all executor options
          },
        },
      };

      expect(config.jobs?.executor?.maxRetries).toBe(3);
    });

    it('should allow partial jobs.stateManager configuration', () => {
      const config: DeepPartial<AppConfig> = {
        jobs: {
          enabled: true,
          stateManager: {
            persistPath: './jobs-state',
            historySize: 100,
            // Don't need persistInterval, enableAutoPersist, etc.
          },
        },
      };

      expect(config.jobs?.stateManager?.persistPath).toBe('./jobs-state');
    });
  });

  describe('Queue Configuration', () => {
    it('should allow partial queue configuration', () => {
      const config: DeepPartial<AppConfig> = {
        queue: {
          adapter: 'bull',
          concurrency: 5,
          // Don't need connection, retry, deadLetterQueue, etc.
        },
      };

      expect(config.queue?.adapter).toBe('bull');
      expect(config.queue?.concurrency).toBe(5);
    });

    it('should allow partial queue.connection configuration', () => {
      const config: DeepPartial<AppConfig> = {
        queue: {
          adapter: 'rabbitmq',
          connection: {
            host: 'localhost',
            port: 5672,
            // Don't need username, password, database, etc.
          },
        },
      };

      expect(config.queue?.connection?.host).toBe('localhost');
    });

    it('should allow partial queue.retry configuration', () => {
      const config: DeepPartial<AppConfig> = {
        queue: {
          retry: {
            maxAttempts: 3,
            backoff: 'exponential',
            initialDelay: 1000,
            // Don't need maxDelay
          },
        },
      };

      expect(config.queue?.retry?.maxAttempts).toBe(3);
    });

    it('should allow partial queue.deadLetterQueue configuration', () => {
      const config: DeepPartial<AppConfig> = {
        queue: {
          deadLetterQueue: {
            enabled: true,
            maxRetries: 5,
            // Don't need queueName
          },
        },
      };

      expect(config.queue?.deadLetterQueue?.enabled).toBe(true);
    });
  });

  describe('External Services Configuration', () => {
    it('should allow partial external.stripe configuration', () => {
      const config: DeepPartial<AppConfig> = {
        external: {
          stripe: {
            secretKey: 'sk_test_123',
            apiVersion: '2023-10-16',
            // Don't need publishableKey, webhookSecret
          },
        },
      };

      expect(config.external?.stripe?.secretKey).toBe('sk_test_123');
    });

    it('should allow partial external.paypal configuration', () => {
      const config: DeepPartial<AppConfig> = {
        external: {
          paypal: {
            clientId: 'paypal-client-id',
            environment: 'sandbox',
            // Don't need clientSecret, webhookId
          },
        },
      };

      expect(config.external?.paypal?.clientId).toBe('paypal-client-id');
    });

    it('should allow partial external.smtp configuration', () => {
      const config: DeepPartial<AppConfig> = {
        external: {
          smtp: {
            host: 'smtp.example.com',
            port: 587,
            // Don't need secure, username, password
          },
        },
      };

      expect(config.external?.smtp?.host).toBe('smtp.example.com');
    });
  });

  describe('Real-World Use Cases', () => {
    it('should work with environment variables', () => {
      const config: DeepPartial<AppConfig> = {
        server: {
          port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
        },
        database: {
          url: process.env.DATABASE_URL,
          redis: process.env.REDIS_URL
            ? {
                url: process.env.REDIS_URL,
              }
            : undefined,
        },
        logging: {
          level: process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
        },
      };

      expect(config).toBeDefined();
      expect(config.server?.port).toBeDefined();
    });

    it('should work with conditional configuration', () => {
      const isProd = process.env.NODE_ENV === 'production';

      const config: DeepPartial<AppConfig> = {
        server: {
          port: isProd ? 8080 : 3000,
        },
        logging: {
          level: isProd ? 'error' : 'debug',
          format: isProd ? 'json' : 'pretty',
        },
        security: {
          cors: {
            enabled: !isProd,
          },
        },
      };

      expect(config).toBeDefined();
    });

    it('should work with multiple database configurations', () => {
      const config: DeepPartial<AppConfig> = {
        database: {
          url: 'postgresql://localhost:5432/maindb',
          postgresql: {
            host: 'localhost',
            port: 5432,
            database: 'maindb',
          },
          redis: {
            url: 'redis://localhost:6379',
          },
        },
      };

      expect(config.database?.postgresql?.database).toBe('maindb');
      expect(config.database?.redis?.url).toBe('redis://localhost:6379');
    });

    it('should work with complex security configuration', () => {
      const config: DeepPartial<AppConfig> = {
        security: {
          cors: {
            enabled: true,
            origin: ['https://app.example.com', 'https://admin.example.com'],
            methods: ['GET', 'POST', 'PUT', 'DELETE'],
            credentials: true,
          },
          helmet: {
            enabled: true,
            contentSecurityPolicy: true,
            hsts: true,
          },
          csrf: {
            enabled: true,
            secret: 'my-csrf-secret',
          },
          rateLimit: {
            global: {
              enabled: true,
              requests: 1000,
              window: 60000,
            },
          },
        },
      };

      expect(config.security?.cors?.origin).toHaveLength(2);
      expect(config.security?.helmet?.enabled).toBe(true);
    });

    it('should allow arrays in configuration', () => {
      const config: DeepPartial<AppConfig> = {
        security: {
          cors: {
            enabled: true,
            origin: ['http://localhost:3000', 'http://localhost:3001'],
            methods: ['GET', 'POST', 'PUT'],
            allowedHeaders: ['Content-Type', 'Authorization'],
          },
        },
        modules: {
          autoDiscovery: {
            paths: ['./modules', './src/modules', './api'],
            patterns: ['**/*.module.ts', '**/*.controller.ts'],
          },
        },
      };

      expect(config.security?.cors?.origin).toHaveLength(2);
      expect(config.modules?.autoDiscovery?.paths).toHaveLength(3);
    });
  });

  describe('Edge Cases', () => {
    it('should allow empty configuration', () => {
      const config: DeepPartial<AppConfig> = {};

      expect(config).toBeDefined();
      expect(Object.keys(config)).toHaveLength(0);
    });

    it('should allow undefined values', () => {
      const config: DeepPartial<AppConfig> = {
        database: {
          redis: undefined,
          postgresql: undefined,
        },
      };

      expect(config.database?.redis).toBeUndefined();
    });

    it('should allow null values where appropriate', () => {
      const config: DeepPartial<AppConfig> = {
        database: {
          url: process.env.DATABASE_URL || undefined,
        },
      };

      expect(config).toBeDefined();
    });

    it('should work with spread operators', () => {
      const baseConfig: DeepPartial<AppConfig> = {
        server: {
          port: 3000,
        },
      };

      const extendedConfig: DeepPartial<AppConfig> = {
        ...baseConfig,
        database: {
          url: 'postgresql://localhost:5432/db',
        },
      };

      expect(extendedConfig.server?.port).toBe(3000);
      expect(extendedConfig.database?.url).toBeDefined();
    });

    it('should work with computed property names', () => {
      const adapter = 'postgresql' as const;

      const config: DeepPartial<AppConfig> = {
        database: {
          [adapter]: {
            host: 'localhost',
            port: 5432,
          },
        },
      };

      expect(config.database?.postgresql?.host).toBe('localhost');
    });
  });
});
