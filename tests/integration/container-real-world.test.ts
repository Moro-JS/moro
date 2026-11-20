/**
 * Real-World DI Container Integration Tests
 *
 * Tests realistic patterns shown in the documentation website
 * https://morojs.com/docs/advanced/dependency-injection
 */

import { jest } from '@jest/globals';
import { createApp, Container } from '../../src/index.js';
import { MoroLogger, logger as globalLogger } from '../../src/core/logger/index.js';

describe('Real-World DI Patterns', () => {
  describe('Accessing Container in Different Contexts', () => {
    it('should access container via req.app in routes', async () => {
      const app = await createApp({
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
      const logger = container.resolve<any>('logger');
      const result = logger.log('test message');
      expect(result).toBe('test message');

      // Verify it's accessible through app as well
      const logger2 = app.getContainer().resolve('logger');
      expect(logger2).toBe(logger); // Singleton

      await app.close();
    });

    it('should access container in middleware via req.app', async () => {
      const app = await createApp({
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
      const auth = container.resolve<any>('authService');
      expect(auth.verify('valid-token')).toBe(true);
      expect(auth.verify('invalid-token')).toBe(false);

      await app.close();
    });
  });

  describe('Complete Application Example (from docs)', () => {
    it('should demonstrate full dependency chain', async () => {
      const app = await createApp({
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
      const userService = await container.resolve<any>('userService');
      const result = await userService.register('user@example.com', 'password123');

      expect(result).toEqual([
        { id: { email: 'user@example.com', password: 'password123' }, name: 'Test User' },
      ]);

      // Verify email was sent
      const emailService = await container.resolve<any>('emailService');
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
      const app = await createApp({
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
      const app = await createApp({
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
      const app = await createApp({
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

      const logger1 = await enhanced.resolve('requestLogger', { context: context1 as any });
      const logger2 = await enhanced.resolve('requestLogger', { context: context2 as any });

      expect(logger1.log('test')).toBe('[req-1] test');
      expect(logger2.log('test')).toBe('[req-2] test');

      await app.close();
    });

    it('should support service interceptors for logging', async () => {
      const app = await createApp({
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
        .interceptor((name: any, factory: any, deps: any, context: any) => {
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

      const service = await container.resolve<any>('trackedService');
      expect(service.doWork()).toBe('work-done');
      expect(logs).toHaveLength(2);
      expect(logs[0]).toBe('Creating service: trackedService');
      expect(logs[1]).toMatch(/Service trackedService created in \d+ms/);

      await app.close();
    });

    it('should support service interceptors with next() callback pattern', async () => {
      const app = await createApp({
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
        .interceptor((name: any, deps: any, context: any, next: any) => {
          // Middleware-style with next() callback
          logs.push(`Before ${name}`);
          const result = next();
          logs.push(`After ${name}`);
          return result;
        })
        .singleton()
        .build();

      const service = await container.resolve<any>('middlewareService');
      expect(service.process()).toBe('processed');
      expect(logs).toEqual(['Before middlewareService', 'After middlewareService']);

      await app.close();
    });

    it('should support service decorators for error handling', async () => {
      const app = await createApp({
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

    it('should accept a factory-wrapping interceptor whatever its parameters are called', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const enhanced = app.getContainer().getEnhanced();

      const calls: string[] = [];

      enhanced
        .register('renamedService')
        .factory(() => ({ real: true }))
        .interceptor((serviceName: any, create: any, _deps: any, _context: any) => {
          return () => {
            calls.push(`creating ${serviceName}`);
            return create();
          };
        })
        .singleton()
        .build();

      // What a bundler leaves of the same interceptor
      enhanced
        .register('minifiedService')
        .factory(() => ({ real: true }))
        .interceptor((a: any, b: any, _c: any, _d: any) => () => b())
        .singleton()
        .build();

      // Returns the factory it was given, untouched
      enhanced
        .register('untouchedService')
        .factory(() => ({ real: true }))
        .interceptor((_serviceName: any, original: any, _deps: any, _context: any) => original)
        .singleton()
        .build();

      expect(await enhanced.resolve('renamedService')).toEqual({ real: true });
      expect(await enhanced.resolve('minifiedService')).toEqual({ real: true });
      expect(await enhanced.resolve('untouchedService')).toEqual({ real: true });
      expect(enhanced.resolveSync('renamedService')).toEqual({ real: true });
      expect(calls).toEqual(['creating renamedService']);

      await app.close();
    });

    it('should call an interceptor once per creation whichever pattern it follows', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const enhanced = app.getContainer().getEnhanced();

      const calls: string[] = [];
      // Same parameter names, different patterns
      const wrapsFactory = (a: any, b: any, _c: any, _d: any) => {
        calls.push(`wrap ${a}`);
        return () => {
          calls.push(`create ${a}`);
          return b();
        };
      };
      const callsNext = (a: any, _b: any, _c: any, d: any) => {
        calls.push(`before ${a}`);
        const created = d();
        calls.push(`after ${a}`);
        return created;
      };

      enhanced
        .register('job')
        .factory(() => ({ id: Math.random() }))
        .interceptor(wrapsFactory)
        .interceptor(callsNext)
        .transient()
        .build();

      // The first creation finds out which pattern each one follows
      await enhanced.resolve('job');
      calls.length = 0;

      const job = await enhanced.resolve('job');
      expect(typeof job.id).toBe('number');
      expect(calls).toEqual(['wrap job', 'before job', 'create job', 'after job']);

      // A service that is itself a function is what next() returned, not a factory
      const handler = () => 'handled';
      enhanced
        .register('handlerService')
        .factory(() => handler)
        .interceptor((a: any, _b: any, _c: any, d: any) => {
          calls.push(`before ${a}`);
          return d();
        })
        .singleton()
        .build();
      calls.length = 0;
      expect(await enhanced.resolve('handlerService')).toBe(handler);
      expect(calls).toEqual(['before handlerService']);

      await app.close();
    });
  });

  describe('Replacing and Disposing Services', () => {
    it('should resolve the latest registration of a name', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();

      class ProductionEmailService {
        kind = 'production';
      }
      class MockEmailService {
        kind = 'mock';
      }

      container.register('emailService', () => new ProductionEmailService(), true);
      expect(container.resolve<any>('emailService').kind).toBe('production');

      // Substituting a mock after the service was used
      container.register('emailService', () => new MockEmailService(), true);
      expect(container.resolve<any>('emailService').kind).toBe('mock');
      expect(container.getEnhanced().resolveSync('emailService').kind).toBe('mock');

      // And through the enhanced container
      container
        .getEnhanced()
        .register('emailService')
        .factory(() => ({ kind: 'second mock' }))
        .singleton()
        .build();
      expect(container.resolve<any>('emailService').kind).toBe('second mock');
      expect((await container.getEnhanced().resolve('emailService')).kind).toBe('second mock');

      await app.close();
    });

    it('should replace a request-scoped service for requests that already resolved it', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const enhanced = app.getContainer().getEnhanced();
      const context = { requestId: 'req-1', metadata: {}, timestamp: Date.now() };

      enhanced
        .register('requestClock')
        .factory(() => 'real')
        .requestScoped()
        .build();
      expect(await enhanced.resolve('requestClock', { context })).toBe('real');

      enhanced
        .register('requestClock')
        .factory(() => 'mock')
        .requestScoped()
        .build();
      expect(await enhanced.resolve('requestClock', { context })).toBe('mock');

      await app.close();
    });

    it('should build a new instance after the container is disposed', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();
      const enhanced = container.getEnhanced();

      let built = 0;
      let disposed = 0;

      enhanced
        .register('connection')
        .factory(() => ({ id: ++built }))
        .onDispose(() => {
          disposed++;
        })
        .singleton()
        .build();

      const first = container.resolve<any>('connection');
      expect(container.resolve('connection')).toBe(first);

      await enhanced.dispose();
      expect(disposed).toBe(1);

      const second = container.resolve<any>('connection');
      expect(second).not.toBe(first);
      expect(second.id).toBe(2);
      expect(container.resolve('connection')).toBe(second);

      await app.close();
    });

    it('should not resolve a service of a destroyed container', () => {
      const container = new Container();
      container.register('cache', () => new Map(), true);
      container.resolve('cache');

      container.getEnhanced().destroy();

      expect(container.has('cache')).toBe(false);
      expect(() => container.resolve('cache')).toThrow("Service 'cache' not registered");
    });
  });

  describe('Concurrent Resolution', () => {
    it('should run an async singleton factory once for concurrent first resolutions', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const enhanced = app.getContainer().getEnhanced();

      let connections = 0;

      enhanced
        .register('database')
        .factory(async () => {
          const id = ++connections;
          await new Promise(resolve => setTimeout(resolve, 10));
          return { id };
        })
        .singleton()
        .build();

      const [first, second, third] = await Promise.all([
        enhanced.resolve('database'),
        enhanced.resolve('database'),
        enhanced.resolve('database'),
      ]);

      expect(connections).toBe(1);
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(await enhanced.resolve('database')).toBe(first);

      // A transient service is still built for every caller
      let tokens = 0;
      enhanced
        .register('token')
        .factory(async () => ({ id: ++tokens }))
        .transient()
        .build();
      const [token1, token2] = await Promise.all([
        enhanced.resolve('token'),
        enhanced.resolve('token'),
      ]);
      expect(tokens).toBe(2);
      expect(token2).not.toBe(token1);

      await app.close();
    });

    it('should build a dependency once when two services need it at the same time', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const enhanced = app.getContainer().getEnhanced();

      let pools = 0;

      enhanced
        .register('pool')
        .factory(async () => {
          const id = ++pools;
          await new Promise(resolve => setTimeout(resolve, 10));
          return { id };
        })
        .singleton()
        .build();
      enhanced
        .register('users')
        .factory(deps => ({ pool: deps.pool }))
        .dependsOn('pool')
        .singleton()
        .build();
      enhanced
        .register('orders')
        .factory(deps => ({ pool: deps.pool }))
        .dependsOn('pool')
        .singleton()
        .build();

      const [users, orders] = await Promise.all([
        enhanced.resolve('users'),
        enhanced.resolve('orders'),
      ]);

      expect(pools).toBe(1);
      expect(users.pool).toBe(orders.pool);

      await app.close();
    });

    it('should share one request-scoped instance within a request, not across requests', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const enhanced = app.getContainer().getEnhanced();

      let built = 0;

      enhanced
        .register('unitOfWork')
        .factory(async () => {
          const id = ++built;
          await new Promise(resolve => setTimeout(resolve, 5));
          return { id };
        })
        .requestScoped()
        .build();

      const request1 = { requestId: 'req-1', metadata: {}, timestamp: Date.now() };
      const request2 = { requestId: 'req-2', metadata: {}, timestamp: Date.now() };

      const [a, b, c] = await Promise.all([
        enhanced.resolve('unitOfWork', { context: request1 }),
        enhanced.resolve('unitOfWork', { context: request1 }),
        enhanced.resolve('unitOfWork', { context: request2 }),
      ]);

      expect(built).toBe(2);
      expect(b).toBe(a);
      expect(c).not.toBe(a);

      await app.close();
    });

    it('should fail every concurrent caller of a failed creation and retry on the next resolve', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const enhanced = app.getContainer().getEnhanced();

      let attempts = 0;

      enhanced
        .register('remoteConfig')
        .factory(async () => {
          const attempt = ++attempts;
          await new Promise(resolve => setTimeout(resolve, 5));
          if (attempt === 1) {
            throw new Error('config server unavailable');
          }
          return { attempt };
        })
        .singleton()
        .build();

      const results = await Promise.allSettled([
        enhanced.resolve('remoteConfig'),
        enhanced.resolve('remoteConfig'),
      ]);

      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(attempts).toBe(1);

      // Nothing was stored: the factory runs again
      expect(await enhanced.resolve('remoteConfig')).toEqual({ attempt: 2 });
      expect(attempts).toBe(2);

      await app.close();
    });
  });

  describe('Circular Dependencies', () => {
    it('should name the cycle when services depend on each other', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const enhanced = app.getContainer().getEnhanced();

      enhanced
        .register('serviceA')
        .factory(deps => ({ b: deps.serviceB }))
        .dependsOn('serviceB')
        .singleton()
        .build();
      enhanced
        .register('serviceB')
        .factory(deps => ({ a: deps.serviceA }))
        .dependsOn('serviceA')
        .singleton()
        .build();

      await expect(enhanced.resolve('serviceA')).rejects.toThrow(
        'Circular dependency detected: serviceA -> serviceB -> serviceA'
      );
      expect(() => enhanced.resolveSync('serviceB')).toThrow(
        'Circular dependency detected: serviceB -> serviceA -> serviceB'
      );
      expect(() => app.getContainer().resolve('serviceA')).toThrow(
        'Circular dependency detected: serviceA -> serviceB -> serviceA'
      );

      await app.close();
    });

    it('should name only the services on the cycle', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const enhanced = app.getContainer().getEnhanced();

      enhanced
        .register('entry')
        .factory(deps => deps)
        .dependsOn('first')
        .singleton()
        .build();
      enhanced
        .register('first')
        .factory(deps => deps)
        .dependsOn('second')
        .singleton()
        .build();
      enhanced
        .register('second')
        .factory(deps => deps)
        .dependsOn('first')
        .singleton()
        .build();
      enhanced
        .register('selfish')
        .factory(deps => deps)
        .dependsOn('selfish')
        .singleton()
        .build();

      await expect(enhanced.resolve('entry')).rejects.toThrow(
        'Circular dependency detected: first -> second -> first'
      );
      await expect(enhanced.resolve('selfish')).rejects.toThrow(
        'Circular dependency detected: selfish -> selfish'
      );

      // A dependency reached along two paths is not a cycle
      enhanced
        .register('config')
        .factory(() => ({ name: 'config' }))
        .singleton()
        .build();
      enhanced
        .register('left')
        .factory(deps => ({ config: deps.config }))
        .dependsOn('config')
        .transient()
        .build();
      enhanced
        .register('right')
        .factory(deps => ({ config: deps.config, left: deps.left }))
        .dependsOn('config', 'left')
        .transient()
        .build();
      enhanced
        .register('top')
        .factory(deps => deps)
        .dependsOn('left', 'right')
        .singleton()
        .build();

      const top = await enhanced.resolve('top');
      expect(top.left.config).toBe(top.right.config);
      expect(enhanced.resolveSync('right').left.config).toBe(top.left.config);

      await app.close();
    });
  });

  describe('Request Scope Without a Request Id', () => {
    it('should say once per service that the instance is shared', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const enhanced = app.getContainer().getEnhanced();
      globalLogger.setLevel('warn');
      const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      const warnings = () =>
        log.mock.calls
          .filter(call => call[0] === 'warn' && String(call[1]).includes('without a request id'))
          .map(call => String(call[1]));

      try {
        let built = 0;
        enhanced
          .register('requestContext')
          .factory(() => ({ id: ++built }))
          .requestScoped()
          .build();
        enhanced
          .register('requestTimer')
          .factory(() => ({ startedAt: Date.now() }))
          .requestScoped()
          .build();

        // With a request id: one instance per request, nothing to report
        const request = { requestId: 'req-1', metadata: {}, timestamp: Date.now() };
        await enhanced.resolve('requestContext', { context: request });
        expect(warnings()).toHaveLength(0);

        // Without one: the same instance for every caller, as before
        const first = await enhanced.resolve('requestContext');
        const second = await enhanced.resolve('requestContext');
        const third = enhanced.resolveSync('requestContext', {
          metadata: {},
          timestamp: Date.now(),
        });
        expect(second).toBe(first);
        expect(third).toBe(first);

        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toContain("Request-scoped service 'requestContext'");

        enhanced.resolveSync('requestTimer');
        enhanced.resolveSync('requestTimer');
        expect(warnings()).toHaveLength(2);
        expect(warnings()[1]).toContain("Request-scoped service 'requestTimer'");
      } finally {
        log.mockRestore();
        globalLogger.setLevel('error');
      }

      await app.close();
    });
  });

  describe('Service Lifetimes', () => {
    it('should build a service registered without a lifetime once, however many names there are', () => {
      const container = new Container();
      const built: number[] = [];

      for (let i = 0; i < 60; i++) {
        built.push(0);
        container.register(`service${i}`, () => ({ index: i, build: ++built[i] }));
      }

      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 60; i++) {
          expect(container.resolve<any>(`service${i}`).index).toBe(i);
        }
      }

      // The 51st name and the ones after it, like the first 50
      expect(built).toEqual(new Array(60).fill(1));
      expect(container.resolve('service50')).toBe(container.resolve('service50'));
      expect(container.resolve('service59')).toBe(container.resolve('service59'));

      container.getEnhanced().destroy();
    });

    it('should return the one instance through the enhanced container as well', async () => {
      const container = new Container();
      const enhanced = container.getEnhanced();
      let built = 0;

      container.register('settings', () => ({ id: ++built }));
      enhanced
        .register('reporter')
        .factory((deps: any) => ({ settings: deps.settings }))
        .dependsOn('settings')
        .singleton()
        .build();

      const settings = container.resolve<any>('settings');
      expect(await enhanced.resolve('settings')).toBe(settings);
      expect(enhanced.resolveSync('settings')).toBe(settings);
      expect((await enhanced.resolve('reporter')).settings).toBe(settings);
      expect(built).toBe(1);
      expect(enhanced.getServiceInfo().settings.scope).toBe('singleton');

      enhanced.destroy();
    });

    it('should build a transient service on every resolve, as the first name or the sixtieth', () => {
      const container = new Container();
      let firstBuilt = 0;
      let lastBuilt = 0;

      // The first name this container resolves
      container.register('firstId', () => ({ id: ++firstBuilt }), { lifetime: 'transient' });
      expect(container.resolve<any>('firstId').id).toBe(1);
      expect(container.resolve<any>('firstId').id).toBe(2);
      expect(container.resolve<any>('firstId').id).toBe(3);

      for (let i = 0; i < 58; i++) {
        container.register(`service${i}`, () => i, true);
        container.resolve(`service${i}`);
      }

      // The sixtieth
      container.register('lastId', () => ({ id: ++lastBuilt }), { lifetime: 'transient' });
      expect(container.resolve<any>('lastId').id).toBe(1);
      expect(container.resolve<any>('lastId').id).toBe(2);
      expect(container.resolve<any>('lastId').id).toBe(3);

      expect(container.resolve<any>('firstId').id).toBe(4);
      expect(firstBuilt).toBe(4);
      expect(lastBuilt).toBe(3);

      container.getEnhanced().destroy();
    });

    it('should build a service the builder marked transient on every resolve', () => {
      const container = new Container();
      let built = 0;

      container
        .getEnhanced()
        .register('requestId')
        .factory(() => ({ id: ++built }))
        .transient()
        .build();
      container.getEnhanced().transient('traceId', () => ({ id: ++built }));

      const first = container.resolve<any>('requestId');
      const second = container.resolve<any>('requestId');
      expect(second).not.toBe(first);
      expect([first.id, second.id]).toEqual([1, 2]);
      expect(container.resolve('traceId')).not.toBe(container.resolve('traceId'));
      expect(built).toBe(4);

      container.getEnhanced().destroy();
    });

    it('should keep a singleton when the lifetime is named or given as a boolean', () => {
      const container = new Container();
      const built = { named: 0, yes: 0 };

      container.register('named', () => ({ id: ++built.named }), { lifetime: 'singleton' });
      container.register('yes', () => ({ id: ++built.yes }), true);

      expect(container.resolve('named')).toBe(container.resolve('named'));
      expect(container.resolve('yes')).toBe(container.resolve('yes'));
      expect(built).toEqual({ named: 1, yes: 1 });

      // Replaced by a transient registration of the same name, and back
      container.register('named', () => ({ id: ++built.named }), { lifetime: 'transient' });
      expect(container.resolve('named')).not.toBe(container.resolve('named'));
      expect(built.named).toBe(3);
      container.register('named', () => ({ id: ++built.named }));
      expect(container.resolve('named')).toBe(container.resolve('named'));
      expect(built.named).toBe(4);

      container.getEnhanced().destroy();
    });

    it('should refuse a lifetime it does not know', () => {
      const container = new Container();

      expect(() =>
        container.register('cache', () => new Map(), { lifetime: 'request' } as any)
      ).toThrow("Unknown lifetime 'request' for service 'cache': use 'singleton' or 'transient'");
      expect(container.has('cache')).toBe(false);

      container.getEnhanced().destroy();
    });

    it('should say once that false does not make a service transient', () => {
      const container = new Container();
      globalLogger.setLevel('warn');
      const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      const warnings = () =>
        log.mock.calls
          .filter(call => call[0] === 'warn' && String(call[1]).includes('third argument'))
          .map(call => String(call[1]));

      try {
        let built = 0;
        container.register('plain', () => ({}));
        container.register('shared', () => ({}), true);
        expect(warnings()).toHaveLength(0);

        container.register('counter', () => ({ id: ++built }), false);
        container.register('other', () => ({}), false);

        expect(container.resolve('counter')).toBe(container.resolve('counter'));
        expect(built).toBe(1);
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toContain("Service 'counter'");
        expect(warnings()[0]).toContain("{ lifetime: 'transient' }");
      } finally {
        log.mockRestore();
        globalLogger.setLevel('error');
        container.getEnhanced().destroy();
      }
    });

    it('should build a module service once, whatever its position among the names', async () => {
      const app = await createApp({
        logging: { level: 'error' },
      });
      const container = app.getContainer();
      globalLogger.setLevel('warn');
      const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});

      try {
        for (let i = 0; i < 55; i++) {
          container.register(`service${i}`, () => i, true);
          container.resolve(`service${i}`);
        }

        const built = { orders: 0, pricing: 0 };
        class PricingService {
          id = ++built.pricing;
        }
        class OrdersController {
          id = ++built.orders;
          constructor(private pricing: PricingService) {}
          list = (_req: any, res: any) => {
            res.json({ controller: this.id, pricing: this.pricing.id });
          };
        }

        await app.loadModule({
          name: 'orders',
          version: '1.0.0',
          services: [
            { name: 'pricing', implementation: PricingService, singleton: false },
            { name: 'orders', implementation: OrdersController, dependencies: ['pricing'] },
          ],
          routes: [{ method: 'GET', path: '/', handler: 'list' }],
        } as any);

        await new Promise<void>(resolve => {
          app.listen(0, () => resolve());
        });
        const { port } = app.address() as { port: number };

        for (let request = 0; request < 3; request++) {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1.0.0/orders`);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ controller: 1, pricing: 1 });
        }

        expect(container.resolve('pricing')).toBe(container.resolve('pricing'));
        expect(built).toEqual({ orders: 1, pricing: 1 });
        // The framework's own registrations say nothing about their lifetime
        expect(
          log.mock.calls.filter(
            call => call[0] === 'warn' && String(call[1]).includes('third argument')
          )
        ).toHaveLength(0);
      } finally {
        log.mockRestore();
        globalLogger.setLevel('error');
        await app.close();
      }
    });
  });
});
