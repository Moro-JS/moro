// Built-in Middleware Exports
export { auth } from './auth.js';
export { rateLimit } from './rate-limit.js';
export { cors } from './cors.js';
export { validation } from './validation.js';
export { requestLogger } from './request-logger.js';
export { performanceMonitor } from './performance-monitor.js';
export { errorTracker } from './error-tracker.js';

// Advanced Security & Performance Middleware
export { cookie } from './cookie.js';
export { csrf } from './csrf.js';
export { csp } from './csp.js';
export { sse } from './sse.js';
export { session } from './session.js';

// Clean Architecture Middleware
export { cache } from './cache.js';
export { cdn } from './cdn.js';

// Auth Helpers and Extended Providers
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
} from './auth-helpers.js';

// JWT Utilities for Custom Middleware
export {
  safeVerifyJWT,
  extractJWTFromHeader,
  createAuthErrorResponse,
  type JWTVerificationResult,
} from './jwt-helpers.js';

export {
  extendedProviders,
  enterpriseProviders,
  createCustomOAuthProvider,
  createCustomOIDCProvider,
} from './auth-providers.js';

// Import for collections
import { auth } from './auth.js';
import { rateLimit } from './rate-limit.js';
import { cors } from './cors.js';
import { validation } from './validation.js';
import { requestLogger } from './request-logger.js';
import { performanceMonitor } from './performance-monitor.js';
import { errorTracker } from './error-tracker.js';
import { cookie } from './cookie.js';
import { csrf } from './csrf.js';
import { csp } from './csp.js';
import { sse } from './sse.js';
import { session } from './session.js';
import { cache } from './cache.js';
import { cdn } from './cdn.js';

export const builtInMiddleware = {
  auth,
  rateLimit,
  cors,
  validation,
  // Advanced middleware
  cookie,
  csrf,
  csp,
  sse,
  session,
  // Clean architecture middleware
  cache,
  cdn,
};

export const simpleMiddleware = {
  requestLogger,
  performanceMonitor,
  errorTracker,
};
