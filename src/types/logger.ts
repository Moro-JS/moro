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
  format?: 'pretty' | 'json' | 'compact';
  outputs?: LogOutput[];
  filters?: LogFilter[];
  maxEntries?: number;
  maxBufferSize?: number;
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
  addOutput(output: LogOutput): void;
  removeOutput(name: string): void;
  addFilter(filter: LogFilter): void;
  removeFilter(name: string): void;

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
