// Helmet Hook Integration
import { HelmetCore, HelmetOptions } from './core.js';

export function registerHelmetHooks(hookManager: any, options: HelmetOptions = {}): void {
  const core = new HelmetCore(options);

  hookManager.on('request', async (context: any) => {
    const { request, response } = context;
    if (!request || !response) return;

    core.applyHeaders(request, response);
  });
}
