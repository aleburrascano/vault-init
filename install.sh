#!/usr/bin/env bash
# Install vault-init — one command, any machine.
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/aleburrascano/vault-init/main/install.sh)
set -euo pipefail

REPO="aleburrascano/vault-init"
DEST="$HOME/bin/vault-init"

echo "Installing vault-init..."
mkdir -p "$HOME/bin"
curl -fsSL "https://raw.githubusercontent.com/$REPO/main/vault-init" -o "$DEST"
chmod +x "$DEST"

# Add ~/bin to PATH in shell rc files if missing
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
    [ -f "$rc" ] || continue
    grep -q 'HOME/bin' "$rc" || echo 'export PATH="$HOME/bin:$PATH"' >> "$rc"
done

echo ""
echo "vault-init installed to $DEST"
echo ""
echo "Usage:   vault-init <wiki-name> [--private]"
echo "Example: vault-init architecture-wiki"
echo ""
echo "Prerequisites: git, node 22+, npm, gh (GitHub CLI)"
echo "               gh auth login  (once, if not already done)"
echo ""
echo "Reload your shell first: source ~/.bashrc   (or open a new terminal)"
