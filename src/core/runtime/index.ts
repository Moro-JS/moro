// Runtime adapters export
export { BaseRuntimeAdapter } from "./base-adapter";
export { NodeRuntimeAdapter } from "./node-adapter";
export { VercelEdgeAdapter } from "./vercel-edge-adapter";
export { AWSLambdaAdapter } from "./aws-lambda-adapter";
export { CloudflareWorkersAdapter } from "./cloudflare-workers-adapter";

// Re-export types
export type {
  RuntimeType,
  RuntimeAdapter,
  RuntimeConfig,
  RuntimeMoroOptions,
  RuntimeHttpResponse,
} from "../../types/runtime";

// Re-export specific runtime types
export type {
  LambdaEvent,
  LambdaContext,
  LambdaResponse,
} from "./aws-lambda-adapter";
export type { WorkersEnv, WorkersContext } from "./cloudflare-workers-adapter";

// Runtime factory functions
import { NodeRuntimeAdapter } from "./node-adapter";
import { VercelEdgeAdapter } from "./vercel-edge-adapter";
import { AWSLambdaAdapter } from "./aws-lambda-adapter";
import { CloudflareWorkersAdapter } from "./cloudflare-workers-adapter";
import { RuntimeType, RuntimeAdapter } from "../../types/runtime";

export function createRuntimeAdapter(type: RuntimeType): RuntimeAdapter {
  switch (type) {
    case "node":
      return new NodeRuntimeAdapter();
    case "vercel-edge":
      return new VercelEdgeAdapter();
    case "aws-lambda":
      return new AWSLambdaAdapter();
    case "cloudflare-workers":
      return new CloudflareWorkersAdapter();
    default:
      throw new Error(`Unsupported runtime type: ${type}`);
  }
}

// Convenience functions for creating runtime-specific handlers
export function createNodeHandler(
  handler: (req: any, res: any) => Promise<void>,
) {
  const adapter = new NodeRuntimeAdapter();
  return adapter.createServer(handler);
}

export function createEdgeHandler(
  handler: (req: any, res: any) => Promise<void>,
) {
  const adapter = new VercelEdgeAdapter();
  return adapter.createServer(handler);
}

export function createLambdaHandler(
  handler: (req: any, res: any) => Promise<void>,
) {
  const adapter = new AWSLambdaAdapter();
  return adapter.createServer(handler);
}

export function createWorkerHandler(
  handler: (req: any, res: any) => Promise<void>,
) {
  const adapter = new CloudflareWorkersAdapter();
  return adapter.createServer(handler);
}
