#!/usr/bin/env bash
set -euo pipefail

mode="${1:-local}"

if [[ "$mode" != "local" && "$mode" != "remote" ]]; then
  echo "Usage: $0 [local|remote]" >&2
  exit 1
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

files=(
  "migrations/0001_init.sql"
  "migrations/0002_claude_support.sql"
  "migrations/0003_yolo_mode.sql"
  "migrations/0004_agent_workdir.sql"
  "migrations/0005_default_user.sql"
  "migrations/0006_voice_selection.sql"
  "migrations/0007_agent_title.sql"
)

for file in "${files[@]}"; do
  pnpm wrangler d1 execute coder --"$mode" --file="$file"
done
