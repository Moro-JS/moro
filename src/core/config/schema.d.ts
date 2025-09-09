import { z } from 'zod';
declare const ServerConfigSchema: z.ZodObject<
  {
    port: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    host: z.ZodDefault<z.ZodString>;
    environment: z.ZodDefault<
      z.ZodEnum<{
        production: 'production';
        development: 'development';
        staging: 'staging';
      }>
    >;
    maxConnections: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    timeout: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
  },
  z.core.$strip
>;
declare const ServiceDiscoveryConfigSchema: z.ZodObject<
  {
    enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
    type: z.ZodDefault<
      z.ZodEnum<{
        memory: 'memory';
        consul: 'consul';
        kubernetes: 'kubernetes';
      }>
    >;
    consulUrl: z.ZodDefault<z.ZodString>;
    kubernetesNamespace: z.ZodDefault<z.ZodString>;
    healthCheckInterval: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    retryAttempts: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
  },
  z.core.$strip
>;
declare const DatabaseConfigSchema: z.ZodObject<
  {
    url: z.ZodOptional<z.ZodString>;
    redis: z.ZodObject<
      {
        url: z.ZodDefault<z.ZodString>;
        maxRetries: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        retryDelay: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        keyPrefix: z.ZodDefault<z.ZodString>;
      },
      z.core.$strip
    >;
    mysql: z.ZodOptional<
      z.ZodObject<
        {
          host: z.ZodDefault<z.ZodString>;
          port: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
          database: z.ZodOptional<z.ZodString>;
          username: z.ZodOptional<z.ZodString>;
          password: z.ZodOptional<z.ZodString>;
          connectionLimit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
          acquireTimeout: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
          timeout: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
declare const ModuleDefaultsConfigSchema: z.ZodObject<
  {
    cache: z.ZodObject<
      {
        enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        defaultTtl: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        maxSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        strategy: z.ZodDefault<
          z.ZodEnum<{
            lru: 'lru';
            lfu: 'lfu';
            fifo: 'fifo';
          }>
        >;
      },
      z.core.$strip
    >;
    rateLimit: z.ZodObject<
      {
        enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        defaultRequests: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        defaultWindow: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        skipSuccessfulRequests: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        skipFailedRequests: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
      },
      z.core.$strip
    >;
    validation: z.ZodObject<
      {
        enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        stripUnknown: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        abortEarly: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
declare const LoggingConfigSchema: z.ZodObject<
  {
    level: z.ZodDefault<
      z.ZodEnum<{
        debug: 'debug';
        info: 'info';
        warn: 'warn';
        error: 'error';
        fatal: 'fatal';
      }>
    >;
    format: z.ZodDefault<
      z.ZodEnum<{
        pretty: 'pretty';
        json: 'json';
        compact: 'compact';
      }>
    >;
    enableColors: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
    enableTimestamp: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
    enableContext: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
    outputs: z.ZodObject<
      {
        console: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        file: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            path: z.ZodDefault<z.ZodString>;
            maxSize: z.ZodDefault<z.ZodString>;
            maxFiles: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
          },
          z.core.$strip
        >;
        webhook: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            url: z.ZodOptional<z.ZodString>;
            headers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
declare const SecurityConfigSchema: z.ZodObject<
  {
    cors: z.ZodObject<
      {
        enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        origin: z.ZodDefault<
          z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>, z.ZodBoolean]>
        >;
        methods: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedHeaders: z.ZodDefault<z.ZodArray<z.ZodString>>;
        credentials: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
      },
      z.core.$strip
    >;
    helmet: z.ZodObject<
      {
        enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        contentSecurityPolicy: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        hsts: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        noSniff: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        frameguard: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
      },
      z.core.$strip
    >;
    rateLimit: z.ZodObject<
      {
        global: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            requests: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            window: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
declare const ExternalServicesConfigSchema: z.ZodObject<
  {
    stripe: z.ZodOptional<
      z.ZodObject<
        {
          secretKey: z.ZodOptional<z.ZodString>;
          publishableKey: z.ZodOptional<z.ZodString>;
          webhookSecret: z.ZodOptional<z.ZodString>;
          apiVersion: z.ZodDefault<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    paypal: z.ZodOptional<
      z.ZodObject<
        {
          clientId: z.ZodOptional<z.ZodString>;
          clientSecret: z.ZodOptional<z.ZodString>;
          webhookId: z.ZodOptional<z.ZodString>;
          environment: z.ZodDefault<
            z.ZodEnum<{
              production: 'production';
              sandbox: 'sandbox';
            }>
          >;
        },
        z.core.$strip
      >
    >;
    smtp: z.ZodOptional<
      z.ZodObject<
        {
          host: z.ZodOptional<z.ZodString>;
          port: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
          secure: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
          username: z.ZodOptional<z.ZodString>;
          password: z.ZodOptional<z.ZodString>;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
declare const PerformanceConfigSchema: z.ZodObject<
  {
    compression: z.ZodObject<
      {
        enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        level: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        threshold: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
      },
      z.core.$strip
    >;
    circuitBreaker: z.ZodObject<
      {
        enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        failureThreshold: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        resetTimeout: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        monitoringPeriod: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
      },
      z.core.$strip
    >;
    clustering: z.ZodObject<
      {
        enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        workers: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
export declare const ConfigSchema: z.ZodObject<
  {
    server: z.ZodObject<
      {
        port: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        host: z.ZodDefault<z.ZodString>;
        environment: z.ZodDefault<
          z.ZodEnum<{
            production: 'production';
            development: 'development';
            staging: 'staging';
          }>
        >;
        maxConnections: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        timeout: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
      },
      z.core.$strip
    >;
    serviceDiscovery: z.ZodObject<
      {
        enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        type: z.ZodDefault<
          z.ZodEnum<{
            memory: 'memory';
            consul: 'consul';
            kubernetes: 'kubernetes';
          }>
        >;
        consulUrl: z.ZodDefault<z.ZodString>;
        kubernetesNamespace: z.ZodDefault<z.ZodString>;
        healthCheckInterval: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        retryAttempts: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
      },
      z.core.$strip
    >;
    database: z.ZodObject<
      {
        url: z.ZodOptional<z.ZodString>;
        redis: z.ZodObject<
          {
            url: z.ZodDefault<z.ZodString>;
            maxRetries: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            retryDelay: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            keyPrefix: z.ZodDefault<z.ZodString>;
          },
          z.core.$strip
        >;
        mysql: z.ZodOptional<
          z.ZodObject<
            {
              host: z.ZodDefault<z.ZodString>;
              port: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
              database: z.ZodOptional<z.ZodString>;
              username: z.ZodOptional<z.ZodString>;
              password: z.ZodOptional<z.ZodString>;
              connectionLimit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
              acquireTimeout: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
              timeout: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            },
            z.core.$strip
          >
        >;
      },
      z.core.$strip
    >;
    modules: z.ZodObject<
      {
        cache: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            defaultTtl: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            maxSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            strategy: z.ZodDefault<
              z.ZodEnum<{
                lru: 'lru';
                lfu: 'lfu';
                fifo: 'fifo';
              }>
            >;
          },
          z.core.$strip
        >;
        rateLimit: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            defaultRequests: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            defaultWindow: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            skipSuccessfulRequests: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            skipFailedRequests: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
          },
          z.core.$strip
        >;
        validation: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            stripUnknown: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            abortEarly: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >;
    logging: z.ZodObject<
      {
        level: z.ZodDefault<
          z.ZodEnum<{
            debug: 'debug';
            info: 'info';
            warn: 'warn';
            error: 'error';
            fatal: 'fatal';
          }>
        >;
        format: z.ZodDefault<
          z.ZodEnum<{
            pretty: 'pretty';
            json: 'json';
            compact: 'compact';
          }>
        >;
        enableColors: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        enableTimestamp: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        enableContext: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
        outputs: z.ZodObject<
          {
            console: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            file: z.ZodObject<
              {
                enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
                path: z.ZodDefault<z.ZodString>;
                maxSize: z.ZodDefault<z.ZodString>;
                maxFiles: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
              },
              z.core.$strip
            >;
            webhook: z.ZodObject<
              {
                enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
                url: z.ZodOptional<z.ZodString>;
                headers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
              },
              z.core.$strip
            >;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >;
    security: z.ZodObject<
      {
        cors: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            origin: z.ZodDefault<
              z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>, z.ZodBoolean]>
            >;
            methods: z.ZodDefault<z.ZodArray<z.ZodString>>;
            allowedHeaders: z.ZodDefault<z.ZodArray<z.ZodString>>;
            credentials: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
          },
          z.core.$strip
        >;
        helmet: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            contentSecurityPolicy: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            hsts: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            noSniff: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            frameguard: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
          },
          z.core.$strip
        >;
        rateLimit: z.ZodObject<
          {
            global: z.ZodObject<
              {
                enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
                requests: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
                window: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
              },
              z.core.$strip
            >;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >;
    external: z.ZodObject<
      {
        stripe: z.ZodOptional<
          z.ZodObject<
            {
              secretKey: z.ZodOptional<z.ZodString>;
              publishableKey: z.ZodOptional<z.ZodString>;
              webhookSecret: z.ZodOptional<z.ZodString>;
              apiVersion: z.ZodDefault<z.ZodString>;
            },
            z.core.$strip
          >
        >;
        paypal: z.ZodOptional<
          z.ZodObject<
            {
              clientId: z.ZodOptional<z.ZodString>;
              clientSecret: z.ZodOptional<z.ZodString>;
              webhookId: z.ZodOptional<z.ZodString>;
              environment: z.ZodDefault<
                z.ZodEnum<{
                  production: 'production';
                  sandbox: 'sandbox';
                }>
              >;
            },
            z.core.$strip
          >
        >;
        smtp: z.ZodOptional<
          z.ZodObject<
            {
              host: z.ZodOptional<z.ZodString>;
              port: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
              secure: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
              username: z.ZodOptional<z.ZodString>;
              password: z.ZodOptional<z.ZodString>;
            },
            z.core.$strip
          >
        >;
      },
      z.core.$strip
    >;
    performance: z.ZodObject<
      {
        compression: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            level: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            threshold: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
          },
          z.core.$strip
        >;
        circuitBreaker: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            failureThreshold: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            resetTimeout: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
            monitoringPeriod: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
          },
          z.core.$strip
        >;
        clustering: z.ZodObject<
          {
            enabled: z.ZodDefault<z.ZodCoercedBoolean<unknown>>;
            workers: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
          },
          z.core.$strip
        >;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
export type AppConfig = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ServiceDiscoveryConfig = z.infer<typeof ServiceDiscoveryConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type ModuleDefaultsConfig = z.infer<typeof ModuleDefaultsConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type ExternalServicesConfig = z.infer<typeof ExternalServicesConfigSchema>;
export type PerformanceConfig = z.infer<typeof PerformanceConfigSchema>;
export {
  ServerConfigSchema,
  ServiceDiscoveryConfigSchema,
  DatabaseConfigSchema,
  ModuleDefaultsConfigSchema,
  LoggingConfigSchema,
  SecurityConfigSchema,
  ExternalServicesConfigSchema,
  PerformanceConfigSchema,
};
