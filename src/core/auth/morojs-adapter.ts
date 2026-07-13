/**
 * Better Auth Adapter for MoroJS
 *
 * This adapter allows Better Auth to work seamlessly with MoroJS framework.
 * Maintains compatibility with the original Auth.js API.
 *
 * @see https://better-auth.com/
 */

import { randomBytes } from 'crypto';
import { createFrameworkLogger } from '../logger/index.js';
import { resolveUserPackage } from '../utilities/package-utils.js';

const logger = createFrameworkLogger('AuthAdapter');

// Lazy load Better Auth (optional dependency)
let betterAuthModule: any = null;

/**
 * Dynamically load Better Auth from user's node_modules
 * This ensures it's only required when actually used
 */
async function loadBetterAuth() {
  if (betterAuthModule) {
    return betterAuthModule;
  }

  try {
    const betterAuthPath = resolveUserPackage('better-auth');
    betterAuthModule = await import(betterAuthPath);
    return betterAuthModule;
  } catch {
    throw new Error(
      'Better Auth package not found. Install it with: npm install better-auth\n' +
        'See: https://better-auth.com/ for setup instructions'
    );
  }
}

// Auth types (compatible with Auth.js)
export interface AuthConfig {
  providers: any[];
  secret?: string;
  session?: any;
  callbacks?: any;
  events?: any;
  pages?: any;
  adapter?: any;
  debug?: boolean;
  basePath?: string;
  [key: string]: any;
}

export interface Session {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
    [key: string]: any;
  };
  expires: string;
  [key: string]: any;
}

export type AuthAction = 'signin' | 'signout' | 'callback' | 'session' | 'providers' | 'csrf';

// MoroJS-specific types
export interface MoroJSAuthConfig extends Omit<AuthConfig, 'raw'> {
  /**
   * Base path for auth routes in MoroJS
   * @default "/api/auth"
   */
  basePath?: string;

  /**
   * MoroJS-specific options
   */
  morojs?: {
    /**
     * Enable MoroJS-specific logging
     * @default false
     */
    debug?: boolean;

    /**
     * Custom request/response transformers
     */
    transformers?: {
      request?: (req: any) => any;
      response?: (res: any) => any;
    };
  };
}

export interface MoroJSRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  query?: Record<string, string>;
  cookies?: Record<string, string>;
}

export interface MoroJSResponse {
  status(code: number): MoroJSResponse;
  json(data: any): Promise<void>;
  redirect(url: string): void;
  setHeader(name: string, value: string): void;
  cookie(name: string, value: string, options?: any): void;
  send(data: any): void;
  end(data?: any): void;
  headersSent: boolean;
}

/**
 * Convert MoroJS request to Auth.js Web API Request
 */
function toWebRequest(req: MoroJSRequest, basePath: string): Request {
  const url = new URL(req.url || '/', 'http://localhost:3000');

  // Handle auth routes
  if (url.pathname.startsWith(basePath)) {
    url.pathname = url.pathname.replace(basePath, '');
  }

  const headers = new Headers();
  if (req.headers) {
    Object.entries(req.headers).forEach(([key, value]) => {
      headers.set(key, value);
    });
  }

  // Add cookies to headers if not present - check first key instead of length
  if (req.cookies) {
    let hasCookies = false;
    let cookieHeader = '';
    for (const name in req.cookies) {
      if (Object.prototype.hasOwnProperty.call(req.cookies, name)) {
        if (hasCookies) {
          cookieHeader += `; ${name}=${req.cookies[name]}`;
        } else {
          cookieHeader = `${name}=${req.cookies[name]}`;
          hasCookies = true;
        }
      }
    }

    if (hasCookies && !headers.has('cookie')) {
      headers.set('cookie', cookieHeader);
    }
  }

  const body = req.body ? JSON.stringify(req.body) : undefined;

  return new Request(url.toString(), {
    method: req.method || 'GET',
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

/**
 * Parse a single Set-Cookie header value and apply it to the MoroJS response.
 */
function applySetCookie(moroResponse: MoroJSResponse, cookie: string): void {
  const [nameValue, ...options] = cookie.split('; ');
  if (nameValue === undefined) return;
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return;
  const name = nameValue.slice(0, eq);
  const cookieValue = nameValue.slice(eq + 1);

  const cookieOptions: any = {};
  options.forEach(option => {
    const optEq = option.indexOf('=');
    const optKey = (optEq === -1 ? option : option.slice(0, optEq)).toLowerCase();
    const optValue = optEq === -1 ? '' : option.slice(optEq + 1);
    switch (optKey) {
      case 'max-age':
        cookieOptions.maxAge = parseInt(optValue, 10);
        break;
      case 'expires':
        cookieOptions.expires = new Date(optValue);
        break;
      case 'httponly':
        cookieOptions.httpOnly = true;
        break;
      case 'secure':
        cookieOptions.secure = true;
        break;
      case 'samesite':
        cookieOptions.sameSite = optValue;
        break;
      case 'path':
        cookieOptions.path = optValue;
        break;
      case 'domain':
        cookieOptions.domain = optValue;
        break;
    }
  });

  moroResponse.cookie(name, cookieValue, cookieOptions);
}

/**
 * Convert Auth.js Web API Response to MoroJS response
 */
async function fromWebResponse(webResponse: Response, moroResponse: MoroJSResponse): Promise<void> {
  // Set status
  moroResponse.status(webResponse.status);

  // Set-Cookie is multi-valued and MUST be read via getSetCookie(): the Fetch
  // Headers.forEach() folds multiple Set-Cookie headers into a single
  // comma-joined string, and splitting that on ', ' corrupts any cookie whose
  // Expires attribute contains a comma ("Expires=Wed, 21 Oct 2025 ..."),
  // silently dropping or garbling auth cookies.
  const getSetCookie = (webResponse.headers as any).getSetCookie;
  const setCookies: string[] =
    typeof getSetCookie === 'function' ? getSetCookie.call(webResponse.headers) : [];
  for (const cookie of setCookies) {
    applySetCookie(moroResponse, cookie);
  }

  // Set remaining headers
  webResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'set-cookie') {
      // Handled above via getSetCookie(). Fallback for legacy runtimes without
      // it: apply the (best-effort) folded value as a single cookie.
      if (setCookies.length === 0 && value) applySetCookie(moroResponse, value);
      return;
    }
    if (lower === 'location') {
      // Handle redirects
      moroResponse.redirect(value);
      return;
    }
    moroResponse.setHeader(key, value);
  });

  // Handle response body
  const contentType = webResponse.headers.get('content-type');

  if (webResponse.status >= 300 && webResponse.status < 400) {
    // Redirect - already handled above
    return;
  } else if (contentType?.includes('application/json')) {
    const data = await webResponse.json();
    await moroResponse.json(data);
  } else {
    const text = await webResponse.text();
    moroResponse.send(text);
  }
}

/**
 * Main MoroJS Better Auth handler
 *
 * This is the core function that integrates Better Auth with MoroJS
 * Maintains API compatibility with the original Auth.js implementation
 */
export async function MoroJSAuth(config: MoroJSAuthConfig): Promise<{
  handler: (req: MoroJSRequest, res: MoroJSResponse) => Promise<void>;
  auth: (req: MoroJSRequest) => Promise<Session | null>;
}> {
  const basePath = config.basePath || '/api/auth';

  // Lazy load Better Auth
  const betterAuthModule = await loadBetterAuth();
  const { betterAuth } = betterAuthModule;

  // Convert providers to Better Auth format
  const socialProviders: Record<string, any> = {};
  for (const provider of config.providers || []) {
    if (provider.id === 'google' && provider.clientId && provider.clientSecret) {
      socialProviders.google = {
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
      };
    } else if (provider.id === 'github' && provider.clientId && provider.clientSecret) {
      socialProviders.github = {
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
      };
    } else if (provider.id === 'discord' && provider.clientId && provider.clientSecret) {
      socialProviders.discord = {
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
      };
    }
  }

  // Resolve the auth secret. Never fall back to an empty string: an empty
  // secret disables the signing/encryption Better Auth relies on. Fail fast in
  // production, and warn-plus-generate elsewhere (matching the built-in auth
  // middleware's behavior).
  const secret =
    config.secret ||
    process.env.AUTH_SECRET ||
    (() => {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          '[MoroJS Security] No auth secret configured. Set config.secret or the AUTH_SECRET environment variable before starting in production.'
        );
      }
      const generated = randomBytes(32).toString('hex');
      logger.warn(
        '[MoroJS Security] No auth secret configured. A random secret was generated — sessions will NOT survive restarts. Set config.secret or AUTH_SECRET for production use.',
        'AuthAdapter'
      );
      return generated;
    })();

  const baseURL =
    config.baseURL || process.env.BASE_URL || process.env.AUTH_URL || 'http://localhost:3000';

  // Default trustedOrigins to the app's own origin instead of a wildcard.
  // trustedOrigins is Better Auth's origin/CSRF defense for state-changing auth
  // routes and its callback/redirect-URL allowlist; ['*'] trusts every origin.
  // Users can override or extend it via config.trustedOrigins.
  let defaultOrigin: string;
  try {
    defaultOrigin = new URL(baseURL).origin;
  } catch {
    defaultOrigin = baseURL;
  }
  const trustedOrigins = config.trustedOrigins ?? [defaultOrigin];

  // Initialize Better Auth
  const betterAuthInstance = betterAuth({
    secret,
    baseURL,
    basePath,
    trustedOrigins,
    session: {
      expiresIn: config.session?.maxAge || 30 * 24 * 60 * 60,
      updateAge: config.session?.updateAge || 24 * 60 * 60,
    },
    socialProviders,
  });

  return {
    /**
     * Main request handler for auth routes
     */
    handler: async (req: MoroJSRequest, res: MoroJSResponse) => {
      try {
        // Convert MoroJS request to Web API request
        const webRequest = toWebRequest(req, basePath);

        // Apply request transformer if provided
        let transformedRequest = webRequest;
        if (config.morojs?.transformers?.request) {
          transformedRequest = config.morojs.transformers.request(webRequest);
        }

        // Call Better Auth handler
        const authResponse = await betterAuthInstance.handler(transformedRequest);

        // Apply response transformer if provided
        let finalResponse = authResponse;
        if (config.morojs?.transformers?.response) {
          finalResponse = config.morojs.transformers.response(authResponse);
        }

        // Convert Web API response to MoroJS response
        await fromWebResponse(finalResponse, res);
      } catch (error) {
        logger.error('[MoroJS Auth] Error', 'AuthAdapter', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Robust error handling - check if response methods exist
        if (typeof (res as any).status === 'function' && typeof (res as any).json === 'function') {
          (res as any).status(500).json({
            error: 'Internal server error',
            message: config.morojs?.debug ? (error as Error).message : 'Authentication error',
          });
        } else {
          // Fallback to basic Node.js response methods
          (res as any).statusCode = 500;
          (res as any).setHeader('Content-Type', 'application/json');
          (res as any).end(
            JSON.stringify({
              error: 'Internal server error',
              message: config.morojs?.debug ? (error as Error).message : 'Authentication error',
            })
          );
        }
      }
    },

    /**
     * Get session for the current request
     */
    auth: async (req: MoroJSRequest): Promise<Session | null> => {
      try {
        // Convert MoroJS request to Web API request
        const webRequest = toWebRequest(req, basePath);

        // Get session from Better Auth
        const session = await betterAuthInstance.api.getSession({
          headers: webRequest.headers,
        });

        if (session?.user) {
          return {
            user: {
              id: session.user.id,
              name: session.user.name || null,
              email: session.user.email || null,
              image: session.user.image || null,
            },
            expires: new Date(
              session.session?.expiresAt || Date.now() + 30 * 24 * 60 * 60 * 1000
            ).toISOString(),
          };
        }

        return null;
      } catch (error) {
        if (config.morojs?.debug) {
          logger.error('[MoroJS Auth] Session error', 'AuthAdapter', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      }
    },
  };
}

/**
 * MoroJS Auth middleware factory
 *
 * This creates a MoroJS-compatible middleware for authentication
 * Uses Better Auth internally while maintaining the same API
 */
export function createAuthMiddleware(config: MoroJSAuthConfig) {
  logger.info('createAuthMiddleware called - creating middleware function', 'AuthAdapter');
  // Return a function that MoroJS can call directly
  return async (app: any) => {
    logger.info('Installing Better Auth middleware...', 'AuthAdapter');
    logger.debug('App object received', 'AuthAdapter', {
      appType: typeof app,
      appConstructor: app.constructor.name,
    });

    // Get the hooks from the app's middleware system
    const hooks =
      (app as any).coreFramework?.middlewareManager?.hooks || (app as any).middlewareManager?.hooks;

    if (!hooks) {
      logger.error('Could not access MoroJS hooks system', 'AuthAdapter');
      return;
    }

    const options = {};
    const mergedConfig = { ...config, ...options };
    const authHandlers = await MoroJSAuth(mergedConfig);
    const basePath = mergedConfig.basePath || '/api/auth';

    // Register request hook
    hooks.before('request', async (context: any) => {
      logger.debug('Native adapter hook starting', 'AuthAdapter');
      const req = context.request;
      logger.debug('Request path', 'AuthAdapter', { path: req.path || req.url });

      try {
        // Get session from Better Auth
        const session = await authHandlers.auth(req);

        // Add auth object to request
        req.auth = {
          session: session,
          user: session?.user || null,
          isAuthenticated: !!session?.user,

          // Helper methods
          getSession: async () => session,
          getUser: () => session?.user || null,

          // Sign in/out helpers (redirect to auth routes)
          signIn: (provider?: string, options?: any) => {
            const params = new URLSearchParams();
            if (provider) params.set('provider', provider);
            if (options?.callbackUrl) params.set('callbackUrl', options.callbackUrl);

            const signInUrl = `${basePath}/signin${provider ? `/${provider}` : ''}${
              params.toString() ? `?${params.toString()}` : ''
            }`;

            return { url: signInUrl };
          },

          signOut: (options?: any) => {
            const params = new URLSearchParams();
            if (options?.callbackUrl) params.set('callbackUrl', options.callbackUrl);

            const signOutUrl = `${basePath}/signout${
              params.toString() ? `?${params.toString()}` : ''
            }`;

            return { url: signOutUrl };
          },
        };
        logger.debug('Native adapter hook completed successfully', 'AuthAdapter');
      } catch (error) {
        logger.error('Error in native adapter hook', 'AuthAdapter', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });

    logger.info('Better Auth middleware installed successfully!', 'AuthAdapter');
  };
}

// Types are already exported above, no need to re-export

/**
 * Default export for convenience
 */
export default MoroJSAuth;
