"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.middleware = exports.HookManager = exports.HOOK_EVENTS = void 0;
// Hook System for Moro
const events_1 = require("events");
const logger_1 = require("../logger");
exports.HOOK_EVENTS = {
    BEFORE_REQUEST: 'before:request',
    AFTER_REQUEST: 'after:request',
    BEFORE_RESPONSE: 'before:response',
    AFTER_RESPONSE: 'after:response',
    ERROR: 'error',
};
class HookManager extends events_1.EventEmitter {
    hooks = new Map();
    beforeHooks = new Map();
    afterHooks = new Map();
    logger = (0, logger_1.createFrameworkLogger)('Hooks');
    constructor() {
        super();
        // Initialize hook arrays
        Object.values(exports.HOOK_EVENTS).forEach(event => {
            this.hooks.set(event, []);
            this.beforeHooks.set(event, []);
            this.afterHooks.set(event, []);
        });
    }
    // Register a hook for a specific event
    hook(event, fn) {
        if (!this.hooks.has(event)) {
            this.hooks.set(event, []);
        }
        this.hooks.get(event).push(fn);
        return this;
    }
    // Register a before hook
    before(event, fn) {
        if (!this.beforeHooks.has(event)) {
            this.beforeHooks.set(event, []);
        }
        this.beforeHooks.get(event).push(fn);
        return this;
    }
    // Register an after hook
    after(event, fn) {
        if (!this.afterHooks.has(event)) {
            this.afterHooks.set(event, []);
        }
        this.afterHooks.get(event).push(fn);
        return this;
    }
    // Execute hooks for an event
    async execute(event, context = {}) {
        // Execute before hooks
        const beforeHooks = this.beforeHooks.get(event) || [];
        for (const hook of beforeHooks) {
            await this.executeHook(hook, context);
        }
        // Execute main hooks
        const hooks = this.hooks.get(event) || [];
        for (const hook of hooks) {
            await this.executeHook(hook, context);
        }
        // Execute after hooks
        const afterHooks = this.afterHooks.get(event) || [];
        for (const hook of afterHooks) {
            await this.executeHook(hook, context);
        }
        // Emit event for listeners
        this.emit(event, context);
        return context;
    }
    // Execute a single hook with error handling
    async executeHook(hook, context) {
        try {
            await hook(context);
        }
        catch (error) {
            this.logger.error('Hook execution error', 'HookExecution', {
                error: error instanceof Error ? error.message : String(error),
                context: context.request?.method || 'unknown',
            });
            throw error;
        }
    }
    // Remove hooks
    removeHook(event, fn) {
        if (!fn) {
            this.hooks.delete(event);
            this.beforeHooks.delete(event);
            this.afterHooks.delete(event);
        }
        else {
            [this.hooks, this.beforeHooks, this.afterHooks].forEach(map => {
                const hooks = map.get(event);
                if (hooks) {
                    const index = hooks.indexOf(fn);
                    if (index !== -1) {
                        hooks.splice(index, 1);
                    }
                }
            });
        }
        return this;
    }
    // Get all registered hooks for debugging
    getHooks(event) {
        if (event) {
            return {
                before: this.beforeHooks.get(event) || [],
                main: this.hooks.get(event) || [],
                after: this.afterHooks.get(event) || [],
            };
        }
        const allHooks = {};
        const allEvents = new Set([
            ...this.hooks.keys(),
            ...this.beforeHooks.keys(),
            ...this.afterHooks.keys(),
        ]);
        allEvents.forEach(event => {
            allHooks[event] = this.getHooks(event);
        });
        return allHooks;
    }
}
exports.HookManager = HookManager;
// Built-in middleware - now organized in individual files
var index_1 = require("../middleware/index");
Object.defineProperty(exports, "middleware", { enumerable: true, get: function () { return index_1.simpleMiddleware; } });
