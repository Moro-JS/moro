// Shared record of what the stand-in drivers in this directory were asked to
// do. The real drivers (mysql2, pg, mongodb, better-sqlite3, ioredis) are
// optional peers and are not installed in this repository; each stand-in keeps
// the one piece of the real driver's behaviour that the adapter tests rely on.
'use strict';

const KEY = '__moroFakeDatabaseDrivers';

function registry() {
  if (!globalThis[KEY]) {
    globalThis[KEY] = {
      mysql: [],
      pg: [],
      redis: [],
      mongodb: [],
      sqlite: [],
      mongodbGeneration: 7,
    };
  }
  return globalThis[KEY];
}

/**
 * Node's tls.connect() validation of the option the drivers pass through:
 * anything but a function is ERR_INVALID_ARG_TYPE.
 */
function assertTlsOptions(options) {
  if (!options || typeof options !== 'object') return;
  const check = options.checkServerIdentity;
  if (check !== undefined && typeof check !== 'function') {
    const error = new TypeError(
      `The "options.checkServerIdentity" property must be of type function. Received type ${typeof check} (${check})`
    );
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
}

module.exports = { registry, assertTlsOptions };
