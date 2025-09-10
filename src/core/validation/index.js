"use strict";
// Functional Validation System for Moro Framework
// Elegant, type-safe validation using Zod with functional composition
Object.defineProperty(exports, "__esModule", { value: true });
exports.z = void 0;
exports.validate = validate;
exports.body = body;
exports.query = query;
exports.params = params;
exports.combineSchemas = combineSchemas;
const zod_1 = require("zod");
const logger_1 = require("../logger");
const logger = (0, logger_1.createFrameworkLogger)('Validation');
// Main validation wrapper function
function validate(config, handler) {
    return async (req, res) => {
        try {
            const validatedReq = req;
            // Validate body
            if (config.body) {
                const result = await validateField(config.body, req.body, 'body');
                if (!result.success) {
                    return sendValidationError(res, result.errors, 'body');
                }
                validatedReq.validatedBody = result.data;
                validatedReq.body = result.data; // Also update original body for compatibility
            }
            // Validate query parameters
            if (config.query) {
                const result = await validateField(config.query, req.query, 'query');
                if (!result.success) {
                    return sendValidationError(res, result.errors, 'query');
                }
                validatedReq.validatedQuery = result.data;
                validatedReq.query = result.data; // Also update original query for compatibility
            }
            // Validate path parameters
            if (config.params) {
                const result = await validateField(config.params, req.params, 'params');
                if (!result.success) {
                    return sendValidationError(res, result.errors, 'params');
                }
                validatedReq.validatedParams = result.data;
                validatedReq.params = result.data; // Also update original params for compatibility
            }
            // Validate headers
            if (config.headers) {
                const result = await validateField(config.headers, req.headers, 'headers');
                if (!result.success) {
                    return sendValidationError(res, result.errors, 'headers');
                }
                validatedReq.validatedHeaders = result.data;
            }
            logger.debug('Request validation passed', 'ValidationSuccess', {
                path: req.path,
                method: req.method,
                validatedFields: Object.keys(config),
            });
            // Execute the handler with validated request
            return await handler(validatedReq, res);
        }
        catch (error) {
            logger.error('Validation wrapper error', 'ValidationError', {
                error: error instanceof Error ? error.message : String(error),
                path: req.path,
                method: req.method,
            });
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    error: 'Internal validation error',
                    requestId: req.requestId,
                });
            }
        }
    };
}
// Validate individual field
async function validateField(schema, data, fieldName) {
    try {
        const validated = await schema.parseAsync(data);
        return {
            success: true,
            data: validated,
        };
    }
    catch (error) {
        if (error instanceof zod_1.ZodError) {
            const errors = error.issues.map((err) => ({
                field: err.path.length > 0 ? err.path.join('.') : fieldName,
                message: err.message,
                code: err.code,
            }));
            logger.debug('Field validation failed', 'ValidationFailed', {
                field: fieldName,
                errors: errors.length,
                details: errors,
            });
            return {
                success: false,
                errors,
            };
        }
        // Re-throw unexpected errors
        throw error;
    }
}
// Send validation error response
function sendValidationError(res, errors, field) {
    logger.debug('Sending validation error response', 'ValidationResponse', {
        field,
        errorCount: errors.length,
    });
    res.status(400).json({
        success: false,
        error: `Validation failed for ${field}`,
        details: errors,
        requestId: res.req?.requestId,
    });
}
// Convenience functions for single-field validation
function body(schema) {
    return (handler) => {
        return validate({ body: schema }, handler);
    };
}
function query(schema) {
    return (handler) => {
        return validate({ query: schema }, handler);
    };
}
function params(schema) {
    return (handler) => {
        return validate({ params: schema }, handler);
    };
}
// Schema composition helpers
function combineSchemas(schemas) {
    return schemas;
}
// Re-export Zod for convenience
var zod_2 = require("zod");
Object.defineProperty(exports, "z", { enumerable: true, get: function () { return zod_2.z; } });
