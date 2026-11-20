/**
 * Configuration sections that install a built-in middleware.
 *
 * `security.rateLimit.global`, `security.csp`, `modules.session` and
 * `security.csrf` each switch on the built-in of the same name, with the
 * section's values as its options: the same thing as calling
 * `app.use(middleware.rateLimit({ ... }))` and so on before any middleware of
 * the application's own. They run as request hooks, in this fixed order:
 *
 *   1. rate limit   a refused request costs nothing further
 *   2. CSP          a header only
 *   3. session      loads req.session
 *   4. CSRF         after the session, before any handler
 *
 * and ahead of the configuration-driven helmet, CORS and compression, which
 * are function middleware and therefore run after every request hook.
 *
 * The rate limit and the CSRF check can refuse a request, and they do it
 * before the application's CORS has seen it. Both built-ins allow for that
 * themselves, however they were installed: a preflight that CORS answers is
 * left to it (neither counted nor checked), and a refusal carries its
 * headers, so a page on an allowed origin reads a 429 or a 403 and not an
 * opaque network error (see `applyGlobalCORS`).
 *
 * An application that already installs one of these built-ins itself keeps
 * exactly what it has: its own registration is the one that runs and the
 * configured one is withdrawn (see `supersede`). For that to cost nothing, a
 * configured built-in is only a placeholder in the hook order until the
 * server starts listening (or the first request arrives); the middleware
 * itself, with its store connection, timers and warnings, is created then.
 */
import type { AppConfig } from '../../types/config.js';
import type { HookContext, HookFunction, MiddlewareInterface } from '../../types/hooks.js';
import type { MiddlewareManager } from '../middleware/index.js';
import { rateLimit, csp, session, csrf } from '../middleware/built-in/index.js';
import type { HelmetOptions } from '../middleware/built-in/helmet/index.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('ConfiguredMiddleware');

/** A copy of `source` without `enabled` and without undefined values. */
function optionsOf(source: Record<string, unknown> | undefined): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (!source) return options;
  for (const key of Object.keys(source)) {
    if (key !== 'enabled' && source[key] !== undefined) options[key] = source[key];
  }
  return options;
}

/**
 * `security.helmet` as options for the helmet built-in. The detailed keys
 * (`xFrameOptions`, `strictTransportSecurity`, ...) are passed as written;
 * the three switches turn their header off when false (`hsts` for
 * Strict-Transport-Security, `noSniff` for X-Content-Type-Options,
 * `frameguard` for X-Frame-Options). With `security.csp` enabled the
 * Content-Security-Policy header belongs to that section, so helmet does not
 * send one of its own.
 */
export function helmetOptionsFromConfig(
  helmetConfig: Record<string, any> | undefined,
  cspEnabled: boolean
): HelmetOptions {
  const source = helmetConfig ?? {};
  const options: Record<string, unknown> = {};

  for (const key of [
    'contentSecurityPolicy',
    'xFrameOptions',
    'xContentTypeOptions',
    'xXssProtection',
    'referrerPolicy',
    'strictTransportSecurity',
    'xDownloadOptions',
    'xPermittedCrossDomainPolicies',
  ]) {
    if (source[key] !== undefined) options[key] = source[key];
  }

  if (source.hsts === false) options.strictTransportSecurity = false;
  if (source.noSniff === false) options.xContentTypeOptions = false;
  if (source.frameguard === false) options.xFrameOptions = false;
  if (cspEnabled) options.contentSecurityPolicy = false;

  return options as HelmetOptions;
}

interface ConfiguredEntry {
  /** The built-in's name, as the middleware manager reports an installation */
  name: string;
  /** The configuration path that enabled it */
  section: string;
  middleware: MiddlewareInterface;
  /** What holds its place among the request hooks */
  placeholder: HookFunction;
  /** Its own before-'request' hooks, once it has been created */
  request: HookFunction[] | undefined;
  /** Everything else it registered, to be taken back if it is superseded */
  registered: Array<[event: string, fn: HookFunction]>;
  /** Called with each request until it clears itself (one-time notices) */
  observe: ((context: HookContext) => void) | undefined;
  /** Why it could not be created: every request then fails instead of passing unprotected */
  failure: unknown;
  superseded: boolean;
}

/** What `installConfiguredMiddleware` returns to the framework. */
export interface ConfiguredMiddleware {
  /** Configuration paths whose built-in is in force, in running order */
  readonly sections: string[];
  /**
   * Create the middleware behind every placeholder that is still in place.
   * Called when the server starts listening; a request arriving before that
   * creates what it needs itself.
   */
  ready(): void;
}

function runFrom(fns: HookFunction[], context: HookContext, from: number): void | Promise<void> {
  for (let i = from; i < fns.length; i++) {
    const result: unknown = (fns[i] as HookFunction)(context);
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      const rest = i + 1;
      return Promise.resolve(result).then(() => {
        // A hook that answered the request ends the run
        const response = context.response as { headersSent?: boolean } | undefined;
        if (rest < fns.length && !(response && response.headersSent)) {
          return runFrom(fns, context, rest);
        }
        return undefined;
      });
    }
  }
  return undefined;
}

/**
 * Install the built-ins the configuration enables. `manager` is the app's
 * middleware manager: its hook manager takes the hooks, and its 'installed'
 * event is how an application's own registration of the same built-in is
 * noticed.
 */
export function installConfiguredMiddleware(
  config: AppConfig,
  manager: MiddlewareManager
): ConfiguredMiddleware {
  const hooks = manager.getHookManager();
  const entries: ConfiguredEntry[] = [];

  const create = (entry: ConfiguredEntry): void => {
    const request: HookFunction[] = [];
    entry.request = request;

    // The built-in registers through this view of the hook manager: its
    // before-'request' hooks run where the placeholder stands, and anything
    // else goes to the hook manager directly and is remembered.
    const record =
      (method: 'before' | 'after' | 'hook') =>
      (event: string, fn: HookFunction): unknown => {
        if (method === 'before' && event === 'request') {
          request.push(fn);
        } else {
          entry.registered.push([event, fn]);
          hooks[method](event, fn);
        }
        return scoped;
      };
    const scoped: unknown = new Proxy(hooks, {
      get(target, property) {
        if (property === 'before' || property === 'after' || property === 'hook') {
          return record(property);
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });

    const failed = (error: unknown): void => {
      entry.failure = error ?? new Error(`${entry.section}: the middleware could not be created`);
      logger.error(
        `${entry.section} is enabled, but its middleware could not be created: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'Installation'
      );
    };

    let installed: unknown;
    try {
      installed = entry.middleware.install(scoped, {});
    } catch (error) {
      failed(error);
      throw error;
    }
    if (installed && typeof (installed as PromiseLike<unknown>).then === 'function') {
      // As with app.use(): a middleware that cannot install is a start-up
      // failure, so the rejection is reported and left to reject.
      void (installed as PromiseLike<unknown>).then(undefined, (error: unknown) => {
        failed(error);
        throw error;
      });
    }
  };

  const add = (
    section: string,
    middleware: MiddlewareInterface,
    observe?: (context: HookContext, done: () => void) => void
  ): void => {
    const entry: ConfiguredEntry = {
      name: middleware.metadata?.name ?? middleware.name,
      section,
      middleware,
      placeholder: () => undefined,
      request: undefined,
      registered: [],
      observe: undefined,
      failure: undefined,
      superseded: false,
    };
    if (observe) {
      entry.observe = context =>
        observe(context, () => {
          entry.observe = undefined;
        });
    }

    entry.placeholder = function configuredMiddleware(context: HookContext) {
      if (entry.request === undefined) create(entry);
      if (entry.failure !== undefined) throw entry.failure;
      // A request an earlier hook has already answered goes no further
      const response = context.response as { headersSent?: boolean } | undefined;
      if (response && response.headersSent) return undefined;
      if (entry.observe !== undefined) entry.observe(context);
      return runFrom(entry.request as HookFunction[], context, 0);
    };

    hooks.before('request', entry.placeholder);
    entries.push(entry);
  };

  const security = config.security;
  const modules = config.modules;

  const globalLimit = security?.rateLimit?.global;
  if (globalLimit?.enabled) {
    const trustProxySet = config.server?.trustProxy !== undefined;
    add(
      'security.rateLimit.global',
      rateLimit({ requests: globalLimit.requests, window: globalLimit.window }),
      trustProxySet
        ? undefined
        : (context, done) => {
            // Behind a proxy that is not named in server.trustProxy, req.ip is
            // the proxy: say so once, on the first request that shows it.
            const headers = (context.request as { headers?: Record<string, unknown> } | undefined)
              ?.headers;
            if (!headers || !headers['x-forwarded-for']) return;
            done();
            logger.warn(
              `security.rateLimit.global counts requests per connecting address, and a request ` +
                `has arrived through a proxy (it carries X-Forwarded-For) while server.trustProxy ` +
                `is not set: every client behind that proxy shares one limit of ` +
                `${globalLimit.requests} requests per ${globalLimit.window} ms. Set ` +
                `server.trustProxy (1 for a single proxy, or the proxy's address or range) so ` +
                `that the limit is counted per client.`,
              'RateLimit'
            );
          }
    );
  }

  if (security?.csp?.enabled) {
    add('security.csp', csp(optionsOf(security.csp as Record<string, unknown>)));
  }

  if (modules?.session?.enabled) {
    add('modules.session', session(optionsOf(modules.session as Record<string, unknown>)));
  }

  if (security?.csrf?.enabled) {
    add('security.csrf', csrf(optionsOf(security.csrf as Record<string, unknown>)));
  }

  if (entries.length > 0) {
    // The application's own registration of the same built-in wins: what it
    // had before these sections were applied is what it keeps.
    manager.on('installed', (event: { name?: string }) => {
      for (const entry of entries) {
        if (entry.superseded || entry.name !== event?.name) continue;
        entry.superseded = true;
        hooks.removeHook('request', entry.placeholder);
        for (const [hookEvent, fn] of entry.registered) hooks.removeHook(hookEvent, fn);
        logger.warn(
          `${entry.section} is enabled in the configuration and the application also installs ` +
            `the '${entry.name}' middleware itself: the application's own registration is used ` +
            `and the configured one is not installed. Remove one of the two.`,
          'Installation'
        );
      }
    });

    logger.info(
      `Middleware installed from configuration: ${entries.map(entry => entry.section).join(', ')}`,
      'Installation'
    );
  }

  return {
    get sections(): string[] {
      return entries.filter(entry => !entry.superseded).map(entry => entry.section);
    },
    ready(): void {
      for (const entry of entries) {
        if (!entry.superseded && entry.request === undefined) create(entry);
      }
    },
  };
}
