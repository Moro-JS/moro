// Moro Logger - Beautiful, Fast, Feature-Rich
import { performance } from 'perf_hooks';

import {
  LogLevel,
  LogEntry,
  LoggerOptions,
  Logger,
  LogOutput,
  LogFilter,
  LogMetrics,
  ColorScheme,
} from '../../types/logger.js';

// Optional LogEntry fields are cleared to undefined when a pooled entry is
// reused. exactOptionalPropertyTypes rejects assigning undefined straight onto
// a plain optional property, so those writes go through this widened view.
// Runtime shape is unchanged; this only relaxes the compile-time check.
type ResettableLogEntry = { [K in keyof LogEntry]: LogEntry[K] | undefined };

export class MoroLogger implements Logger {
  private level: LogLevel = 'info';
  private options: LoggerOptions;
  private outputs: Map<string, LogOutput> = new Map();
  private filters: Map<string, LogFilter> = new Map();
  private history: LogEntry[] = [];
  private timers: Map<string, number> = new Map();
  private metrics: LogMetrics = {
    totalLogs: 0,
    logsByLevel: { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 },
    logsByContext: {},
    averageLogRate: 0,
    errorRate: 0,
    memoryUsage: 0,
  };
  private startTime = Date.now();
  private contextPrefix?: string;
  private contextMetadata?: Record<string, any>;
  private parent?: MoroLogger; // Reference to parent logger for level inheritance

  // Performance optimizations
  private historyIndex = 0;
  private historySize = 0;
  private lastMemoryCheck = 0;
  private memoryCheckInterval = 5000; // 5 seconds
  private cachedTimestamp = '';
  private lastTimestamp = 0;
  private timestampCacheInterval = 100; // 100ms for better precision

  // Metrics tracking toggle (disabled by default)
  private metricsEnabled = false;

  // Object pooling for LogEntry objects (Pino's technique)
  private static readonly ENTRY_POOL: LogEntry[] = [];
  private static readonly MAX_POOL_SIZE = 100;
  private static poolIndex = 0;

  // String builder for efficient concatenation
  private static stringBuilder: string[] = [];
  private static stringBuilderIndex = 0;

  // Buffered output for performance
  private outputBuffer: string[] = [];
  private bufferSize = 0;
  private maxBufferSize = 1000;
  private flushTimeout: NodeJS.Timeout | null = null;
  private flushInterval = 1; // 1ms micro-batching

  // Buffer overflow protection
  private bufferOverflowThreshold: number;
  private emergencyFlushInProgress = false;
  private isDestroyed = false;

  // High-performance output methods

  private static readonly LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4,
  };

  private static readonly COLORS: ColorScheme = {
    debug: '\x1b[36m', // Cyan
    info: '\x1b[32m', // Green
    warn: '\x1b[33m', // Yellow
    error: '\x1b[31m', // Red
    fatal: '\x1b[35m', // Magenta
    timestamp: '\x1b[90m', // Gray
    context: '\x1b[34m', // Blue
    metadata: '\x1b[37m', // White
    performance: '\x1b[36m', // Cyan
    reset: '\x1b[0m', // Reset
  };

  private static readonly RESET = '\x1b[0m';
  private static readonly BOLD = '\x1b[1m';

  // Static pre-allocated strings for performance
  private static readonly LEVEL_STRINGS: Record<LogLevel, string> = {
    debug: 'DEBUG',
    info: 'INFO ',
    warn: 'WARN ',
    error: 'ERROR',
    fatal: 'FATAL',
  };

  constructor(options: LoggerOptions = {}) {
    this.options = this.validateOptions({
      level: 'info',
      enableColors: true,
      enableTimestamp: true,
      enableContext: true,
      // Opt-in: appends JSON metadata tail in pretty logs. Off by default to keep lines clean.
      enableMetadata: false,
      // Opt-in: per-log perf data. Off by default to skip process.memoryUsage() per log.
      enablePerformance: false,
      format: 'pretty',
      outputs: [],
      filters: [],
      maxEntries: 1000,
      maxBufferSize: 1000,
      ...options,
    });

    this.level = this.options.level || 'info';

    // Enable metrics only if explicitly requested
    this.metricsEnabled = this.options.enableMetrics ?? false;

    // Initialize buffer size from options
    this.maxBufferSize = this.options.maxBufferSize || 1000;

    // Initialize buffer overflow protection
    this.bufferOverflowThreshold = this.maxBufferSize * 2;

    // Initialize log methods based on level
    this.debug = this.createLogMethod('debug');
    this.info = this.createLogMethod('info');
    this.warn = this.createLogMethod('warn');
    this.error = this.createLogMethod('error');
    this.fatal = this.createLogMethod('fatal');

    // Add default console output
    this.addOutput({
      name: 'console',
      write: this.writeToConsole.bind(this),
      ...(this.options.format !== undefined ? { format: this.options.format } : {}),
    });

    // Add custom outputs
    if (this.options.outputs) {
      const outputsLen = this.options.outputs.length;
      for (let i = 0; i < outputsLen; i++) {
        const output = this.options.outputs[i];
        if (output !== undefined) {
          this.addOutput(output);
        }
      }
    }
    if (this.options.filters) {
      const filtersLen = this.options.filters.length;
      for (let i = 0; i < filtersLen; i++) {
        const filter = this.options.filters[i];
        if (filter !== undefined) {
          this.addFilter(filter);
        }
      }
    }
  }

  // Object pooling methods
  private static getPooledEntry(): LogEntry {
    if (MoroLogger.ENTRY_POOL.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const entry = MoroLogger.ENTRY_POOL.pop()!;
      // Properly reset ALL properties to prevent memory leaks. Reset through a
      // Partial view so the optional fields can be cleared to undefined under
      // exactOptionalPropertyTypes; the runtime object shape is unchanged.
      const reset = entry as ResettableLogEntry;
      reset.timestamp = new Date();
      reset.level = 'info';
      reset.message = '';
      reset.context = undefined;
      reset.metadata = undefined;
      reset.performance = undefined;
      reset.moduleId = undefined;
      return entry;
    }
    return MoroLogger.createFreshEntry();
  }

  // ADD this new method:
  private static createFreshEntry(): LogEntry {
    // Optional fields are present-and-undefined so pooled and fresh entries
    // share one V8 hidden class. Built as a Partial to satisfy
    // exactOptionalPropertyTypes, then returned as a fully-formed LogEntry.
    const entry: ResettableLogEntry = {
      timestamp: new Date(),
      level: 'info',
      message: '',
      context: undefined,
      metadata: undefined,
      performance: undefined,
      moduleId: undefined,
    };
    return entry as LogEntry;
  }

  private static returnPooledEntry(entry: LogEntry): void {
    if (MoroLogger.ENTRY_POOL.length < MoroLogger.MAX_POOL_SIZE) {
      MoroLogger.ENTRY_POOL.push(entry);
    }
  }

  // String builder methods
  private static resetStringBuilder(): void {
    MoroLogger.stringBuilder.length = 0;
    MoroLogger.stringBuilderIndex = 0;
  }

  private static appendToBuilder(str: string): void {
    MoroLogger.stringBuilder[MoroLogger.stringBuilderIndex++] = str;
  }

  private static buildString(): string {
    const result = MoroLogger.stringBuilder.join('');
    MoroLogger.resetStringBuilder();
    return result;
  }

  // Noop functions for disabled log levels
  // These are replaced when level changes to avoid unnecessary calls
  debug: (message: string, context?: string, metadata?: Record<string, any>) => void =
    this.createLogMethod('debug');

  info: (message: string, context?: string, metadata?: Record<string, any>) => void =
    this.createLogMethod('info');

  warn: (message: string, context?: string, metadata?: Record<string, any>) => void =
    this.createLogMethod('warn');

  error: (message: string | Error, context?: string, metadata?: Record<string, any>) => void =
    this.createLogMethod('error');

  fatal: (message: string | Error, context?: string, metadata?: Record<string, any>) => void =
    this.createLogMethod('fatal');

  // Create log method with level check optimization
  private createLogMethod(level: LogLevel): any {
    // If this level is disabled, return noop function
    if (MoroLogger.LEVELS[level] < MoroLogger.LEVELS[this.level]) {
      // Noop - zero overhead!
      return () => {};
    }

    // Return actual logging function
    if (level === 'error' || level === 'fatal') {
      return (message: string | Error, context?: string, metadata?: Record<string, any>) => {
        const msg = message instanceof Error ? message.message : message;
        const stack = message instanceof Error ? message.stack : undefined;
        this.log(level, msg, context, { ...metadata, stack });
      };
    }

    return (message: string, context?: string, metadata?: Record<string, any>) => {
      this.log(level, message, context, metadata);
    };
  }

  time(label: string): void {
    this.timers.set(label, performance.now());
  }

  timeEnd(label: string, context?: string, metadata?: Record<string, any>): void {
    const startTime = this.timers.get(label);
    if (startTime !== undefined) {
      const duration = performance.now() - startTime;
      this.timers.delete(label);

      this.log('info', `Timer: ${label}`, context, {
        ...metadata,
        performance: { duration: Math.round(duration * 100) / 100 },
      });
    }
  }

  // Children created via child() - tracked (weakly) so setLevel propagates.
  // Without this, a child created while level was 'warn' keeps noop info/debug
  // methods forever, silently dropping logs after the level is raised.
  private childRefs: Set<WeakRef<MoroLogger>> | null = null;

  child(context: string, metadata?: Record<string, any>): Logger {
    // Create child logger with current parent level (not original options level)
    const childOptions = { ...this.options, level: this.level };
    const childLogger = new MoroLogger(childOptions);
    childLogger.contextPrefix = this.contextPrefix ? `${this.contextPrefix}:${context}` : context;
    childLogger.contextMetadata = { ...this.contextMetadata, ...metadata };
    childLogger.outputs = this.outputs;
    childLogger.filters = this.filters;

    // Keep reference to parent for level inheritance
    (childLogger as any).parent = this;

    if (!this.childRefs) this.childRefs = new Set();
    this.childRefs.add(new WeakRef(childLogger));

    return childLogger;
  }

  setLevel(level: LogLevel): void {
    this.level = level;

    // Rebuild log methods to update noop functions
    this.debug = this.createLogMethod('debug');
    this.info = this.createLogMethod('info');
    this.warn = this.createLogMethod('warn');
    this.error = this.createLogMethod('error');
    this.fatal = this.createLogMethod('fatal');

    // Propagate to children so their noop-swapped methods follow the new level
    if (this.childRefs) {
      for (const ref of this.childRefs) {
        const childLogger = ref.deref();
        if (childLogger) {
          childLogger.setLevel(level);
        } else {
          this.childRefs.delete(ref);
        }
      }
    }
  }

  getLevel(): LogLevel {
    return this.level;
  }

  addOutput(output: LogOutput): void {
    this.outputs.set(output.name, output);
  }

  removeOutput(name: string): void {
    this.outputs.delete(name);
  }

  addFilter(filter: LogFilter): void {
    this.filters.set(filter.name, filter);
  }

  removeFilter(name: string): void {
    this.filters.delete(name);
  }

  getHistory(count?: number): LogEntry[] {
    if (this.historySize === 0) return [];

    if (this.historySize < (this.options.maxEntries || 1000)) {
      // History not full yet, return all entries
      const entries = this.history.slice(0, this.historySize);
      return count ? entries.slice(-count) : entries;
    } else {
      // History is full, use circular buffer logic
      const entries: LogEntry[] = [];
      const maxEntries = this.options.maxEntries || 1000;

      for (let i = 0; i < maxEntries; i++) {
        const index = (this.historyIndex + i) % maxEntries;
        if (this.history[index]) {
          entries.push(this.history[index]);
        }
      }

      return count ? entries.slice(-count) : entries;
    }
  }

  // Cached timestamp formatting to avoid repeated string operations
  private getCachedTimestamp(timestamp: Date): string {
    const now = timestamp.getTime();
    if (now - this.lastTimestamp > this.timestampCacheInterval) {
      this.lastTimestamp = now;
      this.cachedTimestamp = timestamp.toISOString().replace('T', ' ').slice(0, 19);
    }
    return this.cachedTimestamp;
  }

  // Cached timestamp generation (updates once per second)
  private getFastCachedTimestamp(): string {
    const now = Date.now();
    if (now - this.lastTimestamp > 1000) {
      // Update every second
      this.lastTimestamp = now;
      this.cachedTimestamp = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
    }
    return this.cachedTimestamp;
  }

  getMetrics(): LogMetrics {
    const now = Date.now();
    const uptime = (now - this.startTime) / 1000; // seconds
    const avgRate = uptime > 0 ? this.metrics.totalLogs / uptime : 0;
    const errorCount = this.metrics.logsByLevel.error + this.metrics.logsByLevel.fatal;
    const errorRate = this.metrics.totalLogs > 0 ? (errorCount / this.metrics.totalLogs) * 100 : 0;

    return {
      ...this.metrics,
      averageLogRate: Math.round(avgRate * 100) / 100,
      errorRate: Math.round(errorRate * 100) / 100,
      memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024, // MB
    };
  }

  clear(): void {
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

  // Optimized logging method
  private log(
    level: LogLevel,
    message: string,
    context?: string,
    metadata?: Record<string, any>
  ): void {
    // Prevent logging after destroy() is called (important for test cleanup)
    if (this.isDestroyed) {
      return;
    }

    // Quick level check - use parent level if available (for child loggers)
    const effectiveLevel = this.parent ? this.parent.level : this.level;
    if (MoroLogger.LEVELS[level] < MoroLogger.LEVELS[effectiveLevel as LogLevel]) {
      return;
    }

    // Absolute minimal path for simple logs - pure speed
    if (!metadata && !context && !this.contextPrefix && !this.contextMetadata) {
      this.writeSimpleLog(level, message);
      return;
    }

    // Minimal path for logs with context but no metadata
    if (!metadata && !this.contextMetadata) {
      this.writeSimpleLog(level, message, context);
      return;
    }

    // Path for complex logs - avoid Object.keys for empty check
    if (metadata) {
      // Fast empty check: iterate and return on first property
      let hasKeys = false;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const _ in metadata) {
        hasKeys = true;
        break;
      }
      if (hasKeys) {
        // Only take the minimal fast path when nothing needs the full pipeline.
        // If filters (e.g. sanitizeFilter redaction) or metrics are configured,
        // metadata-bearing logs MUST go through fullLog - otherwise sensitive
        // keys in call metadata would be logged unredacted.
        if (this.filters.size === 0 && !this.metricsEnabled) {
          this.complexLog(level, message, context, metadata);
        } else {
          this.fullLog(level, message, context, metadata);
        }
        return;
      }
    }

    // Full logging path for complex logs
    this.fullLog(level, message, context, metadata);
  }

  // Full logging with all features
  private fullLog(
    level: LogLevel,
    message: string,
    context?: string,
    metadata?: Record<string, any>
  ): void {
    // Use object pooling for LogEntry (Pino's technique)
    const entry = MoroLogger.getPooledEntry();
    const now = Date.now();

    entry.timestamp = new Date(now);
    entry.level = level;
    entry.message = message;
    (entry as ResettableLogEntry).context = this.contextPrefix
      ? context
        ? `${this.contextPrefix}:${context}`
        : this.contextPrefix
      : context;
    entry.metadata = this.createMetadata(metadata);
    (entry as ResettableLogEntry).performance = this.options.enablePerformance
      ? this.getPerformanceData(now)
      : undefined;

    // Apply filters with early return optimization
    if (this.filters.size > 0) {
      for (const filter of this.filters.values()) {
        if (!filter.filter(entry)) {
          MoroLogger.returnPooledEntry(entry);
          return;
        }
      }
    }

    // Only update metrics and history if enabled
    if (this.metricsEnabled) {
      this.updateMetrics(entry);
      this.addToHistory(entry);
    }

    // Write to outputs with batched processing
    this.writeToOutputs(entry, level);

    // Return entry to pool
    MoroLogger.returnPooledEntry(entry);
  }

  // Absolute minimal logging - pure speed, no overhead
  private complexLog(
    level: LogLevel,
    message: string,
    context?: string,
    metadata?: Record<string, any>
  ): void {
    // Use object pooling for LogEntry (Pino's technique)
    const entry = MoroLogger.getPooledEntry();
    const now = Date.now();

    entry.timestamp = new Date(now);
    entry.level = level;
    entry.message = message;
    (entry as ResettableLogEntry).context = this.contextPrefix
      ? context
        ? `${this.contextPrefix}:${context}`
        : this.contextPrefix
      : context;
    entry.metadata = this.createMetadata(metadata);
    (entry as ResettableLogEntry).performance = this.options.enablePerformance
      ? this.getPerformanceData(now)
      : undefined;

    // Write to outputs with batched processing
    this.writeToOutputs(entry, level);

    // Return entry to pool
    MoroLogger.returnPooledEntry(entry);
  }

  // Simple log writer with colors for minimal overhead cases
  private writeSimpleLog(level: LogLevel, message: string, context?: string): void {
    const colors = this.options.enableColors !== false;
    const levelReset = colors ? MoroLogger.RESET : '';

    MoroLogger.resetStringBuilder();

    // Timestamp with caching optimization
    if (this.options.enableTimestamp !== false) {
      const timestamp = this.getFastCachedTimestamp();
      if (colors) {
        MoroLogger.appendToBuilder(MoroLogger.COLORS.timestamp);
        MoroLogger.appendToBuilder(timestamp);
        MoroLogger.appendToBuilder(levelReset);
      } else {
        MoroLogger.appendToBuilder(timestamp);
      }
      MoroLogger.appendToBuilder(' ');
    }

    // Level with pre-allocated strings
    const levelStr = MoroLogger.LEVEL_STRINGS[level];
    if (colors) {
      MoroLogger.appendToBuilder(MoroLogger.COLORS[level]);
      MoroLogger.appendToBuilder(MoroLogger.BOLD);
      MoroLogger.appendToBuilder(levelStr);
      MoroLogger.appendToBuilder(levelReset);
    } else {
      MoroLogger.appendToBuilder(levelStr);
    }

    // Context
    if (context && this.options.enableContext !== false) {
      MoroLogger.appendToBuilder(' ');
      if (colors) {
        MoroLogger.appendToBuilder(MoroLogger.COLORS.context);
        MoroLogger.appendToBuilder(`[${context}]`);
        MoroLogger.appendToBuilder(levelReset);
      } else {
        MoroLogger.appendToBuilder(`[${context}]`);
      }
    }

    // Message
    MoroLogger.appendToBuilder(' ');
    MoroLogger.appendToBuilder(message);

    // Output main log line with high-performance method
    const finalMessage = MoroLogger.buildString();
    this.output(`${finalMessage}\n`, level);
  }

  private updateMetrics(entry: LogEntry): void {
    // NOOP when metrics disabled
    if (!this.metricsEnabled) return;

    this.metrics.totalLogs++;
    this.metrics.logsByLevel[entry.level]++;

    if (entry.context) {
      this.metrics.logsByContext[entry.context] =
        (this.metrics.logsByContext[entry.context] || 0) + 1;
    }
  }

  // Optimized metadata creation to avoid unnecessary object spreading
  private createMetadata(metadata?: Record<string, any>): Record<string, any> {
    if (!metadata && !this.contextMetadata) {
      return {};
    }
    if (!metadata) {
      return { ...this.contextMetadata };
    }
    if (!this.contextMetadata) {
      return { ...metadata };
    }
    return { ...this.contextMetadata, ...metadata };
  }

  // Optimized performance data with caching
  private getPerformanceData(now: number): { memory: number } | undefined {
    if (now - this.lastMemoryCheck > this.memoryCheckInterval) {
      this.lastMemoryCheck = now;
      this.metrics.memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024;
    }
    return { memory: this.metrics.memoryUsage };
  }

  // Circular buffer implementation for history (O(1) instead of O(n))
  private addToHistory(entry: LogEntry): void {
    const maxEntries = this.options.maxEntries || 1000;

    if (this.historySize < maxEntries) {
      this.history[this.historySize] = entry;
      this.historySize++;
    } else {
      // Circular buffer: overwrite oldest entry
      this.history[this.historyIndex] = entry;
      this.historyIndex = (this.historyIndex + 1) % maxEntries;
    }
  }

  // Optimized output writing with batching
  private writeToOutputs(entry: LogEntry, level: LogLevel): void {
    if (this.outputs.size === 0) return;

    let successCount = 0;
    const errors: Array<{ outputName: string; error: any }> = [];

    for (const output of this.outputs.values()) {
      if (!output.level || MoroLogger.LEVELS[level] >= MoroLogger.LEVELS[output.level]) {
        try {
          void output.write(entry);
          successCount++;
        } catch (error) {
          errors.push({ outputName: output.name, error });
          this.handleOutputError(output.name, error);
        }
      }
    }

    // If all outputs fail, use emergency console
    if (successCount === 0 && this.outputs.size > 0) {
      this.emergencyConsoleWrite(entry);
    }

    // Log output errors (but avoid infinite loops)
    if (errors.length > 0 && level !== 'error') {
      this.error(`Logger output errors: ${errors.length} failed`, 'MoroLogger', {
        errors: errors.map(e => e.outputName),
      });
    }
  }

  private writeToConsole(entry: LogEntry): void {
    const format = this.options.format || 'pretty';

    if (format === 'json') {
      this.output(`${this.safeStringify(entry)}\n`, entry.level);
      return;
    }

    if (format === 'compact') {
      const level = entry.level.toUpperCase().padEnd(5);
      const context = entry.context ? `[${entry.context}] ` : '';
      this.output(`${level} ${context}${entry.message}\n`, entry.level);
      return;
    }

    // Pretty format (default)
    this.writePrettyLog(entry);
  }

  private writePrettyLog(entry: LogEntry): void {
    const colors = this.options.enableColors !== false;
    const levelReset = colors ? MoroLogger.RESET : '';

    MoroLogger.resetStringBuilder();

    // Timestamp with caching optimization
    if (this.options.enableTimestamp !== false) {
      const timestamp = this.getCachedTimestamp(entry.timestamp);
      if (colors) {
        MoroLogger.appendToBuilder(MoroLogger.COLORS.timestamp);
        MoroLogger.appendToBuilder(timestamp);
        MoroLogger.appendToBuilder(levelReset);
      } else {
        MoroLogger.appendToBuilder(timestamp);
      }
      MoroLogger.appendToBuilder(' ');
    }

    // Level with pre-allocated strings
    const levelStr = MoroLogger.LEVEL_STRINGS[entry.level];
    if (colors) {
      MoroLogger.appendToBuilder(MoroLogger.COLORS[entry.level]);
      MoroLogger.appendToBuilder(MoroLogger.BOLD);
      MoroLogger.appendToBuilder(levelStr);
      MoroLogger.appendToBuilder(levelReset);
    } else {
      MoroLogger.appendToBuilder(levelStr);
    }

    // Context
    if (entry.context && this.options.enableContext !== false) {
      MoroLogger.appendToBuilder(' ');
      if (colors) {
        MoroLogger.appendToBuilder(MoroLogger.COLORS.context);
        MoroLogger.appendToBuilder(`[${entry.context}]`);
        MoroLogger.appendToBuilder(levelReset);
      } else {
        MoroLogger.appendToBuilder(`[${entry.context}]`);
      }
    }

    // Message
    MoroLogger.appendToBuilder(' ');
    MoroLogger.appendToBuilder(entry.message);

    // Performance info
    if (entry.performance && this.options.enablePerformance !== false) {
      const perfColor = colors ? MoroLogger.COLORS.performance : '';
      const perfParts: string[] = [];

      if (entry.performance.duration !== undefined) {
        perfParts.push(`${entry.performance.duration}ms`);
      }
      if (entry.performance.memory !== undefined) {
        perfParts.push(`${Math.round(entry.performance.memory)}MB`);
      }

      if (perfParts.length > 0) {
        MoroLogger.appendToBuilder(' ');
        if (colors) {
          MoroLogger.appendToBuilder(perfColor);
          MoroLogger.appendToBuilder(`(${perfParts.join(', ')})`);
          MoroLogger.appendToBuilder(levelReset);
        } else {
          MoroLogger.appendToBuilder(`(${perfParts.join(', ')})`);
        }
      }
    }

    // Metadata with optimized JSON stringify - fast empty check
    if (entry.metadata && this.options.enableMetadata !== false) {
      // Fast empty check
      let hasMetadata = false;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const _ in entry.metadata) {
        hasMetadata = true;
        break;
      }

      if (hasMetadata) {
        const metaColor = colors ? MoroLogger.COLORS.metadata : '';
        const cleanMetadata = this.cleanMetadata(entry.metadata);

        // Check cleaned metadata is not empty
        let hasCleanedData = false;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const _ in cleanMetadata) {
          hasCleanedData = true;
          break;
        }

        if (hasCleanedData) {
          MoroLogger.appendToBuilder(' ');
          if (colors) {
            MoroLogger.appendToBuilder(metaColor);
            MoroLogger.appendToBuilder(this.safeStringify(cleanMetadata));
            MoroLogger.appendToBuilder(levelReset);
          } else {
            MoroLogger.appendToBuilder(this.safeStringify(cleanMetadata));
          }
        }
      }
    }

    // Output main log line with high-performance method
    const finalMessage = MoroLogger.buildString();
    this.output(`${finalMessage}\n`, entry.level);

    // Stack trace for errors
    if (entry.metadata?.stack && (entry.level === 'error' || entry.level === 'fatal')) {
      const stackColor = colors ? MoroLogger.COLORS.error : '';
      this.output(`${stackColor}${entry.metadata.stack}${levelReset}\n`, entry.level);
    }
  }

  // Optimized metadata cleaning to avoid unnecessary object operations
  private cleanMetadata(metadata: Record<string, any>): Record<string, any> {
    const clean: Record<string, any> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (key !== 'stack') {
        clean[key] = value;
      }
    }
    return clean;
  }

  // Parallel to outputBuffer: whether each entry belongs on stderr.
  // Tagged at push time from the actual level - avoids re-scanning every
  // buffered line for 'ERROR' text (which also misrouted lines that merely
  // contained the word).
  private outputBufferIsError: boolean[] = [];

  // High-performance output with buffering
  private output(message: string, level: LogLevel = 'info'): void {
    // Prevent memory exhaustion
    if (
      this.outputBuffer.length >= this.bufferOverflowThreshold &&
      !this.emergencyFlushInProgress
    ) {
      this.emergencyFlushInProgress = true;
      this.forceFlushBuffer();
      this.emergencyFlushInProgress = false;
    }

    this.outputBuffer.push(message);
    this.outputBufferIsError.push(level === 'error' || level === 'fatal');
    this.bufferSize++;

    // Immediate flush for critical levels or full buffer
    if (level === 'fatal' || level === 'error' || this.bufferSize >= this.maxBufferSize) {
      this.flushBuffer();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimeout || this.isDestroyed) {
      return; // Already scheduled or destroyed
    }

    this.flushTimeout = setTimeout(() => {
      this.flushBuffer();
    }, this.flushInterval);

    // Unref the timeout so it doesn't prevent process exit (important for tests)
    this.flushTimeout.unref();
  }

  public flushBuffer(): void {
    if (this.outputBuffer.length === 0) {
      return;
    }

    // Group messages by the stream tag recorded at push time
    const stdoutMessages: string[] = [];
    const stderrMessages: string[] = [];

    for (let i = 0; i < this.outputBuffer.length; i++) {
      const message = this.outputBuffer[i];
      if (message === undefined) continue;
      if (this.outputBufferIsError[i]) {
        stderrMessages.push(message);
      } else {
        stdoutMessages.push(message);
      }
    }

    // Write to appropriate streams with error handling
    try {
      if (stdoutMessages.length > 0 && process.stdout.writable) {
        process.stdout.write(stdoutMessages.join(''));
      }
      if (stderrMessages.length > 0 && process.stderr.writable) {
        process.stderr.write(stderrMessages.join(''));
      }
    } catch {
      // Fallback to console if streams fail
      try {
        // eslint-disable-next-line no-console
        console.log(this.outputBuffer.join(''));
      } catch {
        // If even console.log fails, just ignore
      }
    }

    // Clear buffer
    this.outputBuffer.length = 0;
    this.outputBufferIsError.length = 0;
    this.bufferSize = 0;

    // Clear timeout
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
  }

  // Emergency flush for buffer overflow protection
  private forceFlushBuffer(): void {
    if (this.outputBuffer.length === 0) return;

    try {
      const message = this.outputBuffer.join('');
      process.stdout.write(message);
    } catch {
      // Emergency fallback - write individual messages
      for (const msg of this.outputBuffer) {
        try {
          process.stdout.write(msg);
        } catch {
          // If even this fails, give up on this batch
          break;
        }
      }
    } finally {
      this.outputBuffer.length = 0;
      this.outputBufferIsError.length = 0;
      this.bufferSize = 0;
    }
  }

  // Safe stringify with circular reference detection
  private safeStringify(obj: any, maxDepth = 3): string {
    const seen = new WeakSet();

    const stringify = (value: any, depth: number): any => {
      if (depth > maxDepth) return '[Max Depth Reached]';
      if (value === null || typeof value !== 'object') return value;
      if (seen.has(value)) return '[Circular Reference]';

      seen.add(value);

      if (Array.isArray(value)) {
        return value.map(item => stringify(item, depth + 1));
      }

      const result: any = {};
      for (const [key, val] of Object.entries(value)) {
        if (typeof val !== 'function') {
          // Skip functions
          result[key] = stringify(val, depth + 1);
        }
      }
      return result;
    };

    try {
      return JSON.stringify(stringify(obj, 0));
    } catch {
      return '[Stringify Error]';
    }
  }

  // Configuration validation
  private validateOptions(options: LoggerOptions): LoggerOptions {
    const validated = { ...options };

    // Validate log level
    const validLevels = ['debug', 'info', 'warn', 'error', 'fatal'];
    if (validated.level && !validLevels.includes(validated.level)) {
      // eslint-disable-next-line no-console
      console.warn(`[MoroLogger] Invalid log level: ${validated.level}, defaulting to 'info'`);
      validated.level = 'info';
    }

    // Validate max entries
    if (validated.maxEntries !== undefined) {
      if (validated.maxEntries < 1 || validated.maxEntries > 100000) {
        // eslint-disable-next-line no-console
        console.warn(
          `[MoroLogger] Invalid maxEntries: ${validated.maxEntries}, defaulting to 1000`
        );
        validated.maxEntries = 1000;
      }
    }

    // Validate buffer size
    if (validated.maxBufferSize !== undefined) {
      if (validated.maxBufferSize < 10 || validated.maxBufferSize > 10000) {
        // eslint-disable-next-line no-console
        console.warn(
          `[MoroLogger] Invalid maxBufferSize: ${validated.maxBufferSize}, defaulting to 1000`
        );
        validated.maxBufferSize = 1000;
      }
    }

    return validated;
  }

  // Error handling methods
  private handleOutputError(outputName: string, _error: any): void {
    // Could implement output retry logic, circuit breaker, etc.
    // For now, just track the error
    if (!this.metrics.outputErrors) {
      this.metrics.outputErrors = {};
    }
    this.metrics.outputErrors[outputName] = (this.metrics.outputErrors[outputName] || 0) + 1;
  }

  private emergencyConsoleWrite(entry: LogEntry): void {
    const message = `${entry.timestamp.toISOString()} ${entry.level.toUpperCase()} ${entry.message}`;
    try {
      if (entry.level === 'error' || entry.level === 'fatal') {
        process.stderr.write(`[EMERGENCY] ${message}\n`);
      } else {
        process.stdout.write(`[EMERGENCY] ${message}\n`);
      }
    } catch {
      // If even emergency write fails, there's nothing more we can do
    }
  }

  // Force flush streams (useful for shutdown)
  public flush(): void {
    // Clear any pending flush timeout
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    // Flush any remaining buffer
    this.flushBuffer();

    try {
      // Force flush streams without ending them
      if (process.stdout.writable) {
        process.stdout.write(''); // Force flush without ending
      }
      if (process.stderr.writable) {
        process.stderr.write(''); // Force flush without ending
      }
    } catch {
      // Ignore flush errors
    }
  }

  // Destroy logger and clean up all resources (for testing)
  public destroy(): void {
    // Mark as destroyed to prevent new timeouts
    this.isDestroyed = true;

    // Clear any remaining timeouts
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    // Flush any remaining buffer
    this.flushBuffer();

    // Clear outputs and filters
    this.outputs.clear();
    this.filters.clear();

    // Clear history
    this.history.length = 0;
    this.historyIndex = 0;
    this.historySize = 0;
  }
}

// Global logger instance
const initialLogLevel =
  process.env.LOG_LEVEL ||
  process.env.MORO_LOG_LEVEL ||
  (process.env.NODE_ENV === 'production' ? 'warn' : 'debug');

// Local boolean env parser - kept here so the global logger can be configured
// from env vars before any framework code (createApp) runs.
const parseGlobalBoolEnv = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return undefined;
};

const envMetadata = parseGlobalBoolEnv(process.env.LOG_METADATA ?? process.env.MORO_LOG_METADATA);
const envPerformance = parseGlobalBoolEnv(
  process.env.LOG_PERFORMANCE ?? process.env.MORO_LOG_PERFORMANCE
);

export const logger = new MoroLogger({
  level: initialLogLevel as LogLevel,
  enableColors: !process.env.NO_COLOR,
  format: (process.env.LOG_FORMAT as any) || 'pretty',
  // Opt-in flags - only override defaults when env var is explicitly set.
  ...(envMetadata !== undefined ? { enableMetadata: envMetadata } : {}),
  ...(envPerformance !== undefined ? { enablePerformance: envPerformance } : {}),
});

/**
 * Configure the global logger with new settings.
 * This allows runtime configuration of the logger.
 *
 * The presentation flags (enableMetadata, enablePerformance, enableTimestamp,
 * enableContext, enableColors, format) are read live from this.options on every
 * log call, so reassigning them on the existing instance takes effect immediately
 * without rebuilding the logger.
 */
export function configureGlobalLogger(options: Partial<LoggerOptions>): void {
  if (options.level) {
    logger.setLevel(options.level);
  }

  // Apply presentation toggles directly onto the live options object.
  // We touch this.options via a typed accessor to keep it explicit.
  const liveOptions = (logger as unknown as { options: LoggerOptions }).options;
  if (liveOptions === undefined || liveOptions === null) {
    return;
  }

  if (options.enableMetadata !== undefined) {
    liveOptions.enableMetadata = options.enableMetadata;
  }
  if (options.enablePerformance !== undefined) {
    liveOptions.enablePerformance = options.enablePerformance;
  }
  if (options.enableTimestamp !== undefined) {
    liveOptions.enableTimestamp = options.enableTimestamp;
  }
  if (options.enableContext !== undefined) {
    liveOptions.enableContext = options.enableContext;
  }
  if (options.enableColors !== undefined) {
    liveOptions.enableColors = options.enableColors;
  }
  if (options.format !== undefined) {
    liveOptions.format = options.format;
  }
}

/**
 * Destroy the global logger and clean up resources (for testing)
 * @internal
 */
export function destroyGlobalLogger(): void {
  logger.destroy();
}

/**
 * Apply logging configuration from the config system and/or createApp options
 */
export function applyLoggingConfiguration(
  configLogging?: any,
  appOptions?: Partial<LoggerOptions> | boolean
): void {
  // First apply config system settings (from environment variables / config files).
  // Pluck any presentation flags that map directly onto LoggerOptions.
  if (configLogging) {
    const fromConfig: Partial<LoggerOptions> = {};
    if (configLogging.level) {
      fromConfig.level = configLogging.level;
    }
    if (configLogging.format !== undefined) {
      fromConfig.format = configLogging.format;
    }
    if (configLogging.enableColors !== undefined) {
      fromConfig.enableColors = configLogging.enableColors;
    }
    if (configLogging.enableTimestamp !== undefined) {
      fromConfig.enableTimestamp = configLogging.enableTimestamp;
    }
    if (configLogging.enableContext !== undefined) {
      fromConfig.enableContext = configLogging.enableContext;
    }
    if (configLogging.enableMetadata !== undefined) {
      fromConfig.enableMetadata = configLogging.enableMetadata;
    }
    if (configLogging.enablePerformance !== undefined) {
      fromConfig.enablePerformance = configLogging.enablePerformance;
    }
    if (Object.keys(fromConfig).length > 0) {
      configureGlobalLogger(fromConfig);
    }
  }

  // Then apply createApp options (these take precedence)
  if (appOptions !== undefined) {
    if (appOptions === false) {
      // Disable logging by setting to fatal level
      configureGlobalLogger({ level: 'fatal' });
    } else if (typeof appOptions === 'object') {
      configureGlobalLogger(appOptions);
    }
  }
}

// Framework-specific logger
export const createFrameworkLogger = (context: string) => {
  return logger.child('Moro', { framework: 'moro', context });
};

// Flush any pending logs synchronously on the way out. We deliberately do NOT
// register SIGINT/SIGTERM handlers here. Registering them at import time is
// harmful either way: a non-exiting handler suppresses Node's default Ctrl-C
// termination (the app becomes unkillable), and one that calls process.exit()
// preempts the framework's own graceful-shutdown handlers (which are registered
// later, so process.exit() runs first) and masks the real signal/exit code.
// Signal handling belongs to the application/framework; the logger only ensures
// buffered logs are flushed. flush() is synchronous, so it is safe in 'exit'.
process.on('exit', () => {
  logger.flush();
});

process.on('beforeExit', () => {
  logger.flush();
});
