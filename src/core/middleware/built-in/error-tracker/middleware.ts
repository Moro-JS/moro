// Error Tracker Middleware
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { createUrlQueryRedactor } from '../../../logger/query-redaction.js';

const logger = createFrameworkLogger('ErrorTracker');

export interface ErrorTrackerOptions {
  /**
   * Query parameters whose values are replaced with `REDACTED` in the logged
   * `url`, matched case-insensitively. The default list is `token`,
   * `access_token`, `refresh_token`, `id_token`, `code`, `key`, `api_key`,
   * `apikey`, `password`, `secret`, `client_secret`, `signature`, `sig`,
   * `AWSAccessKeyId`, `X-Amz-Signature`, `X-Amz-Security-Token` and
   * `X-Goog-Signature`. An array replaces that list; `false` logs the URL as
   * it was received.
   */
  redactedQueryParams?: string[] | false;
}

/**
 * Error tracking middleware
 * Captures and logs errors that occur during request processing.
 * Errors are logged and re-thrown so the framework's error handling
 * (registered error handler / default 500) still applies.
 *
 * The logged `url` has the values of credential-carrying query parameters
 * replaced (see {@link ErrorTrackerOptions.redactedQueryParams}).
 *
 * The returned middleware uses the 4-arg (err, req, res, next)
 * error-handler shape.
 *
 * @example
 * ```ts
 * import { middleware } from '@morojs/moro';
 *
 * app.use(middleware.errorTracker());
 * ```
 */
export function createErrorTrackerMiddleware(options: ErrorTrackerOptions = {}) {
  const redactUrl =
    options.redactedQueryParams === false
      ? undefined
      : createUrlQueryRedactor(options.redactedQueryParams);

  return (err: Error, req: HttpRequest, _res: HttpResponse, next: (err?: Error) => void): void => {
    const url = req.url;
    logger.error('Request error', 'ErrorTracking', {
      error: err.message,
      stack: err.stack,
      url: redactUrl !== undefined && typeof url === 'string' ? redactUrl(url) : url,
      method: req.method,
      timestamp: new Date().toISOString(),
    });
    // Pass the error along so downstream error handling still runs
    next(err);
  };
}
