#!/usr/bin/env bash
set -euo pipefail

# Migrations are idempotent; we check schema before applying ALTER statements.
mode="${1:-local}"

if [[ "$mode" != "local" && "$mode" != "remote" ]]; then
  echo "Usage: $0 [local|remote]" >&2
  exit 1
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

run_file() {
  local file="$1"
  pnpm wrangler d1 execute sled --"$mode" --file="$file"
}

run_sql() {
  local sql="$1"
  pnpm wrangler d1 execute sled --"$mode" --command "$sql"
}

column_exists() {
  local table="$1"
  local column="$2"
  pnpm wrangler d1 execute sled --"$mode" --command "SELECT 1 FROM pragma_table_info('${table}') WHERE name='${column}' LIMIT 1;" --json \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); present=any((entry.get("results") or []) for entry in data); sys.exit(0 if present else 1)'
}

# 0001: base schema (idempotent)
run_file "migrations/0001_init.sql"

# 0002: Claude support (guarded per column)
if ! column_exists "agents" "type"; then
  run_sql "ALTER TABLE agents ADD COLUMN type TEXT DEFAULT 'gemini';"
fi
if ! column_exists "users" "anthropic_api_key"; then
  run_sql "ALTER TABLE users ADD COLUMN anthropic_api_key TEXT;"
fi

# 0003: yolo mode
if ! column_exists "agents" "yolo"; then
  run_sql "ALTER TABLE agents ADD COLUMN yolo INTEGER DEFAULT 0;"
fi

# 0004: workdir
if ! column_exists "agents" "workdir"; then
  run_sql "ALTER TABLE agents ADD COLUMN workdir TEXT;"
fi

# 0005: default user/session (idempotent)
run_file "migrations/0005_default_user.sql"

# 0006: voice selection
if ! column_exists "agents" "voice"; then
  run_sql "ALTER TABLE agents ADD COLUMN voice TEXT;"
fi
if ! column_exists "users" "default_voice"; then
  run_sql "ALTER TABLE users ADD COLUMN default_voice TEXT;"
fi

# 0007: agent title
if ! column_exists "agents" "title"; then
  run_sql "ALTER TABLE agents ADD COLUMN title TEXT;"
fi
