// OpenTelemetry Core - request instrumentation over @opentelemetry/api
//
// MoroJS instruments its own request lifecycle: the native engine and the uWS
// transport never touch Node's http module, so the generic
// @opentelemetry/instrumentation-http sees nothing on them and would leave a
// service without server spans. Only the API package is required (an optional
// peer). The application owns the SDK, exporters, sampling and resource
// attributes - the OpenTelemetry project's rule for libraries - so a NodeSDK
// started before the app picks these spans and metrics up with no wiring.
import { performance } from 'perf_hooks';
import type { Attributes, Context, Histogram, Span, UpDownCounter } from '@opentelemetry/api';
import { resolveUserPackage } from '../../../utilities/package-utils.js';
import { selfRequire } from '../../../utilities/self-require.js';
import { UnifiedRouter } from '../../../routing/unified-router.js';
import type { HttpRequest, HttpResponse } from '../../../../types/http.js';

/** The @opentelemetry/api module, loaded from the application's node_modules. */
export type OpenTelemetryApi = typeof import('@opentelemetry/api');

/** The part of an @opentelemetry/api Tracer the middleware calls. */
export interface TracerLike {
  startSpan(name: string, options?: any, context?: any): any;
}

/** The part of an @opentelemetry/api Meter the middleware calls. */
export interface MeterLike {
  createHistogram(name: string, options?: any): any;
  createUpDownCounter(name: string, options?: any): any;
}

export interface OpenTelemetryOptions {
  /** Create one server span per request (default true) */
  traces?: boolean;
  /** Record the http.server.request.duration histogram (default true) */
  metrics?: boolean;
  /**
   * Also record the http.server.active_requests up/down counter. Opt-in in the
   * semantic conventions, and two extra metric writes per request (default false).
   */
  activeRequests?: boolean;
  /** Continue traces from incoming traceparent/tracestate/baggage headers (default true) */
  propagation?: boolean;
  /** Paths left uninstrumented - health checks, metrics scrapes. Exact strings or RegExps. */
  ignorePaths?: Array<string | RegExp>;
  /** Request headers captured as http.request.header.<name> span attributes */
  captureRequestHeaders?: string[];
  /** Response headers captured as http.response.header.<name> span attributes */
  captureResponseHeaders?: string[];
  /** Static attributes added to every span and metric data point */
  attributes?: Record<string, string | number | boolean>;
  /**
   * Span name override. The default is the method and the matched route
   * template ('GET /users/:id'), or the bare method when no route matched.
   */
  spanName?: (req: HttpRequest, route: string | undefined) => string;
  /** Tracer to use instead of the global TracerProvider's '@morojs/moro' tracer */
  tracer?: TracerLike;
  /** Meter to use instead of the global MeterProvider's '@morojs/moro' meter */
  meter?: MeterLike;
}

const PACKAGE = '@opentelemetry/api';
const SCOPE_NAME = '@morojs/moro';
const MISSING_API =
  'OpenTelemetry API not installed. Run: npm install @opentelemetry/api ' +
  '(plus an SDK such as @opentelemetry/sdk-node to export the data)';

// Methods the HTTP semantic conventions name verbatim; anything else is _OTHER
const KNOWN_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'CONNECT',
  'OPTIONS',
  'TRACE',
  'PATCH',
]);

// Bucket advice for http.server.request.duration (seconds), per the conventions
const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

// Context entry naming the request a Moro-entered context belongs to. begin()
// uses it to tell a context left over from an earlier request (stale) from one
// an outer instrumentation set for this request (a legitimate parent).
const REQUEST_KEY = Symbol.for('morojs.opentelemetry.request');

// Carrier getter for propagation.extract. The native transports build the
// header object on first access, so the request itself is the carrier and the
// headers are only materialised when a real propagator asks for a key - the
// no-op propagator never does.
const HEADER_GETTER = {
  get(carrier: HttpRequest, key: string): string | string[] | undefined {
    return carrier.headers ? (carrier.headers[key] as string | string[] | undefined) : undefined;
  },
  keys(carrier: HttpRequest): string[] {
    return carrier.headers ? Object.keys(carrier.headers) : [];
  },
};

let apiPromise: Promise<OpenTelemetryApi> | undefined;
let loadedApi: OpenTelemetryApi | undefined;

// Resolve from the application's working directory first (where its
// dependencies live), then from Moro's own install location: an app started
// from another cwd (Docker WORKDIR, pm2, a subdirectory) still finds the package
// it installed next to @morojs/moro.
function resolveApiPath(): string | undefined {
  try {
    return resolveUserPackage(PACKAGE);
  } catch {
    // not resolvable from cwd - try Moro's own location
  }
  try {
    return selfRequire.resolve(PACKAGE);
  } catch {
    return undefined;
  }
}

/** Whether @opentelemetry/api is installed where the application or Moro can resolve it. */
export function isOpenTelemetryAvailable(): boolean {
  return resolveApiPath() !== undefined;
}

/** Throw the install hint when @opentelemetry/api is not resolvable. */
export function assertOpenTelemetryAvailable(): void {
  if (!isOpenTelemetryAvailable()) {
    throw new Error(MISSING_API);
  }
}

/**
 * Load @opentelemetry/api from the application's node_modules (once). The
 * application's SDK registers its providers on the global registry the API
 * keeps, so this copy sees them.
 */
export function loadOpenTelemetryApi(): Promise<OpenTelemetryApi> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const apiPath = resolveApiPath();
      if (apiPath === undefined) throw new Error(MISSING_API);
      const mod = await import(apiPath);
      // CommonJS interop: named exports on the namespace, else on default
      const api = (mod && mod.trace ? mod : mod.default) as OpenTelemetryApi;
      loadedApi = api;
      return api;
    })();
    apiPromise.catch(() => {
      apiPromise = undefined;
    });
  }
  return apiPromise;
}

/** The API module once loadOpenTelemetryApi() has resolved, else undefined. */
export function getLoadedOpenTelemetryApi(): OpenTelemetryApi | undefined {
  return loadedApi;
}

/** Per-request state carried from begin() to end() */
export interface RequestTelemetry {
  span: Span | undefined;
  startTime: number;
  /** Method as the conventions want it: a known verb, else '_OTHER' */
  method: string;
  route: string | undefined;
  scheme: string;
  protocolVersion: string | undefined;
  /** Attributes the active-requests counter was incremented with */
  activeAttributes: Attributes | undefined;
}

export class OpenTelemetryCore {
  private readonly api: OpenTelemetryApi;
  private readonly traces: boolean;
  private readonly metrics: boolean;
  private readonly activeRequests: boolean;
  private readonly propagation: boolean;
  private readonly ignoreExact = new Set<string>();
  private readonly ignorePatterns: RegExp[] = [];
  private readonly requestHeaders: string[];
  private readonly responseHeaders: string[];
  private readonly staticAttributes: Attributes | undefined;
  private readonly spanName: OpenTelemetryOptions['spanName'];
  private readonly customTracer: TracerLike | undefined;
  private readonly customMeter: MeterLike | undefined;
  // Resolved on first use, so an SDK registered after app.use() still counts
  private tracer: TracerLike | undefined;
  // Transport scheme, resolved once (see schemeOf)
  private scheme: string | undefined;
  private duration: Histogram | undefined;
  private active: UpDownCounter | undefined;

  constructor(api: OpenTelemetryApi, options: OpenTelemetryOptions = {}) {
    this.api = api;
    this.traces = options.traces !== false;
    this.metrics = options.metrics !== false;
    this.activeRequests = options.activeRequests === true;
    this.propagation = options.propagation !== false;
    for (const entry of options.ignorePaths ?? []) {
      if (typeof entry === 'string') this.ignoreExact.add(entry);
      else this.ignorePatterns.push(entry);
    }
    this.requestHeaders = (options.captureRequestHeaders ?? []).map(h => h.toLowerCase());
    this.responseHeaders = (options.captureResponseHeaders ?? []).map(h => h.toLowerCase());
    this.staticAttributes =
      options.attributes && Object.keys(options.attributes).length > 0
        ? { ...options.attributes }
        : undefined;
    this.spanName = options.spanName;
    this.customTracer = options.tracer;
    this.customMeter = options.meter;
  }

  shouldIgnore(path: string): boolean {
    if (this.ignoreExact.has(path)) return true;
    const patterns = this.ignorePatterns;
    for (let i = 0; i < patterns.length; i++) {
      if ((patterns[i] as RegExp).test(path)) return true;
    }
    return false;
  }

  /**
   * Start a request: resolve the route template, open the span under the right
   * parent and make it current, count it as active. Returns undefined when the
   * request is already instrumented (the middleware registered twice).
   *
   * Only JS-resident request state is touched here. Anything that costs a
   * header or address lookup on the native transports (the engine builds the
   * header object on first access) is collected in describeRequest(), for
   * spans that actually record - so a sampled-out or SDK-less request pays for
   * the route lookup and the metric point, not for materialising headers.
   */
  begin(req: HttpRequest): RequestTelemetry | undefined {
    const api = this.api;
    const rawMethod = req.method || 'GET';
    const upper = KNOWN_METHODS.has(rawMethod) ? rawMethod : rawMethod.toUpperCase();
    const known = KNOWN_METHODS.has(upper);
    const method = known ? upper : '_OTHER';
    const path = req.path || '/';
    const route = UnifiedRouter.getInstance().matchRoute(upper, path);
    const scheme = this.schemeOf(req);
    const protocolVersion =
      typeof req.httpVersion === 'string' && req.httpVersion ? req.httpVersion : undefined;

    let span: Span | undefined;
    if (this.traces) {
      const current = api.context.active();
      const owner = current.getValue(REQUEST_KEY);
      if (owner === req) return undefined;

      let parent: Context;
      let kind: number;
      if (owner === undefined && api.trace.getSpan(current) !== undefined) {
        // An outer instrumentation (instrumentation-http on the Node transport)
        // already opened a span for this request: nest under it.
        parent = current;
        kind = api.SpanKind.INTERNAL;
      } else {
        parent = this.propagation
          ? api.propagation.extract(api.ROOT_CONTEXT, req, HEADER_GETTER)
          : api.ROOT_CONTEXT;
        kind = api.SpanKind.SERVER;
      }

      // What a sampler gets to see; the rest is added once the span records
      const attributes: Attributes = {
        'http.request.method': method,
        'url.path': path,
        'url.scheme': scheme,
      };
      if (!known) attributes['http.request.method_original'] = rawMethod;
      if (route !== undefined) attributes['http.route'] = route;
      if (protocolVersion !== undefined) attributes['network.protocol.version'] = protocolVersion;
      if (this.staticAttributes) Object.assign(attributes, this.staticAttributes);

      const name = this.spanName
        ? this.spanName(req, route)
        : route !== undefined
          ? `${known ? upper : 'HTTP'} ${route}`
          : known
            ? upper
            : 'HTTP';
      const tracer =
        this.tracer ?? (this.tracer = this.customTracer ?? api.trace.getTracer(SCOPE_NAME));
      span = tracer.startSpan(name, { kind, attributes }, parent) as Span;
      if (span.isRecording()) this.describeRequest(span, req);

      // Make the span current for everything downstream (see contextStorage)
      const storage = this.contextStorage();
      if (storage !== undefined) {
        storage.enterWith(api.trace.setSpan(parent, span).setValue(REQUEST_KEY, req));
      }
    }

    let activeAttributes: Attributes | undefined;
    if (this.metrics && this.activeRequests) {
      activeAttributes = { 'http.request.method': method, 'url.scheme': scheme };
      if (this.staticAttributes) Object.assign(activeAttributes, this.staticAttributes);
      this.instruments().active.add(1, activeAttributes);
    }

    return {
      span,
      startTime: performance.now(),
      method,
      route,
      scheme,
      protocolVersion,
      activeAttributes,
    };
  }

  // url.scheme as instrumentation-http reports it: from the transport, not
  // x-forwarded-proto (req.protocol reads the headers for that). Resolved once
  // per instance: a listener is TLS or plain for its lifetime, and the native
  // transports build a socket shim - an object literal with an accessor - on
  // every req.socket access, which V8 allocates on a slow path that was
  // measured to triple RSS under load.
  private schemeOf(req: HttpRequest): string {
    let scheme = this.scheme;
    if (scheme === undefined) {
      const socket = (req as any).socket;
      scheme = socket != null && socket.encrypted ? 'https' : 'http';
      this.scheme = scheme;
    }
    return scheme;
  }

  // Request details that cost a header or address lookup - recorded spans only
  private describeRequest(span: Span, req: HttpRequest): void {
    const headers: Record<string, unknown> = req.headers || {};
    const extra: Attributes = {};
    const url = req.url;
    if (typeof url === 'string') {
      const q = url.indexOf('?');
      if (q !== -1) extra['url.query'] = url.slice(q + 1);
    }
    const host = headers.host;
    if (typeof host === 'string' && host) setServerAttributes(extra, host);
    const userAgent = headers['user-agent'];
    if (typeof userAgent === 'string' && userAgent) extra['user_agent.original'] = userAgent;
    const ip = req.ip;
    if (ip) extra['client.address'] = ip;
    for (const name of this.requestHeaders) {
      const value = headers[name];
      if (value !== undefined) {
        extra[`http.request.header.${name}`] = Array.isArray(value)
          ? value.map(String)
          : [String(value)];
      }
    }
    span.setAttributes(extra);
  }

  /** Finish a request: status, error classification, span end, metric points. */
  end(telemetry: RequestTelemetry, res: HttpResponse, aborted: boolean): void {
    const api = this.api;
    const status = res.statusCode;
    // A 5xx is a server failure; a client that went away before the response
    // completed is 'aborted'. 4xx are not errors for a server span.
    let errorType: string | undefined;
    if (aborted) errorType = 'aborted';
    else if (status >= 500) errorType = String(status);

    const span = telemetry.span;
    if (span !== undefined) {
      if (!aborted) span.setAttribute('http.response.status_code', status);
      if (this.responseHeaders.length > 0 && typeof res.getHeader === 'function') {
        for (const name of this.responseHeaders) {
          const value = res.getHeader(name);
          if (value !== undefined) {
            span.setAttribute(
              `http.response.header.${name}`,
              Array.isArray(value) ? value.map(String) : [String(value)]
            );
          }
        }
      }
      if (errorType !== undefined) {
        span.setAttribute('error.type', errorType);
        span.setStatus({
          code: api.SpanStatusCode.ERROR,
          message: aborted ? 'Client aborted the request' : `HTTP ${status}`,
        });
      }
      span.end();
    }

    if (this.metrics) {
      const { duration, active } = this.instruments();
      const attributes: Attributes = {
        'http.request.method': telemetry.method,
        'url.scheme': telemetry.scheme,
      };
      if (!aborted) attributes['http.response.status_code'] = status;
      if (telemetry.route !== undefined) attributes['http.route'] = telemetry.route;
      if (telemetry.protocolVersion !== undefined) {
        attributes['network.protocol.version'] = telemetry.protocolVersion;
      }
      if (errorType !== undefined) attributes['error.type'] = errorType;
      if (this.staticAttributes) Object.assign(attributes, this.staticAttributes);
      duration.record((performance.now() - telemetry.startTime) / 1000, attributes);
      if (telemetry.activeAttributes !== undefined) active.add(-1, telemetry.activeAttributes);
    }
  }

  /** Drop a Moro request context left current by an earlier request (ignored paths). */
  leaveStaleContext(): void {
    const api = this.api;
    if (api.context.active().getValue(REQUEST_KEY) !== undefined) {
      const storage = this.contextStorage();
      if (storage !== undefined) storage.enterWith(api.ROOT_CONTEXT);
    }
  }

  private instruments(): { duration: Histogram; active: UpDownCounter } {
    let duration = this.duration;
    let active = this.active;
    if (duration === undefined || active === undefined) {
      const meter = this.customMeter ?? this.api.metrics.getMeter(SCOPE_NAME);
      duration = meter.createHistogram('http.server.request.duration', {
        description: 'Duration of HTTP server requests.',
        unit: 's',
        advice: { explicitBucketBoundaries: DURATION_BUCKETS },
      }) as Histogram;
      active = meter.createUpDownCounter('http.server.active_requests', {
        description: 'Number of active HTTP server requests.',
        unit: '{request}',
      }) as UpDownCounter;
      this.duration = duration;
      this.active = active;
    }
    return { duration, active };
  }

  // The servers run the middleware chain iteratively: next() only records that
  // this middleware is done, and the following middleware, the router and the
  // handler run after it returns - so context.with(ctx, next) would scope the
  // span to nothing. The AsyncLocalStorage context manager (the SDK's default
  // on Node) keeps its store on the current async resource: entering it makes
  // the span current for the rest of this request's synchronous dispatch and
  // for every async continuation it spawns - route middleware, handlers,
  // instrumented database and HTTP clients. The store is deliberately not
  // exited at the end: that runs from the response's own events, on another
  // resource. begin() recognises a Moro context left over from an earlier
  // request by REQUEST_KEY and never parents to it. Other context managers
  // still get correct spans and metrics; only in-handler nesting is lost.
  // Returns undefined when no such storage exists (no SDK, other manager), so
  // callers skip building the context altogether.
  private contextStorage(): { enterWith(ctx: Context): void } | undefined {
    const manager = (this.api.context as any)._getContextManager?.();
    const storage = manager?._asyncLocalStorage;
    return storage !== undefined && typeof storage.enterWith === 'function' ? storage : undefined;
  }
}

// server.address / server.port from a Host header: "api.example.com:8080",
// "[::1]:3000", "api.example.com"
function setServerAttributes(attributes: Attributes, host: string): void {
  const bracket = host.indexOf(']');
  const colon = host.lastIndexOf(':');
  let address = host;
  if (colon !== -1 && colon > bracket) {
    address = host.slice(0, colon);
    const port = Number(host.slice(colon + 1));
    if (Number.isInteger(port) && port > 0) attributes['server.port'] = port;
  }
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (address) attributes['server.address'] = address;
}
