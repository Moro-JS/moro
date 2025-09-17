// Test Setup - Global configuration and utilities for MoroJS tests
import { jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import { logger } from '../src/core/logger';

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
  // Reset console mocks before each test
  console.log = jest.fn();
  console.error = jest.fn();
  console.warn = jest.fn();
});

afterEach(() => {
  // Restore console methods after each test
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

afterAll(() => {
  // Cleanup logger to prevent Jest open handles
  logger.cleanup();
});

// Global test helpers
export const createTestPort = () => 3000 + Math.floor(Math.random() * 1000);

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
