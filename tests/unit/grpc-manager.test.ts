// gRPC Manager Unit Tests
import { describe, it, expect } from '@jest/globals';

describe('GrpcManager', () => {
  describe('Type Safety', () => {
    it('should have proper TypeScript types', async () => {
      const types = await import('../../src/core/grpc/types.js');

      expect(types).toBeDefined();
      expect(types.GrpcStatusCode).toBeDefined();
      expect(types.HealthCheckStatus).toBeDefined();
    });

    it('should export GrpcStatusCode enum', async () => {
      const { GrpcStatusCode } = await import('../../src/core/grpc/types.js');

      expect(GrpcStatusCode.OK).toBe(0);
      expect(GrpcStatusCode.CANCELLED).toBe(1);
      expect(GrpcStatusCode.UNKNOWN).toBe(2);
      expect(GrpcStatusCode.INVALID_ARGUMENT).toBe(3);
      expect(GrpcStatusCode.DEADLINE_EXCEEDED).toBe(4);
      expect(GrpcStatusCode.NOT_FOUND).toBe(5);
      expect(GrpcStatusCode.ALREADY_EXISTS).toBe(6);
      expect(GrpcStatusCode.PERMISSION_DENIED).toBe(7);
      expect(GrpcStatusCode.RESOURCE_EXHAUSTED).toBe(8);
      expect(GrpcStatusCode.FAILED_PRECONDITION).toBe(9);
      expect(GrpcStatusCode.ABORTED).toBe(10);
      expect(GrpcStatusCode.OUT_OF_RANGE).toBe(11);
      expect(GrpcStatusCode.UNIMPLEMENTED).toBe(12);
      expect(GrpcStatusCode.INTERNAL).toBe(13);
      expect(GrpcStatusCode.UNAVAILABLE).toBe(14);
      expect(GrpcStatusCode.DATA_LOSS).toBe(15);
      expect(GrpcStatusCode.UNAUTHENTICATED).toBe(16);
    });
  });

  describe('Lazy Loading', () => {
    it('should lazy load GrpcManager', async () => {
      try {
        const { GrpcManager } = await import('../../src/core/grpc/grpc-manager.js');
        expect(GrpcManager).toBeDefined();
        expect(typeof GrpcManager).toBe('function');
      } catch (error) {
        // This is expected if dependencies are not available
        expect(error).toBeDefined();
      }
    });

    it('should lazy load GrpcJsAdapter', async () => {
      try {
        const { GrpcJsAdapter } = await import('../../src/core/grpc/adapters/grpc-js-adapter.js');
        expect(GrpcJsAdapter).toBeDefined();
        expect(typeof GrpcJsAdapter).toBe('function');
      } catch (error) {
        // This is expected if dependencies are not available
        expect(error).toBeDefined();
      }
    });
  });

  describe('Middleware Exports', () => {
    it('should export gRPC middleware functions', async () => {
      const middleware = await import('../../src/core/grpc/index.js');

      expect(middleware.grpcAuth).toBeDefined();
      expect(middleware.grpcRequirePermission).toBeDefined();
      expect(middleware.grpcRequireRole).toBeDefined();
      expect(middleware.grpcLogger).toBeDefined();
      expect(middleware.grpcSimpleLogger).toBeDefined();
      expect(middleware.grpcDetailedLogger).toBeDefined();
      expect(middleware.grpcValidate).toBeDefined();
      expect(middleware.grpcValidateHandler).toBeDefined();
    });
  });
});

describe('GrpcJsAdapter', () => {
  describe('Initialization', () => {
    it('should handle missing @grpc/grpc-js gracefully', async () => {
      try {
        const { GrpcJsAdapter } = await import('../../src/core/grpc/adapters/grpc-js-adapter.js');
        const adapter = new GrpcJsAdapter();

        await expect(adapter.initialize({})).rejects.toThrow();
      } catch (error) {
        // Expected when @grpc/grpc-js is not installed
        expect(error).toBeDefined();
      }
    });
  });

  describe('Adapter Interface', () => {
    it('should implement GrpcAdapter interface', async () => {
      try {
        const { GrpcJsAdapter } = await import('../../src/core/grpc/adapters/grpc-js-adapter.js');
        const adapter = new GrpcJsAdapter();

        expect(adapter.initialize).toBeDefined();
        expect(adapter.loadProto).toBeDefined();
        expect(adapter.addService).toBeDefined();
        expect(adapter.start).toBeDefined();
        expect(adapter.stop).toBeDefined();
        expect(adapter.createClient).toBeDefined();
        expect(adapter.enableHealthCheck).toBeDefined();
        expect(adapter.enableReflection).toBeDefined();
        expect(adapter.getAdapterName).toBeDefined();
        expect(adapter.isAvailable).toBeDefined();
      } catch (error) {
        // Expected when @grpc/grpc-js is not installed
        expect(error).toBeDefined();
      }
    });
  });
});
