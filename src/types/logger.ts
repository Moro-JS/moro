// Enterprise Logger Types
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: string;
  metadata?: Record<string, any>;
  requestId?: string;
  moduleId?: string;
  userId?: string;
  sessionId?: string;
  performance?: {
    duration?: number;
    memory?: number;
    cpu?: number;
  };
  stack?: string;
}

export interface LoggerOptions {
  level?: LogLevel;
  enableColors?: boolean;
  enableTimestamp?: boolean;
  enableContext?: boolean;
  enableMetadata?: boolean;
  enablePerformance?: boolean;
  enableMetrics?: boolean;
  format?: 'pretty' | 'json' | 'compact';
  outputs?: LogOutput[];
  filters?: LogFilter[];
  maxEntries?: number;
  maxBufferSize?: number;
  /**
   * Mask the values of sensitive metadata keys (`password`, `token`, `secret`,
   * `authorization`, `cookie`, `apiKey`, ...) with `[REDACTED]`, at any depth,
   * before the entry reaches filters and outputs.
   *
   * Default: on whenever the console output prints metadata, that is with
   * `format: 'json'` and with `format: 'pretty'` plus `enableMetadata: true`;
   * off otherwise. `true` turns it on for every format (useful with a custom
   * output), `false` logs metadata as it was passed, and an array turns it on
   * and adds those exact key names to the built-in list.
   */
  redact?: boolean | string[];
  /**
   * In the `pretty` and `compact` formats, write control characters found in
   * a message or context (CR, LF, ESC and the other C0 / C1 controls) as
   * visible escapes such as `\n` and `\x1b`, so a logged value cannot start a
   * new log line or send a terminal sequence. Stack frames keep their own
   * lines. Default `true`; `false` writes messages exactly as passed.
   */
  escapeControlChars?: boolean;
}

export interface LogOutput {
  name: string;
  write: (entry: LogEntry) => Promise<void> | void;
  level?: LogLevel;
  format?: 'pretty' | 'json' | 'compact';
}

export interface LogFilter {
  name: string;
  filter: (entry: LogEntry) => boolean;
}

export interface Logger {
  debug(message: string, context?: string, metadata?: Record<string, any>): void;
  info(message: string, context?: string, metadata?: Record<string, any>): void;
  warn(message: string, context?: string, metadata?: Record<string, any>): void;
  error(message: string | Error, context?: string, metadata?: Record<string, any>): void;
  fatal(message: string | Error, context?: string, metadata?: Record<string, any>): void;

  // Performance logging
  time(label: string): void;
  timeEnd(label: string, context?: string, metadata?: Record<string, any>): void;

  // Structured logging
  child(context: string, metadata?: Record<string, any>): Logger;

  // Configuration
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  addOutput(output: LogOutput): void;
  removeOutput(name: string): void;
  addFilter(filter: LogFilter): void;
  removeFilter(name: string): void;

  // Cleanup
  flush(): void;
  flushBuffer(): void;
  destroy(): void;

  // Metrics and history
  getHistory(count?: number): LogEntry[];
  getMetrics(): LogMetrics;
  clear(): void;
}

export interface LogMetrics {
  totalLogs: number;
  logsByLevel: Record<LogLevel, number>;
  logsByContext: Record<string, number>;
  averageLogRate: number;
  errorRate: number;
  memoryUsage: number;
  outputErrors?: Record<string, number>;
}

export interface ColorScheme {
  debug: string;
  info: string;
  warn: string;
  error: string;
  fatal: string;
  timestamp: string;
  context: string;
  metadata: string;
  performance: string;
  reset: string;
}
