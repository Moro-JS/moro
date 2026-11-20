// Unit Tests - Enhanced Module Auto-Discovery System
import {
  ModuleDiscovery,
  autoDiscoverModules,
  autoDiscoverModuleDirectories,
} from '../../../src/core/modules/auto-discovery.js';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ModuleConfig } from '../../../src/types/module.js';
import { ModuleDefaultsConfig } from '../../../src/types/config.js';
import {
  compareModulePaths,
  findModuleFiles,
  matchesModulePattern,
} from '../../../src/core/modules/module-files.js';
import { promises as fs } from 'fs';
import * as fsPromises from 'fs/promises';
import { join, relative } from 'path';
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
          version: '1.0.0',
        });

        const modules = await discovery.discoverModuleDirectories('modules');

        expect(modules).toHaveLength(1);
        expect(modules[0].name).toBe('users');
        expect(modules[0].version).toBe('1.0.0');
      });

      it('should discover modules with different file patterns', async () => {
        // Create modules with different patterns
        await createTestModule(
          tempDir,
          'auth',
          { name: 'auth', version: '1.0.0' },
          'auth.module.ts'
        );
        await createTestModule(
          tempDir,
          'orders',
          { name: 'orders', version: '1.0.0' },
          'module.ts'
        );
        await createTestModule(
          tempDir,
          'payments',
          { name: 'payments', version: '1.0.0' },
          'config.ts'
        );

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

        expect(
          await fs
            .access(usersFile)
            .then(() => true)
            .catch(() => false)
        ).toBe(true);
        expect(
          await fs
            .access(ordersFile)
            .then(() => true)
            .catch(() => false)
        ).toBe(true);

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
          maxDepth: 5,
        };

        // Always show debug info to understand what's happening in CI
        const dirContents = await fs.readdir(tempDir, { recursive: true }).catch(() => []);
        const modulesExists = await fs
          .access(modulesDir)
          .then(() => true)
          .catch(() => false);

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

        const modules = await discovery.discoverModulesAdvanced(config);

        expect(modules).toHaveLength(2);
        expect(modules[0].name).toBe('orders'); // Alphabetical order
        expect(modules[1].name).toBe('users');
      });

      it('loads an absolute path as the directory itself, whatever the base directory is', async () => {
        await createTestModule(tempDir, 'users', { name: 'users', version: '1.0.0' });
        const elsewhere = await mkdtemp(join(tmpdir(), 'moro-test-base-'));
        try {
          const config: ModuleDefaultsConfig['autoDiscovery'] = {
            enabled: true,
            paths: [join(tempDir, 'modules')],
            patterns: ['**/index.{ts,js}'],
            recursive: true,
            loadingStrategy: 'eager',
            watchForChanges: false,
            ignorePatterns: [],
            loadOrder: 'alphabetical',
            failOnError: true,
            maxDepth: 5,
          };

          const modules = await new ModuleDiscovery(elsewhere).discoverModulesAdvanced(config);
          expect(modules.map(module => module.name)).toEqual(['users']);
        } finally {
          await rm(elsewhere, { recursive: true, force: true });
        }
      });

      it('says once when the modules came from a working directory the application was not started from', async () => {
        await createTestModule(tempDir, 'users', { name: 'users', version: '1.0.0' });
        const config = {
          enabled: true,
          paths: ['modules'],
          patterns: ['**/index.{ts,js}'],
          recursive: true,
          loadingStrategy: 'eager',
          watchForChanges: false,
          ignorePatterns: [],
          loadOrder: 'alphabetical',
          failOnError: true,
          maxDepth: 5,
        } as ModuleDefaultsConfig['autoDiscovery'];
        const startedIn = process.cwd();
        const scriptStartedWith = process.argv[1] as string;

        await jest.isolateModulesAsync(async () => {
          // A discovery of its own: what it has said so far is per process
          const isolated = await import('../../../src/core/modules/auto-discovery.js');
          const logging = await import('../../../src/core/logger/index.js');
          logging.logger.setLevel('debug');
          const log = jest
            .spyOn(logging.MoroLogger.prototype as any, 'log')
            .mockImplementation(() => {});
          const said = (level: string, text: string) =>
            log.mock.calls
              .filter(call => call[0] === level && String(call[1]).includes(text))
              .map(call => String(call[1]));
          try {
            process.chdir(tempDir);
            const modulesDir = join(process.cwd(), 'modules');

            // Started the usual way: the script is inside the working directory
            await fs.writeFile(join(process.cwd(), 'server.js'), '');
            process.argv[1] = join(process.cwd(), 'server.js');
            await new isolated.ModuleDiscovery().discoverModulesAdvanced(config);
            expect(said('debug', 'Scanning for modules in')).toEqual([
              `Scanning for modules in ${modulesDir}`,
            ]);
            expect(said('info', 'through the working directory')).toEqual([]);

            // Started from somewhere else
            process.argv[1] = scriptStartedWith;
            await new isolated.ModuleDiscovery().discoverModulesAdvanced(config);
            await new isolated.ModuleDiscovery().discoverModulesAdvanced(config);
            const notices = said('info', 'through the working directory');
            expect(notices).toHaveLength(1);
            expect(notices[0]).toContain(`module directory ${modulesDir}`);
            expect(notices[0]).toContain('modules.autoDiscovery.paths');
          } finally {
            process.chdir(startedIn);
            process.argv[1] = scriptStartedWith;
            log.mockRestore();
          }
        });
      });

      it('should respect ignore patterns', async () => {
        // Create modules and test files
        await createTestModule(tempDir, 'users', { name: 'users', version: '1.0.0' });
        await createTestFile(
          tempDir,
          'users/users.test.ts',
          'export const testModule = { name: "test", version: "1.0.0" };'
        );

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
          maxDepth: 5,
        };

        const modules = await discovery.discoverModulesAdvanced(config);

        expect(modules).toHaveLength(1);
        expect(modules[0].name).toBe('users');
      });

      it('should respect maxDepth configuration', async () => {
        // Create nested module structure
        await createTestModule(tempDir, 'level1/level2/level3/deep', {
          name: 'deep',
          version: '1.0.0',
        });

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
          maxDepth: 2, // Should not find the deep module
        };

        const modules = await discovery.discoverModulesAdvanced(config);
        expect(modules).toHaveLength(0);
      });
    });

    // One walk finds the files and one rule orders them, so the same modules
    // load in the same order on every Node.js version, operating system and
    // file system, in CI and out of it.
    describe('Which files are found, and in what order', () => {
      const moduleFile = (name: string) =>
        `export default ${JSON.stringify({ name, version: '1.0.0' })};\n`;
      const write = async (path: string, name: string) => {
        const file = join(tempDir, 'modules', path);
        await fs.mkdir(join(file, '..'), { recursive: true });
        await fs.writeFile(file, moduleFile(name));
      };
      const config = (
        overrides: Partial<ModuleDefaultsConfig['autoDiscovery']> = {}
      ): ModuleDefaultsConfig['autoDiscovery'] => ({
        enabled: true,
        paths: ['modules'],
        patterns: ['**/*.module.{ts,js}', '**/index.{ts,js}', '**/*.config.{ts,js}'],
        recursive: true,
        loadingStrategy: 'eager',
        watchForChanges: false,
        ignorePatterns: ['**/*.test.{ts,js}', '**/*.spec.{ts,js}', '**/node_modules/**'],
        loadOrder: 'dependency',
        failOnError: true,
        maxDepth: 5,
        ...overrides,
      });
      const names = async (settings = config()) =>
        (await new ModuleDiscovery(tempDir).discoverModulesAdvanced(settings)).map(m => m.name);

      // What a file system that lists a directory in another order looks like
      const listDirectoriesBackwards = () => {
        const nodeFs = require('fs');
        const original = nodeFs.readdirSync;
        return jest
          .spyOn(nodeFs, 'readdirSync')
          .mockImplementation((...args: any[]) => original(...args).reverse());
      };

      const savedCI = process.env.CI;
      const savedActions = process.env.GITHUB_ACTIONS;
      afterEach(() => {
        jest.restoreAllMocks();
        if (savedCI === undefined) delete process.env.CI;
        else process.env.CI = savedCI;
        if (savedActions === undefined) delete process.env.GITHUB_ACTIONS;
        else process.env.GITHUB_ACTIONS = savedActions;
      });

      it('loads modules in the order of their paths, the same in CI, out of it and on a file system that lists differently', async () => {
        await write('zeta/index.ts', 'zeta');
        await write('leads/leads.module.ts', 'leads');
        await write('Users/index.ts', 'users');
        await write('admin/index.ts', 'admin');
        await write('a-b/index.ts', 'a-b');
        await write('a/index.ts', 'a');
        await write('a/reports/reports.module.ts', 'reports');
        await write('billing/billing.config.ts', 'billing');
        await write('top.module.ts', 'top');
        // Not module files of this application: hidden ones
        await write('.cache/index.ts', 'hidden-directory');
        await write('admin/.draft.module.ts', 'hidden-file');

        // By path, segment by segment, upper case before lower case:
        //   Users/index.ts, a/index.ts, a/reports/reports.module.ts,
        //   a-b/index.ts, admin/index.ts, billing/billing.config.ts,
        //   leads/leads.module.ts, top.module.ts, zeta/index.ts
        const expected = [
          'users',
          'a',
          'reports',
          'a-b',
          'admin',
          'billing',
          'leads',
          'top',
          'zeta',
        ];

        delete process.env.CI;
        delete process.env.GITHUB_ACTIONS;
        expect(await names()).toEqual(expected);

        process.env.CI = 'true';
        expect(await names()).toEqual(expected);
        delete process.env.CI;

        listDirectoriesBackwards();
        expect(await names()).toEqual(expected);
      });

      it('does not depend on the order the patterns are written in', async () => {
        await write('orders/index.ts', 'orders');
        await write('orders/audit/audit.module.ts', 'audit');
        await write('catalog/catalog.module.ts', 'catalog');

        const expected = ['catalog', 'audit', 'orders'];
        expect(await names(config({ patterns: ['**/index.ts', '**/*.module.ts'] }))).toEqual(
          expected
        );
        expect(await names(config({ patterns: ['**/*.module.ts', '**/index.ts'] }))).toEqual(
          expected
        );
      });

      it('orders paths segment by segment and by code unit, with no locale', () => {
        const paths = ['a.b/x', 'é/x', 'a-b/x', 'a/x', 'B/x', 'a', 'a/b/x', 'Z', 'a/B'];
        expect([...paths].sort(compareModulePaths)).toEqual([
          'B/x',
          'Z',
          'a',
          'a/B',
          'a/b/x',
          'a/x',
          'a-b/x',
          'a.b/x',
          'é/x',
        ]);
      });

      it('tells upper case from lower case on every file system', async () => {
        await write('gamma/Index.ts', 'capital-index');
        await write('gamma/thing.MODULE.ts', 'capital-module');
        await write('delta/index.ts', 'delta');

        expect(await names()).toEqual(['delta']);
        // A pattern that spells the name another way does not find it either
        expect(findModuleFiles(join(tempDir, 'modules'), ['gamma/index.ts'])).toEqual([]);
        expect(findModuleFiles(join(tempDir, 'modules'), ['gamma/Index.ts'])).toEqual([
          'gamma/Index.ts',
        ]);
      });

      it('matches a name that starts with a dot only when the pattern says so', async () => {
        await write('.cache/index.ts', 'hidden-directory');
        await write('visible/.draft.module.ts', 'hidden-file');
        await write('visible/index.ts', 'visible');
        const root = join(tempDir, 'modules');

        expect(findModuleFiles(root, ['**/*.ts'])).toEqual(['visible/index.ts']);
        expect(findModuleFiles(root, ['**/*'])).toEqual(['visible/index.ts']);
        expect(findModuleFiles(root, ['.cache/*.ts'])).toEqual(['.cache/index.ts']);
        expect(findModuleFiles(root, ['**/.*.ts'])).toEqual(['visible/.draft.module.ts']);
      });

      it('takes a linked file as a file, and enters a linked directory only when the pattern names it', async () => {
        await write('real/index.ts', 'real');
        const outside = join(tempDir, 'outside');
        await fs.mkdir(join(outside, 'shared'), { recursive: true });
        await fs.writeFile(join(outside, 'shared', 'index.ts'), moduleFile('shared'));
        await fs.writeFile(join(outside, 'linked.module.ts'), moduleFile('linked'));
        const root = join(tempDir, 'modules');
        await fs.symlink(join(outside, 'linked.module.ts'), join(root, 'linked.module.ts'));
        await fs.symlink(join(outside, 'shared'), join(root, 'shared'), 'dir');

        expect(await names()).toEqual(['linked', 'real']);
        expect(findModuleFiles(root, ['*/index.ts'])).toEqual(['real/index.ts']);
        expect(findModuleFiles(root, ['shared/index.ts', 'shared/**/*.ts'])).toEqual([
          'shared/index.ts',
        ]);
      });

      it('counts maxDepth in directories below the path: 0 is the files directly in it', async () => {
        await write('top.module.ts', 'top');
        await write('one/index.ts', 'one');
        await write('one/two/index.ts', 'two');
        await write('one/two/three/index.ts', 'three');

        expect(await names(config({ maxDepth: 0 }))).toEqual(['top']);
        expect(await names(config({ maxDepth: 1 }))).toEqual(['one', 'top']);
        expect(await names(config({ maxDepth: 2 }))).toEqual(['one', 'two', 'top']);
        expect(await names(config({ maxDepth: 5 }))).toEqual(['one', 'two', 'three', 'top']);
      });

      it('reads the pattern forms: *, ?, [set], {a,b} and **', async () => {
        for (const path of [
          'index.ts',
          'alpha/index.ts',
          'alpha/alpha.module.ts',
          'alpha/deep/down/x.module.ts',
          'beta/index.js',
          'a-b/index.ts',
          'a.b/index.ts',
          'zeta/helper.ts',
        ]) {
          await write(path, path);
        }
        const root = join(tempDir, 'modules');
        const found = (...patterns: string[]) => findModuleFiles(root, patterns);

        expect(found('*/index.ts')).toEqual(['a-b/index.ts', 'a.b/index.ts', 'alpha/index.ts']);
        expect(found('**/index.{ts,js}')).toEqual([
          'a-b/index.ts',
          'a.b/index.ts',
          'alpha/index.ts',
          'beta/index.js',
          'index.ts',
        ]);
        expect(found('a?b/index.ts')).toEqual(['a-b/index.ts', 'a.b/index.ts']);
        expect(found('[ab]*/index.*')).toEqual([
          'a-b/index.ts',
          'a.b/index.ts',
          'alpha/index.ts',
          'beta/index.js',
        ]);
        expect(found('[!a]*/*.ts')).toEqual(['zeta/helper.ts']);
        expect(found('{alpha,{beta,zeta}}/*.{ts,js}')).toEqual([
          'alpha/alpha.module.ts',
          'alpha/index.ts',
          'beta/index.js',
          'zeta/helper.ts',
        ]);
        expect(found('alpha/**')).toEqual([
          'alpha/alpha.module.ts',
          'alpha/deep/down/x.module.ts',
          'alpha/index.ts',
        ]);
        expect(found('./alpha/**/*.module.ts', 'alpha/*.module.ts')).toEqual([
          'alpha/alpha.module.ts',
          'alpha/deep/down/x.module.ts',
        ]);
        // No file: a pattern for directories, and one for a directory that is not there
        expect(found('alpha/', 'missing/**/*.ts')).toEqual([]);

        // A changed file's name is tested by the same rules
        const patterns = ['**/*.module.{ts,js}', '**/index.{ts,js}'];
        expect(matchesModulePattern('alpha/deep/down/x.module.ts', patterns)).toBe(true);
        expect(matchesModulePattern('index.js', patterns)).toBe(true);
        expect(matchesModulePattern('alpha\\index.ts', patterns)).toBe(true);
        expect(matchesModulePattern('alpha/Index.ts', patterns)).toBe(false);
        expect(matchesModulePattern('.cache/index.ts', patterns)).toBe(false);
        expect(matchesModulePattern('alpha/helper.ts', patterns)).toBe(false);
      });

      // Node.js 22 and later have a glob of their own, which discovery used
      // there. What it found for the documented patterns is what is found now.
      const nodeGlob = (fsPromises as any).glob;
      (typeof nodeGlob === 'function' ? it : it.skip)(
        'finds the files the Node.js glob finds for the documented patterns',
        async () => {
          for (const path of [
            'index.ts',
            'users/index.ts',
            'users/users.module.ts',
            'users/users.config.ts',
            'users/helper.ts',
            'orders/index.js',
            'orders/items/items.module.js',
            'orders/items/deeper/still/there.module.ts',
            'with space/index.ts',
            '.hidden/index.ts',
            'users/.draft.module.ts',
          ]) {
            await write(path, path);
          }
          const root = join(tempDir, 'modules');
          const viaNode = async (pattern: string) => {
            const files: string[] = [];
            for await (const file of nodeGlob(join(root, pattern))) {
              files.push(relative(root, file).split('\\').join('/'));
            }
            return files.sort(compareModulePaths);
          };

          for (const pattern of [
            '**/*.module.{ts,js}',
            '**/index.{ts,js}',
            '**/*.config.{ts,js}',
            '**/*.module.js',
            '**/modules/*.{ts,js}',
            '*/index.ts',
            'users/*.ts',
            '**/items/**/*.module.{ts,js}',
          ]) {
            expect({ pattern, files: findModuleFiles(root, [pattern]) }).toEqual({
              pattern,
              files: await viaNode(pattern),
            });
          }
        }
      );
    });

    describe('Dependency Resolution', () => {
      it('should resolve dependencies in correct order', async () => {
        // Create modules with dependencies
        await createTestModule(tempDir, 'auth', {
          name: 'auth',
          version: '1.0.0',
          dependencies: [],
        });

        await createTestModule(tempDir, 'users', {
          name: 'users',
          version: '1.0.0',
          dependencies: ['auth@1.0.0'],
        });

        await createTestModule(tempDir, 'orders', {
          name: 'orders',
          version: '1.0.0',
          dependencies: ['users@1.0.0', 'auth@1.0.0'],
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
          maxDepth: 5,
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
          dependencies: ['moduleB@1.0.0'],
        });

        await createTestModule(tempDir, 'moduleB', {
          name: 'moduleB',
          version: '1.0.0',
          dependencies: ['moduleA@1.0.0'],
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
          maxDepth: 5,
        };

        await expect(discovery.discoverModulesAdvanced(config)).rejects.toThrow(
          'Circular dependency detected'
        );
      });
    });

    describe('Custom Load Order', () => {
      it('should sort modules by custom priority', async () => {
        // Create modules with different priorities
        await createTestModule(tempDir, 'low-priority', {
          name: 'low-priority',
          version: '1.0.0',
          config: { priority: 1 },
        });

        await createTestModule(tempDir, 'high-priority', {
          name: 'high-priority',
          version: '1.0.0',
          config: { priority: 10 },
        });

        await createTestModule(tempDir, 'medium-priority', {
          name: 'medium-priority',
          version: '1.0.0',
          config: { priority: 5 },
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
          maxDepth: 5,
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
        await createTestFile(
          tempDir,
          'modules/invalid/index.ts',
          'export const invalid = "not a module";'
        );

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
          maxDepth: 5,
        };

        const modules = await discovery.discoverModulesAdvanced(config);

        expect(modules).toHaveLength(1);
        expect(modules[0].name).toBe('valid');
      });

      it('should throw error when failOnError is true and module loading fails', async () => {
        // Create invalid module file
        await createTestFile(
          tempDir,
          'modules/invalid/index.ts',
          'throw new Error("Module loading failed");'
        );

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
          maxDepth: 5,
        };

        await expect(discovery.discoverModulesAdvanced(config)).rejects.toThrow(
          'Failed to load module'
        );
      });
    });

    describe('Module Deduplication', () => {
      it('should remove duplicate modules', async () => {
        // Create same module in different locations
        await createTestModule(tempDir, 'users', { name: 'users', version: '1.0.0' });
        await createTestFile(
          tempDir,
          'modules/duplicate/users.module.ts',
          'export default { name: "users", version: "1.0.0" };'
        );

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
          maxDepth: 5,
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
        extensions: ['.ts', '.js'],
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
