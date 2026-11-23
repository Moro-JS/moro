/**
 * Parse a human size string ("10mb", "5gb", "16kb") or a raw number of bytes
 * into bytes. Shared by config validation, the runtime-limits builder, and
 * every HTTP server so `bodySizeLimit: '10mb'` means the same thing
 * everywhere.
 *
 * A number passes through unchanged. An unparseable string falls back to
 * `fallback` (10 MB by default) so a typo degrades to a safe default rather
 * than 0/NaN.
 */
const UNITS: { [key: string]: number } = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

export function parseSizeToBytes(
  size: string | number,
  fallback: number = 10 * 1024 * 1024
): number {
  if (typeof size === 'number') return size;
  if (typeof size !== 'string') return fallback;

  const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
  if (!match) return fallback;

  const value = parseFloat(match[1] ?? '');
  const unit = match[2] || 'b';
  return Math.round(value * (UNITS[unit] ?? 1));
}

/**
 * server.timeouts.request when the configuration gives none (ms): how long a
 * client may take to deliver one complete request. The same five minutes as
 * Node's own `requestTimeout`, so every server agrees.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300000;

/**
 * server.timeouts.idle on the HTTP/2 server and the native engine when the
 * configuration gives none (ms). Above the 60 s idle timeout of the common
 * load balancers, so the proxy is the side that retires an idle connection
 * and never sends a request down one the server has just closed. The native
 * engine gets it only when its idle timeout leaves a connection with a
 * response still to deliver alone (capabilities.idleSparesDrainingResponse).
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 75000;

/**
 * Flattened, size-resolved runtime limits passed from the framework to every
 * HTTP server. undefined = use that server's own documented default. Mirrors
 * the RuntimeLimits built in framework.ts (kept here so the servers can import
 * it without depending on framework.ts).
 */
export interface HttpRuntimeLimits {
  maxBodySize?: number;
  maxUploadSize?: number;
  maxConnections?: number;
  backlog?: number;
  timeouts?: {
    request?: number;
    idle?: number;
    keepAlive?: number;
    headers?: number;
  };
  maxHeaderSize?: number;
  maxHeaders?: number;
  wsMaxMessageSize?: number;
  wsBackpressureLimit?: number;
  writeHighWaterMark?: number;
  maxPendingBytes?: number;
  responseBackpressureLimit?: number;
  /** server.limits.allowNonAsciiTarget (engine allowNonAsciiTarget). */
  allowNonAsciiTarget?: boolean;
  multipart?: {
    maxParts?: number;
    maxPartHeaderBytes?: number;
    maxFiles?: number;
    maxFileSize?: number;
  };
}

/** True when `size` is a number, or a string parseable by parseSizeToBytes. */
export function isValidSize(size: unknown): boolean {
  if (typeof size === 'number') return Number.isFinite(size) && size >= 0;
  if (typeof size !== 'string') return false;
  return /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.test(size.trim());
}
