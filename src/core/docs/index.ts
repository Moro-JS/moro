// Moro Framework Documentation System
// Automatic API documentation generation from intelligent routes and Validation schemas

import { CompiledRoute } from '../routing/index.js';
import { IntelligentRoutingManager } from '../routing/app-integration.js';
import {
  OpenAPIGenerator,
  generateOpenAPIFromRoutes,
  GenerationOptions,
  OpenAPISpec,
  defaultSecuritySchemes,
} from './openapi-generator.js';
import { SwaggerUIMiddleware, SwaggerUIOptions, createDocsMiddleware } from './swagger-ui.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('DocumentationSystem');

// Documentation configuration
export interface DocsConfig {
  title: string;
  version: string;
  description?: string;
  basePath?: string;
  servers?: Array<{ url: string; description?: string }>;
  contact?: {
    name?: string;
    url?: string;
    email?: string;
  };
  license?: {
    name: string;
    url?: string;
  };
  swaggerUI?: SwaggerUIOptions;
  includeExamples?: boolean;
  includeSchemas?: boolean;
  enableAuth?: boolean;
}

// Main documentation system class
export class DocumentationSystem {
  private generator: OpenAPIGenerator;
  private swaggerUI: SwaggerUIMiddleware;
  private config: DocsConfig;

  constructor(config: DocsConfig) {
    this.config = {
      basePath: '/docs',
      includeExamples: true,
      includeSchemas: true,
      enableAuth: true,
      ...config,
    };

    // Create OpenAPI generator
    const generationOptions: GenerationOptions = {
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
      securitySchemes: this.config.enableAuth ? defaultSecuritySchemes : undefined,
    };

    this.generator = new OpenAPIGenerator(generationOptions);

    // Initialize with empty spec
    const initialSpec = this.generator.generate();
    this.swaggerUI = new SwaggerUIMiddleware(initialSpec, this.config.swaggerUI);

    logger.info('Documentation system initialized', 'Initialization', {
      title: this.config.title,
      basePath: this.config.basePath,
      includeExamples: this.config.includeExamples,
    });
  }

  // Generate documentation from intelligent routing manager
  generateFromRoutes(routes: CompiledRoute[]): OpenAPISpec {
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
  getOpenAPIJSON(): string {
    return this.generator.generateJSON();
  }

  // Generate OpenAPI spec as YAML
  getOpenAPIYAML(): string {
    return this.generator.generateYAML();
  }

  // Get the current OpenAPI spec
  getSpec(): OpenAPISpec {
    return this.generator.generate();
  }

  // Update configuration
  updateConfig(newConfig: Partial<DocsConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.debug('Documentation configuration updated', 'ConfigUpdate', {
      title: this.config.title,
      basePath: this.config.basePath,
    });
  }
}

// App integration mixin for documentation
export interface AppWithDocs {
  // Enable automatic API documentation
  enableDocs(config: DocsConfig): void;

  // Get the current OpenAPI specification
  getOpenAPISpec(): OpenAPISpec;

  // Get documentation as JSON
  getDocsJSON(): string;

  // Get documentation as YAML
  getDocsYAML(): string;
}

// Documentation integration for apps
export class AppDocumentationManager {
  private docSystem?: DocumentationSystem;
  private routingManager?: IntelligentRoutingManager;

  // Initialize documentation system
  enableDocs(config: DocsConfig, routingManager: IntelligentRoutingManager): void {
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
  refreshDocs(): void {
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
  getOpenAPISpec(): OpenAPISpec {
    if (!this.docSystem) {
      throw new Error('Documentation not enabled. Call enableDocs() first.');
    }
    return this.docSystem.getSpec();
  }

  // Get docs as JSON
  getDocsJSON(): string {
    if (!this.docSystem) {
      throw new Error('Documentation not enabled. Call enableDocs() first.');
    }
    return this.docSystem.getOpenAPIJSON();
  }

  // Get docs as YAML
  getDocsYAML(): string {
    if (!this.docSystem) {
      throw new Error('Documentation not enabled. Call enableDocs() first.');
    }
    return this.docSystem.getOpenAPIYAML();
  }
}

// Convenience functions
export function createDocumentationSystem(config: DocsConfig): DocumentationSystem {
  return new DocumentationSystem(config);
}

export function generateDocsFromIntelligentRoutes(
  routes: CompiledRoute[],
  config: DocsConfig
): { spec: OpenAPISpec; middleware: any } {
  const docSystem = new DocumentationSystem(config);
  const spec = docSystem.generateFromRoutes(routes);
  const middleware = docSystem.createMiddleware();

  return { spec, middleware };
}

// Export all types and functions
export * from './openapi-generator.js';
export * from './swagger-ui.js';
export * from './zod-to-openapi.js';
