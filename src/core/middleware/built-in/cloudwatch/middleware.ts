// CloudWatch Middleware - zero-dependency Embedded Metric Format emitter
//
// Emits one EMF JSON line per request to stdout. On AWS Lambda (and any
// environment shipping stdout to CloudWatch Logs), CloudWatch extracts these
// as real metrics automatically — no AWS SDK, credentials, or network calls.
// See: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
import { Middleware } from '../../../../types/http.js';

export interface CloudWatchOptions {
  /** CloudWatch metric namespace (default 'MoroJS') */
  namespace?: string;
  /** Extra static dimensions added to every record */
  dimensions?: Record<string, string>;
  /** Override the output sink (default: process.stdout). Useful for testing. */
  emit?: (line: string) => void;
}

/**
 * Build a single EMF record for one completed request.
 * Exported for direct unit testing.
 */
export function buildEmfRecord(
  options: { namespace: string; dimensions: Record<string, string> },
  request: { method: string; path: string },
  statusCode: number,
  durationMs: number
): Record<string, any> {
  const dimensionKeys = ['Method', 'Status', ...Object.keys(options.dimensions)];

  return {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: options.namespace,
          Dimensions: [dimensionKeys],
          Metrics: [
            { Name: 'RequestCount', Unit: 'Count' },
            { Name: 'RequestDuration', Unit: 'Milliseconds' },
          ],
        },
      ],
    },
    Method: request.method,
    Status: String(statusCode),
    ...options.dimensions,
    RequestCount: 1,
    RequestDuration: durationMs,
    Path: request.path,
  };
}

/**
 * CloudWatch metrics middleware (Embedded Metric Format)
 *
 * @example
 * ```ts
 * import { middleware } from '@morojs/moro';
 *
 * app.use(middleware.cloudWatch({ namespace: 'MoroAPI' }));
 * ```
 */
export function createCloudWatchMiddleware(options: CloudWatchOptions = {}): Middleware {
  const namespace = options.namespace ?? 'MoroJS';
  const dimensions = options.dimensions ?? {};
  const emit = options.emit ?? ((line: string) => process.stdout.write(line + '\n'));

  return (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const record = buildEmfRecord(
        { namespace, dimensions },
        { method: req.method || 'UNKNOWN', path: req.path || '' },
        res.statusCode,
        Date.now() - start
      );
      emit(JSON.stringify(record));
    });

    next();
  };
}
