"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.performanceMonitor = void 0;
// Performance monitoring middleware
const logger_1 = require("../../logger");
const logger = (0, logger_1.createFrameworkLogger)("PerformanceMonitor");
const performanceMonitor = async (context) => {
    const startTime = Date.now();
    context.onComplete = () => {
        const duration = Date.now() - startTime;
        // Log slow requests
        if (duration > 1000) {
            logger.warn(`Slow request detected: ${context.request?.path} took ${duration}ms`, "SlowRequest", {
                path: context.request?.path,
                method: context.request?.method,
                duration,
            });
        }
    };
};
exports.performanceMonitor = performanceMonitor;
