import { BaseRuntimeAdapter } from './base-adapter';
import { HttpRequest, HttpResponse } from '../../types/http';
import { RuntimeHttpResponse } from '../../types/runtime';
export interface WorkersEnv {
  [key: string]: any;
}
export interface WorkersContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}
export declare class CloudflareWorkersAdapter extends BaseRuntimeAdapter {
  readonly type: 'cloudflare-workers';
  adaptRequest(request: Request, env: WorkersEnv, ctx: WorkersContext): Promise<HttpRequest>;
  adaptResponse(moroResponse: HttpResponse | RuntimeHttpResponse): Promise<Response>;
  createServer(
    handler: (req: HttpRequest, res: HttpResponse) => Promise<void>
  ): (request: Request, env: WorkersEnv, ctx: WorkersContext) => Promise<Response>;
  private getClientIP;
  private parseCookies;
}
