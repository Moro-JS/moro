// Test DeepPartial type for user configuration
import type { AppConfig, DeepPartial } from '../../src/index.js';

describe('DeepPartial Configuration Type', () => {
  it('should allow partial nested configuration objects', () => {
    // This should compile without errors - previously would fail with Partial<AppConfig>
    const config: DeepPartial<AppConfig> = {
      server: {
        port: 3000,
        host: 'localhost',
        // Notice: we don't need to provide all ServerConfig properties
      },
      database: {
        url: process.env.DATABASE_URL,
        // Notice: nested objects can be partial too
        redis: {
          url: 'redis://localhost:6379',
          // We don't need to provide all redis properties like maxRetries, retryDelay, keyPrefix
        },
      },
      logging: {
        level: 'debug',
        format: 'json',
        // We don't need to provide all logging properties
      },
      security: {
        cors: {
          enabled: true,
          // We don't need to provide all cors properties
        },
      },
    };

    expect(config).toBeDefined();
    expect(config.server?.port).toBe(3000);
    expect(config.logging?.level).toBe('debug');
  });

  it('should allow deeply nested partial objects', () => {
    const config: DeepPartial<AppConfig> = {
      modules: {
        session: {
          enabled: true,
          store: 'memory',
          cookie: {
            maxAge: 86400000,
            httpOnly: true,
            // Don't need to provide all cookie properties
          },
          // Don't need to provide all session properties
        },
        // Don't need to provide all module properties
      },
    };

    expect(config.modules?.session?.cookie?.maxAge).toBe(86400000);
  });

  it('should work with environment variables', () => {
    const config: DeepPartial<AppConfig> = {
      server: {
        port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
      },
      database: {
        url: process.env.DATABASE_URL,
        postgresql: process.env.DATABASE_URL
          ? {
              host: 'localhost',
              port: 5432,
              database: 'testdb',
              // Partial nested database config - don't need connectionLimit
            }
          : undefined,
      },
    };

    expect(config).toBeDefined();
  });

  it('should allow partial nested objects in arrays', () => {
    const config: DeepPartial<AppConfig> = {
      security: {
        cors: {
          enabled: true,
          origin: ['http://localhost:3000', 'http://localhost:3001'],
          methods: ['GET', 'POST'],
          // Don't need all CORS properties
        },
      },
    };

    expect(config.security?.cors?.origin).toHaveLength(2);
  });

  it('should work with optional nested config sections', () => {
    const config: DeepPartial<AppConfig> = {
      server: {
        port: 3000,
        ssl: {
          key_file_name: '/path/to/key',
          cert_file_name: '/path/to/cert',
          // Don't need passphrase
        },
      },
    };

    expect(config.server?.ssl?.key_file_name).toBe('/path/to/key');
  });
});
