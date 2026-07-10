// Minimal Node-compatible event emitter with lazy listener storage: nothing
// allocates until the first listener is added, so request/response objects on
// the plain JSON fast path pay a single null field for the capability.
// Backs req.on('close') (SSE/monitor cleanup) and the response lifecycle
// events ('finish'/'close'/'drain') that stream-oriented middleware needs.
//
// Shared, transport-neutral: used by both the uWS adapter (uws-http-server.ts)
// and the Moro engine adapter (moro-engine-server.ts).
export class LazyEventEmitter {
  _events: Record<string, Array<(...args: any[]) => void>> | null = null;

  on(event: string, listener: (...args: any[]) => void): this {
    const events = (this._events ??= {});
    (events[event] ??= []).push(listener);
    return this;
  }

  addListener(event: string, listener: (...args: any[]) => void): this {
    return this.on(event, listener);
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const wrapper = (...args: any[]) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    (wrapper as any)._original = listener;
    return this.on(event, wrapper);
  }

  emit(event: string, ...args: any[]): boolean {
    const listeners = this._events?.[event];
    if (!listeners || listeners.length === 0) {
      // Node EventEmitter contract: an unhandled 'error' event throws instead
      // of vanishing - code relying on that backstop must not silently no-op.
      if (event === 'error') {
        throw args[0] instanceof Error
          ? args[0]
          : new Error(`Unhandled 'error' event: ${String(args[0])}`);
      }
      return false;
    }
    // Copy so listeners removing themselves (once) don't skip siblings
    for (const listener of listeners.slice()) listener(...args);
    return true;
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    const listeners = this._events?.[event];
    if (listeners) {
      const index = listeners.findIndex(l => l === listener || (l as any)._original === listener);
      if (index !== -1) listeners.splice(index, 1);
    }
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    return this.removeListener(event, listener);
  }

  removeAllListeners(event?: string): this {
    if (this._events) {
      if (event) delete this._events[event];
      else this._events = null;
    }
    return this;
  }

  listenerCount(event: string): number {
    return this._events?.[event]?.length ?? 0;
  }
}
