"use strict";
// Zod to OpenAPI Schema Converter
// Transforms Zod schemas into OpenAPI 3.0 schema definitions
Object.defineProperty(exports, "__esModule", { value: true });
exports.zodToOpenAPI = zodToOpenAPI;
exports.generateExampleFromSchema = generateExampleFromSchema;
const logger_1 = require("../logger");
const logger = (0, logger_1.createFrameworkLogger)('ZodToOpenAPI');
// Main conversion function
function zodToOpenAPI(schema, options = {}) {
    const opts = {
        includeExamples: true,
        includeDescriptions: true,
        strict: false,
        ...options,
    };
    try {
        return convertZodType(schema._def, opts);
    }
    catch (error) {
        logger.error('Failed to convert Zod schema to OpenAPI', 'Conversion', {
            error: error instanceof Error ? error.message : String(error),
        });
        // Return a basic schema as fallback
        return {
            type: 'object',
            description: 'Schema conversion failed',
            additionalProperties: true,
        };
    }
}
// Convert Zod type definition to OpenAPI schema
function convertZodType(def, options) {
    if (!def || typeof def !== 'object') {
        logger.warn('Invalid Zod definition received', 'Conversion', { def });
        return { type: 'object', additionalProperties: true };
    }
    // Handle newer Zod structure - check for 'type' field first, then 'typeName'
    const typeName = def.typeName || def.type;
    if (!typeName) {
        logger.warn('Missing typeName/type in Zod definition', 'Conversion', {
            def: JSON.stringify(def).substring(0, 200),
        });
        return { type: 'object', additionalProperties: true };
    }
    switch (typeName) {
        case 'ZodString':
        case 'string':
            return convertZodString(def, options);
        case 'ZodNumber':
        case 'number':
            return convertZodNumber(def, options);
        case 'ZodBoolean':
        case 'boolean':
            return convertZodBoolean(def, options);
        case 'ZodObject':
        case 'object':
            return convertZodObject(def, options);
        case 'ZodArray':
        case 'array':
            return convertZodArray(def, options);
        case 'ZodEnum':
        case 'enum':
            return convertZodEnum(def, options);
        case 'ZodOptional':
        case 'optional':
            return convertZodOptional(def, options);
        case 'ZodDefault':
        case 'default':
            return convertZodDefault(def, options);
        case 'ZodUnion':
        case 'union':
            return convertZodUnion(def, options);
        case 'ZodLiteral':
        case 'literal':
            return convertZodLiteral(def, options);
        case 'ZodDate':
            return {
                type: 'string',
                format: 'date-time',
                description: options.includeDescriptions ? 'ISO 8601 date-time string' : undefined,
            };
        case 'ZodUUID':
            return {
                type: 'string',
                format: 'uuid',
                pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                description: options.includeDescriptions ? 'UUID string' : undefined,
            };
        default:
            logger.warn(`Unsupported Zod type: ${typeName}`, 'Conversion');
            return {
                type: 'object',
                description: `Unsupported type: ${typeName}`,
                additionalProperties: true,
            };
    }
}
// Convert ZodString
function convertZodString(def, options) {
    const schema = { type: 'string' };
    // Handle checks (validations)
    if (def.checks) {
        for (const check of def.checks) {
            switch (check.kind) {
                case 'min':
                    schema.minLength = check.value;
                    break;
                case 'max':
                    schema.maxLength = check.value;
                    break;
                case 'email':
                    schema.format = 'email';
                    break;
                case 'url':
                    schema.format = 'uri';
                    break;
                case 'uuid':
                    schema.format = 'uuid';
                    schema.pattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
                    break;
                case 'regex':
                    schema.pattern = check.regex.source;
                    break;
                case 'datetime':
                    schema.format = 'date-time';
                    break;
            }
        }
    }
    if (options.includeExamples) {
        if (schema.format === 'email') {
            schema.example = 'user@example.com';
        }
        else if (schema.format === 'uuid') {
            schema.example = '123e4567-e89b-12d3-a456-426614174000';
        }
        else if (schema.format === 'date-time') {
            schema.example = '2023-12-01T10:00:00Z';
        }
        else {
            schema.example = 'string';
        }
    }
    return schema;
}
// Convert ZodNumber
function convertZodNumber(def, options) {
    const schema = { type: 'number' };
    if (def.checks) {
        for (const check of def.checks) {
            switch (check.kind) {
                case 'min':
                    schema.minimum = check.value;
                    break;
                case 'max':
                    schema.maximum = check.value;
                    break;
                case 'int':
                    schema.type = 'integer';
                    break;
            }
        }
    }
    if (options.includeExamples) {
        schema.example = schema.type === 'integer' ? 42 : 3.14;
    }
    return schema;
}
// Convert ZodBoolean
function convertZodBoolean(def, options) {
    const schema = { type: 'boolean' };
    if (options.includeExamples) {
        schema.example = true;
    }
    return schema;
}
// Convert ZodObject
function convertZodObject(def, options) {
    const schema = {
        type: 'object',
        properties: {},
        required: [],
    };
    // Handle both old and new Zod object structures
    let shape;
    if (typeof def.shape === 'function') {
        shape = def.shape();
    }
    else if (def.shape && typeof def.shape === 'object') {
        shape = def.shape;
    }
    else {
        logger.warn('Could not extract shape from Zod object', 'Conversion');
        return { type: 'object', additionalProperties: true };
    }
    for (const [key, value] of Object.entries(shape)) {
        const zodType = value;
        // Handle the nested structure properly
        let typeDef;
        if (zodType._def) {
            typeDef = zodType._def;
        }
        else if (zodType.def) {
            typeDef = zodType.def;
        }
        else {
            typeDef = zodType;
        }
        schema.properties[key] = convertZodType(typeDef, options);
        // Check if field is required (not optional and no default)
        const typeStr = typeDef.typeName || typeDef.type;
        if (typeStr !== 'optional' &&
            typeStr !== 'ZodOptional' &&
            typeStr !== 'default' &&
            typeStr !== 'ZodDefault') {
            schema.required.push(key);
        }
    }
    // Remove required array if empty
    if (schema.required.length === 0) {
        delete schema.required;
    }
    return schema;
}
// Convert ZodArray
function convertZodArray(def, options) {
    const schema = {
        type: 'array',
        items: def.type && def.type._def ? convertZodType(def.type._def, options) : { type: 'string' },
    };
    // Handle array length constraints
    if (def.minLength !== null && def.minLength !== undefined) {
        schema.minLength = typeof def.minLength === 'object' ? def.minLength.value : def.minLength;
    }
    if (def.maxLength !== null && def.maxLength !== undefined) {
        schema.maxLength = typeof def.maxLength === 'object' ? def.maxLength.value : def.maxLength;
    }
    if (options.includeExamples && schema.items) {
        schema.example = [schema.items.example || 'item'];
    }
    return schema;
}
// Convert ZodEnum
function convertZodEnum(def, options) {
    const schema = {
        type: 'string',
        enum: def.values || [],
    };
    if (options.includeExamples && def.values && Array.isArray(def.values) && def.values.length > 0) {
        schema.example = def.values[0];
    }
    return schema;
}
// Convert ZodOptional
function convertZodOptional(def, options) {
    return convertZodType(def.innerType._def, options);
}
// Convert ZodDefault
function convertZodDefault(def, options) {
    const schema = convertZodType(def.innerType._def, options);
    // Handle both function and property forms of defaultValue
    if (typeof def.defaultValue === 'function') {
        try {
            schema.default = def.defaultValue();
        }
        catch (error) {
            logger.warn('Failed to get default value from function', 'Conversion', {
                error,
            });
            schema.default = undefined;
        }
    }
    else if (def.defaultValue !== undefined) {
        schema.default = def.defaultValue;
    }
    else {
        logger.warn('No default value found in ZodDefault', 'Conversion');
        schema.default = undefined;
    }
    return schema;
}
// Convert ZodUnion
function convertZodUnion(def, options) {
    const schemas = def.options.map((option) => convertZodType(option._def, options));
    return {
        oneOf: schemas,
    };
}
// Convert ZodLiteral
function convertZodLiteral(def, options) {
    const value = def.value;
    return {
        type: typeof value,
        enum: [value],
        example: options.includeExamples ? value : undefined,
    };
}
// Helper functions
function isOptionalType(type) {
    return type._def.typeName === 'ZodOptional';
}
function hasDefault(type) {
    return type._def.typeName === 'ZodDefault';
}
// Generate example data from Zod schema
function generateExampleFromSchema(schema) {
    try {
        return generateExample(schema._def);
    }
    catch (error) {
        logger.warn('Failed to generate example from schema', 'ExampleGeneration', {
            error: error instanceof Error ? error.message : String(error),
        });
        return {};
    }
}
function generateExample(def) {
    const typeName = def.typeName;
    switch (typeName) {
        case 'ZodString':
            if (def.checks) {
                for (const check of def.checks) {
                    if (check.kind === 'email')
                        return 'user@example.com';
                    if (check.kind === 'uuid')
                        return '123e4567-e89b-12d3-a456-426614174000';
                    if (check.kind === 'url')
                        return 'https://example.com';
                    if (check.kind === 'datetime')
                        return '2023-12-01T10:00:00Z';
                }
            }
            return 'string';
        case 'ZodNumber':
            return 42;
        case 'ZodBoolean':
            return true;
        case 'ZodObject': {
            const example = {};
            let shape;
            try {
                if (typeof def.shape === 'function') {
                    shape = def.shape();
                }
                else if (def.shape && typeof def.shape === 'object') {
                    shape = def.shape;
                }
                else {
                    return {};
                }
                for (const [key, value] of Object.entries(shape)) {
                    const zodType = value;
                    if (!isOptionalType(zodType)) {
                        example[key] = generateExample(zodType._def);
                    }
                }
            }
            catch (error) {
                logger.warn('Failed to generate object example', 'ExampleGeneration', {
                    error,
                });
                return {};
            }
            return example;
        }
        case 'ZodArray':
            if (def.type && def.type._def) {
                const itemExample = generateExample(def.type._def);
                return [itemExample];
            }
            return ['item'];
        case 'ZodEnum':
            return def.values && Array.isArray(def.values) && def.values.length > 0
                ? def.values[0]
                : 'enum-value';
        case 'ZodOptional':
            return generateExample(def.innerType._def);
        case 'ZodDefault':
            // Handle both function and property forms of defaultValue
            if (typeof def.defaultValue === 'function') {
                try {
                    return def.defaultValue();
                }
                catch (error) {
                    logger.warn('Failed to get default value from function in example generation', 'ExampleGeneration', { error });
                    return null;
                }
            }
            else if (def.defaultValue !== undefined) {
                return def.defaultValue;
            }
            else {
                return null;
            }
        case 'ZodUnion':
            return generateExample(def.options[0]._def);
        case 'ZodLiteral':
            return def.value;
        default:
            return null;
    }
}
