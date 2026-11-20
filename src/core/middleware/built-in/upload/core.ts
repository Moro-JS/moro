// File Upload Core Logic
import * as crypto from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { isMultipartBody } from '../../../http/utils/multipart-parser.js';
import { FILE_MIME_TYPES } from '../../../http/utils/mime-types.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { contentSignature, signaturesForType, typesForSignature } from './content-type.js';

const logger = createFrameworkLogger('UploadMiddleware');

// Pre-compiled regex — avoids recompilation per file
// eslint-disable-next-line no-control-regex
const RE_CONTROL_CHARS = /[\x00-\x1f]/g;

export interface UploadOptions {
  /**
   * Directory to write uploads to. Files are also kept in memory on
   * `file.data`; set this when you want them on disk, and each file gains a
   * `path`. Left unset, nothing is written.
   *
   * A file is written when the handler asks for it - by reading `file.path`
   * (or `file.destination`), or with `await file.save()` - and not before:
   * a request that never reaches a handler, or whose handler never looks at
   * the file, leaves nothing in `dest`.
   */
  dest?: string;
  maxFileSize?: number;
  maxFiles?: number;
  /**
   * Media types a file may declare (the part's own `Content-Type`, as the
   * client sent it). Add `verifyContent` to check the bytes as well.
   */
  allowedTypes?: string[];
  /**
   * Check each file's leading bytes against its declared type, for the types
   * that have a signature (JPEG, PNG, GIF, WebP, BMP, TIFF, ICO, AVIF, HEIC,
   * PDF, ZIP and the ZIP-based office formats, gzip, MP4, QuickTime, WebM,
   * MP3, WAV, Ogg, FLAC, WOFF, WOFF2). A file whose bytes are not what it
   * says it is gets a 400, as does a file of a recognisable type that
   * `allowedTypes` does not list. A file written to `dest` is also stored
   * under the extension of its type instead of the one the client sent.
   * Default false: only the declared type is checked.
   */
  verifyContent?: boolean;
  /**
   * When files written to `dest` for a request are removed again:
   * - `'failed'` (default): when the request is answered with an error (a
   *   4xx or 5xx status);
   * - `'always'`: when the response is over, whatever its status - `dest`
   *   is then a staging area, and the handler moves what it wants to keep;
   * - `'never'`: files are left where they were written.
   * A file the handler has already moved or removed is left alone.
   */
  cleanup?: 'failed' | 'always' | 'never';
}

export interface UploadedFile {
  filename: string;
  mimetype: string;
  data: Buffer;
  size: number;
  /**
   * Absolute path of the stored file - present only when `dest` is set. The
   * file is written, once, the first time this is read.
   */
  path?: string;
  /** Directory the file was written to; reading it stores the file, as `path` does. */
  destination?: string;
  /**
   * Store the file in `dest` without blocking and resolve to its path - the
   * choice for large files. Present only when `dest` is set.
   */
  save?(): Promise<string>;
}

// Extension a stored file gets for a media type, when the server picks it
const EXTENSION_FOR_TYPE: Record<string, string> = {};
for (const [extension, type] of Object.entries(FILE_MIME_TYPES)) {
  if (EXTENSION_FOR_TYPE[type] === undefined) EXTENSION_FOR_TYPE[type] = extension;
}

function dataProperty(value: unknown): PropertyDescriptor {
  return { value, writable: true, enumerable: true, configurable: true };
}

// The reason stays in the log: an fs error message carries paths on disk
function reportStoreFailure(error: unknown): void {
  logger.error('Failed to store an uploaded file', 'Upload', {
    error: error instanceof Error ? error.message : String(error),
  });
}

export class UploadCore {
  private dest: string | undefined;
  private maxFileSize: number;
  private maxFiles: number;
  private allowedTypes?: string[] | undefined;
  private verifyContent: boolean;
  private cleanup: 'failed' | 'always' | 'never';

  constructor(options: UploadOptions = {}) {
    // Undefined by default: writing every upload to /tmp behind the user's back
    // would be a surprise, so files only hit disk when a dest is asked for.
    this.dest = options.dest;
    this.maxFileSize = options.maxFileSize || 5 * 1024 * 1024; // 5MB default
    this.maxFiles = options.maxFiles || 10;
    this.allowedTypes = options.allowedTypes;
    this.verifyContent = options.verifyContent === true;
    this.cleanup =
      options.cleanup === 'always' || options.cleanup === 'never' ? options.cleanup : 'failed';
  }

  validateUpload(files: Record<string, any>): { valid: boolean; error?: string } {
    // Validate file count
    const fileCount = Object.keys(files).length;
    if (fileCount > this.maxFiles) {
      return {
        valid: false,
        error: `Too many files. Maximum ${this.maxFiles} allowed.`,
      };
    }

    // Validate each file
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [fieldName, file] of Object.entries(files)) {
      const fileData = file as UploadedFile;

      if (!fileData || typeof fileData !== 'object') {
        return { valid: false, error: 'Invalid file upload.' };
      }

      // A filename that is not a string is not something the multipart parser
      // produces; it would otherwise fail later, inside path handling
      if (fileData.filename !== undefined && typeof fileData.filename !== 'string') {
        return { valid: false, error: 'Invalid filename.' };
      }

      // File contents are bytes, and the size is theirs - never the `size`
      // the object declares about itself.
      if (!Buffer.isBuffer(fileData.data)) {
        return { valid: false, error: 'Invalid file contents.' };
      }
      const size = fileData.data.length;
      fileData.size = size;

      // Validate file size
      if (size > this.maxFileSize) {
        return {
          valid: false,
          error: `File ${fileData.filename} is too large. Maximum ${this.formatSize(this.maxFileSize)} allowed.`,
        };
      }

      // Validate file type
      if (this.allowedTypes && !this.allowedTypes.includes(fileData.mimetype)) {
        return {
          valid: false,
          error: `File type ${fileData.mimetype} not allowed.`,
        };
      }

      // Validate the bytes against what the file says it is
      if (this.verifyContent) {
        const mismatch = this.contentMismatch(fileData);
        if (mismatch !== undefined) return { valid: false, error: mismatch };
      }
    }

    return { valid: true };
  }

  /**
   * Why a file's bytes disagree with its declared type, or undefined when
   * they do not. A declared type with a known signature must carry it. A
   * declared type without one (text, JSON, an unknown binary format) cannot
   * be confirmed, but its bytes must not be those of a recognisable type
   * that `allowedTypes` leaves out.
   */
  private contentMismatch(file: UploadedFile): string | undefined {
    const declared = typeof file.mimetype === 'string' ? file.mimetype : '';
    const signature = contentSignature(file.data);
    const expected = signaturesForType(declared);

    if (expected !== undefined) {
      return signature !== undefined && expected.includes(signature)
        ? undefined
        : `File ${file.filename} is not a valid ${declared} file.`;
    }
    if (signature !== undefined && this.allowedTypes) {
      const allowed = this.allowedTypes;
      if (!typesForSignature(signature).some(type => allowed.includes(type))) {
        return `File ${file.filename} does not match its declared type ${declared}.`;
      }
    }
    return undefined;
  }

  attachFiles(req: HttpRequest): void {
    // Files are taken only from the framework's multipart parser output. A
    // body of another type that happens to have a `files` key (JSON can say
    // anything about `size`, `mimetype` and `data`) is left alone.
    if (isMultipartBody(req.body) && req.body.files) {
      // Sanitize filenames to prevent path traversal when writing to disk
      for (const [, file] of Object.entries(req.body.files)) {
        const f = file as UploadedFile;
        if (f.filename && typeof f.filename === 'string') {
          (f as any).originalFilename = f.filename;
          f.filename = path.basename(f.filename).replace(RE_CONTROL_CHARS, '');
        }
      }
      req.files = req.body.files;
    }
  }

  /**
   * Arrange for the request's files to be stored in `dest` when the handler
   * asks, and for what was stored to be removed again if the request fails.
   * Nothing is written here: this runs ahead of routing when the middleware
   * is registered with `app.use()`, before it is known that the request has a
   * route, or that the route's guards will let it through.
   *
   * Each file gets a `path` and a `destination` that store it on first read
   * (synchronously, once) and a `save()` that stores it without blocking.
   * Stored names are randomized, so two uploads of the same filename can't
   * overwrite one another and a crafted name can't pick its own destination.
   * A no-op when no `dest` is configured.
   */
  deferPersistence(files: Record<string, any>, res?: HttpResponse): void {
    if (!this.dest) return;

    const destination = path.resolve(this.dest);
    const written: string[] = [];

    for (const [, file] of Object.entries(files)) {
      const uploaded = file as UploadedFile;
      if (!uploaded || !Buffer.isBuffer(uploaded.data)) continue;
      // Already arranged (the middleware ran twice, or persistFiles() after it)
      if (Object.prototype.hasOwnProperty.call(uploaded, 'save')) continue;

      // One target per file, chosen when it is first needed, so the blocking
      // and the non-blocking way of storing it can never produce two copies.
      let target: string | undefined;
      let stored = false;
      let pending: Promise<string> | undefined;

      const targetPath = (): string => {
        if (target === undefined) {
          target = path.join(
            destination,
            `${crypto.randomBytes(8).toString('hex')}-${this.storedName(uploaded)}`
          );
          written.push(target);
        }
        return target;
      };
      const settle = (where: string): string => {
        stored = true;
        // From here on these are ordinary properties again
        Object.defineProperty(uploaded, 'path', dataProperty(where));
        Object.defineProperty(uploaded, 'destination', dataProperty(destination));
        return where;
      };
      const storeNow = (): string => {
        if (stored) return target as string;
        const where = targetPath();
        try {
          try {
            writeFileSync(where, uploaded.data);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            mkdirSync(destination, { recursive: true });
            writeFileSync(where, uploaded.data);
          }
        } catch (error) {
          reportStoreFailure(error);
          throw error;
        }
        return settle(where);
      };
      const store = (): Promise<string> => {
        if (stored) return Promise.resolve(target as string);
        if (pending === undefined) {
          const where = targetPath();
          pending = fs
            .writeFile(where, uploaded.data)
            .catch(async (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
              await fs.mkdir(destination, { recursive: true });
              await fs.writeFile(where, uploaded.data);
            })
            .then(
              () => settle(where),
              error => {
                pending = undefined;
                reportStoreFailure(error);
                throw error;
              }
            );
        }
        return pending;
      };

      Object.defineProperty(uploaded, 'path', {
        enumerable: true,
        configurable: true,
        get: storeNow,
        set(value: unknown) {
          Object.defineProperty(uploaded, 'path', dataProperty(value));
        },
      });
      Object.defineProperty(uploaded, 'destination', {
        enumerable: true,
        configurable: true,
        get: () => {
          storeNow();
          return destination;
        },
        set(value: unknown) {
          Object.defineProperty(uploaded, 'destination', dataProperty(value));
        },
      });
      // Not enumerable: a file object still serializes and spreads as data
      Object.defineProperty(uploaded, 'save', {
        enumerable: false,
        configurable: true,
        writable: true,
        value: store,
      });
    }

    if (this.cleanup !== 'never' && res !== undefined) {
      this.removeWhenDone(res, written);
    }
  }

  /**
   * Write the uploaded files to `dest` now, recording where each one landed.
   * The middleware does not call this (it stores a file when the handler
   * asks); it is here for code that drives the core itself. A no-op when no
   * `dest` is configured.
   */
  async persistFiles(files: Record<string, any>): Promise<void> {
    if (!this.dest) return;
    this.deferPersistence(files);
    for (const [, file] of Object.entries(files)) {
      const uploaded = file as UploadedFile;
      if (uploaded && typeof uploaded.save === 'function') await uploaded.save();
    }
  }

  /**
   * Remove what this request stored once its response is over: always under
   * `cleanup: 'always'`, otherwise only when the request was answered with an
   * error status. A connection that closes before the handler has answered
   * is not taken for a failure: the handler may still be running, and may
   * yet record the file it stored.
   */
  private removeWhenDone(res: HttpResponse, written: string[]): void {
    const response = res as any;
    if (typeof response.on !== 'function') return;

    let settled = false;
    // 'close' is the one event every server's response ends with, whether
    // the response completed or not
    response.on('close', () => {
      if (settled) return;
      settled = true;
      if (written.length === 0) return;
      if (this.cleanup !== 'always' && !(Number(response.statusCode) >= 400)) return;
      for (const stored of written) {
        // Already moved or removed by the handler: nothing to do
        fs.unlink(stored).catch(() => undefined);
      }
    });
  }

  /**
   * The name a file is stored under, after its random prefix. The client's
   * (sanitized) name by default. With `verifyContent`, the extension is the
   * server's choice for the file's type unless the client's already means
   * that type: `page.html` uploaded as `image/png` is stored as `page.png`.
   */
  private storedName(file: UploadedFile): string {
    const safeName =
      path.basename(file.filename || 'upload').replace(RE_CONTROL_CHARS, '') || 'upload';
    if (!this.verifyContent) return safeName;

    const declared = (typeof file.mimetype === 'string' ? file.mimetype : '')
      .split(';')[0]
      ?.trim()
      .toLowerCase() as string;
    const extension = path.extname(safeName);
    const signature = contentSignature(file.data);
    const types = signature !== undefined ? typesForSignature(signature) : [declared];
    if (extension !== '' && types.includes(FILE_MIME_TYPES[extension.toLowerCase()] ?? '')) {
      return safeName;
    }
    const chosen =
      types.map(type => EXTENSION_FOR_TYPE[type]).find(found => found !== undefined) ?? '.bin';
    const stem = extension === '' ? safeName : safeName.slice(0, -extension.length);
    return `${stem || 'upload'}${chosen}`;
  }

  getDest(): string | undefined {
    return this.dest;
  }

  private formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
    } else if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(2)}KB`;
    }
    return `${bytes}B`;
  }

  getMaxFileSize(): number {
    return this.maxFileSize;
  }

  getMaxFiles(): number {
    return this.maxFiles;
  }

  getAllowedTypes(): string[] | undefined {
    return this.allowedTypes;
  }
}
