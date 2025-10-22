// Auth - Main entry point
// Re-exports all public APIs for the Auth built-in

// Core (for direct use by router and custom implementations)
export { AuthCore, providers } from './core.js';

// Middleware (for middleware chains)
export { createAuthMiddleware } from './middleware.js';

// Hook (for global registration)
export { auth } from './hook.js';

// Auth Helpers
export {
  requireAuth,
  requireRole,
  requirePermission,
  requireAdmin,
  guestOnly,
  optionalAuth,
  withAuth,
  protectedRoute,
  authUtils,
  authResponses,
  sessionHelpers,
  type AuthGuardOptions,
  type AuthRouteOptions,
} from './helpers.js';

// Extended Auth Providers
export {
  extendedProviders,
  enterpriseProviders,
  createCustomOAuthProvider,
  createCustomOIDCProvider,
} from './providers.js';

// JWT Utilities
export {
  safeVerifyJWT,
  extractJWTFromHeader,
  createAuthErrorResponse,
  type JWTVerificationResult,
} from './jwt-helpers.js';

// Re-export types from shared types
export type {
  AuthOptions,
  AuthProvider,
  AuthUser,
  AuthSession,
  AuthRequest,
  OAuthProvider,
  CredentialsProvider,
  EmailProvider,
} from '../../../../types/auth.js';
