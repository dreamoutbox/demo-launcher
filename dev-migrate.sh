#!/usr/bin/env bash
set -euo pipefail

DB_NAME="mydb"
TARGET="${1:---local}"

if [ "$TARGET" != "--local" ] && [ "$TARGET" != "--remote" ]; then
    echo "Usage: $0 [--local|--remote]"
    exit 1
fi

echo "Checking D1 database ($TARGET) for project_demos migrations..."

# Check which columns already exist on project_demos
TABLE_INFO=$(npx wrangler d1 execute "$DB_NAME" "$TARGET" --command="PRAGMA table_info(project_demos)" --json)

if echo "$TABLE_INFO" | grep -q '"name": "tags"'; then
    echo "Column 'tags' already exists on project_demos. Skipping migration."
else
    echo "Applying migration: adding 'tags' column to project_demos..."
    npx wrangler d1 execute "$DB_NAME" "$TARGET" --yes --file=./migrations-manual/0001_project_demos_add_tags.sql
    echo "Migration completed successfully."
fi

if echo "$TABLE_INFO" | grep -q '"name": "attempt_id"'; then
    echo "Column 'attempt_id' already exists on project_demos. Skipping migration."
else
    echo "Applying migration: adding 'attempt_id' column to project_demos..."
    npx wrangler d1 execute "$DB_NAME" "$TARGET" --yes --file=./migrations-manual/0002_project_demos_add_attempt_id.sql
    echo "Migration completed successfully."
fi

# Check if 'projects' table exists
PROJECTS_TABLE=$(npx wrangler d1 execute "$DB_NAME" "$TARGET" --command="SELECT name FROM sqlite_master WHERE type='table' AND name='projects'" --json)
if echo "$PROJECTS_TABLE" | grep -q '"name": "projects"'; then
    echo "Table 'projects' already exists. Skipping migration."
else
    echo "Applying migration: creating 'projects' table..."
    npx wrangler d1 execute "$DB_NAME" "$TARGET" --yes --file=./migrations-manual/0003_create_projects_table.sql
    echo "Migration completed successfully."
fi
