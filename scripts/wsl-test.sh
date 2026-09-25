#!/usr/bin/env bash
# Rust tests of the on-chain program, run in WSL. Call it from PowerShell, not from
# Git Bash:
#   wsl.exe -e bash /mnt/<path-to-repo>/scripts/wsl-test.sh
# Git Bash mangles the /mnt/ path and bash -c swallows quotes, so the command lives
# in a file. This is not part of `pnpm gate`: the gate runs on Windows and in CI,
# where cargo is not on the path.
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

cd "$(dirname "$0")/.."
cargo fmt --all -- --check
cargo test --workspace
