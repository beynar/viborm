# Footprint program: the non-engine half of the bundle

Normative plan for shrinking what a VibORM application ships, outside the
query engine. The engine is Raptor 3's job; this program owns everything else in
the client bundle and, secondarily, maintained source lines.

Principle, unchanged from the native-ids program: **declare facts once, derive
everything else; one owner per invariant; measure before and after with the
same frozen instrument.**

## Where it starts

Measured on branch `native-ids-bigjs` (PR #43), `pg-representative` fixture,
`docs/architecture/native-ids-evidence/final.json`. "Minified" is esbuild
output before compression; the fixtures under `scripts/bundle-fixtures/` are
frozen and never edited.

| Component | Minified | Chunks |
|---|---|---|
| Query engine | 500 KB | `pending-operation-*` — out of scope, Raptor 3 |
| Validation | 136 KB | `validation-*` 50, `validator-*` 39, `datetime-values-*` 29, `v-*` 18 |
| Driver + adapter | 56 KB | `driver-*` 37 + 11, `postgres-adapter-*` 7 |
| Client | 35 KB | `client-*` |
| Relations, preflight, diagnostics, result normalization | 57 KB | `to-many-*` 17, `registration-preflight-*` 16, `normalized-result-*` 12, `diagnostics-*` 12 |
| big.js + @noble/hashes | 12 KB | real dependencies |
| Remainder | 50 KB | sql, clock, native types, parameter snapshots, entry stubs, extensions |
| **Total** | **846 KB** (231 KB gzip, 191 KB brotli) | |

Yardsticks, same bundler, same options, driver external: Drizzle's whole
PostgreSQL surface 98 KB / 25 KB gzip; Kysely 160 KB / 31 KB; all of valibot
(311 exports) 86 KB / 15 KB. VibORM's validation alone is 1.6× the whole of
valibot.

## Where it ends

| Component | Today | Target | Lever |
|---|---|---|---|
| Validation | 136 KB | 55 to 65 KB | one builder per scalar family; delete lazy/intern layer; one operation-schema composer |
| Driver + adapter | 56 KB | 28 to 32 KB | per-driver wiring folded into `drivers/shared` |
| Client | 35 KB | 12 to 15 KB | one proxy/delegation path, one error envelope |
| Relations, preflight, diagnostics | 57 KB | 22 to 28 KB | one graph walk, one issue composer |
| Decimal value type | 7 KB + types dep | ~3 KB, zero deps | VibORM's own `Decimal` over `BigInt` |
| Remainder | 50 KB | 22 to 28 KB | dead branches, duplicate spellings |
| **Non-engine total** | **346 KB** | **≈ 160 to 180 KB** | |

With the engine at 28% of today (140 KB), the client bundle lands near
**300 KB minified / 80 to 90 KB gzip**, about a third of today and roughly
3× a query builder, which is the honest cost of a Prisma-class feature set with
runtime validation. Below that the constraint is architectural (dynamic
per-model dispatch, Prisma-shaped argument validation), not cleanliness.

Source lines: non-engine `src/` is 74,400 code + 21,100 comment lines. Target
30 to 35% off, mostly comments (22% of the tree) and the duplications below.

## Decisions already taken

- **Own `Decimal`, no big.js.** An immutable value over a `BigInt` coefficient
  and a scale: `plus`, `minus`, `times`, `div(dp, rounding)`, `cmp`/`eq`/`lt`/
  `lte`/`gt`/`gte`, `abs`, `neg`, `toString`, `toFixed(dp)`, `toNumber`. No NaN,
  no Infinity, no global configuration statics. Removes `big.js`,
  `@types/big.js`, the dependency-types package smoke, and the foreign-value
  defenses in `decimal-codec.ts` (prototype capture, `s/e/c` snapshot,
  forgery checks, render ceiling): a `Decimal` VibORM constructs is trusted by
  construction; only string and number inputs cross admission. Everything the
  user declares stays: `s.decimal({ precision, scale })`, canonical text,
  provider codecs, limits, DDL, fresh instances at the result boundary.
  **Land it inside PR #43 before merge** so the big.js step is never public and
  there is one Decimal API change (decimal.js → VibORM), not two.
- **Remove `valibot` and `arktype` from `dependencies`.** Declared, never
  imported by `dist/`. One-line change, same PR as the Decimal work.
- **Comments are a lever for LOC, not bytes.** They are stripped by
  minification; cut them for readers, never count them as bundle savings.

## Decision still open: `@noble/hashes`

It exists only for CUID2's SHA3-512 (4.6 KB minified). Options, in the order of
my recommendation:

1. **Keep it.** A well-audited hash for 4.6 KB. Recommended.
2. **Drop `.cuid()`.** Removes the dependency; breaking for CUID2 users.
3. **In-house Keccak-f[1600].** ~100 lines, ~1.5 KB minified, net saving 3 KB,
   and it is writing a cryptographic hash to shave 3 KB. The native-ids plan
   ruled this out; nothing has changed.

The program does not touch it until the owner picks one.

## Prerequisites (workstream 0)

1. **Re-scope the test-run lock.** `scripts/test-run-lock.mjs` keys the lock on
   `git rev-parse --git-common-dir`, so every worktree of the repo serializes on
   one lock and parallel workers spend their time waiting. Key it on the
   worktree root (`git rev-parse --show-toplevel`). Verified cost during the
   native-ids program: Stage B and C blocked each other; the paused footprint
   workers did too.
2. **Raptor 3 landed and its input contract frozen** before workstream 2 (the
   operation-schema half of validation) starts. Everything else is independent
   of the engine.
3. **PR #43 merged**, with the Decimal work folded in, so every branch below
   forks from one line.

## Workstreams

Non-overlapping by file, Hermes-style: no two workstreams touch the same
source file, so integration is a fast-forward or a trivial merge.

| # | Workstream | Files | State | Bundle | LOC |
|---|---|---|---|---|---|
| 1 | Own `Decimal` + drop valibot/arktype | `src/validation/primitives/decimal*.ts`, `src/index.ts`, `package.json`, decimal tests, CHANGELOG | not started; **fold into #43** | −4 KB, −2 deps | −300 to −500 (codec defenses) |
| 2 | Validation scalars | `src/validation/scalars/**`, `src/validation/lazy.ts` | not started | −25 to −30 KB | −1,800 |
| 2b | Validation operation schemas | `src/validation/model/**`, `src/validation/relations/**` | **blocked on Raptor 3** | −30 to −40 KB | −2,500 |
| 3 | Drivers | `src/drivers/**` | paused: worktree `viborm-fp-drivers`, 5 commits + 1 uncommitted file, unreviewed, −2 KB so far | −20 to −25 KB | −1,500 |
| 4 | Client wiring | `src/client/**` runtime (not `types.ts`, `result-types.ts`) | paused: `viborm-fp-client`, 7 commits + 3 uncommitted, unreviewed, −1 KB so far | −18 to −22 KB | −1,200 |
| 5 | Errors and diagnostics | `src/errors/**` | paused: `viborm-fp-errors`, 6 commits, clean, unreviewed, −0.6 KB so far | −5 to −7 KB | −600 |
| 6 | Schema document + relation rules | `src/schema/json/**`, `src/schema/validation/**` | not started | −8 to −12 KB | −2,000 (table-drive the read/write mirror; one graph walk) |
| 7 | Migrations column kinds | `src/migrations/**` | not started | 0 (CLI only) | −7,000 to −9,000 (ten-owner column kind → one table) |
| 8 | Comments pass | everything, after 1–7 | not started | 0 | −10,000 to −12,000 |
| 9 | tsdown chunking | `tsdown.config.ts` | optional | small; bounded by dynamic dispatch | 0 |

Workstreams 1, 3, 4, 5, 6, 7 are independent of the engine and of each other.
2 can start now; 2b waits.

## Method, per workstream

The same shape as the native-ids stages, which caught two live-database
blockers and a collation bug that the test suite had not:

1. **Read.** One agent measures the duplication with `file:line` and line
   counts, writes an ordered plan naming the single surviving owner per step and
   the tests that pin the behavior, lists what only looks duplicated.
2. **Implement** in a fresh worktree off the integration branch, one commit per
   verified step, area gates after each.
3. **Two adversarial reviewers**, distinct lenses (behavior preservation with
   executed reproductions; honesty of measurement and rules), refute with
   evidence, no style nits.
4. **Fix pass** by the implementer, each finding reproduced first.
5. **Orchestrator** reads the diff, re-runs `pnpm test:core`, re-measures, and
   fast-forwards.

Rules every worker inherits: behavior-preserving; no public API or type change;
no pinned message change; no engine/validation contract change; no type
assertions; no guard without nameable coverage (ledger entry); coverage floors
never lowered; the public-surface golden and error-names smoke must pass;
fixtures never edited; every deleted line is duplication of a survivor or proven
dead. Falsify: remove the fix, watch exactly the new test go red.

## Verification and reporting

`pnpm test:core` fully green (508 files / 10,357 tests at the base),
`pnpm test:types`, `pnpm test:package`, `pnpm package:lint`, area coverage
floors, provider lanes for driver work (pre-existing reds: 15 PostGIS on pg,
156 MySQL fingerprint/strict; pglite per-file only). After each merge:
`pnpm package:build && node scripts/measure-bundle.mjs --out
docs/architecture/native-ids-evidence/footprint-<n>.json`, compared to
`final.json`. Final report in the shape of `native-ids-report.md`: Outcome,
Validation, Risks, every number quoted from an artifact.
