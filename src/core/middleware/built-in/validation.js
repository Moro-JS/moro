"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validation = void 0;
const logger_1 = require("../../logger");
const logger = (0, logger_1.createFrameworkLogger)("ValidationMiddleware");
const validation = () => ({
    name: "validation",
    version: "1.0.0",
    metadata: {
        name: "validation",
        version: "1.0.0",
        description: "Request validation middleware with content type checking",
        author: "MoroJS Team",
    },
    install: async (hooks, options = {}) => {
        logger.debug("Installing validation middleware", "Installation");
        hooks.before("request", async (context) => {
            const request = context.request;
            // Basic content type validation
            if (request.method === "POST" || request.method === "PUT") {
                const contentType = request.headers["content-type"];
                if (contentType && contentType.includes("application/json")) {
                    logger.debug("Validation: JSON content type verified", "ContentType");
                    // Additional validation logic would go here
                }
            }
        });
    },
});
exports.validation = validation;
