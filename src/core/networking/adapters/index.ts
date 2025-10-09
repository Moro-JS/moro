// WebSocket Adapters for Moro Framework
// Export all available adapters from this centralized location

export { SocketIOAdapter } from './socketio-adapter.js';
export { WSAdapter } from './ws-adapter.js';
export { UWebSocketsAdapter } from './uws-adapter.js';

// Re-export the adapter interface for convenience
export type {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketConnection,
  WebSocketEmitter,
  WebSocketMiddleware,
  WebSocketEventHandler,
} from '../websocket-adapter.js';
