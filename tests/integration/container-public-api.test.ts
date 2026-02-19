/**
 * Integration test for DI container access through the public API
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createApp } from '../../src/index';

describe('DI Container Public API', () => {
  let app;

  beforeEach(async () => {
    app = await createApp({
      logging: { level: 'error' },
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('app.getContainer()', () => {
    it('should expose the container through public API', () => {
      const container = app.getContainer();

      expect(container).toBeDefined();
      expect(typeof container.resolve).toBe('function');
      expect(typeof container.register).toBe('function');
      expect(typeof container.has).toBe('function');
    });

    it('should allow registering and resolving services', () => {
      const container = app.getContainer();

      container.register(
        'testService',
        () => ({
          getMessage: () => 'Hello from DI!',
        }),
        true
      );

      const service = container.resolve('testService') as any;
      expect(service.getMessage()).toBe('Hello from DI!');
    });

    it('should provide access to enhanced container', () => {
      const container = app.getContainer();
      const enhanced = container.getEnhanced();

      expect(enhanced).toBeDefined();
      expect(typeof enhanced.register).toBe('function');
      expect(typeof enhanced.resolve).toBe('function');
    });

    it('should support type-safe service registration through enhanced container', async () => {
      const container = app.getContainer();
      const enhanced = container.getEnhanced();

      interface TestService {
        getValue(): number;
      }

      // Explicitly type the service registration for type safety
      // @ts-ignore - TypeScript linter doesn't recognize generic in tests without project reference
      const serviceRef = enhanced
        .register<TestService>('typedService')
        .factory(() => ({
          getValue() {
            return 42;
          },
        }))
        .singleton()
        .build();

      const service = await serviceRef.resolve();
      expect(service.getValue()).toBe(42);
    });

    it('should work with services registered in modules', async () => {
      const container = app.getContainer();

      // Simulate module service registration
      container.register(
        'userService',
        () => ({
          findById: (id: string) => ({ id, name: 'Test User' }),
        }),
        true
      );

      const userService = container.resolve('userService') as any;
      const user = userService.findById('123');

      expect(user).toEqual({ id: '123', name: 'Test User' });
    });

    it('should share the same container instance', () => {
      const container1 = app.getContainer();
      const container2 = app.getContainer();

      container1.register(
        'sharedService',
        () => ({
          value: 'shared',
        }),
        true
      );

      const service1 = container1.resolve('sharedService') as any;
      const service2 = container2.resolve('sharedService') as any;

      expect(service1).toBe(service2); // Same instance
      expect(service1.value).toBe('shared');
    });
  });
});
