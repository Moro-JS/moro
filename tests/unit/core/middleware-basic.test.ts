// @ts-nocheck
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  withLogging,
  withCaching,
  withRetry,
  withTimeout,
} from '../../../src/core/utilities/container.js';

// Mock logger for testing
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Helper to create mock ServiceContext
const createMockContext = () => ({
  metadata: {},
  timestamp: Date.now(),
  requestId: 'test-request',
  moduleId: 'test-module',
});

describe('Container Higher-Order Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('withLogging', () => {
    it('should wrap a service factory with logging', () => {
      const mockFactory = jest.fn().mockReturnValue('test-service');
      const wrappedFactory = withLogging(mockLogger)(mockFactory);

      expect(typeof wrappedFactory).toBe('function');
    });

    it('should log service creation', () => {
      const mockFactory = jest.fn().mockReturnValue('test-service');
      const wrappedFactory = withLogging(mockLogger)(mockFactory);

      const mockDeps = { dep1: 'value1', dep2: 'value2' };
      const mockContext = createMockContext();

      const result = wrappedFactory(mockDeps, mockContext);

      expect(result).toBe('test-service');
      expect(mockFactory).toHaveBeenCalledWith(mockDeps, mockContext);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Creating service with dependencies: dep1, dep2'
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/Service created in \d+ms/)
      );
    });

    it('should handle factories with no dependencies', () => {
      const mockFactory = jest.fn().mockReturnValue('simple-service');
      const wrappedFactory = withLogging(mockLogger)(mockFactory);

      const result = wrappedFactory({}, createMockContext());

      expect(result).toBe('simple-service');
      expect(mockLogger.debug).toHaveBeenCalledWith('Creating service with dependencies: ');
    });

    it('should handle async factories', async () => {
      const mockAsyncFactory = jest.fn().mockResolvedValue('async-service');
      const wrappedFactory = withLogging(mockLogger)(mockAsyncFactory);

      const result = await wrappedFactory({}, createMockContext());

      expect(result).toBe('async-service');
      expect(mockLogger.debug).toHaveBeenCalled();
    });
  });

  describe('withCaching', () => {
    it('should create caching wrapper with default TTL', () => {
      const mockFactory = jest.fn().mockReturnValue('cached-service');
      const wrappedFactory = withCaching()(mockFactory);

      expect(typeof wrappedFactory).toBe('function');
    });

    it('should create caching wrapper with custom TTL', () => {
      const customTTL = 60000; // 1 minute
      const mockFactory = jest.fn().mockReturnValue('cached-service');
      const wrappedFactory = withCaching(customTTL)(mockFactory);

      expect(typeof wrappedFactory).toBe('function');
    });

    it('should call the factory function', () => {
      const mockFactory = jest.fn().mockReturnValue('cached-service');
      const wrappedFactory = withCaching(300000)(mockFactory); // 5 minutes

      const deps = { config: 'test' };
      const context = createMockContext();

      // Call the wrapped factory
      wrappedFactory(deps, context);

      expect(mockFactory).toHaveBeenCalledWith(deps, context);
      expect(mockFactory).toHaveBeenCalledTimes(1);
    });

    it('should handle different dependency sets', () => {
      const mockFactory = jest
        .fn()
        .mockReturnValueOnce('service-1')
        .mockReturnValueOnce('service-2');
      const wrappedFactory = withCaching()(mockFactory);

      const deps1 = { config: 'test1' };
      const deps2 = { config: 'test2' };

      wrappedFactory(deps1, createMockContext());
      wrappedFactory(deps2, createMockContext());

      expect(mockFactory).toHaveBeenCalledTimes(2);
    });

    // The cache is private to the wrapper: count its entries by handing it a
    // Map that reports its own size
    const withObservedCache = (create: () => any) => {
      const observed = { size: 0 };
      const RealMap = globalThis.Map;
      class ObservedMap extends RealMap {
        set(key: any, value: any) {
          super.set(key, value);
          observed.size = this.size;
          return this;
        }
        delete(key: any) {
          const deleted = super.delete(key);
          observed.size = this.size;
          return deleted;
        }
      }
      globalThis.Map = ObservedMap as any;
      try {
        return { wrappedFactory: create(), observed };
      } finally {
        globalThis.Map = RealMap;
      }
    };
    const requestContext = (requestId: string) => ({ ...createMockContext(), requestId });

    it('should drop entries once they have expired', async () => {
      const mockFactory = jest.fn().mockImplementation(() => ({}));
      const { wrappedFactory, observed } = withObservedCache(() => withCaching(10)(mockFactory));

      for (let i = 0; i < 100; i++) {
        await wrappedFactory({}, requestContext(`req-${i}`));
      }
      await new Promise(resolve => setTimeout(resolve, 30));

      // The next creation finds the hundred expired entries and removes them
      const last = await wrappedFactory({}, requestContext('req-last'));
      expect(observed.size).toBe(1);
      expect(await wrappedFactory({}, requestContext('req-last'))).toBe(last);

      // An expired entry is built again, not served
      await new Promise(resolve => setTimeout(resolve, 30));
      await wrappedFactory({}, requestContext('req-last'));
      expect(mockFactory).toHaveBeenCalledTimes(102);
      expect(observed.size).toBe(1);
    });

    it('should keep a bounded number of entries and the ones still in use', async () => {
      const mockFactory = jest.fn().mockImplementation(() => ({}));
      const { wrappedFactory, observed } = withObservedCache(() => withCaching(60000)(mockFactory));

      const shared = await wrappedFactory({}, { metadata: {}, timestamp: Date.now() });
      for (let i = 0; i < 3000; i++) {
        await wrappedFactory({}, requestContext(`req-${i}`));
        if (i % 100 === 0) {
          // Still read while other requests come and go
          expect(await wrappedFactory({}, { metadata: {}, timestamp: Date.now() })).toBe(shared);
        }
      }

      expect(observed.size).toBe(1000);
      expect(mockFactory).toHaveBeenCalledTimes(3001);
    });
  });

  describe('withRetry', () => {
    it('should create retry wrapper with default attempts', () => {
      const mockFactory = jest.fn().mockReturnValue('retry-service');
      const wrappedFactory = withRetry()(mockFactory);

      expect(typeof wrappedFactory).toBe('function');
    });

    it('should create retry wrapper with custom attempts', () => {
      const mockFactory = jest.fn().mockReturnValue('retry-service');
      const wrappedFactory = withRetry(5)(mockFactory);

      expect(typeof wrappedFactory).toBe('function');
    });

    it('should succeed on first try', async () => {
      const mockFactory = jest.fn().mockResolvedValue('success');
      const wrappedFactory = withRetry(3)(mockFactory);

      const result = await wrappedFactory({}, createMockContext());

      expect(result).toBe('success');
      expect(mockFactory).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
      const mockFactory = jest
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValueOnce('success');

      const wrappedFactory = withRetry(3)(mockFactory);

      const result = await wrappedFactory({}, createMockContext());

      expect(result).toBe('success');
      expect(mockFactory).toHaveBeenCalledTimes(3);
    });

    it('should fail after max retries', async () => {
      const error = new Error('Persistent failure');
      const mockFactory = jest.fn().mockRejectedValue(error);
      const wrappedFactory = withRetry(3)(mockFactory); // Allow 3 attempts

      await expect(wrappedFactory({}, createMockContext())).rejects.toThrow('Persistent failure');
      // The implementation might retry 4 times total (initial + 3 retries)
      expect(mockFactory).toHaveBeenCalledTimes(4);
    });

    it('should handle synchronous failures', async () => {
      const mockFactory = jest
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('Sync fail');
        })
        .mockReturnValueOnce('success');

      const wrappedFactory = withRetry(2)(mockFactory);

      const result = await wrappedFactory({}, createMockContext());

      expect(result).toBe('success');
      expect(mockFactory).toHaveBeenCalledTimes(2);
    });
  });

  describe('withTimeout', () => {
    it('should create timeout wrapper with default timeout', () => {
      const mockFactory = jest.fn().mockReturnValue('timeout-service');
      const wrappedFactory = withTimeout()(mockFactory);

      expect(typeof wrappedFactory).toBe('function');
    });

    it('should create timeout wrapper with custom timeout', () => {
      const mockFactory = jest.fn().mockReturnValue('timeout-service');
      const wrappedFactory = withTimeout(5000)(mockFactory);

      expect(typeof wrappedFactory).toBe('function');
    });

    it('should complete within timeout', async () => {
      const mockFactory = jest.fn().mockResolvedValue('fast-service');
      const wrappedFactory = withTimeout(1000)(mockFactory);

      const result = await wrappedFactory({}, createMockContext());

      expect(result).toBe('fast-service');
      expect(mockFactory).toHaveBeenCalledTimes(1);
    });

    it('should timeout slow operations', async () => {
      const mockFactory = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            // Just resolve slowly without creating long-running timeouts
            setTimeout(() => resolve('slow-service'), 50);
          })
      );
      const wrappedFactory = withTimeout(10)(mockFactory); // Very short timeout

      await expect(wrappedFactory({}, createMockContext())).rejects.toThrow();
      expect(mockFactory).toHaveBeenCalledTimes(1);
    }, 1000);

    it('should handle synchronous operations', async () => {
      const mockFactory = jest.fn().mockReturnValue('sync-service');
      const wrappedFactory = withTimeout(100)(mockFactory);

      const result = await wrappedFactory({}, createMockContext());

      expect(result).toBe('sync-service');
      expect(mockFactory).toHaveBeenCalledTimes(1);
    });

    it('should handle factory errors', async () => {
      const error = new Error('Factory error');
      const mockFactory = jest.fn().mockRejectedValue(error);
      const wrappedFactory = withTimeout(1000)(mockFactory);

      await expect(wrappedFactory({}, createMockContext())).rejects.toThrow('Factory error');
      expect(mockFactory).toHaveBeenCalledTimes(1);
    });

    it('should leave no timer behind once the factory has settled', async () => {
      jest.useFakeTimers();
      try {
        const fast = withTimeout(60000)(jest.fn().mockResolvedValue('fast-service'));
        expect(await fast({}, createMockContext())).toBe('fast-service');
        expect(jest.getTimerCount()).toBe(0);

        const failing = withTimeout(60000)(jest.fn().mockRejectedValue(new Error('Factory error')));
        await expect(failing({}, createMockContext())).rejects.toThrow('Factory error');
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('Higher-order function composition', () => {
    it('should compose multiple wrappers', async () => {
      const mockFactory = jest.fn().mockResolvedValue('composed-service');

      const composedFactory = withTimeout(1000)(withRetry(2)(withLogging(mockLogger)(mockFactory)));

      const result = await composedFactory({ dep: 'test' }, createMockContext());

      expect(result).toBe('composed-service');
      expect(mockLogger.debug).toHaveBeenCalled();
      expect(mockFactory).toHaveBeenCalledTimes(1);
    });

    it('should handle composition with failures and retries', async () => {
      const mockFactory = jest
        .fn()
        .mockRejectedValueOnce(new Error('First failure'))
        .mockResolvedValueOnce('recovered-service');

      const composedFactory = withRetry(3)(withLogging(mockLogger)(mockFactory));

      const result = await composedFactory({}, createMockContext());

      expect(result).toBe('recovered-service');
      expect(mockFactory).toHaveBeenCalledTimes(2);
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it('should work with basic composition', () => {
      const mockFactory = jest.fn().mockReturnValue('simple-composed-service');

      const composedFactory = withLogging(mockLogger)(mockFactory);

      const deps = { same: 'deps' };

      // Call the composed factory
      composedFactory(deps, createMockContext());
      composedFactory(deps, createMockContext());

      expect(mockFactory).toHaveBeenCalledTimes(2);
      expect(mockLogger.debug).toHaveBeenCalled();
    });
  });
});
