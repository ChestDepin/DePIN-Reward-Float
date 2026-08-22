#!/usr/bin/env bash
# Збірка ончейн-програми у WSL. Кликати з PowerShell, не з Git Bash:
#   wsl.exe -e bash /mnt/<path-to-repo>/scripts/wsl-build.sh
# Git Bash псує /mnt/-шлях, а bash -c ковтає лапки — тому команда лежить файлом.
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

cd "$(dirname "$0")/.."
anchor build
