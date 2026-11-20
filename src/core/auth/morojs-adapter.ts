/**
 * Better Auth Adapter for MoroJS
 *
 * Runs sign-in, callback, session and sign-out on Better Auth and puts the
 * signed-in user on `req.auth`. The configuration keeps the Auth.js-style
 * shape (`providers`, `secret`, `session`, `basePath`); what Better Auth has
 * an option for is translated, `betterAuth` hands options straight through,
 * and a key with no Better Auth equivalent is named in a start-up warning.
 *
 * @see https://better-auth.com/
 */

import { randomBytes } from 'crypto';
import { createFrameworkLogger } from '../logger/index.js';
import { resolveUserPackage } from '../utilities/package-utils.js';
import { escapeHtml } from '../docs/html-escape.js';
import {
  applyAuthFeatures,
  describeMemoryStorage,
  describeMissingTables,
  usesAuthFeatures,
  type AppliedAuthFeatures,
  type AuthFeatureOptions,
} from './feature-helpers.js';

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

/** True when the `better-auth` package can be resolved from the application. */
export function isBetterAuthInstalled(): boolean {
  try {
    resolveUserPackage('better-auth');
    return true;
  } catch {
    return false;
  }
}

// The social provider ids of better-auth 1.7.x. Used only when the installed
// package cannot be asked for its own list.
const SOCIAL_PROVIDER_IDS = [
  'apple',
  'atlassian',
  'cloudflare',
  'cognito',
  'discord',
  'facebook',
  'figma',
  'github',
  'microsoft',
  'google',
  'huggingface',
  'slack',
  'spotify',
  'twitch',
  'twitter',
  'dropbox',
  'kick',
  'linear',
  'linkedin',
  'gitlab',
  'tiktok',
  'reddit',
  'roblox',
  'salesforce',
  'vk',
  'zoom',
  'notion',
  'kakao',
  'naver',
  'line',
  'paybin',
  'paypal',
  'polar',
  'railway',
  'vercel',
  'wechat',
];

type SocialProviderFactory = (options: Record<string, any>) => unknown;

/**
 * The social providers of the installed Better Auth, by id, or null when the
 * package cannot be asked. An id outside this table cannot be handed to
 * `socialProviders`: Better Auth throws on it.
 */
async function loadSocialProviders(): Promise<Record<string, SocialProviderFactory> | null> {
  try {
    const loaded = await import(resolveUserPackage('better-auth/social-providers'));
    const table = loaded.socialProviders ?? loaded.default?.socialProviders;
    if (table && typeof table === 'object' && Object.keys(table).length > 0) return table;
  } catch {
    // Older layout or a bundled build: fall back to the list above
  }
  return null;
}

// Auth types (compatible with Auth.js)
export interface AuthConfig {
  providers?: any[];
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
  /**
   * The organization the session is working in, or `null` when none is
   * active. Present when Better Auth's organization plugin is in use
   * (`organization()`).
   */
  activeOrganizationId?: string | null;
  [key: string]: any;
}

export type AuthAction = 'signin' | 'signout' | 'callback' | 'session' | 'providers' | 'csrf';

// MoroJS-specific types
//
// `plugins`, `accountLinking` and `rateLimit` (AuthFeatureOptions) take the
// feature helpers: `plugins: [twoFactor(), organization(), anonymous(),
// bearerToken()]`, `accountLinking: accountLinking()`, `rateLimit: rateLimit()`.
export interface MoroJSAuthConfig extends Omit<AuthConfig, 'raw'>, AuthFeatureOptions {
  /**
   * Base path for auth routes in MoroJS
   * @default "/api/auth"
   */
  basePath?: string;

  /**
   * The public URL the application is reached at, for example
   * `https://app.example.com`. OAuth redirect URIs are built from it and its
   * origin is the default trusted origin. Falls back to the `BASE_URL` or
   * `AUTH_URL` environment variable, then to `http://localhost:3000`.
   */
  baseURL?: string;

  /**
   * Origins allowed to call the state-changing auth routes and to be
   * redirected to after sign-in.
   * @default [origin of baseURL]
   */
  trustedOrigins?: string[];

  /**
   * Options handed to `betterAuth()` as they are, for everything the keys
   * above do not cover: `database`, `emailAndPassword`, `plugins`, `hooks`,
   * `databaseHooks`, `advanced`, `rateLimit`, `account`, `user` and so on.
   * A key given here wins over the value derived from the keys above;
   * `socialProviders` and `session` are merged with the derived ones, and so
   * are `plugins`, `account.accountLinking` and `rateLimit` with what the
   * feature helpers (`plugins`, `accountLinking`, `rateLimit` above) add.
   */
  betterAuth?: Record<string, any>;

  /**
   * `createAuthMiddleware()` serves the auth routes under `basePath`. Set to
   * `false` to add `req.auth` only and mount `MoroJSAuth().handler` yourself.
   * @default true
   */
  mountRoutes?: boolean;

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

// Both shapes are what `handler(req, res)` and `auth(req)` need from their
// arguments. They are written so that the request and response a MoroJS route
// handler receives satisfy them as they are, whatever strictness the project
// compiles with: `(req, res) => auth.handler(req, res)` needs no cast.
export interface MoroJSRequest {
  url?: string | undefined;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: any;
  query?: Record<string, string> | undefined;
  cookies?: Record<string, string> | undefined;
}

export interface MoroJSResponse {
  status(code: number): MoroJSResponse;
  json(data: any): void | Promise<void>;
  redirect(url: string): void;
  setHeader(name: string, value: string): void;
  cookie(name: string, value: string, options?: any): void;
  send(data: any): void;
  end(data?: any): void;
  headersSent: boolean;
}

/** What `MoroJSAuth()` resolves to. */
export interface MoroJSAuthHandlers {
  /** Answers a request under `basePath`: Better Auth's routes plus `signin` and `signout`. */
  handler: (req: MoroJSRequest, res: MoroJSResponse) => Promise<void>;
  /** The session of the request, or `null`. */
  auth: (req: MoroJSRequest) => Promise<Session | null>;
  /** The base path the routes are served under. */
  basePath: string;
  /** Ids of the social providers handed to Better Auth. */
  providers: string[];
  /** The URL that starts a sign-in: `<basePath>/signin[/<provider>]`. */
  signInUrl: (provider?: string, options?: { callbackUrl?: string }) => string;
  /** The URL that ends the session: `<basePath>/signout`. */
  signOutUrl: (options?: { callbackUrl?: string }) => string;
  /** The Better Auth instance, for its server API (`instance.api.*`). */
  instance: any;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function headerValue(req: MoroJSRequest, name: string): string {
  const value = (req.headers as Record<string, unknown> | undefined)?.[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/**
 * The request body as the text Better Auth will parse. MoroJS has already
 * parsed it, so a form post is written back as a form and anything else as
 * JSON, to match the Content-Type header that is passed on unchanged.
 */
function serializeBody(req: MoroJSRequest): string | Uint8Array | undefined {
  const body = req.body;
  if (body === undefined || body === null || body === '') return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  const contentType = headerValue(req, 'content-type').toLowerCase();
  if (contentType.startsWith('application/x-www-form-urlencoded') && isPlainObject(body)) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, item === null ? '' : `${item}`);
      } else if (value === null) {
        params.append(key, '');
      } else if (isPlainObject(value)) {
        params.append(key, JSON.stringify(value));
      } else {
        params.append(key, `${value}`);
      }
    }
    return params.toString();
  }
  return JSON.stringify(body);
}

/**
 * The path and query string of the request.
 *
 * `req.url` carries both on the servers and on the framework's serverless
 * runtimes. A request that carries its query only as `req.query` (one built
 * by a custom runtime adapter, or by hand for `MoroJSAuth().handler`) has it
 * written back here, so that a provider's `?code=...&state=...` and a
 * `callbackUrl` reach Better Auth from there too.
 */
function requestTarget(req: MoroJSRequest): string {
  const url = req.url || '/';
  const query: unknown = req.query;
  if (query === undefined || query === null || typeof query !== 'object' || url.includes('?')) {
    return url;
  }
  const params = new URLSearchParams();
  for (const name of Object.keys(query)) {
    const value = (query as Record<string, unknown>)[name];
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, String(item));
  }
  const search = params.toString();
  return search === '' ? url : `${url}?${search}`;
}

/**
 * Convert MoroJS request to Auth.js Web API Request
 */
function toWebRequest(req: MoroJSRequest, basePath: string): Request {
  const url = new URL(requestTarget(req), 'http://localhost:3000');

  // Handle auth routes
  if (url.pathname.startsWith(basePath)) {
    url.pathname = url.pathname.replace(basePath, '');
  }

  const headers = new Headers();
  if (req.headers) {
    Object.entries(req.headers as Record<string, unknown>).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, String(item));
        return;
      }
      headers.set(key, String(value));
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

  const method = req.method || 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : serializeBody(req);
  if (body !== undefined) {
    // The length of the text MoroJS read is not the length of what is sent on
    headers.delete('content-length');
    headers.delete('transfer-encoding');
  }

  return new Request(url.toString(), {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

/** True when `pathname` is `basePath` itself or lies below it. */
function isUnderBasePath(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

/**
 * Better Auth is configured with `basePath` and matches its routes against the
 * full request path, so the request it is handed must lie under `basePath`.
 * toWebRequest() removes that prefix (the session lookup only reads headers);
 * put it back here unless it is already there, which is the case when a
 * `morojs.transformers.request` restored it.
 */
function underBasePath(request: Request, basePath: string): Request {
  const base = basePath.replace(/\/+$/, '');
  if (!base) return request;

  const url = new URL(request.url);
  if (isUnderBasePath(url.pathname, base)) return request;

  url.pathname = `${base}${url.pathname.startsWith('/') ? '' : '/'}${url.pathname}`;
  return new Request(url, request);
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
  // The value in a Set-Cookie header is already percent-encoded, and
  // res.cookie() percent-encodes what it is given. Decode it first so the
  // cookie reaches the client as Better Auth wrote it: encoded twice, a signed
  // session token no longer matches its signature when it comes back.
  let cookieValue = nameValue.slice(eq + 1);
  try {
    cookieValue = decodeURIComponent(cookieValue);
  } catch {
    // Not percent-encoded text: pass it on as it is
  }

  const cookieOptions: any = {};
  options.forEach(option => {
    const optEq = option.indexOf('=');
    const optKey = (optEq === -1 ? option : option.slice(0, optEq)).toLowerCase();
    const optValue = optEq === -1 ? '' : option.slice(optEq + 1);
    switch (optKey) {
      case 'max-age':
        // Max-Age counts seconds; res.cookie() takes maxAge in milliseconds
        cookieOptions.maxAge = parseInt(optValue, 10) * 1000;
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
 * True when the browser is navigating: following a link, a redirect or a
 * submitted form, as opposed to a script calling fetch(). Browsers state it in
 * `Sec-Fetch-Mode`; without that header a form content type is the sign.
 */
function isNavigationRequest(req: MoroJSRequest): boolean {
  const mode = headerValue(req, 'sec-fetch-mode');
  if (mode !== '') return mode === 'navigate';
  const contentType = headerValue(req, 'content-type').toLowerCase();
  return (
    contentType.startsWith('application/x-www-form-urlencoded') ||
    contentType.startsWith('multipart/form-data')
  );
}

// Carries the client address MoroJS determined (req.ip: the socket's peer, or
// the client as the proxies named in server.trustProxy report it) to Better
// Auth, which reads addresses from request headers only.
//
// Better Auth is told to consult it after X-Forwarded-For. With
// `server.trustProxy` set, req.ip is the operator's own statement of who the
// client is, and the X-Forwarded-For a request carries is not handed on, so
// this header is the one Better Auth reads. Without the setting the framework
// cannot tell a proxy's X-Forwarded-For from one a client wrote, and Better
// Auth's order stands: this header then decides only where Better Auth would
// otherwise have no address and rate-limit every client as one.
const CLIENT_ADDRESS_HEADER = 'x-moro-client-ip';

/**
 * How the client address reaches Better Auth for one set of handlers.
 * `managed` is false when the application named the address source itself
 * (`advanced.ipAddress.ipAddressHeaders` or `trustedProxies`): nothing is
 * taken from its requests then. `trustProxy` is set once an app whose
 * `server.trustProxy` is set serves the handlers.
 */
interface ClientAddressSource {
  managed: boolean;
  trustProxy: boolean;
}

/** True when the server that received `req` has `server.trustProxy` set. */
function servedWithTrustProxy(req: MoroJSRequest): boolean {
  const server = (req as { _server?: { proxyTrust?: unknown } | null })._server;
  return server !== undefined && server !== null && server.proxyTrust !== undefined;
}

/** Put the client address of `req` on the headers handed to Better Auth. */
function setClientAddress(headers: Headers, req: MoroJSRequest, source: ClientAddressSource): void {
  // Whatever the client sent under this name is not the client's address
  headers.delete(CLIENT_ADDRESS_HEADER);
  const address = (req as { ip?: unknown }).ip;
  if (typeof address === 'string' && address !== '') {
    headers.set(CLIENT_ADDRESS_HEADER, address);
  }
  // server.trustProxy has already been applied in req.ip. What the request
  // itself says about forwarding is not offered to Better Auth a second time.
  if (source.managed && (source.trustProxy || servedWithTrustProxy(req))) {
    headers.delete('x-forwarded-for');
  }
}

// Start-up messages already logged in this process. Creating the handlers
// twice for one configuration (a script that prepares the database, then the
// application) says each thing once.
const SAID = new Set<string>();

function warnOnce(message: string): void {
  if (SAID.has(message)) return;
  SAID.add(message);
  logger.warn(`Better Auth adapter: ${message}`, 'AuthAdapter');
}

/** @internal Forget which start-up warnings were logged (for tests). */
export function forgetStartupWarnings(): void {
  SAID.clear();
}

/**
 * Convert Auth.js Web API Response to MoroJS response
 *
 * A 3xx answer is relayed as the redirect it is. Better Auth also answers
 * some requests (starting a social sign-in, an email sign-in given a
 * `callbackURL`) with 200, a JSON body and a `Location` header: its own
 * client reads the body and navigates. With `followLocation` that answer
 * becomes a 302, which is what a browser that submitted a form needs; without
 * it the answer is passed on unchanged, which is what a fetch() caller needs
 * (a redirect would send the fetch itself to the provider).
 */
async function fromWebResponse(
  webResponse: Response,
  moroResponse: MoroJSResponse,
  followLocation = false
): Promise<void> {
  const location = webResponse.headers.get('location');
  const isRedirectStatus = webResponse.status >= 300 && webResponse.status < 400;
  const redirect = location !== null && (isRedirectStatus || followLocation);

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
    // A redirect is written last, below, once every other header is set
    if (lower === 'location' && redirect) return;
    moroResponse.setHeader(key, value);
  });

  if (redirect) {
    moroResponse.redirect(location as string);
    return;
  }

  // Handle response body
  const contentType = webResponse.headers.get('content-type');

  if (isRedirectStatus) {
    // A 3xx without a Location: nothing to follow and no body to relay
    moroResponse.end();
  } else if (contentType?.includes('application/json')) {
    // Better Auth answers some refusals (an organization route called without
    // a session, for one) with a JSON content type and no body at all
    const text = await webResponse.text();
    if (text === '') {
      moroResponse.end();
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      moroResponse.send(text);
      return;
    }
    await moroResponse.json(data);
  } else {
    const text = await webResponse.text();
    moroResponse.send(text);
  }
}

// Auth.js-style keys Better Auth has no option for, with what to use instead.
const UNSUPPORTED_KEYS: Record<string, string> = {
  callbacks:
    'Better Auth has no callbacks. Use `betterAuth: { hooks, databaseHooks }` (for example ' +
    '`databaseHooks.user.create.before` to refuse a sign-up) and `mapProfileToUser` on a provider entry.',
  events:
    'Use `betterAuth: { databaseHooks }` (`user.create.after`, `session.create.after`) or ' +
    '`betterAuth: { hooks: { after } }`.',
  pages:
    'Serve your own pages and link them to `req.auth.signIn(provider).url`; for the error page ' +
    'use `betterAuth: { onAPIError: { errorURL } }`.',
  adapter: 'Pass a Better Auth database instead: `betterAuth: { database }`.',
  cookies: 'Use `betterAuth: { advanced: { cookies, cookiePrefix } }`.',
  theme: 'There are no built-in pages to theme.',
  logger: 'Use `betterAuth: { logger }`.',
  trustHost:
    'Set `baseURL` (or BASE_URL / AUTH_URL) to the public URL; behind a proxy see ' +
    '`betterAuth: { advanced: { trustedProxyHeaders } }`.',
  skipCSRFCheck: 'Use `betterAuth: { advanced: { disableCSRFCheck } }`.',
  experimental: 'Use Better Auth plugins: `betterAuth: { plugins: [...] }`.',
  jwt:
    'A Better Auth session is not a JWT configured here. For API tokens use `auth({ jwt })`, ' +
    'session tokens as Bearer tokens with `plugins: [bearerToken()]`, or ' +
    "Better Auth's `jwt` plugin through `betterAuth: { plugins: [...] }`.",
};

const UNSUPPORTED_SESSION_KEYS: Record<string, string> = {
  strategy:
    'Better Auth chooses where sessions live from `betterAuth: { database }`: without a database ' +
    'they are kept in signed cookies, with one they are stored in it. `session.cookieCache` is passed on.',
  generateSessionToken: 'Use `betterAuth: { advanced: { database: { generateId } } }`.',
};

// Fields of an Auth.js-style provider entry that describe the provider rather
// than configure it. Better Auth knows the endpoints of its own providers.
const PROVIDER_DESCRIPTOR_FIELDS = new Set([
  'id',
  'name',
  'type',
  'authorization',
  'token',
  'userinfo',
  'issuer',
  'wellKnown',
  'profile',
  'claims',
  'authorization_params',
  'token_endpoint_auth_method',
]);

/** The fields of one provider entry, in the shape Better Auth's provider takes. */
function toSocialProviderOptions(provider: Record<string, any>): Record<string, any> {
  const options: Record<string, any> = {};
  for (const key of Object.keys(provider)) {
    if (PROVIDER_DESCRIPTOR_FIELDS.has(key)) continue;
    const value = provider[key];
    if (value === undefined) continue;
    options[key] = value;
  }

  // Auth.js writes scopes as one space-separated string, Better Auth as a list
  if (typeof options.scope === 'string') {
    options.scope = options.scope.split(/[\s,]+/).filter((scope: string) => scope !== '');
  }
  // Names the MoroJS provider helpers use for options Better Auth has under another name
  if (options.tenant !== undefined && options.tenantId === undefined) {
    options.tenantId = options.tenant;
  }
  delete options.tenant;
  if (options.hostedDomain !== undefined && options.hd === undefined) {
    options.hd = options.hostedDomain;
  }
  delete options.hostedDomain;

  return options;
}

interface TranslatedConfig {
  options: Record<string, any>;
  /** False when the application named Better Auth's client-address source itself */
  managesClientAddress: boolean;
  basePath: string;
  baseURL: string;
  trustedOrigins: unknown;
  warnings: string[];
}

/** Build the `betterAuth()` options from the adapter configuration. */
function toBetterAuthOptions(
  config: MoroJSAuthConfig,
  providerTable: Record<string, SocialProviderFactory> | null
): TranslatedConfig {
  const knownProviders = new Set(providerTable ? Object.keys(providerTable) : SOCIAL_PROVIDER_IDS);
  const warnings: string[] = [];
  const passThrough: Record<string, any> = isPlainObject(config.betterAuth)
    ? config.betterAuth
    : {};
  const basePath = authBasePath(config);

  // Providers: every entry whose id Better Auth knows, with its fields
  const socialProviders: Record<string, any> = {};
  for (const provider of config.providers || []) {
    if (!provider || typeof provider.id !== 'string') continue;
    if (!knownProviders.has(provider.id)) {
      warnings.push(
        `provider '${provider.id}' is not a Better Auth social provider and was not configured. ` +
          (provider.type === 'credentials'
            ? 'For passwords use `betterAuth: { emailAndPassword: { enabled: true }, database }`.'
            : provider.type === 'email'
              ? "Use Better Auth's `magicLink` / `emailOTP` plugins through `betterAuth: { plugins: [...] }`."
              : "For any other OAuth 2 or OpenID Connect provider use Better Auth's `genericOAuth` plugin through `betterAuth: { plugins: [...] }`.")
      );
      continue;
    }
    if (!provider.clientId) {
      warnings.push(`provider '${provider.id}' has no clientId and was not configured.`);
      continue;
    }
    const providerOptions = toSocialProviderOptions(provider);
    // Better Auth builds each provider when it starts and refuses the whole
    // configuration over one it cannot build (a missing required option).
    // Build it here first, so that one provider's mistake costs that provider.
    const factory = providerTable?.[provider.id];
    if (typeof factory === 'function') {
      try {
        factory(providerOptions);
      } catch (error) {
        warnings.push(
          `provider '${provider.id}' was refused by Better Auth and was not configured: ` +
            (error instanceof Error ? error.message : String(error))
        );
        continue;
      }
    }
    socialProviders[provider.id] = providerOptions;
  }

  for (const key of Object.keys(UNSUPPORTED_KEYS)) {
    if (config[key] !== undefined && config[key] !== null) {
      warnings.push(`'${key}' is not used. ${UNSUPPORTED_KEYS[key]}`);
    }
  }

  // Session: maxAge is Auth.js's name for expiresIn; the rest are Better
  // Auth's own names and go through as they are
  const session: Record<string, any> = {};
  if (isPlainObject(config.session)) {
    for (const key of Object.keys(config.session)) {
      const value = config.session[key];
      if (value === undefined) continue;
      if (key in UNSUPPORTED_SESSION_KEYS) {
        warnings.push(`'session.${key}' is not used. ${UNSUPPORTED_SESSION_KEYS[key]}`);
      } else if (key === 'maxAge') {
        if (config.session.expiresIn === undefined) session.expiresIn = value;
      } else {
        session[key] = value;
      }
    }
  }
  if (!session.expiresIn) session.expiresIn = 30 * 24 * 60 * 60;
  if (!session.updateAge) session.updateAge = 24 * 60 * 60;

  // Resolve the auth secret. Never fall back to an empty string: an empty
  // secret disables the signing/encryption Better Auth relies on. Fail fast in
  // production, and warn-plus-generate elsewhere (matching the built-in auth
  // middleware's behavior).
  const secret =
    config.secret ||
    passThrough.secret ||
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

  const configuredBaseURL =
    config.baseURL || passThrough.baseURL || process.env.BASE_URL || process.env.AUTH_URL;
  const baseURL = configuredBaseURL || 'http://localhost:3000';
  if (!configuredBaseURL && process.env.NODE_ENV === 'production') {
    warnings.push(
      'no `baseURL` is configured, so http://localhost:3000 is used: OAuth redirect URIs and the ' +
        'trusted origin will be wrong anywhere else. Set `baseURL` (or BASE_URL / AUTH_URL) to the public URL.'
    );
  }

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
  const trustedOrigins = config.trustedOrigins ?? passThrough.trustedOrigins ?? [defaultOrigin];

  // Better Auth keys its rate limits by client address. Its own sources come
  // first; the address MoroJS determined follows (see CLIENT_ADDRESS_HEADER).
  // An application that names the headers, or the proxies Better Auth should
  // trust, itself is left alone.
  const givenAdvanced: Record<string, any> = isPlainObject(passThrough.advanced)
    ? passThrough.advanced
    : {};
  const givenIpAddress: Record<string, any> = isPlainObject(givenAdvanced.ipAddress)
    ? givenAdvanced.ipAddress
    : {};
  const advanced: Record<string, any> = {
    ...(config.useSecureCookies !== undefined ? { useSecureCookies: config.useSecureCookies } : {}),
    ...givenAdvanced,
    ipAddress: {
      ...givenIpAddress,
      ipAddressHeaders: givenIpAddress.ipAddressHeaders ?? [
        'x-forwarded-for',
        CLIENT_ADDRESS_HEADER,
      ],
    },
  };

  const options: Record<string, any> = {
    ...(config.debug === true ? { logger: { level: 'debug' } } : {}),
    ...passThrough,
    secret,
    baseURL,
    basePath,
    trustedOrigins,
    advanced,
    session: { ...session, ...(isPlainObject(passThrough.session) ? passThrough.session : {}) },
    socialProviders: {
      ...socialProviders,
      ...(isPlainObject(passThrough.socialProviders) ? passThrough.socialProviders : {}),
    },
  };

  const managesClientAddress =
    givenIpAddress.ipAddressHeaders === undefined && givenIpAddress.trustedProxies === undefined;

  return { options, managesClientAddress, basePath, baseURL, trustedOrigins, warnings };
}

/**
 * Where a browser may be sent after signing out: a path on this site, or a
 * URL on a trusted origin. Anything else becomes `/`.
 */
function safeRedirectTarget(value: unknown, trustedOrigins: string[]): string {
  if (typeof value !== 'string' || value === '') return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(value)) return '/';
  if (value.startsWith('/')) return value.startsWith('//') ? '/' : value;
  try {
    const url = new URL(value);
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      trustedOrigins.includes(url.origin)
    ) {
      return value;
    }
  } catch {
    // Not a URL
  }
  return '/';
}

function providerLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Main MoroJS Better Auth handler
 *
 * Creates the Better Auth instance for `config` and returns `handler(req, res)`
 * for the routes under `basePath` and `auth(req)` for the session of a
 * request. `createAuthMiddleware()` calls this and mounts the handler; call it
 * yourself to mount the handler by hand.
 */
export async function MoroJSAuth(config: MoroJSAuthConfig): Promise<MoroJSAuthHandlers> {
  // Lazy load Better Auth
  const betterAuthModule = await loadBetterAuth();
  const { betterAuth } = betterAuthModule;

  const { options, managesClientAddress, basePath, baseURL, trustedOrigins, warnings } =
    toBetterAuthOptions(config, await loadSocialProviders());
  const addressSource: ClientAddressSource = { managed: managesClientAddress, trustProxy: false };
  // The feature helpers: their plugins and options join the ones above
  let stored: AppliedAuthFeatures['stored'] = [];
  if (usesAuthFeatures(config)) {
    const applied = await applyAuthFeatures(config, options);
    warnings.push(...applied.warnings);
    stored = applied.stored;
    // Their plugins keep data, and without a database Better Auth keeps it in
    // the memory of the process
    if (stored.length > 0 && (options.database === undefined || options.database === null)) {
      warnings.push(describeMemoryStorage(stored));
    }
  }

  for (const warning of warnings) warnOnce(warning);

  const debug = config.morojs?.debug === true || config.debug === true;
  const providerIds = Object.keys(options.socialProviders);

  let baseOrigin: string;
  try {
    baseOrigin = new URL(baseURL).origin;
  } catch {
    baseOrigin = baseURL;
  }
  const redirectOrigins = [
    baseOrigin,
    ...(Array.isArray(trustedOrigins)
      ? trustedOrigins.filter((origin): origin is string => typeof origin === 'string')
      : []),
  ];

  // Initialize Better Auth
  const betterAuthInstance = betterAuth(options);

  const signInUrl = (provider?: string, urlOptions?: { callbackUrl?: string }): string => {
    const params = new URLSearchParams();
    if (provider) params.set('provider', provider);
    if (urlOptions?.callbackUrl) params.set('callbackUrl', urlOptions.callbackUrl);

    return `${basePath}/signin${provider ? `/${provider}` : ''}${
      params.toString() ? `?${params.toString()}` : ''
    }`;
  };

  const signOutUrl = (urlOptions?: { callbackUrl?: string }): string => {
    const params = new URLSearchParams();
    if (urlOptions?.callbackUrl) params.set('callbackUrl', urlOptions.callbackUrl);

    return `${basePath}/signout${params.toString() ? `?${params.toString()}` : ''}`;
  };

  /** Hand a Web request (its path without `basePath`) to Better Auth. */
  const dispatch = async (webRequest: Request): Promise<Response> => {
    // Apply request transformer if provided
    let transformedRequest = webRequest;
    if (config.morojs?.transformers?.request) {
      transformedRequest = config.morojs.transformers.request(webRequest);
    }

    // Call Better Auth handler, with the request path under basePath
    const authResponse = await betterAuthInstance.handler(
      underBasePath(transformedRequest, basePath)
    );

    // Apply response transformer if provided
    if (config.morojs?.transformers?.response) {
      return config.morojs.transformers.response(authResponse);
    }
    return authResponse;
  };

  /**
   * Call one of Better Auth's JSON routes on behalf of `req`, with the
   * request's own cookies and headers. `origin` replaces the Origin header: it
   * is given only for a request this adapter has itself established is not a
   * cross-site one, since Better Auth takes the header as the caller's origin.
   */
  const callJsonRoute = (
    req: MoroJSRequest,
    path: string,
    payload: Record<string, any>,
    origin?: string
  ): Promise<Response> => {
    const forwarded = toWebRequest(
      { url: path, method: 'GET', headers: req.headers, cookies: req.cookies },
      basePath
    );
    const headers = new Headers(forwarded.headers);
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    headers.set('content-type', 'application/json');
    if (origin !== undefined) headers.set('origin', origin);
    setClientAddress(headers, req, addressSource);
    return dispatch(
      new Request(forwarded.url, { method: 'POST', headers, body: JSON.stringify(payload) })
    );
  };

  const requestParam = (req: MoroJSRequest, url: URL, name: string): string | undefined => {
    const fromBody = isPlainObject(req.body) ? req.body[name] : undefined;
    if (typeof fromBody === 'string' && fromBody !== '') return fromBody;
    const fromQuery = url.searchParams.get(name);
    return fromQuery === null || fromQuery === '' ? undefined : fromQuery;
  };

  /**
   * The routes this adapter adds to Better Auth's own, so that the URLs
   * `req.auth.signIn()` and `req.auth.signOut()` return can be navigated to:
   *
   *   GET       <basePath>/signin             choose a provider
   *   GET|POST  <basePath>/signin/<provider>  start the provider's sign-in
   *   GET|POST  <basePath>/signout            end the session
   *
   * Resolves to true when the request was one of them and has been answered.
   */
  const handleOwnRoute = async (req: MoroJSRequest, res: MoroJSResponse): Promise<boolean> => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'POST') return false;

    const url = new URL(requestTarget(req), 'http://localhost:3000');
    if (!isUnderBasePath(url.pathname, basePath)) return false;
    const route = url.pathname.slice(basePath.length).replace(/\/+$/, '');
    const callbackUrl =
      requestParam(req, url, 'callbackUrl') ?? requestParam(req, url, 'callbackURL');
    const navigation = method === 'GET' || isNavigationRequest(req);

    if (route === '/signin') {
      if (method !== 'GET') return false;
      const link = (id: string) => signInUrl(id, callbackUrl ? { callbackUrl } : undefined);
      if (providerIds.length === 1) {
        res.redirect(link(providerIds[0] as string));
        return true;
      }
      if (headerValue(req, 'accept').includes('text/html')) {
        const items = providerIds
          .map(
            id =>
              `<li><a href="${escapeHtml(link(id))}">Continue with ${escapeHtml(providerLabel(id))}</a></li>`
          )
          .join('');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(
          '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width, initial-scale=1">' +
            '<title>Sign in</title></head><body><h1>Sign in</h1>' +
            (items ? `<ul>${items}</ul>` : '<p>No sign-in provider is configured.</p>') +
            '</body></html>'
        );
        return true;
      }
      await res.json({ providers: providerIds.map(id => ({ id, signInUrl: link(id) })) });
      return true;
    }

    if (route.startsWith('/signin/')) {
      let provider = route.slice('/signin/'.length);
      if (provider === '' || provider.includes('/')) return false;
      try {
        provider = decodeURIComponent(provider);
      } catch {
        return false;
      }
      // A link to this URL may be followed from anywhere, so a GET carries no
      // Origin to check. Starting a sign-in changes nothing for the visitor
      // until the provider has authenticated them and the state cookie set
      // here has come back with the callback; the callback URL is still
      // checked against the trusted origins by Better Auth.
      const response = await callJsonRoute(
        req,
        '/sign-in/social',
        { provider, callbackURL: callbackUrl ?? '/' },
        method === 'GET' ? baseOrigin : undefined
      );
      await fromWebResponse(response, res, navigation);
      return true;
    }

    if (route === '/signout') {
      if (method === 'GET') {
        // A GET that ends the session must not be something another site can
        // send the browser to. Browsers say where a navigation came from;
        // without that statement only a POST is accepted.
        const site = headerValue(req, 'sec-fetch-site');
        if (site !== 'same-origin' && site !== 'none') {
          res.status(405);
          res.setHeader('Allow', 'POST');
          await res.json({
            error: 'Method not allowed',
            message:
              'Sign out with a POST request to this URL. A GET is accepted only as a same-origin browser navigation.',
          });
          return true;
        }
      }
      const response = await callJsonRoute(
        req,
        '/sign-out',
        {},
        method === 'GET' ? baseOrigin : undefined
      );
      if (navigation && response.ok) {
        const headers = new Headers(response.headers);
        headers.delete('content-type');
        headers.delete('content-length');
        headers.set('location', safeRedirectTarget(callbackUrl, redirectOrigins));
        await fromWebResponse(new Response(null, { status: 302, headers }), res);
        return true;
      }
      await fromWebResponse(response, res);
      return true;
    }

    return false;
  };

  const handlers: MoroJSAuthHandlers = {
    basePath,
    providers: providerIds,
    signInUrl,
    signOutUrl,
    instance: betterAuthInstance,

    /**
     * Main request handler for auth routes
     */
    handler: async (req: MoroJSRequest, res: MoroJSResponse) => {
      try {
        if (await handleOwnRoute(req, res)) return;

        // Convert MoroJS request to Web API request, hand it to Better Auth
        const webRequest = toWebRequest(req, basePath);
        setClientAddress(webRequest.headers, req, addressSource);
        const finalResponse = await dispatch(webRequest);

        // Convert Web API response to MoroJS response
        await fromWebResponse(finalResponse, res, isNavigationRequest(req));
      } catch (error) {
        logger.error('[MoroJS Auth] Error', 'AuthAdapter', {
          error: error instanceof Error ? error.message : String(error),
        });
        if ((res as any).headersSent) return;
        // Robust error handling - check if response methods exist
        if (typeof (res as any).status === 'function' && typeof (res as any).json === 'function') {
          (res as any).status(500).json({
            error: 'Internal server error',
            message: debug ? (error as Error).message : 'Authentication error',
          });
        } else {
          // Fallback to basic Node.js response methods
          (res as any).statusCode = 500;
          (res as any).setHeader('Content-Type', 'application/json');
          (res as any).end(
            JSON.stringify({
              error: 'Internal server error',
              message: debug ? (error as Error).message : 'Authentication error',
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
        // Convert MoroJS request to Web API request (only its headers are read)
        const webRequest = toWebRequest(
          { url: req.url, method: 'GET', headers: req.headers, cookies: req.cookies },
          basePath
        );

        // Get session from Better Auth
        const session = await betterAuthInstance.api.getSession({
          headers: webRequest.headers,
        });

        if (session?.user) {
          const user = session.user;
          return {
            user: {
              // Every field Better Auth returns for the user, so that fields
              // an application adds to it (roles, permissions, a tenant id)
              // reach req.auth.user and the guards
              ...user,
              // The admin plugin keeps a single `role` text; the guards read `roles`
              ...(user.roles === undefined && typeof user.role === 'string'
                ? { roles: user.role }
                : {}),
              id: user.id,
              name: user.name || null,
              email: user.email || null,
              image: user.image || null,
            },
            expires: new Date(
              session.session?.expiresAt || Date.now() + 30 * 24 * 60 * 60 * 1000
            ).toISOString(),
            // The organization plugin keeps the organization (and team) the
            // session is working in on the session itself
            ...(session.session?.activeOrganizationId !== undefined
              ? { activeOrganizationId: session.session.activeOrganizationId }
              : {}),
            ...(session.session?.activeTeamId !== undefined
              ? { activeTeamId: session.session.activeTeamId }
              : {}),
          };
        }

        return null;
      } catch (error) {
        if (debug) {
          logger.error('[MoroJS Auth] Session error', 'AuthAdapter', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      }
    },
  };

  // The plugins of the helpers keep data in the database. Whoever serves the
  // routes asks, once, whether their tables are there (checkAuthStorage).
  if (stored.length > 0 && options.database !== undefined && options.database !== null) {
    STORAGE_CHECKS.set(handlers, async () => {
      const missing = await describeMissingTables(stored, () =>
        betterAuthInstance.api.getSession({ headers: new Headers() })
      );
      if (missing) logger.error(`Better Auth adapter: ${missing}`, 'AuthAdapter');
    });
  }

  // Better Auth's rate limiter runs when it is turned on, and in production
  // unless it is turned off. It counts per client address.
  const rateLimited =
    (options.rateLimit?.enabled ?? process.env.NODE_ENV === 'production') === true &&
    options.advanced?.ipAddress?.disableIpTracking !== true;
  SERVED.set(handlers, { addressSource, rateLimited });

  return handlers;
}

const SERVED = new WeakMap<
  MoroJSAuthHandlers,
  { addressSource: ClientAddressSource; rateLimited: boolean }
>();

/**
 * Tell the handlers which application serves them. Called by what installs
 * them on an app (`createAuthMiddleware()`, `auth()`).
 *
 * With the app's `server.trustProxy` set, the address Better Auth counts is
 * `req.ip` and nothing a request says about forwarding. Without it, and with
 * Better Auth's rate limiter in force, start-up says once that the limit is
 * keyed on a header a client can write.
 */
export function servedByApp(handlers: MoroJSAuthHandlers | null, app: unknown): void {
  const served = handlers ? SERVED.get(handlers) : undefined;
  if (!served || !served.addressSource.managed) return;

  let trustProxy: unknown;
  try {
    trustProxy = (app as { getConfig?: () => any } | null)?.getConfig?.()?.server?.trustProxy;
  } catch {
    // An app that cannot be asked: as if the setting were absent
  }
  if (trustProxy !== undefined && trustProxy !== null) {
    served.addressSource.trustProxy = true;
    return;
  }
  if (served.rateLimited) {
    warnOnce(
      "Better Auth's rate limit of the auth routes is in force and `server.trustProxy` is not " +
        'set. The limit is counted per client address, and without the setting that address is ' +
        'the `X-Forwarded-For` header whenever a request carries one: unless a proxy in front of ' +
        'this server overwrites the header, a client can send a different one with every request ' +
        'and is never limited. Set `server.trustProxy` (`false` when clients connect directly, `1` ' +
        "for one proxy, or the proxies' addresses) and the address MoroJS determines, `req.ip`, " +
        'is the one that is counted.'
    );
  }
}

const STORAGE_CHECKS = new WeakMap<MoroJSAuthHandlers, () => Promise<void>>();

/**
 * Say at start-up, rather than on the first request, when the database is
 * missing tables the feature helpers of these handlers write to. Called by
 * what serves the routes (`createAuthMiddleware()`, `auth()`); `MoroJSAuth()`
 * on its own stays silent, so that a script can use its `instance` to create
 * those tables.
 */
export async function checkAuthStorage(handlers: MoroJSAuthHandlers | null): Promise<void> {
  const check = handlers ? STORAGE_CHECKS.get(handlers) : undefined;
  if (!handlers || !check) return;
  STORAGE_CHECKS.delete(handlers);
  // A database that does not answer must not hold start-up: after a few
  // seconds the check is left to finish on its own, and still reports then
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waitedLongEnough = new Promise<void>(resolve => {
    timer = setTimeout(resolve, STORAGE_CHECK_WAIT_MS);
    timer.unref?.();
  });
  await Promise.race([check().catch(() => undefined), waitedLongEnough]);
  if (timer) clearTimeout(timer);
}

const STORAGE_CHECK_WAIT_MS = 3000;

// Set on a request the mounted routes will answer, so that the session lookup
// that fills req.auth is not also run for it.
const ANSWERED_BY_AUTH_ROUTES = Symbol('morojs.auth.routes');

function requestPath(req: any): string {
  if (typeof req.path === 'string') return req.path;
  const url: string = typeof req.url === 'string' ? req.url : '/';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/**
 * True when a request under `basePath` is one the mounted auth routes answer:
 * a method Better Auth serves, and no route of the application's own at that
 * path. An application that mounts `MoroJSAuth().handler` on routes itself, or
 * has its own route under the base path, keeps answering there.
 */
function isForAuthRoutes(app: any, req: any, basePath: string): boolean {
  const method: string = req.method || 'GET';
  if (method === 'OPTIONS' || method === 'HEAD') return false;
  const path = requestPath(req);
  if (!isUnderBasePath(path, basePath)) return false;
  const router = app?.unifiedRouter;
  if (router && typeof router.matchRoute === 'function') {
    try {
      if (router.matchRoute(method, path) !== undefined) return false;
    } catch {
      // A router that cannot be asked: the application's routes are not known
    }
  }
  return true;
}

/** The base path `config` puts the auth routes under. */
export function authBasePath(config: Pick<MoroJSAuthConfig, 'basePath' | 'betterAuth'>): string {
  const passThrough = isPlainObject(config.betterAuth) ? config.betterAuth : {};
  return config.basePath || passThrough.basePath || '/api/auth';
}

/**
 * Serve auth routes under `basePath` on `app`.
 *
 * They are answered from the global middleware chain: after the middleware
 * registered before this call (CORS, security headers, request logging),
 * before the router, for every method except OPTIONS and HEAD. A route the
 * application registers itself under the base path takes precedence.
 *
 * The middleware takes its place in the chain at once. `handler` is what
 * answers; it may still be loading, in which case a request for it waits. It
 * resolves to `null` when there turn out to be no routes to serve, and those
 * requests go on to the router.
 *
 * Returns a predicate telling whether a request will be answered here.
 */
export function mountAuthRoutes(
  app: any,
  basePath: string,
  handler: Promise<MoroJSAuthHandlers['handler'] | null>
): (req: any) => boolean {
  const base = basePath.replace(/\/+$/, '') || '/';
  let serve: MoroJSAuthHandlers['handler'] | null | undefined;
  handler.then(
    resolved => {
      serve = resolved;
    },
    () => {
      serve = null;
    }
  );

  const answers = (req: any): boolean => {
    if (serve === null) return false;
    if (req[ANSWERED_BY_AUTH_ROUTES] === undefined) {
      req[ANSWERED_BY_AUTH_ROUTES] = isForAuthRoutes(app, req, base);
    }
    return req[ANSWERED_BY_AUTH_ROUTES] === true;
  };

  const authRoutes = (req: any, res: any, next: (error?: unknown) => void) => {
    if (!answers(req)) {
      next();
      return undefined;
    }
    if (serve) return serve(req, res);
    // Still loading
    return handler.then(
      resolved => {
        if (resolved) return resolved(req, res);
        next();
        return undefined;
      },
      () => next()
    );
  };

  const used = app.use(authRoutes);
  if (used && typeof used.then === 'function') {
    used.then(undefined, (error: unknown) => {
      logger.error('Could not mount the auth routes', 'AuthAdapter', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return answers;
}

/**
 * Better Auth middleware for a MoroJS app: `app.use(createAuthMiddleware(config))`.
 *
 * This is the `createAuthMiddleware` exported from `@morojs/moro`. It
 *
 * - serves Better Auth's routes under `basePath` (default `/api/auth`):
 *   sign-in, the provider callback, the session, sign-out and whatever the
 *   configured plugins add, plus `signin[/<provider>]` and `signout`;
 * - turns on the Better Auth feature behind each feature helper it is given:
 *   `plugins: [twoFactor(), organization(), anonymous(), bearerToken()]`,
 *   `accountLinking: accountLinking()`, `rateLimit: rateLimit()`;
 * - sets `req.auth` on every request: `isAuthenticated`, `user`, `session`,
 *   `getSession()`, `getUser()`, and `signIn(provider, options)` /
 *   `signOut(options)`, which return the URL to send the browser to.
 *
 * Needs the `better-auth` package. `mountRoutes: false` leaves the routes to
 * you (mount `MoroJSAuth(config).handler`).
 *
 * Not to be confused with the internal `(req, res, next)` function of the
 * same name in `core/middleware/built-in/auth`, which the package does not
 * export; the public form of that one is `auth(options)`.
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

    // Loading Better Auth takes a moment. The routes and the hook take their
    // places now and wait for it, so that their position among the app's
    // middleware does not depend on whether app.use() was awaited.
    const loading = MoroJSAuth(config).then(handlers => {
      servedByApp(handlers, app);
      return handlers;
    });
    const loaded = loading.then(
      handlers => handlers,
      () => null
    );

    // Serve the auth routes
    const answeredByAuthRoutes =
      config.mountRoutes === false
        ? () => false
        : mountAuthRoutes(
            app,
            authBasePath(config),
            loaded.then(handlers => (handlers ? handlers.handler : null))
          );

    // Register request hook
    hooks.before('request', async (context: any) => {
      const authHandlers = await loaded;
      // Better Auth could not be loaded: app.use() has reported it
      if (!authHandlers) return;

      logger.debug('Native adapter hook starting', 'AuthAdapter');
      const req = context.request;
      logger.debug('Request path', 'AuthAdapter', { path: req.path || req.url });

      try {
        // Get session from Better Auth. A request the auth routes are about
        // to answer is given to Better Auth once, there.
        const session = answeredByAuthRoutes(req) ? null : await authHandlers.auth(req);

        // Add auth object to request
        req.auth = {
          session: session,
          user: session?.user || null,
          isAuthenticated: !!session?.user,

          // Helper methods
          getSession: async () => session,
          getUser: () => session?.user || null,

          // Sign in/out helpers: the URL to send the browser to
          signIn: (provider?: string, options?: any) => ({
            url: authHandlers.signInUrl(provider, options),
          }),

          signOut: (options?: any) => ({ url: authHandlers.signOutUrl(options) }),
        };
        logger.debug('Native adapter hook completed successfully', 'AuthAdapter');
      } catch (error) {
        logger.error('Error in native adapter hook', 'AuthAdapter', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });

    await checkAuthStorage(await loading);
    logger.info('Better Auth middleware installed successfully!', 'AuthAdapter');
  };
}

// Types are already exported above, no need to re-export

/**
 * Default export for convenience
 */
export default MoroJSAuth;
