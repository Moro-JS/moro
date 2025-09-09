"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Router = void 0;
const logger_1 = require("../logger");
class Router {
    routes = [];
    logger = (0, logger_1.createFrameworkLogger)("Router");
    get(path, ...handlers) {
        this.addRoute("GET", path, handlers);
    }
    post(path, ...handlers) {
        this.addRoute("POST", path, handlers);
    }
    put(path, ...handlers) {
        this.addRoute("PUT", path, handlers);
    }
    delete(path, ...handlers) {
        this.addRoute("DELETE", path, handlers);
    }
    patch(path, ...handlers) {
        this.addRoute("PATCH", path, handlers);
    }
    addRoute(method, path, handlers) {
        const { pattern, paramNames } = this.pathToRegex(path);
        const handler = handlers.pop();
        const middleware = handlers;
        this.routes.push({
            method,
            path,
            pattern,
            paramNames,
            handler,
            middleware,
        });
    }
    pathToRegex(path) {
        const paramNames = [];
        // Convert parameterized routes to regex
        const regexPattern = path
            .replace(/\/:([^/]+)/g, (match, paramName) => {
            paramNames.push(paramName);
            return "/([^/]+)";
        })
            .replace(/\//g, "\\/");
        return {
            pattern: new RegExp(`^${regexPattern}$`),
            paramNames,
        };
    }
    async handle(req, res, basePath = "") {
        let path = req.path.startsWith(basePath)
            ? req.path.substring(basePath.length)
            : req.path;
        // If removing basePath results in empty string, default to '/'
        if (path === "" || path === undefined) {
            path = "/";
        }
        this.logger.debug(`Router processing: originalPath="${req.path}", basePath="${basePath}", processedPath="${path}"`, "Processing");
        const route = this.routes.find((r) => r.method === req.method && r.pattern.test(path));
        this.logger.debug(`Found route: ${!!route}${route ? ` ${route.method} ${route.path}` : " none"}`, "RouteMatch");
        if (!route) {
            return false; // Route not found
        }
        // Extract path parameters
        const matches = path.match(route.pattern);
        if (matches) {
            req.params = {};
            route.paramNames.forEach((name, index) => {
                req.params[name] = matches[index + 1];
            });
        }
        // Execute middleware
        for (const mw of route.middleware) {
            await new Promise((resolve, reject) => {
                let nextCalled = false;
                const next = () => {
                    if (nextCalled)
                        return;
                    nextCalled = true;
                    resolve();
                };
                try {
                    const result = mw(req, res, next);
                    if (result instanceof Promise) {
                        result
                            .then(() => {
                            if (!nextCalled)
                                next();
                        })
                            .catch(reject);
                    }
                }
                catch (error) {
                    reject(error);
                }
            });
        }
        // Execute handler
        const result = await route.handler(req, res);
        // If handler returns data and response hasn't been sent, send it
        if (result !== undefined && result !== null && !res.headersSent) {
            res.json(result);
        }
        return true;
    }
    getRoutes() {
        return [...this.routes];
    }
}
exports.Router = Router;
