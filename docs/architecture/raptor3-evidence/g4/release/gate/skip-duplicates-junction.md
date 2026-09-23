# skip-duplicates-junction — gate triage note

Family: cells in the six files below, run under `--project extended-local`
(PGlite) via `node scripts/run-vitest-safe.mjs`. Repo `/Users/arnaud/code/viborm`,
branch `pattern-engine`, HEAD `7bc08ebd9`. Read-only; nothing in the repository
was edited.

Evidence lives in `/private/tmp/viborm-triage-skipdup-tmp/`. `polymorphic-collection-write-family.test.ts`
(2,326 lines, 88 tests) would not fit under the 1,536 MiB ordinary ceiling as one
file even after several retries (1537–1612 MiB observed, competing with sibling
triage lanes' vitest processes on the same host) — it was run to completion in
`-t`-filtered partitions of the same file (see Blockers) whose union is the full
88 tests, confirmed by matching each partition's `(failed+passed+skipped)` back
to 88. Logs: `combined-depth-stress.log`, `compound-junction.log`,
`create-many-skip-depth.log`, `nested-create-context-grandchild.log`,
`junction-create-many-routing.log`, and for the last file
`polymorphic-part-pcwf-tx.log`, `polymorphic-part-pcwf-batch.log`,
`polymorphic-part-plural.log`, `polymorphic-part-singular-a.log`,
`polymorphic-part-singular-b.log`, `polymorphic-part-singular-c.log`,
`polymorphic-part-tail.log` (all in the same directory).

35 red cells total across the six files.

## Table

| file | cell | class | reason | ruling / registration / engine site |
| --- | --- | --- | --- | --- |
| combined-depth-stress.test.ts | X1b combined depth stress > batch composes the same four mechanisms | B-ruled | atomicBatch leg hits the borrowed-createMany-skipDuplicates member-rollback refusal | `operation-context.ts:497-511` `suppressionRefusal()`; G3P-04, `AGENTS.md:580-587` |
| compound-junction.test.ts | (transaction) skipDuplicates links only the exact complete target key | C | ForeignKeyError 23503: a suppressed row's spelled-but-never-inserted key still gets a junction write | `commands/execution.ts:646` `adoptSuppressed` |
| compound-junction.test.ts | (transaction) compound-key member uniqueness > one independently unique key member cannot link a different tuple | C | same signature (FK 23503) as the row above, not independently traced | `commands/execution.ts:646` `adoptSuppressed` (same suspected owner) |
| compound-junction.test.ts | (atomicBatch) skipDuplicates links only the exact complete target key | B-ruled | atomicBatch leg hits the member-rollback refusal | `operation-context.ts:497-511`; G3P-04 |
| compound-junction.test.ts | (atomicBatch) compound-key member uniqueness > one independently unique key member cannot link a different tuple | B-ruled | atomicBatch leg hits the member-rollback refusal | `operation-context.ts:497-511`; G3P-04 |
| compound-junction.test.ts | (atomicBatch) generated compound junction identity > one generated target member publishes the complete tuple to the join | B-ruled | atomicBatch leg needs a just-inserted identity for the join write; batch transport can't supply it | `operation-context.ts:2319` `"Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING"`; D-16 ruling, `g4.md:1610-1614`, `:1624-1627` |
| create-many-skip-depth.test.ts | X1b mechanism 3 (located update target) > batch: skip keeps the fresh child under c1… | B-ruled | member-rollback refusal | `operation-context.ts:497-511`; G3P-04 |
| create-many-skip-depth.test.ts | X1b mechanism 3 (fresh create at depth) > batch: skip under a fresh create attaches survivors… | B-ruled | member-rollback refusal | `operation-context.ts:497-511`; G3P-04 |
| nested-create-context-grandchild.test.ts | CLASS VI key 3 > direct, transaction, and batch preserve the same skip winner | B-ruled | the batch leg of this combined direct/tx/batch test hits the member-rollback refusal | `operation-context.ts:497-511`; G3P-04 |
| junction-create-many-routing.test.ts | residual F1 > a spelled scalar key links only when that exact target exists | C | ForeignKeyError 23503: `adoptSuppressed` replays the junction link for entry id=3, whose row was never inserted (conflict was on `slug`, not `id`) | `commands/execution.ts:646-660` `adoptSuppressed`, guard `command.fields.known(field)?.kind !== "literal"` checks only `schema.keys()` (the row's own PK), not which field actually conflicted |
| junction-create-many-routing.test.ts | residual F1 > a relation-bearing spelled duplicate suppresses its subtree and join | C | entry id=1 is a TRUE existing-row duplicate; `adoptSuppressed` correctly replays its membership per the documented rule, but the test expects the join ALSO suppressed because the member carries its own nested child (`details.create`) | `commands/execution.ts:646-660`; design text `AGENTS.md:1091-1107` documents "membership survives," not the relation-bearing exception the test asserts |
| junction-create-many-routing.test.ts | residual F1 > a scalar adopter plans after a relation-bearing adopter creates its target | C | a root-level duplicate (`slug:"B"`) is not detected against a sibling row's OWN nested child created earlier in the same batch (`children:{create:{slug:"B"}}`); the nested child goes missing from the result entirely | not traced to a specific line; distinct mechanism from the FK cells above (ordering/visibility of same-batch duplicate keys, not `adoptSuppressed`'s PK guard) |
| junction-create-many-routing.test.ts | residual F1 (unnameable indexes) > a spelled key does not link when only a raw unique index conflicts | C | ForeignKeyError 23503: same signature as "a spelled scalar key links only…" above (spelled-but-fresh id=2, conflict via `token`, not `id`) | `commands/execution.ts:646-660` `adoptSuppressed` |
| polymorphic-collection-write-family.test.ts | (transaction) SINGULAR member: exact reconnect is idempotent, an occupied slot TRANSFERS | C | `TransactionError: Concurrent membership change…retry to converge` in a single-threaded, non-concurrent test | `operation-context.ts:2556-2575` `link()`, `failure.meta.raceable = true`; the automatic one-shot re-plan D-32 added (`g4.md:2135-2136`) is wired only for the `this.usesBatch` branch (`queue(...)`), not the direct-dispatch `else` branch this "transaction"-mode test takes — consistent with the same test passing under atomicBatch |
| polymorphic-collection-write-family.test.ts | (transaction) connectOrCreate FOUND duplicates coalesce one singular transfer | C | `NestedWriteError: … depends on an earlier 'connectOrCreate' target write…Split these operations` fires for two `connectOrCreate`s that name the SAME target, which the test expects to coalesce, not refuse | `commands/commands.ts:677` (inherited dependency-conflict refusal, over-firing for a benign same-target duplicate) |
| polymorphic-collection-write-family.test.ts | (transaction) connectOrCreate MISSING duplicates keep the first target and membership | C | same NestedWriteError signature as above | `commands/commands.ts:677` |
| polymorphic-collection-write-family.test.ts | (transaction) createMany skipDuplicates joins a later same-key row after an alternate conflict | C | ForeignKeyError 23503; same signature as the compound-junction/junction-create-many-routing FK cells, not independently traced | `commands/execution.ts:646` `adoptSuppressed` (same suspected owner) |
| polymorphic-collection-write-family.test.ts | (atomicBatch) mixed-variant create + connect in ONE owner create | B-ruled | atomic-output-identity-scratch refusal | `operation-context.ts:2319`; D-16, `g4.md:1610-1614`, `:1624-1627` |
| polymorphic-collection-write-family.test.ts | (atomicBatch) connectOrCreate FOUND duplicates coalesce one singular transfer | C | same NestedWriteError as the transaction-mode cell | `commands/commands.ts:677` |
| polymorphic-collection-write-family.test.ts | (atomicBatch) connectOrCreate MISSING duplicates keep the first target and membership | C | same NestedWriteError | `commands/commands.ts:677` |
| polymorphic-collection-write-family.test.ts | (atomicBatch) createMany skipDuplicates coalesces an existing singular target transition | B-ruled | member-rollback refusal | `operation-context.ts:497-511`; G3P-04 |
| polymorphic-collection-write-family.test.ts | (atomicBatch) createMany skipDuplicates joins a later same-key row after an alternate conflict | B-ruled | member-rollback refusal | `operation-context.ts:497-511`; G3P-04 |
| polymorphic-collection-write-family.test.ts | singular collection inverse (transaction) > root updateMany refuses one singular member across two owners before writing | C | promise resolved `{count:2}` instead of rejecting — root membership guard not enforced | not traced to a specific line (see Unverified) |
| polymorphic-collection-write-family.test.ts | singular collection inverse (transaction) > nested updateMany refuses one singular member across two owners before writing | C | promise resolved instead of rejecting, same guard family | not traced |
| polymorphic-collection-write-family.test.ts | singular collection inverse (transaction) > non-empty set and connectOrCreate reach the same root membership guard | C | promise resolved `{count:2}` instead of rejecting | not traced |
| polymorphic-collection-write-family.test.ts | singular collection inverse (transaction) > `disconnect: true` deletes THE junction row, with no selector | C | `Cannot disconnect relation 'shelf': target record was not found for this parent` where the test expects success | `commands/relation-body.ts:234` |
| polymorphic-collection-write-family.test.ts | singular collection inverse (transaction) > `delete: true` on an EMPTY slot writes nothing | C | same refusal fires where the test expects a silent no-op on an already-empty slot | `commands/relation-body.ts:645` |
| polymorphic-collection-write-family.test.ts | singular collection inverse (atomicBatch) > root updateMany refuses one singular member across two owners before writing | C | same as the transaction-mode cell | not traced |
| polymorphic-collection-write-family.test.ts | singular collection inverse (atomicBatch) > nested updateMany refuses one singular member across two owners before writing | C | same | not traced |
| polymorphic-collection-write-family.test.ts | singular collection inverse (atomicBatch) > non-empty set and connectOrCreate reach the same root membership guard | C | same | not traced |
| polymorphic-collection-write-family.test.ts | singular collection inverse (atomicBatch) > `disconnect: true` deletes THE junction row, with no selector | C | same | `commands/relation-body.ts:234` |
| polymorphic-collection-write-family.test.ts | singular collection inverse (atomicBatch) > `delete: true` on an EMPTY slot writes nothing | C | same | `commands/relation-body.ts:645` |
| polymorphic-collection-write-family.test.ts | a produced collection owner whose split precedes its clear > a produced owner split entirely before its clear succeeds in batch | B-ruled | atomic-output-identity-scratch refusal | `operation-context.ts:2319`; D-16 |
| polymorphic-collection-write-family.test.ts | polymorphic collection `set` refuses before the clear on a splittable batch > a generated target after the clear refuses with prior state intact | C | test expects the registered "Polymorphic collection 'items' set…" refusal but gets the atomic-output-identity refusal instead — a refusal-precedence mismatch | `operation-context.ts:2319` firing ahead of the expected polymorphic-collection-set refusal; no ruling on the ordering between the two |
| polymorphic-collection-write-family.test.ts | polymorphic collection `set` refuses before the clear on a splittable batch > a generated nested target without a clear remains a batch control | B-ruled | atomic-output-identity-scratch refusal, matching the direct pattern | `operation-context.ts:2319`; D-16 |

## Class A

None. No cell in this family is a physical-plan pin (SQL text, statement
count, CTE fold, batch segmentation, alias) with a named ruling behind it.

## Class B — 12 cells, both B-ruled

**B1 — the member-rollback refusal (8 cells).** Registered verbatim at
`src/query-engine/raptor3/shared/operation-context.ts:497-511`,
`suppressionRefusal()`:

> "Raptor 3 borrowed createMany skipDuplicates requires an operation-owned
> member rollback region."

thrown when `this.ownership === "borrowed-transaction" && !this.memberRollback`,
or `this.ownership === "batch-preparation"`, or `this.usesBatch`. This is the
G3P-04 design, stated as a current, non-provisional rule in the normative guide
(`src/query-engine/raptor3/AGENTS.md:580-587`):

> "G3P-04 admits root-conflict suppression only when the operation owns the
> member rollback region… A plain `borrowed-transaction` binding remains
> refused before member effects even when its driver supports savepoints:
> neither the payload nor transport capability grants that authority."

It is pinned by three dedicated regression suites that assert this exact
sentence: `tests/raptor3/prep/g3p04-review-regressions.test.ts:19-20`,
`tests/raptor3/prep/native-suppression-replay.test.ts:790`,
`tests/raptor3/prep/suppression-replay.test.ts:21`, and the granted-capability
success path is separately pinned in
`tests/raptor3/g3/suppression-retry-contract.test.ts`. It dates to commit
`b2daea115` (2026-09-12), predating the G4 parity work, and
`g3-prep-inventory.md` row OP-B03 marks this exact contract ("skipDuplicates
skips only the exact conflicting root and cannot leak descendants,
prerequisites, joins, or output") as `G3P-04 seed -> G3`. Every cell in this
group is the `atomicBatch` (or `batch-preparation`) leg of a test whose
`transaction`/`native`/`direct` leg passes — consistent with the refusal firing
only where `usesBatch`/no-grant applies, never in the interactive case, exactly
as designed. All eight are the retired engine's contract tests exercising a
shape the shipped engine now deliberately refuses; this is loss accepted by a
standing, tested design decision, not an open question.

**B2 — the atomic-output-identity-scratch refusal (4 cells).** Registered at
`src/query-engine/raptor3/shared/operation-context.ts:2319` (line 1837/1471 in
earlier snapshots — the file has grown since):

> "Raptor 3 G1 atomic output requires exact identity scratch or segmented
> RETURNING"

listed in the refusal census as `NEW-in-G4`. It fires when an atomicBatch
operation needs a just-inserted row's generated identity for a dependent
write (a junction link, a further nested write) and the batch transport can
supply neither a scratch slot nor mid-batch RETURNING. This exact site and
message were identified as a real, then-unrecorded coverage loss in
`g4/cutover-execution-review-round3.md:106-107` (`batchPrimaryKeyDataflowContract`
in `pg-nested-write-races.test.ts`, base 167/167 green, cutover tree red) and
explicitly ruled: "Decisions taken in Arnaud's absence (00:45): … the pg
`batchPrimaryKeyDataflowContract` registration stays registered and red as a
recorded engine limitation" (`g4.md:1610-1614`), reaffirmed at commit time
(`g4.md:1624-1627`) as one of "88 unrecorded compatibility differences of the
candidate… none repaired or deleted." The ruling names a sibling test file
(`pg-nested-write-races.test.ts`), not the four cells here, but the engine
site, thrown message, and triggering mechanism (atomicBatch + a
dependent-write's need for a generated identity) are identical, so I treat the
ruling as covering the mechanism rather than one file. Flagged B-ruled rather
than B-open on that basis — call it out if the narrower reading is wanted.

## Class C — 23 cells, four distinct mechanisms plus one unclustered group

**C1 — `adoptSuppressed`'s membership-replay guard conflates "this row's own
key is spelled" with "a row at that key already exists" (6 cells: both
compound-junction.test.ts transaction-mode cells, three of
junction-create-many-routing.test.ts's four cells, and
polymorphic-collection-write-family.test.ts's one transaction-mode `createMany`
FK cell).** `commands/execution.ts:646-660`:

```
private async adoptSuppressed(record) {
  const command = record.command;
  for (const field of this.context.schema.keys(command.model))
    if (command.fields.known(field)?.kind !== "literal") return;
  for (const child of record.children)
    if (child.placement !== "before" &&
        (child.command.kind === "link" || child.command.kind === "remove" ||
         child.command.kind === "junction"))
      await this.run(child, command);
}
```

The design (`AGENTS.md:1091-1107`) says a suppressed member whose target row
"already exists" should still get its declared membership written against
that existing row, citing the shipped V1's `joinWhenTargetExists`
(`junction-create-many-routing.ts:76-84`, V1, readable only in git history per
the file's own provenance note). The guard above checks only whether the
row's OWN primary/row key (`schema.keys()`) was spelled literally in the
payload — it does not check whether the unique-constraint conflict that
actually triggered the suppression was on that same key. Reproduction
(`compound-junction.test.ts:420-499`, PGlite, `author.update` with a nested
`books: { createMany: { data: […], skipDuplicates: true } }`): a row spells a
FRESH compound primary key (`region:"missing", code:"alternate"`) but
conflicts on a separate `isbn` unique constraint belonging to a different
existing row. The row's own key passes the guard's literal-check even though
no row at that key was ever inserted (its INSERT was rolled back), so
`adoptSuppressed` still replays the junction/link write for it, producing
`ForeignKeyError 23503`. Confirmed independently in
`junction-create-many-routing.test.ts` twice more with the same shape
(spelled, fresh `id`, conflict via `slug` or `token` instead of `id`) and
believed (not independently traced) to be the same cause behind
`compound-junction.test.ts`'s "compound-key member uniqueness" cell and
polymorphic-collection-write-family.test.ts's transaction-mode
`createMany skipDuplicates joins a later same-key row…` cell. No ruling covers
this; it is not named in `g4.md`, `g3-prep-inventory.md`, or
`raptor3-parity-plan.md` under any of these test titles or describe names
("residual F1", "compound-junction") — grep for both came back empty.

**C2 — a relation-bearing suppressed member's own join is unexpectedly
NOT suppressed (1 cell).** `junction-create-many-routing.test.ts` "a
relation-bearing spelled duplicate suppresses its subtree and join": entry
id=1 is a TRUE existing-row duplicate (not the C1 shape — its own key really
does already exist), so `adoptSuppressed` correctly replays its membership per
the documented rule, and the observed result (`[{id:1},{id:2}]`) matches
`AGENTS.md:1091-1107`'s stated design. The test's title and expectation
(`[{id:2}]` only) assert that a member carrying its OWN further nested child
(`details:{create:{...}}`) should suppress its join too, not just its
subtree — a narrower rule than what's written. I could not find this
qualifier anywhere in the guide or the ledger; either the design text is
incomplete or the test's premise is a V1 nuance not carried into the written
rule. Recorded as a genuine divergence, not folded into C1.

**C3 — same-batch duplicate visibility ordering (1 cell).**
`junction-create-many-routing.test.ts` "a scalar adopter plans after a
relation-bearing adopter creates its target": a root-level createMany row
(`slug:"B"`) should be suppressed as a duplicate of a SIBLING row's own nested
child created earlier in the same batch (`children:{create:{slug:"B"}}`), but
the result drops the nested child entirely (`[{slug:"A"}]` instead of
`[{slug:"A"},{slug:"B"}]`). Distinct mechanism from C1 (not an
`adoptSuppressed` guard question — it's about whether same-batch,
same-transaction sibling writes are visible to each other's duplicate
detection). Not traced to a specific engine site.

**C4 — `link()`'s raceable membership-change guard fires with no true race
(1 cell).** `polymorphic-collection-write-family.test.ts`, "SINGULAR member:
exact reconnect is idempotent, an occupied slot TRANSFERS" (transaction mode
only — the same test passes under atomicBatch).
`operation-context.ts:2556-2575`, `link()`: on the non-batch branch, deleting a
captured junction row and observing `rowCount !== 1` throws
`TransactionError` with `meta.raceable = true` and no retry. D-32 (Arnaud,
`g4.md:2135-2136`) ruled these premises raceable with "loss after observation
re-plans once from fresh values like the other races," but the described
one-shot re-plan is wired through `OperationContext.submit` gating on
`failure.meta.raceable === true`
(`AGENTS.md:522-524`), which is the BATCH array-submission owner — the direct
`this.transport._execute` branch this transaction-mode test takes has no such
re-entry. In a single-threaded, non-concurrent test this should never observe
`rowCount !== 1` at all, so either the delete or an earlier step in this
operation's own sequence removed the row first. Not traced further; D-29 (the
sibling "premise proved too early" rule) was separately ruled and applied
(`g4.md:2131-2132`, `:1783`) by commit `fd441c7f`, so this is not that same,
already-fixed gap.

**C5 — `NestedWriteError` over-firing on a same-target
`connectOrCreate`/`connectOrCreate` pair (4 cells).** Both modes of
"connectOrCreate FOUND duplicates coalesce one singular transfer" and
"connectOrCreate MISSING duplicates keep the first target and membership."
The refusal (`commands/commands.ts:677`, an inherited/pre-G4 dependency-order
guard: "Nested operation '…' on relation '…' depends on an earlier '…' target
write in the same nested write. Split these operations into separate
queries.") is a real, legitimate guard for genuinely conflicting nested
writes, but here it fires for two `connectOrCreate`s naming the SAME
target — the tests' own titles assert V1 coalesced this case rather than
refusing it. No ruling found under either test title.

**C6 — the "singular collection inverse" cross-owner membership guard is
inconsistently enforced (10 cells, the largest unclustered group — root/nested
`updateMany` and `set`/`connectOrCreate` resolve where the test expects a
guard rejection; `disconnect: true`/`delete: true` on an already-empty or
currently-linked slot instead throw "target record was not found for this
parent" where the test expects success or a silent no-op).** Both `transaction`
and `atomicBatch` modes show the identical five-test pattern, so this is not a
transport-specific gap like B1/B2. I did not trace an engine site for the
three "resolves instead of rejects" cells (the guard appears simply absent or
differently scoped for this shape); the two `disconnect`/`delete` cells throw
from `commands/relation-body.ts:234` and `:645` respectively, an
existing-and-presumably-correct-elsewhere "target not found" refusal that
these two specific tests did not expect here. No ruling, registration, or
mention of "singular collection inverse" exists anywhere under
`docs/architecture/raptor3-evidence/`.

**C7 — a refusal-precedence mismatch (1 cell).** "a generated target after the
clear refuses with prior state intact" expects the registered
"Polymorphic collection 'items' set …" refusal but observes the B2
atomic-output-identity-scratch refusal instead. The B2 refusal is itself
ruled as an accepted limitation in general (see B2), but no ruling addresses
which of the two refusals should win when both apply to the same statement;
kept as its own C row rather than folded into B2 since the OBSERVABLE class
and sentence differ from what the test (and the registered polymorphic-set
refusal) name.

## Class D

None. Every red cell in this family reaches the shipped Raptor 3 engine's own
public-facing behavior (a thrown error from `operation-context.ts`,
`commands/*.ts`, or an observable query/write result) — none reach a retired
internal (`write-engine/`, `query-engine-v2`, an instrumentation-only
attribute, or a runner-only replay/specimen environment).

## Unverified

- C1's extension to three cells (compound-junction transaction "compound-key
  member uniqueness", and polymorphic-collection-write-family transaction
  `createMany skipDuplicates joins a later same-key row…`) is by error-message
  signature match only (`ForeignKeyError` 23503 from the same operation
  shape), not by independently reading each test's fixture and confirming the
  exact spelled-vs-conflicting-field mismatch the way I did for the other
  three C1 cells.
- C6's three "resolves instead of rejects" cells have no traced engine site —
  I did not find where (or whether) a cross-owner singular-membership guard is
  supposed to be enforced for `updateMany`/`set`/`connectOrCreate`, only that
  it fires for none of these three shapes.
- C3's mechanism (same-batch sibling duplicate visibility) is described from
  one reproduction only; I did not look for a shared owner with C1.
- B2's ruling is quoted from a decision about a sibling test file
  (`pg-nested-write-races.test.ts`'s `batchPrimaryKeyDataflowContract`), not
  from a ruling that names any of these four cells or files directly. I read
  this as the same registered mechanism (identical site, identical message,
  identical batch/segmented-RETURNING trigger) rather than four fresh,
  unruled occurrences; a narrower reading would reclassify all four as
  B-open.
- I did not run the full, unfiltered `polymorphic-collection-write-family.test.ts`
  successfully even once (see Blockers); coverage is reconstructed from seven
  filtered partitions whose test counts sum to 88/88, cross-checked, but a
  single filtered run is a materially different code path (fewer concurrent
  fixtures/PGlite instances alive) than the whole-file run the gate itself
  performs, so a defect that depends on file-wide test interaction (shared
  module state, leaked connections) would not surface in my partitions.

## Blockers

- `tests/contracts/engine/write/polymorphic-collection-write-family.test.ts`
  cannot be run whole under `node scripts/run-vitest-safe.mjs --project
  extended-local <file>` as instructed: five attempts (with retries after
  sibling-lane contention subsided) measured 1537–1612 MiB against the fixed
  1536 MiB ordinary-project ceiling, which `scripts/bounded-process.mjs`
  hard-caps (`--rss-limit-mb` may only lower it; the higher
  `ISOLATED_PGLITE_PROVIDER_RSS_CEILING` is not selectable from
  `run-vitest-safe.mjs`'s CLI). I worked around this by adding `-t` test-name
  filters to `run-vitest-safe.mjs`'s forwarded vitest arguments and running
  the file in seven partitions whose test counts sum to the file's full 88, all
  under the ceiling. This is a deviation from "one file per call" in letter
  (same file, seven calls, each narrower than the whole) though not, I
  believe, in the intent of getting a discriminating minimum run per file;
  flagging it explicitly since the brief specified the exact command.
- Two `run-vitest-safe.mjs` invocations hit "Test command refused: workspace
  verification PID … is still active without owning the current command
  chain" (a lock refusal from a sibling triage lane); both resolved after a
  20 s wait and retry, no lock was removed.
- I did not read every one of the six files' full source; the four
  member-rollback (B1) files beyond `combined-depth-stress.test.ts` and the
  B2/C cells I did not quote inline were classified from their failure
  output plus the shared refusal registration, not from a full read of each
  test body.
