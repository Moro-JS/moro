// Shared Path Matching Utility with Caching
// Replaces 6 different pathToRegex implementations across the codebase

export interface CompiledPath {
  pattern: RegExp | null;
  paramNames: string[];
  isStatic: boolean;
  path: string;
  segments: number;
}

export interface MatchResult {
  params: Record<string, string>;
}

/**
 * LRU Cache implementation for compiled paths
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Remove if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Add to end
    this.cache.set(key, value);

    // Evict oldest if over capacity
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * PathMatcher - Single source of truth for path pattern compilation and matching
 */
export class PathMatcher {
  private static readonly cache = new LRUCache<string, CompiledPath>(1000);
  private static compilationCount = 0;
  private static cacheHits = 0;
  private static cacheMisses = 0;

  /**
   * Compile a path pattern into an efficient matching structure
   * Results are cached for performance
   */
  static compile(path: string): CompiledPath {
    // Check cache first
    const cached = this.cache.get(path);
    if (cached) {
      this.cacheHits++;
      return cached;
    }

    this.cacheMisses++;
    this.compilationCount++;

    // Compile the pattern
    const compiled = this.compileInternal(path);
    this.cache.set(path, compiled);
    return compiled;
  }

  /**
   * Internal compilation logic
   */
  private static compileInternal(path: string): CompiledPath {
    const paramNames: string[] = [];
    const isStatic = !path.includes(':') && !path.includes('*');

    // Calculate segment count for optimization
    const segments = path.split('/').filter(s => s.length > 0).length;

    if (isStatic) {
      // No regex needed for static routes
      return {
        pattern: null,
        paramNames: [],
        isStatic: true,
        path,
        segments,
      };
    }

    // Convert parameterized routes to regex
    // Match :paramName and capture the parameter name
    const regexPath = path
      .replace(/\/:([^/]+)/g, (match, paramName) => {
        paramNames.push(paramName);
        return '/([^/]+)';
      })
      .replace(/\//g, '\\/');

    return {
      pattern: new RegExp(`^${regexPath}$`),
      paramNames,
      isStatic: false,
      path,
      segments,
    };
  }

  /**
   * Match a request path against a compiled pattern
   * Returns match result with extracted parameters, or null if no match
   */
  static match(compiledPath: CompiledPath, requestPath: string): MatchResult | null {
    // Path for static routes - simple string comparison
    if (compiledPath.isStatic) {
      return compiledPath.path === requestPath ? { params: {} } : null;
    }

    // Dynamic route - use regex matching
    if (!compiledPath.pattern) {
      return null;
    }

    const matches = requestPath.match(compiledPath.pattern);
    if (!matches) {
      return null;
    }

    // Extract parameters
    const params: Record<string, string> = {};
    compiledPath.paramNames.forEach((name, index) => {
      params[name] = matches[index + 1];
    });

    return { params };
  }

  /**
   * Compile and match in one operation (convenience method)
   */
  static compileAndMatch(pathPattern: string, requestPath: string): MatchResult | null {
    const compiled = this.compile(pathPattern);
    return this.match(compiled, requestPath);
  }

  /**
   * Check if a path pattern is static (no parameters)
   */
  static isStatic(path: string): boolean {
    return !path.includes(':') && !path.includes('*');
  }

  /**
   * Get performance statistics
   */
  static getStats() {
    const totalRequests = this.cacheHits + this.cacheMisses;
    return {
      cacheSize: this.cache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRate: totalRequests > 0 ? this.cacheHits / totalRequests : 0,
      compilationCount: this.compilationCount,
    };
  }

  /**
   * Clear the cache (useful for testing)
   */
  static clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /**
   * Pre-compile multiple paths (cache warming)
   */
  static precompile(paths: string[]): void {
    paths.forEach(path => this.compile(path));
  }
}

/**
 * Legacy compatibility function - maps to PathMatcher.compile
 * @deprecated Use PathMatcher.compile instead
 */
export function pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
  const compiled = PathMatcher.compile(path);
  return {
    pattern: compiled.pattern || new RegExp(`^${path.replace(/\//g, '\\/')}$`),
    paramNames: compiled.paramNames,
  };
}
