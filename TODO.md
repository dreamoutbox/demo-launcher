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

- [ ] env secret support. add secret env to demo server.

# CHORE

- [ ] make admin page use basic main.css

- [ ] add manual cron cleanup button to admin page.
