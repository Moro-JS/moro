// gRPC Middleware - Auth Integration
// Integrate Moro's authentication system with gRPC

import type { GrpcCall, GrpcCallback, GrpcMetadata } from '../types.js';
import { createFrameworkLogger } from '../../logger/index.js';

const logger = createFrameworkLogger('GRPC_AUTH');

/**
 * Extract JWT token from gRPC metadata
 */
export function extractTokenFromMetadata(metadata: GrpcMetadata): string | null {
  if (!metadata) return null;

  // Try to get authorization header
  const authHeader = metadata.get('authorization');

  if (!authHeader) return null;

  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  if (typeof authValue === 'string') {
    // Extract Bearer token
    const match = authValue.match(/^Bearer\s+(\S+)$/i);
    return match?.[1] ?? null;
  }

  return null;
}

/**
 * Normalise a roles/permissions value to a list of strings.
 * An array is kept as is (string elements only); a string is split on commas
 * and whitespace; anything else is an empty list.
 */
function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    return value.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

/**
 * gRPC authentication middleware
 * Verifies bearer tokens from gRPC metadata with the supplied `verify`
 * function. `verify` must resolve to the authenticated user; a falsy result
 * or a rejection denies the call.
 *
 * Token verification from `secret` alone is not implemented: without a
 * `verify` function no token can be checked, so every call that needs or
 * presents a token is rejected as UNAUTHENTICATED.
 */
export function grpcAuth(options: {
  secret?: string;
  verify?: (token: string) => Promise<any>;
  required?: boolean;
}) {
  const verify = typeof options?.verify === 'function' ? options.verify : null;

  // Fail closed when there is nothing to verify a token with
  let misconfiguration: string | null = null;
  if (!verify) {
    if (options?.secret) {
      misconfiguration =
        'grpcAuth: verification from `secret` is not implemented; supply a `verify` function. ' +
        'Calls are rejected as UNAUTHENTICATED until one is configured.';
      logger.error(misconfiguration, 'Auth');
    } else {
      misconfiguration =
        'grpcAuth: no `verify` function configured; tokens cannot be verified. ' +
        'Calls are rejected as UNAUTHENTICATED until one is configured.';
      logger.warn(misconfiguration, 'Auth');
    }
  }

  return async (call: GrpcCall, callback?: GrpcCallback) => {
    try {
      const token = extractTokenFromMetadata(call.metadata);

      if (!token) {
        if (options?.required !== false) {
          const error: any = new Error('Unauthenticated: No token provided');
          error.code = 16; // UNAUTHENTICATED
          throw error;
        }
        return;
      }

      if (!verify) {
        logger.error(misconfiguration as string, 'Auth');
        const error: any = new Error('Unauthenticated: Token verification is not configured');
        error.code = 16; // UNAUTHENTICATED
        throw error;
      }

      // Verify token
      const user = await verify(token);

      if (!user) {
        const error: any = new Error('Unauthenticated: Invalid token');
        error.code = 16; // UNAUTHENTICATED
        throw error;
      }

      // Attach user to call context
      if (!call.request) {
        (call as any).request = {};
      }
      (call as any).user = user;
    } catch (error) {
      logger.error(`Authentication error: ${error}`, 'Auth');

      const grpcError: any = new Error(
        error instanceof Error ? error.message : 'Authentication failed'
      );
      grpcError.code = 16; // UNAUTHENTICATED

      if (callback) {
        callback(grpcError);
        return;
      }

      throw grpcError;
    }
  };
}

/**
 * gRPC permission check middleware
 */
export function grpcRequirePermission(permission: string | string[]) {
  return async (call: GrpcCall, callback?: GrpcCallback) => {
    const user = (call as any).user;

    if (!user) {
      const error: any = new Error('Unauthenticated: User not found in call context');
      error.code = 16; // UNAUTHENTICATED

      if (callback) {
        callback(error);
        return;
      }

      throw error;
    }

    const requiredPermissions = Array.isArray(permission) ? permission : [permission];
    // Exact match only: a string value is split into a list first, so one
    // permission name can never satisfy another that merely contains it.
    const userPermissions = toStringList(user.permissions);

    const hasPermission = requiredPermissions.some((perm: string) =>
      userPermissions.includes(perm)
    );

    if (!hasPermission) {
      const error: any = new Error(
        `Permission denied: Required ${requiredPermissions.join(' or ')}`
      );
      error.code = 7; // PERMISSION_DENIED

      if (callback) {
        callback(error);
        return;
      }

      throw error;
    }
  };
}

/**
 * gRPC role check middleware
 */
export function grpcRequireRole(role: string | string[]) {
  return async (call: GrpcCall, callback?: GrpcCallback) => {
    const user = (call as any).user;

    if (!user) {
      const error: any = new Error('Unauthenticated: User not found in call context');
      error.code = 16; // UNAUTHENTICATED

      if (callback) {
        callback(error);
        return;
      }

      throw error;
    }

    const requiredRoles = Array.isArray(role) ? role : [role];
    // Exact match only (see grpcRequirePermission)
    const userRoles = toStringList(user.roles || [user.role]);

    const hasRole = requiredRoles.some((r: string) => userRoles.includes(r));

    if (!hasRole) {
      const error: any = new Error(
        `Permission denied: Required role ${requiredRoles.join(' or ')}`
      );
      error.code = 7; // PERMISSION_DENIED

      if (callback) {
        callback(error);
        return;
      }

      throw error;
    }
  };
}
