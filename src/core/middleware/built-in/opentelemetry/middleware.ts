// OpenTelemetry Middleware - chain-style factory
import { Middleware, HttpRequest, HttpResponse } from '../../../../types/http.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import {
  OpenTelemetryCore,
  OpenTelemetryOptions,
  assertOpenTelemetryAvailable,
  getLoadedOpenTelemetryApi,
  loadOpenTelemetryApi,
} from './core.js';

const logger = createFrameworkLogger('OpenTelemetry');

/**
 * OpenTelemetry middleware
 * Opens one SERVER span per request (continuing an incoming W3C trace context)
 * and records the semantic-convention HTTP server metrics, through the
 * OpenTelemetry SDK the application has registered. Register it before other
 * middleware so they run inside the span.
 *
 * Requires `@opentelemetry/api` (an optional peer dependency); the SDK and
 * exporters are the application's.
 *
 * @example
 * ```ts
 * import { middleware } from '@morojs/moro';
 *
 * app.use(middleware.openTelemetry({ ignorePaths: ['/health'] }));
 * ```
 */
export function createOpenTelemetryMiddleware(options: OpenTelemetryOptions = {}): Middleware {
  assertOpenTelemetryAvailable();

  // The API module is imported asynchronously (it lives in the application's
  // node_modules). Requests that arrive before it has loaded wait on it; once
  // loaded every request is handled synchronously.
  let core: OpenTelemetryCore | undefined;
  const preloaded = getLoadedOpenTelemetryApi();
  let ready: Promise<void> | undefined;
  if (preloaded) {
    core = new OpenTelemetryCore(preloaded, options);
  } else {
    ready = loadOpenTelemetryApi().then(api => {
      core = new OpenTelemetryCore(api, options);
    });
    ready.catch(() => {});
  }

  const run = (
    instrumentation: OpenTelemetryCore,
    req: HttpRequest,
    res: HttpResponse,
    next: () => void
  ) => {
    if (instrumentation.shouldIgnore(req.path)) {
      instrumentation.leaveStaleContext();
      next();
      return;
    }

    let telemetry;
    try {
      telemetry = instrumentation.begin(req);
    } catch (error) {
      logger.error('Failed to start request telemetry', 'OpenTelemetry', {
        error: error instanceof Error ? error.message : String(error),
      });
      next();
      return;
    }
    if (telemetry === undefined) {
      next();
      return;
    }

    let done = false;
    const complete = (aborted: boolean) => {
      if (done) return;
      done = true;
      try {
        instrumentation.end(telemetry, res, aborted);
      } catch (error) {
        logger.error('Failed to finish request telemetry', 'OpenTelemetry', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    // 'finish' then 'close' on a completed response; 'close' alone when the
    // client went away first (Node ServerResponse semantics on every transport)
    res.on('finish', () => complete(false));
    res.on('close', () => complete(true));

    next();
  };

  return (req, res, next) => {
    if (core !== undefined) {
      run(core, req, res, next);
      return;
    }
    return (ready as Promise<void>).then(
      () => run(core as OpenTelemetryCore, req, res, next),
      error => {
        logger.error(
          'OpenTelemetry API failed to load; request not instrumented',
          'OpenTelemetry',
          {
            error: error instanceof Error ? error.message : String(error),
          }
        );
        next();
      }
    );
  };
}
