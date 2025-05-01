// Cookie Middleware
import { MiddlewareInterface, HookContext } from "../../../types/hooks";
import { createFrameworkLogger } from "../../logger";

const logger = createFrameworkLogger("CookieMiddleware");

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
  domain?: string;
  path?: string;
}

export const cookie = (
  options: {
    secret?: string;
    signed?: boolean;
  } = {},
): MiddlewareInterface => ({
  name: "cookie",
  version: "1.0.0",
  metadata: {
    name: "cookie",
    version: "1.0.0",
    description: "Cookie parsing and setting middleware with security features",
    author: "MoroJS Team",
  },

  install: async (hooks: any, options: any = {}) => {
    logger.debug("Installing cookie middleware", "Installation");

    hooks.before("request", async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Parse cookies from request
      req.cookies = parseCookies(req.headers.cookie || "");

      // Add cookie methods to response
      res.cookie = (
        name: string,
        value: string,
        options: CookieOptions = {},
      ) => {
        const cookieValue = encodeURIComponent(value);
        let cookieString = `${name}=${cookieValue}`;

        if (options.maxAge) cookieString += `; Max-Age=${options.maxAge}`;
        if (options.expires)
          cookieString += `; Expires=${options.expires.toUTCString()}`;
        if (options.httpOnly) cookieString += "; HttpOnly";
        if (options.secure) cookieString += "; Secure";
        if (options.sameSite) cookieString += `; SameSite=${options.sameSite}`;
        if (options.domain) cookieString += `; Domain=${options.domain}`;
        if (options.path) cookieString += `; Path=${options.path}`;

        const existingCookies = res.getHeader("Set-Cookie") || [];
        const cookies = Array.isArray(existingCookies)
          ? [...existingCookies]
          : [existingCookies as string];
        cookies.push(cookieString);
        res.setHeader("Set-Cookie", cookies);

        return res;
      };

      res.clearCookie = (name: string, options: CookieOptions = {}) => {
        const clearOptions = { ...options, expires: new Date(0), maxAge: 0 };
        return res.cookie(name, "", clearOptions);
      };
    });
  },
});

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(";").forEach((cookie) => {
    const [name, value] = cookie.trim().split("=");
    if (name && value) {
      cookies[name] = decodeURIComponent(value);
    }
  });

  return cookies;
}
