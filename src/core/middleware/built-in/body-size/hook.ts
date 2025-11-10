// Body Size Hook Integration
import { BodySizeCore, BodySizeOptions } from './core.js';

export function registerBodySizeHooks(hookManager: any, options: BodySizeOptions = {}): void {
  const core = new BodySizeCore(options);

  hookManager.on('request', async (context: any) => {
    const { request, response } = context;
    if (!request || !response) return;

    core.checkBodySize(request, response);
  });
}
