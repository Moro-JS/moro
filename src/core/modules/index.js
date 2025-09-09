"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.autoDiscoverModuleDirectories = exports.ModuleDiscovery = exports.ModuleLoader = exports.defineModule = void 0;
// Module System - Centralized Exports
var modules_1 = require("./modules");
Object.defineProperty(exports, "defineModule", { enumerable: true, get: function () { return modules_1.defineModule; } });
Object.defineProperty(exports, "ModuleLoader", { enumerable: true, get: function () { return modules_1.ModuleLoader; } });
var auto_discovery_1 = require("./auto-discovery");
Object.defineProperty(exports, "ModuleDiscovery", { enumerable: true, get: function () { return auto_discovery_1.ModuleDiscovery; } });
Object.defineProperty(exports, "autoDiscoverModuleDirectories", { enumerable: true, get: function () { return auto_discovery_1.autoDiscoverModuleDirectories; } });
