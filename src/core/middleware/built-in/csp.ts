// Content Security Policy Middleware
import { MiddlewareInterface, HookContext } from "../../../types/hooks";
import { createFrameworkLogger } from "../../logger";

const logger = createFrameworkLogger("CSPMiddleware");

export const csp = (
  options: {
    directives?: {
      defaultSrc?: string[];
      scriptSrc?: string[];
      styleSrc?: string[];
      imgSrc?: string[];
      connectSrc?: string[];
      fontSrc?: string[];
      objectSrc?: string[];
      mediaSrc?: string[];
      frameSrc?: string[];
      childSrc?: string[];
      workerSrc?: string[];
      formAction?: string[];
      upgradeInsecureRequests?: boolean;
      blockAllMixedContent?: boolean;
    };
    reportOnly?: boolean;
    reportUri?: string;
    nonce?: boolean;
  } = {},
): MiddlewareInterface => ({
  name: "csp",
  version: "1.0.0",
  metadata: {
    name: "csp",
    version: "1.0.0",
    description:
      "Content Security Policy middleware with nonce support and violation reporting",
    author: "MoroJS Team",
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug("Installing CSP middleware", "Installation");

    hooks.before("request", async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      const directives = options.directives || {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      };

      // Generate nonce if requested
      let nonce: string | undefined;
      if (options.nonce) {
        const crypto = require("crypto");
        nonce = crypto.randomBytes(16).toString("base64");
        req.cspNonce = nonce;
      }

      // Build CSP header value
      const cspParts: string[] = [];

      for (const [directive, sources] of Object.entries(directives)) {
        if (directive === "upgradeInsecureRequests" && sources === true) {
          cspParts.push("upgrade-insecure-requests");
        } else if (directive === "blockAllMixedContent" && sources === true) {
          cspParts.push("block-all-mixed-content");
        } else if (Array.isArray(sources)) {
          let sourceList = sources.join(" ");

          // Add nonce to script-src and style-src if enabled
          if (
            nonce &&
            (directive === "scriptSrc" || directive === "styleSrc")
          ) {
            sourceList += ` 'nonce-${nonce}'`;
          }

          // Convert camelCase to kebab-case
          const kebabDirective = directive
            .replace(/([A-Z])/g, "-$1")
            .toLowerCase();
          cspParts.push(`${kebabDirective} ${sourceList}`);
        }
      }

      // Add report-uri if specified
      if (options.reportUri) {
        cspParts.push(`report-uri ${options.reportUri}`);
      }

      const cspValue = cspParts.join("; ");
      const headerName = options.reportOnly
        ? "Content-Security-Policy-Report-Only"
        : "Content-Security-Policy";

      res.setHeader(headerName, cspValue);
    });
  },
});
