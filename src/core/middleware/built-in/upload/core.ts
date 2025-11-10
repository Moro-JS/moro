// File Upload Core Logic
import { HttpRequest } from '../../../../types/http.js';

export interface UploadOptions {
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
}

export class UploadCore {
  private dest: string;
  private maxFileSize: number;
  private maxFiles: number;
  private allowedTypes?: string[];

  constructor(options: UploadOptions = {}) {
    this.dest = options.dest || '/tmp';
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
      req.files = req.body.files;
    }
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
