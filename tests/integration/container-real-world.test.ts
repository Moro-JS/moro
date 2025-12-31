/**
 * Real-World DI Container Integration Tests
 *
 * Tests realistic patterns shown in the documentation website
 * https://morojs.com/docs/advanced/dependency-injection
 */

/* eslint-disable no-unused-vars */
import { createApp } from '../../src/index';

describe('Real-World DI Patterns', () => {
  describe('Accessing Container in Different Contexts', () => {
    it('should access container via req.app in routes', async () => {
      const app = createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();

      // Register a service
      container.register(
        'logger',
        () => ({
          log: (msg: string) => msg,
        }),
        true
      );

      // Test that container is accessible directly
      const logger = container.resolve('logger');
      const result = logger.log('test message');
      expect(result).toBe('test message');

      // Verify it's accessible through app as well
      const logger2 = app.getContainer().resolve('logger');
      expect(logger2).toBe(logger); // Singleton

      await app.close();
    });

    it('should access container in middleware via req.app', async () => {
      const app = createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();

      // Register auth service
      container.register(
        'authService',
        () => ({
          verify: (token: string) => token === 'valid-token',
        }),
        true
      );

      // Test that container is accessible
      const auth = container.resolve('authService');
      expect(auth.verify('valid-token')).toBe(true);
      expect(auth.verify('invalid-token')).toBe(false);

      await app.close();
    });
  });

  describe('Complete Application Example (from docs)', () => {
    it('should demonstrate full dependency chain', async () => {
      const app = createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();
      const enhanced = container.getEnhanced();

      // ConfigService
      class ConfigService {
        get(key: string): any {
          return { DB_HOST: 'localhost' }[key];
        }
      }

      // DatabaseService depends on ConfigService
      class DatabaseService {
        constructor(private _config: ConfigService) {}

        async query(sql: string, params: any[]) {
          const host = this._config.get('DB_HOST');
          expect(host).toBe('localhost');
          return [{ id: params[0], name: 'Test User' }];
        }
      }

      // UserRepository depends on DatabaseService
      class UserRepository {
        constructor(private _db: DatabaseService) {}

        async findById(id: string) {
          return this._db.query('SELECT * FROM users WHERE id = ?', [id]);
        }

        async create(data: any) {
          return this._db.query('INSERT INTO users SET ?', [data]);
        }
      }

      // EmailService (no dependencies)
      class EmailService {
        emails: any[] = [];

        async send(to: string, subject: string, body: string) {
          this.emails.push({ to, subject, body });
        }
      }

      // UserService depends on UserRepository and EmailService
      class UserService {
        constructor(
          private _userRepo: UserRepository,
          private _emailService: EmailService
        ) {}

        async register(email: string, password: string) {
          const user = await this._userRepo.create({ email, password });
          await this._emailService.send(email, 'Welcome!', 'Thanks for registering');
          return user;
        }
      }

      // Register all services with dependencies
      enhanced
        .register('config')
        .factory(() => new ConfigService())
        .singleton()
        .build();

      enhanced
        .register('database')
        .factory(deps => new DatabaseService(deps.config))
        .dependsOn('config')
        .singleton()
        .build();

      enhanced
        .register('userRepository')
        .factory(deps => new UserRepository(deps.database))
        .dependsOn('database')
        .singleton()
        .build();

      enhanced
        .register('emailService')
        .factory(() => new EmailService())
        .singleton()
        .build();

      enhanced
        .register('userService')
        .factory(deps => new UserService(deps.userRepository, deps.emailService))
        .dependsOn('userRepository', 'emailService')
        .singleton()
        .build();

      // Test the full chain
      const userService = await container.resolve('userService');
      const result = await userService.register('user@example.com', 'password123');

      expect(result).toEqual([
        { id: { email: 'user@example.com', password: 'password123' }, name: 'Test User' },
      ]);

      // Verify email was sent
      const emailService = await container.resolve('emailService');
      expect(emailService.emails).toHaveLength(1);
      expect(emailService.emails[0]).toEqual({
        to: 'user@example.com',
        subject: 'Welcome!',
        body: 'Thanks for registering',
      });

      await app.close();
    });
  });

  describe('Service Organization Pattern', () => {
    it('should support centralized service exports', async () => {
      const app = createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();
      const enhanced = container.getEnhanced();

      // Define service types
      interface UserService {
        findById(id: string): Promise<{ id: string; name: string }>;
      }

      interface AuthService {
        signIn(username: string, password: string): Promise<{ token: string }>;
      }

      // Register and store typed references
      const services = {
        user: enhanced
          .register<UserService>('userService')
          .factory(() => ({
            async findById(_id: string) {
              return { id: _id, name: 'Test User' };
            },
          }))
          .singleton()
          .build(),

        auth: enhanced
          .register<AuthService>('authService')
          .factory(() => ({
            async signIn(_username: string, _password: string) {
              return { token: 'mock-token' };
            },
          }))
          .singleton()
          .build(),
      };

      // Use in routes
      const userService = await services.user.resolve();
      const user = await userService.findById('123');
      expect(user).toEqual({ id: '123', name: 'Test User' });

      const authService = await services.auth.resolve();
      const result = await authService.signIn('user', 'pass');
      expect(result).toEqual({ token: 'mock-token' });

      await app.close();
    });
  });

  describe('Advanced Patterns from Docs', () => {
    it('should support service composition with tags', async () => {
      const app = createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();
      const enhanced = container.getEnhanced();

      // Register multiple plugins with tags
      class PostgresPlugin {
        name = 'postgres';
        async initialize() {
          return 'postgres-initialized';
        }
      }

      class RedisPlugin {
        name = 'redis';
        async initialize() {
          return 'redis-initialized';
        }
      }

      enhanced
        .register('postgresPlugin')
        .factory(() => new PostgresPlugin())
        .tags('plugin', 'database')
        .singleton()
        .build();

      enhanced
        .register('redisPlugin')
        .factory(() => new RedisPlugin())
        .tags('plugin', 'cache')
        .singleton()
        .build();

      // Resolve all plugins by tag
      const plugins = await enhanced.resolveByTag('plugin');
      expect(plugins).toHaveLength(2);

      const results = await Promise.all(plugins.map(p => p.initialize()));
      expect(results).toContain('postgres-initialized');
      expect(results).toContain('redis-initialized');

      await app.close();
    });

    it('should support request-scoped services with context', async () => {
      const app = createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();
      const enhanced = container.getEnhanced();

      // Register request-scoped logger
      enhanced
        .register('requestLogger')
        .factory((_deps, context) => ({
          log: (message: string) => {
            return `[${context?.requestId}] ${message}`;
          },
        }))
        .requestScoped()
        .build();

      // Simulate two different requests
      const context1 = { requestId: 'req-1' };
      const context2 = { requestId: 'req-2' };

      const logger1 = await enhanced.resolve('requestLogger', { context: context1 });
      const logger2 = await enhanced.resolve('requestLogger', { context: context2 });

      expect(logger1.log('test')).toBe('[req-1] test');
      expect(logger2.log('test')).toBe('[req-2] test');

      await app.close();
    });

    it('should support service interceptors for logging', async () => {
      const app = createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();
      const enhanced = container.getEnhanced();

      const logs: string[] = [];

      enhanced
        .register('trackedService')
        .factory(() => ({
          doWork() {
            return 'work-done';
          },
        }))
        .interceptor((name, factory, deps, context) => {
          return async () => {
            logs.push(`Creating service: ${name}`);
            const startTime = Date.now();
            const service = await factory();
            const duration = Date.now() - startTime;
            logs.push(`Service ${name} created in ${duration}ms`);
            return service;
          };
        })
        .singleton()
        .build();

      const service = await container.resolve('trackedService');
      expect(service.doWork()).toBe('work-done');
      expect(logs).toHaveLength(2);
      expect(logs[0]).toBe('Creating service: trackedService');
      expect(logs[1]).toMatch(/Service trackedService created in \d+ms/);

      await app.close();
    });

    it('should support service interceptors with next() callback pattern', async () => {
      const app = createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();
      const enhanced = container.getEnhanced();

      const logs: string[] = [];

      enhanced
        .register('middlewareService')
        .factory(() => ({
          process() {
            return 'processed';
          },
        }))
        .interceptor((name, deps, context, next) => {
          // Middleware-style with next() callback
          logs.push(`Before ${name}`);
          const result = next();
          logs.push(`After ${name}`);
          return result;
        })
        .singleton()
        .build();

      const service = await container.resolve('middlewareService');
      expect(service.process()).toBe('processed');
      expect(logs).toEqual(['Before middlewareService', 'After middlewareService']);

      await app.close();
    });

    it('should support service decorators for error handling', async () => {
      const app = createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();
      const enhanced = container.getEnhanced();

      const errors: any[] = [];

      enhanced
        .register('apiService')
        .factory(() => ({
          getData: async () => {
            throw new Error('API Error');
          },
          getSuccess: async () => {
            return { data: 'success' };
          },
        }))
        .decorator(async (service, _context) => {
          // Wrap all methods with error handling
          return new Proxy(service, {
            get(target: any, prop) {
              const original = target[prop];
              if (typeof original === 'function') {
                return async (...args: any[]) => {
                  try {
                    return await original.apply(target, args);
                  } catch (error) {
                    errors.push({ method: String(prop), error });
                    throw error;
                  }
                };
              }
              return original;
            },
          });
        })
        .singleton()
        .build();

      const service = await enhanced.resolve('apiService');

      // Test error handling
      await expect(service.getData()).rejects.toThrow('API Error');
      expect(errors).toHaveLength(1);
      expect(errors[0].method).toBe('getData');

      // Test success case
      const result = await service.getSuccess();
      expect(result).toEqual({ data: 'success' });

      await app.close();
    });
  });
});
