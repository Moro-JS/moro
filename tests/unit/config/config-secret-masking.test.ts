// Config debug dump: secrets are masked in every environment, ordinary values
// are still printed outside production, and URL-shaped values keep their
// scheme and host with the userinfo masked.
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { loadConfigFromAllSources } from '../../../src/core/config/config-sources.js';
import { MoroLogger, logger as globalLogger } from '../../../src/core/logger/index.js';

const SECRETS = {
  DATABASE_URL: 'postgres://app:PGPASS-1@db.internal/prod',
  REDIS_URL: 'redis://:REDISPASS-2@cache.internal:6379',
  SMTP_HOST: 'smtp.internal',
  SMTP_PASSWORD: 'SMTPPASS-3',
  STRIPE_SECRET_KEY: 'sk_live_STRIPE-4',
  MORO_SSL_PASSPHRASE: 'PASSPHRASE-6',
};
const PLANTED = ['PGPASS-1', 'REDISPASS-2', 'SMTPPASS-3', 'sk_live_STRIPE-4', 'PASSPHRASE-6'];

describe('configuration debug dump', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let debugLines: () => string[];

  beforeEach(() => {
    for (const key of [...Object.keys(SECRETS), 'NODE_ENV']) savedEnv[key] = process.env[key];
    Object.assign(process.env, SECRETS);

    // debug() is an instance property (a noop below the active level), so raise
    // the level and observe the shared private log(level, message) sink.
    globalLogger.setLevel('debug');
    const spy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
    debugLines = () => spy.mock.calls.filter(c => c[0] === 'debug').map(c => String(c[1]));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const lineFor = (path: string) => debugLines().find(line => line.startsWith(`  ${path}: `));

  it.each(['development', 'staging', 'test', 'production'])(
    'prints no secret when NODE_ENV=%s',
    nodeEnv => {
      process.env.NODE_ENV = nodeEnv;
      loadConfigFromAllSources({});

      const dump = debugLines().join('\n');
      expect(dump).toContain('server.ssl.passphrase');
      for (const secret of PLANTED) {
        expect(dump).not.toContain(secret);
      }
      expect(lineFor('server.ssl.passphrase')).toBe(
        '  server.ssl.passphrase: *** (from environment)'
      );
      expect(lineFor('database.url')).toBe('  database.url: *** (from environment)');
    }
  );

  it('still prints ordinary values outside production', () => {
    process.env.NODE_ENV = 'development';
    loadConfigFromAllSources({ server: { port: 4321 } });

    expect(lineFor('server.port')).toBe('  server.port: 4321 (from createApp)');
    expect(lineFor('external.smtp.host')).toBe(
      '  external.smtp.host: smtp.internal (from environment)'
    );
  });

  it('masks the userinfo of URL-shaped values but keeps scheme and host', () => {
    process.env.NODE_ENV = 'development';
    const urls = {
      plain: 'https://api.internal:8443/v1?contact=ops@example.com',
      basic: 'https://svc:URLPASS-7@api.internal:8443/v1?x=1',
      userOnly: 'amqp://URLUSER-8@mq.internal',
      unencoded: 'amqp://svc:p@ss/w#URLPASS-9@mq.prod.internal:5672',
      list: ['kafka://u:URLPASS-10@broker-1:9092', 'broker-2:9092'],
    };
    loadConfigFromAllSources({ database: { custom: { endpoints: urls } } } as any);

    expect(lineFor('database.custom.endpoints.plain')).toContain(urls.plain);
    expect(lineFor('database.custom.endpoints.basic')).toContain(
      'https://***@api.internal:8443/v1?x=1'
    );
    expect(lineFor('database.custom.endpoints.userOnly')).toContain('amqp://***@mq.internal');
    expect(lineFor('database.custom.endpoints.unencoded')).toContain(
      'amqp://***@mq.prod.internal:5672'
    );
    expect(lineFor('database.custom.endpoints.list')).toContain(
      '["kafka://***@broker-1:9092","broker-2:9092"]'
    );

    const dump = debugLines().join('\n');
    for (const secret of ['URLPASS-7', 'URLUSER-8', 'URLPASS-9', 'URLPASS-10', 'p@ss']) {
      expect(dump).not.toContain(secret);
    }
  });

  it('masks DSN, connection-string, credential, pfx and passphrase key names', () => {
    process.env.NODE_ENV = 'development';
    loadConfigFromAllSources({
      database: {
        custom: {
          sentryDsn: 'DSN-11',
          connectionString: 'Server=db;Password=CONN-12',
          awsCredentials: 'CRED-13',
          pfx: 'PFX-14',
          keyPassphrase: 'PASS-15',
        },
      },
    } as any);

    const dump = debugLines().join('\n');
    for (const secret of ['DSN-11', 'CONN-12', 'CRED-13', 'PFX-14', 'PASS-15']) {
      expect(dump).not.toContain(secret);
    }
    expect(lineFor('database.custom.sentryDsn')).toBe(
      '  database.custom.sentryDsn: *** (from createApp)'
    );
  });
});
