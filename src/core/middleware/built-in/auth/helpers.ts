// Auth Helper Middleware and Utilities
import { AuthRequest } from '../../../../types/auth.js';

export interface AuthGuardOptions {
  redirectTo?: string;
  redirectOnAuth?: string; // Redirect if already authenticated
  authorize?: (user: any) => boolean | Promise<boolean>;
  roles?: string[];
  permissions?: string[];
  allowUnauthenticated?: boolean;
  onUnauthorized?: (req: any, res: any) => void;
  onForbidden?: (req: any, res: any) => void;
}

export interface AuthRouteOptions {
  requireAuth?: boolean;
  roles?: string[];
  permissions?: string[];
  redirectTo?: string;
}

/**
 * Auth Guard Middleware - Protects routes with authentication and authorization
 */
export function requireAuth(options: AuthGuardOptions = {}) {
  return async (req: any, res: any, next: any) => {
    const auth: AuthRequest = req.auth;

    if (!auth) {
      throw new Error('Auth middleware must be installed before using requireAuth');
    }

    // Check if already authenticated and should redirect
    if (auth.isAuthenticated && options.redirectOnAuth) {
      return res.redirect(options.redirectOnAuth);
    }

    // Check authentication requirement
    if (!options.allowUnauthenticated && !auth.isAuthenticated) {
      if (options.onUnauthorized) {
        return options.onUnauthorized(req, res);
      }

      if (options.redirectTo) {
        return res.redirect(`${options.redirectTo}?callbackUrl=${encodeURIComponent(req.url)}`);
      }

      return res.status(401).json({
        error: 'Authentication required',
        message: 'You must be logged in to access this resource',
        signInUrl: '/api/auth/signin',
      });
    }

    // Skip further checks if not authenticated but allowed
    if (!auth.isAuthenticated && options.allowUnauthenticated) {
      return next();
    }

    const user = auth.user;

    // Check roles if specified
    if (options.roles && options.roles.length > 0) {
      const userRoles = user?.roles || [];
      const hasRole = options.roles.some(role => userRoles.includes(role));

      if (!hasRole) {
        if (options.onForbidden) {
          return options.onForbidden(req, res);
        }

        return res.status(403).json({
          error: 'Insufficient permissions',
          message: `Required roles: ${options.roles.join(', ')}`,
          userRoles,
        });
      }
    }

    // Check permissions if specified
    if (options.permissions && options.permissions.length > 0) {
      const userPermissions = user?.permissions || [];
      const hasPermission = options.permissions.every(permission =>
        userPermissions.includes(permission)
      );

      if (!hasPermission) {
        if (options.onForbidden) {
          return options.onForbidden(req, res);
        }

        return res.status(403).json({
          error: 'Insufficient permissions',
          message: `Required permissions: ${options.permissions.join(', ')}`,
          userPermissions,
        });
      }
    }

    // Custom authorization function
    if (options.authorize) {
      try {
        const authorized = await options.authorize(user);

        if (!authorized) {
          if (options.onForbidden) {
            return options.onForbidden(req, res);
          }

          return res.status(403).json({
            error: 'Access denied',
            message: 'Custom authorization check failed',
          });
        }
      } catch (error) {
        return res.status(500).json({
          error: 'Authorization error',
          message: 'Failed to verify authorization',
        });
      }
    }

    // All checks passed
    next();
  };
}

/**
 * Role-based access control middleware
 */
export function requireRole(
  role: string | string[],
  options: Omit<AuthGuardOptions, 'roles'> = {}
) {
  const roles = Array.isArray(role) ? role : [role];
  return requireAuth({ ...options, roles });
}

/**
 * Permission-based access control middleware
 */
export function requirePermission(
  permission: string | string[],
  options: Omit<AuthGuardOptions, 'permissions'> = {}
) {
  const permissions = Array.isArray(permission) ? permission : [permission];
  return requireAuth({ ...options, permissions });
}

/**
 * Admin-only access middleware
 */
export function requireAdmin(options: Omit<AuthGuardOptions, 'roles'> = {}) {
  return requireRole('admin', options);
}

/**
 * Guest-only middleware (redirect if authenticated)
 */
export function guestOnly(redirectTo = '/dashboard') {
  return requireAuth({
    allowUnauthenticated: true,
    redirectOnAuth: redirectTo,
  });
}

/**
 * Optional auth middleware (allows both authenticated and unauthenticated)
 */
export function optionalAuth() {
  return requireAuth({
    allowUnauthenticated: true,
  });
}

/**
 * Route-level auth decorator
 */
export function withAuth(options: AuthRouteOptions = {}) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (req: any, res: any, next: any) {
      if (options.requireAuth !== false) {
        const authMiddleware = requireAuth({
          roles: options.roles,
          redirectTo: options.redirectTo,
        });

        await new Promise<void>((resolve, reject) => {
          authMiddleware(req, res, (error: any) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }

      return originalMethod.call(this, req, res, next);
    };

    return descriptor;
  };
}

/**
 * Auth utilities for manual checks in route handlers
 */
export const authUtils = {
  /**
   * Check if user is authenticated
   */
  isAuthenticated(req: any): boolean {
    return req.auth?.isAuthenticated || false;
  },

  /**
   * Get current user
   */
  getUser(req: any) {
    return req.auth?.user || null;
  },

  /**
   * Check if user has role
   */
  hasRole(req: any, role: string | string[]): boolean {
    const user = this.getUser(req);
    if (!user?.roles) return false;

    const roles = Array.isArray(role) ? role : [role];
    return roles.some(r => user.roles.includes(r));
  },

  /**
   * Check if user has permission
   */
  hasPermission(req: any, permission: string | string[]): boolean {
    const user = this.getUser(req);
    if (!user?.permissions) return false;

    const permissions = Array.isArray(permission) ? permission : [permission];
    return permissions.every(p => user.permissions.includes(p));
  },

  /**
   * Check if user is admin
   */
  isAdmin(req: any): boolean {
    return this.hasRole(req, 'admin');
  },

  /**
   * Get user ID
   */
  getUserId(req: any): string | null {
    return this.getUser(req)?.id || null;
  },

  /**
   * Force authentication check and redirect if needed
   */
  ensureAuth(req: any, res: any, redirectTo = '/api/auth/signin'): boolean {
    if (!this.isAuthenticated(req)) {
      res.redirect(`${redirectTo}?callbackUrl=${encodeURIComponent(req.url)}`);
      return false;
    }
    return true;
  },

  /**
   * Create auth response for API endpoints
   */
  createAuthResponse(req: any) {
    const auth = req.auth;

    return {
      isAuthenticated: auth?.isAuthenticated || false,
      user: auth?.user || null,
      session: auth?.session || null,
      timestamp: new Date().toISOString(),
    };
  },
};

/**
 * API Response helpers for auth endpoints
 */
export const authResponses = {
  unauthorized: (res: any, message = 'Authentication required') => {
    return res.status(401).json({
      error: 'Unauthorized',
      message,
      code: 'AUTH_REQUIRED',
      signInUrl: '/api/auth/signin',
    });
  },

  forbidden: (res: any, message = 'Insufficient permissions') => {
    return res.status(403).json({
      error: 'Forbidden',
      message,
      code: 'INSUFFICIENT_PERMISSIONS',
    });
  },

  authSuccess: (res: any, user: any, message = 'Authentication successful') => {
    return res.json({
      success: true,
      message,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        roles: user.roles || [],
        permissions: user.permissions || [],
      },
    });
  },

  authError: (res: any, error: string, message = 'Authentication failed') => {
    return res.status(400).json({
      error,
      message,
      code: 'AUTH_ERROR',
    });
  },
};

/**
 * Higher-order function to create protected route handlers
 */
export function protectedRoute(
  handler: (req: any, res: any, next?: any) => any,
  options: AuthGuardOptions = {}
) {
  return async (req: any, res: any, next: any) => {
    const authMiddleware = requireAuth(options);

    return new Promise<void>((resolve, reject) => {
      authMiddleware(req, res, (error: any) => {
        if (error) {
          reject(error);
        } else {
          Promise.resolve(handler(req, res, next))
            .then(() => resolve())
            .catch(reject);
        }
      });
    });
  };
}

/**
 * Session management helpers
 */
export const sessionHelpers = {
  /**
   * Store data in session
   */
  async setSessionData(req: any, key: string, value: any) {
    if (req.session) {
      req.session[key] = value;
      await req.session.save();
    }
  },

  /**
   * Get data from session
   */
  getSessionData(req: any, key: string) {
    return req.session?.[key] || null;
  },

  /**
   * Remove data from session
   */
  async removeSessionData(req: any, key: string) {
    if (req.session && key in req.session.data) {
      delete req.session.data[key];
      await req.session.save();
    }
  },

  /**
   * Clear entire session
   */
  async clearSession(req: any) {
    if (req.session) {
      await req.session.destroy();
    }
  },

  /**
   * Regenerate session ID
   */
  async regenerateSession(req: any) {
    if (req.session) {
      return await req.session.regenerate();
    }
  },
};
