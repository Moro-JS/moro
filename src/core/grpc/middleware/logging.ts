// gRPC Middleware - Logging Integration
// Integrate Moro's logging system with gRPC

import type { GrpcCall, GrpcCallback } from '../types.js';
import { createFrameworkLogger } from '../../logger/index.js';

// Metadata keys whose values are credentials: authorization and
// proxy-authorization, cookie and set-cookie, and any key naming a token,
// secret, password or API key (x-api-key, apikey, api_key, x-auth-token, ...).
const CREDENTIAL_METADATA_KEY = /authorization|cookie|token|secret|password|api[-_]?key/i;
const REDACTED = '[REDACTED]';

/** A copy of a metadata map with the values of credential-bearing keys replaced. */
function redactMetadata(map: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of Object.keys(map)) {
    safe[key] = CREDENTIAL_METADATA_KEY.test(key) ? REDACTED : map[key];
  }
  return safe;
}

/** Longest request or response text logged unless `maxBodyLength` says otherwise. */
const DEFAULT_MAX_BODY_LENGTH = 2048;

/**
 * A request or response message as text for the log. Unless `full`, the
 * values of credential-bearing fields at any depth are replaced by
 * `[REDACTED]`, binary fields are written as their size, and the text is cut
 * at `maxLength` characters.
 */
function describeMessage(message: unknown, full: boolean, maxLength: number): string {
  let text: string | undefined;
  try {
    text = full
      ? JSON.stringify(message)
      : JSON.stringify(message, (key, value) => {
          if (key !== '' && CREDENTIAL_METADATA_KEY.test(key)) return REDACTED;
          // A Buffer reaches the replacer in its toJSON() form
          if (
            value !== null &&
            typeof value === 'object' &&
            value.type === 'Buffer' &&
            Array.isArray(value.data)
          ) {
            return `[${value.data.length} bytes]`;
          }
          if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
          return value;
        });
  } catch {
    return '[unserializable message]';
  }
  if (text === undefined) return String(message);
  if (full || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [${text.length - maxLength} more characters]`;
}

/**
 * gRPC request logging middleware
 * Logs all gRPC calls with timing and status. Place it first in a method's
 * handler array: `[grpcLogger(), ...otherMiddleware, handler]`.
 * `logMetadata` logs the call's metadata with the values of credential-bearing
 * keys (authorization, cookie, and keys naming a token, secret, password or
 * API key) replaced by `[REDACTED]`.
 * `logRequest` logs the request message and `logResponse` the response of
 * unary and client-streaming calls (the ones answered through the callback).
 * Both write the message with the values of credential-bearing fields
 * replaced by `[REDACTED]`, binary fields as their size, and at most
 * `maxBodyLength` characters (default 2048). `fullBodies: true` logs messages
 * whole and as they are.
 */
export function grpcLogger(
  options: {
    logger?: any;
    logMetadata?: boolean;
    logRequest?: boolean;
    logResponse?: boolean;
    /** Log request and response messages whole, with nothing redacted. Default: false. */
    fullBodies?: boolean;
    /** Longest request or response text logged when `fullBodies` is off. Default: 2048. */
    maxBodyLength?: number;
  } = {}
) {
  const logger = options.logger || createFrameworkLogger('GRPC_REQUEST');
  const fullBodies = options.fullBodies === true;
  const maxBodyLength =
    typeof options.maxBodyLength === 'number' && options.maxBodyLength >= 0
      ? Math.floor(options.maxBodyLength)
      : DEFAULT_MAX_BODY_LENGTH;

  return async (call: GrpcCall, callback?: GrpcCallback, next?: CallableFunction) => {
    const startTime = Date.now();
    const peer = call.getPeer?.() || 'unknown';
    const methodPath = (call as any).methodPath || 'unknown';

    // Log request
    logger.info(`→ gRPC call: ${methodPath} from ${peer}`, 'Request');

    if (options.logMetadata && call.metadata) {
      logger.debug(
        `Metadata: ${JSON.stringify(redactMetadata(call.metadata.getMap()))}`,
        'Request'
      );
    }

    if (options.logRequest && call.request) {
      logger.debug(
        `Request: ${describeMessage(call.request, fullBodies, maxBodyLength)}`,
        'Request'
      );
    }

    // With logResponse, watch the callback so a unary response can be logged
    const respond =
      options.logResponse && callback
        ? (((error: any, response?: any) => {
            if (!error) {
              logger.debug(
                `Response: ${describeMessage(response, fullBodies, maxBodyLength)}`,
                'Response'
              );
            }
            return callback(error, response);
          }) as GrpcCallback)
        : callback;

    try {
      // Run the rest of the chain and the handler
      if (next) {
        await next(call, respond);
      }

      const duration = Date.now() - startTime;
      logger.info(`✓ gRPC call completed: ${methodPath} in ${duration}ms`, 'Response');
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`✗ gRPC call failed: ${methodPath} in ${duration}ms - ${error}`, 'Response');
      throw error;
    }
  };
}

/**
 * Simple request logger that just logs method and timing
 */
export function grpcSimpleLogger() {
  return grpcLogger({
    logMetadata: false,
    logRequest: false,
    logResponse: false,
  });
}

/**
 * Detailed request logger: metadata, request and response, each redacted and
 * cut to length as grpcLogger() does by default
 */
export function grpcDetailedLogger() {
  return grpcLogger({
    logMetadata: true,
    logRequest: true,
    logResponse: true,
  });
}
