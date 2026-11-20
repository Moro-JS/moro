// Shared Path Matching Utility with Caching
// Replaces 6 different pathToRegex implementations across the codebase

import { LRUCache } from '../pooling/lru-cache.js';
import { decodeParam } from './decode-param.js';

export interface CompiledPath {
  pattern: RegExp | null;
  paramNames: string[];
  isStatic: boolean;
  path: string;
  segments: number;
  /**
   * The path ends in optional parameters or a wildcard, so the request paths
   * it matches do not all have `segments` segments.
   */
  variableLength?: boolean;
}

export interface MatchResult {
  /** A trailing optional parameter the request path left out has no key */
  params: Record<string, string>;
}

/**
 * What a route path asks for beyond fixed text and required parameters; see
 * parseExtendedPath.
 */
export interface ExtendedPath {
  /**
   * The path in front of the first optional parameter or the wildcard:
   * '/users' for '/users/:id?', '/static/:kind' for '/static/:kind/*', and
   * '' when nothing is in front of it ('/:id?', '/*').
   */
  base: string;
  /** The trailing optional parameters by name, in path order */
  optional: string[];
  /** The key the wildcard's value has in req.params: '*', or the name given */
  wildcard: string | undefined;
}

/**
 * PathMatcher - Single source of truth for path pattern compilation and matching
 */
export class PathMatcher {
  private static readonly cache = new LRUCache<string, CompiledPath>(1000);
  private static compilationCount = 0;
  private static cacheHits = 0;
  private static cacheMisses = 0;

  // PERFORMANCE: Cache segment counts for 500%+ speedup on repeated paths
  private static readonly segmentCountCache = new Map<string, number>();
  private static readonly MAX_SEGMENT_CACHE_SIZE = 1000;

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

    // Calculate segment count for optimization using shared utility
    const segments = PathMatcher.countSegments(path);

    // Trailing optional parameters or a wildcard
    const extended = parseExtendedPath(path);
    if (extended !== null) {
      return {
        pattern: extendedPathPattern(extended, paramNames),
        paramNames,
        isStatic: false,
        path,
        segments,
        variableLength: true,
      };
    }

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
      // A dot in the fixed text of a path is a dot: '/v1.0' is not '/v1x0'.
      // (One that carries a quantifier, as in '.*', and one already escaped
      // keep the meaning they have had; see warnUnsupportedPathSyntax.)
      .replace(LITERAL_DOT, '\\.')
      .replace(/\//g, '\\/');

    return {
      // Without a parameter there is nothing to capture, and the path is
      // matched as it is written ('*' is a character, not a pattern)
      pattern: paramNames.length === 0 ? literalPathPattern(path) : new RegExp(`^${regexPath}$`),
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

    // Extract params - optimized with for loop instead of forEach
    const params: Record<string, string> = {};
    const paramNames = compiledPath.paramNames;
    const paramCount = paramNames.length;
    for (let i = 0; i < paramCount; i++) {
      const value = matches[i + 1];
      // An optional parameter the path left out: no key
      if (value === undefined) continue;
      params[paramNames[i] as string] = decodeParam(value);
    }

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
   * Count segments in a path (optimized with caching)
   */
  static countSegments(path: string): number {
    // Check cache first - most paths are repeated
    const cached = this.segmentCountCache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    // Count segments manually (fast charCode comparison)
    let segmentCount = 0;
    const pathLen = path.length;
    let inSegment = false;

    for (let i = 0; i < pathLen; i++) {
      const char = path.charCodeAt(i);
      if (char === 47) {
        // '/' character
        inSegment = false;
      } else if (!inSegment) {
        inSegment = true;
        segmentCount++;
      }
    }

    // Cache result (limit cache size to prevent memory leaks)
    if (this.segmentCountCache.size < this.MAX_SEGMENT_CACHE_SIZE) {
      this.segmentCountCache.set(path, segmentCount);
    }

    return segmentCount;
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
    this.segmentCountCache.clear(); // Clear segment count cache too
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /**
   * Pre-compile multiple paths (cache warming)
   */
  static precompile(paths: string[]): void {
    const pathsLen = paths.length;
    for (let i = 0; i < pathsLen; i++) {
      this.compile(paths[i] as string);
    }
  }
}

/**
 * A dot that stands for itself in a route path: not escaped already, and not
 * the subject of a quantifier.
 */
export const LITERAL_DOT = /(?<!\\)\.(?![*+?{])/g;

/**
 * A pattern that matches exactly the text of `path`: every character stands
 * for itself, so a path such as '/c++' or '/files/**' is a valid route.
 */
export function literalPathPattern(path: string): RegExp {
  return new RegExp(`^${path.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')}$`);
}

// The characters that are pattern syntax in other routers. Apart from the two
// forms parseExtendedPath reads, none of them is syntax in a route path.
const PATTERN_CHARACTERS = /[*+?()[\]{}|^$\\]/;

// '*' or '*name' as a whole segment
const WILDCARD_SEGMENT = /^\*(?:[A-Za-z_$][A-Za-z0-9_$]*)?$/;

/**
 * Read the two forms a route path has beyond fixed text and required
 * parameters:
 *
 *   - `:name?` as the last segment, or the last few: optional parameters.
 *     '/users/:id?' is '/users' and '/users/7'; the parameter is called `id`,
 *     and req.params has no `id` key when the path leaves it out.
 *   - `*` or `*name` as the last segment: a wildcard, which takes the rest of
 *     the path after the slash, slashes included. '/files/*' is '/files/',
 *     '/files/a' and '/files/a/b.txt', and is not '/files'. The value is
 *     req.params['*'], or req.params.name for '*name'.
 *
 * Returns null for a path that uses neither. A path that has one of them in
 * a place where it cannot work is an error, so that the route is not
 * registered meaning something else: an optional parameter followed by
 * anything but another optional parameter, a '?' elsewhere in a parameter's
 * segment, and a wildcard that is not the last segment. `route` names the
 * route in that error. A '*' or '?' that is neither form ('/c++' has none;
 * '/files/**', '/a/b?c', '/proxy/:name/.*') is not read here: such a path is
 * matched as it has been (see warnUnsupportedPathSyntax in the router).
 */
export function parseExtendedPath(path: string, route: string = path): ExtendedPath | null {
  if (path.indexOf('?') === -1 && path.indexOf('*') === -1) return null;
  // '*' on its own is the request target of 'OPTIONS *', not a wildcard
  if (path === '*') return null;

  const segments = path.split('/');
  // A slash at the end of the path is not one more segment
  let last = segments.length - 1;
  while (last > 0 && segments[last] === '') last--;

  const optional: string[] = [];
  let wildcard: string | undefined;
  let firstAt = -1;

  for (let i = 0; i <= last; i++) {
    const segment = segments[i] as string;
    if (segment === '') continue;

    const optionalParameter = segment.includes('?') && segment.includes(':');
    if (optional.length > 0 && !optionalParameter) {
      throw new Error(
        `${route}: the optional parameter ':${optional[optional.length - 1]}?' is followed by ` +
          `'${segment}'. Only the last segments of a path can be optional parameters ` +
          `('/users/:id?', '/posts/:year?/:month?'); register a route for each of the other shapes.`
      );
    }

    if (optionalParameter) {
      const name = segment.slice(1, -1);
      if (
        segment.charCodeAt(0) !== 58 || // ':'
        !segment.endsWith('?') ||
        name === '' ||
        name.includes(':') ||
        PATTERN_CHARACTERS.test(name)
      ) {
        throw new Error(
          `${route}: '?' makes a parameter optional only when the segment is the parameter and ` +
            `nothing else (':id?'); '${segment}' is not that. A pattern or other text in the ` +
            `same segment is not supported.`
        );
      }
      if (firstAt === -1) firstAt = i;
      optional.push(name);
      continue;
    }

    if (WILDCARD_SEGMENT.test(segment)) {
      if (i !== last) {
        throw new Error(
          `${route}: the wildcard '${segment}' must be the last segment of the path ` +
            `('/files/*', '/files/*path'); here '${segments[i + 1]}' follows it.`
        );
      }
      wildcard = segment.length === 1 ? '*' : segment.slice(1);
      firstAt = i;
    }
  }

  if (firstAt === -1) return null;
  return { base: trimSlashes(segments.slice(0, firstAt)), optional, wildcard };
}

// The segments in front of the optional parameters or the wildcard as a path,
// without empty segments: '' when there are none
function trimSlashes(segments: string[]): string {
  let base = '';
  for (const segment of segments) {
    if (segment !== '') base += `/${segment}`;
  }
  return base;
}

/** Whether a route path has trailing optional parameters or a wildcard. */
export function hasExtendedSyntax(path: string): boolean {
  return parseExtendedPath(path) !== null;
}

/**
 * The paths an optional-parameter route stands for, shortest first:
 * '/users/:id?' is ['/users', '/users/:id']. Every one of them is a path of
 * fixed text and required parameters.
 */
export function optionalPathForms(extended: ExtendedPath): string[] {
  const forms = [extended.base === '' ? '/' : extended.base];
  let form = extended.base;
  for (const name of extended.optional) {
    form += `/:${name}`;
    forms.push(form);
  }
  return forms;
}

const escapeLiteral = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

// The rest of a path under a wildcard: any number of segments, none of them
// empty, and optionally a slash at the end ('', 'a', 'a/b.txt', 'a/'). An
// empty segment ('/files//x') is not part of any path the router matches.
const WILDCARD_REST = '((?:[^/]+\\/)*[^/]*)';

/**
 * The pattern of a path with optional parameters or a wildcard. Its fixed
 * text is matched as it is written, character for character. Pushes the
 * parameter names onto `paramNames` in capture order; the capture of an
 * optional parameter the path leaves out is undefined.
 */
function extendedPathPattern(extended: ExtendedPath, paramNames: string[]): RegExp {
  let source = '';
  for (const segment of extended.base.split('/')) {
    if (segment === '') continue;
    if (segment.length > 1 && segment.charCodeAt(0) === 58) {
      paramNames.push(segment.slice(1));
      source += '\\/([^/]+)';
    } else {
      source += `\\/${escapeLiteral(segment)}`;
    }
  }

  if (extended.optional.length > 0) {
    // '/a/:b?/:c?' is '/a', '/a/1' and '/a/1/2': each optional parameter is
    // there only if the one before it is
    let tail = '';
    for (let i = extended.optional.length - 1; i >= 0; i--) {
      // With nothing in front, the path still starts with its slash: '/:id?'
      // is '/' and '/7'
      const slash = i === 0 && source === '' ? '' : '\\/';
      tail = `(?:${slash}([^/]+)${tail})?`;
    }
    for (const name of extended.optional) paramNames.push(name);
    source = source === '' ? `\\/${tail}` : source + tail;
  }

  if (extended.wildcard !== undefined) {
    paramNames.push(extended.wildcard);
    source += `\\/${WILDCARD_REST}`;
  }

  return new RegExp(`^${source}$`);
}

/**
 * Legacy compatibility function - maps to PathMatcher.compile
 * @deprecated Use PathMatcher.compile instead
 */
export function pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
  const compiled = PathMatcher.compile(path);
  return {
    pattern: compiled.pattern || literalPathPattern(path),
    paramNames: compiled.paramNames,
  };
}
