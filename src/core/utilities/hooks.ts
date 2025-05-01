// Hook System for Moro
import { EventEmitter } from "events";
import { HookFunction, HookContext, MoroMiddleware } from "../../types/hooks";
import { createFrameworkLogger } from "../logger";

export const HOOK_EVENTS = {
  BEFORE_REQUEST: "before:request",
  AFTER_REQUEST: "after:request",
  BEFORE_RESPONSE: "before:response",
  AFTER_RESPONSE: "after:response",
  ERROR: "error",
} as const;

export class HookManager extends EventEmitter {
  private hooks = new Map<string, HookFunction[]>();
  private beforeHooks = new Map<string, HookFunction[]>();
  private afterHooks = new Map<string, HookFunction[]>();
  private logger = createFrameworkLogger("Hooks");

  constructor() {
    super();
    // Initialize hook arrays
    Object.values(HOOK_EVENTS).forEach((event) => {
      this.hooks.set(event, []);
      this.beforeHooks.set(event, []);
      this.afterHooks.set(event, []);
    });
  }

  // Register a hook for a specific event
  hook(event: string, fn: HookFunction): this {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    this.hooks.get(event)!.push(fn);
    return this;
  }

  // Register a before hook
  before(event: string, fn: HookFunction): this {
    if (!this.beforeHooks.has(event)) {
      this.beforeHooks.set(event, []);
    }
    this.beforeHooks.get(event)!.push(fn);
    return this;
  }

  // Register an after hook
  after(event: string, fn: HookFunction): this {
    if (!this.afterHooks.has(event)) {
      this.afterHooks.set(event, []);
    }
    this.afterHooks.get(event)!.push(fn);
    return this;
  }

  // Execute hooks for an event
  async execute(
    event: string,
    context: HookContext = {},
  ): Promise<HookContext> {
    // Execute before hooks
    const beforeHooks = this.beforeHooks.get(event) || [];
    for (const hook of beforeHooks) {
      await this.executeHook(hook, context);
    }

    // Execute main hooks
    const hooks = this.hooks.get(event) || [];
    for (const hook of hooks) {
      await this.executeHook(hook, context);
    }

    // Execute after hooks
    const afterHooks = this.afterHooks.get(event) || [];
    for (const hook of afterHooks) {
      await this.executeHook(hook, context);
    }

    // Emit event for listeners
    this.emit(event, context);

    return context;
  }

  // Execute a single hook with error handling
  private async executeHook(
    hook: HookFunction,
    context: HookContext,
  ): Promise<void> {
    try {
      await hook(context);
    } catch (error) {
      this.logger.error("Hook execution error", "HookExecution", {
        error: error instanceof Error ? error.message : String(error),
        context: context.request?.method || "unknown",
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
      [this.hooks, this.beforeHooks, this.afterHooks].forEach((map) => {
        const hooks = map.get(event);
        if (hooks) {
          const index = hooks.indexOf(fn);
          if (index !== -1) {
            hooks.splice(index, 1);
          }
        }
      });
    }
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

    allEvents.forEach((event) => {
      allHooks[event] = this.getHooks(event);
    });

    return allHooks;
  }
}

// Built-in middleware - now organized in individual files
export { simpleMiddleware as middleware } from "../middleware/index";
