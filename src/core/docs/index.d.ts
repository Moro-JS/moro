import { CompiledRoute } from '../routing';
import { IntelligentRoutingManager } from '../routing/app-integration';
import { OpenAPISpec } from './openapi-generator';
import { SwaggerUIOptions } from './swagger-ui';
export interface DocsConfig {
  title: string;
  version: string;
  description?: string;
  basePath?: string;
  servers?: Array<{
    url: string;
    description?: string;
  }>;
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
export declare class DocumentationSystem {
  private generator;
  private swaggerUI;
  private config;
  constructor(config: DocsConfig);
  generateFromRoutes(routes: CompiledRoute[]): OpenAPISpec;
  createMiddleware(): (
    req: import('../http').HttpRequest,
    res: import('../http').HttpResponse,
    next: () => void
  ) => void;
  getOpenAPIJSON(): string;
  getOpenAPIYAML(): string;
  getSpec(): OpenAPISpec;
  updateConfig(newConfig: Partial<DocsConfig>): void;
}
export interface AppWithDocs {
  enableDocs(config: DocsConfig): void;
  getOpenAPISpec(): OpenAPISpec;
  getDocsJSON(): string;
  getDocsYAML(): string;
}
export declare class AppDocumentationManager {
  private docSystem?;
  private routingManager?;
  enableDocs(config: DocsConfig, routingManager: IntelligentRoutingManager): void;
  getDocsMiddleware(): (
    req: import('../http').HttpRequest,
    res: import('../http').HttpResponse,
    next: () => void
  ) => void;
  refreshDocs(): void;
  getOpenAPISpec(): OpenAPISpec;
  getDocsJSON(): string;
  getDocsYAML(): string;
}
export declare function createDocumentationSystem(config: DocsConfig): DocumentationSystem;
export declare function generateDocsFromIntelligentRoutes(
  routes: CompiledRoute[],
  config: DocsConfig
): {
  spec: OpenAPISpec;
  middleware: any;
};
export * from './openapi-generator';
export * from './swagger-ui';
export * from './zod-to-openapi';
