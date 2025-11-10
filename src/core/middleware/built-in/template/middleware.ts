// Template Rendering Middleware
import { Middleware } from '../../../../types/http.js';
import { TemplateCore, TemplateOptions } from './core.js';

/**
 * Create template rendering middleware
 *
 * @example
 * ```typescript
 * import { template } from '@morojs/moro';
 *
 * app.use(template({
 *   views: './views',
 *   cache: true,
 *   defaultLayout: 'main',
 * }));
 *
 * app.get('/', (req, res) => {
 *   res.render('index', { title: 'Home', user: { name: 'John' } });
 * });
 * ```
 */
export function createTemplateMiddleware(options: TemplateOptions): Middleware {
  const core = new TemplateCore(options);

  return (req, res, next) => {
    core.addRenderMethod(req, res);
    next();
  };
}
