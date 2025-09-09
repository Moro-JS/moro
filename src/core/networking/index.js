"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceRegistry = exports.WebSocketManager = void 0;
// Networking System - Centralized Exports
var websocket_manager_1 = require("./websocket-manager");
Object.defineProperty(exports, "WebSocketManager", { enumerable: true, get: function () { return websocket_manager_1.WebSocketManager; } });
var service_discovery_1 = require("./service-discovery");
Object.defineProperty(exports, "ServiceRegistry", { enumerable: true, get: function () { return service_discovery_1.ServiceRegistry; } });
