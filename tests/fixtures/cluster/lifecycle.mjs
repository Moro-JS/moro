// Cluster lifecycle fixture (plain JavaScript, loading the BUILT framework):
// a clustered app whose start-up, shutdown and failure behaviour
// tests/integration/cluster-threads.test.ts observes from outside. Every
// isolate (primary, worker thread, worker process) appends one line per event
// to the file named by MARKS; the environment selects what the app does.
//
//   PORT, WORKERS (default 2)   where to listen, how many workers
//   ENGINE=node                 the Node http server, so workers are processes
//   MODE                        performance.clustering.mode
//   CRASH_ON_BOOT=1             every worker throws while loading
//   FAIL_IN_THREADS=1           the entry throws in a worker thread only
//   DOUBLE_LISTEN=1             listen() is called twice
//   JOB=1                       a job that starts every second and runs 1.5 s
//   MORO_TEST_DIST              a built framework other than ../../../dist
//
// SIGUSR2 to the primary calls app.close() there without exiting.
import { isMainThread, threadId, parentPort } from 'node:worker_threads';
import cluster from 'node:cluster';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const role = !isMainThread ? 'worker-thread' : cluster.isWorker ? 'worker-process' : 'primary';
const mark = event => {
  if (process.env.MARKS) appendFileSync(process.env.MARKS, `${event} ${role}\n`);
};

mark('load');
if (process.env.CRASH_ON_BOOT === '1' && role !== 'primary') {
  throw new Error('fixture worker fails while loading');
}
if (process.env.FAIL_IN_THREADS === '1' && !isMainThread) {
  throw new Error('fixture entry cannot run in a worker thread');
}

const { createApp } = await import(
  process.env.MORO_TEST_DIST
    ? pathToFileURL(join(process.env.MORO_TEST_DIST, 'index.js')).href
    : '../../../dist/index.js'
);

const port = parseInt(process.env.PORT || '0', 10);

const app = await createApp({
  server: {
    port,
    host: '127.0.0.1',
    ...(process.env.ENGINE ? { engine: process.env.ENGINE } : {}),
  },
  performance: {
    clustering: {
      enabled: true,
      workers: parseInt(process.env.WORKERS || '2', 10),
      ...(process.env.MODE ? { mode: process.env.MODE } : {}),
    },
  },
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

// What application code may send to its parent on the channels the cluster
// also uses: a null IPC message, and a { type: 'fatal' } on parentPort.
app.get('/send-null', (_req, res) => {
  res.json({ sent: true });
  setImmediate(() => process.send?.(null));
});

app.get('/post-fatal', (_req, res) => {
  res.json({ sent: true });
  setImmediate(() =>
    parentPort?.postMessage({ type: 'fatal', code: 'EADDRINUSE', message: 'from application code' })
  );
});

app.onClose(() => mark('onClose'));
app.on('error', error => mark(`app-error ${error.message}`));

if (process.env.JOB === '1') {
  app.job('long', '1s', async () => {
    mark('job-start');
    await new Promise(resolve => setTimeout(resolve, 1500));
    mark('job-end');
  });
}

if (role === 'primary' && process.platform !== 'win32') {
  process.on('SIGUSR2', () => {
    app.close().then(() => {
      // Stay alive: the test then asks whether anything still serves the port.
      setInterval(() => {}, 1000);
      console.log('PRIMARY_CLOSED');
    });
  });
}

app.listen(() => {
  mark('listening');
  console.log(`CLUSTER_READY ${port}`);
});
if (process.env.DOUBLE_LISTEN === '1') {
  app.listen(() => mark('listening-again'));
}
