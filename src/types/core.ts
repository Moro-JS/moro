// Core Framework Types
import { RuntimeConfig } from "./runtime";
import { LogLevel, LoggerOptions } from "./logger";

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
}
