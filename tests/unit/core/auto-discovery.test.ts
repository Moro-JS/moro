// Unit Tests - Enhanced Module Auto-Discovery System
import { ModuleDiscovery, autoDiscoverModules, autoDiscoverModuleDirectories } from '../../../src/core/modules/auto-discovery';
import { ModuleConfig } from '../../../src/types/module';
import { ModuleDefaultsConfig } from '../../../src/types/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp, rm } from 'fs/promises';

describe('Enhanced Module Auto-Discovery System', () => {
  let tempDir: string;
  let discovery: ModuleDiscovery;

  beforeEach(async () => {
    // Create temporary directory for tests
    tempDir = await mkdtemp(join(tmpdir(), 'moro-test-'));
    discovery = new ModuleDiscovery(tempDir);
  });

  afterEach(async () => {
    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('ModuleDiscovery Class', () => {
    describe('Basic Discovery', () => {
      it('should discover modules from directory structure', async () => {
        // Create test module structure
        await createTestModule(tempDir, 'users', {
          name: 'users',
          version: '1.0.0'
        });

        const modules = await discovery.discoverModuleDirectories('modules');

        expect(modules).toHaveLength(1);
        expect(modules[0].name).toBe('users');
        expect(modules[0].version).toBe('1.0.0');
      });

      it('should discover modules with different file patterns', async () => {
        // Create modules with different patterns
        await createTestModule(tempDir, 'auth', { name: 'auth', version: '1.0.0' }, 'auth.module.ts');
        await createTestModule(tempDir, 'orders', { name: 'orders', version: '1.0.0' }, 'module.ts');
        await createTestModule(tempDir, 'payments', { name: 'payments', version: '1.0.0' }, 'config.ts');

        const modules = await discovery.discoverModuleDirectories('modules');

        expect(modules).toHaveLength(3);
        expect(modules.map(m => m.name).sort()).toEqual(['auth', 'orders', 'payments']);
      });

      it('should handle missing directories gracefully', async () => {
        const modules = await discovery.discoverModuleDirectories('non-existent');
        expect(modules).toHaveLength(0);
      });
    });

    describe('Advanced Discovery Configuration', () => {
      it('should discover modules with advanced configuration', async () => {
        // Create test modules
        await createTestModule(tempDir, 'users', { name: 'users', version: '1.0.0' });
        await createTestModule(tempDir, 'orders', { name: 'orders', version: '1.0.0' });

        // Debug: Check if files were actually created
        const modulesDir = join(tempDir, 'modules');
        const usersFile = join(modulesDir, 'users', 'index.ts');
        const ordersFile = join(modulesDir, 'orders', 'index.ts');
        
        expect(await fs.access(usersFile).then(() => true).catch(() => false)).toBe(true);
        expect(await fs.access(ordersFile).then(() => true).catch(() => false)).toBe(true);

        const config: ModuleDefaultsConfig['autoDiscovery'] = {
          enabled: true,
          paths: ['modules'],
          patterns: ['**/index.{ts,js}', '**/*.module.{ts,js}'],
          recursive: true,
          loadingStrategy: 'eager',
          watchForChanges: false,
          ignorePatterns: ['**/*.test.{ts,js}'],
          loadOrder: 'alphabetical',
          failOnError: false,
          maxDepth: 5
        };

        // Always show debug info to understand what's happening in CI
        const dirContents = await fs.readdir(tempDir, { recursive: true }).catch(() => []);
        const modulesExists = await fs.access(modulesDir).then(() => true).catch(() => false);
        
        console.error('=== DEBUG INFO ===');
        console.error('Temp directory:', tempDir);
        console.error('Modules directory exists:', modulesExists);
        console.error('Directory contents:', dirContents);
        console.error('Discovery base dir:', discovery['baseDir']);
        console.error('Config paths:', config.paths);
        console.error('Config patterns:', config.patterns);
        
        // Try manual file discovery
        try {
          const manualFiles = await fs.readdir(join(tempDir, 'modules'), { recursive: true });
          console.error('Manual modules directory scan:', manualFiles);
        } catch (e) {
          console.error('Manual scan failed:', e instanceof Error ? e.message : String(e));
        }

        // DIRECT TEST: Try to call the discovery method with explicit error handling
        let modules: any[] = [];
        let discoveryError: any = null;
        
        try {
          console.error('=== CALLING DISCOVERY ===');
          modules = await discovery.discoverModulesAdvanced(config);
          console.error('=== DISCOVERY COMPLETED ===');
        } catch (error) {
          console.error('=== DISCOVERY ERROR ===', error);
          discoveryError = error;
        }
        
        console.error('Discovered modules count:', modules.length);
        console.error('Discovered modules:', modules.map(m => ({ name: m.name, version: m.version })));
        console.error('Discovery error:', discoveryError);
        console.error('=== END DEBUG ===');

        // If discovery threw an error, re-throw it with context
        if (discoveryError) {
          throw new Error(`Discovery failed: ${discoveryError.message || discoveryError}`);
        }

        // If no modules found, fail with detailed info
        if (modules.length === 0) {
          const errorMsg = [
            'No modules discovered in CI!',
            `Temp dir: ${tempDir}`,
            `Modules dir exists: ${modulesExists}`,
            `Dir contents: ${JSON.stringify(dirContents)}`,
            `Discovery base: ${discovery['baseDir']}`,
            `Config paths: ${JSON.stringify(config.paths)}`,
            `Config patterns: ${JSON.stringify(config.patterns)}`
          ].join('\n');
          
          throw new Error(errorMsg);
        }

        expect(modules).toHaveLength(2);
        expect(modules[0].name).toBe('orders'); // Alphabetical order
        expect(modules[1].name).toBe('users');
      });

      it('should respect ignore patterns', async () => {
        // Create modules and test files
        await createTestModule(tempDir, 'users', { name: 'users', version: '1.0.0' });
        await createTestFile(tempDir, 'users/users.test.ts', 'export const testModule = { name: "test", version: "1.0.0" };');

        const config: ModuleDefaultsConfig['autoDiscovery'] = {
          enabled: true,
          paths: ['modules'],
          patterns: ['**/*.{ts,js}'],
          recursive: true,
          loadingStrategy: 'eager',
          watchForChanges: false,
          ignorePatterns: ['**/*.test.{ts,js}'],
          loadOrder: 'alphabetical',
          failOnError: false,
          maxDepth: 5
        };

        const modules = await discovery.discoverModulesAdvanced(config);

        expect(modules).toHaveLength(1);
        expect(modules[0].name).toBe('users');
      });

      it('should respect maxDepth configuration', async () => {
        // Create nested module structure
        await createTestModule(tempDir, 'level1/level2/level3/deep', { name: 'deep', version: '1.0.0' });

        const config: ModuleDefaultsConfig['autoDiscovery'] = {
          enabled: true,
          paths: ['modules'],
          patterns: ['**/index.{ts,js}'],
          recursive: true,
          loadingStrategy: 'eager',
          watchForChanges: false,
          ignorePatterns: [],
          loadOrder: 'alphabetical',
          failOnError: false,
          maxDepth: 2 // Should not find the deep module
        };

        const modules = await discovery.discoverModulesAdvanced(config);
        expect(modules).toHaveLength(0);
      });
    });

    describe('Dependency Resolution', () => {
      it('should resolve dependencies in correct order', async () => {
        // Create modules with dependencies
        await createTestModule(tempDir, 'auth', {
          name: 'auth',
          version: '1.0.0',
          dependencies: []
        });

        await createTestModule(tempDir, 'users', {
          name: 'users',
          version: '1.0.0',
          dependencies: ['auth@1.0.0']
        });

        await createTestModule(tempDir, 'orders', {
          name: 'orders',
          version: '1.0.0',
          dependencies: ['users@1.0.0', 'auth@1.0.0']
        });

        const config: ModuleDefaultsConfig['autoDiscovery'] = {
          enabled: true,
          paths: ['modules'],
          patterns: ['**/index.{ts,js}'],
          recursive: true,
          loadingStrategy: 'eager',
          watchForChanges: false,
          ignorePatterns: [],
          loadOrder: 'dependency',
          failOnError: false,
          maxDepth: 5
        };

        const modules = await discovery.discoverModulesAdvanced(config);

        expect(modules).toHaveLength(3);
        expect(modules[0].name).toBe('auth'); // No dependencies, loaded first
        expect(modules[1].name).toBe('users'); // Depends on auth
        expect(modules[2].name).toBe('orders'); // Depends on users and auth
      });

      it('should detect circular dependencies', async () => {
        // Create modules with circular dependencies
        await createTestModule(tempDir, 'moduleA', {
          name: 'moduleA',
          version: '1.0.0',
          dependencies: ['moduleB@1.0.0']
        });

        await createTestModule(tempDir, 'moduleB', {
          name: 'moduleB',
          version: '1.0.0',
          dependencies: ['moduleA@1.0.0']
        });

        const config: ModuleDefaultsConfig['autoDiscovery'] = {
          enabled: true,
          paths: ['modules'],
          patterns: ['**/index.{ts,js}'],
          recursive: true,
          loadingStrategy: 'eager',
          watchForChanges: false,
          ignorePatterns: [],
          loadOrder: 'dependency',
          failOnError: true,
          maxDepth: 5
        };

        await expect(discovery.discoverModulesAdvanced(config))
          .rejects
          .toThrow('Circular dependency detected');
      });
    });

    describe('Custom Load Order', () => {
      it('should sort modules by custom priority', async () => {
        // Create modules with different priorities
        await createTestModule(tempDir, 'low-priority', {
          name: 'low-priority',
          version: '1.0.0',
          config: { priority: 1 }
        });

        await createTestModule(tempDir, 'high-priority', {
          name: 'high-priority',
          version: '1.0.0',
          config: { priority: 10 }
        });

        await createTestModule(tempDir, 'medium-priority', {
          name: 'medium-priority',
          version: '1.0.0',
          config: { priority: 5 }
        });

        const config: ModuleDefaultsConfig['autoDiscovery'] = {
          enabled: true,
          paths: ['modules'],
          patterns: ['**/index.{ts,js}'],
          recursive: true,
          loadingStrategy: 'eager',
          watchForChanges: false,
          ignorePatterns: [],
          loadOrder: 'custom',
          failOnError: false,
          maxDepth: 5
        };

        const modules = await discovery.discoverModulesAdvanced(config);

        expect(modules).toHaveLength(3);
        expect(modules[0].name).toBe('high-priority'); // Priority 10
        expect(modules[1].name).toBe('medium-priority'); // Priority 5
        expect(modules[2].name).toBe('low-priority'); // Priority 1
      });
    });

    describe('Error Handling', () => {
      it('should handle invalid module files gracefully when failOnError is false', async () => {
        // Create valid module
        await createTestModule(tempDir, 'valid', { name: 'valid', version: '1.0.0' });

        // Create invalid module file
        await createTestFile(tempDir, 'modules/invalid/index.ts', 'export const invalid = "not a module";');

        const config: ModuleDefaultsConfig['autoDiscovery'] = {
          enabled: true,
          paths: ['modules'],
          patterns: ['**/index.{ts,js}'],
          recursive: true,
          loadingStrategy: 'eager',
          watchForChanges: false,
          ignorePatterns: [],
          loadOrder: 'alphabetical',
          failOnError: false,
          maxDepth: 5
        };

        const modules = await discovery.discoverModulesAdvanced(config);

        expect(modules).toHaveLength(1);
        expect(modules[0].name).toBe('valid');
      });

      it('should throw error when failOnError is true and module loading fails', async () => {
        // Create invalid module file
        await createTestFile(tempDir, 'modules/invalid/index.ts', 'throw new Error("Module loading failed");');

        const config: ModuleDefaultsConfig['autoDiscovery'] = {
          enabled: true,
          paths: ['modules'],
          patterns: ['**/index.{ts,js}'],
          recursive: true,
          loadingStrategy: 'eager',
          watchForChanges: false,
          ignorePatterns: [],
          loadOrder: 'alphabetical',
          failOnError: true,
          maxDepth: 5
        };

        await expect(discovery.discoverModulesAdvanced(config))
          .rejects
          .toThrow('Failed to load module');
      });
    });

    describe('Module Deduplication', () => {
      it('should remove duplicate modules', async () => {
        // Create same module in different locations
        await createTestModule(tempDir, 'users', { name: 'users', version: '1.0.0' });
        await createTestFile(tempDir, 'modules/duplicate/users.module.ts',
          'export default { name: "users", version: "1.0.0" };');

        const config: ModuleDefaultsConfig['autoDiscovery'] = {
          enabled: true,
          paths: ['modules'],
          patterns: ['**/index.{ts,js}', '**/*.module.{ts,js}'],
          recursive: true,
          loadingStrategy: 'eager',
          watchForChanges: false,
          ignorePatterns: [],
          loadOrder: 'alphabetical',
          failOnError: false,
          maxDepth: 5
        };

        const modules = await discovery.discoverModulesAdvanced(config);

        expect(modules).toHaveLength(1);
        expect(modules[0].name).toBe('users');
      });
    });
  });

  describe('Convenience Functions', () => {
    it('should work with autoDiscoverModules function', async () => {
      await createTestModule(tempDir, 'test', { name: 'test', version: '1.0.0' });

      const modules = await autoDiscoverModules(tempDir, {
        pattern: /index\.(ts|js)$/,
        recursive: true,
        extensions: ['.ts', '.js']
      });

      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('test');
    });

    it('should work with autoDiscoverModuleDirectories function', async () => {
      await createTestModule(tempDir, 'test', { name: 'test', version: '1.0.0' });

      const modules = await autoDiscoverModuleDirectories(tempDir, 'modules');

      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('test');
    });
  });
});

// Helper functions for creating test modules and files
async function createTestModule(
  baseDir: string,
  moduleName: string,
  moduleConfig: any,
  fileName: string = 'index.ts'
): Promise<void> {
  const modulePath = join(baseDir, 'modules', moduleName);
  await fs.mkdir(modulePath, { recursive: true });

  const moduleContent = `
export default ${JSON.stringify(moduleConfig, null, 2)};
`;

  await fs.writeFile(join(modulePath, fileName), moduleContent);
}

async function createTestFile(baseDir: string, filePath: string, content: string): Promise<void> {
  const fullPath = join(baseDir, filePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, content);
}
