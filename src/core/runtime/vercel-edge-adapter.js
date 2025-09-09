"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VercelEdgeAdapter = void 0;
// Vercel Edge runtime adapter
const base_adapter_1 = require("./base-adapter");
class VercelEdgeAdapter extends base_adapter_1.BaseRuntimeAdapter {
    type = "vercel-edge";
    async adaptRequest(request) {
        const url = new URL(request.url);
        const { pathname, query } = this.parseUrl(request.url);
        // Parse body for POST/PUT/PATCH requests
        let body;
        if (["POST", "PUT", "PATCH"].includes(request.method)) {
            const contentType = request.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
                try {
                    body = await request.json();
                }
                catch {
                    body = await request.text();
                }
            }
            else {
                body = await request.text();
            }
        }
        // Convert Headers to plain object
        const headers = {};
        request.headers.forEach((value, key) => {
            headers[key] = value;
        });
        const baseRequest = {
            method: request.method,
            url: request.url,
            path: pathname,
            query,
            body,
            headers,
            ip: this.getClientIP(headers),
            params: {},
            requestId: "",
            cookies: {},
            files: {},
        };
        return this.enhanceRequest(baseRequest);
    }
    async adaptResponse(moroResponse) {
        const runtimeResponse = moroResponse;
        // Handle different response states
        let body = runtimeResponse.body;
        let status = runtimeResponse.statusCode || 200;
        const headers = runtimeResponse.headers || {};
        // If it's a real HttpResponse, we need to extract the data differently
        if ("statusCode" in moroResponse &&
            typeof moroResponse.statusCode === "number") {
            status = moroResponse.statusCode;
        }
        // Convert headers to Headers object
        const responseHeaders = new Headers();
        Object.entries(headers).forEach(([key, value]) => {
            responseHeaders.set(key, value);
        });
        // Handle different body types
        if (typeof body === "object" && body !== null) {
            body = JSON.stringify(body);
            responseHeaders.set("Content-Type", "application/json");
        }
        return new Response(body, {
            status,
            headers: responseHeaders,
        });
    }
    createServer(handler) {
        // Return a Vercel Edge-compatible handler function
        return async (request) => {
            try {
                const moroReq = await this.adaptRequest(request);
                const moroRes = this.createMockResponse();
                await handler(moroReq, moroRes);
                return await this.adaptResponse(moroRes);
            }
            catch (error) {
                return new Response(JSON.stringify({
                    success: false,
                    error: "Internal server error",
                    message: error instanceof Error ? error.message : "Unknown error",
                }), {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                });
            }
        };
    }
    // Vercel Edge doesn't have a listen method - it's handled by the platform
    // listen method is optional in the interface
    getClientIP(headers) {
        return (headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
            headers["x-real-ip"] ||
            "unknown");
    }
}
exports.VercelEdgeAdapter = VercelEdgeAdapter;
