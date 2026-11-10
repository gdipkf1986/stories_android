#!/bin/sh
set -eu

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
default_version="$(cat "$NVM_DIR/alias/default")"
version_dir="$NVM_DIR/versions/node/$default_version"

if [ ! -x "$version_dir/bin/node" ] && [ "$default_version" = "${default_version%%.*}" ]; then
  version_dir="$(find "$NVM_DIR/versions/node" -mindepth 1 -maxdepth 1 -type d -name "v$default_version.*" | sort -V | tail -n 1)"
fi

if [ -z "$version_dir" ] || [ ! -x "$version_dir/bin/node" ]; then
  echo "stories-scheduler: cannot resolve Node $default_version under $NVM_DIR" >&2
  exit 127
fi

exec "$version_dir/bin/node" "$@"
