// gRPC Module - Public API
// Central export point for gRPC functionality in MoroJS

export { GrpcManager } from './grpc-manager.js';
export type { GrpcAdapter } from './grpc-adapter.js';

// Export types
export type {
  GrpcOptions,
  GrpcCall,
  GrpcCallback,
  GrpcMetadata,
  GrpcError,
  GrpcStatusCode,
  GrpcCredentials,
  GrpcServer,
  GrpcClient,
  GrpcClientOptions,
  GrpcInterceptor,
  ServiceImplementation,
  ServiceDefinition,
  ServiceRegistration,
  MethodDefinition,
  UnaryHandler,
  ServerStreamingHandler,
  ClientStreamingHandler,
  BidirectionalStreamingHandler,
  GrpcHandler,
  GrpcStats,
  HealthCheckStatus,
  HealthCheckResponse,
  ProtoLoadOptions,
} from './types.js';

// Export adapters
export { GrpcJsAdapter } from './adapters/index.js';

// Export middleware
export {
  grpcAuth,
  grpcRequirePermission,
  grpcRequireRole,
  extractTokenFromMetadata,
} from './middleware/auth.js';

export { grpcLogger, grpcSimpleLogger, grpcDetailedLogger } from './middleware/logging.js';

export { grpcValidate, grpcValidateHandler } from './middleware/validation.js';
