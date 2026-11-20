// Session Core - Reusable session management logic
import crypto from 'crypto';
import { createFrameworkLogger } from '../../../logger/index.js';
import { CacheAdapter } from '../../../../types/cache.js';
import { MemoryCacheAdapter } from '../cache/adapters/cache/memory.js';
import { RedisCacheAdapter, READ_FAILED } from '../cache/adapters/cache/redis.js';
import { FileCacheAdapter } from '../cache/adapters/cache/file.js';
import { keyTag } from '../cache/adapters/cache/log-key.js';
import { forwardedOverHttps } from '../../../http/utils/cookie-attributes.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import {
  signCookieValue,
  unsignCookieValue,
  isSignedCookieValue,
  cookieSecrets,
} from '../cookie/core.js';

const logger = createFrameworkLogger('SessionCore');

// ===== Types =====

export interface SessionOptions {
  // Session store configuration
  store?: 'memory' | 'redis' | 'file' | CacheAdapter;
  storeOptions?: {
    // Redis options (node-redis 4+; url wins over host/port)
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    keyPrefix?: string;
    // File options
    path?: string;
    // Memory options
    max?: number;
  };

  // Session configuration
  /**
   * Signs the session id cookie. An array rotates keys: the id is signed with
   * the first key, and a cookie signed with any listed key is still accepted.
   */
  secret?: string | Array<string | undefined | null>;
  name?: string; // Session cookie name
  genid?: () => string; // Session ID generator
  rolling?: boolean; // Reset expiry on each request
  resave?: boolean; // Save session even if not modified
  saveUninitialized?: boolean; // Save new but not modified sessions

  // Cookie configuration. Whatever is given here is laid over the defaults
  // (24 hours, HttpOnly, SameSite=lax, Path=/): naming one key keeps the rest.
  cookie?: {
    // Session timeout in ms. null sends no Max-Age (the cookie lasts until the
    // browser closes) and the stored session is kept for 24 hours.
    maxAge?: number | null;
    expires?: Date; // Absolute expiry
    httpOnly?: boolean; // Prevent XSS access
    secure?: boolean; // HTTPS only
    sameSite?: 'strict' | 'lax' | 'none';
    domain?: string;
    path?: string;
  };

  // Security
  proxy?: boolean; // Trust proxy for secure cookies
  unset?: 'destroy' | 'keep'; // What to do when session is unset
}

export interface SessionData {
  [key: string]: any;
  cookie?: {
    originalMaxAge?: number;
    expires?: Date;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
  };
}

// ===== Session Class =====

/** The request/response a session was attached to: where a rotated id is sent. */
interface SessionCookieBinding {
  req: HttpRequest;
  res: HttpResponse;
}

// Symbol-keyed so it can never collide with a session data key, and defined
// non-enumerable so it is never serialised.
const kCookieBinding: unique symbol = Symbol('moro.session.cookieBinding');

/** Result of a session load that could not reach the store (not "no such session"). */
const LOAD_FAILED: unique symbol = Symbol('moro.session.loadFailed');

// Symbol-keyed and non-enumerable for the same reasons as kCookieBinding.
const kUnread: unique symbol = Symbol('moro.session.unread');

// The object behind `req.session`. The session's methods run with `this` set
// to the proxy a handler holds; they reach their own fields through this, so
// the proxy can refuse every outside write to those fields.
const kSelf: unique symbol = Symbol('moro.session.self');

/**
 * Names on `req.session` that are not session data even though the session
 * object no longer carries them: a write to one is ignored, as it always was.
 */
const PROTECTED_SESSION_FIELDS: ReadonlySet<string | symbol> = new Set(['store', 'options']);

const DEFAULT_SESSION_COOKIE = 'connect.sid';

/** Cookie value carrying an id — signed with the first secret when one is configured. */
function encodeSessionId(id: string, secret: SessionOptions['secret']): string {
  const signingKey = cookieSecrets(secret)[0];
  return signingKey ? signCookieValue(id, signingKey) : id;
}

/**
 * The options every session cookie of this request is written with.
 *
 * `Secure` is set when `cookie.secure` is true, or when `proxy` is on and the
 * proxy forwarded an https request. With `cookie.secure` left out it follows
 * the connection: res.cookie() adds `Secure` when the request arrived over
 * TLS. `cookie.secure: false` keeps it off.
 */
function sessionCookieOptions(options: SessionOptions, req: HttpRequest) {
  const given = options.cookie?.secure;
  if (given || (options.proxy && forwardedOverHttps(req))) {
    return { ...options.cookie, secure: true };
  }
  if (given === undefined || given === null) {
    const cookieOptions = { ...options.cookie };
    delete cookieOptions.secure;
    return cookieOptions;
  }
  return { ...options.cookie, secure: false };
}

/**
 * `req.session`. Any name that is not one of the session's own members is a
 * session field: `req.session.user = ...` stores it, `req.session.user` reads
 * it back on later requests.
 *
 * The session's own members are read-only from outside: `id` / `sessionID`
 * (the session id), `data` (all the fields, as one object), `isNew`,
 * `isModified` and the methods `save()`, `destroy()`, `regenerate()` and
 * `touch()`. A write to one of those names - `req.session.id = ...`,
 * `Object.assign(req.session, body)` with an `id` or `data` key - is ignored
 * with a warning and never becomes a session field, so request input cannot
 * choose the session id or replace the stored fields wholesale. Use other
 * names for your own fields.
 */
export class Session {
  private data: SessionData = {};
  private id: string;
  // The store and the options (which hold the signing secret and the store
  // credentials). A true private field: no property name, symbol or
  // reflection on `req.session` leads to them.
  readonly #internals: { store: CacheAdapter; options: SessionOptions };
  declare private [kCookieBinding]: SessionCookieBinding | undefined;
  declare private [kSelf]: Session;
  private isNew: boolean = false;
  private isModified: boolean = false;
  // True when the stored data could not be read for this request: `data` is
  // empty because the store was unreachable, not because the session is.
  declare [kUnread]: boolean;

  constructor(id: string, store: CacheAdapter, options: SessionOptions, isNew: boolean = false) {
    this.id = id;
    this.#internals = { store, options };
    Object.defineProperty(this, kSelf, { value: this });
    Object.defineProperty(this, kCookieBinding, { value: undefined, writable: true });
    Object.defineProperty(this, kUnread, { value: false, writable: true });
    this.isNew = isNew;
  }

  // Proxy to make session.prop = value work
  static create(
    id: string,
    store: CacheAdapter,
    options: SessionOptions,
    data: SessionData = {},
    isNew: boolean = false,
    cookieBinding?: SessionCookieBinding
  ): Session {
    const session = new Session(id, store, options, isNew);
    session.data = data;
    session[kCookieBinding] = cookieBinding;

    return new Proxy(session, {
      get(target, prop) {
        if (prop in target) {
          return target[prop as keyof Session];
        }
        return target.data[prop as string];
      },

      set(target, prop, value) {
        if (typeof prop === 'symbol' && prop in target) {
          // The session's own bookkeeping; not reachable by name
          (target as any)[prop] = value;
          return true;
        }
        if (prop in target || PROTECTED_SESSION_FIELDS.has(prop)) {
          // One of the session's own members (id, data, save, ...): a write
          // from outside neither replaces it nor becomes a session field.
          logger.warn(
            `Ignored a write to req.session.${String(prop)}: it is reserved for the session's internals`,
            'SessionReservedField'
          );
          return true;
        }
        target.data[prop as string] = value;
        target.isModified = true;
        return true;
      },

      has(target, prop) {
        return prop in target || prop in target.data;
      },

      deleteProperty(target, prop) {
        if (prop in target.data) {
          delete target.data[prop as string];
          target.isModified = true;
          return true;
        }
        // The session's own members are not session fields and stay. Any
        // other name is a field that is not set: deleting it removes nothing
        // and succeeds, as deleting an absent property of an object does
        // (answering false here made `delete req.session.missing` a
        // TypeError in strict code).
        return !(prop in target || PROTECTED_SESSION_FIELDS.has(prop));
      },
    });
  }

  async save(): Promise<void> {
    const self = this[kSelf];
    if (self[kUnread]) {
      // Writing would replace stored data this request never saw with the
      // little it was given; the stored session is left as it is.
      if (self.isModified) {
        logger.warn(
          `Session ${keyTag(self.id)} was not saved: its stored data could not be read for this request`,
          'SessionSave'
        );
        self.isModified = false;
      }
      return;
    }
    const { store, options } = Session.internalsOf(self);
    if (self.isModified || self.isNew || options.resave) {
      const ttl = options.cookie?.maxAge ? Math.floor(options.cookie.maxAge / 1000) : 86400; // 24h default
      await store.set(self.id, self.data, ttl);
      self.isModified = false;
      self.isNew = false;
      logger.debug(`Session saved: ${keyTag(self.id)}`, 'SessionSave');
    }
  }

  async destroy(): Promise<void> {
    const self = this[kSelf];
    const id = self.id;
    // Before the first await, so `req.session.destroy()` without `await`
    // still clears the cookie ahead of the response.
    Session.writeCookie(self, null);
    self.data = {};
    self.isModified = false;
    await Session.internalsOf(self).store.del(id);
    logger.debug(`Session destroyed: ${keyTag(id)}`, 'SessionDestroy');
  }

  /**
   * Rotate the session id (call it at login and on any privilege change). The
   * session starts empty under a new id, the browser is sent the new id with
   * the same cookie options the original cookie had, and the previous id is
   * removed from the store. Set session data after it resolves.
   */
  async regenerate(): Promise<string> {
    const self = this[kSelf];
    const previousId = self.id;
    self.id = self.generateId();
    self.data = {};
    self.isNew = true;
    self.isModified = true;
    // A new id has no stored data to protect
    self[kUnread] = false;
    // Before the first await: the cookie must be queued while the response
    // headers are still open.
    Session.writeCookie(self, self.id);
    await Session.internalsOf(self).store.del(previousId);
    logger.debug(`Session destroyed: ${keyTag(previousId)}`, 'SessionDestroy');
    logger.debug(`Session regenerated: ${keyTag(self.id)}`, 'SessionRegenerate');
    return self.id;
  }

  private static internalsOf(session: Session): { store: CacheAdapter; options: SessionOptions } {
    return session.#internals;
  }

  /**
   * Send the browser this session's cookie: the given id, or an expired
   * cookie when `id` is null. A no-op for a session that was not attached to a
   * response (Session.create() used directly).
   */
  private static writeCookie(session: Session, id: string | null): void {
    const binding = session[kCookieBinding];
    if (!binding) return;
    const { req, res } = binding;
    const options = Session.internalsOf(session).options;
    const name = options.name || DEFAULT_SESSION_COOKIE;
    if (res.headersSent) {
      logger.warn(
        `Session cookie '${name}' could not be ${id === null ? 'cleared' : 'updated'}: response headers already sent`,
        'SessionCookie'
      );
      return;
    }
    const cookieOptions = sessionCookieOptions(options, req);
    if (id === null) {
      res.cookie(name, '', { ...cookieOptions, maxAge: 0, expires: new Date(0) });
    } else {
      res.cookie(name, encodeSessionId(id, options.secret), cookieOptions);
    }
  }

  async touch(): Promise<void> {
    const self = this[kSelf];
    if (Session.internalsOf(self).options.rolling && !self[kUnread]) {
      self.isModified = true;
      await self.save();
    }
  }

  private generateId(): string {
    const { options } = Session.internalsOf(this[kSelf]);
    if (options.genid) {
      return options.genid();
    }

    return crypto.randomBytes(24).toString('hex');
  }

  get sessionID(): string {
    return this.id;
  }
}

// ===== SessionCore =====

/**
 * SessionCore - Core session management logic
 * Used directly by the router for route-based session handling
 * Can be instantiated for use in middleware or hooks
 */
export class SessionCore {
  private store: CacheAdapter;
  private options: SessionOptions;

  constructor(options: SessionOptions = {}) {
    // The caller's cookie options are laid over the defaults one key at a
    // time: naming `maxAge` (or `secure`, or anything else) must not drop
    // HttpOnly and SameSite from the session cookie. A key given as undefined
    // counts as not given.
    const cookie: NonNullable<SessionOptions['cookie']> = {
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      httpOnly: true,
      // `secure` is not defaulted: left out, the cookie is Secure when the
      // request arrived over TLS (see sessionCookieOptions)
      sameSite: 'lax',
      path: '/',
    };
    const given = options.cookie as Record<string, unknown> | undefined;
    if (given && typeof given === 'object') {
      for (const key of Object.keys(given)) {
        if (given[key] !== undefined) (cookie as Record<string, unknown>)[key] = given[key];
      }
    }

    this.options = {
      store: 'memory',
      name: 'connect.sid',
      rolling: false,
      resave: false,
      saveUninitialized: false,
      unset: 'keep',
      ...options,
      cookie,
    };

    // Initialize store
    if (typeof this.options.store === 'string') {
      switch (this.options.store) {
        case 'redis':
          this.store = new RedisCacheAdapter({
            keyPrefix: 'sess:',
            ...this.options.storeOptions,
            redactKeys: true,
          });
          break;
        case 'file':
          this.store = new FileCacheAdapter({
            cacheDir: this.options.storeOptions?.path || './sessions',
            redactKeys: true,
          });
          break;
        case 'memory':
        default:
          this.store = new MemoryCacheAdapter({ redactKeys: true });
          break;
      }
    } else {
      this.store = this.options.store as CacheAdapter;
      // A built-in adapter handed in as the store: its keys are session ids
      // from here on, and a session id must not be written to the log.
      if (
        this.store instanceof RedisCacheAdapter ||
        this.store instanceof MemoryCacheAdapter ||
        this.store instanceof FileCacheAdapter
      ) {
        this.store.redactKeys = true;
      }
    }
  }

  generateSessionId(): string {
    if (this.options.genid) {
      return this.options.genid();
    }
    return crypto.randomBytes(24).toString('hex');
  }

  async loadSession(sessionId: string): Promise<SessionData | null> {
    if (!sessionId) {
      return null;
    }

    const data = await this.readSession(sessionId);
    return data === LOAD_FAILED ? null : data;
  }

  /**
   * The stored data, null when the store has no such session, or LOAD_FAILED
   * when the store could not be read: the built-in Redis store reports that
   * itself, and any other store by rejecting get().
   */
  private async readSession(sessionId: string): Promise<SessionData | null | typeof LOAD_FAILED> {
    try {
      const store = this.store;
      const data =
        store instanceof RedisCacheAdapter
          ? await store.read(sessionId)
          : await store.get(sessionId);
      if (data === READ_FAILED) {
        logger.warn(`Failed to load session: ${keyTag(sessionId)}`, 'SessionLoadError');
        return LOAD_FAILED;
      }
      logger.debug(`Session loaded: ${keyTag(sessionId)}`, 'SessionLoad');
      return data || null;
    } catch (error) {
      logger.warn(`Failed to load session: ${keyTag(sessionId)}`, 'SessionLoadError', { error });
      return LOAD_FAILED;
    }
  }

  /**
   * The session id the request carries, or undefined when there is none and
   * when a signed id fails verification — a tampered id must start a fresh
   * session rather than load someone else's.
   */
  readSessionId(req: HttpRequest): string | undefined {
    const name = this.options.name || DEFAULT_SESSION_COOKIE;
    // The cookie middleware verifies and strips signatures when it shares the
    // secret, in which case the id arrives already unwrapped.
    const verified = (req as any).signedCookies?.[name] as string | undefined;
    const raw = verified ?? req.cookies?.[name];
    if (!raw) return undefined;

    // Every listed secret verifies: an id signed before a key rotation is
    // still this browser's session.
    const secrets = cookieSecrets(this.options.secret);
    if (secrets.length === 0) return raw;

    if (isSignedCookieValue(raw)) {
      return unsignCookieValue(raw, secrets) ?? undefined;
    }

    // A bare value is only trustworthy if it was verified upstream
    return verified;
  }

  async createSession(req: HttpRequest, res: HttpResponse, sessionId?: string): Promise<Session> {
    const id = sessionId || this.generateSessionId();
    const session = Session.create(id, this.store, this.options, {}, true, { req, res });

    // Set session cookie
    res.cookie(
      this.options.name || DEFAULT_SESSION_COOKIE,
      encodeSessionId(id, this.options.secret),
      sessionCookieOptions(this.options, req)
    );

    return session;
  }

  async attachSession(req: HttpRequest, res: HttpResponse, sessionId?: string): Promise<Session> {
    let id = sessionId;
    let sessionData: SessionData = {};
    let isNew = false;
    let unread = false;

    if (id) {
      const loaded = await this.readSession(id);
      if (loaded === LOAD_FAILED) {
        // The store could not be read, which says nothing about whether the
        // session exists. The request is served without session data and the
        // browser keeps its id, so the session is there again once the store
        // is: a new id here would sign the user out for good.
        unread = true;
      } else {
        sessionData = loaded || {};
        // Fast empty check without Object.keys
        let hasData = false;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const _ in sessionData) {
          hasData = true;
          break;
        }
        if (!hasData) {
          id = this.generateSessionId();
          isNew = true;
        }
      }
    } else {
      id = this.generateSessionId();
      isNew = true;
    }

    const session = Session.create(id, this.store, this.options, sessionData, isNew, { req, res });
    if (unread) session[kUnread] = true;

    // Set session cookie if new or rolling
    if (isNew || this.options.rolling) {
      res.cookie(
        this.options.name || DEFAULT_SESSION_COOKIE,
        encodeSessionId(id, this.options.secret),
        sessionCookieOptions(this.options, req)
      );
    }

    return session;
  }

  async saveSession(session: Session): Promise<void> {
    if (!session) {
      return;
    }

    try {
      if (
        this.options.saveUninitialized ||
        !(session as any).isNew ||
        (session as any).isModified
      ) {
        await session.save();
      }
    } catch (error) {
      logger.error('Failed to save session', 'SessionSaveError', { error });
    }
  }

  getStore(): CacheAdapter {
    return this.store;
  }

  getOptions(): SessionOptions {
    return this.options;
  }
}
