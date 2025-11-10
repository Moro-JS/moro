// HTTP/2 Hook Integration
import { Http2PushCore, Http2PushOptions } from './core.js';

/**
 * Register HTTP/2 hooks with the hook manager
 */
export function registerHttp2Hooks(hookManager: any, options: Http2PushOptions = {}): void {
  const core = new Http2PushCore(options);

  // Hook: Add HTTP/2 capabilities to response
  hookManager.on('request', async (context: any) => {
    const { request, response } = context;

    if (!request || !response) {
      return;
    }

    // Add push capability
    core.addPushCapability(request, response);

    // Setup auto-detect
    core.setupAutoDetect(request, response);

    // Push configured resources
    core.pushConfiguredResources(request, response);
  });

  // Hook: Log HTTP/2 metrics
  hookManager.on('response', async (context: any) => {
    const { request, response } = context;

    if (!request || !response) {
      return;
    }

    // Track HTTP/2 usage
    if (core.isHttp2Available(request, response)) {
      // Could emit metrics here
      context.http2Used = true;
    }
  });
}
