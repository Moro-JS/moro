// CORS Core - Reusable CORS logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

// ===== Types =====

export type OriginFunction = (
  origin: string | undefined,
  req: HttpRequest
) => string | string[] | boolean | Promise<string | string[] | boolean>;

export interface CORSOptions {
  origin?: string | string[] | boolean | OriginFunction;
  methods?: string | string[];
  headers?: string | string[];
  credentials?: boolean;
  maxAge?: number;
  exposedHeaders?: string[];
  preflightContinue?: boolean;
}

// ===== Core Logic =====

/**
 * CORSCore - Core CORS header management logic
 * Used directly by the router for route-based CORS
 * Can be instantiated for use in middleware or hooks
 */
export class CORSCore {
  private options: CORSOptions;

  constructor(options: CORSOptions = {}) {
    this.options = {
      origin: '*',
      methods: 'GET,POST,PUT,DELETE,OPTIONS',
      headers: 'Content-Type,Authorization',
      credentials: false,
      ...options,
    };
  }

  /**
   * Apply CORS headers to response
   * Now supports async origin validation
   */
  async applyCORS(res: HttpResponse, req: HttpRequest): Promise<boolean> {
    // Origin - handle function, array, string, or boolean
    let resolvedOrigin: string | string[] | boolean = '*';

    if (typeof this.options.origin === 'function') {
      const requestOrigin = (req.headers as any).origin || (req.headers as any).Origin;
      resolvedOrigin = await this.options.origin(requestOrigin, req);
    } else if (this.options.origin !== undefined) {
      resolvedOrigin = this.options.origin;
    }

    // If origin function returned false, deny the request
    if (resolvedOrigin === false) {
      return false;
    }

    // Convert true to wildcard
    if (resolvedOrigin === true) {
      resolvedOrigin = '*';
    }

    // Set origin header
    const originHeader = Array.isArray(resolvedOrigin)
      ? resolvedOrigin.join(',')
      : String(resolvedOrigin);
    res.setHeader('Access-Control-Allow-Origin', originHeader);

    // Methods
    const methods = Array.isArray(this.options.methods)
      ? this.options.methods.join(',')
      : this.options.methods || 'GET,POST,PUT,DELETE,OPTIONS';
    res.setHeader('Access-Control-Allow-Methods', methods);

    // Headers
    const headers = Array.isArray(this.options.headers)
      ? this.options.headers.join(',')
      : this.options.headers || 'Content-Type,Authorization';
    res.setHeader('Access-Control-Allow-Headers', headers);

    // Credentials
    if (this.options.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    // Max Age
    if (this.options.maxAge) {
      res.setHeader('Access-Control-Max-Age', String(this.options.maxAge));
    }

    // Exposed Headers
    if (this.options.exposedHeaders && this.options.exposedHeaders.length > 0) {
      res.setHeader('Access-Control-Expose-Headers', this.options.exposedHeaders.join(','));
    }

    return true;
  }
}
