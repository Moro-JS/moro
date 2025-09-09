import { CompiledRoute } from '../routing';
import { OpenAPISchema } from './zod-to-openapi';
export interface OpenAPISpec {
  openapi: string;
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  paths: Record<string, OpenAPIPath>;
  components?: OpenAPIComponents;
  tags?: OpenAPITag[];
}
export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
  contact?: {
    name?: string;
    url?: string;
    email?: string;
  };
  license?: {
    name: string;
    url?: string;
  };
}
export interface OpenAPIServer {
  url: string;
  description?: string;
}
export interface OpenAPIPath {
  [method: string]: OpenAPIOperation;
}
export interface OpenAPIOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses: Record<string, OpenAPIResponse>;
  security?: OpenAPISecurityRequirement[];
}
export interface OpenAPIParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema: OpenAPISchema;
  example?: any;
}
export interface OpenAPIRequestBody {
  description?: string;
  required?: boolean;
  content: Record<string, OpenAPIMediaType>;
}
export interface OpenAPIMediaType {
  schema: OpenAPISchema;
  example?: any;
  examples?: Record<string, OpenAPIExample>;
}
export interface OpenAPIResponse {
  description: string;
  content?: Record<string, OpenAPIMediaType>;
  headers?: Record<string, OpenAPIHeader>;
}
export interface OpenAPIHeader {
  description?: string;
  schema: OpenAPISchema;
}
export interface OpenAPIExample {
  summary?: string;
  description?: string;
  value: any;
}
export interface OpenAPIComponents {
  schemas?: Record<string, OpenAPISchema>;
  responses?: Record<string, OpenAPIResponse>;
  parameters?: Record<string, OpenAPIParameter>;
  examples?: Record<string, OpenAPIExample>;
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
}
export interface OpenAPISecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  description?: string;
  name?: string;
  in?: 'query' | 'header' | 'cookie';
  scheme?: string;
  bearerFormat?: string;
}
export interface OpenAPISecurityRequirement {
  [name: string]: string[];
}
export interface OpenAPITag {
  name: string;
  description?: string;
}
export interface GenerationOptions {
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  includeExamples?: boolean;
  includeSchemas?: boolean;
  groupByTags?: boolean;
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
}
export declare class OpenAPIGenerator {
  private options;
  private routes;
  private schemas;
  private tags;
  constructor(options: GenerationOptions);
  addRoutes(routes: CompiledRoute[]): void;
  generate(): OpenAPISpec;
  private generatePaths;
  private generateOperation;
  private generateParameters;
  private generateRequestBody;
  private generateResponses;
  private generateSecurity;
  private generateTags;
  private convertPathToOpenAPI;
  generateJSON(): string;
  generateYAML(): string;
  private objectToYAML;
}
export declare function generateOpenAPIFromRoutes(
  routes: CompiledRoute[],
  options: GenerationOptions
): OpenAPISpec;
export declare const defaultSecuritySchemes: Record<string, OpenAPISecurityScheme>;
