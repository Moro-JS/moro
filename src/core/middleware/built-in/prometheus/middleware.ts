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
 *
 * // Restrict who may scrape it
 * app.use(
 *   middleware.prometheus({
 *     authorize: req => req.headers.authorization === `Bearer ${process.env.METRICS_TOKEN}`,
 *   })
 * );
 * ```
 */
export function createPrometheusMiddleware(options: PrometheusOptions = {}): Middleware {
  const core = new PrometheusCore(options);
  const endpoint = options.endpoint ?? '/metrics';
  const authorize = options.authorize;

  const serve = (res: any) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.end(core.render());
  };
  const deny = (res: any) => {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Forbidden\n');
  };

  return (req, res, next) => {
    if (req.path === endpoint && req.method === 'GET') {
      if (authorize === undefined) {
        serve(res);
        return;
      }
      // Fails closed: only an explicit true opens the endpoint
      let verdict: boolean | Promise<boolean>;
      try {
        verdict = authorize(req);
      } catch {
        deny(res);
        return;
      }
      if (verdict !== null && typeof verdict === 'object' && typeof verdict.then === 'function') {
        void verdict.then(
          allowed => (allowed === true ? serve(res) : deny(res)),
          () => deny(res)
        );
        return;
      }
      if (verdict === true) serve(res);
      else deny(res);
      return;
    }

    const start = Date.now();
    res.on('finish', () => {
      core.recordRequest(req.method || 'UNKNOWN', res.statusCode, Date.now() - start);
    });

    next();
  };
}
