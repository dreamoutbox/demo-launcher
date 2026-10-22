#!/usr/bin/env bash
set -euo pipefail

DB_NAME="mydb"

# load schema to local d1
npx wrangler d1 execute $DB_NAME --yes --local --file=./schema.sql

# query select local mydb project_demos
npx wrangler d1 execute $DB_NAME --local --command="SELECT * FROM project_demos"

npx wrangler d1 execute $DB_NAME --local --command="SELECT * FROM action_logs"

echo ""
echo "========================================================"
echo " Local Secrets Setup (.dev.vars / .env)"
echo "========================================================"
echo "Configures ADMIN_KEY, DROPLET_SSH_PUBLIC_KEY, and DROPLET_SSH_PRIVATE_KEY."
echo "Tip: Run ./dev-create-ssh-key.sh beforehand to generate local keys."
echo "========================================================"
echo ""

write_env_var() {
    local target_file="$1"
    local key="$2"
    local val="$3"

    touch "${target_file}"

    # Escape backslashes, double quotes, and convert newlines to \n for dotenv format
    local escaped="${val//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    escaped="${escaped//$'\n'/\\n}"

    if grep -q "^${key}=" "${target_file}" 2>/dev/null; then
        grep -v "^${key}=" "${target_file}" > "${target_file}.tmp" || true
        mv "${target_file}.tmp" "${target_file}"
    fi

    # Ensure trailing newline before appending
    if [ -s "${target_file}" ] && [ -n "$(tail -c 1 "${target_file}")" ]; then
        echo "" >> "${target_file}"
    fi

    printf '%s="%s"\n' "${key}" "${escaped}" >> "${target_file}"
}

set_local_secret() {
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

    write_env_var ".dev.vars" "${key_name}" "${user_val}"
    if [ -f ".env" ]; then
        write_env_var ".env" "${key_name}" "${user_val}"
    fi
    echo "Successfully saved ${key_name}."
}

if [ ! -f ".dev.vars" ] && [ -f ".env" ]; then
    cp .env .dev.vars
fi

DEFAULT_PUB_KEY=""
DEFAULT_PRIV_KEY=""
if [ -f "./ssh-keys/id_ed25519.pub" ]; then
    DEFAULT_PUB_KEY="./ssh-keys/id_ed25519.pub"
fi
if [ -f "./ssh-keys/id_ed25519" ]; then
    DEFAULT_PRIV_KEY="./ssh-keys/id_ed25519"
fi

set_local_secret "ADMIN_KEY" "Admin Key (used to authorize /api/admin/* endpoints)" "false" "demo-admin-key"
set_local_secret "DROPLET_SSH_PUBLIC_KEY" "DigitalOcean Droplet SSH Public Key (enter key or file path)" "false" "${DEFAULT_PUB_KEY}"
set_local_secret "DROPLET_SSH_PRIVATE_KEY" "DigitalOcean Droplet SSH Private Key (enter key or file path)" "true" "${DEFAULT_PRIV_KEY}"

echo ""
echo "========================================================"
echo "Local setup complete."
echo "========================================================"
