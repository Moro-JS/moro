/**
 * Type-Safe Dependency Injection Tests
 *
 * Tests for automatic type safety in the DI container
 */

/* eslint-disable no-unused-vars */

import { FunctionalContainer, TypedServiceReference } from '../../src/core/utilities/container';

describe('Container Type Safety', () => {
  let container: FunctionalContainer;

  beforeEach(() => {
    container = new FunctionalContainer();
  });

  afterEach(async () => {
    await container.dispose();
    container.destroy();
  });

  describe('Typed Service References', () => {
    it('should return a typed service reference from registration', () => {
      interface TestService {
        getValue(): string;
      }

      const serviceRef = container
        .register<TestService>('testService')
        .factory(() => ({
          getValue() {
            return 'test-value';
          },
        }))
        .singleton()
        .build();

      expect(serviceRef).toBeInstanceOf(TypedServiceReference);
      expect(serviceRef.getName()).toBe('testService');
    });

    it('should resolve service with correct type', async () => {
      interface UserService {
        findById(id: string): Promise<{ id: string; name: string }>;
      }

      const userServiceRef = container
        .register<UserService>('userService')
        .factory(() => ({
          async findById(userId: string) {
            return { id: userId, name: 'John Doe' };
          },
        }))
        .singleton()
        .build();

      const userService = await userServiceRef.resolve();
      const user = await userService.findById('123');

      expect(user).toEqual({ id: '123', name: 'John Doe' });
    });

    it('should resolve service synchronously with correct type', () => {
      interface ConfigService {
        get(key: string): string;
      }

      const configRef = container
        .register<ConfigService>('config')
        .factory(() => ({
          get(configKey: string) {
            return `value-${configKey}`;
          },
        }))
        .singleton()
        .build();

      const config = configRef.resolveSync();
      const value = config.get('test');

      expect(value).toBe('value-test');
    });
  });

  describe('Typed Dependencies', () => {
    it('should handle typed dependencies correctly', async () => {
      interface EmailService {
        send(to: string, subject: string): Promise<void>;
      }

      interface UserService {
        createUser(email: string): Promise<{ email: string }>;
      }

      container
        .register<EmailService>('emailService')
        .factory(() => ({
          async send(_to: string, _subject: string) {
            // Mock implementation
          },
        }))
        .singleton()
        .build();

      const userRef = container
        .register<UserService>('userService')
        .factory(deps => {
          const emailService = deps.emailService as EmailService;
          return {
            async createUser(userEmail: string) {
              await emailService.send(userEmail, 'Welcome');
              return { email: userEmail };
            },
          };
        })
        .dependsOn('emailService')
        .singleton()
        .build();

      const userService = await userRef.resolve();
      const user = await userService.createUser('test@example.com');

      expect(user).toEqual({ email: 'test@example.com' });
    });
  });

  describe('Class-based Services', () => {
    it('should work with class-based services', async () => {
      class DatabaseService {
        async query(_sql: string) {
          return [{ id: '1', name: 'Test' }];
        }
      }

      class UserRepository {
        constructor(private db: DatabaseService) {}

        async findAll() {
          return this.db.query('SELECT * FROM users');
        }
      }

      container
        .register<DatabaseService>('database')
        .factory(() => new DatabaseService())
        .singleton()
        .build();

      const repoRef = container
        .register<UserRepository>('userRepository')
        .factory(deps => {
          const db = deps.database as DatabaseService;
          return new UserRepository(db);
        })
        .dependsOn('database')
        .singleton()
        .build();

      const repo = await repoRef.resolve();
      const users = await repo.findAll();

      expect(users).toEqual([{ id: '1', name: 'Test' }]);
    });
  });

  describe('Multiple Resolutions', () => {
    it('should maintain type safety across multiple resolutions', async () => {
      interface CounterService {
        increment(): number;
        getValue(): number;
      }

      let counter = 0;
      const counterRef = container
        .register<CounterService>('counter')
        .factory(() => ({
          increment() {
            return ++counter;
          },
          getValue() {
            return counter;
          },
        }))
        .singleton()
        .build();

      // First resolution
      const counter1 = await counterRef.resolve();
      expect(counter1.increment()).toBe(1);

      // Second resolution (should get same instance due to singleton)
      const counter2 = await counterRef.resolve();
      expect(counter2.getValue()).toBe(1);
      expect(counter2.increment()).toBe(2);

      // Both references point to same instance
      expect(counter1.getValue()).toBe(2);
    });
  });

  describe('Direct Registration Methods', () => {
    it('should support singleton() method with type safety', async () => {
      interface CacheService {
        get(key: string): string | null;
        set(key: string, value: string): void;
      }

      const cacheMap = new Map<string, string>();
      const cacheRef = container.singleton<CacheService>('cache', () => ({
        get(cacheKey: string) {
          return cacheMap.get(cacheKey) || null;
        },
        set(cacheKey: string, cacheValue: string) {
          cacheMap.set(cacheKey, cacheValue);
        },
      }));

      const cache = await cacheRef.resolve();
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should support transient() method with type safety', async () => {
      interface RequestIdService {
        getId(): string;
      }

      let idCounter = 0;
      const requestIdRef = container.transient<RequestIdService>('requestId', () => ({
        getId() {
          return `req-${++idCounter}`;
        },
      }));

      const service1 = await requestIdRef.resolve();
      const service2 = await requestIdRef.resolve();

      // Transient services should be different instances
      expect(service1.getId()).toBe('req-1');
      expect(service2.getId()).toBe('req-2');
    });
  });

  describe('Lifecycle Hooks with Type Safety', () => {
    it('should maintain type safety with lifecycle hooks', async () => {
      interface DatabaseConnection {
        isConnected: boolean;
        connect(): Promise<void>;
        disconnect(): Promise<void>;
      }

      let connected = false;
      container
        .register<DatabaseConnection>('dbConnection')
        .factory(() => ({
          isConnected: false,
          async connect() {
            this.isConnected = true;
            connected = true;
          },
          async disconnect() {
            this.isConnected = false;
            connected = false;
          },
        }))
        .singleton()
        .onInit(async () => {
          const db = await container.resolve<DatabaseConnection>('dbConnection');
          await db.connect();
        })
        .build();

      const db = await container.resolve<DatabaseConnection>('dbConnection');
      expect(connected).toBe(true);
      expect(db.isConnected).toBe(true);

      await db.disconnect();
      expect(connected).toBe(false);
    });
  });

  describe('Context-based Resolution', () => {
    it('should support context in typed resolution', async () => {
      interface LoggerService {
        log(message: string): void;
      }

      const logs: string[] = [];
      const loggerRef = container
        .register<LoggerService>('logger')
        .factory((deps, context) => ({
          log(logMessage: string) {
            const prefix = context?.requestId || 'default';
            logs.push(`[${prefix}] ${logMessage}`);
          },
        }))
        .requestScoped()
        .build();

      const logger1 = await loggerRef.resolve({
        requestId: 'req-1',
        metadata: {},
        timestamp: Date.now(),
      });
      logger1.log('Message 1');

      const logger2 = await loggerRef.resolve({
        requestId: 'req-2',
        metadata: {},
        timestamp: Date.now(),
      });
      logger2.log('Message 2');

      expect(logs).toContain('[req-1] Message 1');
      expect(logs).toContain('[req-2] Message 2');
    });
  });

  describe('Complex Service Structures', () => {
    it('should handle complex nested service types', async () => {
      interface User {
        id: string;
        name: string;
        email: string;
      }

      interface UserRepository {
        findById(id: string): Promise<User>;
        findByEmail(email: string): Promise<User | null>;
        create(data: Omit<User, 'id'>): Promise<User>;
      }

      interface AuthResult {
        success: boolean;
        user?: User;
        token?: string;
      }

      interface AuthService {
        signIn(email: string, password: string): Promise<AuthResult>;
        validate(token: string): Promise<User | null>;
      }

      container
        .register<UserRepository>('userRepository')
        .factory(() => ({
          async findById(userId: string) {
            return { id: userId, name: 'John', email: 'john@example.com' };
          },
          async findByEmail(userEmail: string) {
            return { id: '1', name: 'John', email: userEmail };
          },
          async create(userData: Omit<User, 'id'>) {
            return { id: '1', ...userData };
          },
        }))
        .singleton()
        .build();

      const authServiceRef = container
        .register<AuthService>('authService')
        .factory(deps => {
          const userRepo = deps.userRepository as UserRepository;
          return {
            async signIn(userEmail: string, _password: string): Promise<AuthResult> {
              const user = await userRepo.findByEmail(userEmail);
              if (user) {
                return { success: true, user, token: 'jwt-token' };
              }
              return { success: false };
            },
            async validate(_token: string) {
              return userRepo.findById('1');
            },
          };
        })
        .dependsOn('userRepository')
        .singleton()
        .build();

      const authService = await authServiceRef.resolve();
      const result = await authService.signIn('john@example.com', 'password');

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user?.email).toBe('john@example.com');
      expect(result.token).toBe('jwt-token');
    });
  });
});
