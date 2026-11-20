// Stand-in for `pg`: Pool records its options and connect() applies Node's
// validation of the TLS options, as the real client does when it upgrades.
'use strict';
const { registry, assertTlsOptions } = require('./registry.cjs');

class Pool {
  constructor(options) {
    this.options = options;
    registry().pg.push(options);
  }
  on() {}
  async connect() {
    assertTlsOptions(this.options.ssl);
    return { release() {} };
  }
  async end() {}
}

module.exports = { Pool };
