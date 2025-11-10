// Upload Hook Integration
import { UploadCore, UploadOptions } from './core.js';

export function registerUploadHooks(hookManager: any, options: UploadOptions = {}): void {
  const core = new UploadCore(options);

  hookManager.on('request', async (context: any) => {
    const { request, response } = context;
    if (!request || !response) return;

    const contentType = request.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
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
