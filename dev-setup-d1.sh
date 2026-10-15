#!/usr/bin/env bash
set -euo pipefail

# load schema to remote d1
npx wrangler d1 execute mydb --yes --remote --file=./schema.sql

# query select remote d1
# npx wrangler d1 execute mydb --remote --command="SELECT * FROM Customers"
npx wrangler d1 execute mydb --remote --command="SELECT * FROM project_demos"
