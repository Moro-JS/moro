// Helmet Security Headers Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

/** CSP directives by name (camelCase or kebab-case), each a list of sources. */
type HelmetCSPDirectives = Record<string, string[]>;

export interface HelmetOptions {
  /**
   * `true` for the default policy, `false` for none, or the directives to
   * send - given directly (`{ defaultSrc: [...] }`) or under a `directives`
   * key (`{ directives: { defaultSrc: [...] } }`).
   */
  contentSecurityPolicy?: boolean | HelmetCSPDirectives | { directives: HelmetCSPDirectives };
  xFrameOptions?: boolean | 'DENY' | 'SAMEORIGIN';
  xContentTypeOptions?: boolean;
  /**
   * Sends `X-XSS-Protection: 0`, which switches off the legacy XSS filter of
   * older browsers (the filter itself could be abused to break pages; a
   * Content-Security-Policy is the protection). `false` sends no header.
   */
  xXssProtection?: boolean;
  referrerPolicy?: boolean | string;
  strictTransportSecurity?: boolean | { maxAge?: number; includeSubDomains?: boolean };
  xDownloadOptions?: boolean;
  xPermittedCrossDomainPolicies?: boolean;
}

export class HelmetCore {
  private options: Required<HelmetOptions>;

  constructor(options: HelmetOptions = {}) {
    this.options = {
      contentSecurityPolicy: options.contentSecurityPolicy ?? true,
      xFrameOptions: options.xFrameOptions ?? 'DENY',
      xContentTypeOptions: options.xContentTypeOptions ?? true,
      xXssProtection: options.xXssProtection ?? true,
      referrerPolicy: options.referrerPolicy ?? 'strict-origin-when-cross-origin',
      strictTransportSecurity: options.strictTransportSecurity ?? {
        maxAge: 31536000,
        includeSubDomains: true,
      },
      xDownloadOptions: options.xDownloadOptions ?? true,
      xPermittedCrossDomainPolicies: options.xPermittedCrossDomainPolicies ?? true,
    };
  }

  applyHeaders(req: HttpRequest, res: HttpResponse): void {
    // X-Content-Type-Options
    if (this.options.xContentTypeOptions) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }

    // X-Frame-Options
    if (this.options.xFrameOptions) {
      const value =
        typeof this.options.xFrameOptions === 'string' ? this.options.xFrameOptions : 'DENY';
      res.setHeader('X-Frame-Options', value);
    }

    // X-XSS-Protection: 0 disables the legacy XSS filter, as current guidance
    // asks; "1; mode=block" could itself be used against a page.
    if (this.options.xXssProtection) {
      res.setHeader('X-XSS-Protection', '0');
    }

    // Referrer-Policy
    if (this.options.referrerPolicy) {
      const value =
        typeof this.options.referrerPolicy === 'string'
          ? this.options.referrerPolicy
          : 'strict-origin-when-cross-origin';
      res.setHeader('Referrer-Policy', value);
    }

    // Strict-Transport-Security (HSTS)
    if (this.options.strictTransportSecurity) {
      const hsts =
        typeof this.options.strictTransportSecurity === 'object'
          ? this.options.strictTransportSecurity
          : { maxAge: 31536000, includeSubDomains: true };

      const value = `max-age=${hsts.maxAge || 31536000}${hsts.includeSubDomains ? '; includeSubDomains' : ''}`;
      res.setHeader('Strict-Transport-Security', value);
    }

    // Content-Security-Policy
    if (this.options.contentSecurityPolicy) {
      // The default policy. base-uri, form-action and frame-ancestors do not
      // fall back to default-src, so each is named: without them a page could
      // be re-based, post its forms anywhere, or be framed by any site.
      // frame-ancestors says what X-Frame-Options says (it wins in browsers
      // that know both), and is left out when framing was allowed outright.
      let cspValue = "default-src 'self'; base-uri 'self'; form-action 'self'";
      if (this.options.xFrameOptions) {
        cspValue +=
          this.options.xFrameOptions === 'SAMEORIGIN'
            ? "; frame-ancestors 'self'"
            : "; frame-ancestors 'none'";
      }

      if (typeof this.options.contentSecurityPolicy === 'object') {
        // The directives are either the object itself or its `directives`
        // key. (A directive is a list of sources, so a `directives` entry
        // holding a plain object can only be that wrapper.)
        const configured: Record<string, unknown> = this.options.contentSecurityPolicy;
        const nested = configured.directives;
        const source =
          nested !== null && typeof nested === 'object' && !Array.isArray(nested)
            ? (nested as Record<string, unknown>)
            : configured;

        const directives: string[] = [];
        for (const [directive, sources] of Object.entries(source)) {
          const kebabDirective = directive.replace(/([A-Z])/g, '-$1').toLowerCase();
          if (Array.isArray(sources)) {
            directives.push(`${kebabDirective} ${sources.join(' ')}`);
          } else if (typeof sources === 'string') {
            directives.push(`${kebabDirective} ${sources}`);
          } else if (sources === true) {
            // A directive with no sources, e.g. upgradeInsecureRequests: true
            directives.push(kebabDirective);
          }
          // anything else (false, null, undefined) leaves the directive out
        }
        cspValue = directives.join('; ');
      }

      res.setHeader('Content-Security-Policy', cspValue);
    }

    // X-Download-Options
    if (this.options.xDownloadOptions) {
      res.setHeader('X-Download-Options', 'noopen');
    }

    // X-Permitted-Cross-Domain-Policies
    if (this.options.xPermittedCrossDomainPolicies) {
      res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    }
  }
}

// The HelmetCore behind a helmet() middleware function, so that code which
// answers a request before function middleware runs can find it.
const kHelmetCore: unique symbol = Symbol('moro.helmet.core');

/** Mark `middleware` as the helmet middleware that applies `core`'s headers. */
export function tagHelmetMiddleware<T extends object>(middleware: T, core: HelmetCore): T {
  Object.defineProperty(middleware, kHelmetCore, { value: core });
  return middleware;
}

/**
 * Apply the headers of every helmet() registered as global middleware on the
 * server that owns `res`. Hooks run before function middleware, so a response
 * a hook produces (the rate limiter's 429, the CORS and CSRF 403s) would
 * otherwise leave without the security headers every other response of the
 * application carries. Does nothing when no helmet is registered.
 */
export function applyGlobalHelmet(req: HttpRequest, res: HttpResponse): void {
  const registered: unknown = (res as any)?._server?.globalMiddleware;
  if (!Array.isArray(registered) || (res as any).headersSent) return;
  for (let i = 0; i < registered.length; i++) {
    const entry = registered[i];
    const core: HelmetCore | undefined =
      typeof entry === 'function' ? (entry as any)[kHelmetCore] : undefined;
    if (core !== undefined) core.applyHeaders(req, res);
  }
}
