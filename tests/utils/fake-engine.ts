// @ts-nocheck
// A FAKE @morojs/engine module implementing the native API contract (engine
// repo docs/API.md) in memory, for unit-testing MoroEngineServer without a
// native binary. Records serve/respond/writeHead/write/end (and the 1.1.6
// template calls) per reqId and drives the onRequest/onAborted/onWritable
// callbacks. `capabilities` selects what probe() advertises, so the same
// scenario can run against a "1.1.x" engine (no templates) and a "1.1.6"
// engine (templates) and its recorded ops compared; `omitFunctions` removes
// exports so the adapter's flag-AND-function guard is testable.

export const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'OTHER'];

/** Fold a flat [k1,v1,k2,v2,...] header array into { key: [values...] } */
export function foldFlat(flat: string[] | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!flat) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    (out[flat[i]] ??= []).push(flat[i + 1]);
  }
  return out;
}

export interface FakeEngineOptions {
  /** probe().capabilities; absent = an engine that advertises none */
  capabilities?: Record<string, boolean>;
  /** Native exports to leave out (simulates a flag/binary mismatch) */
  omitFunctions?: string[];
}

export function createFakeEngine(options: FakeEngineOptions = {}) {
  const requests = new Map<number, any>();
  let callbacks: any = null;
  let serveOptions: any = null;
  let nextReqId = 1;
  let nextServerId = 42;
  const listens: any[] = [];
  let closed = false;
  // Prepared templates per serverId: id -> { status, headersFlat }
  const templates = new Map<
    number,
    Map<number, { status: number; headersFlat: string[] | null }>
  >();
  const prepareCalls: Array<{ serverId: number; status: number; headersFlat: string[] | null }> =
    [];
  // Engine-answered static routes per serverId (setStaticRoute), plus every
  // registration in order - the adapter's re-registration after close() +
  // listen() is asserted on this list.
  const staticRoutes = new Map<
    number,
    Array<{ method: number; path: string; status: number; headersFlat: string[] | null; body: any }>
  >();
  const staticCalls: Array<{
    serverId: number;
    method: number;
    path: string;
    status: number;
    headersFlat: string[] | null;
    body: any;
  }> = [];
  let currentServerId = 0;
  // Batched dispatch buffers (getBatchBuffers): one set per fake, like the
  // engine's per-server buffers. A request dispatched as a batch slot carries
  // { slot, count } so a synchronous completion advances the control cell
  // exactly as the engine does (next slot activated; count when it was the
  // last one).
  const batch = {
    descriptors: new Uint32Array(3 * 16),
    control: new Uint32Array(1),
    paths: [] as string[],
  };
  const batchCalls: number[] = [];
  const advance = (r: any) => {
    if (r.batch === undefined) return;
    const { slot, count } = r.batch;
    r.batch = undefined;
    batch.control[0] = slot + 1 >= count ? count : slot + 1;
  };

  // reqIds are safe no-ops after terminal/abort - the fake enforces that
  const live = (reqId: number) => {
    const r = requests.get(reqId);
    return r && !r.terminal && !r.aborted ? r : undefined;
  };

  const engine: any = {
    serve(cbs: any, options: any) {
      callbacks = cbs;
      serveOptions = options;
      currentServerId = nextServerId++;
      templates.set(currentServerId, new Map());
      return currentServerId;
    },
    listen(serverId: number, host: string, port: number) {
      listens.push({ serverId, host, port });
      return port === 0 ? 54321 : port;
    },
    close(serverId: number) {
      closed = true;
      templates.delete(serverId); // ids die with the native server
      staticRoutes.delete(serverId); // and so do its static routes
    },
    stopListening(_serverId: number) {
      // graceful-drain phase; the fake has nothing to drain
    },
    getMethod(reqId: number) {
      return live(reqId)?.methodStr;
    },
    getQuery(reqId: number) {
      return live(reqId)?.query;
    },
    getHeaders(reqId: number) {
      return live(reqId)?.headersFlat.slice();
    },
    getHeader(reqId: number, name: string) {
      const r = live(reqId);
      if (!r) return undefined;
      for (let i = 0; i + 1 < r.headersFlat.length; i += 2) {
        if (r.headersFlat[i] === name) return r.headersFlat[i + 1];
      }
      return undefined;
    },
    getBody(reqId: number) {
      const r = live(reqId);
      if (!r || !r.body) return null;
      const copy = new ArrayBuffer(r.body.length);
      new Uint8Array(copy).set(r.body);
      return copy;
    },
    getRemoteAddress(reqId: number) {
      return live(reqId)?.remoteAddress;
    },
    respond(reqId: number, status: number, headersFlat: string[] | null, body: any) {
      const r = live(reqId);
      if (!r) return;
      r.ops.push({ type: 'respond', status, headersFlat, body });
      r.terminal = true;
      advance(r);
    },
    writeHead(reqId: number, status: number, headersFlat: string[] | null) {
      const r = live(reqId);
      if (!r) return;
      r.ops.push({ type: 'writeHead', status, headersFlat });
    },
    write(reqId: number, chunk: any) {
      const r = live(reqId);
      if (!r) return false;
      r.ops.push({ type: 'write', chunk });
      return !r.backpressure;
    },
    getBatchBuffers(_serverId: number) {
      return batch;
    },
    getPath(reqId: number) {
      return requests.get(reqId)?.path ?? '';
    },
    end(reqId: number, chunk?: any) {
      const r = live(reqId);
      if (!r) return;
      r.ops.push({ type: 'end', chunk });
      r.terminal = true;
      advance(r);
    },
    isAborted(reqId: number) {
      return requests.get(reqId)?.aborted ?? false;
    },

    // ---- 1.1.6: prepared response templates ----
    prepareResponse(serverId: number, status: number, headersFlat: string[] | null) {
      const store = templates.get(serverId);
      if (!store) throw new Error('invalid serverId');
      if (store.size >= 4096) throw new RangeError('template store full');
      const id = store.size + 1;
      store.set(id, { status, headersFlat: headersFlat ? headersFlat.slice() : null });
      prepareCalls.push({ serverId, status, headersFlat });
      return id;
    },
    releaseTemplates(serverId: number) {
      templates.get(serverId)?.clear();
    },
    // Recorded as a 'respond' op carrying the template's status/headers, so
    // assertions written against the respond() path apply unchanged; the
    // viaTemplate flag says which native call actually ran.
    respondPrepared(reqId: number, tplId: number, body: any) {
      const r = live(reqId);
      if (!r) return;
      const t = templates.get(currentServerId)?.get(tplId);
      if (!t) {
        r.ops.push({
          type: 'respond',
          status: 500,
          headersFlat: null,
          body: null,
          viaTemplate: true,
          invalidTemplate: tplId,
        });
      } else {
        r.ops.push({
          type: 'respond',
          status: t.status,
          headersFlat: t.headersFlat ? t.headersFlat.slice() : null,
          body,
          viaTemplate: true,
        });
      }
      r.terminal = true;
      advance(r);
    },
    respondPreparedEmpty(reqId: number, tplId: number) {
      engine.respondPrepared(reqId, tplId, null);
    },
    writeHeadPrepared(reqId: number, tplId: number) {
      const r = live(reqId);
      if (!r) return;
      const t = templates.get(currentServerId)?.get(tplId);
      r.ops.push({
        type: 'writeHead',
        status: t ? t.status : 500,
        headersFlat: t?.headersFlat ?? null,
        viaTemplate: true,
      });
    },
    endWith(reqId: number, chunk: any) {
      const r = live(reqId);
      if (!r) return;
      r.ops.push({ type: 'end', chunk, viaEndWith: true });
      r.terminal = true;
      advance(r);
    },

    setStaticRoute(
      serverId: number,
      method: number,
      path: string,
      status = 200,
      headersFlat: string[] | null = null,
      body: any = null
    ) {
      const list = staticRoutes.get(serverId) ?? [];
      const entry = { method, path, status, headersFlat, body };
      const at = list.findIndex(r => r.method === method && r.path === path);
      if (at === -1) list.push(entry);
      else list[at] = entry;
      staticRoutes.set(serverId, list);
      staticCalls.push({ serverId, ...entry });
    },
    clearStaticRoutes(serverId: number) {
      staticRoutes.delete(serverId);
    },

    probe() {
      return {
        ok: true,
        version: 'fake',
        abi: process.versions.modules,
        ...(options.capabilities ? { capabilities: { ...options.capabilities } } : {}),
      };
    },
    version: 'fake',

    // ---- test drivers ----
    requests,
    prepareCalls,
    staticCalls,
    staticRoutes,
    batchCalls,
    batch,
    templates,
    get serveOptions() {
      return serveOptions;
    },
    get listens() {
      return listens;
    },
    get closed() {
      return closed;
    },
    get callbacks() {
      return callbacks;
    },
    simulate(options: any = {}) {
      const method = (options.method || 'GET').toUpperCase();
      let methodIdx = METHODS.indexOf(method);
      if (methodIdx === -1) methodIdx = 7;
      const headersFlat: string[] = [];
      for (const [k, v] of Object.entries(options.headers || {})) {
        headersFlat.push(k.toLowerCase(), String(v));
      }
      if (Array.isArray(options.rawHeaders)) {
        for (const h of options.rawHeaders) headersFlat.push(String(h));
      }
      const reqId = nextReqId++;
      requests.set(reqId, {
        methodStr: method,
        path: options.path || '/',
        query: options.query || '',
        headersFlat,
        body: options.body
          ? Buffer.isBuffer(options.body)
            ? options.body
            : Buffer.from(options.body)
          : null,
        remoteAddress: options.remoteAddress || '127.0.0.1',
        aborted: false,
        terminal: false,
        backpressure: !!options.backpressure,
        ops: [],
      });
      // A registered (method, path) is answered by the engine itself: the
      // reply is recorded as one 'static' op and onRequest never fires.
      const fixed = staticRoutes
        .get(currentServerId)
        ?.find(r => r.method === methodIdx && r.path === (options.path || '/'));
      if (fixed) {
        const r = requests.get(reqId);
        r.ops.push({
          type: 'static',
          status: fixed.status,
          headersFlat: fixed.headersFlat,
          body: fixed.body,
        });
        r.terminal = true;
        return reqId;
      }
      callbacks.onRequest(reqId, methodIdx, options.path || '/');
      return reqId;
    },
    abort(reqId: number) {
      const r = requests.get(reqId);
      if (r) r.aborted = true;
      callbacks.onAborted(reqId);
    },
    // Deliver `list` (simulate() option objects) as ONE onRequestBatch call,
    // the way the engine surfaces pipelined requests: descriptors filled,
    // control at 0, paths interned (a path marked `uncacheable: true` gets
    // pathIdx 0xFFFFFFFF so the adapter must ask getPath()). Returns the
    // reqIds and the number of slots the adapter consumed.
    simulateBatch(list: any[]) {
      if (!callbacks.onRequestBatch) throw new Error('onRequestBatch not registered');
      const count = list.length;
      const reqIds: number[] = [];
      list.forEach((options, slot) => {
        const method = (options.method || 'GET').toUpperCase();
        let methodIdx = METHODS.indexOf(method);
        if (methodIdx === -1) methodIdx = 7;
        const headersFlat: string[] = [];
        for (const [k, v] of Object.entries(options.headers || {})) {
          headersFlat.push(k.toLowerCase(), String(v));
        }
        const reqId = nextReqId++;
        const path = options.path || '/';
        requests.set(reqId, {
          methodStr: method,
          path,
          query: options.query || '',
          headersFlat,
          body: options.body ? Buffer.from(options.body) : null,
          remoteAddress: options.remoteAddress || '127.0.0.1',
          aborted: false,
          terminal: false,
          backpressure: !!options.backpressure,
          ops: [],
          batch: { slot, count },
        });
        reqIds.push(reqId);
        let pathIdx = 0xffffffff;
        if (!options.uncacheable) {
          pathIdx = batch.paths.indexOf(path);
          if (pathIdx === -1) {
            pathIdx = batch.paths.length;
            batch.paths.push(path);
          }
        }
        batch.descriptors[3 * slot] = reqId;
        batch.descriptors[3 * slot + 1] = methodIdx;
        batch.descriptors[3 * slot + 2] = pathIdx;
      });
      batch.control[0] = 0;
      batchCalls.push(count);
      const consumed = callbacks.onRequestBatch(count);
      return { reqIds, consumed };
    },
    drain(reqId: number) {
      const r = requests.get(reqId);
      if (r) r.backpressure = false;
      callbacks.onWritable(reqId);
    },
  };

  for (const name of options.omitFunctions ?? []) delete engine[name];
  return engine;
}

/** Strip the fake's bookkeeping flags so two op lists can be compared for
 *  what reached the wire: type, status, headers, body/chunk. */
export function wireOps(ops: any[]): any[] {
  return ops.map(({ viaTemplate, viaEndWith, invalidTemplate, ...rest }) => rest);
}
