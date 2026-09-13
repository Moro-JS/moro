// Cluster integration fixture: a real app with clustering enabled, launched
// as a child process by tests/integration/cluster-threads.test.ts. Every
// worker (thread or process) answers identity questions so the test can tell
// which transport served it.
import { isMainThread, threadId } from 'node:worker_threads';
import { createApp } from '../../../src/index.js';

const port = parseInt(process.env.PORT || '0', 10);

const app = await createApp({
  server: { port, host: '127.0.0.1' },
  performance: { clustering: { enabled: true, workers: 2 } },
  logger: { level: 'warn' },
});

app.get('/', (_req: any, res: any) => {
  res.json({ pid: process.pid, threadId, isMainThread });
});

app.get('/slow', (_req: any, res: any) => {
  setTimeout(() => res.json({ pid: process.pid, threadId, slow: true }), 500);
});

app.get('/crash', (_req: any, res: any) => {
  res.status(202).json({ threadId, crashing: true });
  setImmediate(() => {
    throw new Error('fixture crash');
  });
});

app.listen(() => {
  // The primary's listen callback runs once the first worker is ready.
  console.log(`CLUSTER_READY ${port}`);
});
