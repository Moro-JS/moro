#!/usr/bin/env node

// Pure uWebSockets.js benchmark - NO framework overhead
// This establishes the theoretical maximum performance

import uWS from 'uWebSockets.js';

const port = 3113;

const app = uWS.App();

// Minimal "hello world" endpoint - exactly like Moro benchmark
// eslint-disable-next-line no-unused-vars
app.get('/', (res, req) => {
    res.cork(() => {
        res.writeStatus('200 OK');
        res.writeHeader('Content-Type', 'application/json');
        res.end('{"hello":"world"}');
    });
});

// String endpoint for comparison
// eslint-disable-next-line no-unused-vars
app.get('/string', (res, req) => {
    res.cork(() => {
        res.writeStatus('200 OK');
        res.end('{ hello: "world" }');
    });
});

app.listen(port, (token) => {
    if (token) {
        console.log('\n╔═══════════════════════════════════════════════════════╗');
        console.log('║   Pure uWebSockets.js Benchmark (NO Framework)      ║');
        console.log('╠═══════════════════════════════════════════════════════╣');
        console.log('║   Server:    uWebSockets.js (C++) - RAW             ║');
        console.log('║   Mode:      Single-threaded (no framework)         ║');
        console.log(`║   URL:       http://0.0.0.0:${port}                   ║`);
        console.log('║   Status:    Ready for benchmarking                 ║');
        console.log('╚═══════════════════════════════════════════════════════╝\n');

        console.log('Benchmark Commands:');
        console.log('------------------');
        console.log('JSON endpoint:');
        console.log(`  autocannon -c 500 -d 60 -p 10 http://127.0.0.1:${port}`);
        console.log('');
        console.log('String endpoint (fastest):');
        console.log(`  autocannon -c 500 -d 60 -p 10 http://127.0.0.1:${port}/string`);
        console.log('');
        console.log('Comparison:');
        console.log('  Port 3111: Moro (Node.js + 24 workers)');
        console.log('  Port 3112: Moro + uWebSockets (1 worker)');
        console.log('  Port 3113: Pure uWebSockets (NO framework)');
        console.log('');
    } else {
        console.log(`Failed to listen on port ${port}`);
    }
});

