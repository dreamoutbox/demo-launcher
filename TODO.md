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

- [x] add force stop api route, delete droplet. when demo instance stuck at launching.

- [x] fix stuck at `LAUNCHING` status if worker reload in dev.

- [x] fix health check problem

- [x] make manual CRON clean up use admin key instead of error "Cleanup failed: Manual cron trigger is only allowed in development"

- [x] add turnstile to admin api and frontend

- [x] add highlight color to all actions in /admin/action_log

- [x] git branch to deploy

- [x] firewall allowed incoming ports. extend default firewall rules.

- [x] limit instances count

- [x] rename `src/helper.ts` `checkHealth` -> `checkHealthSocket` and move to `src/healthcheck.ts`

---

#### we will now store projects.json inside DB instead

- [x] user will now copy projects.template.json -> rename to projects.json.

- [x] gitignore projects.json

- [x] add shell script to read projects.json and insert records to DB. store every field in json. secret are okay to store. the import function should be separate function for use in admin page.

- [x] add reset projects table script. should not delete created droplets record. for admin to view and delete droplets that created before the reset.

- [x] add new admin page for view created droplets. get by fetch DO API. should have info, add button to destroy the droplet.

- [x] add new page for import projects.json to DB. with input text area for paste json. add server side validation. if success show success message and reload table.

- [x] add env (for secret) in projects.json

- [x] created droplets should have secret envs set.

---

- [ ] FIX dev env create real DO droplets even `DO_USE_REAL_API=0`

---

# CHORE

- [x] make admin page use basic main.css

- [x] add manual cron cleanup button to admin page.

- [x] add proper markdown render to Project README view.

---

# BACKLOG

- [ ] set REPO_URL and DROPLET_IP env in created demo droplet

- [ ] statistics collect where user come from, with `?ref=` in link

- [ ] new method user to create demo instance: user enter email → send email to user with link+token → user open link -> backend validate token -> launch droplet
