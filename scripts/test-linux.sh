#!/usr/bin/env bash
# Run the MoroJS test suites inside a Linux container against the sibling
# "MoroJS Engine" working tree, built in the container: a dedicated, isolated
# run with its own dependencies (npm ci inside the container, so platform
# packages such as esbuild are the Linux ones) and the native engine's Linux
# binary. The engine tree is mounted read-write (its build/ receives the
# Linux binary); this repo is mounted read-only and copied.
#
#   scripts/test-linux.sh                 # unit + build + integration + e2e + fuzz
#   MORO_ENGINE_TRANSPORT=uring scripts/test-linux.sh   # the io_uring transport (opt-in)
#   scripts/test-linux.sh -- npm run test:unit          # any command in the container
set -euo pipefail
cd "$(dirname "$0")/.."
MOROJS="$PWD"
ENGINE="${MORO_ENGINE_DIR:-$(cd .. && pwd)/MoroJS Engine}"
[ -d "$ENGINE/packages/engine" ] || { echo "engine working tree not found at $ENGINE (set MORO_ENGINE_DIR)" >&2; exit 1; }
IMAGE="${IMAGE:-node:24-bookworm}"
CMD='npm run test:unit && npm run build && MORO_REQUIRE_ENGINE=1 npm run test:integration && npm run test:e2e && npm run test:fuzz'
if [ "${1:-}" = "--" ]; then shift; CMD="$*"; fi
TTY=(); [ -t 0 ] && TTY=(-it)
exec docker run --rm ${TTY[@]+"${TTY[@]}"} --security-opt seccomp=unconfined \
  -v "$MOROJS:/src/MoroJS:ro" -v "$ENGINE:/src/engine" -w /work \
  -e MORO_ENGINE_TRANSPORT="${MORO_ENGINE_TRANSPORT:-}" \
  -e MORO_ENGINE_REQUIRE_TRANSPORT="${MORO_ENGINE_REQUIRE_TRANSPORT:-}" \
  -e MORO_ENGINE_BATCH="${MORO_ENGINE_BATCH:-}" \
  "$IMAGE" bash -c '
    set -euo pipefail
    apt-get update -qq >/dev/null && apt-get install -y -qq clang lld llvm curl rsync >/dev/null
    uname -r
    mkdir -p /work && rsync -a --exclude node_modules --exclude dist --exclude .git /src/MoroJS/ /work/
    echo "== npm ci (Linux dependencies)"; npm ci --no-audit --no-fund 2>&1 | tail -1
    echo "== engine: Linux build in the mounted tree"; (cd /src/engine && node tools/build.mjs 2>&1 | tail -1)
    rm -rf node_modules/@morojs/engine node_modules/@morojs/engine-*
    ln -s /src/engine/packages/engine node_modules/@morojs/engine
    node -e "const p=require(\"@morojs/engine\").probe(); console.log(\"engine\", p.version, \"ok\", p.ok, \"transport\", p.transport, \"-\", p.transportReason, \"batch\", p.capabilities.batchDispatch)"
    '"$CMD"'
  '
