/* eslint-disable */
// Integration Test - Config File Loading
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { createApp } from '../../src';
import { resetConfig } from '../../src/core/config';

describe('Config File Integration', () => {
  const configPath = join(process.cwd(), 'moro.config.js');
  const originalEnv = process.env;

  afterEach(() => {
    // Clean up test config file
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
    // Restore environment
    process.env = originalEnv;
  });

  it('should work without config file (existing behavior)', async () => {
    // Clean environment first
    delete process.env.PORT;
    delete process.env.HOST;

    // Set env var
    process.env.PORT = '4000';

    resetConfig();
    const app = await createApp({ logger: { level: 'error' } });
    const config = (app as any).config;

    expect(config.server.port).toBe(4000);
  });

  it('should load and apply config file values', async () => {
    // Clean environment first
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;

    // Set environment for the test
    process.env.NODE_ENV = 'staging';

    // Create config file (no longer includes environment)
    const configContent = `
      module.exports = {
        server: {
          port: 3500,
          host: '0.0.0.0'
        },
        logging: {
          level: 'warn'
        }
      };
    `;

    writeFileSync(configPath, configContent);

    resetConfig();
    const app = await createApp({ logger: { level: 'error' } });
    const config = (app as any).config;

    // Config file values should be applied
    expect(config.server.port).toBe(3500);
    expect(config.server.host).toBe('0.0.0.0');
    // Environment is now controlled by NODE_ENV, not config
    expect(process.env.NODE_ENV).toBe('staging');
    expect(config.logging.level).toBe('error');
  });

  it('should gracefully handle invalid config files', async () => {
    // Create invalid config file
    const configContent = `
      module.exports = "invalid config";
    `;

    writeFileSync(configPath, configContent);

    // Should not throw error, just fall back to env vars
    await expect(createApp({ logger: { level: 'error' } })).resolves.toBeDefined();
  });

  it('should handle config file with syntax errors', async () => {
    // Create config file with syntax error
    const configContent = `
      module.exports = {
        server: {
          port: 3000
          // missing comma - syntax error
          host: 'localhost'
        }
      };
    `;

    writeFileSync(configPath, configContent);

    // Should not throw error, just fall back to env vars
    await expect(createApp({ logger: { level: 'error' } })).resolves.toBeDefined();
  });
});
