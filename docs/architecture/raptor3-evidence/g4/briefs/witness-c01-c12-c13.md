# Independent witness brief — C01/C12/C13 fixed witnesses, generated read campaign, native lanes

Read `common.md` first. You are the independent witness author. You do not
implement engine behavior and you must not derive expected behavior from the
candidate. Expected outcomes come from the shipped public contracts, the
shipped engine run over the same SQLite state (differential oracle), and
hand-computed or independently computed values.

## Where you work

Main tree **`/Users/arnaud/code/viborm`**. The G4-03 author concurrently edits
`src/query-engine/raptor3/route/`, small seams in `src/query-engine/query-engine.ts`,
`pending-operation.ts`, `write-engine/OperationExecutor.ts`, `src/client/*`, and
`tests/raptor3/g4/route-*.test.ts`, `tests/types/raptor3/`. The G4-01 author
edits the candidate query owners in a separate worktree; the candidate in this
tree is the frozen G3 version, so most of your C01/C12 witnesses are expected
to be **red** here. That is the intended handoff evidence.

Evidence directory:
`/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/witness/`.

## Files you own

- `tests/raptor3/g4/*.test.ts` except `route-*.test.ts`, and everything under
  `tests/raptor3/g4/generation/`, `tests/raptor3/g4/native/`.
- As the delegated sole writer for this milestone: `scripts/raptor3-manifest.mjs`,
  `scripts/run-raptor3.mjs`, `scripts/raptor3-campaign-receipts.test.mjs`,
  `scripts/raptor3-cli.test.mjs`. Register your suites and the G4-03 author's
  suites (it sends requests through
  `docs/architecture/raptor3-evidence/g4/unit03/note.md`, section
  "Registration requests"; poll that file when you register). Keep every
  existing mode, count and campaign definition unchanged.
- Shared harness files under `tests/raptor3/harness/` and
  `tests/raptor3/scenarios/` only for additive observations (new event kinds
  or recorders) that existing consumers cannot break; record every such edit.

## Outcome

1. **Fixed C01/C12 witnesses** (`tests/raptor3/g4/read-*.test.ts`), one file
   per inventory family, covering every row OP-R01–OP-R09, Q-W01–Q-W10,
   Q-O01–Q-O04, Q-P01–Q-P03, Q-S01–Q-S03, Q-A01–Q-A02, Q-R01, and the read
   crossings of SC-01–SC-14 and SL-01–SL-10. Each test seeds real SQLite rows
   (competing rows and unrelated memberships that must remain untouched),
   runs the candidate through `createCommandEngine({ schema, driver }).execute(...)`
   (pattern: `tests/raptor3/g3/bulk-series-contract.test.ts`), and asserts
   exact public results (fresh containers, scalar identities such as
   `Decimal`, `Date`, `bigint`, `Buffer`, JSON null sentinels), exact error
   identities for refusals and malformed provider rows, and where the
   contract fixes it, statement/round-trip counts. Use the shipped client on
   the same database as the differential oracle where the contract is
   behavioral; when the two disagree, the shipped engine is a disputed row,
   not automatically right: record it in `note.md`.
   Include both FK orientations, junctions, variants, compound and mapped
   keys, default omit, nested pagination per parent, and the recursive-read
   fit on the fuller codec set (extend, do not copy,
   `tests/raptor3/prep/recursive-read-fit.test.ts` — keep its file untouched).
2. **C13 falsifiers** for the private route, in cooperation with the G4-03
   author's own oracles: at least the missing-event, double-admission,
   double-transform, cache-bypass and observer-failure-isolation falsifiers
   (`tests/raptor3/g4/lifecycle-*.test.ts`). They run once the route exists;
   until then they are expected red and recorded as such.
3. **Generated read campaign** (`tests/raptor3/g4/generation/`): seeded
   schema families (scalar-rich model with every codec and list type, a
   to-one/to-many/junction/variant/self-relation family, mapped compound
   keys), a recipe generator producing filter/order/page/projection/aggregate
   requests within the admitted public vocabulary, an **independent JS oracle**
   over the seeded rows (not SQL through the candidate, not the candidate's
   decoder), controlled clock/defaults, and exact replay. Register it as a
   campaign with the frozen ranges in `g4.md`: SQLite profiles seeds
   20000–44999, transport profiles seeds 50000–74999, batches ≤ 100 seeds,
   child receipts with identity, replay count 3, compact per-batch summary
   and gzip corpus support like the G3 generation (`tests/raptor3/g3/generation/`
   and `scripts/run-raptor3.mjs` `g3-seeds` / `g3-transport-seeds`). Add the
   receipt assertion (`assertG4GeneratedBatchReceipt`) in the manifest with the
   same rigor as `assertG3GeneratedBatchReceipt` (per-profile actor/fault
   quotas where the recipe injects faults, contract family rotation, seed
   bounds, zero skips). Add harness self-tests (generation, coverage, replay,
   receipt refusal on stale identity) and the CLI integrity entries.
   The campaign must be runnable at 1–100 seeds now (red against the frozen
   candidate is fine; the oracle and receipts must work) and its 120-second
   child limit must hold: measure a 100-seed child and record wall/RSS.
   Estimate the per-child corpus size and record the projected disk need for
   250 children per family.
4. **Native lanes** (`tests/raptor3/g4/native/*.test.ts`): PostgreSQL and
   MySQL suites for scalar codec round-trips through the candidate (DateTime,
   decimal, bigint, JSON, blob, vector, GeoPoint, lists), string mode
   collation behavior, `nulls` ordering, cursor pagination, `_count`/aggregate
   shapes, and the recursive-read fit lowered natively. Use the existing live
   fixture pattern (`tests/raptor3/g3/scope-composition-native.test.ts`,
   `tests/raptor3/prep/native-set-preparation.test.ts`) and the same
   credential environment. Register them as native modes
   (`g4-…-pg-contracts`, `g4-…-mysql-contracts`). **Providers are currently
   unavailable** (see `g4.md` environment table); write and register them,
   attempt one run to capture the exact refusal/connection failure receipt,
   and report them as blocked, never as passed.
5. **Registration**: fixed modes `g4-read-*`, `g4-lifecycle-*`, `g4-route-*`
   (for the G4-03 author's files), campaign modes `g4-seeds`,
   `g4-transport-seeds`, native modes; expected counts per file; runner
   `parseRaptor3Request` mode list; receipt self-tests; `raptor3-cli.test.mjs`.
   Run `node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs`
   and `node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs`
   after registering; they must pass.

## Method and evidence

- Read the cited shipped evidence for each row before writing its witness.
  Record for each witness: row ID, contract source, oracle kind, and whether
  it is currently red/green and why.
- Run through `node scripts/run-vitest-safe.mjs run <files>` or
  `node scripts/run-raptor3.mjs <mode>` after registration. Save JSON
  reporter output and the bounded-runner resource line for every run under
  the evidence directory, named by mode and attempt. Red runs keep their raw
  output; they are the handoff evidence for G4-01/G4-02.
- Run `node scripts/run-typecheck.mjs` before hand-off: your files must add
  no diagnostics.
- Write `note.md`: coverage matrix (row → witness → status), oracle design,
  campaign design and measured child cost, disk projection, registration
  table, disputed rows, blockers, unverified claims.

## Exit and return value

Return a structured summary: note path, witness files with test counts and
current red/green status per file with receipt paths, campaign design
(seeds, profiles, batch size, measured child wall/RSS, corpus bytes per
child, projected disk), registered modes and counts, self-test results,
native suites and the exact blocked receipt, disputed rows, harness edits,
typecheck result, blockers, unverified claims.
