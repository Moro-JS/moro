// Range Requests Hook Integration
import { RangeCore, RangeOptions } from './core.js';

export function registerRangeHooks(hookManager: any, options: RangeOptions = {}): void {
  const core = new RangeCore(options);

  hookManager.on('request', async (context: any) => {
    const { request, response } = context;
    if (!request || !response) return;

    core.addRangeMethod(request, response);
  });
}
