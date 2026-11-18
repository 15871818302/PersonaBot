#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
mkdir -p release
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
plugin=external/personal-bot
install -Dm644 deploy/koishi.yml "$stage/koishi.yml"
for path in package.json yarn.lock .yarnrc.yml .yarn/releases/yarn-4.5.3.cjs "$plugin/package.json" "$plugin/lib/index.js"; do
  install -Dm644 "$path" "$stage/$path"
done
# Native dependencies will be installed for the architecture of the server.
archive=$(mktemp release/.qq-bot.XXXXXX)
trap 'rm -rf "$stage"; rm -f "$archive"' EXIT
tar -czf "$archive" -C "$stage" .
mv -f "$archive" release/qq-bot.tar.gz
echo 'release/qq-bot.tar.gz'
