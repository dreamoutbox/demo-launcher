npx wrangler d1 execute mydb --local --file=./schema.sql

npx wrangler dev --test-scheduled

curl -X POST http://localhost:8787/api/launch \
  -H "Content-Type: application/json" \
  -d '{"projectId": "awesome-shop-demo"}'

  curl http://localhost:8787/api/projects

  curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"