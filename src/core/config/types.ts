// TypeScript-based Configuration Types for Moro Framework
// Replaces Zod schemas with pure TypeScript interfaces

export interface ServerConfig {
  port: number;
  host: string;
  environment: 'development' | 'staging' | 'production';
  maxConnections: number;
  timeout: number;
}

export interface ServiceDiscoveryConfig {
  enabled: boolean;
  type: 'memory' | 'consul' | 'kubernetes';
  consulUrl: string;
  kubernetesNamespace: string;
  healthCheckInterval: number;
  retryAttempts: number;
}

export interface DatabaseConfig {
  url?: string;
  redis: {
    url: string;
    maxRetries: number;
    retryDelay: number;
    keyPrefix: string;
  };
  mysql?: {
    host: string;
    port: number;
    database?: string;
    username?: string;
    password?: string;
    connectionLimit: number;
    acquireTimeout: number;
    timeout: number;
  };
}

export interface ModuleDefaultsConfig {
  cache: {
    enabled: boolean;
    defaultTtl: number;
    maxSize: number;
    strategy: 'lru' | 'lfu' | 'fifo';
  };
  rateLimit: {
    enabled: boolean;
    defaultRequests: number;
    defaultWindow: number;
    skipSuccessfulRequests: boolean;
    skipFailedRequests: boolean;
  };
  validation: {
    enabled: boolean;
    stripUnknown: boolean;
    abortEarly: boolean;
  };
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  format: 'pretty' | 'json' | 'compact';
  enableColors: boolean;
  enableTimestamp: boolean;
  enableContext: boolean;
  outputs: {
    console: boolean;
    file: {
      enabled: boolean;
      path: string;
      maxSize: string;
      maxFiles: number;
    };
    webhook: {
      enabled: boolean;
      url?: string;
      headers: Record<string, string>;
    };
  };
}

export interface SecurityConfig {
  cors: {
    enabled: boolean;
    origin: string | string[] | boolean;
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };
  helmet: {
    enabled: boolean;
    contentSecurityPolicy: boolean;
    hsts: boolean;
    noSniff: boolean;
    frameguard: boolean;
  };
  rateLimit: {
    global: {
      enabled: boolean;
      requests: number;
      window: number;
    };
  };
}

export interface ExternalServicesConfig {
  stripe?: {
    secretKey?: string;
    publishableKey?: string;
    webhookSecret?: string;
    apiVersion: string;
  };
  paypal?: {
    clientId?: string;
    clientSecret?: string;
    webhookId?: string;
    environment: 'sandbox' | 'production';
  };
  smtp?: {
    host?: string;
    port: number;
    secure: boolean;
    username?: string;
    password?: string;
  };
}

export interface PerformanceConfig {
  compression: {
    enabled: boolean;
    level: number;
    threshold: number;
  };
  circuitBreaker: {
    enabled: boolean;
    failureThreshold: number;
    resetTimeout: number;
    monitoringPeriod: number;
  };
  clustering: {
    enabled: boolean;
    workers: number | 'auto';
  };
}

// Main configuration interface
export interface AppConfig {
  server: ServerConfig;
  serviceDiscovery: ServiceDiscoveryConfig;
  database: DatabaseConfig;
  modules: ModuleDefaultsConfig;
  logging: LoggingConfig;
  security: SecurityConfig;
  external: ExternalServicesConfig;
  performance: PerformanceConfig;
}

// Default configuration
export const DEFAULT_CONFIG: AppConfig = {
  server: {
    port: 3001,
    host: 'localhost',
    environment: 'development',
    maxConnections: 1000,
    timeout: 30000,
  },
  serviceDiscovery: {
    enabled: false,
    type: 'memory',
    consulUrl: 'http://localhost:8500',
    kubernetesNamespace: 'default',
    healthCheckInterval: 30000,
    retryAttempts: 3,
  },
  database: {
    redis: {
      url: 'redis://localhost:6379',
      maxRetries: 3,
      retryDelay: 1000,
      keyPrefix: 'moro:',
    },
  },
  modules: {
    cache: {
      enabled: true,
      defaultTtl: 300,
      maxSize: 1000,
      strategy: 'lru',
    },
    rateLimit: {
      enabled: true,
      defaultRequests: 100,
      defaultWindow: 60000,
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
    },
    validation: {
      enabled: true,
      stripUnknown: true,
      abortEarly: false,
    },
  },
  logging: {
    level: 'info',
    format: 'pretty',
    enableColors: true,
    enableTimestamp: true,
    enableContext: true,
    outputs: {
      console: true,
      file: {
        enabled: false,
        path: './logs/moro.log',
        maxSize: '10MB',
        maxFiles: 5,
      },
      webhook: {
        enabled: false,
        headers: {},
      },
    },
  },
  security: {
    cors: {
      enabled: true,
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: false,
    },
    helmet: {
      enabled: true,
      contentSecurityPolicy: true,
      hsts: true,
      noSniff: true,
      frameguard: true,
    },
    rateLimit: {
      global: {
        enabled: false,
        requests: 1000,
        window: 60000,
      },
    },
  },
  external: {
    stripe: {
      apiVersion: '2023-10-16',
    },
    paypal: {
      environment: 'sandbox',
    },
    smtp: {
      port: 587,
      secure: false,
    },
  },
  performance: {
    compression: {
      enabled: true,
      level: 6,
      threshold: 1024,
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 5,
      resetTimeout: 60000,
      monitoringPeriod: 10000,
    },
    clustering: {
      enabled: false,
      workers: 1,
    },
  },
};
