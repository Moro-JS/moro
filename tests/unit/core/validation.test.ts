// @ts-nocheck
// Unit Tests - MoroJS Validation Integration
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { validate, body, query, params, z, ValidationConfig } from '../../../src/index.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { packageNotice } from '../../../src/core/utilities/package-notices.js';

describe('MoroJS Validation Integration', () => {
  // Mock HTTP objects for testing
  const createMockRequest = (data: any = {}): any => ({
    method: 'GET',
    path: '/test',
    query: {},
    params: {},
    body: {},
    headers: {},
    ...data,
  });

  const createMockResponse = (): any => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      headersSent: false,
    };
    return res;
  };

  describe('validate function', () => {
    it('should validate body successfully', async () => {
      const schema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
      });

      const config: ValidationConfig = { body: schema };
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({
        body: { name: 'John Doe', email: 'john@example.com' },
      });
      const res = createMockResponse();

      const wrappedHandler = validate(config, handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { name: 'John Doe', email: 'john@example.com' },
        }),
        res
      );
    });

    it('should return validation error for invalid body', async () => {
      const schema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
      });

      const config: ValidationConfig = { body: schema };
      const handler = jest.fn();

      const req = createMockRequest({
        body: { name: 'J', email: 'invalid-email' },
      });
      const res = createMockResponse();

      const wrappedHandler = validate(config, handler);
      await wrappedHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Validation failed for body',
        })
      );
      expect(handler).not.toHaveBeenCalled();
    });

    it('should validate query parameters with coercion', async () => {
      const schema = z.object({
        limit: z.coerce.number().min(1).max(100).default(10),
        search: z.string().optional(),
      });

      const config: ValidationConfig = { query: schema };
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({
        query: { limit: '25', search: 'test' },
      });
      const res = createMockResponse();

      const wrappedHandler = validate(config, handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { limit: 25, search: 'test' },
        }),
        res
      );
    });

    it('should validate path parameters', async () => {
      const schema = z.object({
        id: z.string().uuid(),
        category: z.enum(['user', 'admin']),
      });

      const config: ValidationConfig = { params: schema };
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({
        params: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          category: 'user',
        },
      });
      const res = createMockResponse();

      const wrappedHandler = validate(config, handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          params: {
            id: '123e4567-e89b-12d3-a456-426614174000',
            category: 'user',
          },
        }),
        res
      );
    });
  });

  describe('convenience functions', () => {
    it('body() should create body validation wrapper', async () => {
      const schema = z.object({ name: z.string() });
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({ body: { name: 'John' } });
      const res = createMockResponse();

      const wrappedHandler = body(schema)(handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { name: 'John' },
        }),
        res
      );
    });

    it('query() should create query validation wrapper', async () => {
      const schema = z.object({ limit: z.coerce.number() });
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({ query: { limit: '10' } });
      const res = createMockResponse();

      const wrappedHandler = query(schema)(handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { limit: 10 },
        }),
        res
      );
    });

    it('params() should create params validation wrapper', async () => {
      const schema = z.object({ id: z.string().uuid() });
      const handler = jest.fn().mockResolvedValue({ success: true });

      const req = createMockRequest({
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
      });
      const res = createMockResponse();

      const wrappedHandler = params(schema)(handler);
      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        }),
        res
      );
    });
  });
});

// Zod is the application's own package. When the installed version has a
// published advisory the application is told once, the first time `z` is used.
describe('the installed zod version', () => {
  const LOGGER = '../../../src/core/logger/index.js';
  const roots: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  // `z` and the OpenAPI converter, loaded afresh in a directory where a
  // stand-in zod of the given version is installed
  async function loadWithZod(version: string) {
    const root = mkdtempSync(join(tmpdir(), 'moro-zod-'));
    roots.push(root);
    const dir = join(root, 'node_modules', 'zod');
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'zod', version, main: 'lib/index.js' })
    );
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      "module.exports = { z: { string: () => 'a string schema' } };"
    );
    jest.spyOn(process, 'cwd').mockReturnValue(root);

    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    jest.doMock(LOGGER, () => ({ createFrameworkLogger: () => log }));
    try {
      let validation!: typeof import('../../../src/core/validation/index.js');
      let docs!: typeof import('../../../src/core/docs/zod-to-openapi.js');
      await jest.isolateModulesAsync(async () => {
        validation = await import('../../../src/core/validation/index.js');
        docs = await import('../../../src/core/docs/zod-to-openapi.js');
      });
      return {
        z: validation.z,
        zodToOpenAPI: docs.zodToOpenAPI,
        warnings: () => log.warn.mock.calls.map(call => String(call[0])),
      };
    } finally {
      jest.dontMock(LOGGER);
    }
  }

  it('says once when the version has a known problem, and keeps working', async () => {
    const loaded = await loadWithZod('3.22.3');
    expect(loaded.warnings()).toEqual([]); // nothing until zod is loaded

    expect(loaded.z.string()).toBe('a string schema');
    loaded.z.string();
    loaded.zodToOpenAPI({}); // the converter loads zod too

    expect(loaded.warnings()).toHaveLength(1);
    expect(loaded.warnings()[0]).toContain('zod 3.22.3');
    expect(loaded.warnings()[0]).toContain('4.6.6');
  });

  it('says nothing for a version without one', async () => {
    const loaded = await loadWithZod('4.6.6');
    expect(loaded.z.string()).toBe('a string schema');
    loaded.zodToOpenAPI({});
    expect(loaded.warnings()).toEqual([]);
  });

  it('knows which versions are affected', () => {
    for (const version of ['3.22.3', '3.25.76', '4.0.0', '4.3.6', '4.6.5', '4.6.6-beta.1']) {
      expect(packageNotice('zod', version)).toContain(`zod ${version}`);
    }
    for (const version of ['4.6.6', '4.6.7', '4.7.0', '5.0.0', 'not-a-version']) {
      expect(packageNotice('zod', version)).toBeUndefined();
    }
    // Zod 3 has no fixed release; a zod 4 application updates within its major
    expect(packageNotice('zod', '3.25.76')).toContain('No zod 3 release has the fix');
    expect(packageNotice('zod', '4.3.6')).toContain('Update to zod 4.6.6 or later');
    // A package nothing is known about
    expect(packageNotice('joi', '17.13.9')).toBeUndefined();
  });
});
