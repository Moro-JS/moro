// File Upload Middleware
import { Middleware } from '../../../../types/http.js';
import { UploadCore, UploadOptions } from './core.js';
import { isMultipartMediaType } from '../../../http/utils/body-type.js';

/**
 * Create file upload middleware
 *
 * Validates the files of a `multipart/form-data` request and puts them on
 * `req.files`. With `dest`, a file is stored when the handler asks for it
 * (`file.path`, or `await file.save()`): nothing is written for a request
 * that never reaches a handler, and what a request stored is removed again
 * when it is answered with an error.
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
 *   verifyContent: true, // the bytes must be what the file says it is
 * }));
 * ```
 */
export function createUploadMiddleware(options: UploadOptions = {}): Middleware {
  const core = new UploadCore(options);

  return async (req, res, next) => {
    // The media type itself, not a substring: `application/json;
    // x=multipart/form-data` is a JSON request
    if (!isMultipartMediaType(req.headers['content-type'])) {
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

      // Only touches disk when a dest was configured, and then only once
      // the handler asks for the file
      core.deferPersistence(req.files, res);
    }

    next();
  };
}
