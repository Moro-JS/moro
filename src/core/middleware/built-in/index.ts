// Built-in Middleware Exports
export { auth } from './auth/index.js';
export { rateLimit } from './rate-limit/index.js';
export { cors, corsHook } from './cors/index.js';
export { validation } from './validation/index.js';
export { requestLogger } from './request-logger/index.js';
export { performanceMonitor } from './performance-monitor/index.js';
export { errorTracker } from './error-tracker/index.js';

// Advanced Security & Performance Middleware
export { cookie } from './cookie/index.js';
export { csrf } from './csrf/index.js';
export { csp } from './csp/index.js';
export { sse } from './sse/index.js';
export { session } from './session/index.js';

// Clean Architecture Middleware
export { cache } from './cache/index.js';
export { cdn } from './cdn/index.js';

// HTTP/2 Middleware
export { http2 } from './http2/index.js';

// HTTP Utilities Middleware
export { helmet } from './helmet/index.js';
export { compression } from './compression/index.js';
export { bodySize } from './body-size/index.js';
export { staticFiles } from './static/index.js';
export { upload } from './upload/index.js';
export { template } from './template/index.js';
export { range } from './range/index.js';

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
} from './auth/helpers.js';

// JWT Utilities for Custom Middleware
export {
  safeVerifyJWT,
  extractJWTFromHeader,
  createAuthErrorResponse,
  type JWTVerificationResult,
} from './auth/jwt-helpers.js';

export {
  extendedProviders,
  enterpriseProviders,
  createCustomOAuthProvider,
  createCustomOIDCProvider,
} from './auth/providers.js';

// Import for collections
import { auth } from './auth/index.js';
import { rateLimit } from './rate-limit/index.js';
import { corsHook } from './cors/index.js';
import { validation } from './validation/index.js';
import { requestLogger } from './request-logger/index.js';
import { performanceMonitor } from './performance-monitor/index.js';
import { errorTracker } from './error-tracker/index.js';
import { cookie } from './cookie/index.js';
import { csrf } from './csrf/index.js';
import { csp } from './csp/index.js';
import { sse } from './sse/index.js';
import { session } from './session/index.js';
import { cache } from './cache/index.js';
import { cdn } from './cdn/index.js';
import { graphql } from './graphql/index.js';
import { http2 } from './http2/index.js';
import { helmet } from './helmet/index.js';
import { compression } from './compression/index.js';
import { bodySize } from './body-size/index.js';
import { staticFiles } from './static/index.js';
import { upload } from './upload/index.js';
import { template } from './template/index.js';
import { range } from './range/index.js';

export const builtInMiddleware = {
  auth,
  rateLimit,
  cors: corsHook,
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
  // GraphQL
  graphql,
  // HTTP/2
  http2,
  // HTTP Utilities
  helmet,
  compression,
  bodySize,
  staticFiles,
  upload,
  template,
  range,
};

export const simpleMiddleware = {
  requestLogger,
  performanceMonitor,
  errorTracker,
};
