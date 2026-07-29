import { describe, it, expect } from '@jest/globals';
import * as moro from '../../../src/index.js';

const { middleware, builtInMiddleware } = moro;

describe('Middleware namespace exports', () => {
  it('middleware is the built-in middleware namespace', () => {
    expect(typeof (middleware as any).helmet).toBe('function');
    expect(typeof (middleware as any).cors).toBe('function');
    expect(typeof (middleware as any).auth).toBe('function');
    expect(typeof (middleware as any).compression).toBe('function');
    expect(typeof (middleware as any).staticFiles).toBe('function');
  });

  it('builtInMiddleware is a deprecated alias of middleware', () => {
    expect(builtInMiddleware).toBe(middleware);
  });

  it('the observability middleware are proper built-in factories', () => {
    // Zero-config factories: called (no options needed) and return middleware
    const requestLogger = (middleware as any).requestLogger();
    expect(typeof requestLogger).toBe('function');
    expect(requestLogger.length).toBe(3);

    const performanceMonitor = (middleware as any).performanceMonitor();
    expect(typeof performanceMonitor).toBe('function');
    expect(performanceMonitor.length).toBe(3);

    // errorTracker produces the 4-arg (err, req, res, next) error-handler shape
    const errorTracker = (middleware as any).errorTracker();
    expect(typeof errorTracker).toBe('function');
    expect(errorTracker.length).toBe(4);
  });

  it('standardMiddleware and simpleMiddleware no longer exist', () => {
    expect((moro as any).standardMiddleware).toBeUndefined();
    expect((moro as any).simpleMiddleware).toBeUndefined();
  });

  it('built-in factories are branded for uncalled-factory detection', () => {
    const brand = Symbol.for('morojs.middleware-factory');
    expect(((middleware as any).helmet as any)[brand]).toBe(true);
    expect(((middleware as any).requestLogger as any)[brand]).toBe(true);
    // instances produced by factories are NOT branded — they are real middleware
    expect(((middleware as any).helmet() as any)[brand]).toBeUndefined();
  });
});
