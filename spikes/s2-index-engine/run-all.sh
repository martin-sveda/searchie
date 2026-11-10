#!/bin/sh
# Runs every S2 benchmark configuration in its own process, then prints the report.
set -e
cd "$(dirname "$0")"
rm -f out/result-*.json
for engine in node-sqlite sqlite-wasm; do
  for mode in real synthetic; do
    ../node.sh bench.mjs "$engine" "$mode" spec
  done
done
../node.sh bench.mjs node-sqlite synthetic noprefix
WORKER_HEAP_MB=256 ../node.sh bench.mjs node-sqlite real spec
WORKER_HEAP_MB=256 ../node.sh bench.mjs node-sqlite synthetic spec
../node.sh report.mjs
