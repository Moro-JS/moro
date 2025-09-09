"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cors = void 0;
const logger_1 = require("../../logger");
const logger = (0, logger_1.createFrameworkLogger)("CorsMiddleware");
const cors = (options = {}) => ({
    name: "cors",
    version: "1.0.0",
    metadata: {
        name: "cors",
        version: "1.0.0",
        description: "Cross-Origin Resource Sharing middleware",
        author: "MoroJS Team",
    },
    install: async (hooks, options = {}) => {
        logger.debug("Installing CORS middleware", "Installation", { options });
        hooks.before("request", async (context) => {
            const response = context.response;
            response.setHeader("Access-Control-Allow-Origin", options.origin || "*");
            response.setHeader("Access-Control-Allow-Methods", options.methods || "GET,POST,PUT,DELETE,OPTIONS");
            response.setHeader("Access-Control-Allow-Headers", options.headers || "Content-Type,Authorization");
            if (options.credentials) {
                response.setHeader("Access-Control-Allow-Credentials", "true");
            }
        });
    },
});
exports.cors = cors;
