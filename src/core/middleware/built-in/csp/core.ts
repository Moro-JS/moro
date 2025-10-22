// CSP Core - Reusable Content Security Policy logic
import crypto from 'crypto';
import { HttpResponse } from '../../../../types/http.js';

// ===== Types =====

export interface CSPDirectives {
  defaultSrc?: string[];
  scriptSrc?: string[];
  styleSrc?: string[];
  imgSrc?: string[];
  connectSrc?: string[];
  fontSrc?: string[];
  objectSrc?: string[];
  mediaSrc?: string[];
  frameSrc?: string[];
  childSrc?: string[];
  workerSrc?: string[];
  formAction?: string[];
  upgradeInsecureRequests?: boolean;
  blockAllMixedContent?: boolean;
}

export interface CSPOptions {
  directives?: CSPDirectives;
  reportOnly?: boolean;
  reportUri?: string;
  nonce?: boolean;
}

// ===== Core Logic =====

/**
 * Generate a cryptographically secure nonce for CSP
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Convert camelCase directive name to kebab-case
 */
function toKebabCase(str: string): string {
  return str.replace(/([A-Z])/g, '-$1').toLowerCase();
}

/**
 * Build CSP header value from directives
 */
export function buildCSPHeader(
  directives: CSPDirectives,
  nonce?: string,
  reportUri?: string
): string {
  const cspParts: string[] = [];

  for (const [directive, sources] of Object.entries(directives)) {
    if (directive === 'upgradeInsecureRequests' && sources === true) {
      cspParts.push('upgrade-insecure-requests');
      continue;
    }

    if (directive === 'blockAllMixedContent' && sources === true) {
      cspParts.push('block-all-mixed-content');
      continue;
    }

    if (Array.isArray(sources)) {
      let sourceList = sources.join(' ');

      // Add nonce to script-src and style-src if enabled
      if (nonce && (directive === 'scriptSrc' || directive === 'styleSrc')) {
        sourceList += ` 'nonce-${nonce}'`;
      }

      // Convert camelCase to kebab-case
      const kebabDirective = toKebabCase(directive);
      cspParts.push(`${kebabDirective} ${sourceList}`);
    }
  }

  // Add report-uri if specified
  if (reportUri) {
    cspParts.push(`report-uri ${reportUri}`);
  }

  return cspParts.join('; ');
}

/**
 * CSPCore - Core Content Security Policy management logic
 * Used directly by the router for route-based CSP
 */
export class CSPCore {
  private options: CSPOptions;
  private defaultDirectives: CSPDirectives;

  constructor(options: CSPOptions = {}) {
    this.options = options;
    this.defaultDirectives = {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    };
  }

  /**
   * Apply CSP header to response
   * Returns the generated nonce if nonce support is enabled
   */
  applyCSP(res: HttpResponse): string | undefined {
    const directives = this.options.directives || this.defaultDirectives;

    // Generate nonce if requested
    let nonce: string | undefined;
    if (this.options.nonce) {
      nonce = generateNonce();
    }

    // Build CSP header value
    const cspValue = buildCSPHeader(directives, nonce, this.options.reportUri);

    const headerName = this.options.reportOnly
      ? 'Content-Security-Policy-Report-Only'
      : 'Content-Security-Policy';

    res.setHeader(headerName, cspValue);

    return nonce;
  }
}
