#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
APP="$ROOT/company-os-app"
TMP="/tmp/company-os-import"

if [ ! -f "$APP/package.json" ]; then
  echo "Preparing Company OS project..."
  rm -rf "$APP" "$TMP"
  mkdir -p "$TMP"

  test -d "$ROOT/company-os-archive"
  cat "$ROOT"/company-os-archive/part-* | tr -d '\r\n' > "$TMP/company-os.zip.b64"
  base64 --decode "$TMP/company-os.zip.b64" > "$TMP/company-os.zip"
  unzip -q "$TMP/company-os.zip" -d "$TMP/extracted"
  test -f "$TMP/extracted/company-os/package.json"

  mv "$TMP/extracted/company-os" "$APP"
  rm -f "$APP/.env"
  cp "$APP/.env.example" "$APP/.env"
fi

cd "$APP"
echo "Installing packages..."
npm install

echo "Preparing local database..."
npm run db:setup

echo "Company OS is ready."
