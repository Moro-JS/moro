"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFrameworkLogger = exports.logger = exports.MoroLogger = void 0;
exports.configureGlobalLogger = configureGlobalLogger;
exports.applyLoggingConfiguration = applyLoggingConfiguration;
// Moro Logger - Beautiful, Fast, Feature-Rich
const perf_hooks_1 = require("perf_hooks");
class MoroLogger {
    level = "info";
    options;
    outputs = new Map();
    filters = new Map();
    history = [];
    timers = new Map();
    metrics = {
        totalLogs: 0,
        logsByLevel: { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 },
        logsByContext: {},
        averageLogRate: 0,
        errorRate: 0,
        memoryUsage: 0,
    };
    startTime = Date.now();
    contextPrefix;
    contextMetadata;
    static LEVELS = {
        debug: 0,
        info: 1,
        warn: 2,
        error: 3,
        fatal: 4,
    };
    static COLORS = {
        debug: "\x1b[36m", // Cyan
        info: "\x1b[32m", // Green
        warn: "\x1b[33m", // Yellow
        error: "\x1b[31m", // Red
        fatal: "\x1b[35m", // Magenta
        timestamp: "\x1b[90m", // Gray
        context: "\x1b[34m", // Blue
        metadata: "\x1b[37m", // White
        performance: "\x1b[36m", // Cyan
    };
    static RESET = "\x1b[0m";
    static BOLD = "\x1b[1m";
    constructor(options = {}) {
        this.options = {
            level: "info",
            enableColors: true,
            enableTimestamp: true,
            enableContext: true,
            enableMetadata: true,
            enablePerformance: true,
            format: "pretty",
            outputs: [],
            filters: [],
            maxEntries: 1000,
            ...options,
        };
        this.level = this.options.level || "info";
        // Add default console output
        this.addOutput({
            name: "console",
            write: this.writeToConsole.bind(this),
            format: this.options.format,
        });
        // Add custom outputs
        this.options.outputs?.forEach((output) => this.addOutput(output));
        this.options.filters?.forEach((filter) => this.addFilter(filter));
    }
    debug(message, context, metadata) {
        this.log("debug", message, context, metadata);
    }
    info(message, context, metadata) {
        this.log("info", message, context, metadata);
    }
    warn(message, context, metadata) {
        this.log("warn", message, context, metadata);
    }
    error(message, context, metadata) {
        const msg = message instanceof Error ? message.message : message;
        const stack = message instanceof Error ? message.stack : undefined;
        this.log("error", msg, context, { ...metadata, stack });
    }
    fatal(message, context, metadata) {
        const msg = message instanceof Error ? message.message : message;
        const stack = message instanceof Error ? message.stack : undefined;
        this.log("fatal", msg, context, { ...metadata, stack });
    }
    time(label) {
        this.timers.set(label, perf_hooks_1.performance.now());
    }
    timeEnd(label, context, metadata) {
        const startTime = this.timers.get(label);
        if (startTime !== undefined) {
            const duration = perf_hooks_1.performance.now() - startTime;
            this.timers.delete(label);
            this.log("info", `Timer: ${label}`, context, {
                ...metadata,
                performance: { duration: Math.round(duration * 100) / 100 },
            });
        }
    }
    child(context, metadata) {
        const childLogger = new MoroLogger(this.options);
        childLogger.contextPrefix = this.contextPrefix
            ? `${this.contextPrefix}:${context}`
            : context;
        childLogger.contextMetadata = { ...this.contextMetadata, ...metadata };
        childLogger.outputs = this.outputs;
        childLogger.filters = this.filters;
        return childLogger;
    }
    setLevel(level) {
        this.level = level;
    }
    addOutput(output) {
        this.outputs.set(output.name, output);
    }
    removeOutput(name) {
        this.outputs.delete(name);
    }
    addFilter(filter) {
        this.filters.set(filter.name, filter);
    }
    removeFilter(name) {
        this.filters.delete(name);
    }
    getHistory(count) {
        const entries = [...this.history];
        return count ? entries.slice(-count) : entries;
    }
    getMetrics() {
        const now = Date.now();
        const uptime = (now - this.startTime) / 1000; // seconds
        const avgRate = uptime > 0 ? this.metrics.totalLogs / uptime : 0;
        const errorCount = this.metrics.logsByLevel.error + this.metrics.logsByLevel.fatal;
        const errorRate = this.metrics.totalLogs > 0
            ? (errorCount / this.metrics.totalLogs) * 100
            : 0;
        return {
            ...this.metrics,
            averageLogRate: Math.round(avgRate * 100) / 100,
            errorRate: Math.round(errorRate * 100) / 100,
            memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024, // MB
        };
    }
    clear() {
        this.history = [];
        this.metrics = {
            totalLogs: 0,
            logsByLevel: { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 },
            logsByContext: {},
            averageLogRate: 0,
            errorRate: 0,
            memoryUsage: 0,
        };
    }
    log(level, message, context, metadata) {
        // Check level threshold
        if (MoroLogger.LEVELS[level] < MoroLogger.LEVELS[this.level]) {
            return;
        }
        // Create log entry
        const entry = {
            timestamp: new Date(),
            level,
            message,
            context: this.contextPrefix
                ? context
                    ? `${this.contextPrefix}:${context}`
                    : this.contextPrefix
                : context,
            metadata: { ...this.contextMetadata, ...metadata },
            performance: this.options.enablePerformance
                ? {
                    memory: process.memoryUsage().heapUsed / 1024 / 1024,
                }
                : undefined,
        };
        // Apply filters
        for (const filter of this.filters.values()) {
            if (!filter.filter(entry)) {
                return;
            }
        }
        // Update metrics
        this.updateMetrics(entry);
        // Store in history
        this.history.push(entry);
        if (this.history.length > (this.options.maxEntries || 1000)) {
            this.history.shift();
        }
        // Write to outputs
        for (const output of this.outputs.values()) {
            if (!output.level ||
                MoroLogger.LEVELS[level] >= MoroLogger.LEVELS[output.level]) {
                try {
                    output.write(entry);
                }
                catch (error) {
                    console.error("Logger output error:", error);
                }
            }
        }
    }
    updateMetrics(entry) {
        this.metrics.totalLogs++;
        this.metrics.logsByLevel[entry.level]++;
        if (entry.context) {
            this.metrics.logsByContext[entry.context] =
                (this.metrics.logsByContext[entry.context] || 0) + 1;
        }
    }
    writeToConsole(entry) {
        const format = this.options.format || "pretty";
        if (format === "json") {
            console.log(JSON.stringify(entry));
            return;
        }
        if (format === "compact") {
            const level = entry.level.toUpperCase().padEnd(5);
            const context = entry.context ? `[${entry.context}] ` : "";
            console.log(`${level} ${context}${entry.message}`);
            return;
        }
        // Pretty format (default)
        this.writePrettyLog(entry);
    }
    writePrettyLog(entry) {
        const colors = this.options.enableColors !== false;
        const parts = [];
        // Timestamp
        if (this.options.enableTimestamp !== false) {
            const timestamp = entry.timestamp
                .toISOString()
                .replace("T", " ")
                .slice(0, 19);
            parts.push(colors
                ? `${MoroLogger.COLORS.timestamp}${timestamp}${MoroLogger.RESET}`
                : timestamp);
        }
        // Level with color (remove icons)
        const levelColor = colors ? MoroLogger.COLORS[entry.level] : "";
        const levelReset = colors ? MoroLogger.RESET : "";
        const levelText = entry.level.toUpperCase();
        parts.push(`${levelColor}${MoroLogger.BOLD}${levelText}${levelReset}`);
        // Context
        if (entry.context && this.options.enableContext !== false) {
            const contextColor = colors ? MoroLogger.COLORS.context : "";
            parts.push(`${contextColor}[${entry.context}]${levelReset}`);
        }
        // Message
        parts.push(entry.message);
        // Performance info
        if (entry.performance && this.options.enablePerformance !== false) {
            const perfColor = colors ? MoroLogger.COLORS.performance : "";
            const perfParts = [];
            if (entry.performance.duration !== undefined) {
                perfParts.push(`${entry.performance.duration}ms`);
            }
            if (entry.performance.memory !== undefined) {
                perfParts.push(`${Math.round(entry.performance.memory)}MB`);
            }
            if (perfParts.length > 0) {
                parts.push(`${perfColor}(${perfParts.join(", ")})${levelReset}`);
            }
        }
        // Metadata
        if (entry.metadata &&
            Object.keys(entry.metadata).length > 0 &&
            this.options.enableMetadata !== false) {
            const metaColor = colors ? MoroLogger.COLORS.metadata : "";
            const cleanMetadata = { ...entry.metadata };
            delete cleanMetadata.stack; // Handle stack separately
            if (Object.keys(cleanMetadata).length > 0) {
                parts.push(`${metaColor}${JSON.stringify(cleanMetadata)}${levelReset}`);
            }
        }
        // Output main log line
        console.log(parts.join(" "));
        // Stack trace for errors
        if (entry.metadata?.stack &&
            (entry.level === "error" || entry.level === "fatal")) {
            const stackColor = colors ? MoroLogger.COLORS.error : "";
            console.log(`${stackColor}${entry.metadata.stack}${levelReset}`);
        }
    }
}
exports.MoroLogger = MoroLogger;
// Global logger instance
const initialLogLevel = process.env.LOG_LEVEL ||
    process.env.MORO_LOG_LEVEL ||
    (process.env.NODE_ENV === "production" ? "warn" : "debug");
exports.logger = new MoroLogger({
    level: initialLogLevel,
    enableColors: !process.env.NO_COLOR,
    format: process.env.LOG_FORMAT || "pretty",
});
/**
 * Configure the global logger with new settings
 * This allows runtime configuration of the logger
 */
function configureGlobalLogger(options) {
    if (options.level) {
        exports.logger.setLevel(options.level);
    }
    // Additional configuration options can be added here as needed
    // For now, focusing on level which is the most critical
}
/**
 * Apply logging configuration from the config system and/or createApp options
 */
function applyLoggingConfiguration(configLogging, appOptions) {
    // First apply config system settings (from environment variables)
    if (configLogging?.level) {
        configureGlobalLogger({ level: configLogging.level });
    }
    // Then apply createApp options (these take precedence)
    if (appOptions !== undefined) {
        if (appOptions === false) {
            // Disable logging by setting to fatal level
            configureGlobalLogger({ level: "fatal" });
        }
        else if (typeof appOptions === "object") {
            configureGlobalLogger(appOptions);
        }
    }
}
// Framework-specific logger
const createFrameworkLogger = (context) => {
    return exports.logger.child("Moro", { framework: "moro", context });
};
exports.createFrameworkLogger = createFrameworkLogger;
