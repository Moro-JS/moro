"use strict";
// Moro Framework Documentation System
// Automatic API documentation generation from intelligent routes and Zod schemas
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppDocumentationManager = exports.DocumentationSystem = void 0;
exports.createDocumentationSystem = createDocumentationSystem;
exports.generateDocsFromIntelligentRoutes = generateDocsFromIntelligentRoutes;
const openapi_generator_1 = require("./openapi-generator");
const swagger_ui_1 = require("./swagger-ui");
const logger_1 = require("../logger");
const logger = (0, logger_1.createFrameworkLogger)('DocumentationSystem');
// Main documentation system class
class DocumentationSystem {
    generator;
    swaggerUI;
    config;
    constructor(config) {
        this.config = {
            basePath: '/docs',
            includeExamples: true,
            includeSchemas: true,
            enableAuth: true,
            ...config,
        };
        // Create OpenAPI generator
        const generationOptions = {
            info: {
                title: this.config.title,
                version: this.config.version,
                description: this.config.description,
                contact: this.config.contact,
                license: this.config.license,
            },
            servers: this.config.servers,
            includeExamples: this.config.includeExamples,
            includeSchemas: this.config.includeSchemas,
            securitySchemes: this.config.enableAuth ? openapi_generator_1.defaultSecuritySchemes : undefined,
        };
        this.generator = new openapi_generator_1.OpenAPIGenerator(generationOptions);
        // Initialize with empty spec
        const initialSpec = this.generator.generate();
        this.swaggerUI = new swagger_ui_1.SwaggerUIMiddleware(initialSpec, this.config.swaggerUI);
        logger.info('Documentation system initialized', 'Initialization', {
            title: this.config.title,
            basePath: this.config.basePath,
            includeExamples: this.config.includeExamples,
        });
    }
    // Generate documentation from intelligent routing manager
    generateFromRoutes(routes) {
        this.generator.addRoutes(routes);
        const spec = this.generator.generate();
        // Update Swagger UI with new spec
        this.swaggerUI.updateSpec(spec);
        logger.info('Documentation generated from routes', 'Generation', {
            routeCount: routes.length,
            pathCount: Object.keys(spec.paths).length,
        });
        return spec;
    }
    // Create middleware that serves the documentation
    createMiddleware() {
        return this.swaggerUI.createMiddleware(this.config.basePath);
    }
    // Generate OpenAPI spec as JSON
    getOpenAPIJSON() {
        return this.generator.generateJSON();
    }
    // Generate OpenAPI spec as YAML
    getOpenAPIYAML() {
        return this.generator.generateYAML();
    }
    // Get the current OpenAPI spec
    getSpec() {
        return this.generator.generate();
    }
    // Update configuration
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        logger.debug('Documentation configuration updated', 'ConfigUpdate', {
            title: this.config.title,
            basePath: this.config.basePath,
        });
    }
}
exports.DocumentationSystem = DocumentationSystem;
// Documentation integration for apps
class AppDocumentationManager {
    docSystem;
    routingManager;
    // Initialize documentation system
    enableDocs(config, routingManager) {
        this.routingManager = routingManager;
        this.docSystem = new DocumentationSystem(config);
        // Generate docs from current routes
        const routes = routingManager.getIntelligentRoutes();
        this.docSystem.generateFromRoutes(routes);
        logger.info('Documentation enabled for app', 'AppIntegration', {
            title: config.title,
            routeCount: routes.length,
            basePath: config.basePath,
        });
    }
    // Get documentation middleware
    getDocsMiddleware() {
        if (!this.docSystem) {
            throw new Error('Documentation not enabled. Call enableDocs() first.');
        }
        return this.docSystem.createMiddleware();
    }
    // Refresh documentation (useful after adding new routes)
    refreshDocs() {
        if (!this.docSystem || !this.routingManager) {
            throw new Error('Documentation not enabled. Call enableDocs() first.');
        }
        const routes = this.routingManager.getIntelligentRoutes();
        this.docSystem.generateFromRoutes(routes);
        logger.debug('Documentation refreshed', 'Refresh', {
            routeCount: routes.length,
        });
    }
    // Get current OpenAPI spec
    getOpenAPISpec() {
        if (!this.docSystem) {
            throw new Error('Documentation not enabled. Call enableDocs() first.');
        }
        return this.docSystem.getSpec();
    }
    // Get docs as JSON
    getDocsJSON() {
        if (!this.docSystem) {
            throw new Error('Documentation not enabled. Call enableDocs() first.');
        }
        return this.docSystem.getOpenAPIJSON();
    }
    // Get docs as YAML
    getDocsYAML() {
        if (!this.docSystem) {
            throw new Error('Documentation not enabled. Call enableDocs() first.');
        }
        return this.docSystem.getOpenAPIYAML();
    }
}
exports.AppDocumentationManager = AppDocumentationManager;
// Convenience functions
function createDocumentationSystem(config) {
    return new DocumentationSystem(config);
}
function generateDocsFromIntelligentRoutes(routes, config) {
    const docSystem = new DocumentationSystem(config);
    const spec = docSystem.generateFromRoutes(routes);
    const middleware = docSystem.createMiddleware();
    return { spec, middleware };
}
// Export all types and functions
__exportStar(require("./openapi-generator"), exports);
__exportStar(require("./swagger-ui"), exports);
__exportStar(require("./zod-to-openapi"), exports);
