"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = void 0;
// Simple request logging middleware
const requestLogger = async (context) => {
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] ${context.request?.method} ${context.request?.path}`);
    // Log completion after response
    context.onComplete = () => {
        const duration = Date.now() - startTime;
        console.log(`Request completed in ${duration}ms`);
    };
};
exports.requestLogger = requestLogger;
