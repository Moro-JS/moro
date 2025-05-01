// CORS Middleware
import { MiddlewareInterface, HookContext } from "../../../types/hooks";
import { createFrameworkLogger } from "../../logger";

const logger = createFrameworkLogger("CorsMiddleware");

export const cors = (options: any = {}): MiddlewareInterface => ({
  name: "cors",
  version: "1.0.0",
  metadata: {
    name: "cors",
    version: "1.0.0",
    description: "Cross-Origin Resource Sharing middleware",
    author: "MoroJS Team",
  },

  install: async (hooks: any, options: any = {}) => {
    logger.debug("Installing CORS middleware", "Installation", { options });

    hooks.before("request", async (context: HookContext) => {
      const response = context.response as any;

      response.setHeader("Access-Control-Allow-Origin", options.origin || "*");
      response.setHeader(
        "Access-Control-Allow-Methods",
        options.methods || "GET,POST,PUT,DELETE,OPTIONS",
      );
      response.setHeader(
        "Access-Control-Allow-Headers",
        options.headers || "Content-Type,Authorization",
      );

      if (options.credentials) {
        response.setHeader("Access-Control-Allow-Credentials", "true");
      }
    });
  },
});
