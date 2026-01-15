/**
 * Module Path Utilities
 *
 * Helper functions for constructing module routes with configurable prefixes
 */

/**
 * Build the base path for a module route
 *
 * @param apiPrefix - The API prefix from config (e.g., '/api/', '', '/services/')
 * @param version - Module version (e.g., '1.0.0')
 * @param moduleName - Module name (e.g., 'user')
 * @returns The complete base path (e.g., '/api/v1.0.0/user')
 */
export function buildModuleBasePath(
  apiPrefix: string | undefined,
  version: string,
  moduleName: string
): string {
  // Use default '/api/' if not specified
  const prefix = apiPrefix !== undefined ? apiPrefix : '/api/';

  // Normalize prefix - remove trailing slash if present
  const normalizedPrefix = prefix ? (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix) : '';

  // Build complete path
  return `${normalizedPrefix}/v${version}/${moduleName}`;
}
