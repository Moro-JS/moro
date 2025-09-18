// Advanced Logger Filters
import { LogEntry, LogFilter } from '../../types/logger';

// Level-based filter
export const levelFilter = (minLevel: string): LogFilter => ({
  name: `level-${minLevel}`,
  filter: (entry: LogEntry) => {
    const levels = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
    return levels[entry.level] >= levels[minLevel as keyof typeof levels];
  },
});

// Context-based filter
export const contextFilter = (allowedContexts: string[]): LogFilter => ({
  name: 'context-filter',
  filter: (entry: LogEntry) => {
    if (!entry.context) return true;
    return allowedContexts.some(ctx => entry.context!.includes(ctx));
  },
});

// Rate limiting filter
export const rateLimitFilter = (maxPerSecond: number): LogFilter => {
  const timestamps: number[] = [];
  let lastCleanup = 0;

  return {
    name: 'rate-limit',
    filter: (entry: LogEntry) => {
      const now = Date.now();

      // Batch cleanup for better performance and thread safety
      if (now - lastCleanup > 1000) {
        const cutoff = now - 1000;
        let keepIndex = 0;
        for (let i = 0; i < timestamps.length; i++) {
          if (timestamps[i] >= cutoff) {
            timestamps[keepIndex++] = timestamps[i];
          }
        }
        timestamps.length = keepIndex;
        lastCleanup = now;
      }

      // Check rate limit
      if (timestamps.length >= maxPerSecond) {
        return false;
      }

      timestamps.push(now);
      return true;
    },
  };
};

// Sensitive data filter
export const sanitizeFilter = (
  sensitiveKeys: string[] = ['password', 'token', 'key', 'secret']
): LogFilter => ({
  name: 'sanitize',
  filter: (entry: LogEntry) => {
    if (entry.metadata) {
      const sanitized = { ...entry.metadata };

      for (const key of sensitiveKeys) {
        if (sanitized[key]) {
          sanitized[key] = '[REDACTED]';
        }
      }

      entry.metadata = sanitized;
    }

    // Also sanitize message content
    let sanitizedMessage = entry.message;
    for (const key of sensitiveKeys) {
      const regex = new RegExp(`(${key}["\\s]*[:=]["\\s]*)([^"\\s]+)`, 'gi');
      sanitizedMessage = sanitizedMessage.replace(regex, '$1[REDACTED]');
    }
    entry.message = sanitizedMessage;

    return true;
  },
});

// Performance filter - only log slow operations
export const performanceFilter = (minDuration: number): LogFilter => ({
  name: 'performance',
  filter: (entry: LogEntry) => {
    if (!entry.performance?.duration) return true;
    return entry.performance.duration >= minDuration;
  },
});

// Error aggregation filter - prevent spam
export const errorAggregationFilter = (
  maxSameErrors: number = 5,
  timeWindow: number = 60000
): LogFilter => {
  const errorCounts = new Map<string, { count: number; firstSeen: number }>();

  return {
    name: 'error-aggregation',
    filter: (entry: LogEntry) => {
      if (entry.level !== 'error' && entry.level !== 'fatal') return true;

      const errorKey = `${entry.message}:${entry.context || ''}`;
      const now = Date.now();
      const existing = errorCounts.get(errorKey);

      if (!existing) {
        errorCounts.set(errorKey, { count: 1, firstSeen: now });
        return true;
      }

      // Reset if outside time window
      if (now - existing.firstSeen > timeWindow) {
        errorCounts.set(errorKey, { count: 1, firstSeen: now });
        return true;
      }

      // Check if we've exceeded the limit
      if (existing.count >= maxSameErrors) {
        return false;
      }

      existing.count++;
      return true;
    },
  };
};

// Development vs Production filter
export const environmentFilter = (environment: 'development' | 'production'): LogFilter => ({
  name: `env-${environment}`,
  filter: (entry: LogEntry) => {
    if (environment === 'production') {
      // In production, filter out debug logs and sensitive development info
      if (entry.level === 'debug') return false;
      if (entry.context?.includes('dev') || entry.context?.includes('test')) return false;
    }
    return true;
  },
});

// Module-specific filter
export const moduleFilter = (allowedModules: string[]): LogFilter => ({
  name: 'module-filter',
  filter: (entry: LogEntry) => {
    if (!entry.moduleId) return true;
    return allowedModules.includes(entry.moduleId);
  },
});
