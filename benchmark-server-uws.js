#!/usr/bin/env node

// MoroJS with uWebSockets "Hello World" server
// Ultra-high performance C++ HTTP server
// Run with: NODE_ENV=production LOG_LEVEL=warn node benchmark-server-uws.js
// Or override port/host: PORT=8080 HOST=0.0.0.0 node benchmark-server-uws.js

process.env.NODE_ENV = 'production';
import { createApp } from './dist/index.js';


const app = createApp({
    server: {
        port: 3112,        // Different port from regular benchmark (can be overridden by PORT env var)
        host: '127.0.0.1',  // Default benchmark host (can be overridden by HOST env var)
        useUWebSockets: true, // ⚡ ENABLE UWEBSOCKETS FOR MAXIMUM PERFORMANCE
        requestTracking: {
            enabled: false, // Disable IDs for max performance
        },
        requestLogging: {
            enabled: false, // But still log requests for production monitoring
        },
        errorBoundary: {
            enabled: false, // Disable for fair comparison
        },
    },
    // Clustering doesn't work with uWebSockets - single-threaded only
    performance: {
        clustering: {
            enabled: false,
        },
    },

    // Minimal logging for benchmarks
    logger: {
        level: 'warn'
    }
})

// Minimal "hello world" endpoint (mimic the uws raw benchmark)
app.get('/', (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'application/json');
    res.send('{"hello":"world"}');
});

// No JSON Header "hello world" endpoint - fastest possible response
app.get('/string', function (_req, _res) {
    _res.end('{ hello: "world" }');
});

// Start server using config system (respects PORT and HOST env var)
app.listen(() => {
    setTimeout(() => {
        const config = app.getConfig();

        // DIAGNOSTIC: Check which HTTP server is actually being used
        const httpServer = app.core.httpServer;
        const serverType = httpServer.constructor.name;
        const isUWS = serverType === 'UWebSocketsHttpServer';
        const actualServerType = isUWS ? 'uWebSockets.js (C++)' : `Node.js (${serverType})`;

        console.log(`\n╔═══════════════════════════════════════════════════════╗`);
        console.log(`║   MoroJS + uWebSockets Benchmark Server              ║`);
        console.log(`╠═══════════════════════════════════════════════════════╣`);
        console.log(`║   Server:    ${actualServerType.padEnd(37)} ║`);
        console.log(`║   Mode:      Single-threaded (optimized wrappers)   ║`);
        console.log(`║   URL:       http://0.0.0.0:${config.server.port}                   ║`);
        console.log(`║   Status:    Ready for benchmarking                  ║`);
        console.log(`╚═══════════════════════════════════════════════════════╝\n`);

        if (!isUWS) {
            console.log(`⚠️  WARNING: uWebSockets is NOT running!`);
            console.log(`   Possible reasons:`);
            console.log(`   1. uWebSockets.js not installed: npm install --save-dev github:uNetworking/uWebSockets.js#v20.52.0`);
            console.log(`   2. Build failed: npm run build`);
            console.log(`   3. Config not loaded properly\n`);
        }

        console.log(`Benchmark Commands:`);
        console.log(`------------------`);
        console.log(`JSON endpoint:`);
        console.log(`  autocannon -c 100 -d 40 -p 10 http://127.0.0.1:${config.server.port}`);
        console.log(``);
        console.log(`String endpoint (fastest):`);
        console.log(`  autocannon -c 100 -d 40 -p 10 http://127.0.0.1:${config.server.port}/string`);
        console.log(``);
        console.log(`High concurrency test (recommended):`);
        console.log(`  autocannon -c 500 -d 60 -p 10 http://127.0.0.1:${config.server.port}`);
        console.log(``);
        console.log(`Compare all three implementations:`);
        console.log(`  # Terminal 1: node benchmark-server.js          (port 3111)`);
        console.log(`  # Terminal 2: node benchmark-server-uws.js      (port 3112)`);
        console.log(`  # Terminal 3: node benchmark-uws-raw.js         (port 3113)`);
        console.log(`  # Terminal 4: autocannon -c 500 -d 60 -p 10 http://127.0.0.1:PORT`);
        console.log(``);
        console.log(`This tests:`);
        console.log(`  3111: Moro (Node.js + 24 workers)         - Multi-core`);
        console.log(`  3112: Moro + uWebSockets (minimal wrapper) - Single-core`);
        console.log(`  3113: Pure uWebSockets (no framework)      - Single-core`);
        console.log(``);
    }, 1000);
});
