# Extension capabilities v3.1 and `viborm/soft-delete`: final qualification record (U7, amended by the U7 repair)

The qualifier ran on frozen source 572de61f7. Its review found two blockers, two majors and four minors; the U7 repair (commit **654b3df93**, tree e32c2c55a) repaired or re-measured each. **Section 0 below supersedes sections 1-12 wherever they differ**; those sections are kept as the qualification of 572de61f7.

One thing still blocks a clean exit and needs the owner:
1. **The §5.2 bundle budget is breached** (STOP U3R-1, open): base entry +6,343 B gzip over main against +5 KB. Measured in the repair: trimming cannot close it (§0.5).

And one qualification gap remains: **MySQL has never executed a witness** (no server; Docker down). PostgreSQL now has: the repair ran the pg-driver lane on a scratch PostgreSQL 18.3 server (§0.2).

Labels: **MEASURED** means run in the qualification or the repair unless another unit is named. **JUDGEMENT** means reasoning, not measurement.

## 0. U7 repair (2026-09-30)

### 0.1 Identity

| Item | Value |
| --- | --- |
| HEAD | **654b3df933f2339596e99d43ddb5df8f3d57a8ae**, tree e32c2c55a6f9f922dcb80e06024b773b9645f3c2 |
| Commits over 30ff17e69 | 13 (the 12 of §1 plus 654b3df93 "(U7 repair)") |
| Working tree | clean; nothing pushed; nothing amended |
| Trailers | 10 `Claude Fable 5.1`, 3 `Claude Opus 5.5` (U2 5b0423e4d, U2 repair 5b6a625f2, U7 repair 654b3df93, which follows the harness attribution instruction). Only a squash or reword at PR time can normalise them (U7R-8). |

### 0.2 Findings and what the repair did

| Review finding | Outcome |
| --- | --- |
| Blocker 1: bundle +6,320 gzip (STOP U3R-1) | **Still open.** Final +6,343 (the DC14 locks +23). Trim attempt measured, reverted (§0.5). Owner ruling required. |
| Blocker 2: docker witnesses claimed but unwritten | **Written and, for PostgreSQL, run.** New: `tests/providers/docker/{pg,mysql2}-deletion-capability.test.ts`, `{pg,mysql2}-soft-delete.test.ts`, `{pg,mysql2}-deletion-races.test.ts` over `tests/contracts/engine/write/deletion-race-behavior.ts` (DC14 create-with-connect racer in both orders, the same racer through a nested set-oriented `deleteMany`, consumer 3 converging, and its hidden-conflict companion). DC14 **failed** without a lock (3 of 5 races red: a tombstone with a live child), so the lock was added as plan §2.3 prescribes (`Commands.unreferenced`, and `restrict.lock` in `execution.ts` for the nested set path); 5/5 green after. Per-arm EXISTS cost measured on PostgreSQL. MySQL files are written, collected (skip without env) and **unexecuted**. |
| Major 3: M2 floor +31,179 as an increment | **Fixed.** `HiddenTargetNull` distributes over the context; floor 748,022 (−2,360 vs M1's 750,382; −25,788 vs main). No reading needed. |
| Major 4: shipped `viborm/soft-delete` never type-checked or run | **Fixed.** The packed consumer writes `use-entry.ts` importing from `viborm/soft-delete`, type-checks and runs it; falsified (§0.4). |
| Minor 5: Biome on two runner scripts | **Fixed.** All 82 code files changed vs main are clean. |
| Minor 6: mixed trailers | Not fixable without rewrite; recorded (§0.1). |
| Minor 7: record-only bundle gzip did not reproduce | Explained: gzip of fixtures that name hashed chunks varies up to ~100 B between builds with identical raw bytes (this repair: full 267,890, ids-only 27,891 at 30ff17e69; the reviewer 267,790 and 27,862). Record-only gzip figures are ±~100 B; raw bytes are exact; pg-representative reproduces exactly (160,066 / 166,386 on three builds). |
| Minor 8: client programs over the O7 +3% paraphrase | **Resolved by measurement**: after the floor fix every client program is within +3% types and instantiations (§0.3). |

### 0.3 Types, MEASURED on the repair tree

tsc 5.9.3 `--extendedDiagnostics`, heap 1,280, run-layer-core chunking at base, 5 alternating rounds base 30ff17e69 / repair, 76 runs, all exit 0 with 0 errors, counts deterministic. Logs: impl/u7-repair/meas/meas.log.

| Program | Types main → repair | Δ | Instantiations Δ | RSS median MiB (Δ) | Repair max MiB |
| --- | --- | --- | --- | --- | --- |
| client-1 | 802,129 → 776,409 | −3.21% | −11.98% | 1,476.8 → 1,487.1 (+10.3) | 1,501.6 |
| client-2 | 850,210 → 857,438 | +0.85% | −5.22% | 1,420.7 → 1,439.8 (+19.1) | 1,445.8 |
| client-3 | 833,677 → 834,937 | +0.15% | −4.46% | 1,410.7 → 1,423.5 (+12.8) | 1,452.6 |
| client-4 | 781,169 → 755,389 | −3.30% | −12.21% | 1,407.8 → 1,394.4 (−13.4) | 1,427.2 |
| instrumentation | 922,065 → 751,094 | −18.54% | −39.53% | 1,438.6 → 1,406.9 (−31.7) | 1,460.3 |
| schema-only floor | 773,810 → 748,022 | −25,788 | −12.50% | 1,424.8 → 1,378.8 (−46.0) | 1,450.1 |
| dense (whole feature) | 795,841 → 772,501 | −2.93% | −11.24% | 1,459.9 → 1,458.5 (−1.4) | 1,483.9 |

HEAD-only, 1 run: gate-client-1..4 776,409 / 857,438 / 830,890 / 775,911 types; acceptance 758,916; row-reference-nullability 757,240. Every §5.2 row holds in **both** the M1 and M2 columns. The floor's M2 increment over M1's close is −2,360. Largest run 1,501.6 MiB: under the plan's 1,536 (U1R-1), 1.6 over O7's paraphrased 1,500.

Why (MEASURED with `--generateTrace`): variance measurement of `OperationResultWithClientDefaults` (8 parameters) and `Operation` (7) took about 1.7 s each; the `[HiddenSurfaces<Context>] extends [never]` test made the context parameter costly to measure. Falsified: inverting the hide test gives 7 type errors (row-reference-nullability 4, soft-delete-acceptance 1, soft-delete-behavior 2).

### 0.4 Commands of the repair, one at a time, with counts

- Scratch PostgreSQL 18.3 (Homebrew binary; initdb in scratch, port 55434, no PostGIS; deleted after): `PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:55434/viborm pnpm exec vitest run --workspace vitest.workspace.ts --project provider-pg <files>`: pg-deletion-races 5/5, pg-deletion-capability 13/13, pg-soft-delete 17/17, pg-row-scopes 24/24 (59/59, rerun on committed HEAD). Before the locks: races 2 passed, 3 failed.
- The same command without connection strings over the six new docker files, provider-pg + provider-mysql2: 6 files, 69 skipped.
- `node node_modules/typescript-native/bin/tsc --project tsconfig.json --noEmit`: exit 0.
- `pnpm exec biome check --max-diagnostics=500` on the 82 code files changed vs 30ff17e69: 0 diagnostics.
- `node scripts/raptor3-refusal-census.mjs --at HEAD` (572de61f7) and on the repair tree: identical modulo line numbers and the revision line; delta 0.
- Direct vitest, one project at a time: layer-validation 998, scalars 1,159, operation-schemas 1,364, relations 119, schema-validation 470, schema-json 431, query-engine 739, write-engine 82, adapters 190, drivers 988, client 690, cache 85, instrumentation 185, migrations 1,899 (446 files, 9,399 passed); raptor3 2,087 passed and the 7 known reds (cs02 and six G3/G4 generation campaigns); raptor3-provider 32/32; provider-sqlite3 881 + 1 skipped; extended-local 2,348 passed, 393 skipped; dead-symbol gate 225/225.
- `node scripts/run-credential-free-tests.mjs --only …`, each alone: pglite-deletion-capability 13/13 (1,734.5 MiB), pglite-row-scopes 24/24 (1,792.3), pglite-soft-delete 17/17 (1,738.7), shared-family shard 4/8 205/205 (1,731.3), imported-pglite shard 2/2 163 + 14 skipped (1,915.0); teardown verified on each.
- `node scripts/run-node-safe.mjs 512 300000 scripts/<t>.test.mjs`: coverage-policy 11/11, credential-free-ci 4/4, raptor3-campaign-receipts 41/41, raptor3-refusal-census 8/8, bounded-process 16/16, test-run-lock 6/6; raptor3-cli 10/10 with a 900 s wall limit (the 300 s run exceeded its wall under load average 30; one earlier 900 s run was invalidated because a probe edited src during it).
- Lock scripts, one at a time: test:types exit 0; test:core exit 0 (9,399/9,399); test:layer:instrumentation exit 0; test:coverage exit 0, every subsystem at or above its floor (extensions 100; query-engine core 93.8/94.21/94.43/93.8; client 96.33/94.37/96.5/96.33; drivers 96.04/92.69/96.06/96.04; migrations 98.68/97.3/99.89/98.68). test:layer:client, test:layer:query-engine and test:package first failed on wall limits and a vitest RPC timeout under load (all tests passed); rerun alone at lower load: exit 0 each (690/690 and types chunks ≤ 1,434.2 MiB; 739/739; package 13/13 including the entry consumer).
- Entry consumer falsified: a packed tarball whose `dist/soft-delete.d.mts` types `softDelete` as `any` fails `use-entry.ts` only (1 TS2322, 5 TS2578).
- Per-arm EXISTS on PostgreSQL (1,000 pins, 500 hidden claims, 7 × 50 alternating runs of the two statement texts): 2.436 vs 2.286 ms median, +0.151 ms per query, 301 ns per hidden claimed row, inside the no-EXISTS arm's own spread (2.18-2.77).
- Runtime gate (U5 harness, 7 rotated rounds, dists built from 30ff17e69 and the repair): plain read head 27,049 vs mainA 27,126 / mainB 28,152 (stability 3.8%, within spread, 0.985): PASS; controls read 27,759 vs 27,318 / 27,368 (0.2%, 1.014): PASS; no-extension allocation 40,037 vs 40,089 B/op, 0 GCs: PASS. Recorded: rows read 26,093; nested read 97,222 (plain 124,701 / main 124,606); soft delete + restore 56,351 (plain update pair 49,486 / 48,901); bulk 54,021; callback tx 36,781 (35,153 / 34,644); array tx 56,970 (51,277 / 51,784). The harness schema has no restricting relation, so the DC14 lock is not on these paths.

### 0.5 Bundle, MEASURED

tsdown + `scripts/measure-bundle.mjs`, raw / gzip bytes.

| Fixture | main 30ff17e69 | 572de61f7 | repair |
| --- | --- | --- | --- |
| pg-representative | 543,896 / 160,066 | 565,576 / 166,386 | **565,696 / 166,409 (+6,343 vs main)** |
| pg-soft-delete | n/a | 566,472 / 166,750 | 566,592 / 166,775 |
| soft-delete entry | n/a | 759 / 395 | 759 / 395 |
| full | 917,160 / 267,890 (±~100) | 939,500 / 274,364 | 939,620 / 274,414 |
| ids-only | 93,221 / 27,891 (±~100) | 93,221 / 27,892 | 93,221 / 27,892 |

Why trimming cannot close it (MEASURED, src-direct esbuild proxy of pg-representative, which tracks the dist delta within ~125 B): stubbing out the entire capability-definition snapshot (controls, rows and deletion normalization in definition.ts) removes 1,950 B gzip; a compact copy-first rewrite of that code, all extension tests green, saved 128 B gzip (−664 raw), about 7% of what it touched. At that yield compacting the whole feature gives about 435 B against the ≥ 1,345 B needed. The rewrite was reverted (scratch: impl/u7-repair/definition.ts.copyfirst). Refusal-message text of that file is 433 B gzip in total. **JUDGEMENT:** reaching +5 KB needs a design change (removing a planned behavior or moving capability code out of the base entry), which is an owner decision under §5.4.

### 0.6 Exit checklists after the repair

M1: every item of §8 stands, with these changes: "every M1 witness on PostgreSQL, MySQL and SQLite" is **met for PostgreSQL** (pg driver on a real server, including DC14 and DC10-style races) and **not met for MySQL**; "§5.2 holds: types" met in the M1 column; "§5.2 holds: bundle" **NOT MET**.
M2: nullability, integrity and recursion rows met on SQLite3, batch-only SQLite3, PGlite and PostgreSQL (pg); §5.2 M2 types met without any reading; per-arm EXISTS cost measured on SQLite and PostgreSQL; bundle **NOT MET**.

### 0.7 Remaining gaps

1. Bundle STOP U3R-1 (owner).
2. MySQL: nothing executed. Rerun when a server is up: `MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm pnpm exec vitest run --workspace vitest.workspace.ts --project provider-mysql2` (covers mysql2-row-scopes, -deletion-capability, -soft-delete, -deletion-races: InnoDB REPEATABLE READ behaviour of the locks and of consumer 3 is untested). The docker PostgreSQL container and the postgres.js project were not run; the pg lane ran on a scratch server without PostGIS, only the four files named above.
3. Trailers (§0.1).
4. The unregistered reviewer probes under `tests/raptor3/g4/review/` that import run-raptor3.mjs belong to no vitest project and were not run.

## 1. Commit identity

| Item | Value |
| --- | --- |
| Worktree | /Users/arnaud/code/viborm-ext |
| Branch | extension-capabilities |
| Base | origin/main = merge-base = 30ff17e69 (30ff17e69fcb936b40ec3866029117fa5b4cb5dd) |
| HEAD | **572de61f743b83871725106bc77bb2e69a893959**, tree a575bfe9e0ca311a92a48e07c83aa646f7799d64 |
| Working tree | clean; nothing pushed; nothing amended |
| Diff vs main | 89 files, +10,793 / −701 physical lines |

The branch has 12 commits (origin/main..HEAD):

| Unit | Commit | Repair |
| --- | --- | --- |
| U1 | e151a686f | 2ac4eae84 |
| U2 | 5b0423e4d | 5b6a625f2 |
| U3 | ccca6801a | 5cbcf8fe3 |
| U4 | 84a161280 | eca08f842 |
| U5 | 5e8a7fa50 | 5d045dbdb |
| U6 (M2) | 432c93b9b | 572de61f7 |

Attribution trailers are inconsistent: 10 commits carry `Co-Authored-By: Claude Fable 5.1`, and 2 (U2 5b0423e4d, U2 repair 5b6a625f2) carry `Claude Opus 5.5`. Without amending, this can only be fixed by squash or rewrite at PR time. That is the owner's call.

## 2. Runtime identity

| Item | Value |
| --- | --- |
| Node | v24.21.0 (vite-plus runtime) |
| pnpm | 10.11.0 |
| TypeScript for budgets | 5.9.3 (node_modules/typescript), gate heap `--max-old-space-size=1280` |
| TypeScript native (tsgo) | typescript@7.0.2 (node_modules/typescript-native) |
| vitest | 3.1.4 |
| tsdown | 0.19.0-beta.4 |
| Biome | 2.3.11 |
| Machine | macOS 26.5.1 arm64, 48 GiB RAM (51,539,607,552 B), 14 CPUs |

Machine noise during the qualification: another session's vitest process (edytor-arch-v2) ran at about 99% CPU the whole time, and the load average was 22-58 when the runtime gate started. The runtime gate's stability rule is what protects its verdict from this.

Docker: `docker info` exits 1, and `nc -z 127.0.0.1 5434` and `nc -z 127.0.0.1 3307` both fail.

## 3. Every command, one at a time, with counts and outcomes

All commands were run from /Users/arnaud/code/viborm-ext. Logs are in `impl/u7/logs/`.

| # | Command | Outcome |
| --- | --- | --- |
| 1 | `pnpm exec biome check --max-diagnostics=500 <75 changed .ts/.mjs/.json files vs 30ff17e69>` | 73 files clean. The only diagnostics are in scripts/run-raptor3.mjs (38) and scripts/raptor3-campaign-receipts.test.mjs (54). Both counts are identical at 30ff17e69, measured in scratch archives with the repo's biome.jsonc. **Deviation, pre-existing since U3, not reformatted (U7-2).** |
| 2 | `node node_modules/typescript-native/bin/tsc --project tsconfig.json --noEmit` | exit 0, 0 errors, 9.0 s |
| 3 | `node scripts/raptor3-refusal-census.mjs --at 30ff17e69`, then `--at HEAD`, then on the working tree | All exit 0. main and HEAD are **identical modulo line numbers**: 203 sites; invariant 25 sites / 24 sentences; inherited 76 / 76; candidate 44 / 35; rethrow 58. Delta 0. U3's new referential ForeignKeyError is built in a `DeferredFailure` thunk (`createFailureError`) and thrown by an existing rethrow, which the census cannot see by construction. It is recorded in the guard ledger instead (U3-10, U3R-6). |
| 4 | `pnpm exec vitest run --workspace vitest.workspace.ts tests/contracts/engine/write/dead-symbol-gate.core.test.ts` | 3 files (layer-write-engine, coverage-write-engine-core, one more), 225/225 |
| 5 | `node scripts/run-node-safe.mjs 512 300000 scripts/<t>.test.mjs` (manifest and policy tests) | coverage-policy 11/11; credential-free-ci 4/4; raptor3-campaign-receipts 41/41; raptor3-cli 10/10; raptor3-refusal-census 8/8; bounded-process 16/16; test-run-lock 6/6. All exit 0. |
| 6 | Manifest registration (read) | Registered: row-scopes 57 cells (POST_G3_ROW_SCOPE_COUNTS); deletion-sites 26; coverage-extensions list (extension-controls, extension-deletion, soft-delete.core); coverage-policy extensionCoverageTests; soft-delete consumer smoke in tests/package/package.test.ts. Picked up by globs, no manifest entry needed: PGlite files (`tests/providers/local/pglite*.test.ts`), docker files (`tests/providers/docker/pg*` and `mysql2*`), mutation-cache-control (tests/unit/cache glob), referential-delete-actions (layer glob), type files (run-layer-core readdir). |
| 7 | `pnpm exec vitest run --workspace vitest.workspace.ts --project <p>`, once per layer project | validation 42 files / 998; scalars 26 / 1,159; operation-schemas 50 / 1,364; relations 7 / 119; schema-validation 26 / 470; schema-json 10 / 431; query-engine 34 / 739; write-engine 4 / 82; adapters 12 / 190; drivers 44 / 988; client 50 / 690; cache 7 / 85; instrumentation 17 / 185; migrations 117 / 1,899. **All pass: 446 files, 9,399 tests.** |
| 8 | `... --project raptor3` | 200 files passed and 7 failed (207); 2,087 tests passed and 7 failed (2,094). The 7 failures are **exactly the known reds**: cs02-structure-measure; g3 sqlite-campaign and transport-campaign; g4 sqlite-campaign, transport-campaign, write-campaign and write-transport-campaign. |
| 9 | `... --project raptor3-provider` | 9 files, 32/32 |
| 10 | `... --project provider-sqlite3` | 16 files, 881 passed, 1 skipped |
| 11 | `... --project extended-local` (whole project, including every touched extended-local file) | 171 files passed and 22 skipped; 2,348 tests passed and 393 skipped (the skips are docker-gated) |
| 12 | `node scripts/run-credential-free-tests.mjs --only "pglite-deletion-capability"` (alone) | 13/13, 10.97 s, **1,914.4 MiB** peak sampled RSS (ceiling 2,560), teardown verified |
| 13 | `... --only "pglite-row-scopes"` | 24/24, 17.19 s, **1,984.5 MiB** |
| 14 | `... --only "pglite-soft-delete"` | 17/17, 12.84 s, **1,737.3 MiB** |
| 15 | `... --only "shared-family shard 4/8"` (official-cache-invalidation.test.ts) | 14 files, 205/205, 14.91 s, **1,757.7 MiB** |
| 16 | `... --only "imported-pglite shard 2/2"` (official-cache-extension.test.ts) | 8 files passed and 2 skipped; 163 tests passed and 14 skipped; 8.24 s, **2,000.4 MiB** |
| 17 | `docker info` | exit 1. **Docker gap, recorded (§7).** |
| 18 | `pnpm exec vitest run --workspace vitest.workspace.ts --project provider-pg --project provider-postgres --project provider-mysql2` (no connection strings) | 34 files skipped (1,793 tests skipped). The new pg-row-scopes and mysql2-row-scopes files collect and skip 24 + 24. Two pre-existing pg files (pg-batch-reference-reuse, pg-captured-set-concurrency; unchanged since main) fail to collect with "Invalid URL" without env. **Nothing ran against a database.** |
| 19 | **LOCK** `pnpm test:types` | exit 0, 10 s; whole-estate native typecheck, 6,950.7 MiB peak (ceiling 8,192) |
| 20 | **LOCK** `pnpm test:core` | exit 0, 75 s; 446 files, 9,399/9,399; 1,203.4 MiB peak (ceiling 1,536) |
| 21 | **LOCK** `pnpm test:package` | exit 0, 59 s; package.test.ts 13/13, including "lets a third party build soft delete from public exports alone" (11.0 s), the packed public-surface golden and the TS 5.8 consumer floor |
| 22 | **LOCK** `pnpm test:coverage` (all subsystems) | exit 0, 588 s. **Every threshold holds** (table below). |
| 23 | **LOCK** `pnpm test:layer:client` | exit 0, 40 s; runtime 690/690 (731.8 MiB); type chunks 1-4 peak 1,434.8 / 1,441.9 / 1,436.2 / 1,433.4 MiB (ceiling 1,536) |
| 24 | **LOCK** `pnpm test:layer:query-engine` | exit 0, 15 s; 739/739 (861.1 MiB); types 1,451.3 MiB |
| 25 | **LOCK** `pnpm test:layer:instrumentation` | exit 0, 11 s; 185/185 (618.2 MiB); types 1,455.5 MiB |
| 26 | Bundle: tsdown + `node scripts/measure-bundle.mjs` on path-limited archives of 30ff17e69 and HEAD, plus the worktree dist from test:package | §5 |
| 27 | Runtime gate: U5 harness (fresh process per sample, in-memory better-sqlite3, built dists of 30ff17e69 and HEAD), 7 rounds, mainA / head / mainB rotating | §6 |
| 28 | Type budget: tsc 5.9.3 `--extendedDiagnostics`, heap 1,280, run-layer-core chunking, 5 alternating rounds base 30ff17e69 / HEAD, 76 runs | §4 |
| 29 | Code-bearing line accounting (TypeScript-scanner token rule) per unit | §10 |

Coverage thresholds from `pnpm test:coverage` (statements / branches / functions / lines, floors in brackets):

| Subsystem | Result |
| --- | --- |
| public, schema, validation, sql, instrumentation, **extensions**, errors, adapters, CLI | 100 / 100 / 100 / 100 (floor 100) |
| query-engine core | 93.8 / 94.2 / 94.41 / 93.8 (87 / 91 / 90 / 87) |
| drivers | 96.04 / 92.69 / 96.06 / 96.04 (96 / 92.5 / 96 / 96) |
| client | 96.33 / 94.37 / 96.5 / 96.33 (96 / 94 / 96 / 96) |
| cache | 100 / 100 / 100 / 100 (98) |
| migrations | 98.68 / 97.3 / 99.89 / 98.68 (98 / 97.3 / 98 / 98) |

The extensions subsystem includes src/soft-delete/index.ts (U5-3).

## 4. Type budget, before (30ff17e69) and after (HEAD 572de61f7). MEASURED.

Setup: tsc 5.9.3 `--extendedDiagnostics` under `node --max-old-space-size=1280`. Client programs are chunked exactly as run-layer-core chunks them at base (4 chunks). Dense is the 64-model / 122-relation program, whole feature. The floor is the schema-only program. 5 alternating rounds, 76 runs: all exit 0, 0 errors, type counts deterministic. Types and instantiations reproduce fx6's numbers exactly. Logs: impl/u7/meas/meas.log and summary.txt.

| Program | Types main → HEAD | Δ | Instantiations main → HEAD | Δ | RSS median MiB main → HEAD | Δ | HEAD max MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| client-1 | 802,129 → 809,948 | +0.97% | 3,466,692 → 3,073,319 | −11.35% | 1,465.5 → 1,471.8 | +6.3 | 1,476.5 |
| client-2 | 850,210 → 890,991 | +4.80% | 3,871,678 → 3,691,884 | −4.64% | 1,444.3 → 1,442.5 | −1.8 | 1,447.7 |
| client-3 | 833,677 → 868,479 | +4.17% | 3,817,198 → 3,669,036 | −3.88% | 1,426.1 → 1,440.3 | +14.2 | 1,446.7 |
| client-4 | 781,169 → 788,928 | +0.99% | 3,404,399 → 3,010,883 | −11.56% | 1,416.7 → 1,431.3 | +14.6 | 1,451.8 |
| instrumentation | 922,065 → 784,633 | −14.90% | 5,064,021 → 3,084,527 | −39.09% | 1,425.7 → 1,417.0 | −8.7 | 1,456.8 |
| schema-only floor | 773,810 → 781,561 | **+7,751** | 3,326,322 → 2,932,752 | −393,570 | 1,424.1 → 1,435.3 | +11.2 | 1,437.8 |
| dense (whole feature) | 795,841 → 806,040 | +1.28% | 3,495,766 → 3,124,772 | −10.61% | 1,468.4 → 1,484.7 | +16.3 | 1,487.7 |

HEAD-only programs, 1 run each:

| Program | Types | Instantiations | RSS MiB |
| --- | --- | --- | --- |
| gate-client-1 | 809,948 | 3,073,319 | 1,477.0 |
| gate-client-2 | 890,991 | 3,691,884 | 1,446.7 |
| gate-client-3 | 864,432 | 3,646,370 | 1,394.8 |
| gate-client-4 | 809,458 | 3,184,410 | 1,426.9 |
| acceptance | 792,456 | 3,028,215 | 1,389.5 |
| row-reference-nullability | 790,786 | 2,999,660 | 1,367.0 |

Largest run in the whole set: **1,487.7 MiB** (dense, HEAD). It is under both 1,536 (plan) and 1,500 (O7's paraphrase).

Verdict against §5.2, M2 column (HEAD contains M2):
- Each client program: ≤ +6% types and ≤ +3.5% instantiations. **Holds**; the worst is client-2 at +4.80% / −4.64%.
- Dense: same budget. **Holds**, +1.28%.
- Instrumentation: ≤ +4%. **Holds**, −14.90%.
- RSS: median ≤ main + 30 MiB, no run over 1,536. **Holds**; the largest median rise is +16.3, the largest run 1,487.7.
- Floor: "plus ≤ +30k types". **Holds only on the cumulative reading** (U6-8, U7-3): +7,751 vs main, well within M1's +15k plus M2's +30k. Read as an increment over M1's close (750,382 at 5d045dbdb, measured in U5/U6R-4), it is **+31,179, 1,179 over "+30k"**. The owner may overrule the reading.

At M1's close, U5 measured 5 rounds against main: every program within M1's ≤ +3% (client-2 +1.06% was the highest), floor −23,428 types, dense −2.65%.

Heap headroom (MEASURED, "Memory used"): HEAD programs use about 1.16-1.30 GB of the 1.28 GB gate heap. Headroom for further type work is very small.

## 5. Bundle. MEASURED.

Setup: tsdown + `scripts/measure-bundle.mjs` on path-limited archives (src scripts package.json tsconfig.json tsdown.config.ts benchmarks/internal). Sizes are bytes, raw / gzip / brotli. Logs: impl/u7/bundle/.

| Fixture | main 30ff17e69 | HEAD 572de61f7 | Δ gzip | §5.2 |
| --- | --- | --- | --- | --- |
| **Base entry, pg-representative** | 543,896 / 160,066 / 135,512 | 565,576 / 166,386 / 141,049 | **+6,320** (+21,680 raw, +5,537 brotli) | ≤ +5 KB gzip: **BREACHED**, STOP U3R-1 open |
| Base with extension, pg-soft-delete | n/a | 566,472 / 166,750 / 141,378 | +364 over HEAD's pg-representative (+6,684 over main's) | recorded |
| `viborm/soft-delete` entry | n/a | 759 / 395 / 349; imports nothing | n/a | recorded |
| full | 917,160 / 267,890 | 939,500 / 274,364 | +6,474 | recorded |
| ids-only | 93,221 / 27,891 | 93,221 / 27,892 | +1 | unchanged |
| decimal-only | 93,072 / 27,867 | 93,072 / 27,868 | +1 | unchanged |

The worktree dist from `pnpm test:package` gives identical raw bytes and 29 B less gzip on pg-representative (166,357) and pg-soft-delete (166,721). This is gzip variance on identical raw bytes (U7-5).

Where the base-entry gzip went, per unit (measured by the units, archive builds):

| Unit | Δ gzip |
| --- | --- |
| U1 | 0 |
| U2 | +3,564 (U2 5b0423e4d +3,558; repair −22) |
| U3 | +2,068 (+1,974; repair +94) |
| U4 | +634 |
| U5 | 0 |
| U6 | +54 |

Total: 166,386 − 160,066 = +6,320.

JUDGEMENT: the cost is structural. U2's largest shares are the hostile-safe definition normalization (definition.ts about +2.1 KB gzip, controls.ts about +1.6 KB); U3's is the deletion effect itself (commands.ts, rows.ts, relation-body.ts). The trims found were worth tens of bytes (U2R-7, U3R-1). §5.2 says a breach is "never permission to raise a ceiling". **An owner decision is required before M1 or M2 can be declared exited.**

## 6. Runtime benchmark gate. MEASURED.

The U5 harness, re-run on dists built from 30ff17e69 and HEAD in scratch archives (impl/u7/rt/bench: samples.log, run.sh, sum.mjs, worker.mjs). 7 rounds of fresh processes, mainA / head / mainB rotating. Times are ns/op, median over 7 samples. Allocation is heapUsed delta over 1,000 ops with 0 GCs in the window.

| Workload | Result | Gate |
| --- | --- | --- |
| No extension (plain read) | main A 27,247, main B 27,685: **stability 1.6%** (rule ≤ 10%). HEAD 27,500, within main's spread [26,187, 30,510], head/main 0.994 | **PASS** |
| Controls only | main A 27,507, main B 27,927: **stability 1.5%**. HEAD 27,768, within [26,432, 31,352], 0.994. On main this arm is the same read through a name-only extension, because main has no controls. | **PASS** |
| Allocation, no extension | main 40,095 B/op, HEAD 40,035 | an unextended client allocates nothing new: **PASS** |
| Allocation, controls-only chain | main 40,094, HEAD 40,043 | recorded |

Recorded for the owner (HEAD rows client vs plain on HEAD / main):

| Workload | Rows client | Plain HEAD / main |
| --- | --- | --- |
| rows read | 26,720 (fewer rows returned) | plain read 27,500 |
| nested read | 100,263 | 127,751 / 126,660 |
| single soft delete + restore | 58,287 | plain update pair 50,368 / 50,355 |
| bulk deleteMany + restoreMany | 54,474 | n/a |
| callback transaction | 38,243 | 35,302 / 35,243 |
| array transaction | 58,586 | 51,288 / 51,726 |
| rows read allocation | 41,260 B/op | n/a |

## 7. Qualification gaps, stated plainly

1. **PostgreSQL and MySQL: nothing executed, ever.** Docker was down in U1 through U7. The plan's M1 exit asks for "every M1 witness on PostgreSQL, MySQL and SQLite through public entry points", and **that exit item is not met**. PGlite (the PostgreSQL engine, in-process, one connection) and SQLite3 / batch-only SQLite3 carry every witness. Never run on a real server:
   - the DC14 create-with-connect racer (the FOR UPDATE lock decision is OPEN, U3R-5);
   - consumer 3 (a live race converging under a domain, U4-8);
   - the PostgreSQL/MySQL restrict and upsert races (DC10, DC14);
   - MySQL's non-RETURNING tombstone paths;
   - MySQL's missingArm CASE inside JSON_OBJECT/COALESCE;
   - the packaged-guard attribution on PostgreSQL batches;
   - the per-arm EXISTS cost on PostgreSQL (measured on SQLite only).
   tests/providers/docker/pg-row-scopes.test.ts and mysql2-row-scopes.test.ts, and the MySQL arm of dropConstraints, are written but never executed. No docker consumer exists for soft-delete-behavior.ts or deletion-capability-behavior.ts. The known PostGIS-less pg container may turn pg docker files red regardless.
   Rerun: `PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm pnpm exec vitest run --workspace vitest.workspace.ts --project provider-pg --project provider-postgres --project provider-mysql2`.
2. **Bundle budget breached (§5): STOP U3R-1 is open.** +6,320 B gzip against +5 KB.
3. **M2 floor passes only on the cumulative reading (§4).**
4. **Biome deviation (U7-2).** Two touched runner scripts carry 38 and 54 pre-existing diagnostics, equal to main.
5. **Known reds**, all present at main: raptor3 has 7 (cs02-structure-measure and six G3/G4 generation campaigns). Not exercised here: the relation-language-census ENOENT (not red in the architecture run, per rv5) and the PostGIS cells (docker).
6. **Accepted limits recorded, not refused:**
   - a model-mapped query handler does not see `rows` declared in its own definition (U6R-3);
   - the DC22 replay compiles, with its types following the first client;
   - a revoked proxy in a *shipped* member (request, query, model) is still a raw TypeError (inherited, U2R-2);
   - an empty deletion entry behaves like `update({ data: {} })` (U3R-10);
   - batch-only arrays still refuse soft deletes with a relation projection, and nested soft deletes, exactly as the base client refuses the hard equivalents (U3R-3);
   - batch-only instrumentation logs one event per batch unit (inherited, U3R-8).
7. **Plan wording differs from the implemented and ratified behaviour. The orchestrator must amend:**
   - §2.4: key on "a read that admitted a control" (U2-7, U2R-6, U4-6);
   - §2.2: which files own prepared domains (U4R-4).
8. **Scratch only:** the runtime harness is not committed (U5-9). The docs link to src/soft-delete/index.ts on GitHub main resolves only after merge.
9. **Instrument limits:**
   - RSS medians at 94-98% heap are noisy; the same source has measured −25.7 to +47.4 MiB between sessions (U1R-8).
   - PGlite peaks here were 1,737-2,000 MiB against a 2,560 ceiling, sampled process-group RSS.
   - O7's "1,500 MiB" versus the plan's 1,536 MiB: U1R-1 ruled that 1,536 governs. Some runs on U1-U6 sources exceeded 1,500, but none in this set did.

## 8. Exit checklists against plan §5

### M1 (§5.1 "Exit, all executed")

| Item | Status | Evidence |
| --- | --- | --- |
| Every M1 witness on PostgreSQL, MySQL and SQLite through public entry points | **NOT MET** for PostgreSQL (server) and MySQL; met on SQLite3, batch-only SQLite3 and PGlite | §3 rows 7-16; gap 1 |
| §1.1 run end to end by the fixture | MET | soft-delete.core.test.ts (layer-client, 19), pglite-soft-delete 17/17, packed third-party consumer (`pnpm test:package`) |
| §5.2 holds: types | MET (M1 at U5 close; the final source against the M2 column, with the floor reading of gap 3) | §4 |
| §5.2 holds: RSS | MET | §4 |
| §5.2 holds: runtime gate | MET | §6 |
| §5.2 holds: bundle | **NOT MET** (STOP U3R-1) | §5 |
| An unextended client allocates nothing new | MET (40,035 vs 40,095 B/op) | §6 |
| A chain without rows or controls keeps today's path | MET: chain.ts binds no call facts; cache key byte-identical (DC7 witnesses); plain-client SQL bytes pinned (U6) | U2-7, U3 review, U6 |
| No result type changes | MET for the base client. Plugins generic over the client see the announced type changes (`M[K & keyof M]`, DC22 replay, DC2 application-only), listed in CHANGELOG "Changed (types)". | CHANGELOG |
| Framing grep finds no soft-delete branch | MET: over `git diff 30ff17e69 HEAD -- src ':!src/soft-delete' ':!*.md'`, with `tombstone` (the plan's §2.3 generic vocabulary) excluded, zero hits for soft/deletedAt/deletedBy/restore/"deleted"/"only"/"without"/"hard"/viborm.soft | this run |
| No cast beyond §1.1's three | MET: src/soft-delete/index.ts lines 30, 95, 96. Added `as` in the rest of src: one mapped-type key remap (controls.ts) and one `as const` (ROOT_CANDIDATES). | this run |
| Independent review of the changed perimeter; required gates on frozen source | MET: rv1-rv6 plus this qualification | reports |
| Guides | MET | soft-delete.mdx: `restore` (13 mentions), `mode: "hard"` with a `:::warning` beside the purge (ruling 8), one actor per transaction, "never for tenant isolation", partial-unique recipe. create.mdx: controls/rows/deletion, DC22 plugin binding. |

### M2 (§5.3 exit: v2 §6 M2 rows, §5.2 M2 budgets, per-arm EXISTS cost)

| Item | Status | Evidence |
| --- | --- | --- |
| Nullability rows: managed target nullable, unique unmanaged target precise, same-shaped twins widen, recursive and polymorphic agree with runtime | MET | row-reference-nullability.core.types.ts (CM002 control); witnesses falsified in U6/U6R |
| Physical-integrity rows: hidden polymorphic arm reads null and a dangling row still fails; junction orphan fails; hidden duplicate singular membership fails; required polymorphic carrier | MET on SQLite3 / batch-only / PGlite; not run on PostgreSQL (server) or MySQL | row-scopes 57 cells, pglite-row-scopes 24 |
| Recursion: upward to-one reads null; the recursive step reads the domain | MET | U6R-1 witnesses |
| `$withCache` hidden relation nullable | MET | U6 |
| §5.2 M2 budgets: types | MET (floor on the cumulative reading) | §4 |
| §5.2 M2 budgets: bundle | **NOT MET** (the same STOP) | §5 |
| Per-arm EXISTS cost measured | PARTIAL: SQLite only, +8 to +15 µs per query for 1,000 pins with 500 hidden claims (U6); PostgreSQL not timed | U6 |
| No hidden target under a non-null type | MET, including query handlers' `proceed()` (U6R-3) | U6R-3 witness |

## 9. Decisions taken while the owner was away

The full text is in scratchpad/softdelete/impl/decisions.md: 126 entries. Per unit:

| Unit | Entries |
| --- | --- |
| U1 | 10 + 8 repair |
| U2 | 15 + 7 repair |
| U3 | 11 + 11 repair |
| U4 | 12 + 7 repair |
| U5 | 12 + 5 repair |
| U6 | 12 + 9 repair |
| U7 | 7 |

The ones the owner should read first:
- U1R-1 / U7-4: the RSS ceiling is 1,536 (plan), not O7's paraphrased 1,500.
- U2-7 / U2R-6 / U4-6: the cache key is `[args, controls, rowIdentity]` only when a read admitted a control; otherwise today's key byte for byte. §2.4's wording needs amending.
- U2R-1: a fifth announced breaking cache change. A cache-chain write with a primitive argument moves from CacheConfigurationError to ValidationError.
- U2R-3: the official cache always places its own control.
- U3-3 / U3R-3: soft deletes pack into batch-only arrays through the packaged guard. The guard-failure taxonomy gains `foreignKey`.
- U3R-5: DC14 (FOR UPDATE lock) is OPEN, pending the docker racer.
- U3R-6 / U3R-7: the core ForeignKeyError carries the caller's verb and "one of its relations".
- U3R-10: an empty deletion entry is documented, not refused.
- U4-3: nested write lookups take the related purpose on every edge.
- U4-4: DC10 on the batch route. The found UPDATE carries the root domain, so a race loser gets NotFound.
- U5-1: §1.1 ships verbatim, git-moved; three casts.
- U6-4: a rows model set typed `string` hides every model (+1,267 floor types, taken for soundness).
- U6-8 / U6R-4 / U7-3: the cumulative floor reading.
- U6R-3: query handlers typed with the chain's rows context; `ClientOperationResult` deleted (internal).
- The orchestrator's O4-O7 (rulings.md): per-target nullability; `set` over a required FK keeps its refusal; the cache breaking changes announced; the budgets as written; the docker gap recorded; one PR, no merge.

## 10. Accounting. MEASURED.

Rule: the repo's code-bearing rule (TypeScript scanner, `countTokenLines`). A line counts when a parser-owned token starts on it; comments and JSDoc are excluded. Docs are physical lines. Script: impl/u7/codelines-rev.mjs; output: impl/u7/accounting.txt.

| Unit (unit + repair) | src code-bearing | tests + scripts code-bearing | docs (.md/.mdx) physical |
| --- | --- | --- | --- |
| U1 30ff17e69..2ac4eae84 | +295 / −83 (net +212) | +303 | +18 |
| U2 ..5b6a625f2 | +1,444 / −257 (net +1,187) | +1,514 / −27 | +66 / −5 |
| U3 ..5cbcf8fe3 | +668 / −116 (net +552) | +1,077 / −3 | +17 |
| U4 ..eca08f842 | +293 / −102 (net +191) | +1,122 / −1 | +44 |
| U5 ..5d045dbdb | +95 (net +95: src/soft-delete/index.ts, git-moved from the U1 test fixture) | +788 / −1 | +641 / −53 |
| U6 ..572de61f7 | +158 / −57 (net +101) | +737 / −10 | +103 / −22 |
| **Total vs main** | **+2,850 / −512, net +2,338** (21,528 → 23,866) | **+5,434 / −30, net +5,404** | **+867 / −58** |

src net by area:

| Area | Net code-bearing lines |
| --- | --- |
| src/extensions | +1,515 |
| src/query-engine/raptor3 | +564 |
| src/client | +114 |
| src/soft-delete | +95 |
| src/cache | +91 |
| query-engine/pending-operation.ts | +35 |
| schema | +16 |
| validation | +14 |
| batch-error-attribution | +4 |
| index.ts | +2 |
| migrations | −8 |
| query-engine/cache-flow.ts | −104 |

Against the plan's estimate (JUDGEMENT on the comparison, the counts are measured):
- src: +2,338 net, against the plan's "about 1,870-2,120 code lines", so 10-25% over. The excess is concentrated in U2's hostile-safe definition normalization (definition.ts about +585).
- The soft-delete entry is 95 code-bearing lines as Biome formats it, against the plan layout's 65. The token content is identical to §1.1.
- tests: +5,404 against the plan's "about 4,000" (manifests and receipt scripts included).

## 11. CHANGELOG check

CHANGELOG.md "Unreleased" was read against O6 and the units.

| Required entry | Present |
| --- | --- |
| Added `viborm/soft-delete` | yes |
| Added `controls`/`rows`/`deletion` ("nine capabilities") | yes |
| Added `ExtensionState` and `ExtendedOperationResult` exports | yes |
| Changed (types): `M[K & keyof M]`, DC22 replay, DC2 application-only, `Client`'s optional 4th parameter, `$withCache` controls | yes |
| O6's four breaking cache changes (patches cannot inject/replace `cache`; request handlers no longer see it; throwing getter → QueryError; checked before request handlers) | yes |
| U2R-1's fifth (primitive mutation arguments → ValidationError) | yes |
| The two additions (`cache()` value has `controls`; handler `context.controls`) | yes |
| The two DC6 items that do NOT happen (`Client`'s 3rd parameter meaning; the "Invalid mutation cache options" message) | yes, under "Unchanged" |
| M2's to-one `null` and `| null` typing | yes |
| query handlers' `proceed()` read rows | yes |

Not listed, and correctly so, because both were internal and absent from every public entry (checked against src/client/exports.ts and the golden): the deleted `ClientOperationResult` and `ClientRelationDefaults`.

Public-surface golden diff vs main: `ExtendedOperationResult` and `ExtensionState` on `.`; the new `./soft-delete` subpath (`softDelete`; types `SoftDeleteConfig`, `SoftDeleteModel`); `softDelete` pinned absent from the root. Nothing else.

## 12. Head

**572de61f743b83871725106bc77bb2e69a893959** on extension-capabilities, unchanged by U7. It is ready to open as one PR against main, not merged, once the owner rules on:
- the bundle STOP (U3R-1);
- the M2 floor reading;
- whether the PostgreSQL/MySQL gap blocks the PR or is closed by a follow-up docker run.
