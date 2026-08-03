#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
APP="$ROOT/company-os-app"
LOG="$ROOT/company-os-dev.log"
PID_FILE="$ROOT/.company-os-dev.pid"

if [ ! -f "$APP/package.json" ]; then
  echo "Company OS has not been prepared yet."
  exit 1
fi

if curl -fsS http://127.0.0.1:3000 >/dev/null 2>&1; then
  echo "Company OS is already running on port 3000."
  exit 0
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Company OS process is already starting."
  exit 0
fi

cd "$APP"
nohup npm run dev -- --hostname 0.0.0.0 > "$LOG" 2>&1 &
echo $! > "$PID_FILE"

echo "Starting Company OS on port 3000..."
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000 >/dev/null 2>&1; then
    echo "Company OS is ready."
    exit 0
  fi
  sleep 2
done

echo "The server did not become ready. Check: $LOG"
exit 1
