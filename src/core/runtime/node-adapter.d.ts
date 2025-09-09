import { IncomingMessage, ServerResponse } from 'http';
import { BaseRuntimeAdapter } from './base-adapter';
import { HttpRequest, HttpResponse } from '../../types/http';
import { RuntimeHttpResponse } from '../../types/runtime';
import { MoroHttpServer } from '../http/http-server';
export declare class NodeRuntimeAdapter extends BaseRuntimeAdapter {
  readonly type: 'node';
  adaptRequest(req: IncomingMessage): Promise<HttpRequest>;
  adaptResponse(
    moroResponse: HttpResponse | RuntimeHttpResponse,
    req: IncomingMessage
  ): Promise<ServerResponse>;
  createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): MoroHttpServer;
  listen(server: MoroHttpServer, port: number, host?: string, callback?: () => void): void;
  private parseRequestBody;
  private getClientIP;
  private enhanceResponse;
}
