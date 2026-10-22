# TODO

- [x] custom DO creation settings with ENV.

- [ ] refactor mutex in Durable Object

- [x] add action logs with IP logging

- [x] droplet. use ssh key instead of password. set SSH public key and private key in secret.

- [x] create firewall if not exists. create tag for droplet to attach to.

- [x] D1 database. "project_demos" table add tags field.

- [x] attach droplets to firewall. by add tag to droplet.

- [x] allow time range schedule, env `LAUNCH_ALLOW_TIME_RANGE=07:00:00-20:00:00,21:00:00-23:00:00`

- [x] custom machine types in projects.json

- [x] convert `MAX_DEMO_TIME` to ENV `MAX_DEMO_TIME_SECONDS`

- [x] add ping health check

- [ ] make projects.json as secret. use `npx wrangler secret put PROJECTS_JSON < projects.json`

- [ ] add shell script for update `PROJECTS_JSON` secret.

- [ ] make `dev.sh` script update local `PROJECTS_JSON` secret.

- [ ] env secret support. add secret env (from project spec in `PROJECTS_JSON`) to demo server.

# CHORE

- [x] make admin page use basic main.css

- [x] add manual cron cleanup button to admin page.

- [ ] add markdown render to Project README view.
