// Integration Tests - File-based auto routing (config.routing + loadRoutes)
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp, rm } from 'fs/promises';
import { createApp, resetConfig } from '../../src/index.js';
import { loadConfig } from '../../src/core/config/index.js';
import { validateConfig } from '../../src/core/config/config-validator.js';
import { DEFAULT_CONFIG } from '../../src/core/config/schema.js';
import { closeApp } from '../setup.js';

describe('File-based auto routing', () => {
  const originalEnv = process.env;
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    // Ensure no routing env leaks in from the shell/CI
    delete process.env.MORO_ROUTING;
    delete process.env.MORO_AUTO_ROUTING;
    delete process.env.MORO_ROUTING_PATHS;
    resetConfig();

    tempDir = await mkdtemp(join(tmpdir(), 'moro-routing-test-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    resetConfig();
  });

  // ---------------------------------------------------------------------------
  // Layer 1: config resolution + validation
  // ---------------------------------------------------------------------------
  describe('config resolution', () => {
    it('defaults routing to true', () => {
      const config = loadConfig();
      expect(config.routing).toBe(true);
    });

    it('MORO_ROUTING=false disables routing', () => {
      process.env.MORO_ROUTING = 'false';
      const config = loadConfig();
      expect(config.routing).toEqual({ enabled: false });
    });

    it('MORO_AUTO_ROUTING is honored as an alias', () => {
      process.env.MORO_AUTO_ROUTING = 'false';
      const config = loadConfig();
      expect(config.routing).toEqual({ enabled: false });
    });

    it('MORO_ROUTING_PATHS sets custom scan paths (comma-separated, trimmed)', () => {
      process.env.MORO_ROUTING_PATHS = './a, ./b';
      const config = loadConfig();
      expect(config.routing).toEqual({ enabled: true, paths: ['./a', './b'] });
    });
  });

  describe('validateConfig (regression: routing must not be stripped)', () => {
    it('preserves the boolean default instead of dropping it', () => {
      // Before the fix, validateConfig rebuilt the object field-by-field and
      // silently dropped `routing`, leaving it undefined at runtime.
      expect(validateConfig({ ...DEFAULT_CONFIG }).routing).toBe(true);
    });

    it('accepts a boolean shorthand', () => {
      expect(validateConfig({ ...DEFAULT_CONFIG, routing: false }).routing).toBe(false);
    });

    it('accepts an object and defaults enabled to true when omitted', () => {
      expect(validateConfig({ ...DEFAULT_CONFIG, routing: { paths: ['./x'] } }).routing).toEqual({
        enabled: true,
        paths: ['./x'],
      });
    });

    it('rejects an invalid routing type', () => {
      expect(() => validateConfig({ ...DEFAULT_CONFIG, routing: 123 as any })).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Layer 2: the loadRoutes() loader (previously untested)
  // ---------------------------------------------------------------------------
  describe('loadRoutes()', () => {
    beforeEach(() => {
      (globalThis as any).__moroLoaded = [];
    });

    afterEach(() => {
      delete (globalThis as any).__moroLoaded;
    });

    it('imports index files in subdirectories and top-level files, skipping test files', async () => {
      const routesDir = join(tempDir, 'routes');
      await fs.mkdir(join(routesDir, 'users'), { recursive: true });
      await fs.writeFile(
        join(routesDir, 'users', 'index.ts'),
        `(globalThis as any).__moroLoaded.push('users'); export {};`
      );
      await fs.writeFile(
        join(routesDir, 'health.ts'),
        `(globalThis as any).__moroLoaded.push('health'); export {};`
      );
      // Subdir without an index file should be ignored
      await fs.mkdir(join(routesDir, 'noindex'), { recursive: true });
      await fs.writeFile(
        join(routesDir, 'noindex', 'helper.ts'),
        `(globalThis as any).__moroLoaded.push('helper'); export {};`
      );
      // Test/spec files at the top level are skipped
      await fs.writeFile(
        join(routesDir, 'health.test.ts'),
        `(globalThis as any).__moroLoaded.push('ignored'); export {};`
      );

      const app = await createApp({ logger: { level: 'error' } });
      await app.loadRoutes(routesDir);

      expect(((globalThis as any).__moroLoaded as string[]).sort()).toEqual(['health', 'users']);
      await closeApp(app);
    });

    it('is a silent no-op when the directory does not exist', async () => {
      const app = await createApp({ logger: { level: 'error' } });
      await expect(app.loadRoutes(join(tempDir, 'does-not-exist'))).resolves.toBeUndefined();
      expect((globalThis as any).__moroLoaded).toEqual([]);
      await closeApp(app);
    });
  });

  // ---------------------------------------------------------------------------
  // Layer 3: ensureRoutesLoaded() wiring (config -> loadRoutes)
  // ---------------------------------------------------------------------------
  describe('startup wiring (ensureRoutesLoaded)', () => {
    it('auto-loads ./src/routes by default', async () => {
      const app = await createApp({ logger: { level: 'error' } });
      const spy = jest.spyOn(app as any, 'loadRoutes').mockResolvedValue(undefined as never);

      await (app as any).ensureRoutesLoaded();

      expect(spy).toHaveBeenCalledWith('./src/routes');
      await closeApp(app);
    });

    it('does not load any routes when disabled', async () => {
      process.env.MORO_ROUTING = 'false';
      resetConfig();
      const app = await createApp({ logger: { level: 'error' } });
      const spy = jest.spyOn(app as any, 'loadRoutes').mockResolvedValue(undefined as never);

      await (app as any).ensureRoutesLoaded();

      expect(spy).not.toHaveBeenCalled();
      await closeApp(app);
    });

    it('uses custom paths from MORO_ROUTING_PATHS', async () => {
      process.env.MORO_ROUTING_PATHS = './api/routes';
      resetConfig();
      const app = await createApp({ logger: { level: 'error' } });
      const spy = jest.spyOn(app as any, 'loadRoutes').mockResolvedValue(undefined as never);

      await (app as any).ensureRoutesLoaded();

      expect(spy).toHaveBeenCalledWith('./api/routes');
      await closeApp(app);
    });

    it('is idempotent across repeated calls', async () => {
      const app = await createApp({ logger: { level: 'error' } });
      const spy = jest.spyOn(app as any, 'loadRoutes').mockResolvedValue(undefined as never);

      await (app as any).ensureRoutesLoaded();
      await (app as any).ensureRoutesLoaded();

      expect(spy).toHaveBeenCalledTimes(1);
      await closeApp(app);
    });

    it('never throws if a routes directory fails to load (non-fatal startup)', async () => {
      const app = await createApp({ logger: { level: 'error' } });
      jest.spyOn(app as any, 'loadRoutes').mockRejectedValue(new Error('boom') as never);

      await expect((app as any).ensureRoutesLoaded()).resolves.toBeUndefined();
      await closeApp(app);
    });
  });
});
