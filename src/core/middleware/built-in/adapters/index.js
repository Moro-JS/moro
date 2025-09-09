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
exports.createCDNAdapter = exports.createCacheAdapter = void 0;
// Adapters Index
__exportStar(require("./cache"), exports);
__exportStar(require("./cdn"), exports);
// Re-export factory functions for convenience
var cache_1 = require("./cache");
Object.defineProperty(exports, "createCacheAdapter", { enumerable: true, get: function () { return cache_1.createCacheAdapter; } });
var cdn_1 = require("./cdn");
Object.defineProperty(exports, "createCDNAdapter", { enumerable: true, get: function () { return cdn_1.createCDNAdapter; } });
