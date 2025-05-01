// Base runtime adapter with common functionality
import {
  RuntimeAdapter,
  RuntimeType,
  RuntimeHttpResponse,
} from "../../types/runtime";
import { HttpRequest, HttpResponse } from "../../types/http";
import { randomBytes } from "crypto";

export abstract class BaseRuntimeAdapter implements RuntimeAdapter {
  abstract readonly type: RuntimeType;

  abstract adaptRequest(
    runtimeRequest: any,
    ...args: any[]
  ): Promise<HttpRequest>;
  abstract adaptResponse(
    moroResponse: HttpResponse | RuntimeHttpResponse,
    runtimeRequest: any,
  ): Promise<any>;
  abstract createServer(
    handler: (req: HttpRequest, res: HttpResponse) => Promise<void>,
  ): any;

  // Generate UUID without external dependency
  protected generateUUID(): string {
    return randomBytes(16)
      .toString("hex")
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  }

  // Common request enhancement
  protected enhanceRequest(baseRequest: Partial<HttpRequest>): HttpRequest {
    const request = baseRequest as HttpRequest;

    // Add common properties
    request.requestId = request.requestId || this.generateUUID();
    request.ip = request.ip || "unknown";
    request.params = request.params || {};
    request.query = request.query || {};
    request.cookies = request.cookies || {};
    request.files = request.files || {};

    return request;
  }

  // Common response enhancement
  protected createMockResponse(): RuntimeHttpResponse {
    const response: RuntimeHttpResponse = {
      statusCode: 200,
      headers: {},
      body: null,
      headersSent: false,

      status: function (code: number) {
        this.statusCode = code;
        return this;
      },

      json: function (data: any) {
        this.headers["Content-Type"] = "application/json";
        this.body = JSON.stringify(data);
        this.headersSent = true;
      },

      send: function (data: string | Buffer) {
        this.body = data;
        this.headersSent = true;
      },

      cookie: function (name: string, value: string, options?: any) {
        // Simple cookie implementation
        const cookieString = `${name}=${value}`;
        this.headers["Set-Cookie"] = cookieString;
        return this;
      },

      clearCookie: function (name: string, options?: any) {
        this.headers["Set-Cookie"] =
          `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
        return this;
      },

      redirect: function (url: string, status?: number) {
        this.statusCode = status || 302;
        this.headers["Location"] = url;
        this.headersSent = true;
      },

      sendFile: async function (filePath: string) {
        throw new Error("sendFile not implemented in this runtime");
      },
    };

    return response;
  }

  // Parse URL and query parameters
  protected parseUrl(url: string): {
    pathname: string;
    query: Record<string, string>;
  } {
    try {
      const urlObj = new URL(url, "http://localhost");
      const query: Record<string, string> = {};

      urlObj.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      return {
        pathname: urlObj.pathname,
        query,
      };
    } catch {
      return {
        pathname: url,
        query: {},
      };
    }
  }

  // Parse body based on content type
  protected async parseBody(body: any, contentType?: string): Promise<any> {
    if (!body) return undefined;

    if (typeof body === "string") {
      if (contentType?.includes("application/json")) {
        try {
          return JSON.parse(body);
        } catch {
          return body;
        }
      }
      return body;
    }

    return body;
  }
}
