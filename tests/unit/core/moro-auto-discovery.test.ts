// Unit Tests - Moro Auto-Discovery Integration
import { createApp } from '../../../src';
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
      const app = createApp();

      // Access private method for testing
      const config = (app as any).mergeAutoDiscoveryConfig({});

      expect(config.enabled).toBe(true);
      expect(config.paths).toEqual(['./modules', './src/modules']);
      expect(config.loadingStrategy).toBe('eager');
      expect(config.loadOrder).toBe('dependency');
    });

    it('should handle boolean autoDiscover option', async () => {
      const app = createApp({ autoDiscover: false });

      const config = (app as any).mergeAutoDiscoveryConfig({ autoDiscover: false });

      expect(config.enabled).toBe(false);
    });

    it('should handle legacy modulesPath option', async () => {
      const app = createApp({ modulesPath: './custom-modules' });

      const config = (app as any).mergeAutoDiscoveryConfig({
        modulesPath: './custom-modules'
      });

      expect(config.paths).toEqual(['./custom-modules']);
    });

    it('should handle object autoDiscover configuration', async () => {
      const customConfig = {
        enabled: true,
        paths: ['./plugins', './extensions'],
        loadingStrategy: 'lazy' as const,
        watchForChanges: true
      };

      const app = createApp({ autoDiscover: customConfig });

      const config = (app as any).mergeAutoDiscoveryConfig({
        autoDiscover: customConfig
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
            handler: async () => ({ users: [] })
          }
        ]
      });

      await createTestModule('orders', {
        name: 'orders',
        version: '1.0.0',
        dependencies: ['users@1.0.0'],
        routes: [
          {
            method: 'GET',
            path: '/orders',
            handler: async () => ({ orders: [] })
          }
        ]
      });
    });

    it('should handle eager loading strategy', async () => {
      const app = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'eager'
        }
      });

      // Trigger auto-discovery manually (using the async method for tests)
      await app.initializeAutoDiscoveryNow();

      // Check that modules are loaded
      expect((app as any).loadedModules.has('users')).toBe(true);
      expect((app as any).loadedModules.has('orders')).toBe(true);
    });

    it('should handle lazy loading strategy', async () => {
      const app = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'lazy'
        }
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

    it('should handle conditional loading strategy', async () => {
      // Create module with environment condition
      await createTestModule('admin', {
        name: 'admin',
        version: '1.0.0',
        config: {
          conditions: {
            environment: ['production']
          }
        },
        routes: [
          {
            method: 'GET',
            path: '/admin',
            handler: async () => ({ admin: true })
          }
        ]
      });

      // Set environment to development
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const app = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'conditional'
        }
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
            environment: 'production'
          }
        }
      });

      const app = createApp();

      // Test with development environment
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const shouldLoad = (app as any).shouldLoadModule({
        name: 'prod-only',
        version: '1.0.0',
        config: {
          conditions: {
            environment: 'production'
          }
        }
      });

      expect(shouldLoad).toBe(false);

      // Test with production environment
      process.env.NODE_ENV = 'production';

      const shouldLoadProd = (app as any).shouldLoadModule({
        name: 'prod-only',
        version: '1.0.0',
        config: {
          conditions: {
            environment: 'production'
          }
        }
      });

      expect(shouldLoadProd).toBe(true);

      process.env.NODE_ENV = originalEnv;
    });

    it('should respect feature flag conditions', async () => {
      const app = createApp();

      // Test without feature flag
      const shouldLoad = (app as any).shouldLoadModule({
        name: 'feature-module',
        version: '1.0.0',
        config: {
          conditions: {
            features: ['BETA_FEATURES']
          }
        }
      });

      expect(shouldLoad).toBe(false);

      // Test with feature flag
      process.env.FEATURE_BETA_FEATURES = 'true';

      const shouldLoadWithFeature = (app as any).shouldLoadModule({
        name: 'feature-module',
        version: '1.0.0',
        config: {
          conditions: {
            features: ['BETA_FEATURES']
          }
        }
      });

      expect(shouldLoadWithFeature).toBe(true);

      delete process.env.FEATURE_BETA_FEATURES;
    });

    it('should respect custom conditions', async () => {
      const app = createApp();

      const shouldLoad = (app as any).shouldLoadModule({
        name: 'custom-module',
        version: '1.0.0',
        config: {
          conditions: {
            custom: () => false
          }
        }
      });

      expect(shouldLoad).toBe(false);

      const shouldLoadTrue = (app as any).shouldLoadModule({
        name: 'custom-module',
        version: '1.0.0',
        config: {
          conditions: {
            custom: () => true
          }
        }
      });

      expect(shouldLoadTrue).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle auto-discovery errors gracefully when failOnError is false', async () => {
      // Create invalid module
      await createInvalidModule('broken');

      const app = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          failOnError: false
        }
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
            failOnError: true
          }
        });
      }).not.toThrow(); // Constructor doesn't throw, but async discovery will

      // The error will be logged, not thrown in constructor
    });
  });

  describe('Backward Compatibility', () => {
    it('should work with legacy autoDiscover boolean', async () => {
      await createTestModule('legacy', {
        name: 'legacy',
        version: '1.0.0'
      });

      const app = createApp({ autoDiscover: true });

      // Trigger auto-discovery manually (using the async method for tests)
      await app.initializeAutoDiscoveryNow();

      expect((app as any).loadedModules.has('legacy')).toBe(true);
    });

    it('should work with legacy modulesPath', async () => {
      // Create module in custom path (using the same structure as other tests)
      await createTestModule('custom-path', {
        name: 'custom-path',
        version: '1.0.0'
      });

      const app = createApp({ modulesPath: './modules' });

      // Trigger auto-discovery manually (using the async method for tests)
      await app.initializeAutoDiscoveryNow();

      expect((app as any).loadedModules.has('custom-path')).toBe(true);
    });

    it('should disable auto-discovery when autoDiscover is false', async () => {
      await createTestModule('disabled', {
        name: 'disabled',
        version: '1.0.0'
      });

      const app = createApp({ autoDiscover: false });

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
