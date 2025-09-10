"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setConfig = setConfig;
exports.getConfig = getConfig;
exports.createModuleConfig = createModuleConfig;
exports.getEnvVar = getEnvVar;
exports.getEnvArray = getEnvArray;
exports.getEnvJson = getEnvJson;
exports.requireEnvVars = requireEnvVars;
exports.envVar = envVar;
exports.getConfigValue = getConfigValue;
exports.isDevelopment = isDevelopment;
exports.isProduction = isProduction;
exports.isStaging = isStaging;
const logger_1 = require("../logger");
const logger = (0, logger_1.createFrameworkLogger)('ConfigUtils');
// Global configuration store
let appConfig = null;
/**
 * Set the global configuration (used by framework initialization)
 */
function setConfig(config) {
    appConfig = config;
    logger.debug('Global configuration updated');
}
/**
 * Get the global configuration
 */
function getConfig() {
    if (!appConfig) {
        throw new Error('Configuration not initialized. Call loadConfig() first.');
    }
    return appConfig;
}
/**
 * Create module-specific configuration with environment override support
 */
function createModuleConfig(schema, defaultConfig, envPrefix) {
    const globalConfig = getConfig();
    // Build environment configuration object
    const envConfig = {};
    if (envPrefix) {
        // Extract environment variables with the given prefix
        Object.keys(process.env).forEach(key => {
            if (key.startsWith(envPrefix)) {
                const configKey = key
                    .substring(envPrefix.length)
                    .toLowerCase()
                    .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
                envConfig[configKey] = process.env[key];
            }
        });
    }
    // Merge default config, global defaults, and environment overrides
    const mergedConfig = {
        ...defaultConfig,
        ...envConfig,
    };
    try {
        return schema.parse(mergedConfig);
    }
    catch (error) {
        logger.error(`Module configuration validation failed for prefix ${envPrefix}:`, String(error));
        throw error;
    }
}
/**
 * Get environment variable with type conversion
 */
function getEnvVar(key, defaultValue, converter) {
    const value = process.env[key];
    if (value === undefined) {
        return defaultValue;
    }
    if (converter) {
        try {
            return converter(value);
        }
        catch (error) {
            logger.warn(`Failed to convert environment variable ${key}:`, String(error));
            return defaultValue;
        }
    }
    // Default type conversions
    if (typeof defaultValue === 'boolean') {
        return (value.toLowerCase() === 'true');
    }
    if (typeof defaultValue === 'number') {
        const num = Number(value);
        return (isNaN(num) ? defaultValue : num);
    }
    return value;
}
/**
 * Parse comma-separated environment variable as array
 */
function getEnvArray(key, defaultValue = []) {
    const value = process.env[key];
    if (!value) {
        return defaultValue;
    }
    return value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}
/**
 * Parse JSON environment variable safely
 */
function getEnvJson(key, defaultValue) {
    const value = process.env[key];
    if (!value) {
        return defaultValue;
    }
    try {
        return JSON.parse(value);
    }
    catch (error) {
        logger.warn(`Failed to parse JSON environment variable ${key}:`, String(error));
        return defaultValue;
    }
}
/**
 * Validate required environment variables
 */
function requireEnvVars(...keys) {
    const missing = [];
    keys.forEach(key => {
        if (!process.env[key]) {
            missing.push(key);
        }
    });
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}
/**
 * Create environment variable name with prefix
 */
function envVar(prefix, name) {
    return `${prefix.toUpperCase()}_${name.toUpperCase()}`;
}
/**
 * Get configuration value with dot notation
 */
function getConfigValue(path) {
    const config = getConfig();
    return path.split('.').reduce((obj, key) => {
        return obj && obj[key] !== undefined ? obj[key] : undefined;
    }, config);
}
/**
 * Check if we're in development environment
 */
function isDevelopment() {
    try {
        return getConfig().server.environment === 'development';
    }
    catch {
        return process.env.NODE_ENV === 'development';
    }
}
/**
 * Check if we're in production environment
 */
function isProduction() {
    try {
        return getConfig().server.environment === 'production';
    }
    catch {
        return process.env.NODE_ENV === 'production';
    }
}
/**
 * Check if we're in staging environment
 */
function isStaging() {
    try {
        return getConfig().server.environment === 'staging';
    }
    catch {
        return process.env.NODE_ENV === 'staging';
    }
}
