// Swagger UI Integration for Moro Framework
// Serves interactive API documentation using Swagger UI

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { createUserRequire } from '../utilities/package-utils.js';
import { HttpRequest, HttpResponse } from '../http/index.js';
import { OpenAPISpec } from './openapi-generator.js';
import { createFrameworkLogger } from '../logger/index.js';
import { escapeHtml, toScriptLiteral } from './html-escape.js';

const logger = createFrameworkLogger('SwaggerUI');

// The Swagger UI files the middleware serves under its base path. Every other
// name under the base path belongs to the application.
const SWAGGER_UI_ASSETS = new Set([
  'swagger-ui-bundle.js',
  'swagger-ui.css',
  'swagger-ui-standalone-preset.js',
  'favicon-16x16.png',
  'favicon-32x32.png',
  // Where an OAuth2 authorisation started from the page comes back to. The
  // page loads its script from a file of its own in current Swagger UI releases.
  'oauth2-redirect.html',
  'oauth2-redirect.js',
]);

interface CachedAsset {
  body: Buffer;
  etag: string;
}

// Asset files by absolute path, read from disk once per process: the bundle
// alone is well over a megabyte, and the files of an installed package do not
// change while the process runs.
const assetCache = new Map<string, CachedAsset>();

function loadAsset(assetPath: string): CachedAsset {
  let asset = assetCache.get(assetPath);
  if (!asset) {
    const body = readFileSync(assetPath);
    const digest = createHash('sha1').update(body).digest('base64url');
    asset = { body, etag: `"${body.length.toString(16)}-${digest}"` };
    assetCache.set(assetPath, asset);
  }
  return asset;
}

// Whether an If-None-Match header names the entity tag (weak comparison, RFC 9110 13.1.2)
function matchesETag(header: unknown, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (typeof value !== 'string' || value === '') return false;
  if (value.trim() === '*') return true;
  return value.split(',').some(candidate => candidate.trim().replace(/^W\//, '') === etag);
}

/**
 * Write CSS for the page's <style> element. The element ends at the first
 * "</style" in its text, whatever the CSS around it means, so that sequence is
 * written with an escaped slash: the same CSS, and not an end tag.
 */
function toStyleText(css: unknown): string {
  return String(css).replace(/<\/(style)/gi, '<\\/$1');
}

/** The Content-Security-Policy source that allows exactly this inline script. */
function scriptHashSource(script: string): string {
  return `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;
}

// Swagger UI configuration options
export interface SwaggerUIOptions {
  title?: string;
  favicon?: string;
  /**
   * CSS added to the page's own <style> element.
   */
  customCss?: string;
  /**
   * Accepted and not applied: the page's Content-Security-Policy allows only
   * the Swagger UI files and the page's own start-up script. A warning is
   * logged when it is set.
   */
  customJs?: string;
  /**
   * Further Swagger UI configuration (docExpansion, persistAuthorization,
   * defaultModelsExpandDepth, layout...), passed to SwaggerUIBundle as JSON
   * values. The settings the page makes itself keep their own options: the spec
   * URL, the element it renders into, presets, plugins, and
   * enableTryItOut / enableFilter / enableDeepLinking.
   */
  swaggerOptions?: Record<string, any>;
  enableTryItOut?: boolean;
  enableFilter?: boolean;
  enableDeepLinking?: boolean;
}

// Swagger UI middleware
export class SwaggerUIMiddleware {
  private swaggerUIAssetPath: string;
  private openAPISpec: OpenAPISpec;
  private options: SwaggerUIOptions;
  private refreshSpec: (() => void) | undefined;

  constructor(openAPISpec: OpenAPISpec, options: SwaggerUIOptions = {}) {
    this.openAPISpec = openAPISpec;
    this.options = {
      title: 'API Documentation',
      enableTryItOut: true,
      enableFilter: true,
      enableDeepLinking: true,
      ...options,
    };

    try {
      // Find swagger-ui-dist assets using ESM-compatible resolution
      // Create a require function from the user's working directory to find their installed packages
      const require = createUserRequire();
      // dirname, so the directory is found whichever separator the platform uses
      this.swaggerUIAssetPath = dirname(require.resolve('swagger-ui-dist/package.json'));
      logger.debug('Swagger UI assets found', 'Initialization', {
        assetPath: this.swaggerUIAssetPath,
      });
    } catch (error) {
      logger.error('Failed to locate Swagger UI assets', 'Initialization', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        'swagger-ui-dist package not found. Install with: npm install swagger-ui-dist'
      );
    }
  }

  // Generate the HTML page for Swagger UI, with the policy that goes with it
  private generatePage(rawBasePath: string): { html: string; contentSecurityPolicy: string } {
    // The base path lands in href/src attributes; the spec URL is written
    // separately as a script literal below.
    const basePath = escapeHtml(rawBasePath);
    // swaggerOptions go in as one object literal ahead of the settings the page
    // owns, so those win. The layout is the one page setting they may replace.
    // The OAuth2 redirect page is named before them: Swagger UI would look for
    // it beside the page's own path, which is one level above the base path
    // when the page is opened without a trailing slash.
    const swaggerOptions = this.swaggerOptionsLiteral();
    const extraOptions = swaggerOptions === undefined ? '' : `\n          ...${swaggerOptions},`;
    const configuredLayout = this.options.swaggerOptions?.layout;
    const layout = typeof configuredLayout === 'string' ? configuredLayout : 'StandaloneLayout';

    // The one inline script. Its digest goes into the page's policy, so the
    // browser runs this text and no other inline script.
    const bootstrap = `
    console.log('Starting Swagger UI initialization...');

    function showError(message, details) {
      console.error('Swagger UI Error:', message, details);
      document.getElementById('loading-message').style.display = 'none';
      document.getElementById('error-display').style.display = 'block';
      document.getElementById('error-details').innerHTML =
        '<p><strong>Error:</strong> ' + message + '</p>' +
        (details ? '<pre>' + JSON.stringify(details, null, 2) + '</pre>' : '');
    }

    function initializeSwaggerUI() {
      console.log('Initializing Swagger UI...');

      if (typeof SwaggerUIBundle === 'undefined') {
        showError('SwaggerUIBundle not loaded', { SwaggerUIBundle: typeof SwaggerUIBundle });
        return;
      }

      if (typeof SwaggerUIStandalonePreset === 'undefined') {
        showError('SwaggerUIStandalonePreset not loaded', { SwaggerUIStandalonePreset: typeof SwaggerUIStandalonePreset });
        return;
      }

      try {
        console.log('Creating SwaggerUIBundle...');

        const ui = SwaggerUIBundle({
          oauth2RedirectUrl: window.location.origin + ${toScriptLiteral(`${rawBasePath}/oauth2-redirect.html`)},${extraOptions}
          url: ${toScriptLiteral(`${rawBasePath}/openapi.json`)},
          dom_id: '#swagger-ui',
          deepLinking: ${toScriptLiteral(this.options.enableDeepLinking)},
          presets: [
            SwaggerUIBundle.presets.apis,
            SwaggerUIStandalonePreset
          ],
          plugins: [
            SwaggerUIBundle.plugins.DownloadUrl
          ],
          layout: ${toScriptLiteral(layout)},
          tryItOutEnabled: ${toScriptLiteral(this.options.enableTryItOut)},
          filter: ${toScriptLiteral(this.options.enableFilter)},
          onComplete: function() {
            console.log('Swagger UI loaded successfully');
            document.getElementById('loading-message').style.display = 'none';
          },
          onFailure: function(error) {
            console.error('Swagger UI failed to load:', error);
            showError('Swagger UI initialization failed', error);
          }
        });

        window.ui = ui;
        console.log('SwaggerUIBundle created successfully');

        // Hide loading message after timeout if onComplete doesn't fire
        setTimeout(function() {
          var loadingEl = document.getElementById('loading-message');
          if (loadingEl && loadingEl.style.display !== 'none') {
            console.log('Hiding loading message after timeout');
            loadingEl.style.display = 'none';
          }
        }, 5000);

      } catch (error) {
        console.error('Error creating SwaggerUIBundle:', error);
        showError('Failed to create SwaggerUIBundle', {
          name: error.name,
          message: error.message
        });
      }
    }

    // Initialize when DOM is ready and scripts are loaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        setTimeout(initializeSwaggerUI, 100);
      });
    } else {
      setTimeout(initializeSwaggerUI, 100);
    }
  `;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(this.options.title)}</title>
  <link rel="stylesheet" type="text/css" href="${basePath}/swagger-ui.css" />
  <style>
    html {
      box-sizing: border-box;
      overflow: -moz-scrollbars-vertical;
      overflow-y: scroll;
    }
    *, *:before, *:after {
      box-sizing: inherit;
    }
    body {
      margin:0;
      background: #fafafa;
    }
    #loading-message {
      padding: 20px;
      text-align: center;
      font-family: Arial, sans-serif;
      color: #666;
    }
    #error-display {
      display: none;
      padding: 20px;
      background: #ffebee;
      border-left: 4px solid #f44336;
      margin: 20px;
      font-family: monospace;
      color: #c62828;
    }
    ${this.options.customCss ? toStyleText(this.options.customCss) : ''}
  </style>
  ${this.options.favicon ? `<link rel="icon" type="image/png" href="${escapeHtml(this.options.favicon)}" sizes="32x32" />` : ''}
</head>
<body>
  <div id="loading-message">
    <h2>Loading Swagger UI...</h2>
    <p>Please wait while the API documentation loads.</p>
  </div>
  <div id="swagger-ui"></div>
  <div id="error-display">
    <h3>Failed to Load Swagger UI</h3>
    <div id="error-details"></div>
  </div>

  <script src="${basePath}/swagger-ui-bundle.js" charset="UTF-8"></script>
  <script src="${basePath}/swagger-ui-standalone-preset.js" charset="UTF-8"></script>
  <script>${bootstrap}</script>
</body>
</html>`;

    // Swagger UI adds <style> elements of its own while it runs, so inline
    // styles stay allowed; it needs neither inline scripts nor eval().
    const contentSecurityPolicy =
      "default-src 'self'; " +
      `script-src 'self' ${scriptHashSource(bootstrap)}; ` +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; " +
      "font-src 'self' data:; " +
      "connect-src 'self'; " +
      "object-src 'none'; " +
      "base-uri 'self'";

    return { html, contentSecurityPolicy };
  }

  // swaggerOptions as a script literal, or undefined when there is nothing to
  // apply. Only JSON values can be written; functions are left out.
  private swaggerOptionsLiteral(): string | undefined {
    const options = this.options.swaggerOptions;
    if (!options || typeof options !== 'object') return undefined;

    let literal: string;
    try {
      literal = toScriptLiteral(options);
    } catch (error) {
      logger.warn('swaggerOptions cannot be written as JSON and was not applied', 'SwaggerUI', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    return literal.startsWith('{') && literal !== '{}' ? literal : undefined;
  }

  // Create middleware function that serves Swagger UI
  createMiddleware(basePath: string = '/docs') {
    const assetPrefix = `${basePath}/`;

    if (this.options.customJs) {
      logger.warn(
        'docs: swaggerUI.customJs is not applied. The documentation page runs only the ' +
          'Swagger UI files and its own start-up script; use swaggerOptions to configure Swagger UI.',
        'SwaggerUI'
      );
    }

    return (req: HttpRequest, res: HttpResponse, next: () => void) => {
      const path = req.path;

      // Everything outside the base path belongs to the application
      if (path !== basePath && !path.startsWith(assetPrefix)) {
        next();
        return;
      }

      logger.debug(`Docs middleware handling: ${path}`, 'DocsMiddleware', {
        basePath,
      });

      // Serve the main HTML page
      if (path === basePath || path === `${basePath}/`) {
        logger.debug('Serving Swagger UI HTML', 'DocsServing');

        // The policy allows the Swagger UI files served below and the page's
        // own start-up script, named by its digest
        const page = this.generatePage(basePath);
        res.setHeader('Content-Security-Policy', page.contentSecurityPolicy);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(page.html);
        return;
      }

      // Serve the OpenAPI JSON spec
      if (path === `${basePath}/openapi.json`) {
        logger.debug('Serving OpenAPI JSON spec', 'DocsServing');
        this.bringSpecUpToDate();
        res.setHeader('Content-Type', 'application/json');
        res.json(this.openAPISpec);
        return;
      }

      // Serve Swagger UI assets: only the files named above, each read once
      const assetName = path.slice(assetPrefix.length);
      if (SWAGGER_UI_ASSETS.has(assetName)) {
        const assetPath = join(this.swaggerUIAssetPath, assetName);
        try {
          const asset = loadAsset(assetPath);

          res.setHeader('ETag', asset.etag);
          res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

          // The browser's copy is current: no body
          if (matchesETag(req.headers?.['if-none-match'], asset.etag)) {
            res.statusCode = 304;
            res.end();
            return;
          }

          // Set appropriate content type
          res.setHeader('Content-Type', this.getContentType(assetName));

          logger.debug(`Serving asset: ${assetName} (${asset.body.length} bytes)`, 'AssetServing');
          res.send(asset.body);
          return;
        } catch (error) {
          logger.error(`Failed to serve Swagger UI asset: ${assetName}`, 'AssetServing', {
            error: error instanceof Error ? error.message : String(error),
            assetPath,
          });
          res.status(404);
          res.send(`Asset not found: ${assetName}`);
          return;
        }
      }

      // Any other name under the base path is not ours to answer: an
      // application route such as GET /docs/guide is reached through next()
      logger.debug('Not a documentation path; passing the request on', 'DocsMiddleware');
      next();
    };
  }

  // Let the owner of the document regenerate it before it is served
  private bringSpecUpToDate(): void {
    if (!this.refreshSpec) return;
    try {
      this.refreshSpec();
    } catch (error) {
      // The document generated last is still served
      logger.error('Failed to refresh the OpenAPI specification', 'SpecUpdate', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Get content type for asset files
  private getContentType(filename: string): string {
    if (filename.endsWith('.js')) return 'application/javascript';
    if (filename.endsWith('.css')) return 'text/css';
    if (filename.endsWith('.png')) return 'image/png';
    if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
    if (filename.endsWith('.ico')) return 'image/x-icon';
    return 'text/plain';
  }

  /**
   * Register a function that runs before each time the specification is
   * served. It is the place to call updateSpec() when the document has gone
   * stale, and must be cheap when it has not.
   */
  setSpecRefresher(refresh: () => void): void {
    this.refreshSpec = refresh;
  }

  // Update the OpenAPI spec (useful for dynamic updates)
  updateSpec(newSpec: OpenAPISpec): void {
    this.openAPISpec = newSpec;
    logger.debug('OpenAPI specification updated', 'SpecUpdate', {
      pathCount: Object.keys(newSpec.paths).length,
    });
  }
}

// Convenience function to create documentation middleware
export function createDocsMiddleware(openAPISpec: OpenAPISpec, options: SwaggerUIOptions = {}) {
  const middleware = new SwaggerUIMiddleware(openAPISpec, options);
  return middleware.createMiddleware();
}

// Helper function to generate documentation for an app
export function generateDocsForApp(
  routes: any[],
  info: { title: string; version: string; description?: string },
  options: SwaggerUIOptions = {}
) {
  const openAPISpec: OpenAPISpec = {
    openapi: '3.0.3',
    info,
    servers: [{ url: '/' }],
    paths: {},
    tags: [],
  };

  // This will be enhanced when integrated with the routing system
  logger.info('Documentation generated for app', 'AppDocumentation', {
    routeCount: routes.length,
    title: info.title,
  });

  return createDocsMiddleware(openAPISpec, options);
}
