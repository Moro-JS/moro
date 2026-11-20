// SSE Core - Reusable Server-Sent Events logic
import { HttpResponse } from '../../../../types/http.js';

// ===== Types =====

export interface SSEOptions {
  /** Send a `: heartbeat` comment every this many milliseconds on an open stream. */
  heartbeat?: number;
  /** Reconnection delay (ms) sent to the client when a stream opens. */
  retry?: number;
  /** Add `Access-Control-Allow-Origin: *` to the stream's response. */
  cors?: boolean;
}

export interface SSEConnection {
  sendEvent: (data: any, event?: string, id?: string) => void;
  sendComment: (comment: string) => void;
  sendRetry: (ms: number) => void;
  close: () => void;
}

// ===== Core Logic =====

// A line of the event stream ends at CR, LF or CRLF, and a blank line ends the
// event. A value written into a field must therefore never carry a line break
// of its own, or it would start a new field - or a new event.
const LINE_BREAK = /\r\n|\r|\n/;
const LINE_BREAKS = /[\r\n]+/g;

/** `id` and `event` are single-line fields: line breaks are removed. */
function singleLine(value: string): string {
  const text = String(value);
  return LINE_BREAK.test(text) ? text.replace(LINE_BREAKS, '') : text;
}

/**
 * Write `value` under `prefix`, one field line per line of text - how the
 * event-stream format carries a multi-line value. The client joins `data`
 * lines back together with a newline.
 */
function fieldLines(prefix: string, value: string): string {
  if (!LINE_BREAK.test(value)) {
    return `${prefix}${value}\n`;
  }
  let out = '';
  for (const line of value.split(LINE_BREAK)) {
    out += `${prefix}${line}\n`;
  }
  return out;
}

/**
 * Format SSE event data
 */
export function formatSSEEvent(data: any, event?: string, id?: string): string {
  let message = '';

  if (id) {
    message += `id: ${singleLine(id)}\n`;
  }

  if (event) {
    message += `event: ${singleLine(event)}\n`;
  }

  // JSON.stringify escapes line breaks, so only a string can carry them
  if (typeof data === 'string') {
    message += `${fieldLines('data: ', data)}\n`;
  } else {
    message += `data: ${JSON.stringify(data)}\n\n`;
  }

  return message;
}

/**
 * Format SSE comment
 */
export function formatSSEComment(comment: string): string {
  return `${fieldLines(': ', String(comment))}\n`;
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
   * Give a response the event-stream helpers. Nothing is sent and no timer
   * starts here: the stream opens when the handler calls `res.sse()` (or
   * sends its first event with `res.sendEvent()` / `sendComment()` /
   * `sendRetry()`), so a request that never reaches a handler - no such
   * route, a guard that refused it - is answered the way it would be without
   * this middleware.
   */
  attach(req: { on?: (event: string, listener: () => void) => unknown }, res: HttpResponse): void {
    const resAny = res as any;
    let connection: SSEConnection | null = null;

    const open = (): SSEConnection => {
      if (connection !== null) return connection;
      // A handler that wrote its own head keeps it
      if (!resAny.headersSent) this.initializeSSE(res);
      const opened = this.createConnection(res);
      connection = opened;
      // The heartbeat timer ends with the connection, whoever closes it
      const release = () => opened.close();
      if (typeof req.on === 'function') req.on('close', release);
      if (typeof resAny.on === 'function') resAny.on('close', release);
      return opened;
    };

    resAny.sse = open;
    resAny.sendEvent = (data: any, event?: string, id?: string) =>
      open().sendEvent(data, event, id);
    resAny.sendComment = (comment: string) => open().sendComment(comment);
    resAny.sendRetry = (ms: number) => open().sendRetry(ms);
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
