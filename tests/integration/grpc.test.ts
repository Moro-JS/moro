// gRPC Integration Tests
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createApp } from '../../src/index.js';
import type { Moro } from '../../src/moro.js';

describe('gRPC Integration', () => {
  describe('gRPC Initialization', () => {
    let app: Moro;

    beforeAll(async () => {
      app = createApp({
        server: {
          port: 3999,
        },
        logger: { level: 'error' },
      });
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
    });

    it('should gracefully handle gRPC when packages are not installed', async () => {
      // Try to initialize gRPC without @grpc/grpc-js installed
      // Should throw a helpful error message
      try {
        await app.grpcInit({
          port: 50051,
          adapter: 'grpc-js',
        });

        // If we get here, gRPC packages are installed
        expect(app.getGrpcStats).toBeDefined();
        expect(app.getGrpcServices).toBeDefined();
      } catch (error) {
        // Expected error when @grpc/grpc-js is not installed
        expect((error as Error).message).toContain('@grpc/grpc-js');
        expect((error as Error).message).toContain('npm install');
      }
    });

    it('should have gRPC methods available', () => {
      expect(app.grpcInit).toBeDefined();
      expect(app.grpcService).toBeDefined();
      expect(app.startGrpc).toBeDefined();
      expect(app.stopGrpc).toBeDefined();
      expect(app.createGrpcClient).toBeDefined();
      expect(app.getGrpcStats).toBeDefined();
      expect(app.getGrpcServices).toBeDefined();
    });

    it('should return null for gRPC stats when not initialized', () => {
      const stats = app.getGrpcStats();
      expect(stats).toBeNull();
    });

    it('should return empty array for gRPC services when not initialized', () => {
      const services = app.getGrpcServices();
      expect(services).toEqual([]);
    });
  });

  describe('gRPC Error Handling', () => {
    let app: Moro;

    beforeAll(async () => {
      app = createApp({
        server: {
          port: 4000,
        },
        logger: { level: 'error' },
      });
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
    });

    it('should throw error when registering service without initialization', async () => {
      await expect(
        app.grpcService('./proto/test.proto', 'TestService', {})
      ).rejects.toThrow('not initialized');
    });

    it('should throw error when creating client without initialization', async () => {
      await expect(
        app.createGrpcClient('./proto/test.proto', 'TestService', 'localhost:50051')
      ).rejects.toThrow('not initialized');
    });
  });
});

describe('gRPC Types Export', () => {
  it('should export gRPC types from main package', async () => {
    const exports = await import('../../src/index.js');

    // Check type exports (these won't be runtime values, just verify they're in the module)
    expect(exports).toBeDefined();
    expect(typeof exports.createApp).toBe('function');
  });
});

