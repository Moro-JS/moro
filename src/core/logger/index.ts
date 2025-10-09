// Logger System - Main Exports
export {
  MoroLogger,
  logger,
  createFrameworkLogger,
  configureGlobalLogger,
  applyLoggingConfiguration,
  destroyGlobalLogger,
} from './logger.js';
export * from './filters.js';

export type {
  LogLevel,
  LogEntry,
  LoggerOptions,
  Logger,
  LogOutput,
  LogFilter,
  LogMetrics,
  ColorScheme,
} from '../../types/logger.js';
