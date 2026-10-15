# load schema to remote d1
npx wrangler d1 execute mydb --remote --file=./schema.sql
# --yes

# query select remote d1
npx wrangler d1 execute mydb --remote --command="SELECT * FROM Customers"
