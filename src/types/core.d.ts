import { RuntimeConfig } from './runtime';
import { LoggerOptions } from './logger';
export interface MoroOptions {
  autoDiscover?: boolean;
  modulesPath?: string;
  middleware?: any[];
  database?: any;
  cors?: boolean | object;
  compression?: boolean | object;
  helmet?: boolean | object;
  runtime?: RuntimeConfig;
  logger?: LoggerOptions | boolean;
}
