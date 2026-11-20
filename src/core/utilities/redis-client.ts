// Tells the two Redis client libraries apart.
//
// A caller may hand the framework a client it already owns (cache adapter,
// session store, job leader election). node-redis and ioredis name the same
// commands differently and take their arguments in different shapes
// (`set(key, value, { PX, NX })` against `set(key, value, 'PX', ms, 'NX')`),
// so code that issues anything beyond GET/DEL has to know which one it holds.

export type RedisClientFlavour = 'node-redis' | 'ioredis';

/**
 * The library a client object comes from, or undefined when it is neither.
 *
 * - node-redis 4+ (`createClient()` / `createCluster()`): an `isOpen` flag and
 *   option-object arguments.
 * - ioredis (`new Redis()` / `new Redis.Cluster()`): `defineCommand()`, its
 *   own scripting API, and positional arguments.
 */
export function redisClientFlavour(client: unknown): RedisClientFlavour | undefined {
  if (client === null || (typeof client !== 'object' && typeof client !== 'function')) {
    return undefined;
  }
  const candidate = client as Record<string, unknown>;
  if (typeof candidate.isOpen === 'boolean' && typeof candidate.sendCommand === 'function') {
    return 'node-redis';
  }
  if (typeof candidate.defineCommand === 'function') {
    return 'ioredis';
  }
  return undefined;
}
