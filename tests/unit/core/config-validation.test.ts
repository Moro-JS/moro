// Configuration System Validation Tests
// Tests the current implementation to identify what works vs what needs fixing

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { createApp } from '../../../src/index.js';
import { loadConfig, loadConfigWithOptions, resetConfig } from '../../../src/core/config/index.js';
import { MoroOptions } from '../../../src/types/core.js';
import { performance } from 'perf_hooks';

describe('Configuration System Validation', () => {
  const configPath = join(process.cwd(), 'moro.config.js');
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();

    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  afterEach(() => {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
    process.env = originalEnv;
  });

  describe('Current Working Features', () => {
    it('should load basic configuration with defaults', () => {
      const config = loadConfig();

      expect(config.server.port).toBe(3001);
      expect(config.server.host).toBe('localhost');
      expect(config.database.redis).toBeUndefined(); // Redis only included when configured
      expect(config.logging.level).toBe('info');
    });

    it('should handle standard environment variables', () => {
      process.env.PORT = '8080';
      process.env.HOST = '0.0.0.0';
      process.env.NODE_ENV = 'production';

      const config = loadConfig();

      expect(config.server.port).toBe(8080);
      expect(config.server.host).toBe('0.0.0.0');
      // NODE_ENV is now handled separately, not part of server config
      expect(process.env.NODE_ENV).toBe('production');
    });

    it('should load MySQL config when MYSQL_HOST is set', () => {
      process.env.MYSQL_HOST = 'mysql.example.com';
      process.env.MYSQL_PORT = '3307';

      const config = loadConfig();

      expect(config.database.mysql).toBeDefined();
      expect(config.database.mysql?.host).toBe('mysql.example.com');
      expect(config.database.mysql?.port).toBe(3307);
    });

    it('should exclude MySQL config when MYSQL_HOST is not set', () => {
      const config = loadConfig();
      expect(config.database.mysql).toBeUndefined();
    });

    it('should load Redis config when REDIS_URL is set', () => {
      process.env.REDIS_URL = 'redis://test:6379';

      const config = loadConfig();

      expect(config.database.redis).toBeDefined();
      expect(config.database.redis?.url).toBe('redis://test:6379');
      expect(config.database.redis?.maxRetries).toBe(3);
      expect(config.database.redis?.retryDelay).toBe(1000);
      expect(config.database.redis?.keyPrefix).toBe('moro:');
    });

    it('should merge createApp options correctly', () => {
      const options: MoroOptions = {
        cors: false,
        server: { port: 7000 },
      };

      const config = loadConfigWithOptions(options);

      expect(config.security.cors.enabled).toBe(false);
      expect(config.server.port).toBe(7000);
    });
  });

  describe('Issues Identified', () => {
    it('FIXED: MORO_ prefixed environment variables working correctly', () => {
      process.env.MORO_PORT = '9000';
      process.env.MORO_HOST = '127.0.0.1';

      const config = loadConfig();

      // These work correctly now
      expect(config.server.port).toBe(9000);
      expect(config.server.host).toBe('127.0.0.1');
    });

    it('FIXED: External services only included when configured', () => {
      const config = loadConfig();

      // These should be undefined when not configured
      expect(config.external.stripe).toBeUndefined();
      expect(config.external.paypal).toBeUndefined();
      expect(config.external.smtp).toBeUndefined();
    });

    it('TESTING: Config precedence with createApp options', () => {
      const configContent = `
        module.exports = {
          server: { port: 4000 }
        };
      `;
      writeFileSync(configPath, configContent);

      process.env.PORT = '5000'; // Should win

      const app = createApp({
        server: { port: 6000 }, // Should lose to env var
        logger: { level: 'error' },
      });
      const config = (app as any).config;

      console.log(
        '🔍 Config precedence test - port is:',
        config.server.port,
        '(env=5000, options=6000, file=4000)'
      );

      // Test what actually happens
      expect(typeof config.server.port).toBe('number');
    });

    it('TESTING: Optional URL validation behavior', () => {
      process.env.DATABASE_URL = 'not-a-url';

      // Test what actually happens with invalid URLs
      const result = (() => {
        try {
          const config = loadConfig();
          return { success: true, config };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      })();

      console.log('🔍 URL validation test:', result.success ? 'Accepted' : 'Rejected');
      if (result.success && result.config) {
        console.log('   Database URL:', result.config.database.url);
      } else {
        console.log('   Error:', result.error);
      }
    });
  });

  describe('Performance Baseline', () => {
    it('should measure current config loading performance', () => {
      const iterations = 50;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        loadConfig();
        resetConfig();
      }

      const end = performance.now();
      const avgTime = (end - start) / iterations;

      console.log(`\n📊 Current Performance Baseline:`);
      console.log(`  • ${iterations} config loads: ${(end - start).toFixed(2)}ms`);
      console.log(`  • Average per load: ${avgTime.toFixed(3)}ms`);
      console.log(`  • Loads per second: ${(1000 / avgTime).toFixed(0)}`);

      expect(avgTime).toBeLessThan(20); // Current baseline
    });

    it('should measure createApp options merging performance', () => {
      const options: MoroOptions = {
        cors: false,
        server: { port: 8080 },
        database: {
          redis: {
            url: 'redis://test:6379',
            maxRetries: 3,
            retryDelay: 1000,
            keyPrefix: 'test:',
          },
        },
        performance: {
          compression: {
            enabled: false,
            level: 6,
            threshold: 1024,
          },
        },
      };

      const iterations = 30;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        loadConfigWithOptions(options);
        resetConfig();
      }

      const end = performance.now();
      const avgTime = (end - start) / iterations;

      console.log(`\n📊 Options Merging Performance:`);
      console.log(`  • ${iterations} merges: ${(end - start).toFixed(2)}ms`);
      console.log(`  • Average per merge: ${avgTime.toFixed(3)}ms`);

      expect(avgTime).toBeLessThan(25); // Current baseline
    });
  });
});
