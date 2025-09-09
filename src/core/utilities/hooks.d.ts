import { EventEmitter } from 'events';
import { HookFunction, HookContext } from '../../types/hooks';
export declare const HOOK_EVENTS: {
  readonly BEFORE_REQUEST: 'before:request';
  readonly AFTER_REQUEST: 'after:request';
  readonly BEFORE_RESPONSE: 'before:response';
  readonly AFTER_RESPONSE: 'after:response';
  readonly ERROR: 'error';
};
export declare class HookManager extends EventEmitter {
  private hooks;
  private beforeHooks;
  private afterHooks;
  private logger;
  constructor();
  hook(event: string, fn: HookFunction): this;
  before(event: string, fn: HookFunction): this;
  after(event: string, fn: HookFunction): this;
  execute(event: string, context?: HookContext): Promise<HookContext>;
  private executeHook;
  removeHook(event: string, fn?: HookFunction): this;
  getHooks(event?: string): Record<string, any>;
}
export { simpleMiddleware as middleware } from '../middleware/index';
