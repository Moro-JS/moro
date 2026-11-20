// Advanced Logger Filters
import { LogEntry, LogFilter } from '../../types/logger.js';

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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return allowedContexts.some(ctx => entry.context!.includes(ctx));
  },
});

// Rate limiting filter
export const rateLimitFilter = (maxPerSecond: number): LogFilter => {
  const timestamps: number[] = [];
  let lastCleanup = 0;

  return {
    name: 'rate-limit',
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    filter: (entry: LogEntry) => {
      const now = Date.now();

      // Batch cleanup for better performance and thread safety
      if (now - lastCleanup > 1000) {
        const cutoff = now - 1000;
        let keepIndex = 0;
        for (let i = 0; i < timestamps.length; i++) {
          const ts = timestamps[i];
          if (ts !== undefined && ts >= cutoff) {
            timestamps[keepIndex++] = ts;
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

const REDACTED = '[REDACTED]';

// Keys that are always treated as sensitive, whatever list the caller passes
const ALWAYS_SENSITIVE_KEYS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie'];

// A key containing one of these (case-insensitive) is sensitive:
// accessToken, client_secret, dbPassword, keyPassphrase, apiKey, x-api-key, ...
const SENSITIVE_KEY_PATTERN = /token|secret|password|passphrase|api[-_]?key/i;

// Nested metadata is sanitized down to this depth; anything deeper is dropped
const SANITIZE_MAX_DEPTH = 8;

// `Authorization: Bearer abc`, `cookie: a=1; b=2` - the value runs to the end
// of the line (or the closing quote), not just to the next space.
const HEADER_IN_MESSAGE =
  /((?<![A-Za-z0-9_.-])(?:proxy-)?(?:authorization|set-cookie|cookie)["'\s]*[:=]["'\s]*)([^\r\n"']+)/gi;

// `name=value`, `name: value`, `"name":"value"` - one whole word, then the value
const PAIR_IN_MESSAGE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["\s]*[:=]["\s]*)([^"\s]+)/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Built-in redaction (LoggerOptions.redact)

// Names masked whatever the value is (case-insensitive, exact)
const REDACT_EXACT_KEYS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookies',
  'set-cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'passphrase',
  'apikey',
  'api_key',
  'api-key',
];

// A name containing one of these is masked when the value could hold a
// credential: accessToken, client_secret, dbPassword, x-api-key, privateKey.
// Numbers and booleans under such a name are left alone (tokenCount: 512,
// hasPassword: true); an exact name above masks those too.
const REDACT_KEY_PATTERN =
  /token|secret|password|passwd|passphrase|api[-_]?key|private[-_]?key|credential/i;

// Nested metadata is copied down to this depth; anything deeper is replaced
const REDACT_MAX_DEPTH = 8;

// Key classifications are remembered up to this many distinct names
const REDACT_KEY_CACHE_SIZE = 2000;

const KEY_PLAIN = 0;
const KEY_PATTERN = 1;
const KEY_EXACT = 2;

/**
 * Returns a copy of log metadata with the values of sensitive keys replaced by
 * `[REDACTED]`. See {@link createMetadataRedactor}.
 */
export interface MetadataRedactor {
  /**
   * @param metadata The metadata to copy
   * @param base Keys laid underneath `metadata` (which wins on a clash), so a
   *   logger's own context metadata and a call's metadata are merged and
   *   redacted in one pass
   */
  (metadata: Record<string, any>, base?: Record<string, any>): Record<string, any>;
  /** Whether `value`, stored under `key`, is replaced. */
  shouldMask(key: string, value: unknown): boolean;
}

/**
 * Build the redactor the logger applies when `redact` is on.
 *
 * Keys are matched case-insensitively at any depth of plain objects and
 * arrays, down to 8 levels (deeper values become `'[MaxDepth]'`); shared and
 * circular references are handled. The object passed in is never modified.
 * Class instances (a Date, an Error, a Buffer, an ORM entity) are passed
 * through as they are; the logger's own serializer applies `shouldMask` to
 * their fields when it prints them.
 *
 * Masked: `authorization`, `proxy-authorization`, `cookie`, `cookies`,
 * `set-cookie`, `password`, `passwd`, `secret`, `token`, `passphrase`,
 * `apiKey` / `api_key` / `api-key`, every name in `extraKeys`, and any name
 * containing `token`, `secret`, `password`, `passwd`, `passphrase`, `apiKey`,
 * `privateKey` or `credential` unless its value is a number or a boolean.
 * Empty strings, `null` and `undefined` are left as they are.
 *
 * @param extraKeys More exact key names to mask (case-insensitive)
 */
export function createMetadataRedactor(extraKeys: readonly string[] = []): MetadataRedactor {
  const exactKeys = new Set(
    [...REDACT_EXACT_KEYS, ...extraKeys].map(key => String(key).toLowerCase())
  );
  const classified = new Map<string, number>();

  const classify = (key: string): number => {
    let kind = classified.get(key);
    if (kind === undefined) {
      kind = exactKeys.has(key.toLowerCase())
        ? KEY_EXACT
        : REDACT_KEY_PATTERN.test(key)
          ? KEY_PATTERN
          : KEY_PLAIN;
      if (classified.size < REDACT_KEY_CACHE_SIZE) classified.set(key, kind);
    }
    return kind;
  };

  const shouldMask = (key: string, value: unknown): boolean => {
    if (value === null || value === undefined || value === '') return false;
    const kind = classify(key);
    if (kind === KEY_PLAIN) return false;
    if (kind === KEY_EXACT) return true;
    return typeof value !== 'number' && typeof value !== 'boolean';
  };

  const copyValue = (value: unknown, depth: number, seen: WeakMap<object, unknown>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const isArray = Array.isArray(value);
    if (!isArray && !isPlainObject(value)) return value;

    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    if (depth >= REDACT_MAX_DEPTH) return '[MaxDepth]';

    if (isArray) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      for (const item of value as unknown[]) {
        copy.push(copyValue(item, depth + 1, seen));
      }
      return copy;
    }

    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    seen.set(source, copy);
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const item = source[key];
      copy[key] = shouldMask(key, item) ? REDACTED : copyValue(item, depth + 1, seen);
    }
    return copy;
  };

  // Flat metadata is the common case: the reference map is only created once
  // a nested object or array turns up.
  let seen: WeakMap<object, unknown> | undefined;

  const copyInto = (copy: Record<string, any>, source: Record<string, any>): void => {
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const item = source[key];
      if (shouldMask(key, item)) {
        copy[key] = REDACTED;
      } else if (item !== null && typeof item === 'object') {
        if (seen === undefined) {
          seen = new WeakMap();
          seen.set(source, copy);
        }
        copy[key] = copyValue(item, 1, seen);
      } else {
        copy[key] = item;
      }
    }
  };

  const redact = (
    metadata: Record<string, any>,
    base?: Record<string, any>
  ): Record<string, any> => {
    const copy: Record<string, any> = {};
    seen = undefined;
    try {
      if (base !== undefined) copyInto(copy, base);
      copyInto(copy, metadata);
    } finally {
      seen = undefined;
    }
    return copy;
  };

  redact.shouldMask = shouldMask;
  return redact;
}

/**
 * Split an identifier into lower-case words: `privateKey`, `private_key` and
 * `PRIVATE-KEY` all give ['private', 'key']; `monkey` gives ['monkey'].
 */
function identifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Redacts sensitive values from log metadata and messages. Opt-in: add it with
 * `logger.addFilter(sanitizeFilter())`. It goes further than the logger's
 * built-in `redact` option, which masks metadata keys only: this filter also
 * rewrites credentials written into the message text.
 *
 * Metadata keys are matched case-insensitively at any depth (plain objects and
 * arrays; cycles are handled). A key is sensitive when it is one of
 * `sensitiveKeys`, is `authorization`, `cookie` or `set-cookie`, or contains
 * `token`, `secret`, `password`, `passphrase` or `api[-_]?key`. The caller's
 * metadata object is never modified; the entry gets a sanitized copy.
 *
 * In the message, `name=value` / `name: value` pairs are redacted when `name`
 * is sensitive by the same rules or has one of `sensitiveKeys` as a whole word
 * (`privateKey`, `api_key`, but not `monkey`).
 *
 * @param sensitiveKeys Extra exact key names (default: password, token, key, secret)
 */
export const sanitizeFilter = (
  sensitiveKeys: string[] = ['password', 'token', 'key', 'secret']
): LogFilter => {
  const exactKeys = new Set(
    [...sensitiveKeys, ...ALWAYS_SENSITIVE_KEYS].map(key => String(key).toLowerCase())
  );

  const isSensitiveKey = (key: string): boolean =>
    exactKeys.has(key.toLowerCase()) || SENSITIVE_KEY_PATTERN.test(key);

  const isSensitiveWord = (word: string): boolean =>
    isSensitiveKey(word) || identifierWords(word).some(part => exactKeys.has(part));

  const sanitizeValue = (
    value: unknown,
    depth: number,
    seen: WeakMap<object, unknown>
  ): unknown => {
    const isArray = Array.isArray(value);
    if (!isArray && !isPlainObject(value)) {
      return value;
    }

    const source = value as object;
    const existing = seen.get(source);
    if (existing !== undefined) {
      return existing; // shared or circular reference: reuse the sanitized copy
    }
    if (depth >= SANITIZE_MAX_DEPTH) {
      return '[MaxDepth]';
    }

    if (isArray) {
      const copy: unknown[] = [];
      seen.set(source, copy);
      for (const item of value as unknown[]) {
        copy.push(sanitizeValue(item, depth + 1, seen));
      }
      return copy;
    }

    const copy: Record<string, unknown> = {};
    seen.set(source, copy);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = item && isSensitiveKey(key) ? REDACTED : sanitizeValue(item, depth + 1, seen);
    }
    return copy;
  };

  return {
    name: 'sanitize',
    filter: (entry: LogEntry) => {
      if (entry.metadata) {
        // The top level is always copied (own enumerable properties), as before
        const metadata =
          isPlainObject(entry.metadata) || Array.isArray(entry.metadata)
            ? entry.metadata
            : { ...entry.metadata };
        entry.metadata = sanitizeValue(metadata, 0, new WeakMap()) as Record<string, any>;
      }

      // Also sanitize message content
      if (typeof entry.message === 'string') {
        entry.message = entry.message
          .replace(HEADER_IN_MESSAGE, `$1${REDACTED}`)
          .replace(PAIR_IN_MESSAGE, (match, word: string, separator: string) =>
            isSensitiveWord(word) ? `${word}${separator}${REDACTED}` : match
          );
      }

      return true;
    },
  };
};

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
