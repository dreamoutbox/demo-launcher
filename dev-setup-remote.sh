#!/usr/bin/env bash
set -euo pipefail

QUEUE_NAME="demo-launcher-queue"
DLQ_NAME="my-queue-dlq"
DB_NAME="mydb"

echo "========================================================"
echo " Setting up Remote Cloudflare Resources"
echo "========================================================"

# 1. Create Queues
npx wrangler queues create "$QUEUE_NAME" || true
npx wrangler queues create "$DLQ_NAME" || true

# 2. Create D1 database and apply schema
npx wrangler d1 create "$DB_NAME" || true

echo "Applying schema to remote D1 database..."
npx wrangler d1 execute "$DB_NAME" --yes --remote --file=./schema.sql

echo "Running migrations if needed on remote D1 database..."
./dev-migrate.sh --remote

echo "Verifying project_demos table on remote D1..."
npx wrangler d1 execute "$DB_NAME" --remote --command="SELECT * FROM project_demos"

echo ""
echo "========================================================"
echo " Remote Production Secrets Setup"
echo "========================================================"
echo "This step configures the required secrets for remote deployment."
echo ""
echo "1. Cloudflare Turnstile Keys:"
echo "   - Open Cloudflare Dashboard -> Turnstile -> Add Site (or select existing site)."
echo "   - Add your production domain or workers.dev hostname."
echo "   - Copy the 'Site Key' and 'Secret Key'."
echo ""
echo "2. DigitalOcean API Key:"
echo "   - Open DigitalOcean Control Panel -> API -> Tokens/Keys."
echo "   - Generate a Personal Access Token with Read & Write access."
echo ""
echo "3. Admin & SSH Keys:"
echo "   - ADMIN_KEY secures /api/admin/* endpoints."
echo "   - DROPLET_SSH_PUBLIC_KEY & DROPLET_SSH_PRIVATE_KEY for droplet SSH access."
echo "   - Run ./dev-create-ssh-key.sh beforehand to generate local keys in ./ssh-keys/."
echo "========================================================"
echo ""

set_secret() {
    local key_name="$1"
    local prompt_msg="$2"
    local is_secret="${3:-false}"
    local default_file_or_val="${4:-}"
    local user_val=""

    echo "--------------------------------------------------------"
    echo "Configuration: ${key_name}"
    echo "${prompt_msg}"

    local prompt_label="Enter ${key_name}"
    if [ -n "${default_file_or_val}" ]; then
        prompt_label="${prompt_label} [default: ${default_file_or_val}]"
    fi

    if [ "${is_secret}" = "true" ]; then
        read -rsp "${prompt_label} (leave empty to skip): " user_val
        echo ""
    else
        read -rp "${prompt_label} (leave empty to skip): " user_val
    fi

    if [ -z "${user_val}" ] && [ -n "${default_file_or_val}" ]; then
        user_val="${default_file_or_val}"
    fi

    if [ -z "${user_val}" ]; then
        echo "Skipping ${key_name} (no value entered)."
        return 0
    fi

    if [ -f "${user_val}" ]; then
        echo "Reading ${key_name} from file: ${user_val}"
        user_val="$(cat "${user_val}")"
    fi

    printf "%s" "${user_val}" | npx wrangler secret put "${key_name}"
    echo "Successfully updated secret: ${key_name}"
}

DEFAULT_PUB_KEY=""
DEFAULT_PRIV_KEY=""
if [ -f "./ssh-keys/id_ed25519.pub" ]; then
    DEFAULT_PUB_KEY="./ssh-keys/id_ed25519.pub"
fi
if [ -f "./ssh-keys/id_ed25519" ]; then
    DEFAULT_PRIV_KEY="./ssh-keys/id_ed25519"
fi

set_secret "TURNSTILE_SITE_KEY" "Turnstile Site Key (public key used by frontend widget)" "false"
set_secret "TURNSTILE_SECRET_KEY" "Turnstile Secret Key (private key used for server-side siteverify)" "true"
set_secret "DO_API_KEY" "DigitalOcean API Token (for creating/destroying demo droplets)" "true"
set_secret "ADMIN_KEY" "Admin Key (used to authorize /api/admin/* endpoints)" "true" "demo-admin-key"
set_secret "DROPLET_SSH_PUBLIC_KEY" "DigitalOcean Droplet SSH Public Key (enter key or file path)" "false" "${DEFAULT_PUB_KEY}"
set_secret "DROPLET_SSH_PRIVATE_KEY" "DigitalOcean Droplet SSH Private Key (enter key or file path)" "true" "${DEFAULT_PRIV_KEY}"

echo ""
echo "========================================================"
echo "Remote setup complete."
echo "========================================================"
