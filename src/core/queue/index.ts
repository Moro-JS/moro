/**
 * Message Queue System for MoroJS
 * Production-ready queue support with multiple adapters
 *
 * @module queue
 */

// Core exports
export { QueueManager } from './queue-manager.js';
export { QueueAdapter } from './queue-adapter.js';

// Type exports
export type {
  QueueAdapterType,
  JobStatus,
  BackoffStrategy,
  QueueConnectionConfig,
  RetryConfig,
  DeadLetterQueueConfig,
  JobOptions,
  DefaultJobOptions,
  QueueOptions,
  Job,
  JobContext,
  JobHandler,
  BulkJobData,
  QueueMetrics,
  QueueEventType,
  QueueEvent,
  QueueStatus,
  IQueueAdapter,
  IQueueManager,
} from './types.js';

// Adapter exports
export {
  MemoryAdapter,
  BullAdapter,
  RabbitMQAdapter,
  SQSAdapter,
  KafkaAdapter,
} from './adapters/index.js';

// Middleware exports
export {
  createRateLimitMiddleware,
  RateLimiter,
  createPriorityMiddleware,
  Priority,
  PriorityQueue,
  createMonitoringMiddleware,
  QueueMetricsCollector,
  globalMetricsCollector,
  type RateLimiterOptions,
  type PriorityOptions,
  type MonitoringOptions,
  type JobMetrics,
  type QueueStats,
} from './middleware/index.js';
