// HTTP Range Requests Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import * as fs from 'fs/promises';
import { randomBytes } from 'crypto';
import { createFrameworkLogger } from '../../../logger/index.js';
import { assertRoot, locateFile, type DotfilePolicy } from '../../../http/utils/file-send.js';
import { contentTypeForFile } from '../../../http/utils/mime-types.js';

const logger = createFrameworkLogger('RangeMiddleware');

export interface RangeOptions {
  acceptRanges?: string;
  maxRanges?: number;
  /**
   * Directory that `res.sendRange()` paths are resolved against and confined
   * to: a path that leads outside it (`../`, an absolute path, a symlink) is
   * answered with a 404. Unset, `sendRange()` serves the path it is given.
   * A call can pass its own: `res.sendRange(file, { root })`.
   */
  root?: string;
  /**
   * What `res.sendRange()` does with a hidden path, as for `staticFiles`:
   * `'ignore'` (the default) answers 404, `'deny'` 403, `'allow'` serves it.
   * With a `root`, a path is hidden when any segment below the root starts
   * with a dot, in the path as given or in the path it resolves to; without
   * one, when the file's own name does. `.well-known` is never hidden.
   */
  dotfiles?: DotfilePolicy;
}

/** Second argument of `res.sendRange()`, when it is not an `fs.Stats`. */
export interface SendRangeOptions {
  /** Confine this call to a directory; overrides the middleware's `root`. */
  root?: string;
  /** Dotfile policy for this call; overrides the middleware's `dotfiles`. */
  dotfiles?: DotfilePolicy;
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * What a `Range` header asks for:
 * - a list of ranges, each one already clamped to the file;
 * - `'unsatisfiable'` when it is well formed but none of it overlaps the file
 *   (a 416);
 * - `null` when the header is to be ignored and the whole file sent - bad
 *   syntax, a unit other than bytes, or more ranges than `maxRanges` allows.
 */
type ParsedRange = ByteRange[] | 'unsatisfiable' | null;

// One range-spec: `first-last`, `first-` or the suffix form `-length`. Digits
// only - parseInt() would also take `1e2`, `0x10` and `5junk`.
const RANGE_SPEC = /^(\d*)-(\d*)$/;

// Errors that mean "there is no such file" rather than "the server broke"
const NOT_FOUND_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'ENAMETOOLONG',
  'ELOOP',
  // A path with a NUL byte in it
  'ERR_INVALID_ARG_VALUE',
]);

export class RangeCore {
  // Bytes read and written per step when streaming
  private static readonly CHUNK_SIZE = 64 * 1024;

  private acceptRanges: string;
  private maxRanges: number;
  private servesRanges: boolean;
  private root: string | undefined;
  private dotfiles: DotfilePolicy;

  constructor(options: RangeOptions = {}) {
    // Checked at setup: a root that was meant to be set and came out empty
    // must not quietly turn into "no confinement".
    if (options.root !== undefined) assertRoot(options.root, 'sendRange');
    this.root = options.root;
    this.dotfiles = RangeCore.dotfilePolicy(options.dotfiles) ?? 'ignore';
    this.acceptRanges = options.acceptRanges || 'bytes';
    const maxRanges = Number(options.maxRanges);
    this.maxRanges = Number.isInteger(maxRanges) && maxRanges > 0 ? maxRanges : 1;
    // Bytes is the only unit there is a parser for; advertising anything else
    // (`none` included) means Range headers are not honoured.
    this.servesRanges = this.acceptRanges.trim().toLowerCase() === 'bytes';
  }

  addRangeMethod(req: HttpRequest, res: HttpResponse): void {
    (res as any).sendRange = (filePath: string, statsOrOptions?: any) =>
      this.sendRange(req, res, filePath, statsOrOptions);
  }

  /**
   * Send a file, honouring `Range` and `If-Range`.
   *
   * The second argument is either an `fs.Stats` or `{ root }`. Stats only save
   * the pre-flight stat: size comes from the descriptor the bytes are then
   * read from, so a file replaced between the caller's stat and this call
   * can't produce a Content-Length that disagrees with the body.
   */
  private async sendRange(
    req: HttpRequest,
    res: HttpResponse,
    requestedPath: string,
    statsOrOptions?: any
  ): Promise<void> {
    let handle: fs.FileHandle | undefined;
    // True once this call has put the file's Content-Type on the response
    let typed = false;
    try {
      const isStats = !!statsOrOptions && typeof statsOrOptions.isFile === 'function';
      const callOptions = !isStats && statsOrOptions ? statsOrOptions : undefined;
      const callRoot = callOptions !== undefined ? callOptions.root : undefined;
      const root = callRoot !== undefined ? callRoot : this.root;
      const dotfiles =
        (callOptions !== undefined ? RangeCore.dotfilePolicy(callOptions.dotfiles) : undefined) ??
        this.dotfiles;

      // Where the file may be served from: inside the root when there is
      // one, and never a hidden path unless the policy allows it.
      if (root !== undefined) assertRoot(root, 'sendRange');
      const located = await locateFile(requestedPath, root, dotfiles);
      if (located === 'forbidden') {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
      }
      if (located === 'not-found') {
        this.sendNotFound(res);
        return;
      }
      const filePath = located;

      // Checked before open(): opening a FIFO blocks until something writes to
      // it, and a directory opens fine and only fails on the first read.
      // Caller-supplied stats are for the path as the caller spelled it, so
      // they are only trusted when no root has re-resolved that path.
      const preflight = isStats && root === undefined ? statsOrOptions : await fs.stat(filePath);
      if (!preflight.isFile()) {
        this.sendNotFound(res);
        return;
      }

      handle = await fs.open(filePath, 'r');
      const opened = await handle.stat();
      if (!opened.isFile()) {
        this.sendNotFound(res);
        return;
      }

      const fileSize = opened.size;
      const isHead = req.method === 'HEAD';
      res.setHeader('Accept-Ranges', this.acceptRanges);

      // The file's own type, unless the handler has already said what it is,
      // and never one the browser is left to guess from the bytes.
      const getHeader = (res as any).getHeader;
      if (typeof getHeader !== 'function' || !getHeader.call(res, 'Content-Type')) {
        res.setHeader('Content-Type', contentTypeForFile(filePath));
        typed = true;
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Range is defined for GET only, and is ignored when the representation
      // the client holds a piece of is no longer the current one.
      const rangeHeader = req.headers.range;
      const parsed: ParsedRange =
        this.servesRanges &&
        typeof rangeHeader === 'string' &&
        (req.method === undefined || req.method === 'GET') &&
        this.ifRangeMatches(req, res)
          ? this.parseRangeHeader(rangeHeader, fileSize)
          : null;

      if (parsed === 'unsatisfiable') {
        // The body is a JSON error, not a piece of the file
        if (typed) RangeCore.dropContentType(res);
        res.status(416);
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        res.json({ success: false, error: 'Range not satisfiable' });
        return;
      }

      if (parsed === null) {
        res.setHeader('Content-Length', fileSize);
        if (isHead || fileSize === 0) {
          res.end();
          return;
        }
        if (!RangeCore.canStream(res)) {
          res.end(await handle.readFile());
        } else if (await this.pump(handle, res, 0, fileSize)) {
          res.end();
        }
        return;
      }

      const [first] = parsed;
      if (parsed.length === 1 && first) {
        await this.sendSingleRange(handle, fileSize, first, res);
      } else {
        await this.sendMultipleRanges(handle, fileSize, parsed, res);
      }
    } catch (error) {
      if (typed && !res.headersSent) RangeCore.dropContentType(res);
      this.sendFailure(res, error);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  private static dropContentType(res: HttpResponse): void {
    if (typeof (res as any).removeHeader === 'function') (res as any).removeHeader('Content-Type');
  }

  private static dotfilePolicy(value: unknown): DotfilePolicy | undefined {
    return value === 'allow' || value === 'deny' || value === 'ignore' ? value : undefined;
  }

  private parseRangeHeader(header: string, fileSize: number): ParsedRange {
    const eq = header.indexOf('=');
    if (eq === -1 || header.slice(0, eq).trim().toLowerCase() !== 'bytes') return null;

    // Count before splitting, so a header that is all commas costs one pass
    // and no allocation.
    let count = 1;
    for (let i = eq + 1; i < header.length; i++) {
      if (header.charCodeAt(i) === 44 && ++count > this.maxRanges) return null;
    }

    const ranges: ByteRange[] = [];
    let requested = 0;

    for (const spec of header.slice(eq + 1).split(',')) {
      const match = RANGE_SPEC.exec(spec.trim());
      if (!match) return null;

      const rawStart = match[1] as string;
      const rawEnd = match[2] as string;
      if (rawStart === '' && rawEnd === '') return null;

      let start: number;
      let end: number;

      if (rawStart === '') {
        // Suffix form: the last N bytes, or the whole file when it is shorter
        const suffix = Number(rawEnd);
        if (suffix === 0) continue;
        start = Math.max(fileSize - suffix, 0);
        end = fileSize - 1;
      } else {
        start = Number(rawStart);
        // A last-pos at or past the end means "to the end"
        end = rawEnd === '' ? fileSize - 1 : Math.min(Number(rawEnd), fileSize - 1);
      }

      // Past the end of the file, or first-pos > last-pos
      if (start >= fileSize || start > end) continue;

      ranges.push({ start, end });
      requested += end - start + 1;
    }

    if (ranges.length === 0) return 'unsatisfiable';

    // Several ranges that add up to the file or more (overlapping ones, say)
    // would make the multipart answer larger than the file itself.
    if (ranges.length > 1 && requested >= fileSize) return null;

    return ranges;
  }

  /**
   * `If-Range` makes the range conditional on the client's copy still being
   * current. It can only be checked against a validator the handler has put on
   * this response (`ETag` or `Last-Modified`); with nothing to compare to, the
   * precondition fails and the whole file is sent, which is always correct.
   */
  private ifRangeMatches(req: HttpRequest, res: HttpResponse): boolean {
    const header = req.headers['if-range'];
    if (header === undefined) return true;

    const ifRange = String(header).trim();
    const getHeader = (name: string): unknown =>
      typeof (res as any).getHeader === 'function' ? (res as any).getHeader(name) : undefined;

    // Strong comparison: a weak validator never matches
    if (ifRange.startsWith('"')) return getHeader('ETag') === ifRange;
    if (ifRange.startsWith('W/')) return false;

    const lastModified = getHeader('Last-Modified');
    if (typeof lastModified !== 'string') return false;
    const expected = Date.parse(lastModified);
    return !Number.isNaN(expected) && expected === Date.parse(ifRange);
  }

  private async sendSingleRange(
    handle: fs.FileHandle,
    fileSize: number,
    range: ByteRange,
    res: HttpResponse
  ): Promise<void> {
    const { start, end } = range;
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);

    if (!RangeCore.canStream(res)) {
      res.end(await RangeCore.readSlice(handle, start, chunkSize));
    } else if (await this.pump(handle, res, start, chunkSize)) {
      res.end();
    }
  }

  private async sendMultipleRanges(
    handle: fs.FileHandle,
    fileSize: number,
    ranges: ByteRange[],
    res: HttpResponse
  ): Promise<void> {
    // Unpredictable, so file content can't be crafted to contain it
    const boundary = randomBytes(12).toString('hex');
    const existingType =
      typeof (res as any).getHeader === 'function' ? (res as any).getHeader('Content-Type') : null;
    const partType =
      typeof existingType === 'string' && existingType ? existingType : 'application/octet-stream';

    const heads = ranges.map(({ start, end }) =>
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Type: ${partType}\r\n` +
          `Content-Range: bytes ${start}-${end}/${fileSize}\r\n\r\n`
      )
    );
    const partEnd = Buffer.from('\r\n');
    const tail = Buffer.from(`--${boundary}--\r\n`);

    let contentLength = tail.length;
    ranges.forEach(({ start, end }, i) => {
      contentLength += (heads[i] as Buffer).length + (end - start + 1) + partEnd.length;
    });

    res.status(206);
    res.setHeader('Content-Type', `multipart/byteranges; boundary=${boundary}`);
    res.setHeader('Content-Length', contentLength);

    if (!RangeCore.canStream(res)) {
      const parts: Buffer[] = [];
      for (let i = 0; i < ranges.length; i++) {
        const { start, end } = ranges[i] as ByteRange;
        parts.push(heads[i] as Buffer);
        parts.push(await RangeCore.readSlice(handle, start, end - start + 1));
        parts.push(partEnd);
      }
      parts.push(tail);
      res.end(Buffer.concat(parts));
      return;
    }

    for (let i = 0; i < ranges.length; i++) {
      const { start, end } = ranges[i] as ByteRange;
      res.write(heads[i] as Buffer);
      // false: the client went away mid-part, nothing left to write to
      if (!(await this.pump(handle, res, start, end - start + 1))) return;
      res.write(partEnd);
    }
    res.end(tail);
  }

  /**
   * Copy `length` bytes of the file, from `start`, into the response, waiting
   * on 'drain' whenever the response pushes back. Resolves `true` once they
   * are all written and `false` if the client disconnected first; a read error
   * rejects into sendRange's catch.
   *
   * Plain positional reads on the caller's handle, not a read stream: a stream
   * closes the descriptor it is given when destroyed (several slices share
   * one), and a stream 'error' nobody is listening for takes the process down.
   */
  private async pump(
    handle: fs.FileHandle,
    res: HttpResponse,
    start: number,
    length: number
  ): Promise<boolean> {
    const sink = res as any;
    let closed = false;
    let wake: (() => void) | null = null;
    const onClose = () => {
      closed = true;
      if (wake) wake();
    };
    const onDrain = () => {
      if (wake) wake();
    };

    sink.on('close', onClose);
    sink.on('drain', onDrain);
    try {
      let position = start;
      let remaining = length;

      while (remaining > 0) {
        if (closed) return false;

        // A fresh buffer per chunk: the response may hold on to what it is
        // handed until the socket takes it.
        const chunk = Buffer.allocUnsafe(Math.min(remaining, RangeCore.CHUNK_SIZE));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) {
          throw new Error('File ended before the declared Content-Length was sent');
        }
        if (closed) return false;

        position += bytesRead;
        remaining -= bytesRead;

        const flushed = sink.write(
          bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead)
        );
        if (flushed === false && remaining > 0 && !closed) {
          await new Promise<void>(resolve => {
            wake = resolve;
          });
          wake = null;
        }
      }

      return !closed;
    } finally {
      sink.removeListener('close', onClose);
      sink.removeListener('drain', onDrain);
    }
  }

  /** Read one slice into memory - the fallback where streaming isn't available. */
  private static async readSlice(
    handle: fs.FileHandle,
    start: number,
    length: number
  ): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  }

  /**
   * Whether the body is written in chunks with backpressure. The HTTP/2
   * server's response (the one carrying its stream as `_stream`) is always
   * answered from memory with a single end().
   */
  private static canStream(res: HttpResponse): boolean {
    const writable = res as any;
    if (writable._stream !== undefined) return false;
    return (
      typeof writable.write === 'function' &&
      typeof writable.on === 'function' &&
      typeof writable.removeListener === 'function'
    );
  }

  private sendNotFound(res: HttpResponse): void {
    res.status(404).json({ success: false, error: 'File not found' });
  }

  /**
   * The client gets a status and nothing else: an fs error message carries the
   * absolute path on disk, which belongs in the log and not in the response.
   */
  private sendFailure(res: HttpResponse, error: unknown): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const notFound = code !== undefined && NOT_FOUND_CODES.has(code);

    if (!notFound) {
      logger.error('Range request failed', 'SendRange', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (res.headersSent) {
      // Part of the body is already on the wire, short of the declared
      // Content-Length. Drop the connection so the client sees a truncated
      // transfer instead of waiting on a keep-alive socket for the rest; the
      // engine has no destroy() and does the same itself on a short end().
      if (typeof (res as any).destroy === 'function') {
        (res as any).destroy();
      } else {
        res.end();
      }
      return;
    }

    // Headers describing the body that is no longer coming
    if (typeof (res as any).removeHeader === 'function') {
      (res as any).removeHeader('Content-Range');
      (res as any).removeHeader('Content-Length');
    }

    if (notFound) {
      this.sendNotFound(res);
    } else {
      res.status(500).json({ success: false, error: 'Range request failed' });
    }
  }

  getAcceptRanges(): string {
    return this.acceptRanges;
  }

  getMaxRanges(): number {
    return this.maxRanges;
  }
}
