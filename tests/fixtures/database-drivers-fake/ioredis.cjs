// Stand-in for `ioredis`: records its options; the first command applies
// Node's validation of the TLS options, as the real client does on connect.
'use strict';
const { registry, assertTlsOptions } = require('./registry.cjs');

class Redis {
  constructor(options) {
    this.options = options;
    registry().redis.push(options);
  }
  on() {}
  async ping() {
    assertTlsOptions(this.options.tls);
    return 'PONG';
  }
  async quit() {}
}

class Cluster extends Redis {
  constructor(nodes, options) {
    super({ nodes, ...options });
  }
  async ping() {
    assertTlsOptions(this.options.redisOptions && this.options.redisOptions.tls);
    return 'PONG';
  }
}
Redis.Cluster = Cluster;

Redis.default = Redis;

module.exports = Redis;
