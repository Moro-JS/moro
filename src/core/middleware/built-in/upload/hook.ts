// Upload Hook Integration
import { UploadCore, UploadOptions } from './core.js';
import { isMultipartMediaType } from '../../../http/utils/body-type.js';

export function registerUploadHooks(hookManager: any, options: UploadOptions = {}): void {
  const core = new UploadCore(options);

  hookManager.on('request', async (context: any) => {
    const { request, response } = context;
    // A request that has already been answered is finished
    if (!request || !response || response.headersSent) return;

    // The media type itself, not a substring
    if (!isMultipartMediaType(request.headers?.['content-type'])) {
      return;
    }

    core.attachFiles(request);

    if (request.files) {
      const validation = core.validateUpload(request.files);
      if (!validation.valid) {
        response.status(400).json({
          success: false,
          error: validation.error,
        });
      }
    }
  });
}
