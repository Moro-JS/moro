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
    return match ? match[1] : null;
  }

  return null;
}

/**
 * gRPC authentication middleware
 * Verifies JWT tokens from gRPC metadata
 */
export function grpcAuth(options: {
  secret?: string;
  verify?: (token: string) => Promise<any>;
  required?: boolean;
}) {
  return async (call: GrpcCall, callback?: GrpcCallback) => {
    try {
      const token = extractTokenFromMetadata(call.metadata);

      if (!token) {
        if (options.required !== false) {
          const error: any = new Error('Unauthenticated: No token provided');
          error.code = 16; // UNAUTHENTICATED
          throw error;
        }
        return;
      }

      // Verify token
      let user: any;

      if (options.verify) {
        user = await options.verify(token);
      } else if (options.secret) {
        // Simple JWT verification (requires jsonwebtoken package)
        // This is a placeholder - full implementation would use jwt library
        logger.warn('Token verification not fully implemented', 'Auth');
        user = { token };
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
    const userPermissions = user.permissions || [];

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
    const userRoles = user.roles || [user.role];

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
