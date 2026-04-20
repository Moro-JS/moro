// Standalone router — collects route registrations and mounts them onto an app
// at a given prefix. Equivalent semantics to Express's Router(), so migrations
// from Express become a one-token swap: `express.Router()` → `createRouter()`.

import type { HttpRequest, HttpResponse, Middleware } from '../../types/http.js';

type RouteEntry = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  path: string;
  middlewares: Middleware[];
  handler: (req: HttpRequest, res: HttpResponse) => any | Promise<any>;
};

/**
 * Standalone router. Collects routes and middlewares, then mounts them onto an
 * app at a given prefix via `app.use(prefix, router)` or `router.mount(app, prefix)`.
 *
 * @example
 *   const r = createRouter();
 *   r.get('/users', getUsers);
 *   r.post('/users', createUser);
 *   app.use('/api', r);
 */
export class MoroRouter {
  /** @internal — tag used by app.use(path, router) to detect router instances. */
  readonly _morojsRouter = true;
  private routes: RouteEntry[] = [];
  private globalMiddlewares: Middleware[] = [];

  use(...middleware: Middleware[]): this {
    for (const mw of middleware) this.globalMiddlewares.push(mw);
    return this;
  }

  get(path: string, ...handlers: any[]): this {
    return this.addRoute('GET', path, handlers);
  }
  post(path: string, ...handlers: any[]): this {
    return this.addRoute('POST', path, handlers);
  }
  put(path: string, ...handlers: any[]): this {
    return this.addRoute('PUT', path, handlers);
  }
  delete(path: string, ...handlers: any[]): this {
    return this.addRoute('DELETE', path, handlers);
  }
  patch(path: string, ...handlers: any[]): this {
    return this.addRoute('PATCH', path, handlers);
  }
  head(path: string, ...handlers: any[]): this {
    return this.addRoute('HEAD', path, handlers);
  }
  options(path: string, ...handlers: any[]): this {
    return this.addRoute('OPTIONS', path, handlers);
  }

  /** Register the same handler(s) for all HTTP methods on the path. */
  all(path: string, ...handlers: any[]): this {
    const methods: RouteEntry['method'][] = [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'PATCH',
      'HEAD',
      'OPTIONS',
    ];
    for (const m of methods) this.addRoute(m, path, handlers);
    return this;
  }

  private addRoute(method: RouteEntry['method'], path: string, handlers: any[]): this {
    if (handlers.length === 0) {
      throw new Error(`${method} ${path}: handler is required`);
    }
    const handler = handlers[handlers.length - 1];
    const middlewares = handlers.slice(0, -1) as Middleware[];
    this.routes.push({ method, path, middlewares, handler });
    return this;
  }

  /** Mount all collected routes onto `app` at the given prefix. */
  mount(app: any, prefix = ''): void {
    const normalizedPrefix = prefix && !prefix.startsWith('/') ? `/${prefix}` : prefix;
    const cleanPrefix = normalizedPrefix.endsWith('/')
      ? normalizedPrefix.slice(0, -1)
      : normalizedPrefix;

    for (const route of this.routes) {
      const fullPath = cleanPrefix + (route.path.startsWith('/') ? route.path : `/${route.path}`);
      const combinedMiddleware = [...this.globalMiddlewares, ...route.middlewares];
      const method = route.method.toLowerCase() as
        | 'get'
        | 'post'
        | 'put'
        | 'delete'
        | 'patch'
        | 'head'
        | 'options';
      app[method](fullPath, route.handler, { middleware: combinedMiddleware });
    }
  }
}

/** Factory for a standalone router. */
export function createRouter(): MoroRouter {
  return new MoroRouter();
}
