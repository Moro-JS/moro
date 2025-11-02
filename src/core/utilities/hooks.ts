// Hook System for Moro
import { EventEmitter } from 'events';
import { HookFunction, HookContext } from '../../types/hooks.js';
import { createFrameworkLogger } from '../logger/index.js';

export const HOOK_EVENTS = {
  BEFORE_REQUEST: 'before:request',
  AFTER_REQUEST: 'after:request',
  BEFORE_RESPONSE: 'before:response',
  AFTER_RESPONSE: 'after:response',
  ERROR: 'error',
} as const;

export class HookManager extends EventEmitter {
  private hooks = new Map<string, HookFunction[]>();
  private beforeHooks = new Map<string, HookFunction[]>();
  private afterHooks = new Map<string, HookFunction[]>();
  private logger = createFrameworkLogger('Hooks');

  // Cached execute functions
  // When no hooks are registered, replace execute() with noop
  private executeCache = new Map<string, (context: HookContext) => Promise<HookContext>>();

  // Track if hooks are synchronous to avoid Promise overhead
  private hookSyncStatus = new Map<string, boolean>();

  constructor() {
    super();
    // Initialize hook arrays
    const hookEventValues = Object.values(HOOK_EVENTS);
    const hookEventLen = hookEventValues.length;
    for (let i = 0; i < hookEventLen; i++) {
      const event = hookEventValues[i];
      this.hooks.set(event, []);
      this.beforeHooks.set(event, []);
      this.afterHooks.set(event, []);
      // Initialize with noop functions
      this.updateExecuteCache(event);
    }
  }

  // Update cached execute function for an event
  private updateExecuteCache(event: string): void {
    const beforeHooks = this.beforeHooks.get(event) || [];
    const hooks = this.hooks.get(event) || [];
    const afterHooks = this.afterHooks.get(event) || [];

    // If no hooks registered, use noop for zero overhead
    if (beforeHooks.length === 0 && hooks.length === 0 && afterHooks.length === 0) {
      this.executeCache.set(event, async (context: HookContext) => context);
      this.hookSyncStatus.set(event, true); // Mark as sync (noop)
      return;
    }

    // Detect if all hooks are synchronous
    const allSync = this.areHooksSynchronous(beforeHooks, hooks, afterHooks);
    this.hookSyncStatus.set(event, allSync);

    if (allSync) {
      // FAST PATH: Create synchronous version (no Promise overhead)
      // Cast to Promise return type to satisfy interface
      this.executeCache.set(event, ((context: HookContext) => {
        // Execute before hooks synchronously
        const beforeLen = beforeHooks.length;
        for (let i = 0; i < beforeLen; i++) {
          try {
            beforeHooks[i](context);
          } catch (error) {
            this.logger.error('Hook execution error', 'HookExecution', {
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        }

        // Execute main hooks synchronously
        const hooksLen = hooks.length;
        for (let i = 0; i < hooksLen; i++) {
          try {
            hooks[i](context);
          } catch (error) {
            this.logger.error('Hook execution error', 'HookExecution', {
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        }

        // Execute after hooks synchronously
        const afterLen = afterHooks.length;
        for (let i = 0; i < afterLen; i++) {
          try {
            afterHooks[i](context);
          } catch (error) {
            this.logger.error('Hook execution error', 'HookExecution', {
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        }

        // Emit event for listeners
        this.emit(event, context);

        return context as any; // Cast to satisfy Promise return
      }) as any);
    } else {
      // SLOW PATH: Use async version only when needed
      this.executeCache.set(event, async (context: HookContext) => {
        // Execute before hooks
        const beforeLen = beforeHooks.length;
        for (let i = 0; i < beforeLen; i++) {
          await this.executeHook(beforeHooks[i], context);
        }

        // Execute main hooks
        const hooksLen = hooks.length;
        for (let i = 0; i < hooksLen; i++) {
          await this.executeHook(hooks[i], context);
        }

        // Execute after hooks
        const afterLen = afterHooks.length;
        for (let i = 0; i < afterLen; i++) {
          await this.executeHook(afterHooks[i], context);
        }

        // Emit event for listeners
        this.emit(event, context);

        return context;
      });
    }
  }

  // Detect if hooks are synchronous by checking function signatures
  private areHooksSynchronous(...hookArrays: HookFunction[][]): boolean {
    for (const hooks of hookArrays) {
      for (const hook of hooks) {
        // Check if function is async or returns a Promise
        if (hook.constructor.name === 'AsyncFunction') {
          return false;
        }
        // Additional heuristic: check if function name suggests async
        if (hook.name && (hook.name.includes('async') || hook.name.includes('Async'))) {
          return false;
        }
      }
    }
    return true; // Assume synchronous by default
  }

  // Register a hook for a specific event
  hook(event: string, fn: HookFunction): this {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.hooks.get(event)!.push(fn);
    this.updateExecuteCache(event); // Update cache
    return this;
  }

  // Register a before hook
  before(event: string, fn: HookFunction): this {
    if (!this.beforeHooks.has(event)) {
      this.beforeHooks.set(event, []);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.beforeHooks.get(event)!.push(fn);
    this.updateExecuteCache(event); // Update cache
    return this;
  }

  // Register an after hook
  after(event: string, fn: HookFunction): this {
    if (!this.afterHooks.has(event)) {
      this.afterHooks.set(event, []);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.afterHooks.get(event)!.push(fn);
    this.updateExecuteCache(event); // Update cache
    return this;
  }

  // Execute hooks for an event - optimized with cached functions
  async execute(event: string, context: HookContext = {}): Promise<HookContext> {
    const executeFn = this.executeCache.get(event);
    if (executeFn) {
      return executeFn(context);
    }

    // Fallback for events not in cache (shouldn't happen in normal operation)
    this.updateExecuteCache(event);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.executeCache.get(event)!(context);
  }

  // Execute a single hook with error handling
  private async executeHook(hook: HookFunction, context: HookContext): Promise<void> {
    try {
      await hook(context);
    } catch (error) {
      this.logger.error('Hook execution error', 'HookExecution', {
        error: error instanceof Error ? error.message : String(error),
        context: context.request?.method || 'unknown',
      });
      throw error;
    }
  }

  // Remove hooks
  removeHook(event: string, fn?: HookFunction): this {
    if (!fn) {
      this.hooks.delete(event);
      this.beforeHooks.delete(event);
      this.afterHooks.delete(event);
    } else {
      const maps = [this.hooks, this.beforeHooks, this.afterHooks];
      const mapsLen = maps.length;
      for (let i = 0; i < mapsLen; i++) {
        const map = maps[i];
        const hooks = map.get(event);
        if (hooks) {
          const index = hooks.indexOf(fn);
          if (index !== -1) {
            hooks.splice(index, 1);
          }
        }
      }
    }
    this.updateExecuteCache(event); // Update cache
    return this;
  }

  // Get all registered hooks for debugging
  getHooks(event?: string): Record<string, any> {
    if (event) {
      return {
        before: this.beforeHooks.get(event) || [],
        main: this.hooks.get(event) || [],
        after: this.afterHooks.get(event) || [],
      };
    }

    const allHooks: Record<string, any> = {};
    const allEvents = new Set([
      ...this.hooks.keys(),
      ...this.beforeHooks.keys(),
      ...this.afterHooks.keys(),
    ]);

    allEvents.forEach(event => {
      allHooks[event] = this.getHooks(event);
    });

    return allHooks;
  }
}

// Built-in middleware - now organized in individual files
export { simpleMiddleware as middleware } from '../middleware/index.js';
