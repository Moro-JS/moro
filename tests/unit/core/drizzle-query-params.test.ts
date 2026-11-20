// Drizzle adapter: query(sql, params) binds its parameters. Drizzle's
// execute() takes one argument, a `sql` object that carries the values, so the
// adapter has to build that object from the text and the parameter list; the
// no-schema insert / update / delete helpers go through the same path.
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

interface Statement {
  text: string;
  params: unknown[];
}

/**
 * A Drizzle database whose execute() has the real signature: one argument,
 * either plain text (no parameters) or a `sql` object. A `sql` object is
 * rendered the way the PostgreSQL dialect does: `$n` per bound value.
 */
function createFakeDatabase() {
  const statements: Statement[] = [];
  const execute = async (query: any) => {
    if (typeof query === 'string') {
      statements.push({ text: query, params: [] });
    } else {
      const params: unknown[] = [];
      let text = query.strings[0];
      query.params.forEach((param: any, index: number) => {
        // A bare array is spread into a list; sql.param() keeps it one value
        const values =
          param?.kind === 'param' ? [param.value] : Array.isArray(param) ? param : [param];
        const marks = values.map((value: unknown) => `$${params.push(value)}`);
        text += (marks.length > 1 ? `(${marks.join(', ')})` : marks[0]) + query.strings[index + 1];
      });
      statements.push({ text, params });
    }
    return { rows: [{ ok: true }] };
  };
  const database = {
    execute,
    transaction: async <T>(callback: (tx: { execute: typeof execute }) => Promise<T>) =>
      callback({ execute }),
  };
  return { database, statements };
}

describe('DrizzleAdapter query parameters', () => {
  let fake: ReturnType<typeof createFakeDatabase>;
  let adapter: DrizzleAdapter;

  beforeAll(() => globalLogger.setLevel('fatal'));
  afterAll(() => globalLogger.setLevel('error'));

  beforeEach(() => {
    fake = createFakeDatabase();
    adapter = new DrizzleAdapter({ database: fake.database });
    jest
      .spyOn(packageUtils, 'resolveUserPackage')
      .mockReturnValue(path.resolve(__dirname, '../../fixtures/drizzle-orm-fake/index.cjs'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('binds $n parameters', async () => {
    const rows = await adapter.query('SELECT name FROM users WHERE name = $1 AND role = $2', [
      'alice',
      'admin',
    ]);
    expect(rows).toEqual([{ ok: true }]);
    expect(fake.statements).toEqual([
      { text: 'SELECT name FROM users WHERE name = $1 AND role = $2', params: ['alice', 'admin'] },
    ]);
  });

  it('binds ? parameters in order', async () => {
    await adapter.queryOne('SELECT name FROM users WHERE id = ? OR name = ?', [7, "o'brien"]);
    expect(fake.statements).toEqual([
      { text: 'SELECT name FROM users WHERE id = $1 OR name = $2', params: [7, "o'brien"] },
    ]);
  });

  it('follows the numbers of $n placeholders, repeated or out of order', async () => {
    await adapter.query('SELECT $2::text AS b, $1::text AS a, $2::text AS again', ['x', 'y']);
    expect(fake.statements[0].params).toEqual(['y', 'x', 'y']);
  });

  it('leaves placeholders inside strings, identifiers, comments and dollar quotes alone', async () => {
    const text = [
      `SELECT '$1 ?' AS lit, "col?" FROM t -- is $2 here?`,
      `WHERE note = 'it''s $1' AND body = $q$ $1 ? $q$ AND id = $1`,
    ].join('\n');
    await adapter.query(text, [42]);
    expect(fake.statements).toEqual([{ text, params: [42] }]);
  });

  it('binds an array as one parameter', async () => {
    await adapter.query('SELECT * FROM users WHERE id = ANY($1)', [[1, 2, 3]]);
    expect(fake.statements).toEqual([
      { text: 'SELECT * FROM users WHERE id = ANY($1)', params: [[1, 2, 3]] },
    ]);
  });

  it('sends the text unchanged when there are no parameters or they do not line up', async () => {
    await adapter.query('SELECT 1');
    await adapter.query('SELECT 2', []);
    await adapter.query('SELECT 3', ['unused']);
    await adapter.query('SELECT * FROM t WHERE a = $1 AND b = $2', ['only-one']);
    await adapter.query('SELECT * FROM t WHERE a = ? AND b = ?', ['only-one']);
    expect(fake.statements).toEqual([
      { text: 'SELECT 1', params: [] },
      { text: 'SELECT 2', params: [] },
      { text: 'SELECT 3', params: [] },
      { text: 'SELECT * FROM t WHERE a = $1 AND b = $2', params: [] },
      { text: 'SELECT * FROM t WHERE a = ? AND b = ?', params: [] },
    ]);
  });

  it('insert, update and delete without a schema send their values as parameters', async () => {
    await adapter.insert('users', { name: 'carol', note: "it's" });
    await adapter.update('users', { role: 'editor' }, { name: 'carol' });
    await adapter.delete('users', { name: 'carol' });
    expect(fake.statements).toEqual([
      {
        text: 'INSERT INTO "users" ("name", "note") VALUES ($1, $2) RETURNING *',
        params: ['carol', "it's"],
      },
      {
        text: 'UPDATE "users" SET "role" = $1 WHERE "name" = $2 RETURNING *',
        params: ['editor', 'carol'],
      },
      { text: 'DELETE FROM "users" WHERE "name" = $1', params: ['carol'] },
    ]);
  });

  it('binds parameters inside a transaction', async () => {
    await adapter.transaction(async tx => {
      await tx.query('SELECT name FROM users WHERE id = $1', [5]);
      await tx.insert('users', { name: 'dave' });
    });
    expect(fake.statements).toEqual([
      { text: 'SELECT name FROM users WHERE id = $1', params: [5] },
      { text: 'INSERT INTO "users" ("name") VALUES ($1) RETURNING *', params: ['dave'] },
    ]);
  });
});
