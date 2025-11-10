// File Upload Middleware
import { Middleware } from '../../../../types/http.js';
import { UploadCore, UploadOptions } from './core.js';

/**
 * Create file upload middleware
 *
 * @example
 * ```typescript
 * import { upload } from '@morojs/moro';
 *
 * app.use(upload({
 *   dest: './uploads',
 *   maxFileSize: 5 * 1024 * 1024, // 5MB
 *   maxFiles: 10,
 *   allowedTypes: ['image/jpeg', 'image/png', 'image/gif'],
 * }));
 * ```
 */
export function createUploadMiddleware(options: UploadOptions = {}): Middleware {
  const core = new UploadCore(options);

  return (req, res, next) => {
    const contentType = req.headers['content-type'] || '';

    if (!contentType.includes('multipart/form-data')) {
      next();
      return;
    }

    // File upload handling is built into body parsing
    // This middleware validates after parsing
    core.attachFiles(req);

    if (req.files) {
      const validation = core.validateUpload(req.files);
      if (!validation.valid) {
        res.status(400).json({
          success: false,
          error: validation.error,
        });
        return;
      }
    }

    next();
  };
}
