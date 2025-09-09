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
exports.applyLoggingConfiguration = exports.configureGlobalLogger = exports.createFrameworkLogger = exports.logger = exports.MoroLogger = void 0;
// Logger System - Main Exports
var logger_1 = require("./logger");
Object.defineProperty(exports, "MoroLogger", { enumerable: true, get: function () { return logger_1.MoroLogger; } });
Object.defineProperty(exports, "logger", { enumerable: true, get: function () { return logger_1.logger; } });
Object.defineProperty(exports, "createFrameworkLogger", { enumerable: true, get: function () { return logger_1.createFrameworkLogger; } });
Object.defineProperty(exports, "configureGlobalLogger", { enumerable: true, get: function () { return logger_1.configureGlobalLogger; } });
Object.defineProperty(exports, "applyLoggingConfiguration", { enumerable: true, get: function () { return logger_1.applyLoggingConfiguration; } });
__exportStar(require("./filters"), exports);
