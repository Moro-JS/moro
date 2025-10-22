// SSE Core - Reusable Server-Sent Events logic
import { HttpResponse } from '../../../../types/http.js';

// ===== Types =====

export interface SSEOptions {
  heartbeat?: number;
  retry?: number;
  cors?: boolean;
}

export interface SSEConnection {
  sendEvent: (data: any, event?: string, id?: string) => void;
  sendComment: (comment: string) => void;
  sendRetry: (ms: number) => void;
  close: () => void;
}

// ===== Core Logic =====

/**
 * Format SSE event data
 */
export function formatSSEEvent(data: any, event?: string, id?: string): string {
  let message = '';

  if (id) {
    message += `id: ${id}\n`;
  }

  if (event) {
    message += `event: ${event}\n`;
  }

  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  message += `data: ${dataStr}\n\n`;

  return message;
}

/**
 * Format SSE comment
 */
export function formatSSEComment(comment: string): string {
  return `: ${comment}\n\n`;
}

/**
 * Format SSE retry directive
 */
export function formatSSERetry(ms: number): string {
  return `retry: ${ms}\n\n`;
}

/**
 * SSECore - Core Server-Sent Events management logic
 * Used directly by the router for route-based SSE
 */
export class SSECore {
  private options: SSEOptions;

  constructor(options: SSEOptions = {}) {
    this.options = options;
  }

  /**
   * Check if request accepts SSE
   */
  isSSERequest(acceptHeader?: string): boolean {
    if (!acceptHeader) {
      return false;
    }
    return acceptHeader.includes('text/event-stream');
  }

  /**
   * Initialize SSE headers on response
   */
  initializeSSE(res: HttpResponse): void {
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    };

    if (this.options.cors) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Headers'] = 'Cache-Control';
    }

    res.writeHead(200, headers);
  }

  /**
   * Create SSE connection with helper methods
   */
  createConnection(res: HttpResponse, onClose?: () => void): SSEConnection {
    const resAny = res as any;
    let heartbeatInterval: NodeJS.Timeout | null = null;
    let closed = false;

    // Send initial retry if configured
    if (this.options.retry) {
      resAny.write(formatSSERetry(this.options.retry));
    }

    // Set up heartbeat if configured
    if (this.options.heartbeat) {
      heartbeatInterval = setInterval(() => {
        if (!closed) {
          resAny.write(formatSSEComment('heartbeat'));
        }
      }, this.options.heartbeat);
    }

    const connection: SSEConnection = {
      sendEvent: (data: any, event?: string, id?: string) => {
        if (!closed) {
          resAny.write(formatSSEEvent(data, event, id));
        }
      },

      sendComment: (comment: string) => {
        if (!closed) {
          resAny.write(formatSSEComment(comment));
        }
      },

      sendRetry: (ms: number) => {
        if (!closed) {
          resAny.write(formatSSERetry(ms));
        }
      },

      close: () => {
        if (closed) {
          return;
        }

        closed = true;

        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }

        if (onClose) {
          onClose();
        }

        if (resAny.end && !resAny.writableEnded) {
          resAny.end();
        }
      },
    };

    return connection;
  }
}
