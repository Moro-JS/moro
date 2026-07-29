// Prometheus Middleware - chain-style factory
import { Middleware } from '../../../../types/http.js';
import { PrometheusCore, PrometheusOptions } from './core.js';

/**
 * Prometheus metrics middleware
 * Records request count and duration histograms (labeled by method and
 * status), and serves the text exposition format at the configured endpoint.
 *
 * @example
 * ```ts
 * import { middleware } from '@morojs/moro';
 *
 * app.use(middleware.prometheus({ endpoint: '/metrics' }));
 * ```
 */
export function createPrometheusMiddleware(options: PrometheusOptions = {}): Middleware {
  const core = new PrometheusCore(options);
  const endpoint = options.endpoint ?? '/metrics';

  return (req, res, next) => {
    if (req.path === endpoint && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      (res as any).end(core.render());
      return;
    }

    const start = Date.now();
    res.on('finish', () => {
      core.recordRequest(req.method || 'UNKNOWN', res.statusCode, Date.now() - start);
    });

    next();
  };
}
