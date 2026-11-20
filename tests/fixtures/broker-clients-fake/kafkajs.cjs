// Minimal stand-in for `kafkajs`, which is an optional peer and is not
// installed in this repository: a Kafka class that keeps the configuration it
// was constructed with, so a test can see what the Kafka adapter hands it.
'use strict';

// Looked up on every use: a test starts from a fresh record
const constructed = () => (globalThis.__moroFakeBrokerClients ??= { kafka: [], sqs: [] });

class Kafka {
  constructor(config) {
    constructed().kafka.push(config);
  }
  producer() {
    return { connect: async () => {}, disconnect: async () => {}, send: async () => {} };
  }
  consumer() {
    return {
      connect: async () => {},
      disconnect: async () => {},
      subscribe: async () => {},
      run: async () => {},
    };
  }
}

module.exports = { Kafka };
