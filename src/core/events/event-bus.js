"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MoroEventBus = void 0;
// Enterprise Event Bus - Secure, Scalable, Observable
const events_1 = require("events");
const logger_1 = require("../logger");
class MoroEventBus {
    options;
    emitter = new events_1.EventEmitter();
    moduleBuses = new Map();
    metrics = {
        totalEvents: 0,
        eventsByType: {},
        eventsByModule: {},
        averageLatency: 0,
        errorRate: 0,
    };
    auditEnabled = false;
    auditLog = [];
    latencySum = 0;
    errorCount = 0;
    logger = (0, logger_1.createFrameworkLogger)("EventBus");
    constructor(options = {}) {
        this.options = options;
        this.emitter.setMaxListeners(options.maxListeners || 100);
    }
    // Global event emission with full context and metrics
    async emit(event, data, context) {
        const startTime = Date.now();
        const fullContext = {
            timestamp: new Date(),
            source: "framework",
            requestId: this.generateRequestId(),
            ...context,
        };
        const payload = {
            context: fullContext,
            data,
        };
        try {
            // Update metrics
            this.updateMetrics(event, fullContext.moduleId);
            // Audit logging
            if (this.auditEnabled) {
                this.auditLog.push(payload);
                if (this.auditLog.length > 1000) {
                    this.auditLog = this.auditLog.slice(-500); // Keep last 500 events
                }
            }
            // Emit to global listeners
            const result = this.emitter.emit(event, payload);
            // Calculate latency
            const latency = Date.now() - startTime;
            this.latencySum += latency;
            return result;
        }
        catch (error) {
            this.errorCount++;
            this.logger.error(`Event emission error for ${event}`, "Emission", {
                event,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }
    // Type-safe event listeners with automatic payload unwrapping
    on(event, listener) {
        this.emitter.on(event, listener);
        return this;
    }
    once(event, listener) {
        this.emitter.once(event, listener);
        return this;
    }
    off(event, listener) {
        this.emitter.off(event, listener);
        return this;
    }
    removeAllListeners(event) {
        this.emitter.removeAllListeners(event);
        return this;
    }
    listenerCount(event) {
        return this.emitter.listenerCount(event);
    }
    // Create isolated module event bus with namespace protection
    createModuleBus(moduleId) {
        // Return existing bus if it already exists
        if (this.moduleBuses.has(moduleId)) {
            this.logger.debug(`Reusing existing event bus for module: ${moduleId}`, "ModuleBus");
            return this.moduleBuses.get(moduleId);
        }
        const moduleBus = new ModuleEventBusImpl(moduleId, this);
        this.moduleBuses.set(moduleId, moduleBus);
        this.logger.debug(`Created event bus for module: ${moduleId}`, "ModuleBus");
        return moduleBus;
    }
    // Clean up module resources
    destroyModuleBus(moduleId) {
        const moduleBus = this.moduleBuses.get(moduleId);
        if (moduleBus) {
            moduleBus.removeAllListeners();
            this.moduleBuses.delete(moduleId);
            this.logger.debug(`Destroyed event bus for module: ${moduleId}`, "ModuleBus");
        }
    }
    // Comprehensive event metrics
    getMetrics() {
        return {
            ...this.metrics,
            averageLatency: this.metrics.totalEvents > 0
                ? this.latencySum / this.metrics.totalEvents
                : 0,
            errorRate: this.metrics.totalEvents > 0
                ? (this.errorCount / this.metrics.totalEvents) * 100
                : 0,
        };
    }
    // Enable audit logging for compliance
    enableAuditLog() {
        this.auditEnabled = true;
        this.logger.info("Event audit logging enabled", "Audit");
    }
    disableAuditLog() {
        this.auditEnabled = false;
        this.auditLog = [];
        this.logger.info("Event audit logging disabled", "Audit");
    }
    // Get audit log for compliance reporting
    getAuditLog() {
        return [...this.auditLog];
    }
    updateMetrics(event, moduleId) {
        this.metrics.totalEvents++;
        this.metrics.eventsByType[event] =
            (this.metrics.eventsByType[event] || 0) + 1;
        if (moduleId) {
            this.metrics.eventsByModule[moduleId] =
                (this.metrics.eventsByModule[moduleId] || 0) + 1;
        }
    }
    generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}
exports.MoroEventBus = MoroEventBus;
// Module-isolated event bus implementation
class ModuleEventBusImpl {
    moduleId;
    globalBus;
    constructor(moduleId, globalBus) {
        this.moduleId = moduleId;
        this.globalBus = globalBus;
    }
    async emit(event, data) {
        // Module events are namespaced to prevent conflicts
        const namespacedEvent = `module:${this.moduleId}:${event}`;
        return this.globalBus.emit(namespacedEvent, data, {
            source: "module",
            moduleId: this.moduleId,
        });
    }
    on(event, listener) {
        const namespacedEvent = `module:${this.moduleId}:${event}`;
        this.globalBus.on(namespacedEvent, listener);
        return this;
    }
    once(event, listener) {
        const namespacedEvent = `module:${this.moduleId}:${event}`;
        this.globalBus.once(namespacedEvent, listener);
        return this;
    }
    off(event, listener) {
        const namespacedEvent = `module:${this.moduleId}:${event}`;
        this.globalBus.off(namespacedEvent, listener);
        return this;
    }
    removeAllListeners(event) {
        if (event) {
            const namespacedEvent = `module:${this.moduleId}:${event}`;
            this.globalBus.removeAllListeners(namespacedEvent);
        }
        else {
            // Remove all module events - would need access to globalBus emitter
            // For now, this is a simplified implementation
            const logger = (0, logger_1.createFrameworkLogger)("EventBus");
            logger.warn(`Removing all listeners for module ${this.moduleId} not fully implemented`, "ModuleBus");
        }
        return this;
    }
    listenerCount(event) {
        const namespacedEvent = `module:${this.moduleId}:${event}`;
        return this.globalBus.listenerCount(namespacedEvent);
    }
}
