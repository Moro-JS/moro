"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.session = void 0;
const logger_1 = require("../../logger");
const memory_1 = require("./adapters/cache/memory");
const redis_1 = require("./adapters/cache/redis");
const file_1 = require("./adapters/cache/file");
const logger = (0, logger_1.createFrameworkLogger)('SessionMiddleware');
class Session {
    data = {};
    id;
    store;
    options;
    isNew = false;
    isModified = false;
    constructor(id, store, options, isNew = false) {
        this.id = id;
        this.store = store;
        this.options = options;
        this.isNew = isNew;
    }
    // Proxy to make session.prop = value work
    static create(id, store, options, data = {}, isNew = false) {
        const session = new Session(id, store, options, isNew);
        session.data = data;
        return new Proxy(session, {
            get(target, prop) {
                if (prop in target) {
                    return target[prop];
                }
                return target.data[prop];
            },
            set(target, prop, value) {
                if (prop in target) {
                    target[prop] = value;
                }
                else {
                    target.data[prop] = value;
                    target.isModified = true;
                }
                return true;
            },
            has(target, prop) {
                return prop in target || prop in target.data;
            },
            deleteProperty(target, prop) {
                if (prop in target.data) {
                    delete target.data[prop];
                    target.isModified = true;
                    return true;
                }
                return false;
            },
        });
    }
    async save() {
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
    async destroy() {
        await this.store.del(this.id);
        this.data = {};
        this.isModified = false;
        logger.debug(`Session destroyed: ${this.id}`, 'SessionDestroy');
    }
    async regenerate() {
        await this.destroy();
        this.id = this.generateId();
        this.isNew = true;
        this.isModified = true;
        logger.debug(`Session regenerated: ${this.id}`, 'SessionRegenerate');
        return this.id;
    }
    async touch() {
        if (this.options.rolling) {
            this.isModified = true;
            await this.save();
        }
    }
    generateId() {
        if (this.options.genid) {
            return this.options.genid();
        }
        const crypto = require('crypto');
        return crypto.randomBytes(24).toString('hex');
    }
    get sessionID() {
        return this.id;
    }
}
const session = (options = {}) => ({
    name: 'session',
    version: '1.0.0',
    metadata: {
        name: 'session',
        version: '1.0.0',
        description: 'Session management middleware with multiple store adapters',
        author: 'MoroJS Team',
    },
    install: async (hooks, middlewareOptions = {}) => {
        logger.debug('Installing session middleware', 'Installation');
        // Merge options
        const config = {
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
            ...middlewareOptions,
        };
        // Initialize store
        let store;
        if (typeof config.store === 'string') {
            switch (config.store) {
                case 'redis':
                    store = new redis_1.RedisCacheAdapter({
                        keyPrefix: 'sess:',
                        ...config.storeOptions,
                    });
                    break;
                case 'file':
                    store = new file_1.FileCacheAdapter({
                        cacheDir: config.storeOptions?.path || './sessions',
                    });
                    break;
                case 'memory':
                default:
                    store = new memory_1.MemoryCacheAdapter();
                    break;
            }
        }
        else {
            store = config.store;
        }
        // Generate session ID
        const generateSessionId = () => {
            if (config.genid) {
                return config.genid();
            }
            const crypto = require('crypto');
            return crypto.randomBytes(24).toString('hex');
        };
        hooks.before('request', async (context) => {
            const req = context.request;
            const res = context.response;
            // Get session ID from cookie
            let sessionId = req.cookies?.[config.name];
            let sessionData = {};
            let isNew = false;
            if (sessionId) {
                try {
                    sessionData = (await store.get(sessionId)) || {};
                    logger.debug(`Session loaded: ${sessionId}`, 'SessionLoad');
                }
                catch (error) {
                    logger.warn(`Failed to load session: ${sessionId}`, 'SessionLoadError', { error });
                    sessionId = generateSessionId();
                    isNew = true;
                }
            }
            else {
                sessionId = generateSessionId();
                isNew = true;
            }
            // Create session object
            req.session = Session.create(sessionId, store, config, sessionData, isNew);
            // Set session cookie
            if (isNew || config.rolling) {
                res.cookie(config.name, sessionId, {
                    ...config.cookie,
                    secure: config.cookie?.secure || (config.proxy && req.headers['x-forwarded-proto'] === 'https'),
                });
            }
        });
        hooks.after('response', async (context) => {
            const req = context.request;
            if (req.session) {
                try {
                    if (config.saveUninitialized || !req.session.isNew || req.session.isModified) {
                        await req.session.save();
                    }
                }
                catch (error) {
                    logger.error('Failed to save session', 'SessionSaveError', { error });
                }
            }
        });
        logger.info(`Session middleware installed with ${config.store} store`, 'Installation');
    },
});
exports.session = session;
