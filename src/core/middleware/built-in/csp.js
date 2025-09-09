"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.csp = void 0;
const logger_1 = require("../../logger");
const logger = (0, logger_1.createFrameworkLogger)("CSPMiddleware");
const csp = (options = {}) => ({
    name: "csp",
    version: "1.0.0",
    metadata: {
        name: "csp",
        version: "1.0.0",
        description: "Content Security Policy middleware with nonce support and violation reporting",
        author: "MoroJS Team",
    },
    install: async (hooks, middlewareOptions = {}) => {
        logger.debug("Installing CSP middleware", "Installation");
        hooks.before("request", async (context) => {
            const req = context.request;
            const res = context.response;
            const directives = options.directives || {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:", "https:"],
                connectSrc: ["'self'"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'"],
                frameSrc: ["'none'"],
            };
            // Generate nonce if requested
            let nonce;
            if (options.nonce) {
                const crypto = require("crypto");
                nonce = crypto.randomBytes(16).toString("base64");
                req.cspNonce = nonce;
            }
            // Build CSP header value
            const cspParts = [];
            for (const [directive, sources] of Object.entries(directives)) {
                if (directive === "upgradeInsecureRequests" && sources === true) {
                    cspParts.push("upgrade-insecure-requests");
                }
                else if (directive === "blockAllMixedContent" && sources === true) {
                    cspParts.push("block-all-mixed-content");
                }
                else if (Array.isArray(sources)) {
                    let sourceList = sources.join(" ");
                    // Add nonce to script-src and style-src if enabled
                    if (nonce &&
                        (directive === "scriptSrc" || directive === "styleSrc")) {
                        sourceList += ` 'nonce-${nonce}'`;
                    }
                    // Convert camelCase to kebab-case
                    const kebabDirective = directive
                        .replace(/([A-Z])/g, "-$1")
                        .toLowerCase();
                    cspParts.push(`${kebabDirective} ${sourceList}`);
                }
            }
            // Add report-uri if specified
            if (options.reportUri) {
                cspParts.push(`report-uri ${options.reportUri}`);
            }
            const cspValue = cspParts.join("; ");
            const headerName = options.reportOnly
                ? "Content-Security-Policy-Report-Only"
                : "Content-Security-Policy";
            res.setHeader(headerName, cspValue);
        });
    },
});
exports.csp = csp;
