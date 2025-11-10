// gRPC Type Definitions for Moro Framework
// Comprehensive TypeScript interfaces for gRPC support

import type { HttpRequest, HttpResponse } from '../http/index.js';

/**
 * gRPC service call object
 * Represents an incoming RPC call with request data and metadata
 */
export interface GrpcCall<TRequest = any> {
  request: TRequest;
  metadata: GrpcMetadata;
  cancelled: boolean;
  getPeer(): string;
  sendMetadata(metadata: GrpcMetadata): void;
  write?(data: any): void;
  end?(): void;
  on?(event: string, handler: (...args: any[]) => void): void;
}

/**
 * gRPC callback for unary and client streaming calls
 */
export interface GrpcCallback<TResponse = any> {
  (error: GrpcError | null, response?: TResponse): void;
}

/**
 * gRPC metadata (headers)
 */
export interface GrpcMetadata {
  get(key: string): string | string[] | undefined;
  set(key: string, value: string | Buffer): void;
  add(key: string, value: string | Buffer): void;
  remove(key: string): void;
  getMap(): Record<string, string | Buffer>;
}

/**
 * gRPC error with status code
 */
export interface GrpcError extends Error {
  code: GrpcStatusCode;
  details?: string;
  metadata?: GrpcMetadata;
}

/**
 * Standard gRPC status codes
 */
export enum GrpcStatusCode {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
}

/**
 * gRPC credentials for TLS/SSL
 */
export interface GrpcCredentials {
  rootCerts?: Buffer;
  privateKey?: Buffer;
  certChain?: Buffer;
  checkServerIdentity?: boolean;
}

/**
 * gRPC server options
 */
export interface GrpcOptions {
  port?: number;
  host?: string;
  adapter?: 'grpc-js' | 'grpc-web' | string;
  protoPath?: string;
  protoFiles?: string[];
  credentials?: GrpcCredentials;
  enableReflection?: boolean;
  enableHealthCheck?: boolean;
  maxReceiveMessageLength?: number;
  maxSendMessageLength?: number;
  maxConcurrentCalls?: number;
  keepaliveTimeMs?: number;
  keepaliveTimeoutMs?: number;
  keepalivePermitWithoutCalls?: boolean;
  compression?: boolean;
  channelOptions?: Record<string, any>;
}

/**
 * gRPC service method handler types
 */
export type UnaryHandler<TRequest = any, TResponse = any> = (
  call: GrpcCall<TRequest>,
  callback: GrpcCallback<TResponse>
) => void | Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type ServerStreamingHandler<TRequest = any, TResponse = any> = (
  call: GrpcCall<TRequest>
) => void | Promise<void>;

export type ClientStreamingHandler<TRequest = any, TResponse = any> = (
  call: GrpcCall<TRequest>,
  callback: GrpcCallback<TResponse>
) => void | Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type BidirectionalStreamingHandler<TRequest = any, TResponse = any> = (
  call: GrpcCall<TRequest>
) => void | Promise<void>;

export type GrpcHandler =
  | UnaryHandler
  | ServerStreamingHandler
  | ClientStreamingHandler
  | BidirectionalStreamingHandler;

/**
 * Moro middleware-compatible gRPC handler
 * Allows using Moro middleware with gRPC
 */
export type MoroGrpcHandler = (req: HttpRequest, res: HttpResponse) => void | Promise<void>;

/**
 * Service implementation
 * Maps method names to their handlers
 */
export interface ServiceImplementation {
  [methodName: string]: GrpcHandler | GrpcHandler[];
}

/**
 * Service definition from proto file
 */
export interface ServiceDefinition {
  serviceName: string;
  packageName?: string;
  methods: Record<string, MethodDefinition>;
}

/**
 * Method definition from proto file
 */
export interface MethodDefinition {
  path: string;
  requestStream: boolean;
  responseStream: boolean;
  requestType: any;
  responseType: any;
  originalName?: string;
}

/**
 * gRPC client options
 */
export interface GrpcClientOptions {
  address: string;
  credentials?: GrpcCredentials;
  deadline?: number;
  maxReceiveMessageLength?: number;
  maxSendMessageLength?: number;
  interceptors?: GrpcInterceptor[];
  channelOptions?: Record<string, any>;
}

/**
 * gRPC client interface
 */
export interface GrpcClient {
  [methodName: string]: ((...args: any[]) => Promise<any>) | (() => void);
  close(): void;
}

/**
 * gRPC interceptor (middleware for gRPC)
 */
export interface GrpcInterceptor {
  (call: GrpcCall, next: (call: GrpcCall) => Promise<any>): Promise<any>;
}

/**
 * Health check status
 */
export enum HealthCheckStatus {
  UNKNOWN = 0,
  SERVING = 1,
  NOT_SERVING = 2,
  SERVICE_UNKNOWN = 3,
}

/**
 * Health check response
 */
export interface HealthCheckResponse {
  status: HealthCheckStatus;
}

/**
 * Server reflection options
 */
export interface ReflectionOptions {
  services?: string[];
}

/**
 * gRPC statistics
 */
export interface GrpcStats {
  totalCalls: number;
  activeCalls: number;
  successfulCalls: number;
  failedCalls: number;
  averageLatency: number;
  byMethod: Record<
    string,
    {
      calls: number;
      errors: number;
      averageLatency: number;
    }
  >;
}

/**
 * Streaming call state
 */
export interface StreamState {
  isWritable: boolean;
  isReadable: boolean;
  isPaused: boolean;
  isEnded: boolean;
}

/**
 * Proto file loading options
 */
export interface ProtoLoadOptions {
  keepCase?: boolean;
  longs?: any;
  enums?: any;
  bytes?: any;
  defaults?: boolean;
  arrays?: boolean;
  objects?: boolean;
  oneofs?: boolean;
  json?: boolean;
  includeDirs?: string[];
}

/**
 * gRPC server instance
 */
export interface GrpcServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  forceShutdown(): void;
  getPort(): number;
  getStats(): GrpcStats;
}

/**
 * Service registration result
 */
export interface ServiceRegistration {
  serviceName: string;
  methods: string[];
  protoPath?: string;
}
