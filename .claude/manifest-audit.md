# Documentation and manifest consistency audit

Static audit of `AGENTS.md`, `tests/README.md`, and the nested `src/**/AGENTS.md`
against the implemented test/coverage organization at `b1509a59`
(`by-test-suite-coverage-rewrite`). No runtime command was executed: every claim
below was established by reading source, scripts, and configs.

---

## 1. Corrections applied

| File:line (post-edit) | Change | Contract that justifies it |
|---|---|---|
| `AGENTS.md:407` | driver roster `13+: … d1, d1-http, bun-sqlite, bun-sql` → `11: … d1, bun-sqlite, bun-sql` | `src/drivers/` holds exactly 11 provider directories (bun-sql, bun-sqlite, d1, libsql, mysql2, neon-http, pg, pglite, planetscale, postgres, sqlite3); `package.json` exports exactly those 11 driver subpaths; `tests/README.md:234-236` already states there is no `d1-http` driver or package export |
| `AGENTS.md:651-656` | "The focused set is entirely provider-free" → scoped to the write set; added the driver manifest; "No focused subsystem executes against a PGlite database" | `scripts/coverage-policy.mjs:158-165` gives drivers `DRIVER_COVERAGE_TESTS`/`DRIVER_COVERAGE_TEST_GROUPS`; `scripts/driver-test-manifest.mjs:15-26,80-84` admits 5 SQLite-backed `.provider.test.ts` contracts + `tests/providers/local/{sqlite3,libsql}.test.ts`, each in its own group; `scripts/coverage-policy.test.mjs:267-285` requires those to own a provider resource and pins the 7 excluded PGlite files |
| `tests/README.md:55-63` (new paragraph) | Describes `scripts/driver-test-manifest.mjs` and `scripts/credential-free-test-manifest.mjs`, neither of which was named anywhere in the docs | `scripts/driver-test-manifest.mjs:8-13,15-26,42-84`; `scripts/credential-free-test-manifest.mjs:8-12,27-39,60-63`; `scripts/run-credential-free-tests.mjs:51-79` |
| `tests/README.md:65-73` (new paragraph) | States which manifest is a literal admission list and which auto-admit by directory read, and exactly what the policy gate refuses | literal: `scripts/query-engine-test-manifest.mjs:8-144`; directory reads: `coverage-policy.mjs:27-36` (cache), `migration-test-manifest.mjs:20-30`, `client-test-manifest.mjs:13-21`, `driver-test-manifest.mjs:8-13`; audits: `coverage-policy.test.mjs:294-322` (query+write), `:368-396` (cache), `:145-174` (migrations, non-core only), `:253-272` (drivers isolation), `:176-188` (client — equality only, **no import audit**) |
| `tests/README.md:156-161` | write-engine focused report "runs once in the single-thread `coverage-write-engine` project" → runs as the sequential declared parts (7 core slices + isolated mocked-Neon), 512 MB heap each, merged after each exit | `scripts/run-coverage.mjs:57-61` takes the `testGroups` branch whenever a subsystem declares groups; `query-engine-test-manifest.mjs:175-184` declares 8 groups; `coverage-policy.mjs:154-155` sets `testGroups`, `:155` sets `heapLimitMb: 512`; `run-coverage.mjs:94-96` forwards `--heap-limit-mb=512` |
| `tests/README.md:171-172` | "a 768 MB heap." → "a 768 MB heap ceiling a coverage subsystem may lower but never raise." | `scripts/run-vitest-safe.mjs:25-28` (`defaultMb: 768, maxMb: 768`); `bounded-process.mjs:77-103` rejects a heap above `maxMb`; write-engine lowers it to 512 |
| `src/client/AGENTS.md:404-405` | `tests/drivers/transaction-portability.test.ts` → `tests/contracts/drivers/transaction-portability.core.test.ts` | old path does not exist; the current file's header reads "The transaction-option contract, one pinned cell per driver per option" (`tests/contracts/drivers/transaction-portability.core.test.ts:1-16`), so the surrounding claim still holds |
| `src/schema/relation/AGENTS.md:598` | `tests/schema-validation/` → `tests/unit/schema-validation/` | the L5 suite lives at `tests/unit/schema-validation/`; there is no `tests/schema-validation/` |
| `src/validation/AGENTS.md:232-235` | quoted pin renamed and its count corrected: "inverse topology stays lazy until create validation" / "ZERO getter calls" → "a target getter is settled ONCE, by the definition gate, and never again" / exactly ONE call at registry construction and none afterwards | `tests/unit/operation-schemas/relations/polymorphic.core.test.ts:570-603`; the test's own comment says "RE-PINNED. Registry construction is a definition boundary now (§7.3) … the count is 1 HERE" and then asserts `toBe(1)` after `core.create` is read and after validating through it. The old title exists nowhere in `tests/` |

---

## 2. Open questions for the orchestrator (NOT edited)

### Q1 — Five core migration files boot real embedded databases, which the core rule forbids

`tests/README.md:24-27` and `AGENTS.md:658-660` both say core layer projects use
no live provider, that core contracts use deterministic recording drivers and
fakes, and that **embedded and native execution belongs in the extended or
provider estate**. These five `.core.test.ts` files run in the `layer-migrations`
core project (`pnpm test:core`, `pnpm test`) and in the `migrations` focused
coverage lane, and they create and execute against real in-memory
`better-sqlite3` / libSQL databases:

- `tests/unit/migrations/control-bootstrap.core.test.ts`
- `tests/unit/migrations/read-only-tracking.core.test.ts`
- `tests/unit/migrations/v1-apply.core.test.ts`
- `tests/unit/migrations/v1-operators.core.test.ts`
- `tests/unit/migrations/v1-push.core.test.ts`

Evidence: each imports `createInMemorySQLite3Driver` and/or
`createInMemoryLibSQLDriver` from `@tests/fixtures/drivers/{sqlite3,libsql}`;
`tests/fixtures/drivers/sqlite3.ts:11-15` constructs `new SQLite3Driver({ dataDir: ":memory:" })`;
`tests/unit/migrations/v1-apply.core.test.ts:55,64-88` then runs
`generate`/`apply`/`status`/`verify` against it.

Two mutually exclusive resolutions, both outside my mandate:
1. the doctrine is narrower than written (in-process embedded SQLite is
   core-legal because it is no network, Docker service, hosted credential, or
   separate process) — then both docs need one sentence admitting it; or
2. the five files are misfiled and belong in the extended estate — a test-suite
   change owned by another executor.

I did not soften the rule, because doing so would silently legalize whichever
answer is wrong.

### Q2 — Client focused coverage has no provider-import audit

`scripts/coverage-policy.test.mjs:176-188` checks only that
`CLIENT_COVERAGE_TESTS` equals the `tests/contracts/public-client` core listing
plus the two named extended files. Unlike the cache, migration, query, write, and
driver gates, it never inspects imports. `client-test-manifest.mjs:13-21`
auto-admits every new `*.core.test.ts` in that directory, so a future core client
contract that boots PGlite would enter the focused lane silently. I documented
the gap (`tests/README.md:73`) rather than claiming a guarantee that does not
exist. Worth deciding whether the gate should gain the audit.

### Q3 — Three `vitest bench` scripts bypass the bounded launchers and are undocumented

`package.json` has `bench` (`vitest bench --run`), `bench:baseline`, and
`bench:compare`. They invoke Vitest directly, so they take no workspace lock, get
no 768 MB heap cap, no 1536 MiB process-group RSS ceiling, and no teardown
verification — the exact hazard `tests/README.md:219` ("Do not bypass these
launchers for large selections") and `AGENTS.md:633` ("Large selections must use
the package scripts") exist to prevent. They are also the only test-related
scripts absent from both documented command lists. I did not add them to the
docs, because documenting them legitimizes the bypass; the likely correct fix is
routing them through `scripts/run-vitest-safe.mjs` or deleting them, both of
which are `package.json` edits I do not own.

Related, lower severity: `pnpm dev` is `tsc --watch`, also unbounded and
unlocked. It is self-limiting in practice, since
`scripts/test-run-lock.mjs:58-63` lists `/node_modules/typescript/bin/tsc` as a
workspace-verification marker, so a running `pnpm dev` makes every launcher
refuse with "workspace verification PID N is still active".

### Q4 — `AGENTS.md` path-alias list is incomplete

`AGENTS.md:718` lists 9 aliases. `vitest.config.ts:56-73` and `tsconfig` define
16: the 9 listed plus `@src`, `@tests`, `@root`, `@types`, `@extensions`,
`@migrations`, `@errors`. Nothing there is false, so I left it; say the word and
I will complete the list.

### Q5 — `tests/providers/provider-gaps.md` is unreferenced

The file exists and is current-looking, but no owned doc links it. Only
`docs/architecture/*` mention it, under its **pre-rewrite** path
`tests/drivers/nested-write-provider-gaps.md`. Add a pointer from
`tests/README.md`, or confirm it is dead.

---

## 3. Stale references in files I do not own

`docs/architecture/` still names two of the five deleted production files. Both
read as historical record rather than live-ownership claims, so they may be
intentional; neither is in my ownership list:

- `docs/architecture/codebase-reliability-remediation-plan.md:245` — lists
  `src/cli/command-factory.ts` in a work plan.
- `docs/architecture/capability-matrix-2026-07.md:129` — credits commit
  `a9cf030` in `src/cli/resolve-recorder.ts`.

Additionally, `docs/architecture/prisma-parity-contract.md:150`,
`prisma-nested-writes-implementation-plan.md:497`, and
`capability-matrix-2026-07.md:630` reference the retired `tests/drivers/*` tree
(`tests/drivers/pglite.test.ts`, `tests/drivers/README.md`,
`tests/drivers/nested-write-provider-gaps.md`).

No owned document references any of the five deleted files —
`src/cache/cache-contract.ts`, `src/cli/command-factory.ts`, `src/cli/prompts.ts`,
`src/cli/resolve-recorder.ts`, `src/query-engine/result/index.ts`. The successor
owners are already documented correctly: `src/cache/AGENTS.md:33` names
`driver.ts`; `src/migrations/AGENTS.md:443,509,593` put push consent on
`push-v1.ts`; `src/query-engine/AGENTS.md` names the concrete result files, never
a `result/index.ts` barrel.

---

## 4. Verified accurate — no edit needed

**Commands, both directions.** Every command in `AGENTS.md:582-631` and
`tests/README.md` "Commands" exists in `package.json` with the described
behavior: `build`/`test:types` (both `run-typecheck-shards.mjs`), `test`
(`test:types && test:core`), `test:core`/`test:watch`/`test:ui`
(`--project='layer-*'`), `test:all`, all 16 `test:coverage*` entries,
`test:coverage:policy` (coverage-policy + bounded-process + test-run-lock node
tests), `test:package`, `test:providers` (6 docker/hosted projects), all 13
`test:layer:*`, and the 4 `bench:operation-pipeline*` entries. The only
undocumented test-related scripts are the three in Q3.

**Coverage ownership and thresholds.** `scripts/coverage-policy.mjs:18-190`
defines 15 subsystems; `auditCoverageOwnership` runs at import and throws unless
every `src/**/*.ts` has exactly one owner (`:256-284`), and every top-level entry
under `src/` is covered by a root or the explicit file sets. Targets match the
docs exactly: 100 for public, schema, validation, sql, instrumentation,
extensions, errors, adapters, cli; 98 for query-engine-core, write-engine,
drivers, client, cache, migrations. `coverageOptionsForSubsystem:331-353` encodes
100 as Vitest's `{ 100: true }` (all four metrics) and 98 as the four explicit
metrics — so "100%/98% in all four metrics" is exact. Waived source stays in
`include` (`:345-352`), confirming "waived source remains in the denominator".

**PGlite exclusion.** No focused lane executes against PGlite.
`coverage-policy.test.mjs:273-285` pins the 7 excluded PGlite files;
`:305-321` (query/write), `:380-396` (cache), and `:145-167` (non-core
migrations) refuse resource-owning PGlite imports. The focused files that merely
*import* `@drivers/pglite` never open a database: `tests/contracts/adapters/{namespace-binding,vector-capabilities}.core.test.ts`
read only `driver.adapter` facts, `tests/contracts/public-client/geopoint-provider-limit.test.ts:63-76`
asserts `connect`/`execute` are called 0 times, `tests/contracts/public-client/omit-builder-types.test.ts`
contains no `await` at all, and the CLI harness never passes `dataDir` from any
of the four admitted CLI tests. `PGliteDriver`'s database is lazy
(`src/drivers/pglite/index.ts:87-109` constructor vs `:121` `initClient`).
`test:all` owns PGlite behavior via `PGLITE_PROVIDER_TESTS`
(`run-credential-free-tests.mjs:62-64`, 20 minutes per file, own process).

**Safety story.** `DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB = 1536`
(`bounded-process.mjs:4`), sampled every 250 ms (`:5,240`), lowerable but never
raisable (`:60-68`); Vitest heap default and max 768
(`run-vitest-safe.mjs:25-28`); TypeScript shards 1280 MB
(`run-typecheck-shards.mjs:125`); one worker
(`vitest.config.ts:24-33`, plus `vitestArgumentsWithSingleWorker`); teardown
SIGTERM → 1 s grace → SIGKILL → 2 s verification → throw (`:169-180`); macOS `ps`
state instead of `kill(-pgid, 0)` with the `EPERM` rationale (`:125-158`);
workspace lock with process-table preflight over the four verification markers,
fail-closed when unreadable, never auto-deleting a stale lock
(`test-run-lock.mjs:58-63,155-217`); Windows refused (`:30-36`). Wall limits:
30 s per layer command shared across runtime+types
(`run-layer-core.mjs:49,118-123`), 5 min default runtime
(`run-vitest-safe.mjs:40`), 10 min coverage parts (`run-coverage.mjs:97`), 5 min
per extended-local shard and 20 min per PGlite file
(`run-credential-free-tests.mjs:57,63`).

**Reports.** `merge-coverage.mjs:134-149` writes `coverage/metadata.json` with
commit, dirty flag, per-subsystem targets, and waivers; focused reports land in
`coverage/<subsystem>/index.html` (`coverage-policy.mjs:350`); shards land under
`coverage/.shards/` (`run-coverage.mjs:25,41`).

**Layer/type coverage.** 13 layer projects, 13 `test:layer:*` scripts, 13
`tests/types/<layer>/tsconfig.json` probe projects — all three lists agree.
`run-typecheck-shards.mjs:16-66` covers every one of the 9 `tests/unit/*`
directories, all 5 `tests/contracts/*` directories, `tests/{inventory.ts,fixtures,package,providers}`,
and every `tests/types/**` file (each probe tsconfig includes `./*.core.types.ts`;
the single non-probe file `tests/types/relations/debug-relation-type.ts` is named
explicitly at `:45`). Nothing under `tests/` escapes `pnpm test:types`.

**Other verified claims.** `tests/providers/matrix.ts` exists and
`tests/contracts/architecture/contract-matrix.core.test.ts:47-183` enforces
exactly the five things tests/README claims. The PGlite fixture description
matches `tests/fixtures/drivers/pglite.ts:85-170` (one database, one
`syncLiveSchema`, `TRUNCATE … RESTART IDENTITY` per test, family-owned
disconnect). The LibSQL `DRIVER_NOT_SUPPORTED` skip is real
(`tests/providers/local/libsql.test.ts:126-127`). All 7 documented provider
environment variables are the ones the suites read. `describe("coverage low
value")` is a live convention (83 files). Every markdown link target and every
backticked path in the owned documents resolves, apart from the intentional
`src/drivers/AGENTS.md` mention and the generated `coverage/metadata.json`.

**Not a defect, checked anyway.** `credential-free-test-manifest.mjs:8-12`
excludes exactly 3 of the 26 `-docker.test.ts` files. The other 23 are correctly
included: each gates itself with `describe.skip` when its connection string is
absent, and the 3 exclusions are precisely the non-`tests/providers/` files the
`provider-mysql2` project already owns (`vitest.workspace.ts:175-180`), so the
exclusion list prevents double ownership rather than a hard failure. Nothing
enforces that correspondence, so a 4th file added to a provider project would be
double-owned.
