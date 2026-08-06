// File Upload Core Logic
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { HttpRequest } from '../../../../types/http.js';

// Pre-compiled regex — avoids recompilation per file
// eslint-disable-next-line no-control-regex
const RE_CONTROL_CHARS = /[\x00-\x1f]/g;

export interface UploadOptions {
  /**
   * Directory to write uploads to. Files are also kept in memory on
   * `file.data`; set this when you want them on disk, and each file gains a
   * `path`. Left unset, nothing is written.
   */
  dest?: string;
  maxFileSize?: number;
  maxFiles?: number;
  allowedTypes?: string[];
}

export interface UploadedFile {
  filename: string;
  mimetype: string;
  data: Buffer;
  size: number;
  /** Absolute path of the written file — present only when `dest` is set. */
  path?: string;
  /** Directory the file was written to. */
  destination?: string;
}

export class UploadCore {
  private dest: string | undefined;
  private maxFileSize: number;
  private maxFiles: number;
  private allowedTypes?: string[] | undefined;

  constructor(options: UploadOptions = {}) {
    // Undefined by default: writing every upload to /tmp behind the user's back
    // would be a surprise, so files only hit disk when a dest is asked for.
    this.dest = options.dest;
    this.maxFileSize = options.maxFileSize || 5 * 1024 * 1024; // 5MB default
    this.maxFiles = options.maxFiles || 10;
    this.allowedTypes = options.allowedTypes;
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

      // Validate file size
      if (fileData.size > this.maxFileSize) {
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
    }

    return { valid: true };
  }

  attachFiles(req: HttpRequest): void {
    if (req.body && req.body.files) {
      // Sanitize filenames to prevent path traversal when writing to disk
      for (const [, file] of Object.entries(req.body.files)) {
        const f = file as UploadedFile;
        if (f.filename) {
          (f as any).originalFilename = f.filename;
          f.filename = path.basename(f.filename).replace(RE_CONTROL_CHARS, '');
        }
      }
      req.files = req.body.files;
    }
  }

  /**
   * Write the uploaded files to `dest`, recording where each one landed.
   * Stored names are randomized, so two uploads of the same filename can't
   * overwrite one another and a crafted name can't pick its own destination.
   * A no-op when no `dest` is configured.
   */
  async persistFiles(files: Record<string, any>): Promise<void> {
    if (!this.dest) return;

    const destination = path.resolve(this.dest);
    await fs.mkdir(destination, { recursive: true });

    for (const [, file] of Object.entries(files)) {
      const uploaded = file as UploadedFile;
      if (!uploaded.data) continue;

      const safeName =
        path.basename(uploaded.filename || 'upload').replace(RE_CONTROL_CHARS, '') || 'upload';
      const target = path.join(destination, `${crypto.randomBytes(8).toString('hex')}-${safeName}`);

      await fs.writeFile(target, uploaded.data);
      uploaded.path = target;
      uploaded.destination = destination;
    }
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
