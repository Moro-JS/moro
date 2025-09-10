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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModuleLoader = void 0;
exports.defineModule = defineModule;
// Module System - Definition and Loading
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
// Module Definition Function
function defineModule(definition) {
    const moduleConfig = {
        name: definition.name,
        version: definition.version,
        dependencies: definition.dependencies,
    };
    // Store route definitions and handlers
    if (definition.routes) {
        moduleConfig.routes = definition.routes.map((route, index) => ({
            method: route.method,
            path: route.path,
            handler: `route_handler_${index}`, // Standardized naming
            validation: route.validation,
            cache: route.cache,
            rateLimit: route.rateLimit,
            middleware: route.middleware,
        }));
        // Store the actual route handler functions
        moduleConfig.routeHandlers = definition.routes.reduce((acc, route, index) => {
            acc[`route_handler_${index}`] = route.handler;
            return acc;
        }, {});
    }
    // Store socket definitions and handlers
    if (definition.sockets) {
        moduleConfig.sockets = definition.sockets.map((socket, index) => ({
            event: socket.event,
            handler: `socket_handler_${index}`, // Standardized naming
            validation: socket.validation,
            rateLimit: socket.rateLimit,
            rooms: socket.rooms,
            broadcast: socket.broadcast,
        }));
        // Store the actual socket handler functions
        moduleConfig.socketHandlers = definition.sockets.reduce((acc, socket, index) => {
            acc[`socket_handler_${index}`] = socket.handler;
            return acc;
        }, {});
    }
    // Copy config
    if (definition.config) {
        moduleConfig.config = definition.config;
    }
    return moduleConfig;
}
// Module Loader Class
class ModuleLoader {
    container;
    constructor(container) {
        this.container = container;
    }
    async discoverModules(directory) {
        const modules = [];
        try {
            const moduleDir = path_1.default.resolve(directory);
            const entries = await fs_1.promises.readdir(moduleDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const modulePath = path_1.default.join(moduleDir, entry.name, 'index.ts');
                    try {
                        await fs_1.promises.access(modulePath);
                        const moduleExports = await Promise.resolve(`${modulePath}`).then(s => __importStar(require(s)));
                        // Look for exported module config
                        for (const exportName of Object.keys(moduleExports)) {
                            const exported = moduleExports[exportName];
                            if (exported && typeof exported === 'object' && exported.name && exported.version) {
                                modules.push(exported);
                            }
                        }
                    }
                    catch (error) {
                        console.warn(`⚠️  Could not load module from ${modulePath}:`, error instanceof Error ? error.message : String(error));
                    }
                }
            }
        }
        catch (error) {
            console.error('Failed to discover modules:', error);
        }
        return modules;
    }
    validateModule(config) {
        if (!config.name || !config.version) {
            return false;
        }
        // [TODO] Add more validation logic here
        return true;
    }
}
exports.ModuleLoader = ModuleLoader;
