#!/bin/sh
# 中文注释：默认只预览；用户显式 --apply 后才新建专用 profile。
set -eu
exec python3 "$(dirname "$0")/setup-copilot-profile.py" "$@"
