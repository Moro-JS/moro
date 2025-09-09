"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorTracker = void 0;
// Error tracking middleware
const logger_1 = require("../../logger");
const logger = (0, logger_1.createFrameworkLogger)("ErrorTracker");
const errorTracker = async (context) => {
    context.onError = (error) => {
        logger.error("Request error", "ErrorTracking", {
            error: error.message,
            stack: error.stack,
            url: context.request?.url,
            method: context.request?.method,
            timestamp: new Date().toISOString(),
        });
    };
};
exports.errorTracker = errorTracker;
