import { BaseRuntimeAdapter } from './base-adapter';
import { HttpRequest, HttpResponse } from '../../types/http';
import { RuntimeHttpResponse } from '../../types/runtime';
export interface LambdaEvent {
  httpMethod: string;
  path: string;
  pathParameters?: Record<string, string> | null;
  queryStringParameters?: Record<string, string> | null;
  headers?: Record<string, string> | null;
  multiValueHeaders?: Record<string, string[]> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    identity?: {
      sourceIp?: string;
    };
  };
}
export interface LambdaContext {
  requestId: string;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  awsRequestId: string;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis(): number;
}
export interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body: string;
  isBase64Encoded?: boolean;
}
export declare class AWSLambdaAdapter extends BaseRuntimeAdapter {
  readonly type: 'aws-lambda';
  adaptRequest(event: LambdaEvent, context: LambdaContext): Promise<HttpRequest>;
  adaptResponse(moroResponse: HttpResponse | RuntimeHttpResponse): Promise<LambdaResponse>;
  createServer(
    handler: (req: HttpRequest, res: HttpResponse) => Promise<void>
  ): (event: LambdaEvent, context: LambdaContext) => Promise<LambdaResponse>;
  private parseCookies;
}
