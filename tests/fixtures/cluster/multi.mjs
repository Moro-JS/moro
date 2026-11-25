// Cluster fixture (plain JavaScript, loading the BUILT framework): two
// clustered apps in one process, 'a' and 'b', each on its own port.
// tests/integration/cluster-threads.test.ts observes from outside that they
// share one set of workers. Every isolate appends one line per event to the
// file named by MARKS.
//
//   PORT_A, PORT_B              where each app listens
//   WORKERS_A, WORKERS_B        performance.clustering.workers (default 2)
//   ENGINE                      server.engine of both apps ('node': processes)
//   ENGINE_B                    server.engine of 'b' alone
//   MORO_TEST_DIST              a built framework other than ../../../dist
//
// The primary reads commands from stdin, one per line: close-a, close-b,
// open-a. It answers each on stdout (A_CLOSED, B_CLOSED, A_OPEN).
import { isMainThread, threadId } from 'node:worker_threads';
import cluster from 'node:cluster';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const role = !isMainThread ? 'worker-thread' : cluster.isWorker ? 'worker-process' : 'primary';
const mark = event => {
  if (process.env.MARKS) appendFileSync(process.env.MARKS, `${event} ${role}\n`);
};

mark('load');

const { createApp } = await import(
  process.env.MORO_TEST_DIST
    ? pathToFileURL(join(process.env.MORO_TEST_DIST, 'index.js')).href
    : '../../../dist/index.js'
);

async function make(name) {
  const upper = name.toUpperCase();
  const port = parseInt(process.env[`PORT_${upper}`] || '0', 10);
  const engine = process.env[`ENGINE_${upper}`] || process.env.ENGINE;
  const app = await createApp({
    server: { port, host: '127.0.0.1', ...(engine ? { engine } : {}) },
    performance: {
      clustering: { enabled: true, workers: parseInt(process.env[`WORKERS_${upper}`] || '2', 10) },
    },
    routing: false,
    logger: { level: process.env.LOG_LEVEL || 'warn' },
  });
  app.get('/', (_req, res) => {
    res.json({ app: name, pid: process.pid, threadId, isMainThread });
  });
  app.get('/slow', (_req, res) => {
    setTimeout(() => res.json({ app: name, slow: true }), 500);
  });
  app.onClose(() => mark(`onClose-${name}`));
  app.on('error', error => mark(`app-error-${name} ${error.message}`));
  const listen = () =>
    app.listen(() => {
      mark(`listening-${name}`);
      console.log(`READY_${upper} ${port}`);
    });
  return { app, listen };
}

const a = await make('a');
const b = await make('b');

if (role === 'primary') {
  createInterface({ input: process.stdin }).on('line', line => {
    const command = line.trim();
    if (command === 'close-a') a.app.close().then(() => console.log('A_CLOSED'));
    else if (command === 'close-b') b.app.close().then(() => console.log('B_CLOSED'));
    else if (command === 'open-a') a.listen();
  });
}

a.listen();
b.listen();
