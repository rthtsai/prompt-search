#!/bin/zsh
set -eu
cd "$(dirname "$0")"
task_node="$(command -v node || true)"
if [[ -z "$task_node" ]]; then
  task_node='/Users/richardtsai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
fi
if [[ ! -x "$task_node" ]]; then
  print '需要 Node.js 24 或以上，請先安裝。'
  exit 1
fi
"$task_node" src/cli.ts demo
print '\n範例已完成。詳細操作請查看 README.md。'
if [[ -t 0 ]]; then read -r '?按 Enter 關閉…'; fi
