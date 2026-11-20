// Cluster integration fixture (plain JavaScript): the same app as app.ts,
// loading the BUILT framework so a worker thread can import it with no
// loader in the way. tests/integration/cluster-threads.test.ts spawns this
// one for the worker-thread path (it needs `npm run build` first) and app.ts
// through tsx for the TypeScript-entry fallback path.
// MORO_TEST_DIST names a built framework other than ../../../dist (a build
// kept outside the repository).
import { isMainThread, threadId } from 'node:worker_threads';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { createApp } = await import(
  process.env.MORO_TEST_DIST
    ? pathToFileURL(join(process.env.MORO_TEST_DIST, 'index.js')).href
    : '../../../dist/index.js'
);

const port = parseInt(process.env.PORT || '0', 10);

const app = await createApp({
  server: { port, host: '127.0.0.1' },
  performance: { clustering: { enabled: true, workers: 2 } },
  logger: { level: 'warn' },
});

app.get('/', (_req, res) => {
  res.json({ pid: process.pid, threadId, isMainThread });
});

app.get('/slow', (_req, res) => {
  setTimeout(() => res.json({ pid: process.pid, threadId, slow: true }), 500);
});

app.get('/crash', (_req, res) => {
  res.status(202).json({ threadId, crashing: true });
  setImmediate(() => {
    throw new Error('fixture crash');
  });
});

app.listen(() => {
  // The primary's listen callback runs once the first worker is ready.
  console.log(`CLUSTER_READY ${port}`);
});
