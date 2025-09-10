"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cookie = void 0;
const logger_1 = require("../../logger");
const logger = (0, logger_1.createFrameworkLogger)('CookieMiddleware');
const cookie = (options = {}) => ({
    name: 'cookie',
    version: '1.0.0',
    metadata: {
        name: 'cookie',
        version: '1.0.0',
        description: 'Cookie parsing and setting middleware with security features',
        author: 'MoroJS Team',
    },
    install: async (hooks, options = {}) => {
        logger.debug('Installing cookie middleware', 'Installation');
        hooks.before('request', async (context) => {
            const req = context.request;
            const res = context.response;
            // Parse cookies from request
            req.cookies = parseCookies(req.headers.cookie || '');
            // Add cookie methods to response
            res.cookie = (name, value, options = {}) => {
                const cookieValue = encodeURIComponent(value);
                let cookieString = `${name}=${cookieValue}`;
                if (options.maxAge)
                    cookieString += `; Max-Age=${options.maxAge}`;
                if (options.expires)
                    cookieString += `; Expires=${options.expires.toUTCString()}`;
                if (options.httpOnly)
                    cookieString += '; HttpOnly';
                if (options.secure)
                    cookieString += '; Secure';
                if (options.sameSite)
                    cookieString += `; SameSite=${options.sameSite}`;
                if (options.domain)
                    cookieString += `; Domain=${options.domain}`;
                if (options.path)
                    cookieString += `; Path=${options.path}`;
                const existingCookies = res.getHeader('Set-Cookie') || [];
                const cookies = Array.isArray(existingCookies)
                    ? [...existingCookies]
                    : [existingCookies];
                cookies.push(cookieString);
                res.setHeader('Set-Cookie', cookies);
                return res;
            };
            res.clearCookie = (name, options = {}) => {
                const clearOptions = { ...options, expires: new Date(0), maxAge: 0 };
                return res.cookie(name, '', clearOptions);
            };
        });
    },
});
exports.cookie = cookie;
function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader)
        return cookies;
    cookieHeader.split(';').forEach(cookie => {
        const [name, value] = cookie.trim().split('=');
        if (name && value) {
            cookies[name] = decodeURIComponent(value);
        }
    });
    return cookies;
}
