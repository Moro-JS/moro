"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudflareWorkersAdapter = void 0;
// Cloudflare Workers runtime adapter
const base_adapter_1 = require("./base-adapter");
class CloudflareWorkersAdapter extends base_adapter_1.BaseRuntimeAdapter {
    type = "cloudflare-workers";
    async adaptRequest(request, env, ctx) {
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
            else if (contentType.includes("application/x-www-form-urlencoded")) {
                body = await request.formData();
                // Convert FormData to object
                const formObject = {};
                body.forEach((value, key) => {
                    formObject[key] = value;
                });
                body = formObject;
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
            ip: this.getClientIP(headers, request),
            params: {},
            requestId: "",
            cookies: this.parseCookies(headers.cookie || ""),
            files: {},
            // Add Workers-specific context
            env,
            ctx,
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
        // Return a Cloudflare Workers-compatible handler function
        return async (request, env, ctx) => {
            try {
                const moroReq = await this.adaptRequest(request, env, ctx);
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
    // Cloudflare Workers doesn't have a listen method - it's handled by the platform
    // listen method is optional in the interface
    getClientIP(headers, request) {
        // Cloudflare provides the real IP in CF-Connecting-IP header
        return (headers["cf-connecting-ip"] ||
            headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
            headers["x-real-ip"] ||
            "unknown");
    }
    parseCookies(cookieHeader) {
        const cookies = {};
        if (cookieHeader) {
            cookieHeader.split(";").forEach((cookie) => {
                const [name, ...rest] = cookie.trim().split("=");
                if (name && rest.length > 0) {
                    cookies[name] = rest.join("=");
                }
            });
        }
        return cookies;
    }
}
exports.CloudflareWorkersAdapter = CloudflareWorkersAdapter;
