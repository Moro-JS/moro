// Session Middleware
import { MiddlewareInterface, HookContext } from "../../../types/hooks";
import { createFrameworkLogger } from "../../logger";
import { CacheAdapter } from "../../../types/cache";
import { MemoryCacheAdapter } from "./adapters/cache/memory";
import { RedisCacheAdapter } from "./adapters/cache/redis";
import { FileCacheAdapter } from "./adapters/cache/file";

const logger = createFrameworkLogger("SessionMiddleware");

export interface SessionOptions {
  // Session store configuration
  store?: "memory" | "redis" | "file" | CacheAdapter;
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
    sameSite?: "strict" | "lax" | "none";
    domain?: string;
    path?: string;
  };

  // Security
  proxy?: boolean; // Trust proxy for secure cookies
  unset?: "destroy" | "keep"; // What to do when session is unset
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

class Session {
  private data: SessionData = {};
  private id: string;
  private store: CacheAdapter;
  private options: SessionOptions;
  private isNew: boolean = false;
  private isModified: boolean = false;

  constructor(
    id: string,
    store: CacheAdapter,
    options: SessionOptions,
    isNew: boolean = false,
  ) {
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
    isNew: boolean = false,
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
      logger.debug(`Session saved: ${this.id}`, "SessionSave");
    }
  }

  async destroy(): Promise<void> {
    await this.store.del(this.id);
    this.data = {};
    this.isModified = false;
    logger.debug(`Session destroyed: ${this.id}`, "SessionDestroy");
  }

  async regenerate(): Promise<string> {
    await this.destroy();
    this.id = this.generateId();
    this.isNew = true;
    this.isModified = true;
    logger.debug(`Session regenerated: ${this.id}`, "SessionRegenerate");
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

    const crypto = require("crypto");
    return crypto.randomBytes(24).toString("hex");
  }

  get sessionID(): string {
    return this.id;
  }
}

export const session = (options: SessionOptions = {}): MiddlewareInterface => ({
  name: "session",
  version: "1.0.0",
  metadata: {
    name: "session",
    version: "1.0.0",
    description: "Session management middleware with multiple store adapters",
    author: "MoroJS Team",
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug("Installing session middleware", "Installation");

    // Merge options
    const config: SessionOptions = {
      store: "memory",
      name: "connect.sid",
      secret: "moro-session-secret",
      rolling: false,
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
      },
      unset: "keep",
      ...options,
      ...middlewareOptions,
    };

    // Initialize store
    let store: CacheAdapter;

    if (typeof config.store === "string") {
      switch (config.store) {
        case "redis":
          store = new RedisCacheAdapter({
            keyPrefix: "sess:",
            ...config.storeOptions,
          });
          break;
        case "file":
          store = new FileCacheAdapter({
            cacheDir: config.storeOptions?.path || "./sessions",
          });
          break;
        case "memory":
        default:
          store = new MemoryCacheAdapter();
          break;
      }
    } else {
      store = config.store as CacheAdapter;
    }

    // Generate session ID
    const generateSessionId = (): string => {
      if (config.genid) {
        return config.genid();
      }
      const crypto = require("crypto");
      return crypto.randomBytes(24).toString("hex");
    };

    hooks.before("request", async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Get session ID from cookie
      let sessionId = req.cookies?.[config.name!];
      let sessionData: SessionData = {};
      let isNew = false;

      if (sessionId) {
        try {
          sessionData = (await store.get(sessionId)) || {};
          logger.debug(`Session loaded: ${sessionId}`, "SessionLoad");
        } catch (error) {
          logger.warn(
            `Failed to load session: ${sessionId}`,
            "SessionLoadError",
            { error },
          );
          sessionId = generateSessionId();
          isNew = true;
        }
      } else {
        sessionId = generateSessionId();
        isNew = true;
      }

      // Create session object
      req.session = Session.create(
        sessionId,
        store,
        config,
        sessionData,
        isNew,
      );

      // Set session cookie
      if (isNew || config.rolling) {
        res.cookie(config.name!, sessionId, {
          ...config.cookie,
          secure:
            config.cookie?.secure ||
            (config.proxy && req.headers["x-forwarded-proto"] === "https"),
        });
      }
    });

    hooks.after("response", async (context: HookContext) => {
      const req = context.request as any;

      if (req.session) {
        try {
          if (
            config.saveUninitialized ||
            !req.session.isNew ||
            req.session.isModified
          ) {
            await req.session.save();
          }
        } catch (error) {
          logger.error("Failed to save session", "SessionSaveError", { error });
        }
      }
    });

    logger.info(
      `Session middleware installed with ${config.store} store`,
      "Installation",
    );
  },
});
