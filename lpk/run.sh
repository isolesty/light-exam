#!/bin/sh
set -eu
mkdir -p "${DATA_DIR:-/lzcapp/var}"
exec node /lzcapp/pkg/content/server.mjs
