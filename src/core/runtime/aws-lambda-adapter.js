"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AWSLambdaAdapter = void 0;
// AWS Lambda runtime adapter
const base_adapter_1 = require("./base-adapter");
class AWSLambdaAdapter extends base_adapter_1.BaseRuntimeAdapter {
    type = 'aws-lambda';
    async adaptRequest(event, context) {
        const { pathname, query } = this.parseUrl(event.path);
        // Merge query parameters from event
        const mergedQuery = {
            ...query,
            ...(event.queryStringParameters || {}),
        };
        // Parse body
        let body;
        if (event.body) {
            const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';
            if (event.isBase64Encoded) {
                body = Buffer.from(event.body, 'base64').toString();
            }
            else {
                body = event.body;
            }
            body = await this.parseBody(body, contentType);
        }
        const baseRequest = {
            method: event.httpMethod,
            url: event.path,
            path: pathname,
            query: mergedQuery,
            body,
            headers: event.headers || {},
            ip: event.requestContext?.identity?.sourceIp || 'unknown',
            params: event.pathParameters || {},
            requestId: context.awsRequestId,
            cookies: this.parseCookies(event.headers?.cookie || ''),
            files: {},
        };
        return this.enhanceRequest(baseRequest);
    }
    async adaptResponse(moroResponse) {
        const runtimeResponse = moroResponse;
        let body = runtimeResponse.body;
        const status = runtimeResponse.statusCode || 200;
        const headers = runtimeResponse.headers || {};
        // Convert body to string
        if (typeof body === 'object' && body !== null) {
            body = JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
        }
        else if (body === null || body === undefined) {
            body = '';
        }
        else {
            body = String(body);
        }
        return {
            statusCode: status,
            headers,
            body,
            isBase64Encoded: false,
        };
    }
    createServer(handler) {
        // Return a Lambda-compatible handler function
        return async (event, context) => {
            try {
                const moroReq = await this.adaptRequest(event, context);
                const moroRes = this.createMockResponse();
                await handler(moroReq, moroRes);
                return await this.adaptResponse(moroRes);
            }
            catch (error) {
                return {
                    statusCode: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        success: false,
                        error: 'Internal server error',
                        message: error instanceof Error ? error.message : 'Unknown error',
                    }),
                };
            }
        };
    }
    // Lambda doesn't have a listen method - it's event-driven
    // listen method is optional in the interface
    parseCookies(cookieHeader) {
        const cookies = {};
        if (cookieHeader) {
            cookieHeader.split(';').forEach(cookie => {
                const [name, ...rest] = cookie.trim().split('=');
                if (name && rest.length > 0) {
                    cookies[name] = rest.join('=');
                }
            });
        }
        return cookies;
    }
}
exports.AWSLambdaAdapter = AWSLambdaAdapter;
