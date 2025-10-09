// Core Framework Types
import { RuntimeConfig } from './runtime.js';
import { LogLevel, LoggerOptions } from './logger.js';
import { AppConfig } from './config.js';

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
  http2?: boolean;
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

  // Direct config overrides (partial)
  server?: Partial<AppConfig['server']>;
  database?: Partial<AppConfig['database']>;
  modules?: Partial<AppConfig['modules']>;
  logging?: Partial<AppConfig['logging']>;
  security?: Partial<AppConfig['security']>;
  external?: Partial<AppConfig['external']>;
  performance?: Partial<AppConfig['performance']>;
}
