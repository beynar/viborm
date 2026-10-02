# Workers cold-start measurement

Measures VibORM against Drizzle on real Cloudflare Workers with D1. Every arm defines
the same two-model schema, creates a client per request, and runs one query
(`?q=unique|rows20|filtered20|relation20`).

CPU and wall time are read from **Workers Logs**. In-Worker clocks do not advance
during CPU work, so they cannot measure it. A redeploy starts a new version on
fresh isolates, so the first request of each round is a genuine cold start.

Results from runs so far are in `docs/architecture/performance-review/workers-cold-2026-10-01*.json`.

## Prerequisites

- The `cf` CLI (v1 beta), logged in (`cf auth whoami`).
- `export CLOUDFLARE_ACCOUNT_ID=<account id>` in every shell.
- A zone on that account for the route host (it was `viborm.dev`, host `perf.viborm.dev`).
- One VibORM `dist` per VibORM arm (`pnpm build`, then copy `dist` somewhere stable).
- For the Drizzle arm, a directory with `npm i drizzle-orm@1.0.0-rc.5-5935859`.

## Set up

```bash
# 1. The database and its seed (100 users, 1,000 posts).
cf d1 create --name viborm-perf            # note the database id
cf d1 query <database-id> --sql "$(node benchmarks/workers-cold/seed.mjs)"

# 2. A proxied DNS record for the route host. Workers routes need one; 100:: is the
#    placeholder Cloudflare recommends for route-only hosts.
cf dns records create -z viborm.dev --body '{"type":"AAAA","name":"perf.viborm.dev","content":"100::","proxied":true}'

# 3. One Worker project per arm (name=path). An arm whose name starts with
#    "drizzle" is a Drizzle arm; its path is the drizzle-orm package directory.
node benchmarks/workers-cold/generate.mjs --out /abs/workers \
  --arm viborm-now=/abs/dist --arm viborm-before=/abs/old-dist \
  --arm drizzle=/abs/drizzle-dir/node_modules/drizzle-orm \
  --database-id <database-id> --zone viborm.dev --host perf.viborm.dev

# 4. Per arm: install, then convert wrangler.jsonc to the cf config.
cd /abs/workers/viborm-now && npm install && cf migrate wrangler.jsonc
```

To measure a minified arm, copy an arm directory and change its name and route
pattern. Then add `minify: true` to its `wrangler.config.ts`. By default wrangler
re-prints an already minified `dist` with whitespace; for VibORM that is
539 → 781 KiB.

## Measure

```bash
start=$(date +%s000)
node benchmarks/workers-cold/drive.mjs --dir /abs/workers --host perf.viborm.dev \
  --arms viborm-now,viborm-before,drizzle --rounds 12 --per 3 --redeploy \
  --log /abs/requests.jsonl
sleep 60   # let Workers Logs ingest
node benchmarks/workers-cold/report.mjs \
  --services viborm-perf-viborm-now,viborm-perf-viborm-before,viborm-perf-drizzle \
  --from "$start" --to "$(date +%s000)" --json /abs/rows.json
```

The cold rows are the requests whose Worker logged `cold: true`, meaning the first
request of an isolate. Workers Logs reports CPU in whole milliseconds.

## Quirks

- **DNS:** `drive.mjs` resolves the host through 1.1.1.1. A freshly created record
  can stay negatively cached in the local resolver for a while.
- **Run-to-run variation:** absolute cold CPU varied between runs, from 15.8 ms to
  about 26 ms for the same build. Compare arms within one run, never across runs.
- **`cf deploy` requirements:** it needs `node_modules` in the project directory and
  wrangler declared in `package.json`. `generate.mjs` writes that declaration.

## Tear down

```bash
# Deletes ask for confirmation; --force confirms them non-interactively.
for w in viborm-perf-viborm-now viborm-perf-viborm-before viborm-perf-drizzle; do cf workers delete "$w" --force; done
cf d1 delete <database-id> --force
cf dns records list -z viborm.dev     # find the perf host's record id
cf dns records delete <record-id> -z viborm.dev --force
```
