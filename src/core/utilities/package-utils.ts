// Package and Module Resolution Utilities
// ESM-compatible helpers for detecting and resolving optional dependencies

import { createRequire } from 'module';
import { join } from 'path';

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
