#!/bin/bash
# Copyright 2026 The Wazo Authors  (see the AUTHORS file)
# SPDX-License-Identifier: GPL-3.0-or-later

# Runs the benchmark in its smoke profile against the stub engine, to check
# that the script runs end to end. It says nothing about a real stack.
#   K6=/path/to/k6 contrib/dird-confd-benchmark/smoke.sh [extra k6 args]

set -euo pipefail

export K6_NO_USAGE_REPORT=true

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
port=${STUB_PORT:-8443}
trap 'kill "$stub_pid" 2>/dev/null || true; rm -rf "$work"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null

node "$here/stub-server.mjs" "$work/key.pem" "$work/cert.pem" "$port" &
stub_pid=$!
sleep 1

"${K6:-k6}" run \
  --env WAZO_ENGINE="127.0.0.1:$port" \
  --env WAZO_ADMIN_USERNAME=root --env WAZO_ADMIN_PASSWORD=secret \
  --env WAZO_TENANT=00000000-0000-0000-0000-000000000000 \
  --env LOAD_PROFILE=smoke --env ARM=smoke \
  --env MONITOR_CHECKS_PROMETHEUS_URL="https://127.0.0.1:$port" \
  --tag testid=smoke \
  "$@" "$root/scripts/on-demand/dird-confd-cache-benchmark.js"
