"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimit = void 0;
const logger_1 = require("../../logger");
const logger = (0, logger_1.createFrameworkLogger)('RateLimitMiddleware');
const rateLimit = (options = {}) => ({
    name: 'rate-limit',
    version: '1.0.0',
    metadata: {
        name: 'rate-limit',
        version: '1.0.0',
        description: 'Rate limiting middleware with configurable windows',
        author: 'MoroJS Team',
    },
    install: async (hooks, options = {}) => {
        logger.debug('Installing rate limit middleware', 'Installation', {
            options,
        });
        const windowMs = options.windowMs || 60000; // 1 minute default
        const max = options.max || 100; // 100 requests per window
        const clientCounts = new Map();
        hooks.before('request', async (context) => {
            const req = context.request;
            const clientId = req.connection?.remoteAddress || 'unknown';
            const now = Date.now();
            if (!clientCounts.has(clientId)) {
                clientCounts.set(clientId, { count: 0, resetTime: now + windowMs });
            }
            const client = clientCounts.get(clientId);
            if (now > client.resetTime) {
                client.count = 0;
                client.resetTime = now + windowMs;
            }
            client.count++;
            if (client.count > max) {
                logger.warn(`Rate limit exceeded for ${clientId}`, 'RateLimit', {
                    clientId,
                    count: client.count,
                    max,
                });
                throw new Error(options.message || 'Too many requests');
            }
        });
    },
});
exports.rateLimit = rateLimit;
