#!/usr/bin/env bash
set -euo pipefail

# Creates an ED25519 SSH key pair for DigitalOcean droplets and stores them in ./ssh-keys/
#
# Usage:
#   ./dev-create-ssh-key.sh
#   ./dev-create-ssh-key.sh --force

KEYS_DIR="./ssh-keys"
PRIVATE_KEY="${KEYS_DIR}/id_ed25519"
PUBLIC_KEY="${KEYS_DIR}/id_ed25519.pub"
FORCE="${1:-}"

mkdir -p "${KEYS_DIR}"
chmod 700 "${KEYS_DIR}"

if [ -f "${PRIVATE_KEY}" ] && [ "${FORCE}" != "--force" ]; then
    echo "SSH key already exists at ${PRIVATE_KEY}."
    echo "Skipping key generation. Pass --force to regenerate."
    exit 0
fi

if [ -f "${PRIVATE_KEY}" ] && [ "${FORCE}" = "--force" ]; then
    echo "Removing existing SSH keys..."
    rm -f "${PRIVATE_KEY}" "${PUBLIC_KEY}"
fi

echo "Generating new ED25519 SSH key pair..."
ssh-keygen -t ed25519 -C "demo-launcher" -f "${PRIVATE_KEY}" -N "" -q

chmod 600 "${PRIVATE_KEY}"
chmod 644 "${PUBLIC_KEY}"

echo "========================================================"
echo "SSH key pair created successfully!"
echo "  Private key: ${PRIVATE_KEY}"
echo "  Public key:  ${PUBLIC_KEY}"
echo "========================================================"
