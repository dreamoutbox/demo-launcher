#!/usr/bin/env bash
set -euo pipefail

QUEUE_NAME="demo-launcher-queue"
DB_NAME="mydb"

npx wrangler queues create $QUEUE_NAME

# create a new d1 database
npx wrangler d1 create $DB_NAME

# load schema to remote d1
npx wrangler d1 execute $DB_NAME --yes --remote --file=./schema.sql

# query select remote d1
# npx wrangler d1 execute $DB_NAME --remote --command="SELECT * FROM Customers"
npx wrangler d1 execute $DB_NAME --remote --command="SELECT * FROM project_demos"
