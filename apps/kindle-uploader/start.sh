#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${DATA_DIR:-/data}" /tmp/kindle-uploads

exec node /app/server.mjs
