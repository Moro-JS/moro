// Built-in Middleware Exports
export { auth } from './auth';
export { rateLimit } from './rate-limit';
export { cors } from './cors';
export { validation } from './validation';
export { requestLogger } from './request-logger';
export { performanceMonitor } from './performance-monitor';
export { errorTracker } from './error-tracker';

// Advanced Security & Performance Middleware
export { cookie } from './cookie';
export { csrf } from './csrf';
export { csp } from './csp';
export { sse } from './sse';
export { session } from './session';

// Clean Architecture Middleware
export { cache } from './cache';
export { cdn } from './cdn';

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
} from './auth-helpers';

export {
  extendedProviders,
  enterpriseProviders,
  createCustomOAuthProvider,
  createCustomOIDCProvider,
} from './auth-providers';

// Import for collections
import { auth } from './auth';
import { rateLimit } from './rate-limit';
import { cors } from './cors';
import { validation } from './validation';
import { requestLogger } from './request-logger';
import { performanceMonitor } from './performance-monitor';
import { errorTracker } from './error-tracker';
import { cookie } from './cookie';
import { csrf } from './csrf';
import { csp } from './csp';
import { sse } from './sse';
import { session } from './session';
import { cache } from './cache';
import { cdn } from './cdn';

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
