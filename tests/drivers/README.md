# Driver behavior suites

Each `*-behavior.ts` file exports a `run*Behavior({ driverName, createDriver })`
function containing a dialect-agnostic conformance suite. Driver test files
(`pglite.test.ts`, `sqlite3.test.ts`, ...) call these with their own driver
factory, so every driver proves the same public contract.

## The rule

**Every new behavior suite gets wired into every applicable driver file.**
If a suite can't run on a driver (missing capability, needs a special driver
subclass, redundant with another file), leave a one-line comment in that
driver's test file saying why — never omit silently.

Coverage split:

- **Local in-memory drivers** (`pglite`, `sqlite3`, `libsql`): full matrix.
  PGlite and SQLite3 also run batch-only variants (`BatchOnly*Driver`
  subclasses) to exercise the planned nested-write path used by atomic batch
  drivers (D1, Neon HTTP).
- **`mysql2`**: full matrix (its adapter has no in-memory stand-in).
- **`pg` / `postgres`**: driver-level suites only (param serialization, real
  pooling/races, nested writes); the adapter-level matrix already runs on
  PGlite, which shares the postgres adapter.

## Gating

Suites needing a real server are docker-gated by env var — without it the
whole file `describe.skip`s:

- `MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm pnpm test:mysql`
- `PG_TEST_CONNECTION_STRING=postgresql://...@127.0.0.1:5434/viborm pnpm test:pg`

`pnpm test:pg` runs `pg.test.ts` and `postgres.test.ts` serially
(`--no-file-parallelism`): both push schemas to the same database, and `push`
drops tables it doesn't know, so parallel files clobber each other.

Hosted drivers (D1, Neon HTTP, PlanetScale, ...) have no local fixtures yet —
see [nested-write-provider-gaps.md](./nested-write-provider-gaps.md).

## Bun-gated probes

vitest cannot load `bun:sqlite` or Bun's `SQL`, so the Bun drivers are proven by
spawning Bun itself: `*-runtime.test.ts` runs `bun` under `test.runIf` and skips
cleanly when it is not on PATH. `bun-sqlite-runtime.test.ts` spawns
`bun-sqlite-runtime-probe.ts`, a plain script (not `*.test.ts`, so vitest never
collects it) that drives the real client against a real in-memory database and
signals failure by exiting non-zero.
