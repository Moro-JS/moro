// Drizzle adapter: update() and delete() reject an empty `where` instead of
// touching every row, inside and outside a transaction, and still act on the
// matching rows for a non-empty one.
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import path from 'path';
import { DrizzleAdapter } from '../../../src/core/database/adapters/drizzle.js';
import * as packageUtils from '../../../src/core/utilities/package-utils.js';
import { logger as globalLogger } from '../../../src/core/logger/index.js';

interface Row {
  id: number;
  role: string;
}

type Condition =
  | { op: 'eq'; column: { name: keyof Row }; value: unknown }
  | { op: 'and'; conditions: Condition[] }
  | undefined;

const matches = (row: Row, condition: Condition): boolean => {
  if (condition === undefined) return true; // no WHERE clause: every row
  if (condition.op === 'and') return condition.conditions.every(c => matches(row, c));
  return row[condition.column.name] === condition.value;
};

/** In-memory fake of the Drizzle query-builder surface the adapter uses. */
function createFakeDatabase() {
  const rows: Row[] = [
    { id: 1, role: 'user' },
    { id: 2, role: 'user' },
    { id: 3, role: 'user' },
    { id: 4, role: 'admin' },
  ];
  const executed: string[] = [];

  const builder = {
    update: () => ({
      set: (data: Partial<Row>) => ({
        where: (condition: Condition) => ({
          returning: async () => {
            const hit = rows.filter(row => matches(row, condition));
            hit.forEach(row => Object.assign(row, data));
            return hit;
          },
        }),
      }),
    }),
    delete: () => ({
      where: async (condition: Condition) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matches(rows[i], condition)) rows.splice(i, 1);
        }
        return { rowCount: before - rows.length };
      },
    }),
    // Raw statements are recorded, never run: a statement reaching here in an
    // empty-where test means the adapter sent one. A statement with bound
    // values arrives as a `sql` object; its text is recorded with `$n` where
    // each value goes, as the PostgreSQL dialect renders it.
    execute: async (sql: string | { strings: string[] }) => {
      executed.push(
        typeof sql === 'string'
          ? sql
          : sql.strings.reduce((text, chunk, index) => `${text}$${index}${chunk}`)
      );
      return [];
    },
  };

  const database = {
    ...builder,
    transaction: async <T>(callback: (tx: typeof builder) => Promise<T>) => callback(builder),
  };

  return { database, rows, executed };
}

const schema = { users: { id: { name: 'id' }, role: { name: 'role' } } };
const EMPTY_WHERE = /requires a non-empty where object/;

describe('DrizzleAdapter empty where', () => {
  let fake: ReturnType<typeof createFakeDatabase>;

  // The adapter logs every rejected statement at error level; keep the run quiet
  beforeAll(() => globalLogger.setLevel('fatal'));
  afterAll(() => globalLogger.setLevel('error'));

  beforeEach(() => {
    fake = createFakeDatabase();
    jest
      .spyOn(packageUtils, 'resolveUserPackage')
      .mockReturnValue(path.resolve(__dirname, '../../fixtures/drizzle-orm-fake/index.cjs'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each([
    ['with a schema', () => new DrizzleAdapter({ database: fake.database, schema })],
    ['without a schema (raw SQL)', () => new DrizzleAdapter({ database: fake.database })],
  ])('%s', (_label, createAdapter) => {
    it('update() rejects an empty where and changes nothing', async () => {
      const adapter = createAdapter();
      await expect(adapter.update('users', { role: 'admin' }, {})).rejects.toThrow(EMPTY_WHERE);

      expect(fake.rows.filter(row => row.role === 'admin')).toHaveLength(1);
      expect(fake.executed).toEqual([]);
    });

    it('delete() rejects an empty where and removes nothing', async () => {
      const adapter = createAdapter();
      await expect(adapter.delete('users', {})).rejects.toThrow(EMPTY_WHERE);

      expect(fake.rows).toHaveLength(4);
      expect(fake.executed).toEqual([]);
    });

    it('transaction update() rejects an empty where and changes nothing', async () => {
      const adapter = createAdapter();
      await expect(
        adapter.transaction(tx => tx.update('users', { role: 'admin' }, {}))
      ).rejects.toThrow(EMPTY_WHERE);

      expect(fake.rows.filter(row => row.role === 'admin')).toHaveLength(1);
      expect(fake.executed).toEqual([]);
    });

    it('transaction delete() rejects an empty where and removes nothing', async () => {
      const adapter = createAdapter();
      await expect(adapter.transaction(tx => tx.delete('users', {}))).rejects.toThrow(EMPTY_WHERE);

      expect(fake.rows).toHaveLength(4);
      expect(fake.executed).toEqual([]);
    });
  });

  it('names the operation and table in the error', async () => {
    const adapter = new DrizzleAdapter({ database: fake.database, schema });
    await expect(adapter.delete('users', {})).rejects.toThrow(
      'Drizzle delete on "users" requires a non-empty where object'
    );
    await expect(adapter.update('users', { role: 'x' }, {})).rejects.toThrow(
      'Drizzle update on "users" requires a non-empty where object'
    );
  });

  it('still updates and deletes the matching rows for a non-empty where', async () => {
    const adapter = new DrizzleAdapter({ database: fake.database, schema });

    const updated = await adapter.update<Row>('users', { role: 'editor' }, { id: 2 });
    expect(updated).toEqual({ id: 2, role: 'editor' });
    expect(fake.rows.filter(row => row.role === 'editor')).toHaveLength(1);

    expect(await adapter.delete('users', { id: 3, role: 'user' })).toBe(1);
    expect(fake.rows.map(row => row.id)).toEqual([1, 2, 4]);

    await adapter.transaction(async tx => {
      await tx.update('users', { role: 'owner' }, { id: 1 });
      await tx.delete('users', { id: 4 });
    });
    expect(fake.rows).toEqual([
      { id: 1, role: 'owner' },
      { id: 2, role: 'editor' },
    ]);
  });

  it('still sends a WHERE clause on the raw SQL path', async () => {
    const adapter = new DrizzleAdapter({ database: fake.database });
    await adapter.update('users', { role: 'editor' }, { id: 2 });
    await adapter.delete('users', { id: 3 });
    expect(fake.executed).toEqual([
      'UPDATE "users" SET "role" = $1 WHERE "id" = $2 RETURNING *',
      'DELETE FROM "users" WHERE "id" = $1',
    ]);
  });
});
