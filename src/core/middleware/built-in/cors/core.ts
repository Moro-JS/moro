// CORS Core - Reusable CORS logic
import { HttpResponse } from '../../../../types/http.js';

// ===== Types =====

export interface CORSOptions {
  origin?: string | string[];
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
   */
  applyCORS(res: HttpResponse): void {
    // Origin
    const origin = Array.isArray(this.options.origin)
      ? this.options.origin.join(',')
      : this.options.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);

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
  }
}
