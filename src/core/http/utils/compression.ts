/**
 * Shared response compression, used by every runtime (Node, uWS, HTTP/2, and
 * the native engine) so switching engines never silently drops compression.
 *
 * Scope: BUFFERED responses only (json/send/end with a full body). The
 * streaming path (writeHead + write + write + end) stays uncompressed on all
 * runtimes — per-chunk flush semantics would break SSE latency and the
 * engine's Content-Length short-write detection. That is a deliberate,
 * documented non-goal.
 */
import { promisify } from 'util';
import { requireBuiltin } from '../../utilities/builtin.js';

// zlib is loaded on the first compressed response, not at startup
// (core/utilities/builtin.ts): compression is off by default.
const z = () => requireBuiltin<typeof import('zlib')>('zlib');
type Compressor = (buf: Buffer, opts: any) => Promise<Buffer>;
let gzipFn: Compressor | undefined;
let deflateFn: Compressor | undefined;
let brotliFn: Compressor | undefined;
const gzipAsync: Compressor = (buf, opts) =>
  (gzipFn ??= promisify(z().gzip) as unknown as Compressor)(buf, opts);
const deflateAsync: Compressor = (buf, opts) =>
  (deflateFn ??= promisify(z().deflate) as unknown as Compressor)(buf, opts);
const brotliAsync: Compressor = (buf, opts) =>
  (brotliFn ??= promisify(z().brotliCompress) as unknown as Compressor)(buf, opts);

export type Encoding = 'br' | 'gzip' | 'deflate';

export interface CompressionSettings {
  enabled: boolean;
  threshold: number;
  level: number; // 1-9 (mapped to brotli quality)
  encodings: Encoding[]; // server preference order
  /** Bodies at or below this size compress on the calling thread (see shouldInline). */
  maxInlineBytes: number;
}

export const DEFAULT_ENCODINGS: Encoding[] = ['br', 'gzip', 'deflate'];

/**
 * 16 KB: gzip at the default level takes well under a millisecond on a body
 * this size, less than the two thread handoffs the pool round trip costs,
 * while a body many times larger would hold the event loop for longer than
 * the requests queued behind it should wait.
 */
export const DEFAULT_MAX_INLINE_BYTES = 16 * 1024;

/**
 * Build CompressionSettings from the framework's performance config (the
 * shape passed to every server's configurePerformance). Shared so all four
 * runtimes interpret `performance.compression` identically.
 */
export function resolveCompressionSettings(config?: {
  compression?: {
    enabled?: boolean;
    threshold?: number;
    level?: number;
    encodings?: Encoding[];
    maxInlineBytes?: number;
  };
  minimal?: boolean;
}): CompressionSettings {
  const c = config?.compression;
  // Minimal mode disables all response overhead for pure throughput.
  const enabled = config?.minimal ? false : c?.enabled !== false && c !== undefined;
  return {
    enabled,
    threshold: c?.threshold ?? 1024,
    level: c?.level ?? 6,
    encodings: c?.encodings ?? DEFAULT_ENCODINGS,
    maxInlineBytes: c?.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES,
  };
}

/**
 * Whether a body of `bytes` is compressed on the calling thread rather than
 * on the threadpool. Inline is cheaper for small bodies (no handoff, no
 * promise, no wake-up) and lets the response carry a Content-Length instead
 * of streaming chunked. `maxInlineBytes: 0` sends everything through the pool.
 */
export function shouldInline(bytes: number, settings: { maxInlineBytes: number }): boolean {
  return settings.maxInlineBytes > 0 && bytes <= settings.maxInlineBytes;
}

/**
 * Brotli options for one body: quality mapped from the 1-9 level, the size
 * hint, and a window no larger than the input needs. The default window
 * (2^22 bytes) has the encoder allocate and clear several megabytes per call,
 * which for a response of a few kilobytes is most of its cost; a window that
 * covers the whole input compresses it identically, since no match can
 * reach back further than the input is long.
 */
function brotliOptions(length: number, level: number) {
  const c = z().constants;
  const lgwin = Math.max(
    c.BROTLI_MIN_WINDOW_BITS,
    Math.min(c.BROTLI_DEFAULT_WINDOW, Math.ceil(Math.log2(Math.max(length, 1))) + 1)
  );
  return {
    params: {
      [c.BROTLI_PARAM_QUALITY]: Math.max(0, Math.min(11, Math.round((level * 11) / 9))),
      [c.BROTLI_PARAM_SIZE_HINT]: length,
      [c.BROTLI_PARAM_LGWIN]: lgwin,
    },
  };
}

/**
 * Content types worth compressing. Text and structured formats yes; already
 * compressed binary (images, video, zip, octet-stream) no.
 */
export function isCompressible(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (ct.startsWith('text/')) return true;
  if (ct.endsWith('+json') || ct.endsWith('+xml')) return true;
  return (
    ct === 'application/json' ||
    ct === 'application/javascript' ||
    ct === 'application/xml' ||
    ct === 'application/ld+json' ||
    ct === 'application/manifest+json' ||
    ct === 'image/svg+xml'
  );
}

/**
 * Pick the best encoding the client accepts from the server's preference
 * list, honoring q-values (q=0 excludes). Returns null when the client
 * accepts none / only identity.
 */
export function negotiateEncoding(
  acceptEncoding: string | undefined,
  allowed: Encoding[] = DEFAULT_ENCODINGS
): Encoding | null {
  if (!acceptEncoding) return null;

  // Parse "gzip;q=0.8, br, deflate;q=0" into a q-value map.
  const q = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [tokenRaw, ...params] = part.trim().split(';');
    const token = (tokenRaw ?? '').trim().toLowerCase();
    if (!token) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/i.exec(p);
      if (m && m[1] !== undefined) weight = parseFloat(m[1]);
    }
    q.set(token, weight);
  }

  const wildcard = q.get('*');
  const accepts = (enc: Encoding): boolean => {
    if (q.has(enc)) return (q.get(enc) as number) > 0;
    if (wildcard !== undefined) return wildcard > 0;
    return false;
  };

  for (const enc of allowed) {
    if (accepts(enc)) return enc;
  }
  return null;
}

/** Compress a buffer/string with the chosen encoding. */
export async function compressBuffer(
  data: Buffer | string,
  encoding: Encoding,
  level = 6
): Promise<Buffer> {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  switch (encoding) {
    case 'br':
      return brotliAsync(buf, brotliOptions(buf.length, level));
    case 'gzip':
      return gzipAsync(buf, { level });
    case 'deflate':
      return deflateAsync(buf, { level });
  }
}

/** Compress a buffer/string on the calling thread (see shouldInline). */
export function compressBufferSync(data: Buffer | string, encoding: Encoding, level = 6): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const zlib = z();
  switch (encoding) {
    case 'br':
      return zlib.brotliCompressSync(buf, brotliOptions(buf.length, level));
    case 'gzip':
      return zlib.gzipSync(buf, { level });
    case 'deflate':
      return zlib.deflateSync(buf, { level });
  }
}

export interface MaybeCompressResult {
  body: Buffer | string;
  encoding: Encoding | null;
}

/**
 * The one-call helper the servers use: decide whether to compress `body`
 * given the response content type, the client's Accept-Encoding, and the
 * server's compression settings. Returns the (possibly compressed) body plus
 * the chosen encoding (null = sent as-is). Never throws — a compression error
 * degrades to the original body.
 */
export async function maybeCompress(
  body: Buffer | string,
  contentType: string | undefined,
  acceptEncoding: string | undefined,
  settings: CompressionSettings
): Promise<MaybeCompressResult> {
  if (!settings.enabled) return { body, encoding: null };
  const byteLen = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
  if (byteLen < settings.threshold) return { body, encoding: null };
  if (!isCompressible(contentType)) return { body, encoding: null };

  const encoding = negotiateEncoding(acceptEncoding, settings.encodings);
  if (!encoding) return { body, encoding: null };

  try {
    const compressed = shouldInline(byteLen, settings)
      ? compressBufferSync(body, encoding, settings.level)
      : await compressBuffer(body, encoding, settings.level);
    return { body: compressed, encoding };
  } catch {
    return { body, encoding: null };
  }
}
