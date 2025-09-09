import {
  LogLevel,
  LogEntry,
  LoggerOptions,
  Logger,
  LogOutput,
  LogFilter,
  LogMetrics,
} from '../../types/logger';
export declare class MoroLogger implements Logger {
  private level;
  private options;
  private outputs;
  private filters;
  private history;
  private timers;
  private metrics;
  private startTime;
  private contextPrefix?;
  private contextMetadata?;
  private static readonly LEVELS;
  private static readonly COLORS;
  private static readonly RESET;
  private static readonly BOLD;
  constructor(options?: LoggerOptions);
  debug(message: string, context?: string, metadata?: Record<string, any>): void;
  info(message: string, context?: string, metadata?: Record<string, any>): void;
  warn(message: string, context?: string, metadata?: Record<string, any>): void;
  error(message: string | Error, context?: string, metadata?: Record<string, any>): void;
  fatal(message: string | Error, context?: string, metadata?: Record<string, any>): void;
  time(label: string): void;
  timeEnd(label: string, context?: string, metadata?: Record<string, any>): void;
  child(context: string, metadata?: Record<string, any>): Logger;
  setLevel(level: LogLevel): void;
  addOutput(output: LogOutput): void;
  removeOutput(name: string): void;
  addFilter(filter: LogFilter): void;
  removeFilter(name: string): void;
  getHistory(count?: number): LogEntry[];
  getMetrics(): LogMetrics;
  clear(): void;
  private log;
  private updateMetrics;
  private writeToConsole;
  private writePrettyLog;
}
export declare const logger: MoroLogger;
/**
 * Configure the global logger with new settings
 * This allows runtime configuration of the logger
 */
export declare function configureGlobalLogger(options: Partial<LoggerOptions>): void;
/**
 * Apply logging configuration from the config system and/or createApp options
 */
export declare function applyLoggingConfiguration(
  configLogging?: any,
  appOptions?: Partial<LoggerOptions> | boolean
): void;
export declare const createFrameworkLogger: (context: string) => Logger;
