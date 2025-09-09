export { BaseRuntimeAdapter } from './base-adapter';
export { NodeRuntimeAdapter } from './node-adapter';
export { VercelEdgeAdapter } from './vercel-edge-adapter';
export { AWSLambdaAdapter } from './aws-lambda-adapter';
export { CloudflareWorkersAdapter } from './cloudflare-workers-adapter';
export type {
  RuntimeType,
  RuntimeAdapter,
  RuntimeConfig,
  RuntimeMoroOptions,
  RuntimeHttpResponse,
} from '../../types/runtime';
export type { LambdaEvent, LambdaContext, LambdaResponse } from './aws-lambda-adapter';
export type { WorkersEnv, WorkersContext } from './cloudflare-workers-adapter';
import { RuntimeType, RuntimeAdapter } from '../../types/runtime';
export declare function createRuntimeAdapter(type: RuntimeType): RuntimeAdapter;
export declare function createNodeHandler(
  handler: (req: any, res: any) => Promise<void>
): import('../http').MoroHttpServer;
export declare function createEdgeHandler(
  handler: (req: any, res: any) => Promise<void>
): (request: Request) => Promise<Response>;
export declare function createLambdaHandler(
  handler: (req: any, res: any) => Promise<void>
): (
  event: import('./aws-lambda-adapter').LambdaEvent,
  context: import('./aws-lambda-adapter').LambdaContext
) => Promise<import('./aws-lambda-adapter').LambdaResponse>;
export declare function createWorkerHandler(
  handler: (req: any, res: any) => Promise<void>
): (
  request: Request,
  env: import('./cloudflare-workers-adapter').WorkersEnv,
  ctx: import('./cloudflare-workers-adapter').WorkersContext
) => Promise<Response>;
