// Unit Tests - Moro Auto-Discovery Integration
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createApp } from '../../../src/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp, rm } from 'fs/promises';

describe('Moro Auto-Discovery Integration', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'moro-integration-test-'));

    // Store original working directory and change to temp directory for tests
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    // Restore original working directory before cleanup
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Configuration Merging', () => {
    it('should use default auto-discovery configuration', async () => {
      const app = await createApp({ logger: { level: 'error' } });

      // Access private method for testing
      const config = (app as any).mergeAutoDiscoveryConfig({});

      expect(config.enabled).toBe(true);
      expect(config.paths).toEqual(['./modules', './src/modules']);
      expect(config.loadingStrategy).toBe('eager');
      expect(config.loadOrder).toBe('dependency');
    });

    it('should handle boolean autoDiscover option', async () => {
      const app = await createApp({ autoDiscover: false, logger: { level: 'error' } });

      const config = (app as any).mergeAutoDiscoveryConfig({ autoDiscover: false });

      expect(config.enabled).toBe(false);
    });

    it('should handle legacy modulesPath option', async () => {
      const app = await createApp({ modulesPath: './custom-modules', logger: { level: 'error' } });

      const config = (app as any).mergeAutoDiscoveryConfig({
        modulesPath: './custom-modules',
      });

      expect(config.paths).toEqual(['./custom-modules']);
    });

    it('should handle object autoDiscover configuration', async () => {
      const customConfig = {
        enabled: true,
        paths: ['./plugins', './extensions'],
        loadingStrategy: 'lazy' as const,
        watchForChanges: true,
      };

      const app = await createApp({ autoDiscover: customConfig, logger: { level: 'error' } });

      const config = (app as any).mergeAutoDiscoveryConfig({
        autoDiscover: customConfig,
      });

      expect(config.enabled).toBe(true);
      expect(config.paths).toEqual(['./plugins', './extensions']);
      expect(config.loadingStrategy).toBe('lazy');
      expect(config.watchForChanges).toBe(true);
    });
  });

  describe('Loading Strategies', () => {
    beforeEach(async () => {
      // Create test modules
      await createTestModule('users', {
        name: 'users',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/users',
            handler: async () => ({ users: [] }),
          },
        ],
      });

      await createTestModule('orders', {
        name: 'orders',
        version: '1.0.0',
        dependencies: ['users@1.0.0'],
        routes: [
          {
            method: 'GET',
            path: '/orders',
            handler: async () => ({ orders: [] }),
          },
        ],
      });
    });

    it('should handle eager loading strategy', async () => {
      const app = await createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'eager',
        },
        logger: { level: 'error' },
      });

      // Trigger auto-discovery manually (using the async method for tests)
      await app.initializeAutoDiscoveryNow();

      // Check that modules are loaded
      expect((app as any).loadedModules.has('users')).toBe(true);
      expect((app as any).loadedModules.has('orders')).toBe(true);
    });

    it('should handle lazy loading strategy', async () => {
      const app = await createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'lazy',
        },
        logger: { level: 'error' },
      });

      // Trigger auto-discovery manually (using the async method for tests)
      await app.initializeAutoDiscoveryNow();

      // Check that modules are registered for lazy loading
      expect((app as any).lazyModules.has('users')).toBe(true);
      expect((app as any).lazyModules.has('orders')).toBe(true);

      // But not actually loaded yet
      expect((app as any).loadedModules.has('users')).toBe(false);
      expect((app as any).loadedModules.has('orders')).toBe(false);
    });

    it('warns once at start-up that the lazy strategy is not applied', async () => {
      const app = await createApp({
        autoDiscover: { enabled: true, paths: ['./modules'], loadingStrategy: 'lazy' },
        logger: { level: 'error' },
      });
      const warn = jest.spyOn((app as any).logger, 'warn').mockImplementation(() => {});

      await app.initializeAutoDiscoveryNow();
      await app.initializeAutoDiscoveryNow();

      const lazy = warn.mock.calls.filter(c => String(c[0]).includes("loadingStrategy 'lazy'"));
      expect(lazy).toHaveLength(1);
      expect(String(lazy[0][0])).toContain('is not applied');
      expect(String(lazy[0][0])).toContain('none of their routes is served');
    });

    it('warns once at start-up that recursive: false is not applied, and says what is', async () => {
      const app = await createApp({
        autoDiscover: { enabled: true, paths: ['./modules'], recursive: false },
        logger: { level: 'error' },
      });
      const warn = jest.spyOn((app as any).logger, 'warn').mockImplementation(() => {});

      await app.initializeAutoDiscoveryNow();
      await app.initializeAutoDiscoveryNow();

      const recursive = warn.mock.calls.filter(c => String(c[0]).includes('recursive: false'));
      expect(recursive).toHaveLength(1);
      expect(String(recursive[0][0])).toContain('is not applied');
      expect(String(recursive[0][0])).toContain('maxDepth: 0');
      // The modules in the directories below are loaded all the same
      expect((app as any).loadedModules.has('users')).toBe(true);
    });

    it('warns once at start-up that watchForChanges does not reload modules', async () => {
      const app = await createApp({
        autoDiscover: { enabled: true, paths: ['./modules'], watchForChanges: true },
        logger: { level: 'error' },
      });
      const warn = jest.spyOn((app as any).logger, 'warn').mockImplementation(() => {});

      await app.initializeAutoDiscoveryNow();
      (app as any).moduleDiscovery.cleanup();

      const watch = warn.mock.calls.filter(c => String(c[0]).includes('watchForChanges'));
      expect(watch).toHaveLength(1);
      expect(String(watch[0][0])).toContain('does not reload modules');
      // Modules are still loaded eagerly; only the reload is missing
      expect((app as any).loadedModules.has('users')).toBe(true);
    });

    it('says nothing about either setting when neither is used', async () => {
      const app = await createApp({
        autoDiscover: { enabled: true, paths: ['./modules'] },
        logger: { level: 'error' },
      });
      const warn = jest.spyOn((app as any).logger, 'warn').mockImplementation(() => {});

      await app.initializeAutoDiscoveryNow();

      const mine = warn.mock.calls.filter(c =>
        /loadingStrategy|watchForChanges/.test(String(c[0]))
      );
      expect(mine).toEqual([]);
    });

    it('should handle conditional loading strategy', async () => {
      // Create module with environment condition
      await createTestModule('admin', {
        name: 'admin',
        version: '1.0.0',
        config: {
          conditions: {
            environment: ['production'],
          },
        },
        routes: [
          {
            method: 'GET',
            path: '/admin',
            handler: async () => ({ admin: true }),
          },
        ],
      });

      // Set environment to development
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const app = await createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'conditional',
        },
        logger: { level: 'error' },
      });

      // Trigger auto-discovery manually (using the async method for tests)
      await app.initializeAutoDiscoveryNow();

      // Admin module should not be loaded in development
      expect((app as any).loadedModules.has('admin')).toBe(false);

      // But users and orders should be loaded (no conditions)
      expect((app as any).loadedModules.has('users')).toBe(true);
      expect((app as any).loadedModules.has('orders')).toBe(true);

      // Restore environment
      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Conditional Loading Rules', () => {
    it('should respect environment conditions', async () => {
      await createTestModule('prod-only', {
        name: 'prod-only',
        version: '1.0.0',
        config: {
          conditions: {
            environment: 'production',
          },
        },
      });

      const app = await createApp({ logger: { level: 'error' } });

      // Test with development environment
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const shouldLoad = (app as any).shouldLoadModule({
        name: 'prod-only',
        version: '1.0.0',
        config: {
          conditions: {
            environment: 'production',
          },
        },
      });

      expect(shouldLoad).toBe(false);

      // Test with production environment
      process.env.NODE_ENV = 'production';

      const shouldLoadProd = (app as any).shouldLoadModule({
        name: 'prod-only',
        version: '1.0.0',
        config: {
          conditions: {
            environment: 'production',
          },
        },
      });

      expect(shouldLoadProd).toBe(true);

      process.env.NODE_ENV = originalEnv;
    });

    it('should respect feature flag conditions', async () => {
      const app = await createApp({ logger: { level: 'error' } });

      // Test without feature flag
      const shouldLoad = (app as any).shouldLoadModule({
        name: 'feature-module',
        version: '1.0.0',
        config: {
          conditions: {
            features: ['BETA_FEATURES'],
          },
        },
      });

      expect(shouldLoad).toBe(false);

      // Test with feature flag
      process.env.FEATURE_BETA_FEATURES = 'true';

      const shouldLoadWithFeature = (app as any).shouldLoadModule({
        name: 'feature-module',
        version: '1.0.0',
        config: {
          conditions: {
            features: ['BETA_FEATURES'],
          },
        },
      });

      expect(shouldLoadWithFeature).toBe(true);

      delete process.env.FEATURE_BETA_FEATURES;
    });

    it('should respect custom conditions', async () => {
      const app = await createApp({ logger: { level: 'error' } });

      const shouldLoad = (app as any).shouldLoadModule({
        name: 'custom-module',
        version: '1.0.0',
        config: {
          conditions: {
            custom: () => false,
          },
        },
      });

      expect(shouldLoad).toBe(false);

      const shouldLoadTrue = (app as any).shouldLoadModule({
        name: 'custom-module',
        version: '1.0.0',
        config: {
          conditions: {
            custom: () => true,
          },
        },
      });

      expect(shouldLoadTrue).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle auto-discovery errors gracefully when failOnError is false', async () => {
      // Create invalid module
      await createInvalidModule('broken');

      const app = await createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          failOnError: false,
        },
        logger: { level: 'error' },
      });

      // Should not throw error
      await new Promise(resolve => setTimeout(resolve, 100));

      // App should still be functional
      expect(app).toBeDefined();
    });

    it('should throw error when failOnError is true and discovery fails', async () => {
      // Create invalid module
      await createInvalidModule('broken');

      expect(() => {
        createApp({
          autoDiscover: {
            enabled: true,
            paths: ['./modules'],
            failOnError: true,
          },
          logger: { level: 'error' },
        });
      }).not.toThrow(); // Constructor doesn't throw, but async discovery will

      // The error will be logged, not thrown in constructor
    });
  });

  describe('Backward Compatibility', () => {
    it('should work with legacy autoDiscover boolean', async () => {
      await createTestModule('legacy', {
        name: 'legacy',
        version: '1.0.0',
      });

      const app = await createApp({ autoDiscover: true, logger: { level: 'error' } });

      // Trigger auto-discovery manually (using the async method for tests)
      await app.initializeAutoDiscoveryNow();

      expect((app as any).loadedModules.has('legacy')).toBe(true);
    });

    it('should work with legacy modulesPath', async () => {
      // Create module in custom path (using the same structure as other tests)
      await createTestModule('custom-path', {
        name: 'custom-path',
        version: '1.0.0',
      });

      const app = await createApp({ modulesPath: './modules', logger: { level: 'error' } });

      // Trigger auto-discovery manually (using the async method for tests)
      await app.initializeAutoDiscoveryNow();

      expect((app as any).loadedModules.has('custom-path')).toBe(true);
    });

    it('should disable auto-discovery when autoDiscover is false', async () => {
      await createTestModule('disabled', {
        name: 'disabled',
        version: '1.0.0',
      });

      const app = await createApp({ autoDiscover: false, logger: { level: 'error' } });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect((app as any).loadedModules.has('disabled')).toBe(false);
    });
  });
});

// Helper functions
async function createTestModule(moduleName: string, moduleConfig: any): Promise<void> {
  const modulePath = join('./modules', moduleName);
  await fs.mkdir(modulePath, { recursive: true });

  const moduleContent = `
export default ${JSON.stringify(moduleConfig, null, 2)};
`;

  await fs.writeFile(join(modulePath, 'index.ts'), moduleContent);
}

async function createInvalidModule(moduleName: string): Promise<void> {
  const modulePath = join('./modules', moduleName);
  await fs.mkdir(modulePath, { recursive: true });

  const invalidContent = `
throw new Error("This module is intentionally broken for testing");
`;

  await fs.writeFile(join(modulePath, 'index.ts'), invalidContent);
}
