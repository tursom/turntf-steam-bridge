#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SDK_DIR="$PROJECT_DIR/../../sdk/turntf-js"
VENDOR_DIR="$PROJECT_DIR/vendor/turntf-js"

mkdir -p "$VENDOR_DIR/dist" "$VENDOR_DIR/proto"

cp -r "$SDK_DIR/dist/"   "$VENDOR_DIR/dist/"
cp -r "$SDK_DIR/proto/"  "$VENDOR_DIR/proto/"
cp "$SDK_DIR/LICENSE" "$VENDOR_DIR/" 2>/dev/null || true

node -e "
const p = require('$SDK_DIR/package.json');
const dep = {
  name: p.name,
  version: p.version,
  type: p.type,
  main: p.main,
  module: p.module,
  types: p.types,
  exports: p.exports,
  dependencies: p.dependencies
};
require('fs').writeFileSync('$VENDOR_DIR/package.json', JSON.stringify(dep, null, 2));
"

echo "vendor: turntf-js SDK vendored to $VENDOR_DIR"
