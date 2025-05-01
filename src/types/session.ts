// Session Types
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

export interface SessionInstance {
  // Session data proxy
  [key: string]: any;

  // Session methods
  save(): Promise<void>;
  destroy(): Promise<void>;
  regenerate(): Promise<string>;
  touch(): Promise<void>;

  // Session properties
  readonly sessionID: string;
  readonly cookie?: SessionData["cookie"];
  readonly isNew?: boolean;
  readonly isModified?: boolean;
}

export interface SessionOptions {
  // Store configuration
  store?: "memory" | "redis" | "file" | any;
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

// Extend the HTTP request type to include session
declare global {
  namespace Express {
    interface Request {
      session: SessionInstance;
    }
  }
}

// For non-Express environments
export interface RequestWithSession {
  session: SessionInstance;
}

export interface SessionStore {
  get(key: string): Promise<SessionData | null>;
  set(key: string, data: SessionData, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  clear?(): Promise<void>;
  touch?(key: string): Promise<void>;
}
