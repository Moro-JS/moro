// Database adapters (MySQL, PostgreSQL, MongoDB, SQLite, Redis): the options
// each adapter hands to its driver, what its helpers return, and the error it
// reports when the driver fails to start.
//
// The drivers are optional peers and are not installed in this repository.
// Each adapter loads a stand-in from tests/fixtures/database-drivers-fake that
// keeps the real driver's behaviour for the thing under test (what it rejects,
// what it returns) and records what it was given.
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
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MySQLAdapter } from '../../../src/core/database/adapters/mysql.js';
import { PostgreSQLAdapter } from '../../../src/core/database/adapters/postgresql.js';
import { MongoDBAdapter } from '../../../src/core/database/adapters/mongodb.js';
import { SQLiteAdapter } from '../../../src/core/database/adapters/sqlite.js';
import { RedisAdapter } from '../../../src/core/database/adapters/redis.js';
import * as packageUtils from '../../../src/core/utilities/package-utils.js';
import { logger as globalLogger } from '../../../src/core/logger/index.js';

const FIXTURES = path.resolve(__dirname, '../../fixtures/database-drivers-fake');
const DRIVERS: Record<string, string> = {
  'mysql2/promise': 'mysql2-promise.cjs',
  pg: 'pg.cjs',
  mongodb: 'mongodb.cjs',
  'better-sqlite3': 'better-sqlite3.cjs',
  ioredis: 'ioredis.cjs',
};

interface Recorded {
  mysql: any[];
  pg: any[];
  redis: any[];
  mongodb: Array<{ url: string; options: any; host: string; username: string; password: string }>;
  sqlite: any[];
  mongodbGeneration: number;
}
const recorded = (): Recorded => (globalThis as any).__moroFakeDatabaseDrivers;

/** What Node's module resolution throws for a package that is not there. */
function moduleNotFound(name: string): Error {
  return Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' });
}

describe('database adapters', () => {
  let installed: Set<string>;

  beforeAll(() => globalLogger.setLevel('fatal'));
  afterAll(() => globalLogger.setLevel('error'));

  beforeEach(() => {
    installed = new Set(Object.keys(DRIVERS));
    (globalThis as any).__moroFakeDatabaseDrivers = undefined;
    jest.spyOn(packageUtils, 'resolveUserPackage').mockImplementation((name: string) => {
      if (!installed.has(name)) throw moduleNotFound(name);
      return path.join(FIXTURES, DRIVERS[name]);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('driver start-up errors', () => {
    const adapters: Array<[string, string, () => { connect(): Promise<void> }]> = [
      ['mysql2', 'mysql2/promise', () => new MySQLAdapter({})],
      ['pg', 'pg', () => new PostgreSQLAdapter({})],
      ['mongodb', 'mongodb', () => new MongoDBAdapter({})],
      ['better-sqlite3', 'better-sqlite3', () => new SQLiteAdapter({ memory: true })],
      ['ioredis', 'ioredis', () => new RedisAdapter({})],
    ];

    it.each(adapters)(
      'says to install %s only when the package is missing',
      async (name, specifier, create) => {
        installed.delete(specifier);
        await expect(create().connect()).rejects.toThrow(
          new RegExp(`${name} package is required .* npm install ${name}`)
        );
      }
    );

    it('reports the error of a driver that is installed but fails to load', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-broken-driver-'));
      const broken = path.join(dir, 'index.cjs');
      fs.writeFileSync(
        broken,
        "throw Object.assign(new Error('Could not locate the bindings file'), { code: 'ERR_DLOPEN_FAILED' });"
      );
      jest.spyOn(packageUtils, 'resolveUserPackage').mockReturnValue(broken);
      try {
        await expect(new SQLiteAdapter({ memory: true }).connect()).rejects.toThrow(
          'Could not locate the bindings file'
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reports what the driver rejected in the options it was given', async () => {
      await expect(new MySQLAdapter({ ssl: 'NoSuchProfile' as any }).connect()).rejects.toThrow(
        "Unknown SSL profile 'NoSuchProfile'"
      );
      await expect(
        new MongoDBAdapter({ tls: { insecure: true }, url: 'not a connection string' }).connect()
      ).rejects.toThrow(/Invalid URL/);
    });
  });

  describe('MySQL ssl', () => {
    it('turns ssl: true into an options object that verifies the server', async () => {
      await new MySQLAdapter({ ssl: true }).connect();
      expect(recorded().mysql[0].ssl).toEqual({ rejectUnauthorized: true });
    });

    it('keeps ssl off by default and passes an options object through', async () => {
      await new MySQLAdapter({}).connect();
      await new MySQLAdapter({ ssl: false }).connect();
      await new MySQLAdapter({ ssl: { ca: 'PEM', rejectUnauthorized: false } }).connect();
      expect(recorded().mysql.map(options => options.ssl)).toEqual([
        false,
        false,
        { ca: 'PEM', rejectUnauthorized: false },
      ]);
    });
  });

  describe('checkServerIdentity given as a boolean', () => {
    const connectors: Array<[string, (tls: any) => Promise<void>, () => any]> = [
      [
        'PostgreSQL',
        tls => new PostgreSQLAdapter({ ssl: tls }).connect(),
        () => recorded().pg.at(-1).ssl,
      ],
      ['MySQL', tls => new MySQLAdapter({ ssl: tls }).connect(), () => recorded().mysql.at(-1).ssl],
      ['Redis', tls => new RedisAdapter({ tls }).connect(), () => recorded().redis.at(-1).tls],
      [
        'Redis Cluster',
        tls => new RedisAdapter({ tls, cluster: { nodes: [{ host: 'a', port: 1 }] } }).connect(),
        () => recorded().redis.at(-1).redisOptions.tls,
      ],
    ];

    it.each(connectors)(
      '%s: false becomes a function that accepts any host name',
      async (_name, connect, sent) => {
        await connect({ ca: 'PEM', checkServerIdentity: false });
        const options = sent();
        expect(typeof options.checkServerIdentity).toBe('function');
        expect(options.checkServerIdentity('db.internal', {})).toBeUndefined();
        expect(options.ca).toBe('PEM');
      }
    );

    it.each(connectors)(
      '%s: true leaves the default check in place',
      async (_name, connect, sent) => {
        await connect({ ca: 'PEM', checkServerIdentity: true });
        expect(sent()).toEqual({ ca: 'PEM' });
      }
    );

    it('passes a function through unchanged', async () => {
      const check = () => undefined;
      await new PostgreSQLAdapter({ ssl: { checkServerIdentity: check as any } }).connect();
      expect(recorded().pg[0].ssl.checkServerIdentity).toBe(check);
    });

    it('MongoDB: false becomes a function, true is left to the driver', async () => {
      await new MongoDBAdapter({ tls: { checkServerIdentity: false } }).connect();
      await new MongoDBAdapter({ tls: { checkServerIdentity: true } }).connect();
      const [off, on] = recorded().mongodb.map(entry => entry.options);
      expect(typeof off.checkServerIdentity).toBe('function');
      expect(off.checkServerIdentity()).toBeUndefined();
      expect('checkServerIdentity' in on).toBe(false);
    });
  });

  describe('MongoDB connection string', () => {
    const connect = async (username: string, password: string) => {
      await new MongoDBAdapter({ host: 'db.example', port: 27017, username, password }).connect();
      return recorded().mongodb.at(-1)!;
    };

    it('encodes a password that holds a userinfo delimiter', async () => {
      const seen = await connect('root', 'p@ss/w:rd');
      expect(seen.host).toBe('db.example');
      expect(seen.username).toBe('root');
      expect(seen.password).toBe('p@ss/w:rd');
    });

    it('encodes a username that holds a delimiter', async () => {
      const seen = await connect('ops/svc@corp', 'plain');
      expect(seen.host).toBe('db.example');
      expect(seen.username).toBe('ops/svc@corp');
      expect(seen.password).toBe('plain');
    });

    it('leaves other values exactly as given, percent-encoded ones included', async () => {
      const plain = await connect('root', 'S3cret-_.~!*');
      expect(plain.url).toBe('mongodb://root:S3cret-_.~!*@db.example:27017/moro_app');

      const encoded = await connect('root', 'p%40ss%2Fw%3Ard');
      expect(encoded.url).toBe('mongodb://root:p%40ss%2Fw%3Ard@db.example:27017/moro_app');
      expect(encoded.password).toBe('p@ss/w:rd');
    });
  });

  describe('MongoDB tls object', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-mongo-tls-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const optionsFor = async (config: ConstructorParameters<typeof MongoDBAdapter>[0]) => {
      await new MongoDBAdapter(config).connect();
      return recorded().mongodb.at(-1)!.options;
    };

    it('turns TLS on without a conflicting ssl value', async () => {
      const options = await optionsFor({ tls: { allowInvalidCertificates: true } });
      expect(options.tls).toBe(true);
      expect('ssl' in options).toBe(false);
      expect(options.tlsAllowInvalidCertificates).toBe(true);
    });

    it('keeps ssl: true next to the tls object, and ssl: false without one', async () => {
      expect((await optionsFor({ ssl: true, tls: { insecure: true } })).ssl).toBe(true);
      expect(await optionsFor({})).toEqual({ maxPoolSize: 10, minPoolSize: 0, ssl: false });
    });

    it('maps file paths to the driver file options and reads a separate certificate file', async () => {
      const certFile = path.join(dir, 'client.crt');
      fs.writeFileSync(certFile, 'CERT-FILE-CONTENTS');
      const options = await optionsFor({
        tls: { ca: '/etc/ca.pem', key: '/etc/client.key', cert: certFile, passphrase: 'pw' },
      });
      expect(options).toMatchObject({
        tls: true,
        tlsCAFile: '/etc/ca.pem',
        tlsCertificateKeyFile: '/etc/client.key',
        tlsCertificateKeyFilePassword: 'pw',
        cert: 'CERT-FILE-CONTENTS',
      });
      // The option this driver does not accept is never sent
      expect('tlsCertificateFile' in options).toBe(false);
    });

    it('passes PEM text as socket options', async () => {
      const pem = (label: string) => `-----BEGIN ${label}-----\nAAAA\n-----END ${label}-----`;
      const options = await optionsFor({
        tls: { ca: pem('CERTIFICATE'), cert: pem('CERTIFICATE'), key: pem('PRIVATE KEY') },
      });
      expect(options).toMatchObject({
        tls: true,
        ca: pem('CERTIFICATE'),
        cert: pem('CERTIFICATE'),
        key: pem('PRIVATE KEY'),
      });
      expect('tlsCAFile' in options || 'tlsCertificateKeyFile' in options).toBe(false);
    });

    it('reports a certificate file that cannot be read', async () => {
      const missing = path.join(dir, 'absent.crt');
      await expect(new MongoDBAdapter({ tls: { cert: missing } }).connect()).rejects.toThrow(
        /ENOENT/
      );
    });
  });

  describe('MongoDB update()', () => {
    const seeded = async () => {
      const adapter = new MongoDBAdapter({});
      await adapter.connect();
      const { client } = recorded().mongodb.at(-1) as any;
      client.documents.set(1, { _id: 1, name: 'bob', role: 'user' });
      return adapter;
    };

    it.each([
      ['6 and later (resolves to the document)', 7],
      ['5 and earlier (resolves to { value, ... })', 5],
    ])('returns the updated document on driver %s', async (_label, generation) => {
      const adapter = await seeded();
      recorded().mongodbGeneration = generation;

      expect(await adapter.update('users', { role: 'editor' }, { _id: 1 })).toEqual({
        _id: 1,
        name: 'bob',
        role: 'editor',
      });
      expect(await adapter.update('users', { role: 'x' }, { _id: 404 })).toBeNull();

      const inTransaction = await adapter.transaction(tx =>
        tx.update('users', { role: 'admin' }, { _id: 1 })
      );
      expect(inTransaction).toEqual({ _id: 1, name: 'bob', role: 'admin' });
    });
  });

  describe('SQLite statements', () => {
    const open = async () => {
      const adapter = new SQLiteAdapter({ memory: true });
      await adapter.connect();
      return { adapter, db: recorded().sqlite.at(-1) };
    };

    it('query() runs a statement that returns no rows and answers []', async () => {
      const { adapter, db } = await open();
      expect(await adapter.query('CREATE TABLE users (id integer primary key, name text)')).toEqual(
        []
      );
      expect(await adapter.query('UPDATE users SET name = ? WHERE id = ?', ['x', 1])).toEqual([]);
      expect(db.statements).toEqual([
        ['run', 'CREATE TABLE users (id integer primary key, name text)', []],
        ['run', 'UPDATE users SET name = ? WHERE id = ?', ['x', 1]],
      ]);
    });

    it('query() still reads rows from a statement that returns them', async () => {
      const { adapter, db } = await open();
      expect(await adapter.query('SELECT * FROM users WHERE id = ?', [1])).toEqual([
        { id: 1, name: 'alice' },
      ]);
      expect(await adapter.query('INSERT INTO users (name) VALUES (?) RETURNING *', ['b'])).toEqual(
        [{ id: 1, name: 'alice' }]
      );
      expect(db.statements.map((entry: any[]) => entry[0])).toEqual(['all', 'all']);
    });

    it('queryOne() runs a statement that returns no rows and answers null', async () => {
      const { adapter, db } = await open();
      expect(await adapter.queryOne('DELETE FROM users WHERE id = ?', [9])).toBeNull();
      expect(await adapter.queryOne('SELECT * FROM users WHERE id = ?', [1])).toEqual({
        id: 1,
        name: 'alice',
      });
      expect(db.statements.map((entry: any[]) => entry[0])).toEqual(['run', 'get']);
    });

    it('transaction() commits an async callback, and its statements may return no rows', async () => {
      const { adapter, db } = await open();
      const result = await adapter.transaction(async tx => {
        await tx.query('UPDATE users SET name = ? WHERE id = ?', ['x', 1]);
        expect(await tx.queryOne('DELETE FROM users WHERE id = ?', [2])).toBeNull();
        return 'done';
      });
      expect(result).toBe('done');
      expect(db.statements.map((entry: any[]) => entry.slice(0, 2).join(' '))).toEqual([
        'exec BEGIN',
        'run UPDATE users SET name = ? WHERE id = ?',
        'run DELETE FROM users WHERE id = ?',
        'exec COMMIT',
      ]);
      expect(db.inTransaction).toBe(false);
    });

    it('transaction() rolls back when the callback throws, and runs transactions one at a time', async () => {
      const { adapter, db } = await open();
      const order: string[] = [];
      const first = adapter.transaction(async tx => {
        order.push('first:start');
        await tx.query('UPDATE users SET name = ?', ['a']);
        await new Promise(resolve => setTimeout(resolve, 20));
        order.push('first:end');
        throw new Error('abort');
      });
      const second = adapter.transaction(async tx => {
        order.push('second:start');
        await tx.query('UPDATE users SET name = ?', ['b']);
        return 'second';
      });

      await expect(first).rejects.toThrow('abort');
      expect(await second).toBe('second');
      expect(order).toEqual(['first:start', 'first:end', 'second:start']);
      expect(
        db.statements.filter((entry: any[]) => entry[0] === 'exec').map((e: any[]) => e[1])
      ).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
    });
  });
});
