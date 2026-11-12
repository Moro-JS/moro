// In-flight responses by request id, for the events that arrive by id (a
// client abort, a drained socket).
//
// The obvious structure is a Map from id to response, and it is the wrong
// one for values that live a few milliseconds each. A Map's entries are
// appended to its table, never put back into a freed slot, so a map with a
// steady thirty entries and constant turnover fills its table with deleted
// entries every hundred or so insertions and replaces it. The old table
// still holds the entries that were live at that moment. The map itself is
// long-lived, so its tables are in the old generation, and the collector
// treats whatever an old-generation object points at as live when it
// collects the young one - including an old table nothing refers to any
// more. Every replaced table therefore dragged the thirty responses it last
// held, their requests and everything hanging off them, into the old
// generation, where only a full collection could free them: a quarter of all
// delayed requests, on a registry that never held more than a few dozen.
//
// Here the responses sit in an array whose slots are cleared on removal and
// reused, so nothing that dies ever points at one; the map from id to slot
// stays, and holds numbers.
export class InflightRegistry<T> {
  private slots: Array<T | undefined> = [];
  private free: number[] = [];
  private index = new Map<number, number>();

  /** Entries currently registered. */
  get size(): number {
    return this.index.size;
  }

  /** Register `value` under `id` (replacing whatever the id held). */
  set(id: number, value: T): void {
    const existing = this.index.get(id);
    if (existing !== undefined) {
      this.slots[existing] = value;
      return;
    }
    const free = this.free;
    const slot = free.length > 0 ? (free.pop() as number) : this.slots.length;
    this.slots[slot] = value;
    this.index.set(id, slot);
  }

  get(id: number): T | undefined {
    const slot = this.index.get(id);
    return slot === undefined ? undefined : this.slots[slot];
  }

  /** Remove the entry; true when there was one. */
  delete(id: number): boolean {
    const slot = this.index.get(id);
    if (slot === undefined) return false;
    this.index.delete(id);
    this.slots[slot] = undefined;
    this.free.push(slot);
    return true;
  }

  /** Remove and return the entry. */
  take(id: number): T | undefined {
    const slot = this.index.get(id);
    if (slot === undefined) return undefined;
    const value = this.slots[slot];
    this.index.delete(id);
    this.slots[slot] = undefined;
    this.free.push(slot);
    return value;
  }

  clear(): void {
    this.slots = [];
    this.free = [];
    this.index.clear();
  }
}
