// Moro Logger - Beautiful, Fast, Feature-Rich
import { performance } from 'perf_hooks';
// import { format } from 'util'; // Not currently used
import {
  LogLevel,
  LogEntry,
  LoggerOptions,
  Logger,
  LogOutput,
  LogFilter,
  LogMetrics,
  ColorScheme,
} from '../../types/logger';

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

  // Buffered output for micro-batching
  private outputBuffer: string[] = [];
  private bufferSize = 0;
  private maxBufferSize = 1024; // 1KB buffer
  private flushTimeout: NodeJS.Timeout | null = null;
  private flushInterval = 1; // 1ms micro-batching

  // High-performance output methods

  private static readonly LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4,
  };

  // Static pre-allocated strings for maximum performance
  private static readonly LEVEL_STRINGS: Record<LogLevel, string> = {
    debug: 'DEBUG',
    info: 'INFO',
    warn: 'WARN',
    error: 'ERROR',
    fatal: 'FATAL',
  };

  // Pre-allocated ANSI color codes
  private static readonly ANSI_COLORS = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
  };

  // Object pool for LogEntry reuse
  private static readonly ENTRY_POOL: LogEntry[] = [];
  private static readonly MAX_POOL_SIZE = 100;
  private static poolIndex = 0;

  // Object pool management
  private static getPooledEntry(): LogEntry {
    if (MoroLogger.poolIndex > 0) {
      return MoroLogger.ENTRY_POOL[--MoroLogger.poolIndex];
    }
    return {
      timestamp: new Date(),
      level: 'info',
      message: '',
      context: undefined,
      metadata: undefined,
    };
  }

  private static returnPooledEntry(entry: LogEntry): void {
    if (MoroLogger.poolIndex < MoroLogger.MAX_POOL_SIZE) {
      // Reset the entry
      entry.timestamp = new Date();
      entry.level = 'info';
      entry.message = '';
      entry.context = undefined;
      entry.metadata = undefined;
      MoroLogger.ENTRY_POOL[MoroLogger.poolIndex++] = entry;
    }
  }

  // String builder for efficient concatenation
  private static stringBuilder: string[] = [];
  private static stringBuilderIndex = 0;

  private static resetStringBuilder(): void {
    MoroLogger.stringBuilderIndex = 0;
  }

  private static appendToBuilder(str: string): void {
    if (MoroLogger.stringBuilderIndex < MoroLogger.stringBuilder.length) {
      MoroLogger.stringBuilder[MoroLogger.stringBuilderIndex++] = str;
    } else {
      MoroLogger.stringBuilder.push(str);
      MoroLogger.stringBuilderIndex++;
    }
  }

  private static buildString(): string {
    const result = MoroLogger.stringBuilder.slice(0, MoroLogger.stringBuilderIndex).join('');
    MoroLogger.resetStringBuilder();
    return result;
  }

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
  };

  private static readonly RESET = '\x1b[0m';
  private static readonly BOLD = '\x1b[1m';

  constructor(options: LoggerOptions = {}) {
    this.options = {
      level: 'info',
      enableColors: true,
      enableTimestamp: true,
      enableContext: true,
      enableMetadata: true,
      enablePerformance: true,
      format: 'pretty',
      outputs: [],
      filters: [],
      maxEntries: 1000,
      ...options,
    };

    this.level = this.options.level || 'info';

    // Add default console output
    this.addOutput({
      name: 'console',
      write: this.writeToConsole.bind(this),
      format: this.options.format,
    });

    // Add custom outputs
    this.options.outputs?.forEach(output => this.addOutput(output));
    this.options.filters?.forEach(filter => this.addFilter(filter));
  }

  debug(message: string, context?: string, metadata?: Record<string, any>): void {
    this.log('debug', message, context, metadata);
  }

  info(message: string, context?: string, metadata?: Record<string, any>): void {
    this.log('info', message, context, metadata);
  }

  warn(message: string, context?: string, metadata?: Record<string, any>): void {
    this.log('warn', message, context, metadata);
  }

  error(message: string | Error, context?: string, metadata?: Record<string, any>): void {
    const msg = message instanceof Error ? message.message : message;
    const stack = message instanceof Error ? message.stack : undefined;
    this.log('error', msg, context, { ...metadata, stack });
  }

  fatal(message: string | Error, context?: string, metadata?: Record<string, any>): void {
    const msg = message instanceof Error ? message.message : message;
    const stack = message instanceof Error ? message.stack : undefined;
    this.log('fatal', msg, context, { ...metadata, stack });
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

  child(context: string, metadata?: Record<string, any>): Logger {
    const childLogger = new MoroLogger(this.options);
    childLogger.contextPrefix = this.contextPrefix ? `${this.contextPrefix}:${context}` : context;
    childLogger.contextMetadata = { ...this.contextMetadata, ...metadata };
    childLogger.outputs = this.outputs;
    childLogger.filters = this.filters;

    // Keep reference to parent for level inheritance
    (childLogger as any).parent = this;

    return childLogger;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
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

  // Optimized logging method with aggressive level checking
  private log(
    level: LogLevel,
    message: string,
    context?: string,
    metadata?: Record<string, any>
  ): void {
    // AGGRESSIVE LEVEL CHECK - numeric comparison for maximum speed
    const levelNum = MoroLogger.LEVELS[level];
    const effectiveLevelNum = this.parent
      ? MoroLogger.LEVELS[this.parent.level]
      : MoroLogger.LEVELS[this.level];

    if (levelNum < effectiveLevelNum) {
      return; // Exit immediately if level is too low
    }

    // ULTRA-FAST PATH: Just message, no context, no metadata
    if (!metadata && !context && !this.contextPrefix && !this.contextMetadata) {
      const levelStr = MoroLogger.LEVEL_STRINGS[level];
      this.output(`${levelStr} ${message}\n`, level);
      return;
    }

    // FAST PATH: Message + context, no metadata
    if (!metadata && !this.contextMetadata) {
      const levelStr = MoroLogger.LEVEL_STRINGS[level];
      if (context) {
        this.output(`${levelStr} [${context}] ${message}\n`, level);
      } else {
        this.output(`${levelStr} ${message}\n`, level);
      }
      return;
    }

    // MEDIUM PATH: Message + context + simple metadata
    if (metadata && Object.keys(metadata).length <= 3 && !this.contextMetadata) {
      const levelStr = MoroLogger.LEVEL_STRINGS[level];
      const contextStr = context ? `[${context}] ` : '';
      const metaStr = this.stringify(metadata);
      this.output(`${levelStr} ${contextStr}${message} ${metaStr}\n`, level);
      return;
    }

    // FULL PATH: All features enabled
    this.fullLog(level, message, context, metadata);
  }

  // Full logging with all features using object pooling
  private fullLog(
    level: LogLevel,
    message: string,
    context?: string,
    metadata?: Record<string, any>
  ): void {
    // Get pooled entry to avoid allocation
    const entry = MoroLogger.getPooledEntry();
    const now = Date.now();

    entry.timestamp = new Date(now);
    entry.level = level;
    entry.message = message;
    entry.context = this.contextPrefix
      ? context
        ? `${this.contextPrefix}:${context}`
        : this.contextPrefix
      : context;
    entry.metadata = this.createMetadata(metadata);
    entry.performance = this.options.enablePerformance ? this.getPerformanceData(now) : undefined;

    // Apply filters with early return optimization
    if (this.filters.size > 0) {
      for (const filter of this.filters.values()) {
        if (!filter.filter(entry)) {
          return;
        }
      }
    }

    // Update metrics
    this.updateMetrics(entry);

    // Store in history with circular buffer optimization
    this.addToHistory(entry);

    // Write to outputs with batched processing
    this.writeToOutputs(entry, level);

    // Return entry to pool after a short delay to allow async operations
    setTimeout(() => MoroLogger.returnPooledEntry(entry), 0);
  }

  private updateMetrics(entry: LogEntry): void {
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

    for (const output of this.outputs.values()) {
      if (!output.level || MoroLogger.LEVELS[level] >= MoroLogger.LEVELS[output.level]) {
        try {
          output.write(entry);
        } catch (error) {
          // Fallback to console.error for logger errors
          // eslint-disable-next-line no-console
          console.error('Logger output error:', error);
        }
      }
    }
  }

  private writeToConsole(entry: LogEntry): void {
    const format = this.options.format || 'pretty';

    if (format === 'json') {
      this.output(JSON.stringify(entry) + '\n', entry.level);
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
    MoroLogger.resetStringBuilder();

    // Timestamp with caching optimization
    if (this.options.enableTimestamp !== false) {
      const timestamp = this.getCachedTimestamp(entry.timestamp);
      if (colors) {
        MoroLogger.appendToBuilder(MoroLogger.COLORS.timestamp);
        MoroLogger.appendToBuilder(timestamp);
        MoroLogger.appendToBuilder(MoroLogger.RESET);
      } else {
        MoroLogger.appendToBuilder(timestamp);
      }
    }

    // Level with color using pre-allocated strings
    const levelColor = colors ? MoroLogger.COLORS[entry.level] : '';
    const levelReset = colors ? MoroLogger.RESET : '';
    const levelText = MoroLogger.LEVEL_STRINGS[entry.level];

    // Add space after timestamp if present
    if (this.options.enableTimestamp !== false) {
      MoroLogger.appendToBuilder(' ');
    }

    if (colors) {
      MoroLogger.appendToBuilder(levelColor);
      MoroLogger.appendToBuilder(MoroLogger.BOLD);
      MoroLogger.appendToBuilder(levelText);
      MoroLogger.appendToBuilder(levelReset);
    } else {
      MoroLogger.appendToBuilder(levelText);
    }

    // Context
    if (entry.context && this.options.enableContext !== false) {
      const contextColor = colors ? MoroLogger.COLORS.context : '';
      MoroLogger.appendToBuilder(' '); // Space before context
      if (colors) {
        MoroLogger.appendToBuilder(contextColor);
        MoroLogger.appendToBuilder(`[${entry.context}]`);
        MoroLogger.appendToBuilder(levelReset);
      } else {
        MoroLogger.appendToBuilder(`[${entry.context}]`);
      }
    }

    // Message
    MoroLogger.appendToBuilder(' '); // Space before message
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
        MoroLogger.appendToBuilder(' '); // Space before performance info
        if (colors) {
          MoroLogger.appendToBuilder(perfColor);
          MoroLogger.appendToBuilder(`(${perfParts.join(', ')})`);
          MoroLogger.appendToBuilder(levelReset);
        } else {
          MoroLogger.appendToBuilder(`(${perfParts.join(', ')})`);
        }
      }
    }

    // Metadata with optimized JSON stringify
    if (
      entry.metadata &&
      Object.keys(entry.metadata).length > 0 &&
      this.options.enableMetadata !== false
    ) {
      const metaColor = colors ? MoroLogger.COLORS.metadata : '';
      const cleanMetadata = this.cleanMetadata(entry.metadata);

      if (Object.keys(cleanMetadata).length > 0) {
        if (colors) {
          MoroLogger.appendToBuilder(metaColor);
          MoroLogger.appendToBuilder(this.stringify(cleanMetadata));
          MoroLogger.appendToBuilder(levelReset);
        } else {
          MoroLogger.appendToBuilder(this.stringify(cleanMetadata));
        }
      }
    }

    // Output main log line with high-performance method
    const finalMessage = MoroLogger.buildString();
    this.output(finalMessage + '\n', entry.level);

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

  // Fast JSON stringify with error handling
  private stringify(obj: any): string {
    try {
      return JSON.stringify(obj);
    } catch {
      return '[Circular Reference]';
    }
  }

  // High-performance output with micro-batching
  private output(message: string, level: LogLevel = 'info'): void {
    // Add to buffer
    this.outputBuffer.push(message);
    this.bufferSize += message.length;

    // Flush immediately if buffer is full or for errors
    if (this.bufferSize >= this.maxBufferSize || level === 'error' || level === 'fatal') {
      this.flushBuffer();
    } else {
      // Schedule flush with micro-batching
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimeout) return; // Already scheduled

    this.flushTimeout = setTimeout(() => {
      this.flushBuffer();
      this.flushTimeout = null;
    }, this.flushInterval);
  }

  private flushBuffer(): void {
    if (this.outputBuffer.length === 0) return;

    try {
      // Group by stream type for efficiency
      const stdoutMessages: string[] = [];
      const stderrMessages: string[] = [];

      for (const message of this.outputBuffer) {
        // Determine stream based on message content (simple heuristic)
        if (message.includes('ERROR') || message.includes('FATAL')) {
          stderrMessages.push(message);
        } else {
          stdoutMessages.push(message);
        }
      }

      // Write to streams
      if (stdoutMessages.length > 0) {
        process.stdout.write(stdoutMessages.join(''));
      }
      if (stderrMessages.length > 0) {
        process.stderr.write(stderrMessages.join(''));
      }
    } catch {
      // Fallback to console methods if stream write fails
      for (const message of this.outputBuffer) {
        if (message.includes('ERROR') || message.includes('FATAL')) {
          // eslint-disable-next-line no-console
          console.error(message.trim());
        } else {
          // eslint-disable-next-line no-console
          console.log(message.trim());
        }
      }
    }

    // Reset buffer
    this.outputBuffer.length = 0;
    this.bufferSize = 0;
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
      // Force flush streams
      if (process.stdout.writable) {
        process.stdout.end();
      }
      if (process.stderr.writable) {
        process.stderr.end();
      }
    } catch {
      // Ignore flush errors
    }
  }

  // Cleanup method to clear all timeouts and handles
  public cleanup(): void {
    // Clear any pending flush timeout
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    // Flush any remaining output
    this.flushBuffer();
  }
}

// Global logger instance
const initialLogLevel =
  process.env.LOG_LEVEL ||
  process.env.MORO_LOG_LEVEL ||
  (process.env.NODE_ENV === 'production' ? 'warn' : 'debug');

export const logger = new MoroLogger({
  level: initialLogLevel as LogLevel,
  enableColors: !process.env.NO_COLOR,
  format: (process.env.LOG_FORMAT as any) || 'pretty',
});

// Add cleanup handlers for Jest and other test runners
if (typeof process !== 'undefined') {
  // Cleanup on process exit
  process.on('beforeExit', () => {
    logger.cleanup();
  });

  process.on('SIGINT', () => {
    logger.cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.cleanup();
    process.exit(0);
  });

  // For Jest and other test runners - cleanup on uncaught exceptions
  process.on('uncaughtException', () => {
    logger.cleanup();
  });

  process.on('unhandledRejection', () => {
    logger.cleanup();
  });
}

/**
 * Configure the global logger with new settings
 * This allows runtime configuration of the logger
 */
export function configureGlobalLogger(options: Partial<LoggerOptions>): void {
  if (options.level) {
    logger.setLevel(options.level);
  }
  // Additional configuration options can be added here as needed
  // For now, focusing on level which is the most critical
}

/**
 * Apply logging configuration from the config system and/or createApp options
 */
export function applyLoggingConfiguration(
  configLogging?: any,
  appOptions?: Partial<LoggerOptions> | boolean
): void {
  // First apply config system settings (from environment variables)
  if (configLogging?.level) {
    configureGlobalLogger({ level: configLogging.level });
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

// Graceful shutdown handler to flush any pending logs
process.on('SIGINT', () => {
  logger.flush();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.flush();
  process.exit(0);
});

process.on('beforeExit', () => {
  logger.flush();
});
