import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createModuleConfig } from '../../../src/core/config/utils.js';
import { resetConfig } from '../../../src/core/config/index.js';
import { z } from 'zod';

describe('Config Utils - createModuleConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
    // Reset global config state
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const TestModuleSchema = z.object({
    apiKey: z.string().default('default-key'),
    timeout: z.number().default(3000),
    retries: z.number().default(3),
    enabled: z.boolean().default(true),
    features: z.array(z.string()).default([]),
  });

  describe('createModuleConfig function', () => {
    it('should use default config when no environment variables or global config', () => {
      const result = createModuleConfig(
        TestModuleSchema,
        { apiKey: 'from-default', retries: 5 },
        'TEST_'
      );

      expect(result.apiKey).toBe('from-default');
      expect(result.retries).toBe(5);
      expect(result.timeout).toBe(3000); // From schema default
      expect(result.enabled).toBe(true); // From schema default
    });

    it('should override defaults with environment variables', () => {
      process.env.TEST_API_KEY = 'env-secret';
      process.env.TEST_TIMEOUT = '5000';
      process.env.TEST_ENABLED = 'false';

      const result = createModuleConfig(
        TestModuleSchema,
        { apiKey: 'from-default', retries: 5 },
        'TEST_'
      );

      expect(result.apiKey).toBe('env-secret');
      expect(result.timeout).toBe(5000); // Coerced to number
      expect(result.enabled).toBe(false); // Coerced to boolean
      expect(result.retries).toBe(5); // From default config
    });

    it('should handle type coercion for environment variables', () => {
      process.env.TEST_TIMEOUT = '7500';
      process.env.TEST_ENABLED = 'true';
      process.env.TEST_RETRIES = '10';

      const result = createModuleConfig(TestModuleSchema, {}, 'TEST_');

      expect(result.timeout).toBe(7500);
      expect(typeof result.timeout).toBe('number');
      expect(result.enabled).toBe(true);
      expect(typeof result.enabled).toBe('boolean');
      expect(result.retries).toBe(10);
      expect(typeof result.retries).toBe('number');
    });

    it('should work without environment prefix', () => {
      const result = createModuleConfig(TestModuleSchema, { apiKey: 'no-prefix-test' });

      expect(result.apiKey).toBe('no-prefix-test');
      expect(result.timeout).toBe(3000); // Schema default
    });

    it('should validate the final configuration against schema', () => {
      process.env.TEST_API_KEY = 'valid-key';
      process.env.TEST_TIMEOUT = '2000';

      expect(() => {
        createModuleConfig(TestModuleSchema, {}, 'TEST_');
      }).not.toThrow();
    });

    it('should throw error for invalid configuration that fails schema validation', () => {
      // This test ensures that even after type coercion, schema validation still catches invalid data
      const StrictSchema = z.object({
        timeout: z.number().min(1000).max(10000), // Strict range
        apiKey: z.string().min(5),
      });

      process.env.TEST_TIMEOUT = '50'; // Too low
      process.env.TEST_API_KEY = 'x'; // Too short

      expect(() => {
        createModuleConfig(StrictSchema, {}, 'TEST_');
      }).toThrow();
    });

    it('should handle underscore to camelCase conversion', () => {
      process.env.TEST_API_KEY = 'underscore-test';
      process.env.TEST_MAX_RETRIES = '5';

      const ExtendedSchema = z.object({
        apiKey: z.string(),
        maxRetries: z.number().default(3),
      });

      const result = createModuleConfig(ExtendedSchema, {}, 'TEST_');

      expect(result.apiKey).toBe('underscore-test');
      expect(result.maxRetries).toBe(5);
    });

    it('should handle JSON values in environment variables', () => {
      process.env.TEST_FEATURES = '["feature1", "feature2"]';

      const result = createModuleConfig(TestModuleSchema, {}, 'TEST_');

      expect(result.features).toEqual(['feature1', 'feature2']);
      expect(Array.isArray(result.features)).toBe(true);
    });

    it('should ignore environment variables without the specified prefix', () => {
      process.env.OTHER_API_KEY = 'should-be-ignored';
      process.env.TEST_API_KEY = 'should-be-used';

      const result = createModuleConfig(TestModuleSchema, { apiKey: 'default' }, 'TEST_');

      expect(result.apiKey).toBe('should-be-used');
    });
  });
});
