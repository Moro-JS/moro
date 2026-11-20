// Stand-in for `mongodb`: MongoClient parses the connection string as the
// real driver does (WHATWG URL rules), rejects the option combinations the
// real driver rejects, and findOneAndUpdate() answers in the shape of the
// driver generation selected in the registry (6+ returns the document, 5 and
// earlier a { value, lastErrorObject, ok } result).
'use strict';
const { registry, assertTlsOptions } = require('./registry.cjs');

const SUPPORTED = new Set([
  'maxPoolSize',
  'minPoolSize',
  'ssl',
  'tls',
  'tlsCAFile',
  'tlsCertificateKeyFile',
  'tlsCertificateKeyFilePassword',
  'tlsInsecure',
  'tlsAllowInvalidCertificates',
  'tlsAllowInvalidHostnames',
  'ca',
  'cert',
  'key',
  'passphrase',
  'checkServerIdentity',
]);

class MongoClient {
  constructor(url, options = {}) {
    for (const name of Object.keys(options)) {
      if (!SUPPORTED.has(name)) {
        throw new Error(`option ${name.toLowerCase()} is not supported`);
      }
    }
    if (options.tls !== undefined && options.ssl !== undefined && options.tls !== options.ssl) {
      throw new Error('All values of tls/ssl must be the same.');
    }
    const parsed = new URL(url);
    this.options = options;
    this.documents = new Map();
    registry().mongodb.push({
      url,
      options,
      host: parsed.hostname,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      client: this,
    });
  }
  on() {}
  async connect() {
    assertTlsOptions(this.options);
  }
  async close() {}
  db() {
    const documents = this.documents;
    return {
      command: async () => ({ ok: 1 }),
      collection: () => ({
        findOneAndUpdate: async (filter, update, options = {}) => {
          const existing = documents.get(filter._id);
          const document = existing ? Object.assign(existing, update.$set) : null;
          const metadata =
            registry().mongodbGeneration >= 6
              ? options.includeResultMetadata === true
              : options.includeResultMetadata !== false;
          return metadata
            ? { value: document, lastErrorObject: { n: document ? 1 : 0 }, ok: 1 }
            : document;
        },
      }),
    };
  }
  startSession() {
    return {
      withTransaction: async callback => callback(),
      endSession: async () => {},
    };
  }
}

module.exports = { MongoClient };
