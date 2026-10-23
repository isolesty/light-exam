#!/bin/sh
set -eu
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$APP_DIR"
mkdir -p .lpk-content/public
cp server.mjs store.mjs domain.mjs auth.mjs .lpk-content/
cp public/index.html public/app.js public/styles.css public/login.html public/login.js public/question-manager.js .lpk-content/public/
cp lpk/run.sh .lpk-content/run.sh
chmod +x .lpk-content/run.sh
