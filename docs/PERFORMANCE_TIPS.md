# MoroJS Performance Optimization Guide

This guide collects host-, runtime-, and OS-level tuning tips for squeezing
more throughput out of a MoroJS server, plus advice on running load tests
that actually reflect production behaviour.

> **Numbers:** For official, methodology-backed throughput figures and
> framework comparisons, see the
> **[MoroJS Benchmark repo](https://github.com/Moro-JS/benchmark)** — don't
> rely on ad-hoc numbers from a single machine. The headline reference figures
> are summarised in [Expected Results](#expected-results) below.

## Server-Side Optimizations

### 1. Run in production mode

Always benchmark and deploy with production settings so development-only
logging and checks are disabled. Replace `your-server.js` with your own server
entry point:

```bash
NODE_ENV=production LOG_LEVEL=error node your-server.js
```

### 2. Node.js Runtime Optimizations

```bash
# Increase max old space size
NODE_OPTIONS="--max-old-space-size=8192" NODE_ENV=production LOG_LEVEL=error node your-server.js

# Enable additional V8 tuning
NODE_OPTIONS="--max-old-space-size=8192 --optimize-for-size" NODE_ENV=production LOG_LEVEL=error node your-server.js
```

Measure before and after — the right flags depend on your workload and
hardware, so treat these as starting points rather than guaranteed wins.

### 3. System-Level Optimizations

```bash
# Increase file descriptor limits
ulimit -n 65536

# Disable CPU frequency scaling (Linux)
echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Pin the process to specific cores (if needed)
taskset -c 0-23 node your-server.js
```

## Load-Testing the Server

### 1. Autocannon settings

```bash
# Baseline: 100 connections, 10 pipelining
autocannon -c 100 -d 40 -p 10 http://127.0.0.1:3000/

# Push harder: more connections and pipelining
autocannon -c 200 -d 40 -p 20 http://127.0.0.1:3000/
autocannon -c 500 -d 40 -p 50 http://127.0.0.1:3000/
```

Pipelining (`-p`) inflates request counts dramatically and does **not** model
typical real-world traffic. Report pipelined and non-pipelined results
separately so the numbers are comparable to the benchmark repo.

### 2. Alternative benchmark tools

```bash
# wrk (C-based, higher ceiling than autocannon)
brew install wrk
wrk -t24 -c1000 -d40s http://127.0.0.1:3000/

# hey (Go-based)
go install github.com/rakyll/hey@latest
hey -n 1000000 -c 1000 http://127.0.0.1:3000/
```

### 3. Measure clustering from a separate machine

When you run the load generator on the same box as the server, the two compete
for CPU cores and the clustered numbers are understated. Drive load from a
separate machine to see the real per-core scaling.

## Expected Results

Reference figures measured on an Apple M2 Ultra (single thread, `wrk`, no
pipelining unless noted) — they scale with your hardware:

- **~102k req/sec on a single thread** with the default native engine
  (`wrk`, no pipelining)
- **~572k req/sec** in pipelined ×10 microbenchmarks (TechEmpower-style)
- **Clustering multiplies throughput across CPU cores** — measure it from a
  separate load machine, as noted above
- **Lower latency** under high load

See the [MoroJS Benchmark repo](https://github.com/Moro-JS/benchmark) for the
full methodology, saved result files, and up-to-date comparisons.
