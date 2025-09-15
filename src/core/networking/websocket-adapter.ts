// WebSocket Adapter Interface for Moro Framework
// Provides a common interface for different WebSocket implementations

export interface WebSocketAdapterOptions {
  compression?: boolean;
  cors?: {
    origin?: string | string[] | boolean;
    methods?: string[];
    credentials?: boolean;
  };
  path?: string;
  maxPayloadLength?: number;
  idleTimeout?: number;
  [key: string]: any; // Allow adapter-specific options
}

/**
 * Abstract WebSocket adapter interface
 * Allows the framework to work with different WebSocket implementations
 */
export interface WebSocketAdapter {
  /**
   * Initialize the WebSocket server with the given HTTP server
   */
  initialize(httpServer: any, options?: WebSocketAdapterOptions): Promise<void>;

  /**
   * Create a namespace for organizing WebSocket connections
   */
  createNamespace(namespace: string): WebSocketNamespace;

  /**
   * Get the default namespace (usually '/')
   */
  getDefaultNamespace(): WebSocketNamespace;

  /**
   * Close the WebSocket server and all connections
   */
  close(): Promise<void>;

  /**
   * Set compression configuration
   */
  setCompression(enabled: boolean, options?: any): void;

  /**
   * Set custom ID generator for connections
   */
  setCustomIdGenerator(generator: () => string): void;

  /**
   * Get adapter name/type
   */
  getAdapterName(): string;

  /**
   * Get connection count across all namespaces
   */
  getConnectionCount(): number;
}

/**
 * WebSocket namespace interface
 * Represents a logical grouping of WebSocket connections
 */
export interface WebSocketNamespace {
  /**
   * Listen for connection events
   */
  on(event: 'connection', handler: (socket: WebSocketConnection) => void): void;

  /**
   * Emit event to all connected sockets in this namespace
   */
  emit(event: string, data: any): void;

  /**
   * Emit to specific room(s)
   */
  to(room: string | string[]): WebSocketEmitter;

  /**
   * Emit to sockets except those in specified room(s)
   */
  except(room: string | string[]): WebSocketEmitter;

  /**
   * Get all connected sockets
   */
  getSockets(): WebSocketConnection[];

  /**
   * Get connection count for this namespace
   */
  getConnectionCount(): number;

  /**
   * Use middleware for this namespace
   */
  use(middleware: (socket: WebSocketConnection, next: (err?: Error) => void) => void): void;
}

/**
 * WebSocket connection interface
 * Represents an individual client connection
 */
export interface WebSocketConnection {
  /** Unique connection ID */
  id: string;

  /** Client IP address */
  ip?: string;

  /** Connection headers */
  headers?: Record<string, string>;

  /** Custom data storage */
  data: Record<string, any>;

  /**
   * Listen for events from this socket
   */
  on(event: string, handler: (data: any, callback?: (response?: any) => void) => void): void;

  /**
   * Listen for any event from this socket
   */
  onAny(handler: (event: string, ...args: any[]) => void): void;

  /**
   * Emit event to this socket
   */
  emit(event: string, data: any): void;

  /**
   * Emit with compression
   */
  compressedEmit?(event: string, data: any): void;

  /**
   * Join a room
   */
  join(room: string | string[]): void;

  /**
   * Leave a room
   */
  leave(room: string | string[]): void;

  /**
   * Emit to specific room(s)
   */
  to(room: string | string[]): WebSocketEmitter;

  /**
   * Emit to all sockets except this one
   */
  broadcast: WebSocketEmitter;

  /**
   * Get rooms this socket has joined
   */
  getRooms(): Set<string>;

  /**
   * Disconnect this socket
   */
  disconnect(close?: boolean): void;

  /**
   * Check if socket is connected
   */
  connected: boolean;
}

/**
 * WebSocket emitter interface for chaining operations
 */
export interface WebSocketEmitter {
  /**
   * Emit to target sockets
   */
  emit(event: string, data: any): void;

  /**
   * Target specific room(s)
   */
  to(room: string | string[]): WebSocketEmitter;

  /**
   * Exclude specific room(s)
   */
  except(room: string | string[]): WebSocketEmitter;

  /**
   * Use compression for this emit
   */
  compress(compress: boolean): WebSocketEmitter;
}

/**
 * WebSocket middleware function type
 */
export type WebSocketMiddleware = (
  socket: WebSocketConnection,
  next: (err?: Error) => void
) => void;

/**
 * WebSocket event handler type
 */
export type WebSocketEventHandler = (
  socket: WebSocketConnection,
  data: any,
  callback?: (response?: any) => void
) => void | Promise<void>;
