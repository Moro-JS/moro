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
  /** The authenticated user, set by `grpcAuth` once `verify` has accepted the token */
  user?: any;
  write?(data: any): void;
  end?(): void;
  on?(event: string, handler: (...args: any[]) => void): void;
}

/**
 * gRPC callback for unary and client streaming calls
 */
export type GrpcCallback<TResponse = any> = {
  // Declared through a method so parameters compare bivariantly: a callback
  // written as `(error: GrpcError | null, response) => ...` stays assignable
  // now that a plain status object is accepted too.
  bivariant(error: GrpcError | GrpcStatusObject | null, response?: TResponse): void;
}['bivariant'];

/**
 * A plain status object, the usual way to fail a call:
 * `callback({ code: grpc.status.NOT_FOUND, message: 'User not found' })`
 */
export interface GrpcStatusObject {
  code: GrpcStatusCode | number;
  message?: string;
  details?: string;
  metadata?: GrpcMetadata;
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
  /**
   * Server: require every client to present a certificate signed by
   * `rootCerts` (mutual TLS). Default: false, so a client certificate is not
   * asked for.
   */
  requireClientCert?: boolean;
  /**
   * Server: the earlier name of `requireClientCert`, still honoured when
   * `requireClientCert` is not set. Despite the name it has nothing to do with
   * checking the server's identity.
   * @deprecated Use `requireClientCert`.
   */
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
  UnaryHandler | ServerStreamingHandler | ClientStreamingHandler | BidirectionalStreamingHandler;

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
  [methodName: string]: GrpcMethodHandler | GrpcMethodHandler[];
}

/**
 * What a service method accepts: any of the handler kinds above, or a
 * middleware. One signature (instead of the GrpcHandler union) so that an
 * inline `async call => { ... }` gets its parameter types inferred.
 */
export type GrpcMethodHandler = (
  call: GrpcCall<any>,
  callback: GrpcCallback<any>
) => void | Promise<void>;

/**
 * Service definition from proto file
 */
export interface ServiceDefinition {
  serviceName: string;
  packageName?: string | undefined;
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
  /**
   * The protobuf serialisers of the method, taken from the loaded .proto.
   * Every definition `loadProto()` returns carries all four.
   */
  requestSerialize?: (value: any) => Buffer;
  requestDeserialize?: (bytes: Buffer) => any;
  responseSerialize?: (value: any) => Buffer;
  responseDeserialize?: (bytes: Buffer) => any;
}

/**
 * gRPC client options
 */
export interface GrpcClientOptions {
  address: string;
  credentials?: GrpcCredentials | undefined;
  deadline?: number | undefined;
  maxReceiveMessageLength?: number | undefined;
  maxSendMessageLength?: number | undefined;
  interceptors?: GrpcInterceptor[] | undefined;
  channelOptions?: Record<string, any> | undefined;
}

/**
 * gRPC client interface
 *
 * One method per RPC of the service, under its name in the .proto (`GetUser`)
 * and its lower-camel-case form (`getUser`).
 *
 * - Unary: `await client.GetUser(request, metadata?, options?)` resolves to the
 *   response and rejects with the grpc-js ServiceError (`code`, `details`,
 *   `metadata`). With a callback as the last argument,
 *   `client.GetUser(request, callback)`, it returns the grpc-js call instead.
 * - Streaming methods return the grpc-js call stream, not a promise:
 *   server streaming `client.ListUsers(request)` is readable, client streaming
 *   `client.CreateUsers(callback)` is writable and answers through the
 *   callback, bidirectional `client.Chat()` is both.
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
