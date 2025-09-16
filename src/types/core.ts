// Core Framework Types
import { RuntimeConfig } from './runtime';
import { LogLevel, LoggerOptions } from './logger';

export interface MoroOptions {
  autoDiscover?: boolean;
  modulesPath?: string;
  middleware?: any[];
  database?: any;
  cors?: boolean | object;
  compression?: boolean | object;
  helmet?: boolean | object;
  // Runtime configuration
  runtime?: RuntimeConfig;
  // Logger configuration
  logger?: LoggerOptions | boolean;
  // Module configuration
  modules?: {
    cache?: {
      enabled?: boolean;
      defaultTtl?: number;
      maxSize?: number;
      strategy?: 'lru' | 'lfu' | 'fifo';
    };
    rateLimit?: {
      enabled?: boolean;
      defaultRequests?: number;
      defaultWindow?: number;
      skipSuccessfulRequests?: boolean;
      skipFailedRequests?: boolean;
    };
    validation?: {
      enabled?: boolean;
      stripUnknown?: boolean;
      abortEarly?: boolean;
    };
  };
  // Performance configuration
  performance?: {
    clustering?: {
      enabled?: boolean;
      workers?: number | 'auto';
    };
    compression?: {
      enabled?: boolean;
      level?: number;
      threshold?: number;
    };
    circuitBreaker?: {
      enabled?: boolean;
      failureThreshold?: number;
      resetTimeout?: number;
      monitoringPeriod?: number;
    };
  };
}
