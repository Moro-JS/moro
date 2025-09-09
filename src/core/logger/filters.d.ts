import { LogFilter } from '../../types/logger';
export declare const levelFilter: (minLevel: string) => LogFilter;
export declare const contextFilter: (allowedContexts: string[]) => LogFilter;
export declare const rateLimitFilter: (maxPerSecond: number) => LogFilter;
export declare const sanitizeFilter: (sensitiveKeys?: string[]) => LogFilter;
export declare const performanceFilter: (minDuration: number) => LogFilter;
export declare const errorAggregationFilter: (
  maxSameErrors?: number,
  timeWindow?: number
) => LogFilter;
export declare const environmentFilter: (environment: 'development' | 'production') => LogFilter;
export declare const moduleFilter: (allowedModules: string[]) => LogFilter;
