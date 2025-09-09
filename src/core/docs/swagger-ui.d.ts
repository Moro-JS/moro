import { HttpRequest, HttpResponse } from '../http';
import { OpenAPISpec } from './openapi-generator';
export interface SwaggerUIOptions {
  title?: string;
  favicon?: string;
  customCss?: string;
  customJs?: string;
  swaggerOptions?: Record<string, any>;
  enableTryItOut?: boolean;
  enableFilter?: boolean;
  enableDeepLinking?: boolean;
}
export declare class SwaggerUIMiddleware {
  private swaggerUIAssetPath;
  private openAPISpec;
  private options;
  constructor(openAPISpec: OpenAPISpec, options?: SwaggerUIOptions);
  private generateHTML;
  createMiddleware(
    basePath?: string
  ): (req: HttpRequest, res: HttpResponse, next: () => void) => void;
  private getContentType;
  updateSpec(newSpec: OpenAPISpec): void;
}
export declare function createDocsMiddleware(
  openAPISpec: OpenAPISpec,
  options?: SwaggerUIOptions
): (req: HttpRequest, res: HttpResponse, next: () => void) => void;
export declare function generateDocsForApp(
  routes: any[],
  info: {
    title: string;
    version: string;
    description?: string;
  },
  options?: SwaggerUIOptions
): (req: HttpRequest, res: HttpResponse, next: () => void) => void;
