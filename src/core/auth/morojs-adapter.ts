/**
 * Auth.js Adapter for MoroJS
 *
 * This adapter allows Auth.js to work seamlessly with MoroJS framework.
 * It can be contributed to the Auth.js project as @auth/morojs
 *
 * @see https://authjs.dev/guides/adapters/creating-a-custom-adapter
 * @see https://github.com/nextauthjs/next-auth/tree/main/packages
 */

import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('AuthAdapter');

// Auth.js types
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

/**
 * Placeholder Auth function
 *
 * NOTE: This is a stub implementation. To use Auth.js with MoroJS:
 * 1. Install @auth/core: npm install @auth/core
 * 2. Import the real Auth function: import { Auth } from '@auth/core';
 * 3. Replace this stub with the actual Auth function
 *
 * This stub allows the adapter to compile without @auth/core installed.
 */
const Auth = async (_request: Request, _config: any): Promise<Response> => {
  throw new Error(
    'Auth.js is not configured. Please install @auth/core and configure it properly. ' +
      'See docs/AUTH_GUIDE.md for setup instructions.'
  );
};

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
    body,
  });
}

/**
 * Convert Auth.js Web API Response to MoroJS response
 */
async function fromWebResponse(webResponse: Response, moroResponse: MoroJSResponse): Promise<void> {
  // Set status
  moroResponse.status(webResponse.status);

  // Set headers
  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      // Handle cookies specially for MoroJS
      const cookies = value.split(', ');
      cookies.forEach(cookie => {
        const [nameValue, ...options] = cookie.split('; ');
        const [name, cookieValue] = nameValue.split('=');

        // Parse cookie options
        const cookieOptions: any = {};
        options.forEach(option => {
          const [optKey, optValue] = option.split('=');
          switch (optKey.toLowerCase()) {
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
      });
    } else if (key.toLowerCase() === 'location') {
      // Handle redirects
      moroResponse.redirect(value);
      return;
    } else {
      moroResponse.setHeader(key, value);
    }
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
 * Main MoroJS Auth.js handler
 *
 * This is the core function that integrates Auth.js with MoroJS
 */
export async function MoroJSAuth(config: MoroJSAuthConfig): Promise<{
  handler: (req: MoroJSRequest, res: MoroJSResponse) => Promise<void>;
  auth: (req: MoroJSRequest) => Promise<Session | null>;
}> {
  const basePath = config.basePath || '/api/auth';

  return {
    /**
     * Main request handler for auth routes
     */
    handler: async (req: MoroJSRequest, res: MoroJSResponse) => {
      try {
        // Convert MoroJS request to Web API request
        const webRequest = toWebRequest(req, basePath);

        // Determine the auth action from the URL
        const url = new URL(webRequest.url);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const action = (url.pathname.split('/')[1] as AuthAction) || 'session';

        // Apply request transformer if provided
        let transformedRequest = webRequest;
        if (config.morojs?.transformers?.request) {
          transformedRequest = config.morojs.transformers.request(webRequest);
        }

        // Call Auth.js core
        const authResponse = await Auth(transformedRequest, {
          ...config,
          basePath,
          raw: (code: any, ...message: any[]) => {
            if (config.morojs?.debug) {
              logger.debug(`[MoroJS Auth] ${code}:`, 'AuthAdapter', { message });
            }
          },
        });

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
        // Create a session request
        const sessionUrl = new URL('/session', 'http://localhost:3000');
        const sessionRequest = new Request(sessionUrl.toString(), {
          method: 'GET',
          headers: req.headers ? new Headers(req.headers) : new Headers(),
        });

        // Get session from Auth.js
        const response = await Auth(sessionRequest, {
          ...config,
          basePath,
        });

        if (response.status === 200) {
          const session = await response.json();
          return session as Session;
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
 */
export function createAuthMiddleware(config: MoroJSAuthConfig) {
  logger.info('createAuthMiddleware called - creating middleware function', 'AuthAdapter');
  // Return a function that MoroJS can call directly
  return async (app: any) => {
    logger.info('Installing Auth.js middleware...', 'AuthAdapter');
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
    await MoroJSAuth(mergedConfig);
    // Note: The auth handler would need to be registered as routes in a complete implementation
    // For now, we just use the basePath for generating URLs
    const basePath = mergedConfig.basePath || '/api/auth';

    // Register request hook
    hooks.before('request', async (context: any) => {
      logger.debug('Native adapter hook starting', 'AuthAdapter');
      const req = context.request;
      logger.debug('Request path', 'AuthAdapter', { path: req.path || req.url });

      try {
        // Just add auth object to request - don't touch response
        req.auth = {
          session: null,
          user: null,
          isAuthenticated: false,

          // Helper methods
          getSession: () => Promise.resolve(null),
          getUser: () => null,

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

    logger.info('Auth.js middleware installed successfully!', 'AuthAdapter');
  };
}

// Types are already exported above, no need to re-export

/**
 * Default export for convenience
 */
export default MoroJSAuth;
