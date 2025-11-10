// Helmet Security Headers Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

export interface HelmetOptions {
  contentSecurityPolicy?: boolean | Record<string, string[]>;
  xFrameOptions?: boolean | 'DENY' | 'SAMEORIGIN';
  xContentTypeOptions?: boolean;
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

    // X-XSS-Protection
    if (this.options.xXssProtection) {
      res.setHeader('X-XSS-Protection', '1; mode=block');
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
      let cspValue = "default-src 'self'";

      if (typeof this.options.contentSecurityPolicy === 'object') {
        const directives: string[] = [];
        for (const [directive, sources] of Object.entries(this.options.contentSecurityPolicy)) {
          const kebabDirective = directive.replace(/([A-Z])/g, '-$1').toLowerCase();
          directives.push(`${kebabDirective} ${sources.join(' ')}`);
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
