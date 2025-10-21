// Test Setup - Global configuration and utilities for MoroJS tests
import { jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import { destroyGlobalLogger, logger } from '../src/core/logger';
import { UnifiedRouter } from '../src/core/routing/unified-router.js';
import { ObjectPoolManager } from '../src/core/pooling/object-pool-manager.js';

// Set up minimal test environment configuration for MoroJS
process.env.NODE_ENV = 'development';
process.env.MORO_SERVER_PORT = '0'; // Use dynamic port
process.env.MORO_SERVER_HOST = 'localhost';
process.env.MORO_LOGGER_LEVEL = 'error'; // Reduce noise in tests

// Extend Jest timeout for integration tests
jest.setTimeout(10000);

// Global test utilities
declare global {
  var testPort: number;
}

// Generate a unique port for each test suite to avoid conflicts
globalThis.testPort = 3000 + Math.floor(Math.random() * 1000);

// Mock console methods for cleaner test output (optional)
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  // Reset singletons before each test to ensure test isolation
  UnifiedRouter.reset();
  ObjectPoolManager.reset();

  // Reset console mocks before each test
  console.log = jest.fn();
  console.error = jest.fn();
  console.warn = jest.fn();
});

afterEach(async () => {
  // Clean up logger resources FIRST to prevent Jest open handles
  // destroy() clears all timeouts and flushes buffer
  try {
    destroyGlobalLogger();
  } catch {
    // Ignore cleanup errors
  }

  // Restore console methods after each test
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

// Global cleanup after all tests complete
afterAll(async () => {
  // Final cleanup of logger resources
  // destroy() clears all timeouts and flushes buffer
  try {
    destroyGlobalLogger();
  } catch {
    // Ignore cleanup errors
  }
});

// Global test helpers
export const createTestPort = () => 3000 + Math.floor(Math.random() * 1000);

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Properly close a Moro app instance with logger cleanup
 * Use this in tests instead of app.core.httpServer.close()
 */
export const closeApp = async (app: any): Promise<void> => {
  try {
    // Close HTTP server with timeout to prevent hanging
    if (app && app.core && app.core.httpServer) {
      await Promise.race([
        new Promise<void>(resolve => {
          app.core.httpServer.close(() => resolve());
        }),
        new Promise<void>(resolve => setTimeout(resolve, 1000)), // 1 second timeout
      ]);
    }

    // Destroy logger to clear all timeouts and prevent open handles
    // destroy() already flushes the buffer internally
    if (app && app.logger && typeof app.logger.destroy === 'function') {
      app.logger.destroy();
    }
  } catch (error) {
    // Ignore close errors in tests
  }
};

export const waitForServer = async (port: number, maxAttempts = 10): Promise<boolean> => {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) return true;
    } catch {
      // Server not ready yet
    }
    await delay(100);
  }
  return false;
};
