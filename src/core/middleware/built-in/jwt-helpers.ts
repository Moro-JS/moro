/**
 * JWT Error Handling Utilities for Custom Middleware
 *
 * This module provides utilities to help users handle JWT errors gracefully
 * in their custom authentication middleware.
 */

import { resolveUserPackage } from '../../utilities/package-utils.js';

export interface JWTVerificationResult {
  success: boolean;
  payload?: any;
  error?: {
    type: 'expired' | 'invalid' | 'malformed' | 'missing_secret' | 'unknown';
    message: string;
    expiredAt?: Date;
    date?: Date;
  };
}

/**
 * Safely verify a JWT token with proper error handling
 *
 * @param token - The JWT token to verify
 * @param secret - The secret key for verification
 * @param options - Additional JWT verification options
 * @returns JWTVerificationResult with success status and payload or error details
 */
export async function safeVerifyJWT(
  token: string,
  secret: string,
  options: any = {}
): Promise<JWTVerificationResult> {
  // Check if jsonwebtoken is available
  let jwt: any;
  try {
    const jwtPath = resolveUserPackage('jsonwebtoken');
    jwt = await import(jwtPath);
  } catch (error) {
    return {
      success: false,
      error: {
        type: 'missing_secret',
        message:
          'JWT verification requires the "jsonwebtoken" package. ' +
          'Please install it with: npm install jsonwebtoken @types/jsonwebtoken',
      },
    };
  }

  if (!secret) {
    return {
      success: false,
      error: {
        type: 'missing_secret',
        message:
          'JWT verification requires a secret. ' +
          'Please provide a secret for token verification.',
      },
    };
  }

  try {
    const payload = jwt.verify(token, secret, options);
    return {
      success: true,
      payload,
    };
  } catch (error: any) {
    // Handle specific JWT errors gracefully
    if (error.name === 'TokenExpiredError') {
      return {
        success: false,
        error: {
          type: 'expired',
          message: 'JWT token has expired',
          expiredAt: error.expiredAt,
        },
      };
    } else if (error.name === 'JsonWebTokenError') {
      return {
        success: false,
        error: {
          type: 'invalid',
          message: 'Invalid JWT token format or signature',
        },
      };
    } else if (error.name === 'NotBeforeError') {
      return {
        success: false,
        error: {
          type: 'malformed',
          message: 'JWT token is not active yet',
          date: error.date,
        },
      };
    } else {
      return {
        success: false,
        error: {
          type: 'unknown',
          message: `JWT verification failed: ${error.message}`,
        },
      };
    }
  }
}

/**
 * Extract JWT token from Authorization header
 *
 * @param authHeader - The Authorization header value
 * @returns The JWT token or null if not found/invalid format
 */
export function extractJWTFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  return token.trim() || null;
}

/**
 * Create a standardized auth middleware error response
 *
 * @param error - The JWT verification error
 * @returns Standardized error response object
 */
export function createAuthErrorResponse(error: JWTVerificationResult['error']) {
  if (!error) {
    return {
      success: false,
      error: 'Authentication failed',
      message: 'Unknown authentication error',
    };
  }

  switch (error.type) {
    case 'expired':
      return {
        success: false,
        error: 'Token expired',
        message: 'Your session has expired. Please sign in again.',
        expiredAt: error.expiredAt,
      };

    case 'invalid':
      return {
        success: false,
        error: 'Invalid token',
        message: 'The provided authentication token is invalid.',
      };

    case 'malformed':
      return {
        success: false,
        error: 'Token not ready',
        message: 'The authentication token is not yet valid.',
        availableAt: error.date,
      };

    case 'missing_secret':
      return {
        success: false,
        error: 'Configuration error',
        message: 'Authentication service is not properly configured.',
      };

    default:
      return {
        success: false,
        error: 'Authentication failed',
        message: error.message || 'Authentication verification failed.',
      };
  }
}

/**
 * Example usage for custom middleware with elegant error handling:
 *
 * ```typescript
 * import { safeVerifyJWT, extractJWTFromHeader, createAuthErrorResponse } from '@morojs/moro';
 *
 * const authMiddleware = async (req: any, res: any, next: any) => {
 *   const token = extractJWTFromHeader(req.headers.authorization);
 *
 *   if (!token) {
 *     return res.status(401).json({
 *       success: false,
 *       error: 'Missing token',
 *       message: 'Authorization header with Bearer token is required'
 *     });
 *   }
 *
 *   const result = safeVerifyJWT(token, process.env.JWT_SECRET!);
 *
 *   if (!result.success) {
 *     // This provides elegant, user-friendly error messages instead of stack traces
 *     const errorResponse = createAuthErrorResponse(result.error);
 *     return res.status(401).json(errorResponse);
 *   }
 *
 *   // Token is valid - attach user info to request
 *   req.user = result.payload;
 *   req.auth = {
 *     user: result.payload,
 *     isAuthenticated: true,
 *     token
 *   };
 *
 *   next();
 * };
 * ```
 *
 * Benefits of using safeVerifyJWT vs raw jsonwebtoken.verify():
 *
 * ❌ Raw approach (shows ugly error messages to users):
 * ```typescript
 * try {
 *   const decoded = jwt.verify(token, secret);
 *   req.user = decoded;
 * } catch (error) {
 *   // This exposes technical details and stack traces to users:
 *   // "Invalid token: TokenExpiredError: jwt expired at /node_modules/jsonwebtoken/verify.js:190:21..."
 *   throw error; // BAD - exposes internal details
 * }
 * ```
 *
 * ✅ Safe approach (shows clean, user-friendly messages):
 * ```typescript
 * const result = safeVerifyJWT(token, secret);
 * if (!result.success) {
 *   // This returns clean messages like:
 *   // { "error": "Token expired", "message": "Your session has expired. Please sign in again." }
 *   return res.status(401).json(createAuthErrorResponse(result.error));
 * }
 * ```
 */
