#!/usr/bin/env bash

set -euo pipefail

if [[ "${WSL_DISTRO_NAME:-}" == "" ]]; then
  echo "This script is intended to run inside WSL." >&2
  exit 1
fi

REQUIRED_PACKAGES=(
  build-essential
  curl
  file
  libegl1-mesa-dev
  libgbm-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  libwebkit2gtk-4.1-dev
  libgtk-3-dev
  libpipewire-0.3-dev
  libwayland-dev
  pkg-config
)

missing_packages=()
for pkg in "${REQUIRED_PACKAGES[@]}"; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    missing_packages+=("$pkg")
  fi
done

echo "WSL distro: ${WSL_DISTRO_NAME}"
echo "Repo root: $(cd "$(dirname "$0")/.." && pwd)"
echo

if [[ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${ALL_PROXY:-}" ]]; then
  cat <<'EOF'
Detected proxy-related environment variables:
  HTTP_PROXY / HTTPS_PROXY / ALL_PROXY

If dependency downloads fail, verify the proxy still exists or unset these variables
before retrying cargo/npm commands.
EOF
  echo
fi

if ((${#missing_packages[@]} > 0)); then
  echo "Installing missing system packages:"
  printf '  - %s\n' "${missing_packages[@]}"
  sudo apt-get update
  sudo apt-get install -y "${missing_packages[@]}"
else
  echo "All required system packages are already installed."
fi

cat <<'EOF'

Next steps:
  1. npm install
  2. cargo check --workspace
  3. npm run tauri:dev
EOF
