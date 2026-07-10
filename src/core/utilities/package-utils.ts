// Package and Module Resolution Utilities
// ESM-compatible helpers for detecting and resolving optional dependencies

import { createRequire } from 'module';
import { dirname, join } from 'path';
import { existsSync, realpathSync } from 'fs';
import { pathToFileURL } from 'url';

/**
 * Check if a package is available in the user's node_modules
 * Uses ESM-compatible module resolution from the user's working directory
 *
 * @param packageName - The name of the package to check (e.g., 'socket.io', 'zod')
 * @returns true if the package is installed, false otherwise
 *
 * @example
 * if (isPackageAvailable('socket.io')) {
 *   // socket.io is installed, safe to import
 *   const { Server } = await import('socket.io');
 * }
 */
export function isPackageAvailable(packageName: string): boolean {
  try {
    const userRequire = createRequire(join(process.cwd(), 'package.json'));
    userRequire.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a package path from the user's node_modules
 * Uses ESM-compatible module resolution from the user's working directory
 *
 * @param packageName - The name of the package to resolve
 * @returns The resolved package path
 * @throws Error if the package is not found
 *
 * @example
 * const socketIOPath = resolveUserPackage('socket.io');
 * const { Server } = await import(socketIOPath);
 */
export function resolveUserPackage(packageName: string): string {
  const userRequire = createRequire(join(process.cwd(), 'package.json'));
  return userRequire.resolve(packageName);
}

/**
 * Create a require function for the user's working directory
 * Useful for resolving packages installed by the user, not in Moro's dependencies
 *
 * @returns A require function scoped to the user's working directory
 *
 * @example
 * const userRequire = createUserRequire();
 * const packagePath = userRequire.resolve('some-package');
 */
export function createUserRequire() {
  return createRequire(join(process.cwd(), 'package.json'));
}

// ---------------------------------------------------------------------------
// Native HTTP engine loading
// ---------------------------------------------------------------------------

/**
 * Package names probed for the native HTTP engine, in priority order.
 * '@morojs/engine' is Moro's own engine (installed as an optionalDependency of
 * the framework); 'uWebSockets.js' is honored as a legacy user-installed peer.
 */
export const NATIVE_ENGINE_PACKAGES = ['@morojs/engine', 'uWebSockets.js'] as const;

const FRAMEWORK_PACKAGE_NAME = '@morojs/moro';

/** Feature flags the framework gates option-passing on, so it never hands a
 *  serve() option to an engine build that predates it. Everything defaults
 *  false, so an older engine behaves exactly as it did before these existed. */
export interface EngineCapabilities {
  /** The full serve() limit surface is parsed (engine >= 1.1.0). */
  limits: boolean;
  /** In-process TLS termination via options.ssl (engine >= 1.2.0). */
  tls: boolean;
  /** ALPN HTTP/2 via options.http2 (engine >= 1.4.0). */
  http2: boolean;
  /** WebSocket permessage-deflate via options.wsDeflate (engine >= 1.5.0). */
  wsDeflate: boolean;
}

export interface NativeEngineLoadResult {
  /** The loaded engine module (CJS namespace: App, SSLApp, ...) */
  module: any;
  /** Which package satisfied the load */
  source: string;
  /** The engine package's version, when its package.json is resolvable */
  version?: string;
  /** Feature flags (Moro-shaped engine only; all-false for uWS or an
   *  engine too old to advertise them). */
  capabilities?: EngineCapabilities;
}

const NO_CAPABILITIES: EngineCapabilities = {
  limits: false,
  tls: false,
  http2: false,
  wsDeflate: false,
};

const capabilitiesCache = new WeakMap<object, EngineCapabilities>();

/**
 * Feature-detect a loaded engine module. Reads probe().capabilities when the
 * engine exposes it (>= 1.1.0); otherwise everything is false so the framework
 * passes only the options an older engine understood. uWS-style modules (no
 * probe/serve) report all-false — their SSL/limits go through the uWS-specific
 * paths, not these flags.
 */
export function getEngineCapabilities(module: any): EngineCapabilities {
  const surface = module?.default || module;
  if (!surface || typeof surface !== 'object') return NO_CAPABILITIES;
  const cached = capabilitiesCache.get(surface);
  if (cached) return cached;

  let caps: EngineCapabilities = NO_CAPABILITIES;
  try {
    if (typeof surface.probe === 'function') {
      const probe = surface.probe();
      const c = probe?.capabilities;
      if (c && typeof c === 'object') {
        caps = {
          limits: c.limits === true,
          tls: c.tls === true,
          http2: c.http2 === true,
          wsDeflate: c.wsDeflate === true,
        };
      }
    }
  } catch {
    caps = NO_CAPABILITIES;
  }
  capabilitiesCache.set(surface, caps);
  return caps;
}

// undefined = never attempted, null = attempted and failed
let cachedEngine: NativeEngineLoadResult | null | undefined;
let engineLoadErrors: string[] = [];

/**
 * Locate the installed framework package directory so the engine (a dependency
 * of moro, not of the user's app) resolves under strict layouts like pnpm's.
 * Walks up from cwd looking for node_modules/@morojs/moro, resolving symlinks
 * so pnpm's store-linked layout anchors requires next to moro's own deps.
 * Inside the framework repo itself (tests, examples) cwd is the framework dir.
 */
function findFrameworkAnchor(): ReturnType<typeof createRequire> | null {
  try {
    const cwdPackageJson = join(process.cwd(), 'package.json');
    if (existsSync(cwdPackageJson)) {
      const require = createRequire(cwdPackageJson);
      const name = require(cwdPackageJson)?.name;
      if (name === FRAMEWORK_PACKAGE_NAME) {
        return require;
      }
    }
  } catch {
    // fall through to the node_modules walk
  }

  let dir = process.cwd();
  for (;;) {
    const packageJson = join(dir, 'node_modules', '@morojs', 'moro', 'package.json');
    try {
      if (existsSync(packageJson)) {
        return createRequire(join(realpathSync(dirname(packageJson)), 'package.json'));
      }
    } catch {
      // unreadable/broken link - keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Synchronously load the native HTTP engine, trying '@morojs/engine' first and
 * falling back to a user-installed 'uWebSockets.js'. Loading is require-based
 * (both packages are CJS at their core - .node addon loading is require-based),
 * so the instance is shared with any later import() via the CJS module cache.
 *
 * The default call is memoized: the engine either loads once per process or it
 * doesn't. Failure details are retained for logging via
 * getNativeEngineLoadErrors().
 *
 * @param options.candidates - Override the probed package names (testing).
 *   When provided, the call bypasses the cache.
 * @returns The loaded engine and its source package, or null if none loads
 */
export function loadNativeEngine(options?: {
  candidates?: readonly string[];
  /** When provided, every per-attempt failure message is appended here, so a
   *  candidate-override caller (which bypasses the memoized diagnostics) can
   *  still report exactly WHY the engine didn't load — not just "not installed". */
  collectErrors?: string[];
}): NativeEngineLoadResult | null {
  const useCache = !options?.candidates;
  if (useCache && cachedEngine !== undefined) {
    if (options?.collectErrors && !cachedEngine) {
      options.collectErrors.push(...engineLoadErrors);
    }
    return cachedEngine;
  }

  const candidates = options?.candidates ?? NATIVE_ENGINE_PACKAGES;
  const errors: string[] = [];
  let result: NativeEngineLoadResult | null = null;

  const frameworkRequire = findFrameworkAnchor();
  const userRequire = createUserRequire();

  for (const candidate of candidates) {
    // Moro's own engine lives in moro's dependencies (framework anchor first);
    // the legacy uWS peer dep lives in the user's node_modules (cwd first).
    const anchors =
      candidate === 'uWebSockets.js'
        ? [userRequire, frameworkRequire]
        : [frameworkRequire, userRequire];

    for (const anchor of anchors) {
      if (!anchor) continue;
      try {
        const module = anchor(candidate);
        // Capability check: the HTTP server needs either a uWS-style App()
        // factory or the Moro-shaped engine surface (serve()/respond()).
        // A package that loads but can't serve (e.g. a pre-M1 @morojs/engine
        // that only exposes probe()) must not shadow a usable alternative.
        const surface = module?.default || module;
        const uwsStyle = typeof surface?.App === 'function';
        const moroStyle =
          !uwsStyle &&
          typeof surface?.serve === 'function' &&
          typeof surface?.respond === 'function';
        if (!uwsStyle && !moroStyle) {
          errors.push(
            `${candidate}: loaded but provides neither App() nor serve()/respond() - not a usable HTTP engine`
          );
          continue;
        }
        let version: string | undefined;
        try {
          // May be blocked by the package's exports map - version is optional
          version = anchor(`${candidate}/package.json`)?.version;
        } catch {
          version = undefined;
        }
        result = {
          module,
          source: candidate,
          version,
          capabilities: moroStyle ? getEngineCapabilities(module) : NO_CAPABILITIES,
        };
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        errors.push(`${candidate}: ${message}`);
      }
    }
    if (result) break;
  }

  // Candidate-override probes (e.g. the clustering worker's uWS-only check)
  // must not clobber the diagnostics of the real default load, which
  // framework startup logging reads via getNativeEngineLoadErrors().
  if (useCache) {
    engineLoadErrors = result ? [] : [...new Set(errors)];
    cachedEngine = result;
  }
  // Hand this specific call's failure detail back to a caller that asked for it,
  // regardless of caching (so 'moro'/'uws' fallback reasons are precise).
  if (options?.collectErrors && !result) {
    options.collectErrors.push(...new Set(errors));
  }
  return result;
}

/**
 * Failure details from the most recent unsuccessful loadNativeEngine() call,
 * one entry per package/anchor attempt. Empty after a successful load.
 */
export function getNativeEngineLoadErrors(): readonly string[] {
  return engineLoadErrors;
}

/**
 * Clear the memoized engine load result. Testing only.
 */
export function resetNativeEngineLoaderForTesting(): void {
  cachedEngine = undefined;
  engineLoadErrors = [];
}

/**
 * Convert a file path to a file URL for ESM dynamic imports
 * This is required on Windows where absolute paths like C:\path\to\module
 * need to be converted to file:/// URLs for dynamic import() to work
 *
 * @param filePath - The file path to convert (absolute or relative)
 * @returns A proper URL string for ESM import() that works cross-platform
 *
 * @example
 * const modulePath = 'C:\\Users\\project\\module.js';
 * const module = await import(filePathToImportURL(modulePath));
 */
export function filePathToImportURL(filePath: string): string {
  if (!filePath) {
    return filePath;
  }

  // If it's already a URL (starts with file:// or http(s)://), return as-is
  if (
    filePath.startsWith('file://') ||
    filePath.startsWith('http://') ||
    filePath.startsWith('https://')
  ) {
    return filePath;
  }

  // Check if it's a Windows absolute path (C:\ or C:/)
  const windowsAbsolutePathRegex = /^[A-Za-z]:[\\//]/;
  const isWindowsAbsolute = windowsAbsolutePathRegex.test(filePath);

  // Check if it's a Unix absolute path (starts with /)
  const isUnixAbsolute = filePath.startsWith('/');

  // Check if it's a Windows UNC path (\\server\share)
  const isWindowsUNC = filePath.startsWith('\\\\');

  // Convert absolute paths to file URLs
  if (isWindowsAbsolute || isUnixAbsolute || isWindowsUNC) {
    return pathToFileURL(filePath).href;
  }

  // For relative paths, return as-is (they work in import())
  return filePath;
}
