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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileCacheAdapter = void 0;
const logger_1 = require("../../../../logger");
const logger = (0, logger_1.createFrameworkLogger)('FileCacheAdapter');
class FileCacheAdapter {
    cacheDir;
    constructor(options = {}) {
        this.cacheDir = options.cacheDir || './cache';
        this.ensureCacheDir();
    }
    async ensureCacheDir() {
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        try {
            await fs.mkdir(this.cacheDir, { recursive: true });
        }
        catch (error) {
            logger.error('Failed to create cache directory', 'FileCache', { error });
        }
    }
    getFilePath(key) {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(key).digest('hex');
        return `${this.cacheDir}/${hash}.json`;
    }
    async get(key) {
        try {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const filePath = this.getFilePath(key);
            const data = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(data);
            if (Date.now() > parsed.expires) {
                await this.del(key);
                return null;
            }
            return parsed.value;
        }
        catch (error) {
            return null;
        }
    }
    async set(key, value, ttl = 3600) {
        try {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const filePath = this.getFilePath(key);
            const expires = Date.now() + ttl * 1000;
            const data = JSON.stringify({ value, expires });
            await fs.writeFile(filePath, data);
            logger.debug(`Cached item to file: ${key} (TTL: ${ttl}s)`, 'FileCache');
        }
        catch (error) {
            logger.error('File cache set error', 'FileCache', { key, error });
        }
    }
    async del(key) {
        try {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const filePath = this.getFilePath(key);
            await fs.unlink(filePath);
            logger.debug(`Deleted file cache item: ${key}`, 'FileCache');
        }
        catch (error) {
            // File might not exist, which is okay
        }
    }
    async clear() {
        try {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const files = await fs.readdir(this.cacheDir);
            await Promise.all(files.map(file => fs.unlink(`${this.cacheDir}/${file}`)));
            logger.debug('Cleared all file cache items', 'FileCache');
        }
        catch (error) {
            logger.error('File cache clear error', 'FileCache', { error });
        }
    }
    async exists(key) {
        const value = await this.get(key);
        return value !== null;
    }
    async ttl(key) {
        try {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const filePath = this.getFilePath(key);
            const data = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(data);
            const remaining = Math.floor((parsed.expires - Date.now()) / 1000);
            return remaining > 0 ? remaining : -1;
        }
        catch (error) {
            return -1;
        }
    }
}
exports.FileCacheAdapter = FileCacheAdapter;
