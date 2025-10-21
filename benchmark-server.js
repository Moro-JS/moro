#!/usr/bin/env node

// MoroJS "Hello World" server - matches Fastify benchmark methodology
// Equivalent to their express/fastify test servers
// Run with: NODE_ENV=production LOG_LEVEL=warn node benchmark-server.js
// Or override port/host: PORT=8080 HOST=0.0.0.0 node benchmark-server.js

process.env.NODE_ENV = 'production';
import { createApp } from './dist/index.js';


const app = createApp({
    server: {
        port: 3111,        // Default benchmark port (can be overridden by PORT env var)
        host: '127.0.0.1',  // Default benchmark host (can be overridden by HOST env var)
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
    // Minimal middleware for fair comparison
    performance: {
        clustering: {
            enabled: true, // unleash the power of clustering
            workers: 'auto',
        },
    },

    // Minimal logging for benchmarks
    logger: {
        level: 'warn'
    }
})

// Minimal "hello world" endpoint
app.get('/', () => {
    return { hello: 'world' };
});

// No JSON Header "hello world" endpoint
app.get('/string', function (_req, _res) {
    _res.end('{ hello: "world" }');
});

// Start server using config system (respects PORT and HOST env vars)
app.listen(() => {
    setTimeout(() => {
        const config = app.config;
        console.log(`MoroJS benchmark server listening on http://${config.server.host}:${config.server.port}`);
        console.log('Ready for autocannon benchmarking');
        console.log(`Run: autocannon -c 100 -d 40 -p 10 http://${config.server.host}:${config.server.port}`);
        console.log(`No JSON Header Run: autocannon -c 100 -d 40 -p 10 http://${config.server.host}:${config.server.port}/string`);
    }, 1000);
});
