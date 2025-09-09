import { BaseRuntimeAdapter } from './base-adapter';
import { HttpRequest, HttpResponse } from '../../types/http';
import { RuntimeHttpResponse } from '../../types/runtime';
export declare class VercelEdgeAdapter extends BaseRuntimeAdapter {
  readonly type: 'vercel-edge';
  adaptRequest(request: Request): Promise<HttpRequest>;
  adaptResponse(moroResponse: HttpResponse | RuntimeHttpResponse): Promise<Response>;
  createServer(
    handler: (req: HttpRequest, res: HttpResponse) => Promise<void>
  ): (request: Request) => Promise<Response>;
  private getClientIP;
}
