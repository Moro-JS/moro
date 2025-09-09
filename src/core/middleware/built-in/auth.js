"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = void 0;
const logger_1 = require("../../logger");
const logger = (0, logger_1.createFrameworkLogger)("AuthMiddleware");
const auth = (options = {}) => ({
    name: "auth",
    version: "1.0.0",
    metadata: {
        name: "auth",
        version: "1.0.0",
        description: "JWT authentication middleware with token validation",
        author: "MoroJS Team",
    },
    install: async (hooks, options = {}) => {
        logger.debug(`Installing auth middleware with options`, "Installation", {
            options,
        });
        hooks.before("request", async (context) => {
            const req = context.request;
            const token = req.headers?.authorization?.replace("Bearer ", "");
            if (token) {
                try {
                    // Simple token validation (in production, use proper JWT verification)
                    if (token.startsWith("valid_")) {
                        req.user = { id: 1, role: "user" };
                        logger.debug(`Auth: Verified token for request`, "TokenValidation");
                    }
                }
                catch (error) {
                    throw new Error("Invalid token");
                }
            }
        });
    },
});
exports.auth = auth;
