"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.simpleMiddleware = exports.builtInMiddleware = exports.cdn = exports.cache = exports.session = exports.sse = exports.csp = exports.csrf = exports.cookie = exports.errorTracker = exports.performanceMonitor = exports.requestLogger = exports.validation = exports.cors = exports.rateLimit = exports.auth = void 0;
// Built-in Middleware Exports
var auth_1 = require("./auth");
Object.defineProperty(exports, "auth", { enumerable: true, get: function () { return auth_1.auth; } });
var rate_limit_1 = require("./rate-limit");
Object.defineProperty(exports, "rateLimit", { enumerable: true, get: function () { return rate_limit_1.rateLimit; } });
var cors_1 = require("./cors");
Object.defineProperty(exports, "cors", { enumerable: true, get: function () { return cors_1.cors; } });
var validation_1 = require("./validation");
Object.defineProperty(exports, "validation", { enumerable: true, get: function () { return validation_1.validation; } });
var request_logger_1 = require("./request-logger");
Object.defineProperty(exports, "requestLogger", { enumerable: true, get: function () { return request_logger_1.requestLogger; } });
var performance_monitor_1 = require("./performance-monitor");
Object.defineProperty(exports, "performanceMonitor", { enumerable: true, get: function () { return performance_monitor_1.performanceMonitor; } });
var error_tracker_1 = require("./error-tracker");
Object.defineProperty(exports, "errorTracker", { enumerable: true, get: function () { return error_tracker_1.errorTracker; } });
// Advanced Security & Performance Middleware
var cookie_1 = require("./cookie");
Object.defineProperty(exports, "cookie", { enumerable: true, get: function () { return cookie_1.cookie; } });
var csrf_1 = require("./csrf");
Object.defineProperty(exports, "csrf", { enumerable: true, get: function () { return csrf_1.csrf; } });
var csp_1 = require("./csp");
Object.defineProperty(exports, "csp", { enumerable: true, get: function () { return csp_1.csp; } });
var sse_1 = require("./sse");
Object.defineProperty(exports, "sse", { enumerable: true, get: function () { return sse_1.sse; } });
var session_1 = require("./session");
Object.defineProperty(exports, "session", { enumerable: true, get: function () { return session_1.session; } });
// Clean Architecture Middleware
var cache_1 = require("./cache");
Object.defineProperty(exports, "cache", { enumerable: true, get: function () { return cache_1.cache; } });
var cdn_1 = require("./cdn");
Object.defineProperty(exports, "cdn", { enumerable: true, get: function () { return cdn_1.cdn; } });
// Import for collections
const auth_2 = require("./auth");
const rate_limit_2 = require("./rate-limit");
const cors_2 = require("./cors");
const validation_2 = require("./validation");
const request_logger_2 = require("./request-logger");
const performance_monitor_2 = require("./performance-monitor");
const error_tracker_2 = require("./error-tracker");
const cookie_2 = require("./cookie");
const csrf_2 = require("./csrf");
const csp_2 = require("./csp");
const sse_2 = require("./sse");
const session_2 = require("./session");
const cache_2 = require("./cache");
const cdn_2 = require("./cdn");
exports.builtInMiddleware = {
    auth: auth_2.auth,
    rateLimit: rate_limit_2.rateLimit,
    cors: cors_2.cors,
    validation: validation_2.validation,
    // Advanced middleware
    cookie: cookie_2.cookie,
    csrf: csrf_2.csrf,
    csp: csp_2.csp,
    sse: sse_2.sse,
    session: session_2.session,
    // Clean architecture middleware
    cache: cache_2.cache,
    cdn: cdn_2.cdn,
};
exports.simpleMiddleware = {
    requestLogger: request_logger_2.requestLogger,
    performanceMonitor: performance_monitor_2.performanceMonitor,
    errorTracker: error_tracker_2.errorTracker,
};
