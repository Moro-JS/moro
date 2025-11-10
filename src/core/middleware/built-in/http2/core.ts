// HTTP/2 Server Push Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

export interface Http2PushOptions {
  resources?: Array<{
    path: string;
    as: string;
    type?: string;
    priority?: number;
  }>;
  condition?: (req: HttpRequest) => boolean;
  autoDetect?: boolean;
}

export interface Http2PushResult {
  pushed: string[];
  failed: string[];
}

export class Http2PushCore {
  private options: Http2PushOptions;

  constructor(options: Http2PushOptions = {}) {
    this.options = options;
  }

  /**
   * Add push capability to response object
   */
  addPushCapability(req: HttpRequest, res: HttpResponse): void {
    // Add HTTP/2 push capability to response
    (res as any).push = (path: string, pushOptions: any = {}) => {
      // Check if HTTP/2 is supported
      if (req.httpVersion === '2.0' && (res as any).stream && (res as any).stream.pushAllowed) {
        try {
          const pushHeaders: any = {
            ':method': 'GET',
            ':path': path,
            ...pushOptions.headers,
          };

          const pushStream = (res as any).stream.pushStream(pushHeaders);

          if (pushStream) {
            // Set priority if specified
            if (pushOptions.priority !== undefined) {
              try {
                const weight = Math.max(1, Math.min(256, pushOptions.priority));
                (pushStream as any).priority({
                  parent: 0,
                  weight,
                  exclusive: false,
                });
              } catch {
                // Priority setting failed, continue
              }
            }

            return pushStream;
          }
        } catch {
          // Push failed, continue normally
        }
      }
      return null;
    };
  }

  /**
   * Auto-detect and push resources from HTML
   */
  setupAutoDetect(req: HttpRequest, res: HttpResponse): void {
    if (!this.options.autoDetect || !req.path.endsWith('.html')) {
      return;
    }

    // Will push resources after HTML is rendered
    const originalSend = res.send;
    res.send = function (data: any) {
      if (typeof data === 'string' && req.httpVersion === '2.0') {
        // Extract CSS and JS from HTML
        const cssMatches = data.match(/<link[^>]+href=["']([^"']+\.css)["']/g) || [];
        const jsMatches = data.match(/<script[^>]+src=["']([^"']+\.js)["']/g) || [];

        // Push CSS files (high priority)
        for (const match of cssMatches) {
          const pathMatch = match.match(/href=["']([^"']+)["']/);
          if (pathMatch) {
            (res as any).push?.(pathMatch[1], {
              headers: { 'content-type': 'text/css' },
              priority: 200, // High priority
            });
          }
        }

        // Push JS files (medium priority)
        for (const match of jsMatches) {
          const pathMatch = match.match(/src=["']([^"']+)["']/);
          if (pathMatch) {
            (res as any).push?.(pathMatch[1], {
              headers: { 'content-type': 'application/javascript' },
              priority: 150, // Medium priority
            });
          }
        }
      }
      return originalSend.call(res, data);
    };
  }

  /**
   * Push configured resources
   */
  pushConfiguredResources(req: HttpRequest, res: HttpResponse): Http2PushResult {
    const result: Http2PushResult = {
      pushed: [],
      failed: [],
    };

    if (!this.options.resources) {
      return result;
    }

    // Check condition if provided
    if (this.options.condition && !this.options.condition(req)) {
      return result;
    }

    // Push each configured resource
    for (const resource of this.options.resources) {
      try {
        const pushStream = (res as any).push?.(resource.path, {
          headers: {
            'content-type': resource.type || 'text/plain',
          },
          priority: resource.priority,
        });

        if (pushStream) {
          result.pushed.push(resource.path);
        } else {
          result.failed.push(resource.path);
        }
      } catch {
        result.failed.push(resource.path);
      }
    }

    return result;
  }

  /**
   * Check if HTTP/2 is available
   */
  isHttp2Available(req: HttpRequest, res: HttpResponse): boolean {
    return req.httpVersion === '2.0' && (res as any).push !== undefined;
  }
}
