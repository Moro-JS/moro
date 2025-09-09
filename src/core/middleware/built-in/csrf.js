"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.csrf = void 0;
const logger_1 = require("../../logger");
const logger = (0, logger_1.createFrameworkLogger)("CSRFMiddleware");
const csrf = (options = {}) => ({
    name: "csrf",
    version: "1.0.0",
    metadata: {
        name: "csrf",
        version: "1.0.0",
        description: "CSRF protection middleware with token generation and validation",
        author: "MoroJS Team",
    },
    install: async (hooks, middlewareOptions = {}) => {
        logger.debug("Installing CSRF middleware", "Installation");
        const secret = options.secret || "moro-csrf-secret";
        const tokenLength = options.tokenLength || 32;
        const cookieName = options.cookieName || "_csrf";
        const headerName = options.headerName || "x-csrf-token";
        const ignoreMethods = options.ignoreMethods || ["GET", "HEAD", "OPTIONS"];
        const generateToken = () => {
            const crypto = require("crypto");
            return crypto.randomBytes(tokenLength).toString("hex");
        };
        const verifyToken = (token, sessionToken) => {
            return token && sessionToken && token === sessionToken;
        };
        hooks.before("request", async (context) => {
            const req = context.request;
            const res = context.response;
            // Add CSRF token generation method
            req.csrfToken = () => {
                if (!req._csrfToken) {
                    req._csrfToken = generateToken();
                    // Set token in cookie
                    res.cookie(cookieName, req._csrfToken, {
                        httpOnly: true,
                        sameSite: options.sameSite !== false ? "strict" : undefined,
                        secure: req.headers["x-forwarded-proto"] === "https" ||
                            req.socket.encrypted,
                    });
                }
                return req._csrfToken;
            };
            // Skip verification for safe methods
            if (ignoreMethods.includes(req.method)) {
                return;
            }
            // Get token from header or body
            const token = req.headers[headerName] ||
                (req.body && req.body._csrf) ||
                (req.query && req.query._csrf);
            // Get session token from cookie
            const sessionToken = req.cookies?.[cookieName];
            if (!verifyToken(token, sessionToken || "")) {
                const error = new Error("Invalid CSRF token");
                error.status = 403;
                error.code = "CSRF_TOKEN_MISMATCH";
                throw error;
            }
        });
    },
});
exports.csrf = csrf;
