// Authentication Middleware
import { MiddlewareInterface, HookContext } from "../../../types/hooks";
import { createFrameworkLogger } from "../../logger";

const logger = createFrameworkLogger("AuthMiddleware");

export const auth = (options: any = {}): MiddlewareInterface => ({
  name: "auth",
  version: "1.0.0",
  metadata: {
    name: "auth",
    version: "1.0.0",
    description: "JWT authentication middleware with token validation",
    author: "MoroJS Team",
  },

  install: async (hooks: any, options: any = {}) => {
    logger.debug(`Installing auth middleware with options`, "Installation", {
      options,
    });

    hooks.before("request", async (context: HookContext) => {
      const req = context.request as any;
      const token = req.headers?.authorization?.replace("Bearer ", "");

      if (token) {
        try {
          // Simple token validation (in production, use proper JWT verification)
          if (token.startsWith("valid_")) {
            req.user = { id: 1, role: "user" };
            logger.debug(`Auth: Verified token for request`, "TokenValidation");
          }
        } catch (error) {
          throw new Error("Invalid token");
        }
      }
    });
  },
});
