// @ts-nocheck
// Unit Tests - InflightRegistry: the id -> response registry of the engine
// adapter. It behaves as the Map it replaced; what it adds is that a removed
// value is referenced by nothing the registry keeps, however entries turn
// over - the property the Map lacked (its discarded tables kept the values
// that were live when each was replaced).
import { describe, it, expect } from '@jest/globals';
import { InflightRegistry } from '../../../src/core/http/utils/inflight-registry.js';

describe('InflightRegistry', () => {
  it('sets, gets, deletes and counts like a Map', () => {
    const r = new InflightRegistry<object>();
    const a = { n: 'a' };
    const b = { n: 'b' };
    expect(r.size).toBe(0);
    expect(r.get(1)).toBeUndefined();
    r.set(1, a);
    r.set(7, b);
    expect(r.size).toBe(2);
    expect(r.get(1)).toBe(a);
    expect(r.get(7)).toBe(b);
    expect(r.delete(1)).toBe(true);
    expect(r.delete(1)).toBe(false);
    expect(r.get(1)).toBeUndefined();
    expect(r.size).toBe(1);
    expect(r.take(7)).toBe(b);
    expect(r.take(7)).toBeUndefined();
    expect(r.size).toBe(0);
  });

  it('replaces the value of an id that is already registered', () => {
    const r = new InflightRegistry<string>();
    r.set(5, 'first');
    r.set(5, 'second');
    expect(r.size).toBe(1);
    expect(r.get(5)).toBe('second');
    expect(r.take(5)).toBe('second');
    expect(r.size).toBe(0);
  });

  it('reuses slots: storage follows the peak in flight, not the turnover', () => {
    const r = new InflightRegistry<object>();
    let id = 1;
    const live: number[] = [];
    for (let round = 0; round < 5000; round++) {
      // thirty in flight, each replaced in turn
      while (live.length < 30) {
        r.set(id, { id });
        live.push(id++);
      }
      const done = live.shift() as number;
      expect(r.get(done)).toEqual({ id: done });
      expect(r.delete(done)).toBe(true);
    }
    expect(r.size).toBe(29);
    expect((r as any).slots.length).toBeLessThanOrEqual(30);
    expect((r as any).free.length + r.size).toBe((r as any).slots.length);
  });

  it('keeps no reference to a value once it is removed', () => {
    const r = new InflightRegistry<object>();
    const values = Array.from({ length: 200 }, (_, i) => ({ i }));
    values.forEach((v, i) => r.set(i + 1, v));
    for (let i = 0; i < 200; i += 2) r.delete(i + 1);
    for (let i = 1; i < 200; i += 4) r.take(i + 1);
    const held = new Set((r as any).slots.filter((v: unknown) => v !== undefined));
    values.forEach((v, i) => {
      const stillRegistered = r.get(i + 1) === v;
      expect(held.has(v)).toBe(stillRegistered);
    });
    // The id index holds numbers only.
    for (const slot of (r as any).index.values()) expect(typeof slot).toBe('number');
  });

  it('clear() empties it and it is usable afterwards', () => {
    const r = new InflightRegistry<string>();
    r.set(1, 'a');
    r.set(2, 'b');
    r.clear();
    expect(r.size).toBe(0);
    expect(r.get(1)).toBeUndefined();
    r.set(3, 'c');
    expect(r.get(3)).toBe('c');
    expect(r.size).toBe(1);
  });

  it('agrees with a Map over a long random run', () => {
    const r = new InflightRegistry<number>();
    const m = new Map<number, number>();
    let seed = 12345;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let step = 0; step < 50000; step++) {
      const id = (next() % 300) + 1;
      const op = next() % 4;
      if (op === 0) {
        r.set(id, step);
        m.set(id, step);
      } else if (op === 1) {
        expect(r.delete(id)).toBe(m.delete(id));
      } else if (op === 2) {
        expect(r.take(id)).toBe(m.get(id));
        m.delete(id);
      } else {
        expect(r.get(id)).toBe(m.get(id));
      }
      expect(r.size).toBe(m.size);
    }
  });
});
