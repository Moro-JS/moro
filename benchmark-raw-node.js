#!/usr/bin/env node

// RAW Node.js HTTP server - NO framework, NO middleware, NO nothing
// This is the theoretical maximum performance for Node.js HTTP

import http from 'http';
import cluster from 'cluster';
import os from 'os';

const PORT = 3333;
const HOST = '127.0.0.1';
const WORKERS = os.cpus().length;

// Pre-serialize the JSON response (optimization)
const RESPONSE_BODY = JSON.stringify({ hello: 'world' });
const RESPONSE_LENGTH = Buffer.byteLength(RESPONSE_BODY);

if (cluster.isPrimary) {
    console.log(`\n=== RAW Node.js HTTP Benchmark Server ===`);
    console.log(`Starting ${WORKERS} workers...`);

    cluster.schedulingPolicy = cluster.SCHED_RR; // Round-robin

    for (let i = 0; i < WORKERS; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code) => {
        if (code !== 0) {
            console.log(`Worker ${worker.process.pid} died, restarting...`);
            cluster.fork();
        }
    });

    setTimeout(() => {
        console.log(`\n✓ Raw Node.js server listening on http://${HOST}:${PORT}`);
        console.log(`✓ Using ${WORKERS} workers`);
        console.log(`\nRun benchmark:`);
        console.log(`  autocannon -c 100 -d 40 -p 10 http://${HOST}:${PORT}`);
        console.log(`\nThis is the THEORETICAL MAXIMUM for Node.js HTTP\n`);
    }, 1000);

} else {
    // Worker process - create minimal HTTP server
    const server = http.createServer((req, res) => {
        // Absolute minimal overhead
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': RESPONSE_LENGTH
        });
        res.end(RESPONSE_BODY);
    });

    server.listen(PORT, HOST);
}

