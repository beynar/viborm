# Probe corpus

Each probe checks one plan item of the 1.2.0 program ([completion plan](../docs/architecture/completion-plan-2026-10.md)) against an installed viborm package. `pass` means the 1.2.0 **target** behaviour holds, so most probes fail on 1.1.0.

## Contract

A probe is `probes/<area>/<item>.probe.mjs`. The areas are `postgres`, `outcomes`, `sqlite`, `workers`, `track-a` and `track-b`. `runner/` holds the runner's self-test probes, which run only when `--only` names that folder.

```js
import { createClient } from "viborm/sqlite3"; // by package name only

export const meta = {
  id: "S1",
  title: "Time limits on the migration session",
  plan: "phase-1/lane-P",
  needs: [], // or ["pg"], ["mysql"]
  source: "<the review or code-check probe it comes from>",
};

export default async function probe(ctx) {
  // ctx = { pgUrl?, mysqlUrl?, tmpDir, version }
  return { status: "pass" | "fail", evidence: "first line is the summary" };
}
```

- The runner reports `skip` when `needs` names a service without a URL. Such a probe is imported but never run.
- Throwing, an invalid result, or exceeding the time limit is reported as `error`.
- Each probe runs in its own Node process, in a temporary consumer holding the tarball as `node_modules/viborm` plus `better-sqlite3`, `@electric-sql/pglite`, `pg`, `postgres`, `mysql2`, `@libsql/client` and `@neondatabase/serverless`. These are linked from this checkout's install; nothing is installed from npm.
- The module must load on 1.1.0, so it can report `fail` rather than `error`. To reach an API that 1.1.0 lacks, use a namespace import (`import * as migrations from "viborm/migrations"`) or a dynamic `import()` inside `probe`.
- Write files only under `ctx.tmpDir`, a fresh directory for each probe.

## Running

```sh
pnpm package:build && pnpm probes                 # this checkout, packed
pnpm probes --tarball path/to/viborm-x.y.z.tgz    # a given tarball
pnpm probes --version 1.1.0                       # a published version (npm pack)
pnpm probes --only S1                             # one id; a glob also matches ids or area/item paths
pnpm probes --only 'sqlite/*' --md status.md --json status.json
```

`--timeout <ms>` changes the time limit for each probe (the default is 120000).

The Docker databases are reached through two environment variables:

```sh
VIBORM_PROBE_PG_URL=postgres://postgres:password@127.0.0.1:5434/viborm \
VIBORM_PROBE_MYSQL_URL=mysql://root:password@127.0.0.1:3307/viborm \
pnpm probes
```

## The final gate

```sh
pnpm package:build && pnpm probes --expect pass --md status-1.2.0.md
```

With both URLs set, `--expect pass` exits 1 when any probe is `fail` or `error`. A `skip` counts as met, so the gate must run with the databases. Without `--expect`, the runner exits 0 whatever the probes report. That is the mode for publishing a status matrix such as `status-1.1.0.md`.
