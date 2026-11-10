#!/bin/sh
# Runs VS Code's bundled Electron Node (same runtime as the extension host).
# Override with SEARCHIE_NODE=/path/to/node to use a standalone Node.
if [ -n "$SEARCHIE_NODE" ]; then exec "$SEARCHIE_NODE" "$@"; fi
CODE_BIN="${CODE_BIN:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"
ELECTRON_RUN_AS_NODE=1 exec "$CODE_BIN" "$@"
