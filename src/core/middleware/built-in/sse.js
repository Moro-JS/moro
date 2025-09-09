"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sse = void 0;
const logger_1 = require("../../logger");
const logger = (0, logger_1.createFrameworkLogger)("SSEMiddleware");
const sse = (options = {}) => ({
    name: "sse",
    version: "1.0.0",
    metadata: {
        name: "sse",
        version: "1.0.0",
        description: "Server-Sent Events middleware with heartbeat and retry support",
        author: "MoroJS Team",
    },
    install: async (hooks, middlewareOptions = {}) => {
        logger.debug("Installing SSE middleware", "Installation");
        hooks.before("request", async (context) => {
            const req = context.request;
            const res = context.response;
            // Only handle SSE requests
            if (!req.headers.accept?.includes("text/event-stream")) {
                return;
            }
            logger.debug("Setting up SSE connection", "SSESetup");
            // Set SSE headers
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": options.cors ? "*" : undefined,
                "Access-Control-Allow-Headers": options.cors
                    ? "Cache-Control"
                    : undefined,
            });
            // Add SSE methods to response
            res.sendEvent = (data, event, id) => {
                if (id)
                    res.write(`id: ${id}\n`);
                if (event)
                    res.write(`event: ${event}\n`);
                res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
            };
            res.sendComment = (comment) => {
                res.write(`: ${comment}\n\n`);
            };
            res.sendRetry = (ms) => {
                res.write(`retry: ${ms}\n\n`);
            };
            // Set up heartbeat if configured
            let heartbeatInterval = null;
            if (options.heartbeat) {
                heartbeatInterval = setInterval(() => {
                    res.sendComment("heartbeat");
                }, options.heartbeat);
            }
            // Set retry if configured
            if (options.retry) {
                res.sendRetry(options.retry);
            }
            // Clean up on close
            req.on("close", () => {
                if (heartbeatInterval) {
                    clearInterval(heartbeatInterval);
                }
                logger.debug("SSE connection closed", "SSECleanup");
            });
            // Mark that this middleware handled the request
            context.handled = true;
        });
    },
});
exports.sse = sse;
