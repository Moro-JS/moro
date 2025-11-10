// Session Core - Reusable session management logic
import crypto from 'crypto';
import { createFrameworkLogger } from '../../../logger/index.js';
import { CacheAdapter } from '../../../../types/cache.js';
import { MemoryCacheAdapter } from '../cache/adapters/cache/memory.js';
import { RedisCacheAdapter } from '../cache/adapters/cache/redis.js';
import { FileCacheAdapter } from '../cache/adapters/cache/file.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

const logger = createFrameworkLogger('SessionCore');

// ===== Types =====

export interface SessionOptions {
  // Session store configuration
  store?: 'memory' | 'redis' | 'file' | CacheAdapter;
  storeOptions?: {
    // Redis options
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
  secret?: string;
  name?: string; // Session cookie name
  genid?: () => string; // Session ID generator
  rolling?: boolean; // Reset expiry on each request
  resave?: boolean; // Save session even if not modified
  saveUninitialized?: boolean; // Save new but not modified sessions

  // Cookie configuration
  cookie?: {
    maxAge?: number; // Session timeout in ms
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

export class Session {
  private data: SessionData = {};
  private id: string;
  private store: CacheAdapter;
  private options: SessionOptions;
  private isNew: boolean = false;
  private isModified: boolean = false;

  constructor(id: string, store: CacheAdapter, options: SessionOptions, isNew: boolean = false) {
    this.id = id;
    this.store = store;
    this.options = options;
    this.isNew = isNew;
  }

  // Proxy to make session.prop = value work
  static create(
    id: string,
    store: CacheAdapter,
    options: SessionOptions,
    data: SessionData = {},
    isNew: boolean = false
  ): Session {
    const session = new Session(id, store, options, isNew);
    session.data = data;

    return new Proxy(session, {
      get(target, prop) {
        if (prop in target) {
          return target[prop as keyof Session];
        }
        return target.data[prop as string];
      },

      set(target, prop, value) {
        if (prop in target) {
          (target as any)[prop] = value;
        } else {
          target.data[prop as string] = value;
          target.isModified = true;
        }
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
        return false;
      },
    });
  }

  async save(): Promise<void> {
    if (this.isModified || this.isNew || this.options.resave) {
      const ttl = this.options.cookie?.maxAge
        ? Math.floor(this.options.cookie.maxAge / 1000)
        : 86400; // 24h default
      await this.store.set(this.id, this.data, ttl);
      this.isModified = false;
      this.isNew = false;
      logger.debug(`Session saved: ${this.id}`, 'SessionSave');
    }
  }

  async destroy(): Promise<void> {
    await this.store.del(this.id);
    this.data = {};
    this.isModified = false;
    logger.debug(`Session destroyed: ${this.id}`, 'SessionDestroy');
  }

  async regenerate(): Promise<string> {
    await this.destroy();
    this.id = this.generateId();
    this.isNew = true;
    this.isModified = true;
    logger.debug(`Session regenerated: ${this.id}`, 'SessionRegenerate');
    return this.id;
  }

  async touch(): Promise<void> {
    if (this.options.rolling) {
      this.isModified = true;
      await this.save();
    }
  }

  private generateId(): string {
    if (this.options.genid) {
      return this.options.genid();
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
    this.options = {
      store: 'memory',
      name: 'connect.sid',
      secret: 'moro-session-secret',
      rolling: false,
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
      },
      unset: 'keep',
      ...options,
    };

    // Initialize store
    if (typeof this.options.store === 'string') {
      switch (this.options.store) {
        case 'redis':
          this.store = new RedisCacheAdapter({
            keyPrefix: 'sess:',
            ...this.options.storeOptions,
          });
          break;
        case 'file':
          this.store = new FileCacheAdapter({
            cacheDir: this.options.storeOptions?.path || './sessions',
          });
          break;
        case 'memory':
        default:
          this.store = new MemoryCacheAdapter();
          break;
      }
    } else {
      this.store = this.options.store as CacheAdapter;
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

    try {
      const data = await this.store.get(sessionId);
      logger.debug(`Session loaded: ${sessionId}`, 'SessionLoad');
      return data || null;
    } catch (error) {
      logger.warn(`Failed to load session: ${sessionId}`, 'SessionLoadError', { error });
      return null;
    }
  }

  async createSession(req: HttpRequest, res: HttpResponse, sessionId?: string): Promise<Session> {
    const id = sessionId || this.generateSessionId();
    const session = Session.create(id, this.store, this.options, {}, true);

    // Set session cookie
    res.cookie(this.options.name || 'connect.sid', id, {
      ...this.options.cookie,
      secure:
        this.options.cookie?.secure ||
        (this.options.proxy && req.headers['x-forwarded-proto'] === 'https'),
    });

    return session;
  }

  async attachSession(req: HttpRequest, res: HttpResponse, sessionId?: string): Promise<Session> {
    let id = sessionId;
    let sessionData: SessionData = {};
    let isNew = false;

    if (id) {
      sessionData = (await this.loadSession(id)) || {};
      // Fast empty check without Object.keys
      if (!sessionData) {
        id = this.generateSessionId();
        isNew = true;
      } else {
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

    const session = Session.create(id, this.store, this.options, sessionData, isNew);

    // Set session cookie if new or rolling
    if (isNew || this.options.rolling) {
      res.cookie(this.options.name || 'connect.sid', id, {
        ...this.options.cookie,
        secure:
          this.options.cookie?.secure ||
          (this.options.proxy && req.headers['x-forwarded-proto'] === 'https'),
      });
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
