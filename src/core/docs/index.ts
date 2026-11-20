// Moro Framework Documentation System
// Automatic API documentation generation from intelligent routes and Validation schemas

import { CompiledRoute, RouteSchema } from '../routing/index.js';
import { IntelligentRoutingManager } from '../routing/app-integration.js';
import {
  OpenAPIGenerator,
  GenerationOptions,
  OpenAPISpec,
  defaultSecuritySchemes,
} from './openapi-generator.js';
import { SwaggerUIMiddleware, SwaggerUIOptions } from './swagger-ui.js';
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
  // Where the live route list comes from, once followRoutes() has been called
  private routeSource: (() => CompiledRoute[]) | undefined;
  // The route schemas the current document was generated from, in order
  private documented: RouteSchema[] = [];

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
        ...(this.config.description !== undefined ? { description: this.config.description } : {}),
        ...(this.config.contact !== undefined ? { contact: this.config.contact } : {}),
        ...(this.config.license !== undefined ? { license: this.config.license } : {}),
      },
      ...(this.config.servers !== undefined ? { servers: this.config.servers } : {}),
      ...(this.config.includeExamples !== undefined
        ? { includeExamples: this.config.includeExamples }
        : {}),
      ...(this.config.includeSchemas !== undefined
        ? { includeSchemas: this.config.includeSchemas }
        : {}),
      ...(this.config.enableAuth
        ? { securitySchemes: defaultSecuritySchemes }
        : { enableAuth: false }),
    };

    this.generator = new OpenAPIGenerator(generationOptions);

    // Initialize with empty spec
    const initialSpec = this.generator.generate();
    this.swaggerUI = new SwaggerUIMiddleware(initialSpec, this.config.swaggerUI);
    // The served document is brought up to date when it is asked for
    this.swaggerUI.setSpecRefresher(() => this.syncRoutes());

    logger.info('Documentation system initialized', 'Initialization', {
      title: this.config.title,
      basePath: this.config.basePath,
      includeExamples: this.config.includeExamples,
    });
  }

  // Generate documentation from intelligent routing manager. Routes given in
  // an earlier call stay documented; a route given again is documented once.
  generateFromRoutes(routes: CompiledRoute[]): OpenAPISpec {
    this.generator.addRoutes(routes);
    return this.publish(routes.length);
  }

  // Generate the document from the routes the generator holds and hand it to
  // the page that serves it
  private publish(routeCount?: number): OpenAPISpec {
    const spec = this.generator.generate();

    // Update Swagger UI with new spec
    this.swaggerUI.updateSpec(spec);

    logger.info('Documentation generated from routes', 'Generation', {
      ...(routeCount !== undefined ? { routeCount } : {}),
      pathCount: Object.keys(spec.paths).length,
    });

    return spec;
  }

  /**
   * Keep the document in step with a route list that changes after this call:
   * routes declared later, and routes loaded from files while the server
   * starts. The list is read again whenever the document is asked for (the
   * getters below and the served `openapi.json`), and the document is
   * generated again only when the list is not the one already documented.
   */
  followRoutes(source: () => CompiledRoute[]): void {
    this.routeSource = source;
    this.regenerate();
  }

  /**
   * Generate the document again from the followed route list, which becomes
   * the whole of what is documented. Without a followed list the document is
   * generated again from the routes already given.
   */
  regenerate(): OpenAPISpec {
    return this.routeSource ? this.documentOnly(this.routeSource()) : this.publish();
  }

  // Make the given routes the whole of what is documented
  private documentOnly(routes: CompiledRoute[]): OpenAPISpec {
    this.generator.setRoutes(routes);
    this.documented = routes.map(route => route.schema);
    return this.publish(routes.length);
  }

  // Regenerate if the followed route list has changed since the last generation
  private syncRoutes(): void {
    if (!this.routeSource) return;

    const routes = this.routeSource();
    const documented = this.documented;
    if (
      routes.length === documented.length &&
      routes.every((route, index) => route.schema === documented[index])
    ) {
      return;
    }

    this.documentOnly(routes);
  }

  // Create middleware that serves the documentation
  createMiddleware() {
    return this.swaggerUI.createMiddleware(this.config.basePath);
  }

  // Generate OpenAPI spec as JSON
  getOpenAPIJSON(): string {
    this.syncRoutes();
    return this.generator.generateJSON();
  }

  // Generate OpenAPI spec as YAML
  getOpenAPIYAML(): string {
    this.syncRoutes();
    return this.generator.generateYAML();
  }

  // Get the current OpenAPI spec
  getSpec(): OpenAPISpec {
    this.syncRoutes();
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

    // Generate docs from current routes, and again when the document is asked
    // for after the route list has changed
    const routes = routingManager.getIntelligentRoutes();
    this.docSystem.followRoutes(() => routingManager.getIntelligentRoutes());

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

    const spec = this.docSystem.regenerate();

    logger.debug('Documentation refreshed', 'Refresh', {
      pathCount: Object.keys(spec.paths).length,
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
