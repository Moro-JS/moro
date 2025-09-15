// WebSocket Adapters for Moro Framework
// Export all available adapters from this centralized location

export { SocketIOAdapter } from './socketio-adapter';
export { WSAdapter } from './ws-adapter';

// Re-export the adapter interface for convenience
export type {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketConnection,
  WebSocketEmitter,
  WebSocketMiddleware,
  WebSocketEventHandler,
} from '../websocket-adapter';
