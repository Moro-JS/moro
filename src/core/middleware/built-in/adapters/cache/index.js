"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileCacheAdapter = exports.RedisCacheAdapter = exports.MemoryCacheAdapter = void 0;
exports.createCacheAdapter = createCacheAdapter;
// Cache Adapters
var memory_1 = require("./memory");
Object.defineProperty(exports, "MemoryCacheAdapter", { enumerable: true, get: function () { return memory_1.MemoryCacheAdapter; } });
var redis_1 = require("./redis");
Object.defineProperty(exports, "RedisCacheAdapter", { enumerable: true, get: function () { return redis_1.RedisCacheAdapter; } });
var file_1 = require("./file");
Object.defineProperty(exports, "FileCacheAdapter", { enumerable: true, get: function () { return file_1.FileCacheAdapter; } });
const memory_2 = require("./memory");
const redis_2 = require("./redis");
const file_2 = require("./file");
// Adapter factory function for auto-loading
function createCacheAdapter(type, options = {}) {
    switch (type.toLowerCase()) {
        case "memory":
            return new memory_2.MemoryCacheAdapter();
        case "redis":
            return new redis_2.RedisCacheAdapter(options);
        case "file":
            return new file_2.FileCacheAdapter(options);
        default:
            throw new Error(`Unknown cache adapter type: ${type}`);
    }
}
