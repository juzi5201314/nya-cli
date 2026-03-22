#!/usr/bin/env bash
set -euo pipefail

# Idempotent environment setup for workers.

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but was not found in PATH" >&2
  exit 1
fi

bun install --frozen-lockfile
