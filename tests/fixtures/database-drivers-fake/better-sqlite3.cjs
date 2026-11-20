// Stand-in for `better-sqlite3`: a prepared statement knows whether it returns
// data (`reader`), all()/get() refuse one that does not and run() refuses one
// that does, and transaction() refuses a function that returns a promise.
// Statements are recorded, not executed.
'use strict';
const { registry } = require('./registry.cjs');

const RETURNS_DATA = /^\s*(select|pragma|with|values)\b|\breturning\b/i;

class Database {
  constructor(filename, options) {
    this.filename = filename;
    this.options = options;
    this.statements = [];
    this.inTransaction = false;
    this.rows = [{ id: 1, name: 'alice' }];
    registry().sqlite.push(this);
  }
  pragma() {}
  close() {}
  exec(sql) {
    this.statements.push(['exec', sql]);
    const word = sql.trim().split(/\s+/)[0].toUpperCase();
    if (word === 'BEGIN') {
      if (this.inTransaction) throw new Error('cannot start a transaction within a transaction');
      this.inTransaction = true;
    } else if (word === 'COMMIT' || word === 'ROLLBACK') {
      if (!this.inTransaction)
        throw new Error(`cannot ${word.toLowerCase()} - no transaction is active`);
      this.inTransaction = false;
    }
  }
  prepare(sql) {
    const db = this;
    const reader = RETURNS_DATA.test(sql);
    const assertReader = () => {
      if (!reader) throw new TypeError('This statement does not return data. Use run() instead');
    };
    return {
      reader,
      all(params) {
        assertReader();
        db.statements.push(['all', sql, params]);
        return db.rows.slice();
      },
      get(params) {
        assertReader();
        db.statements.push(['get', sql, params]);
        return db.rows[0];
      },
      run(params) {
        if (reader)
          throw new TypeError(
            'This statement returns data. Use get(), all(), or iterate() instead'
          );
        db.statements.push(['run', sql, params]);
        return { changes: 1, lastInsertRowid: 1 };
      },
    };
  }
  transaction(fn) {
    return (...args) => {
      const result = fn(...args);
      if (result && typeof result.then === 'function') {
        throw new TypeError('Transaction function cannot return a promise');
      }
      return result;
    };
  }
}

module.exports = Database;
