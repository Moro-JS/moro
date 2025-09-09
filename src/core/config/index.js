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
exports.z = void 0;
exports.initializeConfig = initializeConfig;
exports.getGlobalConfig = getGlobalConfig;
exports.isConfigInitialized = isConfigInitialized;
// Configuration System - Main Exports and Utilities
__exportStar(require("./schema"), exports);
__exportStar(require("./loader"), exports);
__exportStar(require("./utils"), exports);
// Re-export common Zod utilities for configuration
var zod_1 = require("zod");
Object.defineProperty(exports, "z", { enumerable: true, get: function () { return zod_1.z; } });
// Main configuration loading function
const loader_1 = require("./loader");
// Global configuration instance
let globalConfig = null;
/**
 * Initialize and load the global application configuration
 * This should be called once at application startup
 */
function initializeConfig() {
    if (globalConfig) {
        return globalConfig;
    }
    globalConfig = (0, loader_1.loadConfig)();
    return globalConfig;
}
/**
 * Get the current global configuration
 * Throws if configuration hasn't been initialized
 */
function getGlobalConfig() {
    if (!globalConfig) {
        throw new Error("Configuration not initialized. Call initializeConfig() first.");
    }
    return globalConfig;
}
/**
 * Check if configuration has been initialized
 */
function isConfigInitialized() {
    return globalConfig !== null;
}
