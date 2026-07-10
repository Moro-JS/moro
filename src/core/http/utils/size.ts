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

  const value = parseFloat(match[1]);
  const unit = match[2] || 'b';
  return Math.round(value * UNITS[unit]);
}

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
