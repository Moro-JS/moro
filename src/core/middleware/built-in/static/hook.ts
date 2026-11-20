// Static File Serving Hook Integration
import { StaticCore, StaticOptions } from './core.js';

export function registerStaticHooks(hookManager: any, options: StaticOptions): void {
  const core = new StaticCore(options);

  hookManager.on('request', async (context: any) => {
    const { request, response } = context;
    // A request that has already been answered is finished
    if (!request || !response || response.headersSent) return;

    await core.handleRequest(request, response);
  });
}
