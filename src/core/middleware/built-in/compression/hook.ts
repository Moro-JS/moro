// Compression Hook Integration
import { CompressionCore, CompressionOptions } from './core.js';

export function registerCompressionHooks(hookManager: any, options: CompressionOptions = {}): void {
  const core = new CompressionCore(options);

  hookManager.on('request', async (context: any) => {
    const { request, response } = context;
    if (!request || !response) return;

    if (core.shouldCompress(request, response)) {
      core.wrapResponse(request, response);
    }
  });
}
