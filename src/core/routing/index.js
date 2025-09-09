"use strict";
// Intelligent Routing System for Moro Framework
// Schema-first with automatic middleware ordering and chainable API
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutableRoute = exports.IntelligentRouteBuilder = exports.EXECUTION_PHASES = void 0;
exports.createRoute = createRoute;
exports.defineRoute = defineRoute;
const logger_1 = require("../logger");
const logger = (0, logger_1.createFrameworkLogger)("IntelligentRouting");
// Execution phases in optimal order
exports.EXECUTION_PHASES = [
    "security", // CORS, Helmet (framework-managed)
    "parsing", // Body/query parsing (framework-managed)
    "rateLimit", // Rate limiting (early protection)
    "before", // Custom pre-processing middleware
    "auth", // Authentication/authorization
    "validation", // Request validation
    "transform", // Data transformation middleware
    "cache", // Caching logic
    "after", // Custom post-processing middleware
    "handler", // Route handler (always last)
];
// Route builder implementation
class IntelligentRouteBuilder {
    schema;
    constructor(method, path) {
        this.schema = {
            method,
            path,
            middleware: {},
        };
    }
    // Validation methods
    validate(config) {
        this.schema.validation = { ...this.schema.validation, ...config };
        return this;
    }
    body(schema) {
        if (!this.schema.validation)
            this.schema.validation = {};
        this.schema.validation.body = schema;
        return this;
    }
    query(schema) {
        if (!this.schema.validation)
            this.schema.validation = {};
        this.schema.validation.query = schema;
        return this;
    }
    params(schema) {
        if (!this.schema.validation)
            this.schema.validation = {};
        this.schema.validation.params = schema;
        return this;
    }
    headers(schema) {
        if (!this.schema.validation)
            this.schema.validation = {};
        this.schema.validation.headers = schema;
        return this;
    }
    // Security methods
    auth(config) {
        this.schema.auth = config;
        return this;
    }
    rateLimit(config) {
        this.schema.rateLimit = config;
        return this;
    }
    // Caching
    cache(config) {
        this.schema.cache = config;
        return this;
    }
    // Custom middleware
    before(...middleware) {
        if (!this.schema.middleware)
            this.schema.middleware = {};
        this.schema.middleware.before = [
            ...(this.schema.middleware.before || []),
            ...middleware,
        ];
        return this;
    }
    after(...middleware) {
        if (!this.schema.middleware)
            this.schema.middleware = {};
        this.schema.middleware.after = [
            ...(this.schema.middleware.after || []),
            ...middleware,
        ];
        return this;
    }
    transform(...middleware) {
        if (!this.schema.middleware)
            this.schema.middleware = {};
        this.schema.middleware.transform = [
            ...(this.schema.middleware.transform || []),
            ...middleware,
        ];
        return this;
    }
    use(...middleware) {
        return this.after(...middleware);
    }
    // Metadata
    describe(description) {
        this.schema.description = description;
        return this;
    }
    tag(...tags) {
        this.schema.tags = [...(this.schema.tags || []), ...tags];
        return this;
    }
    // Terminal method - compiles the route
    handler(handler) {
        if (!handler) {
            throw new Error("Handler is required");
        }
        const completeSchema = {
            ...this.schema,
            handler,
        };
        logger.debug(`Compiled route: ${completeSchema.method} ${completeSchema.path}`, "RouteCompilation", {
            hasValidation: !!completeSchema.validation,
            hasAuth: !!completeSchema.auth,
            hasRateLimit: !!completeSchema.rateLimit,
            hasCache: !!completeSchema.cache,
            customMiddleware: {
                before: completeSchema.middleware?.before?.length || 0,
                after: completeSchema.middleware?.after?.length || 0,
                transform: completeSchema.middleware?.transform?.length || 0,
            },
        });
        return new ExecutableRoute(completeSchema);
    }
}
exports.IntelligentRouteBuilder = IntelligentRouteBuilder;
// Executable route with intelligent middleware ordering
class ExecutableRoute {
    schema;
    constructor(schema) {
        this.schema = schema;
    }
    async execute(req, res) {
        const validatedReq = req;
        try {
            // Execute middleware in intelligent order
            await this.executePhase("before", validatedReq, res);
            await this.executePhase("rateLimit", validatedReq, res);
            await this.executePhase("auth", validatedReq, res);
            await this.executePhase("validation", validatedReq, res);
            await this.executePhase("transform", validatedReq, res);
            await this.executePhase("cache", validatedReq, res);
            await this.executePhase("after", validatedReq, res);
            // Execute handler last
            if (!res.headersSent) {
                await this.executePhase("handler", validatedReq, res);
            }
        }
        catch (error) {
            logger.error("Route execution error", "RouteExecution", {
                error: error instanceof Error ? error.message : String(error),
                route: `${this.schema.method} ${this.schema.path}`,
                requestId: req.requestId,
            });
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                    requestId: req.requestId,
                });
            }
        }
    }
    async executePhase(phase, req, res) {
        switch (phase) {
            case "before":
                if (this.schema.middleware?.before) {
                    for (const middleware of this.schema.middleware.before) {
                        await this.executeMiddleware(middleware, req, res);
                    }
                }
                break;
            case "rateLimit":
                if (this.schema.rateLimit) {
                    await this.executeRateLimit(req, res);
                }
                break;
            case "auth":
                if (this.schema.auth) {
                    await this.executeAuth(req, res);
                }
                break;
            case "validation":
                if (this.schema.validation) {
                    await this.executeValidation(req, res);
                }
                break;
            case "transform":
                if (this.schema.middleware?.transform) {
                    for (const middleware of this.schema.middleware.transform) {
                        await this.executeMiddleware(middleware, req, res);
                    }
                }
                break;
            case "cache":
                if (this.schema.cache) {
                    await this.executeCache(req, res);
                }
                break;
            case "after":
                if (this.schema.middleware?.after) {
                    for (const middleware of this.schema.middleware.after) {
                        await this.executeMiddleware(middleware, req, res);
                    }
                }
                break;
            case "handler": {
                const result = await this.schema.handler(req, res);
                if (result !== undefined && !res.headersSent) {
                    res.json(result);
                }
                break;
            }
        }
    }
    async executeMiddleware(middleware, req, res) {
        return new Promise((resolve, reject) => {
            try {
                const next = () => resolve();
                const result = middleware(req, res, next);
                if (result instanceof Promise) {
                    result.then(() => resolve()).catch(reject);
                }
            }
            catch (error) {
                reject(error);
            }
        });
    }
    async executeRateLimit(req, res) {
        // Rate limiting implementation will be added
        logger.debug("Rate limit check", "RateLimit", {
            config: this.schema.rateLimit,
            ip: req.ip,
        });
    }
    async executeAuth(req, res) {
        // Authentication implementation will be added
        logger.debug("Auth check", "Auth", {
            config: this.schema.auth,
        });
    }
    async executeValidation(req, res) {
        if (!this.schema.validation)
            return;
        const { body, query, params, headers } = this.schema.validation;
        // Validate body
        if (body && req.body !== undefined) {
            try {
                req.validatedBody = await body.parseAsync(req.body);
                req.body = req.validatedBody; // Update original for compatibility
            }
            catch (error) {
                this.sendValidationError(res, error, "body", req.requestId);
                return;
            }
        }
        // Validate query
        if (query && req.query !== undefined) {
            try {
                req.validatedQuery = await query.parseAsync(req.query);
                req.query = req.validatedQuery; // Update original for compatibility
            }
            catch (error) {
                this.sendValidationError(res, error, "query", req.requestId);
                return;
            }
        }
        // Validate params
        if (params && req.params !== undefined) {
            try {
                req.validatedParams = await params.parseAsync(req.params);
                req.params = req.validatedParams; // Update original for compatibility
            }
            catch (error) {
                this.sendValidationError(res, error, "params", req.requestId);
                return;
            }
        }
        // Validate headers
        if (headers && req.headers !== undefined) {
            try {
                req.validatedHeaders = await headers.parseAsync(req.headers);
            }
            catch (error) {
                this.sendValidationError(res, error, "headers", req.requestId);
                return;
            }
        }
        logger.debug("Validation passed", "Validation", {
            route: `${this.schema.method} ${this.schema.path}`,
            validatedFields: Object.keys(this.schema.validation),
        });
    }
    sendValidationError(res, error, field, requestId) {
        if (error.issues) {
            res.status(400).json({
                success: false,
                error: `Validation failed for ${field}`,
                details: error.issues.map((issue) => ({
                    field: issue.path.length > 0 ? issue.path.join(".") : field,
                    message: issue.message,
                    code: issue.code,
                })),
                requestId,
            });
        }
        else {
            res.status(400).json({
                success: false,
                error: `Validation failed for ${field}`,
                requestId,
            });
        }
    }
    async executeCache(req, res) {
        // Caching implementation will be added
        logger.debug("Cache check", "Cache", {
            config: this.schema.cache,
        });
    }
}
exports.ExecutableRoute = ExecutableRoute;
// Factory functions for creating routes
function createRoute(method, path) {
    return new IntelligentRouteBuilder(method, path);
}
// Schema-first route creation
function defineRoute(schema) {
    return new ExecutableRoute(schema);
}
