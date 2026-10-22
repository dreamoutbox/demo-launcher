#!/usr/bin/env bash
set -euo pipefail

DB_NAME="mydb"

# load schema to local d1
npx wrangler d1 execute $DB_NAME --yes --local --file=./schema.sql

# query select local mydb project_demos
npx wrangler d1 execute $DB_NAME --local --command="SELECT * FROM project_demos"

npx wrangler d1 execute $DB_NAME --local --command="SELECT * FROM action_logs"
