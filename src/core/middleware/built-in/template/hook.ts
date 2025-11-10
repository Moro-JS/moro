// Template Rendering Hook Integration
import { TemplateCore, TemplateOptions } from './core.js';

export function registerTemplateHooks(hookManager: any, options: TemplateOptions): void {
  const core = new TemplateCore(options);

  hookManager.on('request', async (context: any) => {
    const { request, response } = context;
    if (!request || !response) return;

    core.addRenderMethod(request, response);
  });
}
