"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketManager = void 0;
const utilities_1 = require("../utilities");
class WebSocketManager {
    io;
    container;
    circuitBreakers = new Map();
    rateLimiters = new Map();
    compressionEnabled = true;
    customIdGenerator;
    constructor(io, container) {
        this.io = io;
        this.container = container;
        this.setupAdvancedFeatures();
    }
    setupAdvancedFeatures() {
        // Enable compression for WebSocket messages
        if (this.compressionEnabled) {
            this.io.engine.compression = true;
            this.io.engine.perMessageDeflate = {
                threshold: 1024,
                concurrencyLimit: 10,
                memLevel: 8,
            };
        }
        // Custom session ID generation if provided
        if (this.customIdGenerator) {
            this.io.engine.generateId = this.customIdGenerator;
        }
        // Global WebSocket middleware for advanced features
        this.io.use((socket, next) => {
            // Add binary message handling
            socket.onAny((event, ...args) => {
                // Handle binary frames efficiently
                args.forEach((arg, index) => {
                    if (Buffer.isBuffer(arg)) {
                        // Process binary data with optimizations
                        args[index] = this.processBinaryData(arg);
                    }
                });
            });
            // Add compression per message
            socket.compressedEmit = (event, data) => {
                if (this.compressionEnabled && this.shouldCompress(data)) {
                    socket.compress(true).emit(event, data);
                }
                else {
                    socket.emit(event, data);
                }
            };
            // Add heartbeat mechanism
            socket.heartbeat = () => {
                socket.emit("heartbeat", { timestamp: Date.now() });
            };
            next();
        });
    }
    setCustomIdGenerator(generator) {
        this.customIdGenerator = generator;
        this.io.engine.generateId = generator;
    }
    enableCompression(options) {
        this.compressionEnabled = true;
        if (options) {
            this.io.engine.perMessageDeflate = {
                threshold: options.threshold || 1024,
                concurrencyLimit: options.concurrencyLimit || 10,
                memLevel: options.memLevel || 8,
            };
        }
    }
    processBinaryData(buffer) {
        // Optimize binary data processing
        // Could add compression, validation, etc.
        return buffer;
    }
    shouldCompress(data) {
        // Determine if data should be compressed
        const serialized = JSON.stringify(data);
        return serialized.length > 1024; // Compress if larger than 1KB
    }
    async registerHandler(namespace, wsConfig, moduleConfig) {
        namespace.on("connection", (socket) => {
            console.log(`WebSocket connected to /${moduleConfig.name}: ${socket.id}`);
            this.setupSocketHandlers(socket, wsConfig, moduleConfig);
            this.setupSocketMiddleware(socket, moduleConfig.name);
        });
    }
    setupSocketHandlers(socket, wsConfig, moduleConfig) {
        socket.on(wsConfig.event, async (data, callback) => {
            const handlerKey = `${moduleConfig.name}.${wsConfig.handler}`;
            try {
                // Rate limiting
                if (wsConfig.rateLimit &&
                    !this.checkRateLimit(socket.id, handlerKey, wsConfig.rateLimit)) {
                    const error = {
                        success: false,
                        error: "Rate limit exceeded",
                        code: "RATE_LIMIT",
                    };
                    if (callback)
                        callback(error);
                    else
                        socket.emit("error", error);
                    return;
                }
                // Validation (Zod-only)
                if (wsConfig.validation) {
                    try {
                        data = wsConfig.validation.parse(data);
                    }
                    catch (validationError) {
                        if (validationError.issues) {
                            const error = {
                                success: false,
                                error: "Validation failed",
                                details: validationError.issues.map((issue) => ({
                                    field: issue.path.length > 0 ? issue.path.join(".") : "data",
                                    message: issue.message,
                                    code: issue.code,
                                })),
                            };
                            if (callback)
                                callback(error);
                            else
                                socket.emit("error", error);
                            return;
                        }
                        throw validationError;
                    }
                }
                // Circuit breaker protection
                const circuitBreaker = this.getCircuitBreaker(handlerKey);
                const result = await circuitBreaker.execute(async () => {
                    const controller = this.container.resolve(moduleConfig.name);
                    return await controller[wsConfig.handler](socket, data);
                });
                // Handle response
                if (callback) {
                    callback({ success: true, data: result });
                }
                else if (wsConfig.broadcast && result?.event) {
                    socket.broadcast.emit(result.event, result.data);
                }
                else if (result) {
                    socket.emit(`${wsConfig.event}:response`, result);
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const errorCode = error?.code || "INTERNAL_ERROR";
                console.error(`WebSocket error in ${handlerKey}:`, errorMessage);
                const errorResponse = {
                    success: false,
                    error: errorMessage,
                    code: errorCode,
                };
                if (callback) {
                    callback(errorResponse);
                }
                else {
                    socket.emit("error", errorResponse);
                }
            }
        });
    }
    setupSocketMiddleware(socket, moduleName) {
        socket.on("disconnect", (reason) => {
            console.log(`WebSocket disconnected from /${moduleName}: ${socket.id} (${reason})`);
            this.cleanup(socket.id);
        });
        socket.on("ping", () => {
            socket.emit("pong");
        });
    }
    checkRateLimit(socketId, handlerKey, rateLimit) {
        if (!this.rateLimiters.has(handlerKey)) {
            this.rateLimiters.set(handlerKey, new Map());
        }
        const handlerLimiter = this.rateLimiters.get(handlerKey);
        const now = Date.now();
        const socketLimit = handlerLimiter.get(socketId);
        if (!socketLimit || now > socketLimit.resetTime) {
            handlerLimiter.set(socketId, {
                count: 1,
                resetTime: now + rateLimit.window,
            });
            return true;
        }
        if (socketLimit.count >= rateLimit.requests) {
            return false;
        }
        socketLimit.count++;
        return true;
    }
    getCircuitBreaker(key) {
        if (!this.circuitBreakers.has(key)) {
            this.circuitBreakers.set(key, new utilities_1.CircuitBreaker({
                failureThreshold: 5,
                resetTimeout: 30000,
                monitoringPeriod: 10000,
            }));
        }
        return this.circuitBreakers.get(key);
    }
    cleanup(socketId) {
        this.rateLimiters.forEach((limiter) => {
            limiter.delete(socketId);
        });
    }
}
exports.WebSocketManager = WebSocketManager;
