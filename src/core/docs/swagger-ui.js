"use strict";
// Swagger UI Integration for Moro Framework
// Serves interactive API documentation using Swagger UI
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwaggerUIMiddleware = void 0;
exports.createDocsMiddleware = createDocsMiddleware;
exports.generateDocsForApp = generateDocsForApp;
const fs_1 = require("fs");
const path_1 = require("path");
const logger_1 = require("../logger");
const logger = (0, logger_1.createFrameworkLogger)("SwaggerUI");
// Swagger UI middleware
class SwaggerUIMiddleware {
    swaggerUIAssetPath;
    openAPISpec;
    options;
    constructor(openAPISpec, options = {}) {
        this.openAPISpec = openAPISpec;
        this.options = {
            title: "API Documentation",
            enableTryItOut: true,
            enableFilter: true,
            enableDeepLinking: true,
            swaggerOptions: {
                dom_id: "#swagger-ui",
                presets: [
                    "SwaggerUIBundle.presets.apis",
                    "SwaggerUIBundle.presets.standalone",
                ],
                plugins: ["SwaggerUIBundle.plugins.DownloadUrl"],
                layout: "StandaloneLayout",
            },
            ...options,
        };
        try {
            // Find swagger-ui-dist assets
            this.swaggerUIAssetPath = require
                .resolve("swagger-ui-dist/package.json")
                .replace("/package.json", "");
            logger.debug("Swagger UI assets found", "Initialization", {
                assetPath: this.swaggerUIAssetPath,
            });
        }
        catch (error) {
            logger.error("Failed to locate Swagger UI assets", "Initialization", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw new Error("swagger-ui-dist package not found. Install with: npm install swagger-ui-dist");
        }
    }
    // Generate HTML page for Swagger UI
    generateHTML(basePath) {
        const swaggerOptions = {
            ...this.options.swaggerOptions,
            url: `${basePath}/openapi.json`, // Relative URL to the OpenAPI spec
            tryItOutEnabled: this.options.enableTryItOut,
            filter: this.options.enableFilter,
            deepLinking: this.options.enableDeepLinking,
        };
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${this.options.title}</title>
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
    ${this.options.customCss || ""}
  </style>
  ${this.options.favicon ? `<link rel="icon" type="image/png" href="${this.options.favicon}" sizes="32x32" />` : ""}
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
  <script>
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
          url: '${basePath}/openapi.json',
          dom_id: '#swagger-ui',
          deepLinking: ${this.options.enableDeepLinking},
          presets: [
            SwaggerUIBundle.presets.apis,
            SwaggerUIStandalonePreset
          ],
          plugins: [
            SwaggerUIBundle.plugins.DownloadUrl
          ],
          layout: "StandaloneLayout",
          tryItOutEnabled: ${this.options.enableTryItOut},
          filter: ${this.options.enableFilter},
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
  </script>
</body>
</html>`;
    }
    // Create middleware function that serves Swagger UI
    createMiddleware(basePath = "/docs") {
        return (req, res, next) => {
            const path = req.path;
            logger.debug(`Docs middleware handling: ${path}`, "DocsMiddleware", {
                basePath,
            });
            // Serve the main HTML page
            if (path === basePath || path === `${basePath}/`) {
                logger.debug("Serving Swagger UI HTML", "DocsServing");
                // Set CSP headers to allow Swagger UI to work
                res.setHeader("Content-Security-Policy", "default-src 'self'; " +
                    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
                    "style-src 'self' 'unsafe-inline'; " +
                    "img-src 'self' data: https:; " +
                    "font-src 'self' data:; " +
                    "connect-src 'self'");
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.send(this.generateHTML(basePath));
                return;
            }
            // Serve the OpenAPI JSON spec
            if (path === `${basePath}/openapi.json`) {
                logger.debug("Serving OpenAPI JSON spec", "DocsServing");
                res.setHeader("Content-Type", "application/json");
                res.json(this.openAPISpec);
                return;
            }
            // Serve Swagger UI assets
            if (path.startsWith(`${basePath}/`)) {
                const assetName = path.replace(`${basePath}/`, "");
                logger.debug(`Attempting to serve asset: ${assetName}`, "AssetServing", {
                    fullPath: path,
                    basePath,
                    assetPath: this.swaggerUIAssetPath,
                });
                // Security: only allow specific asset files
                const allowedAssets = [
                    "swagger-ui-bundle.js",
                    "swagger-ui.css",
                    "swagger-ui-standalone-preset.js",
                    "favicon-16x16.png",
                    "favicon-32x32.png",
                ];
                if (allowedAssets.includes(assetName)) {
                    try {
                        const assetPath = (0, path_1.join)(this.swaggerUIAssetPath, assetName);
                        logger.debug(`Reading asset from: ${assetPath}`, "AssetServing");
                        const content = (0, fs_1.readFileSync)(assetPath);
                        // Set appropriate content type
                        const contentType = this.getContentType(assetName);
                        res.setHeader("Content-Type", contentType);
                        res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 1 day
                        logger.debug(`Serving asset: ${assetName} (${content.length} bytes)`, "AssetServing");
                        res.send(content);
                        return;
                    }
                    catch (error) {
                        logger.error(`Failed to serve Swagger UI asset: ${assetName}`, "AssetServing", {
                            error: error instanceof Error ? error.message : String(error),
                            assetPath: (0, path_1.join)(this.swaggerUIAssetPath, assetName),
                        });
                        res.status(404);
                        res.send(`Asset not found: ${assetName}`);
                        return;
                    }
                }
                else {
                    logger.warn(`Asset not allowed: ${assetName}`, "AssetServing", {
                        allowedAssets,
                    });
                    res.status(404);
                    res.send(`Asset not allowed: ${assetName}`);
                    return;
                }
            }
            // Not a docs request, continue to next middleware
            next();
        };
    }
    // Get content type for asset files
    getContentType(filename) {
        if (filename.endsWith(".js"))
            return "application/javascript";
        if (filename.endsWith(".css"))
            return "text/css";
        if (filename.endsWith(".png"))
            return "image/png";
        if (filename.endsWith(".ico"))
            return "image/x-icon";
        return "text/plain";
    }
    // Update the OpenAPI spec (useful for dynamic updates)
    updateSpec(newSpec) {
        this.openAPISpec = newSpec;
        logger.debug("OpenAPI specification updated", "SpecUpdate", {
            pathCount: Object.keys(newSpec.paths).length,
        });
    }
}
exports.SwaggerUIMiddleware = SwaggerUIMiddleware;
// Convenience function to create documentation middleware
function createDocsMiddleware(openAPISpec, options = {}) {
    const middleware = new SwaggerUIMiddleware(openAPISpec, options);
    return middleware.createMiddleware();
}
// Helper function to generate documentation for an app
function generateDocsForApp(routes, info, options = {}) {
    const openAPISpec = {
        openapi: "3.0.3",
        info,
        servers: [
            { url: "http://localhost:3000", description: "Development server" },
        ],
        paths: {},
        tags: [],
    };
    // This will be enhanced when integrated with the routing system
    logger.info("Documentation generated for app", "AppDocumentation", {
        routeCount: routes.length,
        title: info.title,
    });
    return createDocsMiddleware(openAPISpec, options);
}
