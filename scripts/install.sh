#!/usr/bin/env bash
set -euo pipefail
command -v node >/dev/null || { echo 'Install Node.js 24 or newer, then run this command again.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { echo 'Node.js 24 or newer is required.' >&2; exit 1; }
acadence_tmp=$(mktemp -d)
trap 'rm -rf "$acadence_tmp"' EXIT
acadence_release=https://github.com/trckster/acadence/releases/latest/download
curl --proto '=https' --tlsv1.2 -fsSL "$acadence_release/acadence.tgz" -o "$acadence_tmp/acadence.tgz"
curl --proto '=https' --tlsv1.2 -fsSL "$acadence_release/SHA256SUMS" -o "$acadence_tmp/SHA256SUMS"
(cd "$acadence_tmp" && if command -v sha256sum >/dev/null; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi)
npm install --global --prefix "$HOME/.local" "$acadence_tmp/acadence.tgz"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    for acadence_rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
      if ! test -f "$acadence_rc" || ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$acadence_rc"; then
        printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$acadence_rc"
      fi
    done
    echo 'Open a new terminal, or run: export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac
echo 'Installed. Run: acadence login'
