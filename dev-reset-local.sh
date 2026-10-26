#!/usr/bin/env bash
set -euo pipefail

# reset_local_d1: Drops existing application tables, re-applies schema.sql, and runs pending migrations on local D1.
# Input:
#   $1 - database name (string, defaults to "mydb")
# Example usage:
#   reset_local_d1 "mydb"
reset_local_d1() {
    local db_name="${1:-mydb}"

    echo "Resetting local D1 database: ${db_name}..."

    # Drop existing tables to ensure clean state
    pnpm wrangler d1 execute "${db_name}" --yes --local --command="DROP TABLE IF EXISTS project_demos; DROP TABLE IF EXISTS action_logs; DROP TABLE IF EXISTS d1_migrations;"

    # Re-create base schema
    pnpm wrangler d1 execute "${db_name}" --yes --local --file=./schema.sql

    # Apply any pending migrations
    ./dev-migrate.sh --local

    # Verify tables are initialized and empty
    pnpm wrangler d1 execute "${db_name}" --local --command="SELECT count(*) AS project_demos_count FROM project_demos; SELECT count(*) AS action_logs_count FROM action_logs;"

    echo "Local D1 database '${db_name}' successfully reset."
}

reset_local_d1 "${1:-mydb}"
