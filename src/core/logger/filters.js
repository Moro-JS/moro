"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.moduleFilter = exports.environmentFilter = exports.errorAggregationFilter = exports.performanceFilter = exports.sanitizeFilter = exports.rateLimitFilter = exports.contextFilter = exports.levelFilter = void 0;
// Level-based filter
const levelFilter = (minLevel) => ({
    name: `level-${minLevel}`,
    filter: (entry) => {
        const levels = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
        return levels[entry.level] >= levels[minLevel];
    },
});
exports.levelFilter = levelFilter;
// Context-based filter
const contextFilter = (allowedContexts) => ({
    name: 'context-filter',
    filter: (entry) => {
        if (!entry.context)
            return true;
        return allowedContexts.some(ctx => entry.context.includes(ctx));
    },
});
exports.contextFilter = contextFilter;
// Rate limiting filter
const rateLimitFilter = (maxPerSecond) => {
    const timestamps = [];
    return {
        name: 'rate-limit',
        filter: (entry) => {
            const now = Date.now();
            const oneSecondAgo = now - 1000;
            // Remove old timestamps
            while (timestamps.length > 0 && timestamps[0] < oneSecondAgo) {
                timestamps.shift();
            }
            // Check rate limit
            if (timestamps.length >= maxPerSecond) {
                return false;
            }
            timestamps.push(now);
            return true;
        },
    };
};
exports.rateLimitFilter = rateLimitFilter;
// Sensitive data filter
const sanitizeFilter = (sensitiveKeys = ['password', 'token', 'key', 'secret']) => ({
    name: 'sanitize',
    filter: (entry) => {
        if (entry.metadata) {
            const sanitized = { ...entry.metadata };
            for (const key of sensitiveKeys) {
                if (sanitized[key]) {
                    sanitized[key] = '[REDACTED]';
                }
            }
            entry.metadata = sanitized;
        }
        // Also sanitize message content
        let sanitizedMessage = entry.message;
        for (const key of sensitiveKeys) {
            const regex = new RegExp(`(${key}["\\s]*[:=]["\\s]*)([^"\\s]+)`, 'gi');
            sanitizedMessage = sanitizedMessage.replace(regex, '$1[REDACTED]');
        }
        entry.message = sanitizedMessage;
        return true;
    },
});
exports.sanitizeFilter = sanitizeFilter;
// Performance filter - only log slow operations
const performanceFilter = (minDuration) => ({
    name: 'performance',
    filter: (entry) => {
        if (!entry.performance?.duration)
            return true;
        return entry.performance.duration >= minDuration;
    },
});
exports.performanceFilter = performanceFilter;
// Error aggregation filter - prevent spam
const errorAggregationFilter = (maxSameErrors = 5, timeWindow = 60000) => {
    const errorCounts = new Map();
    return {
        name: 'error-aggregation',
        filter: (entry) => {
            if (entry.level !== 'error' && entry.level !== 'fatal')
                return true;
            const errorKey = `${entry.message}:${entry.context || ''}`;
            const now = Date.now();
            const existing = errorCounts.get(errorKey);
            if (!existing) {
                errorCounts.set(errorKey, { count: 1, firstSeen: now });
                return true;
            }
            // Reset if outside time window
            if (now - existing.firstSeen > timeWindow) {
                errorCounts.set(errorKey, { count: 1, firstSeen: now });
                return true;
            }
            // Check if we've exceeded the limit
            if (existing.count >= maxSameErrors) {
                return false;
            }
            existing.count++;
            return true;
        },
    };
};
exports.errorAggregationFilter = errorAggregationFilter;
// Development vs Production filter
const environmentFilter = (environment) => ({
    name: `env-${environment}`,
    filter: (entry) => {
        if (environment === 'production') {
            // In production, filter out debug logs and sensitive development info
            if (entry.level === 'debug')
                return false;
            if (entry.context?.includes('dev') || entry.context?.includes('test'))
                return false;
        }
        return true;
    },
});
exports.environmentFilter = environmentFilter;
// Module-specific filter
const moduleFilter = (allowedModules) => ({
    name: 'module-filter',
    filter: (entry) => {
        if (!entry.moduleId)
            return true;
        return allowedModules.includes(entry.moduleId);
    },
});
exports.moduleFilter = moduleFilter;
