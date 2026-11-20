// Simple Documentation Generator - Fallback for when Swagger UI has issues
// Generates clean, readable API documentation from routes

import { createHash } from 'crypto';
import { CompiledRoute, RouteSchema } from '../routing/index.js';
import { createFrameworkLogger } from '../logger/index.js';
import { escapeHtml } from './html-escape.js';

const logger = createFrameworkLogger('SimpleDocs');

// The page's only style sheet. The text is fixed, so the page's policy can
// name it by digest and allow no other inline style and no script at all.
const SIMPLE_DOCS_CSS = `
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      margin: 0;
      padding: 20px;
      background: #f8f9fa;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    h1 { color: #2563eb; margin-bottom: 10px; }
    h2 { color: #374151; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; }
    h3 { color: #6b7280; }
    .endpoint {
      background: #f3f4f6;
      border-left: 4px solid #2563eb;
      padding: 15px;
      margin: 15px 0;
      border-radius: 4px;
    }
    .method {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-weight: bold;
      margin-right: 10px;
      color: white;
    }
    .method.GET { background: #10b981; }
    .method.POST { background: #f59e0b; }
    .method.PUT { background: #3b82f6; }
    .method.DELETE { background: #ef4444; }
    .method.PATCH { background: #8b5cf6; }
    .path { font-family: monospace; font-size: 16px; font-weight: bold; }
    .description { color: #6b7280; margin: 8px 0; }
    .tags { margin: 8px 0; }
    .tag {
      display: inline-block;
      background: #e5e7eb;
      color: #374151;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      margin-right: 5px;
    }
    .validation {
      background: #fef3c7;
      border: 1px solid #f59e0b;
      padding: 10px;
      border-radius: 4px;
      margin: 10px 0;
    }
    .auth {
      background: #fee2e2;
      border: 1px solid #ef4444;
      padding: 10px;
      border-radius: 4px;
      margin: 10px 0;
    }
    .rate-limit {
      background: #e0f2fe;
      border: 1px solid #0284c7;
      padding: 10px;
      border-radius: 4px;
      margin: 10px 0;
    }
    .example {
      background: #f3f4f6;
      border: 1px solid #d1d5db;
      padding: 10px;
      border-radius: 4px;
      margin: 10px 0;
      font-family: monospace;
      font-size: 14px;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
      color: #6b7280;
    }
  `;

let simpleDocsPolicy: string | undefined;

/**
 * The Content-Security-Policy of the simple docs page: its own style sheet and
 * the site's icon, nothing else. The page has no script, font or form.
 */
function simpleDocsContentSecurityPolicy(): string {
  if (simpleDocsPolicy === undefined) {
    const digest = createHash('sha256').update(SIMPLE_DOCS_CSS, 'utf8').digest('base64');
    simpleDocsPolicy =
      `default-src 'none'; style-src 'sha256-${digest}'; img-src 'self'; ` +
      "base-uri 'none'; form-action 'none'";
  }
  return simpleDocsPolicy;
}

export interface SimpleDocsOptions {
  title?: string;
  description?: string;
  basePath?: string;
}

export class SimpleDocsGenerator {
  private routes: CompiledRoute[] = [];

  constructor(private options: SimpleDocsOptions = {}) {
    this.options = {
      title: 'API Documentation',
      description: 'API documentation generated from intelligent routes',
      basePath: '/docs',
      ...options,
    };
  }

  addRoutes(routes: CompiledRoute[]): void {
    this.routes = routes;
    logger.debug(`Added ${routes.length} routes to simple docs`, 'RouteAddition');
  }

  generateHTML(): string {
    const routesByTag = this.groupRoutesByTag();
    // Everything below is written as HTML text or into a quoted attribute
    const title = escapeHtml(this.options.title);
    const description = escapeHtml(this.options.description);
    const basePath = escapeHtml(this.options.basePath);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${SIMPLE_DOCS_CSS}</style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p>${description}</p>

    <div class="example">
      <strong>Interactive Swagger UI:</strong> <a href="${basePath}" target="_blank">${basePath}</a><br>
      <strong>OpenAPI JSON:</strong> <a href="${basePath}/openapi.json" target="_blank">${basePath}/openapi.json</a>
    </div>

    ${this.generateRouteDocumentation(routesByTag)}

    <div class="footer">
      <p>Generated automatically from Moro Framework intelligent routes</p>
      <p>Built with Moro Framework - Intelligent Routing + Type-Safe Validation</p>
    </div>
  </div>
</body>
</html>`;
  }

  private groupRoutesByTag(): Map<string, CompiledRoute[]> {
    const grouped = new Map<string, CompiledRoute[]>();

    for (const route of this.routes) {
      const tags = route.schema.tags || ['default'];

      for (const tag of tags) {
        if (!grouped.has(tag)) {
          grouped.set(tag, []);
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        grouped.get(tag)!.push(route);
      }
    }

    return grouped;
  }

  private generateRouteDocumentation(routesByTag: Map<string, CompiledRoute[]>): string {
    let html = '';

    for (const [tag, routes] of routesByTag) {
      html += `<h2>${escapeHtml(tag.charAt(0).toUpperCase() + tag.slice(1))}</h2>`;

      for (const route of routes) {
        html += this.generateRouteSection(route.schema);
      }
    }

    return html;
  }

  private generateRouteSection(route: RouteSchema): string {
    //const methodClass = route.method.toLowerCase();

    const html = `
    <div class="endpoint">
      <div>
        <span class="method ${escapeHtml(route.method)}">${escapeHtml(route.method)}</span>
        <span class="path">${escapeHtml(route.path)}</span>
      </div>

      ${route.description ? `<div class="description">${escapeHtml(route.description)}</div>` : ''}

      ${route.tags ? `<div class="tags">${route.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}

      ${this.generateValidationInfo(route)}
      ${this.generateAuthInfo(route)}
      ${this.generateRateLimitInfo(route)}
      ${this.generateExamples(route)}
    </div>`;

    return html;
  }

  private generateValidationInfo(route: RouteSchema): string {
    if (!route.validation) return '';

    const validationTypes = [];
    if (route.validation.body) validationTypes.push('Body');
    if (route.validation.query) validationTypes.push('Query Parameters');
    if (route.validation.params) validationTypes.push('Path Parameters');
    if (route.validation.headers) validationTypes.push('Headers');

    return `
    <div class="validation">
      <strong>Validation:</strong> ${validationTypes.join(', ')}
      <br><small>Request will be validated with Validation schemas for type safety</small>
    </div>`;
  }

  private generateAuthInfo(route: RouteSchema): string {
    if (!route.auth) return '';

    const roles = route.auth.roles ? route.auth.roles.join(', ') : 'authenticated';

    return `
    <div class="auth">
      <strong>Authentication Required:</strong> ${escapeHtml(roles)}
      <br><small>Requires valid authentication token</small>
    </div>`;
  }

  private generateRateLimitInfo(route: RouteSchema): string {
    if (!route.rateLimit) return '';

    const { requests, window } = route.rateLimit;
    const windowSeconds = Math.round(window / 1000);

    return `
    <div class="rate-limit">
      <strong>Rate Limit:</strong> ${escapeHtml(requests)} requests per ${escapeHtml(windowSeconds)} seconds
      <br><small>Automatic protection against abuse</small>
    </div>`;
  }

  private generateExamples(route: RouteSchema): string {
    const baseUrl = 'http://localhost:3001';
    const fullPath = `${baseUrl}${route.path}`;

    let example = '';

    if (route.method === 'GET') {
      example = `curl "${fullPath}"`;

      // Add query parameter example if validation exists
      if (route.validation?.query) {
        example = `curl "${fullPath}?limit=10&search=example"`;
      }
    } else if (['POST', 'PUT', 'PATCH'].includes(route.method)) {
      example = `curl -X ${route.method} ${fullPath} \\
  -H "Content-Type: application/json" \\
  -d '{"example": "data"}'`;
    } else {
      example = `curl -X ${route.method} ${fullPath}`;
    }

    return `
    <div class="example">
      <strong>Example:</strong><br>
      <code>${escapeHtml(example)}</code>
    </div>`;
  }
}

// Create middleware for simple docs
export function createSimpleDocsMiddleware(
  routes: CompiledRoute[],
  options: SimpleDocsOptions = {}
) {
  const generator = new SimpleDocsGenerator(options);
  generator.addRoutes(routes);

  const basePath = options.basePath || '/docs';

  return (req: any, res: any, next: () => void) => {
    if (req.path === `${basePath}/simple` || req.path === `${basePath}/simple/`) {
      res.setHeader('Content-Security-Policy', simpleDocsContentSecurityPolicy());
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(generator.generateHTML());
      return;
    }

    next();
  };
}
