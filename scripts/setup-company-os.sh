#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f "company-os/package.json" ]; then
  echo "Reconstructing Company OS..."
  cat company-os-archive/part-* | base64 -d > /tmp/company-os.zip
  rm -rf "$ROOT_DIR/company-os" /tmp/company-os-extract
  mkdir -p /tmp/company-os-extract
  unzip -q /tmp/company-os.zip -d /tmp/company-os-extract
  mv /tmp/company-os-extract/company-os "$ROOT_DIR/company-os"
  rm -rf /tmp/company-os-extract /tmp/company-os.zip
fi

grep -qxF "company-os/" .git/info/exclude 2>/dev/null || echo "company-os/" >> .git/info/exclude

cd company-os

if [ ! -f .env ]; then
  cp .env.example .env
fi

npm install
npm run db:setup

echo "Company OS is ready."
echo "Run: cd company-os && npm run dev -- --hostname 0.0.0.0"
