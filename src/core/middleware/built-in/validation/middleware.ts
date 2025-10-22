// Validation Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { sharedValidationCore, type ValidationConfig } from './core.js';

/**
 * Create validation middleware for use in middleware chains
 *
 * @example
 * ```ts
 * const validateMw = createValidationMiddleware({
 *   body: myBodySchema,
 *   query: myQuerySchema
 * });
 *
 * app.use(validateMw);
 * ```
 */
export function createValidationMiddleware(config: ValidationConfig): StandardMiddleware {
  if (!config || Object.keys(config).length === 0) {
    return (_req, _res, next) => next();
  }

  return async (req: any, res: any, next: () => void) => {
    const success = await sharedValidationCore.validate(req, res, config);
    if (success) {
      next();
    }
    // If validation failed, response is already sent
  };
}
