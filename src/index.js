"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEnvVar = exports.createModuleConfig = exports.getConfig = exports.RouteRegistry = exports.IntelligentRoutingManager = exports.EXECUTION_PHASES = exports.defineRoute = exports.createRoute = exports.defineModule = exports.z = exports.combineSchemas = exports.params = exports.query = exports.body = exports.validate = exports.logger = exports.createFrameworkLogger = exports.middleware = exports.HOOK_EVENTS = exports.HookManager = exports.CircuitBreaker = exports.withTimeout = exports.withRetry = exports.withCaching = exports.withLogging = exports.ServiceLifecycle = exports.ServiceScope = exports.FunctionalContainer = exports.Container = exports.WebSocketManager = exports.simpleMiddleware = exports.builtInMiddleware = exports.httpMiddleware = exports.MoroHttpServer = exports.createWorkerHandler = exports.createLambdaHandler = exports.createEdgeHandler = exports.createNodeHandler = exports.createRuntimeAdapter = exports.CloudflareWorkersAdapter = exports.AWSLambdaAdapter = exports.VercelEdgeAdapter = exports.NodeRuntimeAdapter = exports.createAppWorker = exports.createAppLambda = exports.createAppEdge = exports.createAppNode = exports.createApp = exports.MoroCore = exports.Moro = void 0;
exports.getConfigValue = exports.envVar = exports.requireEnvVars = exports.isStaging = exports.isProduction = exports.isDevelopment = exports.getEnvJson = exports.getEnvArray = void 0;
// MoroJS Framework - Main Entry Point
var moro_1 = require("./moro");
Object.defineProperty(exports, "Moro", { enumerable: true, get: function () { return moro_1.Moro; } });
Object.defineProperty(exports, "MoroCore", { enumerable: true, get: function () { return moro_1.Moro; } });
Object.defineProperty(exports, "createApp", { enumerable: true, get: function () { return moro_1.createApp; } });
Object.defineProperty(exports, "createAppNode", { enumerable: true, get: function () { return moro_1.createAppNode; } });
Object.defineProperty(exports, "createAppEdge", { enumerable: true, get: function () { return moro_1.createAppEdge; } });
Object.defineProperty(exports, "createAppLambda", { enumerable: true, get: function () { return moro_1.createAppLambda; } });
Object.defineProperty(exports, "createAppWorker", { enumerable: true, get: function () { return moro_1.createAppWorker; } });
var runtime_1 = require("./core/runtime");
Object.defineProperty(exports, "NodeRuntimeAdapter", { enumerable: true, get: function () { return runtime_1.NodeRuntimeAdapter; } });
Object.defineProperty(exports, "VercelEdgeAdapter", { enumerable: true, get: function () { return runtime_1.VercelEdgeAdapter; } });
Object.defineProperty(exports, "AWSLambdaAdapter", { enumerable: true, get: function () { return runtime_1.AWSLambdaAdapter; } });
Object.defineProperty(exports, "CloudflareWorkersAdapter", { enumerable: true, get: function () { return runtime_1.CloudflareWorkersAdapter; } });
Object.defineProperty(exports, "createRuntimeAdapter", { enumerable: true, get: function () { return runtime_1.createRuntimeAdapter; } });
Object.defineProperty(exports, "createNodeHandler", { enumerable: true, get: function () { return runtime_1.createNodeHandler; } });
Object.defineProperty(exports, "createEdgeHandler", { enumerable: true, get: function () { return runtime_1.createEdgeHandler; } });
Object.defineProperty(exports, "createLambdaHandler", { enumerable: true, get: function () { return runtime_1.createLambdaHandler; } });
Object.defineProperty(exports, "createWorkerHandler", { enumerable: true, get: function () { return runtime_1.createWorkerHandler; } });
// Core exports
var http_1 = require("./core/http");
Object.defineProperty(exports, "MoroHttpServer", { enumerable: true, get: function () { return http_1.MoroHttpServer; } });
Object.defineProperty(exports, "httpMiddleware", { enumerable: true, get: function () { return http_1.middleware; } });
var built_in_1 = require("./core/middleware/built-in");
Object.defineProperty(exports, "builtInMiddleware", { enumerable: true, get: function () { return built_in_1.builtInMiddleware; } });
Object.defineProperty(exports, "simpleMiddleware", { enumerable: true, get: function () { return built_in_1.simpleMiddleware; } });
var networking_1 = require("./core/networking");
Object.defineProperty(exports, "WebSocketManager", { enumerable: true, get: function () { return networking_1.WebSocketManager; } });
var utilities_1 = require("./core/utilities");
Object.defineProperty(exports, "Container", { enumerable: true, get: function () { return utilities_1.Container; } });
Object.defineProperty(exports, "FunctionalContainer", { enumerable: true, get: function () { return utilities_1.FunctionalContainer; } });
Object.defineProperty(exports, "ServiceScope", { enumerable: true, get: function () { return utilities_1.ServiceScope; } });
Object.defineProperty(exports, "ServiceLifecycle", { enumerable: true, get: function () { return utilities_1.ServiceLifecycle; } });
Object.defineProperty(exports, "withLogging", { enumerable: true, get: function () { return utilities_1.withLogging; } });
Object.defineProperty(exports, "withCaching", { enumerable: true, get: function () { return utilities_1.withCaching; } });
Object.defineProperty(exports, "withRetry", { enumerable: true, get: function () { return utilities_1.withRetry; } });
Object.defineProperty(exports, "withTimeout", { enumerable: true, get: function () { return utilities_1.withTimeout; } });
Object.defineProperty(exports, "CircuitBreaker", { enumerable: true, get: function () { return utilities_1.CircuitBreaker; } });
Object.defineProperty(exports, "HookManager", { enumerable: true, get: function () { return utilities_1.HookManager; } });
Object.defineProperty(exports, "HOOK_EVENTS", { enumerable: true, get: function () { return utilities_1.HOOK_EVENTS; } });
Object.defineProperty(exports, "middleware", { enumerable: true, get: function () { return utilities_1.middleware; } });
var logger_1 = require("./core/logger");
Object.defineProperty(exports, "createFrameworkLogger", { enumerable: true, get: function () { return logger_1.createFrameworkLogger; } });
Object.defineProperty(exports, "logger", { enumerable: true, get: function () { return logger_1.logger; } });
// Validation System (Zod-based)
var validation_1 = require("./core/validation");
Object.defineProperty(exports, "validate", { enumerable: true, get: function () { return validation_1.validate; } });
Object.defineProperty(exports, "body", { enumerable: true, get: function () { return validation_1.body; } });
Object.defineProperty(exports, "query", { enumerable: true, get: function () { return validation_1.query; } });
Object.defineProperty(exports, "params", { enumerable: true, get: function () { return validation_1.params; } });
Object.defineProperty(exports, "combineSchemas", { enumerable: true, get: function () { return validation_1.combineSchemas; } });
Object.defineProperty(exports, "z", { enumerable: true, get: function () { return validation_1.z; } });
// Module System
var modules_1 = require("./core/modules");
Object.defineProperty(exports, "defineModule", { enumerable: true, get: function () { return modules_1.defineModule; } });
// Intelligent Routing System
var routing_1 = require("./core/routing");
Object.defineProperty(exports, "createRoute", { enumerable: true, get: function () { return routing_1.createRoute; } });
Object.defineProperty(exports, "defineRoute", { enumerable: true, get: function () { return routing_1.defineRoute; } });
Object.defineProperty(exports, "EXECUTION_PHASES", { enumerable: true, get: function () { return routing_1.EXECUTION_PHASES; } });
var app_integration_1 = require("./core/routing/app-integration");
Object.defineProperty(exports, "IntelligentRoutingManager", { enumerable: true, get: function () { return app_integration_1.IntelligentRoutingManager; } });
Object.defineProperty(exports, "RouteRegistry", { enumerable: true, get: function () { return app_integration_1.RouteRegistry; } });
// Configuration utilities
var utils_1 = require("./core/config/utils");
Object.defineProperty(exports, "getConfig", { enumerable: true, get: function () { return utils_1.getConfig; } });
Object.defineProperty(exports, "createModuleConfig", { enumerable: true, get: function () { return utils_1.createModuleConfig; } });
Object.defineProperty(exports, "getEnvVar", { enumerable: true, get: function () { return utils_1.getEnvVar; } });
Object.defineProperty(exports, "getEnvArray", { enumerable: true, get: function () { return utils_1.getEnvArray; } });
Object.defineProperty(exports, "getEnvJson", { enumerable: true, get: function () { return utils_1.getEnvJson; } });
Object.defineProperty(exports, "isDevelopment", { enumerable: true, get: function () { return utils_1.isDevelopment; } });
Object.defineProperty(exports, "isProduction", { enumerable: true, get: function () { return utils_1.isProduction; } });
Object.defineProperty(exports, "isStaging", { enumerable: true, get: function () { return utils_1.isStaging; } });
Object.defineProperty(exports, "requireEnvVars", { enumerable: true, get: function () { return utils_1.requireEnvVars; } });
Object.defineProperty(exports, "envVar", { enumerable: true, get: function () { return utils_1.envVar; } });
Object.defineProperty(exports, "getConfigValue", { enumerable: true, get: function () { return utils_1.getConfigValue; } });
// Adapters
__exportStar(require("./core/middleware/built-in/adapters"), exports);
__exportStar(require("./core/database/adapters"), exports);
