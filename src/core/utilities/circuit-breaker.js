"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = void 0;
// src/core/circuit-breaker.ts
class CircuitBreaker {
    options;
    failures = 0;
    lastFailTime = 0;
    state = "CLOSED";
    constructor(options) {
        this.options = options;
    }
    async execute(fn) {
        if (this.state === "OPEN") {
            if (Date.now() - this.lastFailTime < this.options.resetTimeout) {
                throw new Error("Circuit breaker is OPEN");
            }
            this.state = "HALF_OPEN";
        }
        try {
            const result = await fn();
            this.onSuccess();
            return result;
        }
        catch (error) {
            this.onFailure();
            throw error;
        }
    }
    onSuccess() {
        this.failures = 0;
        this.state = "CLOSED";
    }
    onFailure() {
        this.failures++;
        this.lastFailTime = Date.now();
        if (this.failures >= this.options.failureThreshold) {
            this.state = "OPEN";
        }
    }
}
exports.CircuitBreaker = CircuitBreaker;
