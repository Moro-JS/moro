import { RuntimeAdapter, RuntimeType, RuntimeHttpResponse } from '../../types/runtime';
import { HttpRequest, HttpResponse } from '../../types/http';
export declare abstract class BaseRuntimeAdapter implements RuntimeAdapter {
  abstract readonly type: RuntimeType;
  abstract adaptRequest(runtimeRequest: any, ...args: any[]): Promise<HttpRequest>;
  abstract adaptResponse(
    moroResponse: HttpResponse | RuntimeHttpResponse,
    runtimeRequest: any
  ): Promise<any>;
  abstract createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): any;
  protected generateUUID(): string;
  protected enhanceRequest(baseRequest: Partial<HttpRequest>): HttpRequest;
  protected createMockResponse(): RuntimeHttpResponse;
  protected parseUrl(url: string): {
    pathname: string;
    query: Record<string, string>;
  };
  protected parseBody(body: any, contentType?: string): Promise<any>;
}
