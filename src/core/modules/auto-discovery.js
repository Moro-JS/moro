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
exports.ModuleRegistry = exports.ModuleDiscovery = void 0;
exports.autoDiscoverModules = autoDiscoverModules;
exports.autoDiscoverModuleDirectories = autoDiscoverModuleDirectories;
// Auto-discovery system for Moro modules
const fs_1 = require("fs");
const path_1 = require("path");
class ModuleDiscovery {
    baseDir;
    options;
    constructor(baseDir = process.cwd(), options = {}) {
        this.baseDir = baseDir;
        this.options = {
            pattern: /\.(module|config)\.(ts|js)$/,
            recursive: true,
            extensions: ['.ts', '.js'],
            ...options,
        };
    }
    // Auto-discover modules in the filesystem
    async discoverModules() {
        const modules = [];
        const modulePaths = this.findModuleFiles();
        for (const modulePath of modulePaths) {
            try {
                const module = await this.loadModule(modulePath);
                if (module) {
                    modules.push(module);
                    console.log(`Auto-discovered module: ${module.name}@${module.version} from ${modulePath}`);
                }
            }
            catch (error) {
                console.warn(`Failed to load module from ${modulePath}:`, error);
            }
        }
        return modules;
    }
    // Find modules by directory structure
    async discoverModuleDirectories(modulesDir = 'src/modules') {
        const modules = [];
        const fullPath = (0, path_1.join)(this.baseDir, modulesDir);
        try {
            if (!(0, fs_1.statSync)(fullPath).isDirectory()) {
                return modules;
            }
            const items = (0, fs_1.readdirSync)(fullPath);
            for (const item of items) {
                const itemPath = (0, path_1.join)(fullPath, item);
                if ((0, fs_1.statSync)(itemPath).isDirectory()) {
                    const indexPath = (0, path_1.join)(itemPath, 'index.ts');
                    try {
                        if ((0, fs_1.statSync)(indexPath).isFile()) {
                            const module = await this.loadModule(indexPath);
                            if (module) {
                                modules.push(module);
                                console.log(`Auto-discovered module directory: ${module.name} from ${item}/`);
                            }
                        }
                    }
                    catch {
                        // Try alternate patterns
                        const alternates = ['module.ts', `${item}.module.ts`, 'config.ts'];
                        for (const alt of alternates) {
                            const altPath = (0, path_1.join)(itemPath, alt);
                            try {
                                if ((0, fs_1.statSync)(altPath).isFile()) {
                                    const module = await this.loadModule(altPath);
                                    if (module) {
                                        modules.push(module);
                                        console.log(`Auto-discovered module: ${module.name} from ${item}/${alt}`);
                                        break;
                                    }
                                }
                            }
                            catch {
                                // Continue trying
                            }
                        }
                    }
                }
            }
        }
        catch {
            // Directory doesn't exist, that's fine
        }
        return modules;
    }
    // Find all module files matching the pattern
    findModuleFiles() {
        const files = [];
        this.scanDirectory(this.baseDir, files);
        return files.filter(file => this.options.pattern?.test(file));
    }
    // Recursively scan directories for module files
    scanDirectory(dir, files) {
        try {
            const items = (0, fs_1.readdirSync)(dir);
            for (const item of items) {
                const fullPath = (0, path_1.join)(dir, item);
                const stat = (0, fs_1.statSync)(fullPath);
                if (stat.isDirectory()) {
                    // Skip node_modules and other common directories
                    if (!['node_modules', '.git', 'dist', 'build'].includes(item) && this.options.recursive) {
                        this.scanDirectory(fullPath, files);
                    }
                }
                else if (stat.isFile()) {
                    const ext = (0, path_1.extname)(item);
                    if (this.options.extensions?.includes(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        }
        catch {
            // Directory not accessible, skip
        }
    }
    // Load a module from a file path
    async loadModule(modulePath) {
        try {
            const module = await Promise.resolve(`${modulePath}`).then(s => __importStar(require(s)));
            // Try different export patterns
            const candidates = [
                module.default,
                module.module,
                module.config,
                module,
                ...Object.values(module).filter(exp => exp && typeof exp === 'object' && 'name' in exp && 'version' in exp),
            ];
            for (const candidate of candidates) {
                if (this.isValidModule(candidate)) {
                    return candidate;
                }
            }
            return null;
        }
        catch (error) {
            throw new Error(`Failed to import module: ${error.message}`);
        }
    }
    // Validate that an object is a valid ModuleConfig
    isValidModule(obj) {
        return (obj &&
            typeof obj === 'object' &&
            typeof obj.name === 'string' &&
            typeof obj.version === 'string' &&
            (obj.routes === undefined || Array.isArray(obj.routes)) &&
            (obj.websockets === undefined || Array.isArray(obj.websockets)) &&
            (obj.services === undefined || Array.isArray(obj.services)));
    }
    // Watch for module changes (for development)
    watchModules(callback) {
        const fs = require('fs');
        const modulePaths = this.findModuleFiles();
        modulePaths.forEach(path => {
            try {
                fs.watchFile(path, async () => {
                    console.log(`Module file changed: ${path}`);
                    const modules = await this.discoverModules();
                    callback(modules);
                });
            }
            catch {
                // File watching not supported or failed
            }
        });
    }
}
exports.ModuleDiscovery = ModuleDiscovery;
// Convenience functions
async function autoDiscoverModules(baseDir, options) {
    const discovery = new ModuleDiscovery(baseDir, options);
    return discovery.discoverModules();
}
async function autoDiscoverModuleDirectories(baseDir, modulesDir) {
    const discovery = new ModuleDiscovery(baseDir);
    return discovery.discoverModuleDirectories(modulesDir);
}
// Module registry for tracking loaded modules
class ModuleRegistry {
    modules = new Map();
    loadedModules = new Set();
    register(module) {
        const key = `${module.name}@${module.version}`;
        this.modules.set(key, module);
    }
    markLoaded(moduleName, version) {
        const key = `${moduleName}@${version}`;
        this.loadedModules.add(key);
    }
    isLoaded(moduleName, version) {
        const key = `${moduleName}@${version}`;
        return this.loadedModules.has(key);
    }
    getModule(moduleName, version) {
        if (version) {
            return this.modules.get(`${moduleName}@${version}`);
        }
        // Find latest version if no version specified
        const modules = Array.from(this.modules.entries())
            .filter(([key]) => key.startsWith(`${moduleName}@`))
            .sort(([a], [b]) => b.localeCompare(a)); // Sort by version desc
        return modules[0]?.[1];
    }
    getAllModules() {
        return Array.from(this.modules.values());
    }
    getLoadedModules() {
        return Array.from(this.modules.entries())
            .filter(([key]) => this.loadedModules.has(key))
            .map(([, module]) => module);
    }
    clear() {
        this.modules.clear();
        this.loadedModules.clear();
    }
}
exports.ModuleRegistry = ModuleRegistry;
