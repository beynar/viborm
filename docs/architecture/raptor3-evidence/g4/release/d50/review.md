# Release unit "d50" — independent review

Reviewer: independent session (not the integrator). Reviewed tree: main
worktree `/Users/arnaud/code/viborm`, branch `pattern-engine`, head `b7b0f7235`,
unit uncommitted (`git diff -- src tests scripts CHANGELOG.md` plus the two
untracked pins). `TMPDIR=/private/tmp/viborm-d50-review-tmp` for every test run.
No file under `src`, `tests` or `scripts` was edited by this review.

## Verdict: ACCEPT

The diff does exactly what D-50 and `note.md` claim: it gives PostgreSQL-family
batch-only transports an exact identity scratch for one generated increment
key, spelled by the dialect as a data-modifying CTE around the INSERT, gated
live by `capabilities.supportsCteWithMutations`, with the engine choosing
nothing beyond "is this one increment key and does the dialect state a store."
Every hunk was read against the note and the twelve rules in
`g4/briefs/common.md`; every discriminating test the review brief named was
re-run in this tree, one live-PGlite pin was reproduced from a genuinely cold
base, and biome/coverage were independently checked. No patchwork, no second
authority, no policy boolean, no weakened or skipped test was found.

## What was checked, and how

### 1. Single-authority checks (adapter contract, capability, dialect-owned store, engine choice)

- `src/adapters/adapter-core-types.ts`: `CastType` gains `"bigint"`;
  `BatchReferenceSqlAdapter` gains `storeReturning?` and `storeInsertedKey?`,
  both documented as PostgreSQL-only / dialect-derived. `createCastExpression`
  takes `Record<CastType, string>`, so TypeScript itself forces every adapter's
  cast map to add a `bigint` entry — confirmed the only three call sites
  (mysql, postgres, sqlite adapters) all did, and no other implementation of
  `cast` exists in the tree (`grep -rn "createCastExpression("` → exactly those
  three).
- `src/adapters/shared/batch-refs.ts`: `createBatchRefs` derives
  `storeInsertedKey` ONCE — `storeReturning` present ⇒ the CTE store alone;
  otherwise `lastInsertId` present ⇒ `[insert, config.store(..., lastInsertId())]`;
  otherwise `undefined`. This is the single owner of "how a generated key is
  stored, in order" the note claims — no second copy of this decision exists
  anywhere in the diff.
- `src/adapters/databases/postgres/postgres-adapter.ts`: `#cteBatchRefs` is
  the always-capable inner object (`storeReturning` spelled as the documented
  `WITH "__viborm_inserted" AS (<insert> RETURNING <column>) INSERT INTO
  "__viborm_batch_refs" ...`). `#batchRefs` wraps it with `get storeReturning()`
  / `get storeInsertedKey()` accessors that read `capabilities.supportsCteWithMutations`
  **live**, not memoized at construction — verified both by reading the code
  (plain getters closing over `this.capabilities`) and by the new contract
  test `"the dialect states how a generated increment key is stored, in order
  (D-50)"` in `tests/contracts/adapters/internals-and-geo.core.test.ts`, which
  flips `adapter.capabilities.supportsCteWithMutations` on the SAME adapter
  instance after construction and asserts `storeReturning`/`storeInsertedKey`
  disappear and reappear accordingly. This is exactly "the one authority the
  estate already toggles," read live, as the note states — not a new capability
  and not an engine-side re-derivation.
- `src/query-engine/raptor3/shared/operation-context.ts`, `insert`'s batch arm:
  `carriesIdentity = insertIdField !== undefined && storeInsertedKey !== undefined`.
  `insertIdField` is the pre-existing single-increment-field check (unchanged,
  `produced.length === 1` and `autoGenerate.kind === "increment"`); the only new
  fact read is `references.storeInsertedKey`, the dialect's own derived answer.
  The engine does not choose between the CTE store and the last-insert-id
  store, does not read `supportsCteWithMutations` itself, and does not spell
  any SQL — it queues whatever statements `storeInsertedKey` returns, in order,
  with the first one carrying the original statement context and producer
  record. This matches "one owner per fact, no policy boolean in the engine."
  The refusal guard (`!carriesIdentity` and (`!supportsReturning` or
  `supportsCteWithMutations`)) is the same shape as before the diff, just fed
  by `storeInsertedKey === undefined` instead of `!storeLastInsertId`; a
  provider that can mutate in a CTE but has a non-increment or multi-field
  produced set still refuses, matching "the guard stays for the shapes the
  scratch cannot carry."
- Width: the previous unconditional `"integer"` cast on the scratch read is now
  `physicalField(this.schema, model, insertIdField).scalar["~"].state.type ===
  "bigint" ? "bigint" : "integer"` — reusing the exact `scalar["~"].state.type`
  accessor already used elsewhere in this file and in `shared/query.ts` (not a
  new authority). Confirmed by both pins: `increment-key-width.test.ts` (SQLite,
  deterministic) asserts the read-back statement casts `AS INTEGER` for the
  64-bit SQLite width, and the dialect-vocabulary contract test asserts
  PostgreSQL's `bigint` cast spells `BIGINT` while MySQL/SQLite's `bigint` cast
  is identical to their `integer` cast (both already 64-bit).

Conclusion for (1): capability, dialect spelling, and key-store ownership each
have exactly one authority, read live where required; the engine's batch arm
adds no decision beyond the two named facts.

### 2. Dropping `ON COMMIT DROP`

The PostgreSQL scratch table create statement no longer carries `ON COMMIT
DROP`. Reasoning in `note.md` §2 (a record series commits member by member on
a batch-only transport; the second segment's INSERT reads the reference the
first batch stored, and with `ON COMMIT DROP` found no table — `42P01`) is
sound: a `TEMP TABLE ... ON COMMIT DROP` is dropped at the end of the
transaction that (re)creates it, which is incompatible with a scratch that has
to survive into a later, separately-committed segment on the same session.

Judgment: a lingering per-session TEMP table is acceptable here. It is not a
new pattern — SQLite's and MySQL's scratch tables already live for the
session/connection lifetime, and `setup` still runs `CREATE TEMP TABLE IF NOT
EXISTS` so it is idempotent across scratch instantiations within one session.
Cleanup is unconditional and unchanged by this diff: `clear` (`ensureScratch`,
line ~2223) deletes any rows for a fresh scratch id before use, and `cleanup`
(`finishTerminals`, line ~1519–1522, confirmed NOT touched by this diff — same
`deleteBatch` used for both `clear` and `cleanup` in `batch-refs.ts`) deletes
the batch id's rows once its terminals are queued. Since each scratch id is a
fresh `crypto.randomUUID()`, a batch that throws before reaching cleanup could
in principle leave an orphaned row set under a batch id nothing will ever
reuse — a bounded, non-recurring leak of the same shape the SQLite/MySQL
scratch tables already accept, not a new risk introduced by this unit. Noted
for completeness, not a blocker.

### 3. Error attribution unchanged in meaning

`TransportAttempt.recordInsertProducer` keys a `Map<BatchQuery, object>` by
the exact queued statement object, not by index or position
(`src/query-engine/raptor3/shared/transport-attempt.ts:29`). The diff's
`const inserted = this.queue(producing!, context, member); if (producer)
this.attempt.recordInsertProducer(inserted, producer);` attributes the
producer to whichever statement actually performs the INSERT — for PostgreSQL
that IS the CTE-wrapped statement (the CTE's inner clause is the literal
INSERT whose unique-violation would surface through executing this one
statement), for SQLite/MySQL it is still the plain INSERT. Same statement
context (`context`) and same `member` are threaded through unchanged. This is
the same attribution rule as before the diff, applied to a (dialect-chosen)
different physical statement; nothing about "which statement owns this error"
was re-decided by the engine.

### 4. Discriminating tests — all re-run in this tree

| Command | Result |
|---|---|
| `node scripts/run-vitest-safe.mjs tests/contracts/adapters/internals-and-geo.core.test.ts` | 22/22 passed |
| `node scripts/run-vitest-safe.mjs tests/contracts/adapters/dialect-vocabulary.core.test.ts` | 34/34 passed |
| `node scripts/run-vitest-safe.mjs tests/raptor3/g4/parity/increment-key-width.test.ts` | 1/1 passed |
| `node scripts/run-vitest-safe.mjs tests/raptor3/g4/parity/upsert-array-route.test.ts` | 6/6 passed |
| `pnpm test:all --only "postgres-identity-scratch"` (live PGlite, gate stage) | 2/2 passed |
| `node .../run-shared-family.mjs tests/contracts/engine/write/generated-output-fallback.test.ts` | 4/5 passed; the one red reproduced byte-for-byte against `receipts/family/generated-output-fallback.log` (`UnsupportedOperationError`: "query-engine-v2 create cannot resolve the parent id for relation 'account': referenced field 'providerId' is neither this record's primary key nor a knowable value in its own create data.") — this is the SQLite nested-connect "known"-value defect the note classifies as C and NOT this unit's: it fires inside `BatchOnlyNonReturningSQLiteDriver`'s nested `account: { create: { provider: { connect: {...} } } }` case, unrelated to the PostgreSQL CTE/identity-scratch code this unit touches |
| `pnpm test:all --only "Raptor 3 fixed"` | 758/758 passed, matching the note's receipt exactly |
| `pnpm test:coverage:adapters` | 100/100/100/100 on every file, matching the note's receipt |

Also independently re-ran one more family file not explicitly required
(`tests/contracts/engine/write/junction-produced-identity.test.ts`) as a cross
check: 10/12 passed, the same 2 reds (skipDuplicates adopt, both arms) byte-
for-byte matching `receipts/family/junction-produced-identity.log` — further
corroborating that the family's remaining reds are the five pre-classified
class-C cells and not new fallout from this diff.

`node scripts/run-typecheck.mjs` (whole-estate, native): 0 diagnostics,
consistent with `receipts/typecheck.log`.

### 5. Falsification reproduced at a genuinely cold base

`git worktree add --detach /private/tmp/viborm-d50-verify-base HEAD`, copied
only the untracked pin `tests/raptor3/g4/parity/postgres-identity-scratch.test.ts`
into it (the fixture `BatchOnlyPGliteDriver` it needs already exists at HEAD),
`pnpm install --offline` to materialize `node_modules`, then
`node scripts/run-vitest-safe.mjs tests/raptor3/g4/parity/postgres-identity-scratch.test.ts`.
Both cases failed exactly on the registered refusal:

```
Error: Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING
 ❯ OperationContext.insert src/query-engine/raptor3/shared/operation-context.ts:2318:17
```

`git worktree remove /private/tmp/viborm-d50-verify-base --force` afterward;
nothing else in that worktree or this one was touched.

### 6. Biome — every touched file

Checked all fourteen touched/untracked files with `npx biome check`. Findings:

- `src/adapters/adapter-core-types.ts`, `src/adapters/databases/mysql/mysql-adapter.ts`,
  `src/adapters/databases/postgres/postgres-adapter.ts`,
  `src/adapters/databases/sqlite/sqlite-adapter.ts`, `src/adapters/shared/batch-refs.ts`,
  `tests/contracts/adapters/dialect-vocabulary.core.test.ts`,
  `tests/contracts/adapters/internals-and-geo.core.test.ts`,
  `tests/raptor3/g4/parity/postgres-identity-scratch.test.ts`,
  `tests/raptor3/g4/parity/increment-key-width.test.ts`: clean.
- `src/query-engine/raptor3/shared/operation-context.ts`: 7 pre-existing
  diagnostic blocks (organizeImports + `noParameterProperties` + formatter
  drift), identical in count when checked against `git show HEAD:...` of the
  same file — the note's "diagnostics identical to its base" claim holds.
- `scripts/raptor3-manifest.mjs`: 71 pre-existing diagnostic blocks
  (`noMisplacedAssertion` on non-test `assert` helper usage plus formatting),
  identical count against the base copy — pre-existing, not introduced here.
- `scripts/credential-free-test-manifest.mjs`, `scripts/run-credential-free-tests.mjs`:
  base HAD an `organizeImports` diagnostic each (unsorted import list); the
  diff's large import-list reordering (verified by diffing the parsed import
  name sets: identical set plus the one addition, `D50_PROVIDER_TESTS` — no
  export silently dropped) leaves both files biome-clean. This exceeds the
  note's claim ("clean") rather than falling short of it.

### Registration and wiring

`D50_PROVIDER_TESTS` (`tests/raptor3/g4/parity/postgres-identity-scratch.test.ts`)
is registered in all three places the note claims, matching the existing
`G1_PROVIDER_TESTS` pattern exactly: exported from `scripts/raptor3-manifest.mjs`
and folded into `RAPTOR3_PROVIDER_TESTS`; added to `extendedLocalExclusions` in
`scripts/credential-free-test-manifest.mjs` (so a plain local walk skips it);
appended to the `raptor3-provider` stage list in `scripts/run-credential-free-tests.mjs`.
`CHANGELOG.md` and `src/query-engine/raptor3/AGENTS.md` hunks match the note's
description; the AGENTS.md paragraph correctly states the scratch's scope
limit ("do not widen the scratch to other produced columns without a ruling").

## What could not be verified

- Neon HTTP itself was not exercised (no credential-free transport for it);
  the note states this and names the PGlite batch-only fixture as the
  stand-in. Taken on the note's word, as instructed — this is explicitly out
  of scope for a credential-free review.
- `receipts/numstat.txt` reports `62 0` for
  `tests/contracts/adapters/internals-and-geo.core.test.ts`; the actual working
  tree diff is `76 0`. This is a stale intermediate receipt (predating the
  "capability read live" and "neither mechanism" test cases that are present
  and passing in the file today, per §1 and §4 above) — a paperwork gap, not a
  correctness gap. Not a blocker; worth regenerating the receipt if this note
  is revised.
- Did not re-run `mode-g2-baseline`, `mode-g2-contracts`, `mode-g3-transaction-array`,
  `coverage:query-engine-core`, or `coverage:policy` myself — outside the set
  the review brief named as required; the receipts for these are consistent in
  shape with everything independently reproduced above and there is no reason
  from the diff's shape (adapters + one engine file) to expect query-engine-core
  coverage to have moved outside its floor.

## Findings by severity

- **Blocking:** none.
- **Major:** none.
- **Minor:** the lingering per-session PostgreSQL TEMP table on an
  exception-before-cleanup path (an orphaned, never-reused batch id's rows
  persist for the session) — same shape already accepted for SQLite/MySQL
  scratch tables, not introduced by this unit, not a regression, noted for
  awareness only.
- **Nit:** `receipts/numstat.txt` is stale against the final
  `internals-and-geo.core.test.ts` (62/0 recorded vs. 76/0 actual); regenerate
  if this note is ever amended.

## Conclusion

D-50 is implemented as ruled: the CTE identity scratch, not a fallback to
segmented RETURNING, not the refusal. One authority per fact throughout
(dialect spells the SQL, capability is read live by the one consumer that
needs it, the dialect states the key-store order, the engine chooses only
"one increment key AND a stated store"). Every registered refusal and every
already-classified defect stays exactly where the note says it is; nothing was
weakened, deleted, or skipped to get here. **ACCEPT.**

Review path: `docs/architecture/raptor3-evidence/g4/release/d50/review.md`
