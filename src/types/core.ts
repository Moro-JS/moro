// Core Framework Types
import { RuntimeConfig } from './runtime.js';
import { LoggerOptions } from './logger.js';
import { AppConfig, ValidationErrorHandler } from './config.js';

export interface MoroOptions {
  autoDiscover?:
    | boolean
    | {
        enabled?: boolean;
        paths?: string[];
        patterns?: string[];
        recursive?: boolean;
        loadingStrategy?: 'eager' | 'lazy' | 'conditional';
        watchForChanges?: boolean;
        ignorePatterns?: string[];
        loadOrder?: 'alphabetical' | 'dependency' | 'custom';
        failOnError?: boolean;
        maxDepth?: number;
      };
  modulesPath?: string; // Deprecated: use autoDiscover.paths instead
  middleware?: any[];

  // Runtime configuration
  runtime?: RuntimeConfig;

  // HTTP/WebSocket options
  http2?:
    | boolean
    | {
        allowHTTP1?: boolean;
        maxSessionMemory?: number;
        settings?: {
          headerTableSize?: number;
          enablePush?: boolean;
          initialWindowSize?: number;
          maxFrameSize?: number;
          maxConcurrentStreams?: number;
          maxHeaderListSize?: number;
          maxHeaderSize?: number;
          enableConnectProtocol?: boolean;
        };
      };
  https?: {
    key: string | Buffer;
    cert: string | Buffer;
    ca?: string | Buffer;
  };
  websocket?:
    | {
        enabled?: boolean;
        adapter?: any;
        compression?: boolean;
        customIdGenerator?: () => string;
        options?: any;
      }
    | false;

  // Simplified config options (these map to the full config)
  cors?: boolean | object;
  compression?: boolean | object;
  helmet?: boolean | object;
  logger?: LoggerOptions | boolean;

  // Worker threads configuration
  workers?: {
    count?: number;
    maxQueueSize?: number;
  };

  // Validation configuration (top-level for convenience, maps to modules.validation)
  validation?: {
    enabled?: boolean;
    stripUnknown?: boolean;
    abortEarly?: boolean;
    allowUnknown?: boolean;
    onError?: ValidationErrorHandler;
  };

  // Direct config overrides (partial)
  server?: Partial<AppConfig['server']>;
  database?: Partial<AppConfig['database']>;
  modules?: Partial<AppConfig['modules']>;
  logging?: Partial<AppConfig['logging']>;
  security?: Partial<AppConfig['security']>;
  external?: Partial<AppConfig['external']>;
  performance?: Partial<AppConfig['performance']>;
  jobs?: Partial<AppConfig['jobs']>;
}
