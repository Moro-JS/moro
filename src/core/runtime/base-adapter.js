"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseRuntimeAdapter = void 0;
const crypto_1 = require("crypto");
class BaseRuntimeAdapter {
    // Generate UUID without external dependency
    generateUUID() {
        return (0, crypto_1.randomBytes)(16)
            .toString("hex")
            .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
    }
    // Common request enhancement
    enhanceRequest(baseRequest) {
        const request = baseRequest;
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
    createMockResponse() {
        const response = {
            statusCode: 200,
            headers: {},
            body: null,
            headersSent: false,
            status: function (code) {
                this.statusCode = code;
                return this;
            },
            json: function (data) {
                this.headers["Content-Type"] = "application/json";
                this.body = JSON.stringify(data);
                this.headersSent = true;
            },
            send: function (data) {
                this.body = data;
                this.headersSent = true;
            },
            cookie: function (name, value, options) {
                // Simple cookie implementation
                const cookieString = `${name}=${value}`;
                this.headers["Set-Cookie"] = cookieString;
                return this;
            },
            clearCookie: function (name, options) {
                this.headers["Set-Cookie"] =
                    `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
                return this;
            },
            redirect: function (url, status) {
                this.statusCode = status || 302;
                this.headers["Location"] = url;
                this.headersSent = true;
            },
            sendFile: async function (filePath) {
                throw new Error("sendFile not implemented in this runtime");
            },
        };
        return response;
    }
    // Parse URL and query parameters
    parseUrl(url) {
        try {
            const urlObj = new URL(url, "http://localhost");
            const query = {};
            urlObj.searchParams.forEach((value, key) => {
                query[key] = value;
            });
            return {
                pathname: urlObj.pathname,
                query,
            };
        }
        catch {
            return {
                pathname: url,
                query: {},
            };
        }
    }
    // Parse body based on content type
    async parseBody(body, contentType) {
        if (!body)
            return undefined;
        if (typeof body === "string") {
            if (contentType?.includes("application/json")) {
                try {
                    return JSON.parse(body);
                }
                catch {
                    return body;
                }
            }
            return body;
        }
        return body;
    }
}
exports.BaseRuntimeAdapter = BaseRuntimeAdapter;
