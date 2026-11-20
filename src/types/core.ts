// Core Framework Types
import { RuntimeConfig } from './runtime.js';
import { LoggerOptions } from './logger.js';
import { AppConfig, DeepPartial, RoutingConfig, ValidationErrorHandler } from './config.js';

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
          /** Accepted for compatibility but never sent: RFC 9113 forbids a server from advertising ENABLE_PUSH=1 (clients drop the connection), and whether push is possible is the client's setting, read per stream. */
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
    enabled?: boolean;
    count?: number;
    maxQueueSize?: number;
    /**
     * V8 limits for each worker thread of the pool, passed to `new Worker()`
     * as given. Not set by default.
     */
    resourceLimits?: {
      maxOldGenerationSizeMb?: number;
      maxYoungGenerationSizeMb?: number;
      codeRangeSizeMb?: number;
      stackSizeMb?: number;
    };
  };

  // Validation configuration (top-level for convenience, maps to modules.validation)
  validation?: {
    enabled?: boolean;
    stripUnknown?: boolean;
    abortEarly?: boolean;
    allowUnknown?: boolean;
    onError?: ValidationErrorHandler;
  };

  // Direct config overrides. Each section is merged into the defaults at every
  // depth, so a nested object may name only the keys it changes.
  server?: DeepPartial<AppConfig['server']>;
  database?: DeepPartial<AppConfig['database']>;
  modules?: DeepPartial<AppConfig['modules']>;
  logging?: DeepPartial<AppConfig['logging']>;
  security?: DeepPartial<AppConfig['security']>;
  external?: DeepPartial<AppConfig['external']>;
  performance?: DeepPartial<AppConfig['performance']>;
  jobs?: DeepPartial<AppConfig['jobs']>;
  /**
   * File-based routing and route middleware: `false` turns the loading of
   * route files off, an object sets `enabled`, the `paths` to load them from
   * and `strictMiddleware`.
   */
  routing?: boolean | DeepPartial<RoutingConfig>;
}
