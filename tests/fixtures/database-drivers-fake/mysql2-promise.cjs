// Stand-in for `mysql2/promise`: createPool() refuses a boolean `ssl` and an
// unknown profile name the way the real connection config does, and records
// the options it was given.
'use strict';
const { registry } = require('./registry.cjs');

function createPool(options) {
  if (typeof options.ssl === 'string') {
    // The real driver knows a few named profiles; none is defined here
    throw new TypeError(`Unknown SSL profile '${options.ssl}'`);
  }
  if (options.ssl && typeof options.ssl !== 'object') {
    throw new TypeError(`SSL profile must be an object, instead it's a ${typeof options.ssl}`);
  }
  registry().mysql.push(options);
  return {
    on() {},
    async getConnection() {
      return { release() {} };
    },
    async execute() {
      return [[], []];
    },
    async end() {},
  };
}

module.exports = { createPool };
