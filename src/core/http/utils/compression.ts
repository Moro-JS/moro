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
import type { BrotliOptions, ZlibOptions } from 'zlib';
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

/**
 * Per-encoding encoder settings. The shared `level` (1-9) picks a gzip level
 * and a brotli quality for an app that does not care; an app that does pins
 * the encoder it wants here, and what it pins wins over the level.
 */
export interface EncoderOptions {
  /**
   * zlib options for gzip and deflate. A `level` here replaces the shared
   * level; `windowBits`, `memLevel` and `strategy` pass through.
   */
  gzip?: ZlibOptions;
  /**
   * brotli options. A quality under `params` replaces the one the shared
   * level maps to; the window is still fitted to the body unless
   * `BROTLI_PARAM_LGWIN` is given.
   */
  brotli?: BrotliOptions;
  /**
   * Keep one gzip encoder per setting and reset it between bodies instead
   * of building a new one for every response: the encoder's hash tables and
   * window are a fair share of what compressing a few kilobytes costs. The
   * handle is proven with a round trip once and the one-call API stands in
   * whenever it cannot be driven that way. Default true.
   */
  reuseEncoders?: boolean;
}

export interface CompressionSettings extends EncoderOptions {
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
    gzip?: ZlibOptions;
    brotli?: BrotliOptions;
    reuseEncoders?: boolean;
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
    ...(c?.gzip !== undefined ? { gzip: c.gzip } : {}),
    ...(c?.brotli !== undefined ? { brotli: c.brotli } : {}),
    ...(c?.reuseEncoders !== undefined ? { reuseEncoders: c.reuseEncoders } : {}),
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
 * Brotli options for one body: quality mapped from the 1-9 level (unless the
 * app pinned one), the size hint, and a window no larger than the input
 * needs. The default window (2^22 bytes) has the encoder allocate and clear
 * several megabytes per call, which for a response of a few kilobytes is
 * most of its cost; a window that covers the whole input finds the same
 * matches, since none can reach back further than the input is long (only
 * the window field of the stream header differs).
 */
function brotliOptions(length: number, level: number, custom?: BrotliOptions): BrotliOptions {
  const c = z().constants;
  const params: { [key: number]: number | boolean } = { ...(custom?.params ?? {}) };
  if (params[c.BROTLI_PARAM_QUALITY] === undefined) {
    params[c.BROTLI_PARAM_QUALITY] = Math.max(0, Math.min(11, Math.round((level * 11) / 9)));
  }
  if (params[c.BROTLI_PARAM_SIZE_HINT] === undefined) params[c.BROTLI_PARAM_SIZE_HINT] = length;
  if (params[c.BROTLI_PARAM_LGWIN] === undefined) {
    params[c.BROTLI_PARAM_LGWIN] = Math.max(
      c.BROTLI_MIN_WINDOW_BITS,
      Math.min(c.BROTLI_DEFAULT_WINDOW, Math.ceil(Math.log2(Math.max(length, 1))) + 1)
    );
  }
  return { ...custom, params };
}

/** zlib options for one gzip/deflate body: the app's, with the level filled in. */
function zlibOptions(level: number, custom?: ZlibOptions): ZlibOptions {
  if (custom === undefined) return { level };
  return custom.level === undefined ? { ...custom, level } : custom;
}

// ---------------------------------------------------------------------------
// Reused gzip encoders
//
// Node's one-call API (gzipSync) builds a fresh encoder for every body and
// tears it down after: for a body of a few kilobytes the deflate state - a
// 32 KB window plus hash tables, allocated and cleared - is a fair share of
// the work. The sync API drives the same native handle a zlib stream owns,
// so one stream per gzip setting is kept and reset between bodies, the way
// the encoder would be reused in C. The handle is reached through two
// stream internals (`_handle`, `_writeState`); they have been stable since
// Node 10, but a Node that changes them must never produce a wrong body, so
// the handle is proven once with a round trip against the one-call output,
// and anything it does not match - or any later throw - retires it in
// favour of gzipSync. `reuseEncoders: false` turns the whole thing off.
// ---------------------------------------------------------------------------
type SyncEncoder = (input: Buffer) => Buffer;
const retainedGzip = new Map<string, SyncEncoder | null>();

function makeRetainedGzip(options: ZlibOptions): SyncEncoder | null {
  const zlib = z();
  let stream: any;
  try {
    stream = zlib.createGzip(options);
    const handle = stream._handle;
    const state = stream._writeState;
    if (
      !handle ||
      typeof handle.writeSync !== 'function' ||
      typeof handle.reset !== 'function' ||
      !(state instanceof Uint32Array) ||
      state.length < 2
    ) {
      stream.close();
      return null;
    }
    // An error the handle raises reaches the stream; it must never take the
    // process down, and the throw below retires the encoder.
    stream.on('error', () => {});
    const FINISH = zlib.constants.Z_FINISH;
    const compress: SyncEncoder = input => {
      let chunks: Buffer[] | null = null;
      let first: Buffer | null = null;
      let inOff = 0;
      let inLen = input.length;
      let outSize = inLen < 512 ? 256 : inLen >> 1;
      for (;;) {
        const out = Buffer.allocUnsafe(outSize);
        handle.writeSync(FINISH, input, inOff, inLen, out, 0, outSize);
        const availOut = state[0] as number;
        const availIn = state[1] as number;
        const produced = outSize - availOut;
        if (produced > 0) {
          const piece = produced === outSize ? out : out.subarray(0, produced);
          if (first === null) first = piece;
          else (chunks ??= [first]).push(piece);
        }
        inOff += inLen - availIn;
        inLen = availIn;
        if (availOut !== 0) break;
        outSize *= 2;
      }
      handle.reset();
      return chunks === null ? (first ?? Buffer.alloc(0)) : Buffer.concat(chunks);
    };
    // Proof: two bodies in a row (the second exercises the reset) decode to
    // the input and are the size the one-call API makes of them, so a handle
    // whose reset forgot its level can never serve.
    const sample = Buffer.from('moro compression sample '.repeat(300) + Math.random());
    const reference = zlib.gzipSync(sample, options).length;
    for (let i = 0; i < 2; i++) {
      const got = compress(sample);
      if (!zlib.gunzipSync(got).equals(sample) || Math.abs(got.length - reference) > 16) {
        stream.close();
        return null;
      }
    }
    let broken = false;
    return input => {
      if (broken) return zlib.gzipSync(input, options);
      try {
        return compress(input);
      } catch {
        // The handle's state is unknown now: this body and every later one
        // go the one-call way.
        broken = true;
        try {
          stream.close();
        } catch {
          // already closed
        }
        return zlib.gzipSync(input, options);
      }
    };
  } catch {
    try {
      stream?.close();
    } catch {
      // nothing to close
    }
    return null;
  }
}

function retainedGzipFor(options: ZlibOptions): SyncEncoder | null {
  const key = JSON.stringify(options);
  let enc = retainedGzip.get(key);
  if (enc === undefined) {
    enc = makeRetainedGzip(options);
    retainedGzip.set(key, enc);
  }
  return enc;
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

/** Compress a buffer/string with the chosen encoding, on the threadpool. */
export async function compressBuffer(
  data: Buffer | string,
  encoding: Encoding,
  level = 6,
  encoders?: EncoderOptions
): Promise<Buffer> {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  switch (encoding) {
    case 'br':
      return brotliAsync(buf, brotliOptions(buf.length, level, encoders?.brotli));
    case 'gzip':
      return gzipAsync(buf, zlibOptions(level, encoders?.gzip));
    case 'deflate':
      return deflateAsync(buf, zlibOptions(level, encoders?.gzip));
  }
}

/** Compress a buffer/string on the calling thread (see shouldInline). */
export function compressBufferSync(
  data: Buffer | string,
  encoding: Encoding,
  level = 6,
  encoders?: EncoderOptions
): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const zlib = z();
  switch (encoding) {
    case 'br':
      return zlib.brotliCompressSync(buf, brotliOptions(buf.length, level, encoders?.brotli));
    case 'gzip': {
      const options = zlibOptions(level, encoders?.gzip);
      if (encoders?.reuseEncoders !== false) {
        const retained = retainedGzipFor(options);
        if (retained !== null) return retained(buf);
      }
      return zlib.gzipSync(buf, options);
    }
    case 'deflate':
      return zlib.deflateSync(buf, zlibOptions(level, encoders?.gzip));
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
      ? compressBufferSync(body, encoding, settings.level, settings)
      : await compressBuffer(body, encoding, settings.level, settings);
    return { body: compressed, encoding };
  } catch {
    return { body, encoding: null };
  }
}
