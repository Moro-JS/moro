// Static File Serving Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import * as fs from 'fs/promises';
import { createReadStream, watch as watchDir, type FSWatcher, type Stats } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isCompressible, negotiateEncoding } from '../../../http/utils/compression.js';

export interface StaticCacheOptions {
  /**
   * Largest file kept in memory, in bytes. Bigger files take the uncached
   * path (read or streamed from disk per request). Default 1 MiB.
   */
  maxFileBytes?: number;
  /**
   * Budget for everything cached, in bytes, originals and precompressed
   * sidecars together; the oldest entries leave when it is exceeded.
   * Default 64 MiB.
   */
  maxBytes?: number;
  /**
   * How long a cached file is served without looking at the disk again, in
   * milliseconds. Past it, the next request stats the file (and the
   * sidecars it may have) and reloads what changed, so a replaced file is
   * served within this window at the latest. Default 1000. `0` stats on
   * every request.
   */
  revalidateMs?: number;
  /**
   * Watch the root directory and revalidate everything the moment a change
   * is reported, ahead of `revalidateMs`. Default true where the platform
   * supports it; a watcher that cannot be started is simply not used.
   */
  watch?: boolean;
}

export interface StaticOptions {
  root: string;
  /**
   * URL path the files are served under, e.g. `/assets`. Requests outside the
   * prefix fall through untouched; inside it, the prefix is stripped before the
   * path is resolved against `root` (`/assets/app.css` -> `<root>/app.css`).
   * Matching is exact and case-sensitive. Defaults to the URL root.
   */
  prefix?: string;
  maxAge?: number;
  index?: string[];
  dotfiles?: 'allow' | 'deny' | 'ignore';
  etag?: boolean;
  /**
   * Send `Last-Modified` and answer `If-Modified-Since` with a 304.
   * Default true.
   */
  lastModified?: boolean;
  /**
   * Advertise `Accept-Ranges: bytes` and serve `Range` requests as 206
   * responses — what media seeking and resumable downloads need. A request for
   * multiple ranges is answered with the whole entity. Default true.
   */
  acceptRanges?: boolean;
  /**
   * Serve precompressed sidecars: when `app.js.br` or `app.js.gz` sits next
   * to `app.js` and the client accepts that encoding, the sidecar is sent
   * with the original's Content-Type, the matching Content-Encoding and
   * `Vary: Accept-Encoding` (brotli preferred, then gzip). A sidecar older
   * than its source is ignored, so a replaced file is never served stale.
   * Range requests always get the identity file. Default false.
   */
  precompressed?: boolean;
  /**
   * Keep the files in memory. Without it every request resolves, stats and
   * reads the file (and its sidecars) from disk - five to eight filesystem
   * round trips through the threadpool per response, which is what bounds a
   * busy static route. With it, a file is read once and served from memory
   * with its validators and sidecars; the disk is consulted again at most
   * once per `revalidateMs` (default every second) or as soon as the root
   * directory reports a change, so a replaced file is still served promptly.
   * `true` takes the defaults; an object tunes them. Default false.
   */
  cache?: boolean | StaticCacheOptions;
}

/** Sidecar suffix per encoding, in preference order. */
const SIDECARS: Array<{ encoding: 'br' | 'gzip'; suffix: string }> = [
  { encoding: 'br', suffix: '.br' },
  { encoding: 'gzip', suffix: '.gz' },
];

/** What identifies one file on disk: a replacement of the same length still differs here. */
interface FileStamp {
  mtimeMs: number;
  size: number;
  ino: number;
}

/** One representation of a cached file: the original, or a precompressed sidecar. */
interface CachedVariant {
  /** '' for the identity representation */
  encoding: '' | 'br' | 'gzip';
  path: string;
  stamp: FileStamp;
  body: Buffer;
  etag: string;
}

interface CacheEntry {
  /** The resolved (real) path of the original, the key's target on disk */
  filePath: string;
  baseMimeType: string;
  contentType: string;
  mtime: Date;
  lastModified: string;
  identity: CachedVariant;
  /** The sidecars that existed (and were current) when the entry was built, in SIDECARS order */
  sidecars: CachedVariant[];
  /** Sidecar paths probed when the entry was built, present or not: absent ones must be re-probed too */
  sidecarStamps: Array<FileStamp | null>;
  bytes: number;
  checkedAt: number;
}

const stampOf = (st: { mtimeMs: number; size: number; ino: number }): FileStamp => ({
  mtimeMs: st.mtimeMs,
  size: st.size,
  ino: st.ino,
});
const sameStamp = (a: FileStamp | null, b: FileStamp | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino);

export class StaticCore {
  private root: string;
  private prefix: string;
  private maxAge: number;
  private index: string[];
  private dotfiles: 'allow' | 'deny' | 'ignore';
  private etag: boolean;
  private lastModified: boolean;
  private acceptRanges: boolean;
  private precompressed: boolean;

  /** Files at or below this size are read in one go instead of streamed. */
  private static readonly STREAM_THRESHOLD = 512 * 1024;

  // The in-memory cache (see StaticOptions.cache), keyed by the request path
  // under the prefix. Null when caching is off.
  private cache: Map<string, CacheEntry> | null = null;
  private cacheMaxFileBytes = 1024 * 1024;
  private cacheMaxBytes = 64 * 1024 * 1024;
  private cacheRevalidateMs = 1000;
  private cacheBytes = 0;
  private watcher: FSWatcher | null = null;
  private watchWanted = true;

  private mimeTypes: Record<string, string> = {
    // Documents / text
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xhtml': 'application/xhtml+xml',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.cjs': 'application/javascript',
    '.map': 'application/json',
    '.json': 'application/json',
    '.jsonld': 'application/ld+json',
    '.webmanifest': 'application/manifest+json',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.pdf': 'application/pdf',
    '.wasm': 'application/wasm',
    // Images
    '.png': 'image/png',
    '.apng': 'image/apng',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    // Fonts
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
    // Audio / video
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.weba': 'audio/webm',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.ogv': 'video/ogg',
    '.mov': 'video/quicktime',
    // Archives
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
  };

  constructor(options: StaticOptions) {
    this.root = path.resolve(options.root);
    this.prefix = StaticCore.normalizePrefix(options.prefix);
    this.maxAge = options.maxAge || 0;
    this.index = options.index || ['index.html', 'index.htm'];
    this.dotfiles = options.dotfiles || 'ignore';
    this.etag = options.etag !== false;
    this.lastModified = options.lastModified !== false;
    this.acceptRanges = options.acceptRanges !== false;
    this.precompressed = options.precompressed === true;
    if (options.cache) {
      const c = typeof options.cache === 'object' ? options.cache : {};
      this.cache = new Map();
      if (c.maxFileBytes !== undefined) this.cacheMaxFileBytes = Math.max(0, c.maxFileBytes);
      if (c.maxBytes !== undefined) this.cacheMaxBytes = Math.max(0, c.maxBytes);
      if (c.revalidateMs !== undefined) this.cacheRevalidateMs = Math.max(0, c.revalidateMs);
      this.watchWanted = c.watch !== false;
    }
  }

  async handleRequest(req: HttpRequest, res: HttpResponse): Promise<boolean> {
    // Only handle GET and HEAD requests
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return false;
    }

    // Strip the mount prefix; anything outside it is not ours to serve
    const urlPath = this.stripPrefix(req.path);
    if (urlPath === null) {
      return false;
    }

    // Cached: the common case is a hit that needs no filesystem call at all.
    // A Range request keeps the uncached path (byte offsets refer to the
    // identity file on disk).
    const cache = this.cache;
    if (cache !== null) {
      const entry = cache.get(urlPath);
      if (entry !== undefined && req.headers.range === undefined) {
        if (Date.now() - entry.checkedAt < this.cacheRevalidateMs) {
          return this.serveCached(req, res, entry);
        }
        // Past the revalidation window: one look at the disk. Unchanged, the
        // entry serves on; changed or gone, it is dropped and the request
        // takes the resolving path below, which rebuilds it.
        if (await this.stillCurrent(entry)) {
          entry.checkedAt = Date.now();
          return this.serveCached(req, res, entry);
        }
        this.evict(urlPath, entry);
      }
    }

    try {
      let filePath = path.join(this.root, urlPath);

      // Security: prevent directory traversal. The trailing separator is required —
      // a bare prefix check would allow sibling dirs like `/app/static-backups` to
      // satisfy `startsWith('/app/static')` and escape the root.
      const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
      if (filePath !== this.root && !filePath.startsWith(rootWithSep)) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return true;
      }

      // Security: resolve symlinks and re-check path to prevent symlink-based traversal
      try {
        const realPath = await fs.realpath(filePath);
        if (realPath !== this.root && !realPath.startsWith(rootWithSep)) {
          res.status(403).json({ success: false, error: 'Forbidden' });
          return true;
        }
        filePath = realPath;
      } catch {
        // realpath fails if file doesn't exist — handled by stat below
      }

      // Handle dotfiles
      const basename = path.basename(filePath);
      if (basename.startsWith('.')) {
        if (this.dotfiles === 'deny') {
          res.status(403).json({ success: false, error: 'Forbidden' });
          return true;
        } else if (this.dotfiles === 'ignore') {
          return false;
        }
      }

      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch {
        return false; // File not found, let other middleware handle
      }

      // Handle directories
      if (stats.isDirectory()) {
        let indexFound = false;

        for (const indexFile of this.index) {
          const indexPath = path.join(filePath, indexFile);
          try {
            const indexStats = await fs.stat(indexPath);
            if (indexStats.isFile()) {
              filePath = indexPath;
              stats = indexStats;
              indexFound = true;
              break;
            }
          } catch {
            // Continue to next index file
          }
        }

        if (!indexFound) {
          return false;
        }
      }

      // Get mime type and add charset for text files
      const ext = path.extname(filePath);
      const baseMimeType = this.mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
      const contentType = this.addCharsetIfNeeded(baseMimeType);

      // A file that fits the cache is read once, with its sidecars, and the
      // response comes from the entry - this request's and every later one's.
      if (
        cache !== null &&
        stats.isFile() &&
        stats.size <= this.cacheMaxFileBytes &&
        req.headers.range === undefined
      ) {
        const entry = await this.buildEntry(filePath, stats, baseMimeType, contentType);
        if (entry !== null) {
          this.insert(urlPath, entry);
          return this.serveCached(req, res, entry);
        }
      }

      res.setHeader('Content-Type', contentType);

      // Precompressed sidecar (app.js.br / app.js.gz next to app.js). Chosen
      // before the validators so the ETag names the encoded representation;
      // Range requests keep the identity file (byte offsets refer to it).
      let sidecar: { path: string; encoding: string; stats: { size: number } } | null = null;
      if (this.precompressed) {
        // The response now varies on Accept-Encoding whether or not a sidecar
        // exists for this particular file - caches must key on it either way.
        res.setHeader('Vary', 'Accept-Encoding');
        if (!req.headers.range) {
          sidecar = await this.findSidecar(filePath, stats.mtime, req.headers['accept-encoding']);
        }
      }

      // Cache headers
      if (this.maxAge > 0) {
        res.setHeader('Cache-Control', `public, max-age=${this.maxAge}`);
      }

      if (this.lastModified) {
        res.setHeader('Last-Modified', stats.mtime.toUTCString());
      }

      if (this.acceptRanges) {
        res.setHeader('Accept-Ranges', 'bytes');
      }

      let etag: string | undefined;
      if (this.etag) {
        // A strong ETag must differ between representations, so the encoded
        // sidecar gets its own (RFC 9110 8.8.1)
        etag = StaticCore.etagFor(stats, sidecar ? sidecar.encoding : '');
        res.setHeader('ETag', etag);
      }

      // Conditional requests. Content-Length is deliberately not set for a 304 —
      // the response carries no body.
      if (this.isNotModified(req, stats.mtime, etag)) {
        res.statusCode = 304;
        res.end();
        return true;
      }

      const range = this.acceptRanges ? this.resolveRange(req, stats, etag) : null;

      if (range === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${stats.size}`);
        res.status(416).json({ success: false, error: 'Range not satisfiable' });
        return true;
      }

      if (range) {
        const chunkSize = range.end - range.start + 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`);
        res.setHeader('Content-Length', chunkSize);

        if (req.method === 'HEAD') {
          res.end();
          return true;
        }

        if (StaticCore.canStream(res)) {
          await this.streamFile(filePath, res, range);
        } else {
          res.end(await StaticCore.readSlice(filePath, range.start, chunkSize));
        }
        return true;
      }

      if (sidecar) {
        res.setHeader('Content-Encoding', sidecar.encoding);
        res.setHeader('Content-Length', sidecar.stats.size);
        if (req.method === 'HEAD') {
          res.end();
          return true;
        }
        if (sidecar.stats.size <= StaticCore.STREAM_THRESHOLD || !StaticCore.canStream(res)) {
          res.end(await fs.readFile(sidecar.path));
        } else {
          await this.streamFile(sidecar.path, res);
        }
        return true;
      }

      // Handle HEAD requests
      if (req.method === 'HEAD') {
        res.setHeader('Content-Length', stats.size);
        res.end();
        return true;
      }

      // Small files take the one-read/one-write path — the common case for
      // assets, and the cheapest. Larger ones stream, so serving a big file
      // doesn't cost its full size in resident memory per request.
      if (stats.size <= StaticCore.STREAM_THRESHOLD || !StaticCore.canStream(res)) {
        const data = await fs.readFile(filePath);
        this.sendBody(res, data, baseMimeType);
      } else {
        res.setHeader('Content-Length', stats.size);
        await this.streamFile(filePath, res);
      }
      return true;
    } catch {
      res.status(500).json({ success: false, error: 'Internal server error' });
      return true;
    }
  }

  // ---- the in-memory cache ----

  /**
   * Read the file and whichever current sidecars exist beside it into one
   * entry. Null when the file could not be read (gone between stat and
   * read), in which case the request takes the uncached path's answer.
   */
  private async buildEntry(
    filePath: string,
    stats: { mtimeMs: number; size: number; ino: number; mtime: Date },
    baseMimeType: string,
    contentType: string
  ): Promise<CacheEntry | null> {
    let body: Buffer;
    try {
      body = await fs.readFile(filePath);
    } catch {
      return null;
    }
    const stamp = stampOf(stats);
    const identity: CachedVariant = {
      encoding: '',
      path: filePath,
      stamp,
      body,
      etag: StaticCore.etagFor(stats, ''),
    };
    const sidecars: CachedVariant[] = [];
    const sidecarStamps: Array<FileStamp | null> = [];
    let bytes = body.length;
    if (this.precompressed) {
      const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
      for (const { encoding, suffix } of SIDECARS) {
        const found = await this.statSidecar(filePath + suffix, rootWithSep);
        sidecarStamps.push(found ? stampOf(found.stats) : null);
        // A sidecar older than its source is a stale body for a replaced
        // asset: not served, and its stamp is still remembered so a later
        // touch of it is noticed.
        if (!found || found.stats.mtimeMs < stats.mtimeMs) continue;
        let sideBody: Buffer;
        try {
          sideBody = await fs.readFile(found.real);
        } catch {
          continue;
        }
        sidecars.push({
          encoding,
          path: found.real,
          stamp: stampOf(found.stats),
          body: sideBody,
          etag: StaticCore.etagFor(stats, encoding),
        });
        bytes += sideBody.length;
      }
    }
    return {
      filePath,
      baseMimeType,
      contentType,
      mtime: stats.mtime,
      lastModified: stats.mtime.toUTCString(),
      identity,
      sidecars,
      sidecarStamps,
      bytes,
      checkedAt: Date.now(),
    };
  }

  /** The sidecar at `candidate` when it is a regular file inside the root. */
  private async statSidecar(
    candidate: string,
    rootWithSep: string
  ): Promise<{ real: string; stats: Stats } | null> {
    try {
      const real = await fs.realpath(candidate);
      if (!real.startsWith(rootWithSep)) return null;
      const stats = await fs.stat(real);
      if (!stats.isFile()) return null;
      return { real, stats };
    } catch {
      return null;
    }
  }

  /**
   * Whether the disk still matches the entry: the original and every sidecar
   * position (present or absent when the entry was built) are stat'ed and
   * compared on mtime, size and inode, so a same-length replacement counts
   * as a change and a sidecar that appeared or vanished does too.
   */
  private async stillCurrent(entry: CacheEntry): Promise<boolean> {
    let stats;
    try {
      stats = await fs.stat(entry.filePath);
    } catch {
      return false;
    }
    if (!stats.isFile() || !sameStamp(stampOf(stats), entry.identity.stamp)) return false;
    if (this.precompressed) {
      for (let i = 0; i < SIDECARS.length; i++) {
        let now: FileStamp | null = null;
        try {
          const st = await fs.stat(entry.filePath + (SIDECARS[i] as { suffix: string }).suffix);
          if (st.isFile()) now = stampOf(st);
        } catch {
          // absent
        }
        if (!sameStamp(now, entry.sidecarStamps[i] ?? null)) return false;
      }
    }
    return true;
  }

  private insert(key: string, entry: CacheEntry): void {
    const cache = this.cache;
    if (cache === null) return;
    const old = cache.get(key);
    if (old !== undefined) this.evict(key, old);
    cache.set(key, entry);
    this.cacheBytes += entry.bytes;
    // Over budget: the oldest entries go first (insertion order).
    for (const [k, e] of cache) {
      if (this.cacheBytes <= this.cacheMaxBytes || k === key) break;
      this.evict(k, e);
    }
    this.ensureWatcher();
  }

  private evict(key: string, entry: CacheEntry): void {
    if (this.cache !== null && this.cache.delete(key)) this.cacheBytes -= entry.bytes;
  }

  /**
   * One watcher on the root directory: any change reported there marks every
   * entry for revalidation on its next request, ahead of `revalidateMs`.
   * Non-persistent, so it never keeps the process alive, and best effort: a
   * platform or filesystem without change events simply falls back to the
   * timed revalidation.
   */
  private ensureWatcher(): void {
    if (!this.watchWanted || this.watcher !== null) return;
    try {
      const watcher = watchDir(this.root, { persistent: false }, () => {
        if (this.cache === null) return;
        for (const entry of this.cache.values()) entry.checkedAt = 0;
      });
      watcher.on('error', () => {
        this.watcher = null;
        this.watchWanted = false; // a dead watcher is not retried
      });
      this.watcher = watcher;
    } catch {
      this.watchWanted = false;
    }
  }

  /** Stop the directory watcher and drop every cached file. */
  close(): void {
    if (this.watcher !== null) {
      try {
        this.watcher.close();
      } catch {
        // already closed
      }
      this.watcher = null;
    }
    if (this.cache !== null) {
      this.cache.clear();
      this.cacheBytes = 0;
    }
  }

  /** Answer a request from a cache entry: the same headers and bytes the uncached path sends. */
  private serveCached(req: HttpRequest, res: HttpResponse, entry: CacheEntry): boolean {
    res.setHeader('Content-Type', entry.contentType);
    let variant = entry.identity;
    if (this.precompressed) {
      res.setHeader('Vary', 'Accept-Encoding');
      const sidecars = entry.sidecars;
      if (sidecars.length > 0) {
        const acceptEncoding = req.headers['accept-encoding'];
        if (acceptEncoding) {
          for (let i = 0; i < sidecars.length; i++) {
            const candidate = sidecars[i] as CachedVariant;
            if (negotiateEncoding(acceptEncoding, [candidate.encoding as 'br' | 'gzip']) !== null) {
              variant = candidate;
              break;
            }
          }
        }
      }
    }
    if (this.maxAge > 0) {
      res.setHeader('Cache-Control', `public, max-age=${this.maxAge}`);
    }
    if (this.lastModified) {
      res.setHeader('Last-Modified', entry.lastModified);
    }
    if (this.acceptRanges) {
      res.setHeader('Accept-Ranges', 'bytes');
    }
    const etag = this.etag ? variant.etag : undefined;
    if (etag !== undefined) res.setHeader('ETag', etag);
    if (this.isNotModified(req, entry.mtime, etag)) {
      res.statusCode = 304;
      res.end();
      return true;
    }
    if (variant.encoding !== '') {
      res.setHeader('Content-Encoding', variant.encoding);
      res.setHeader('Content-Length', variant.body.length);
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      res.end(variant.body);
      return true;
    }
    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', variant.body.length);
      res.end();
      return true;
    }
    this.sendBody(res, variant.body, entry.baseMimeType);
    return true;
  }

  /**
   * The identity body of a small file. A compressible one goes through
   * send() so it joins the server's response compression (the compression
   * middleware or performance.compression) exactly like a handler's body
   * would; send() sets Content-Length itself. Binary bodies are ended as they
   * are, with their length.
   */
  private sendBody(res: HttpResponse, data: Buffer, baseMimeType: string): void {
    if (isCompressible(baseMimeType) && typeof (res as any).send === 'function') {
      (res as any).send(data);
    } else {
      res.setHeader('Content-Length', data.length);
      res.end(data);
    }
  }

  /**
   * The strong ETag of one representation: the file's mtime and size, plus
   * the encoding for a sidecar, since a strong ETag must differ between
   * representations (RFC 9110 8.8.1).
   */
  private static etagFor(stats: { mtimeMs: number; size: number }, encoding: string): string {
    return `"${crypto
      .createHash('md5')
      .update(`${Math.trunc(stats.mtimeMs)}-${stats.size}`)
      .digest('hex')}${encoding ? `-${encoding}` : ''}"`;
  }

  /**
   * The best precompressed sidecar for `filePath` that the client accepts, or
   * null. A sidecar must be a regular file INSIDE the root (its real path is
   * checked like the source's, so a symlinked `.br` cannot reach outside) and
   * at least as new as the source, so a replaced asset never ships a stale
   * compressed body.
   */
  private async findSidecar(
    filePath: string,
    sourceMtime: Date,
    acceptEncoding: string | undefined
  ): Promise<{ path: string; encoding: string; stats: { size: number } } | null> {
    if (!acceptEncoding) return null;
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    for (const { encoding, suffix } of SIDECARS) {
      if (negotiateEncoding(acceptEncoding, [encoding]) !== encoding) continue;
      const candidate = filePath + suffix;
      try {
        const real = await fs.realpath(candidate);
        if (!real.startsWith(rootWithSep)) continue;
        const st = await fs.stat(real);
        if (!st.isFile() || st.mtime.getTime() < sourceMtime.getTime()) continue;
        return { path: real, encoding, stats: { size: st.size } };
      } catch {
        // no sidecar for this encoding
      }
    }
    return null;
  }

  /**
   * Whether the client's cached copy is still current. `If-None-Match` wins
   * over `If-Modified-Since` when both are present (RFC 9110 13.1.3).
   */
  private isNotModified(req: HttpRequest, mtime: Date, etag?: string): boolean {
    const ifNoneMatch = req.headers['if-none-match'];
    if (etag && ifNoneMatch) {
      if (ifNoneMatch === '*') return true;
      return ifNoneMatch
        .split(',')
        .some(candidate => candidate.trim().replace(/^W\//, '') === etag);
    }

    if (this.lastModified) {
      const ifModifiedSince = req.headers['if-modified-since'];
      if (ifModifiedSince) {
        const since = Date.parse(ifModifiedSince);
        // HTTP dates carry second precision, so compare at that resolution
        if (!Number.isNaN(since)) {
          return Math.floor(mtime.getTime() / 1000) <= Math.floor(since / 1000);
        }
      }
    }

    return false;
  }

  /**
   * The byte range to serve, `'unsatisfiable'` for a 416, or null to send the
   * whole entity — which is also the answer for a multi-range request and for
   * an `If-Range` that no longer matches.
   */
  private resolveRange(
    req: HttpRequest,
    stats: { size: number; mtime: Date },
    etag?: string
  ): { start: number; end: number } | 'unsatisfiable' | null {
    const rangeHeader = req.headers.range;
    if (!rangeHeader) return null;

    const ifRange = req.headers['if-range'];
    if (ifRange) {
      const asDate = Date.parse(ifRange);
      const matches =
        (etag !== undefined && ifRange.trim() === etag) ||
        (!Number.isNaN(asDate) &&
          Math.floor(stats.mtime.getTime() / 1000) <= Math.floor(asDate / 1000));
      if (!matches) return null;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) return null;

    const size = stats.size;
    const [, rawStart, rawEnd] = match;
    let start: number;
    let end: number;

    if (rawStart === '') {
      // Suffix form: the last N bytes
      const suffix = parseInt(rawEnd as string, 10);
      if (!suffix) return 'unsatisfiable';
      start = Math.max(size - suffix, 0);
      end = size - 1;
    } else {
      start = parseInt(rawStart as string, 10);
      end = rawEnd === '' ? size - 1 : Math.min(parseInt(rawEnd as string, 10), size - 1);
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return 'unsatisfiable';
    }

    return { start, end };
  }

  /**
   * Pipe a file (or a slice of one) to the response, closing it on abort.
   * Resolves once the response is done — the caller must not return before
   * then, or the router would see an untouched response and 404 the request.
   */
  private streamFile(
    filePath: string,
    res: HttpResponse,
    range?: { start: number; end: number }
  ): Promise<void> {
    const stream = range
      ? createReadStream(filePath, { start: range.start, end: range.end })
      : createReadStream(filePath);

    return new Promise<void>(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      // A client that disconnects mid-download must not leak the descriptor
      (res as any).once?.('close', () => {
        stream.destroy();
        done();
      });

      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: 'Internal server error' });
        } else {
          res.end();
        }
        done();
      });

      stream.on('end', done);
      stream.pipe(res as any);
    });
  }

  /** Read just the requested slice — the fallback where piping isn't available. */
  private static async readSlice(filePath: string, start: number, length: number): Promise<Buffer> {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** HTTP/2 responses are plain objects with no stream plumbing to pipe into. */
  private static canStream(res: HttpResponse): boolean {
    const writable = res as any;
    return typeof writable.write === 'function' && typeof writable.on === 'function';
  }

  /**
   * `/assets/` -> `/assets`, `/` and `''` -> `''` (serve from the URL root).
   * A prefix given without a leading slash still mounts where you'd expect.
   */
  private static normalizePrefix(prefix?: string): string {
    if (!prefix) return '';
    let normalized = prefix.trim();
    if (!normalized.startsWith('/')) normalized = `/${normalized}`;
    while (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized === '/' ? '' : normalized;
  }

  /**
   * Request path relative to the mount point, or `null` when the request falls
   * outside it. `/assets` itself maps to `/` so the directory index still
   * resolves; `/assetsfoo` is a different route and is left alone.
   */
  private stripPrefix(reqPath: string): string | null {
    if (!this.prefix) return reqPath;
    if (reqPath === this.prefix) return '/';
    if (reqPath.startsWith(`${this.prefix}/`)) return reqPath.slice(this.prefix.length);
    return null;
  }

  private addCharsetIfNeeded(mimeType: string): string {
    const textTypes = [
      'text/',
      'application/json',
      'application/javascript',
      'application/xml',
      'application/yaml',
      'image/svg+xml',
    ];
    const needsCharset =
      textTypes.some(type => mimeType.startsWith(type)) ||
      mimeType.endsWith('+json') ||
      mimeType.endsWith('+xml');
    return needsCharset ? `${mimeType}; charset=utf-8` : mimeType;
  }

  getRoot(): string {
    return this.root;
  }

  getPrefix(): string {
    return this.prefix;
  }
}
