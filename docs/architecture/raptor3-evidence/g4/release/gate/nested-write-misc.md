# Family: nested-write-misc — triage note

Read-only classification. Repo `/Users/arnaud/code/viborm`, branch `pattern-engine`,
HEAD `7bc08ebd9` (+ uncommitted `src/query-engine/raptor3/shared/decimal.ts`, not
touched). No edits made anywhere in the repository.

Every file run with `TMPDIR=/private/tmp/viborm-triage-misc-tmp node
scripts/run-vitest-safe.mjs --project extended-local <file>`, one file per call.
Raw stdout kept at `/private/tmp/viborm-triage-misc-tmp/*.log`. Two files
(`parent-held-lookup.test.ts`, `shared-pk-update-root.test.ts`) repeatedly hit the
1536 MiB process-group RSS ceiling on a whole-file run under this evening's heavy
concurrent load (several sibling triage agents running the same suite at once);
both were re-run split by `-t "<describe-title fragment>"` per PGlite substrate,
which stayed under the ceiling and accounts for every test in the file (see
"Unverified"/"Blockers" for the one substrate pair that never got under the
ceiling after five attempts).

**28 red cells measured across the 7 family files: 18 class C, 9 class D, 1 class
B (B-ruled). Zero class A.** A further ~47 cells (the "PGlite transaction" and
"PGlite atomic batch" substrate legs of `shared-pk-update-root.test.ts`) could not
be run at all — recorded under Blockers, not counted above.

## Table

| file | cell | class | reason | ruling / registration / engine site |
|---|---|---|---|---|
| supplier-continuation.test.ts | E — supply then update on a to-one slot (PGlite transaction) > the continuation carries a nested relation-bearing updateMany | C | `notes: {createMany}` then `notes: {updateMany}` on the same captured badge is refused as an own-write dependency even though the updateMany's target set is exactly the rows the createMany just produced for this badge; test expects success | `program.ts:396-399` `analyzeDecisions` (overlap of a later `scan` against an earlier `insert`'s literal values); see Class C §1 |
| supplier-continuation.test.ts | E4 — the composed continuation on ordered committed segments > carries the parent and captured-target guards into every later segment | C | the later batch's guard SELECTs re-pin the captured badge (`"e7_badges"`) but not the parent station (`"e7_stations"`); test's own comment states both are required | `operation-context.ts:1104-1134` `submit()` (`continuations`/`guards` construction only re-pins the captured target, not a separate parent-row guard); see Class C §2 |
| supplier-continuation.test.ts | E4 — the composed continuation on ordered committed segments > routes the composition's placement through the pre-effect capacity refusal | D | test names `runProgressiveFragmentOperation`/`executeProgressiveFragment`/`progressiveSeriesRefusal` as the owner of a pre-effect "committed segments" capacity refusal; none of those three names exist anywhere in `src/` | see Class D §1; shipped equivalent: `src/drivers/bind-parameter-capacity.ts:22` (generic per-statement bound-value-limit refusal, different reasoning and wording) |
| supplier-continuation.test.ts | E4 — supplier continuation keeps the write-side membership premise > a reused non-PK reference cannot redirect the continuation | C | a non-PK reference reused by a DIFFERENT parent row between the supplier's commit and the continuation's re-verification should reject `parent record changed across a committed segment` (documented invariant); promise resolved instead | `src/query-engine/raptor3/AGENTS.md:1055-1067` (the invariant, stated in the present tense as something the engine does); message site `src/query-engine/raptor3/commands/execution.ts:771`; see Class C §3 |
| nested-semantic-stability.test.ts | X1 semantic stability — own-write 'split these operations' at depth > depth-1 root create rejects with the own-write message | D | test's docstring cites `OwnWritePreflight.assertUpdate` running before `interpretRelation` on `UpdateOperation`; none of those three names exist in `src/` | see Class D §2; shipped equivalent not pinned (falls through to the raw driver `Unique constraint violation`) |
| nested-semantic-stability.test.ts | X1 semantic stability — own-write 'split these operations' at depth > depth-4 lifted create-context chain rejects with the SAME own-write message | D | same premise, same missing internals, same fallthrough | see Class D §2 |
| nested-error-attribution.test.ts | nested statement error attribution > a tree folded into ONE statement keeps the operation's model | D | test's own comment names `CreateOperation.buildTreeFold` as the reason a folded statement "keeps the operation's model" (author); `buildTreeFold` exists only in the retired-engine deletion patches, not in `src/` | see Class D §3; shipped equivalent: `context.model` is set per compiled statement (`driver-error-context.ts:361` `buildMeta`) and in this case already answers `post` (the fix's own stated goal), not `author` |
| parent-held-compound-edge.test.ts | E6.4 parent-held to-one over a compound edge (transaction) > a NULL member makes the edge name NO target, on all three kinds | C | singular `delete` on a to-one compound edge whose captured member no longer fully matches throws `NestedWriteError` instead of the silent zero-row no-op the test (and SQL DELETE's own semantics) expect | `src/query-engine/raptor3/commands/relation-body.ts:218-234` (`case "disconnect": case "delete":` shares one unconditional not-found throw with no no-op carve-out for singular `delete`) |
| parent-held-compound-edge.test.ts | E6.4 parent-held to-one over a compound edge (atomic batch) > a NULL member makes the edge name NO target, on all three kinds | C | same defect, atomic-batch substrate | same site |
| parent-held-lookup.test.ts | PGlite transaction parent-held to-one lookup (E1 U1/U2) > a located target whose referenced NULLABLE unique is NULL refuses, and writes nothing | C | connecting via a non-referenced unique that resolves to a row whose REFERENCED column is NULL should refuse (writing NULL would silently disconnect); update instead succeeds, writes `name: "renamed"` AND `badgeCode: null` | no null-guard found for this shape; suspected owner `src/query-engine/raptor3/commands/relation-body.ts:490-513` (`connect` lookup construction, no referenced-field-null check) |
| parent-held-lookup.test.ts | PGlite atomic batch parent-held to-one lookup (E1 U1/U2) > a located target whose referenced NULLABLE unique is NULL refuses, and writes nothing | C | same defect, atomic-batch substrate | same site |
| parent-held-lookup.test.ts | E1 U1 — the lookup fold's provenance > the written key comes from the LOOKUP, not from the probe row | C | a corrupted early "probe" read (author id) is written directly (`authorId: 1`) instead of being re-verified by a write-time lookup (which would have written `2`) | same connect/lookup machinery as above; suspected owner `relation-body.ts:490-513` plus whatever builds the probe read in `commands.ts`/`operation-context.ts` |
| parent-held-lookup.test.ts | E1 U1 — the lookup fold's provenance > a probe row whose required referenced column reads NULL fails typed parsing | C | the malformed-scalar error names `operation "update"` where the probe's own `findMany` should be named; same underlying probe/lookup path as the previous row | `operation-context.ts:534` (message built from `context.operation`, which the probe apparently inherits from the enclosing `update` rather than its own `findMany`) |
| parent-held-lookup.test.ts | E1 U1 — the guard→UPDATE vanish window > a target deleted between planning and the batch aborts typed, writing nothing | C | target deleted between the planning probe and the write batch surfaces as a raw `ForeignKeyError` (23503) instead of the arm's own `NestedWriteError` presence guard the comment says should fire first | same probe/lookup path; no live re-verification guard found for `connect`-by-non-referenced-unique between probe and write |
| parent-held-lookup.test.ts | PGlite transaction before-root target subtree (E1 U3) > a null referenced field in the target's create data stays refused | D | test pins the wording `"query-engine-v2 update cannot resolve referenced field 'code' for the before-root target of relation …"`; that exact template does not exist in `src/` (only in the retired-engine cutover-deletion patches) | see Class D §4; shipped (kept) equivalent: `src/query-engine/raptor3/commands/commands.ts:449` `"query-engine-v2 create cannot resolve the parent id for relation …"` — this is the sentence actually produced, and it is current/kept, not retired |
| parent-held-lookup.test.ts | PGlite atomic batch before-root target subtree (E1 U3) > a null referenced field in the target's create data stays refused | D | same wording mismatch, atomic-batch substrate | see Class D §4 |
| parent-held-lookup.test.ts | E1 U3 — the produced identity by substrate > the PostgreSQL atomic batch spends the producer's exact RETURNING key | B-ruled | PGlite atomic batch hits `"Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING"`, the registered `batchPrimaryKeyDataflowContract` refusal | `docs/architecture/raptor3-evidence/g4/root-review-C-receipts/refusals.json`; ruling: `g4.md:1613,1626` "the pg `batchPrimaryKeyDataflowContract` registration stays registered and red as a recorded engine limitation" / "5 of them the restored `batchPrimaryKeyDataflowContract`, kept red as a recorded engine limitation"; registered for PGlite too via `tests/providers/local/pglite-bulk-writes.test.ts` |
| parent-held-lookup.test.ts | PGlite transaction parent-held upsert arm relations (E1 U4) > a same-update FK rebind makes the arm correlate on the FINAL value | C | a direct scalar FK rebind (`authorId: 2`) composed with a nested `author: {upsert}}` on the SAME relation is refused as "conflicting final assignments" instead of correlating the upsert against the final (post-rebind) value | `commands.ts:452-456` (`assignMembership`/`contribute`, the "conflicting final assignments" template); no ruling found for this shape |
| parent-held-lookup.test.ts | PGlite atomic batch parent-held upsert arm relations (E1 U4) > a same-update FK rebind makes the arm correlate on the FINAL value | C | same defect, atomic-batch substrate | same site |
| parent-held-lookup.test.ts | E1 U4 — the delegated upsert arm's staleness window > a target that vanishes before the batch aborts with the upsert family's wording | D | test pins `"Nested upsert premise changed for relation …"`; that template does not exist in `src/` | see Class D §5; shipped (kept) equivalent: the generic `NotFoundError` template `"No ${model} record found for ${operation}"` at `src/errors/query.ts:126` — the actual, current message received |
| inverse-to-one-update-depth.test.ts | E2-U1 provenance: the deeper key comes from the row the probe locked > a probe row without the located key fails closed at planning (transaction) | D | test pins `UNRESOLVED_LOCATED_PK = /did not produce row field 'id'/`; that phrase exists only inside `docs/architecture/raptor3-evidence/g4/cutover/cutover.patch` as **removed** (`-`) lines from other, already-migrated test files, never in current `src/` | see Class D §6; shipped equivalent: the same generic malformed-scalar message as `operation-context.ts:534`, actually received |
| inverse-to-one-update-depth.test.ts | E2-U1 provenance: the deeper key comes from the row the probe locked > a probe row without the located key fails closed at planning (atomic batch) | D | same premise, atomic-batch substrate | see Class D §6 |
| shared-pk-update-root.test.ts | Package E shared-PK update root (better-sqlite3) > upsert FOUND publishes the target's post-update referenced key | C | upsert's update arm moves the shared primary key (`account.id: "cascade"`); the compiled `UPDATE … RETURNING` apparently still matches on the pre-transition key and returns no row | `TypeError` at `src/query-engine/raptor3/shared/operation-context.ts:2497-2499` ("UPDATE RETURNING did not produce the required record"); see Class C §4 |
| shared-pk-update-root.test.ts | Package E shared-PK update root (better-sqlite3) > update publishes the target's post-update key before descendant writes | C | a nested `chits.update` sibling of a shared-key-transitioning `account.update` refuses "target record was not found for this parent" — its own lookup/guard appears to correlate against the pre-transition key | `relation-body.ts` lookup/guard construction (`membership: {edge, parent: parent.located!.fields}`, e.g. line ~224); see Class C §4 |
| shared-pk-update-root.test.ts | Package E shared-PK update root (better-sqlite3) > a partial compound shared edge publishes every transitioned member | C | a compound (2-column) shared-key transition propagates only SOME of the changed columns to the descendant `tokens` row's FK, producing a real `ForeignKeyError` (23503) | same root cause as the two rows above; see Class C §4 |
| shared-pk-update-root.test.ts | Package E shared-PK update root (better-sqlite3) > fresh create publishes the complete selected compound tuple | C | `partialCard.create` that CONNECTs its account via a compound unique, plus a nested `tokens.create`, is refused: the connect-resolved compound-key member (`accountCode`) is not recognized as "a knowable value" for the child's referenced-field resolution | `commands.ts:436-450` `assignMembership` (`producer.known(referenced)` does not see a connect-resolved value as known); message is the current/kept `commands.ts:449` sentence, but fired on a shape (connect, not literal create data) the test expects to succeed |
| shared-pk-update-root.test.ts | Package E shared-PK update root (better-sqlite3) > upsert FOUND publishes a relation-folded non-primary referenced field | C | same `UPDATE RETURNING did not produce the required record` as the first shared-pk-update-root row, on a non-primary referenced-field variant | `operation-context.ts:2497-2499`; see Class C §4 |
| shared-pk-update-root.test.ts | Package E shared-PK update root (better-sqlite3) > update publishes a nested relation-folded non-primary referenced field | C | the update itself resolves, but a later read of the transitioned non-primary referenced field returns `undefined` instead of the post-transition value | same shared-key-transition-propagation family; see Class C §4 |

## Class A

None. No cell in this family pins a physical-plan detail (SQL text, statement
count, CTE fold shape, an alias) with the SAME observable result under the
shipped engine — every red here is either a wrong/missing/refused observable
result (C), a reach into a name that only exists in the retired engine or in the
deletion patches (D), or the one registered, ruled kept-red contract (B).

## Class B — 1 cell (B-ruled)

`parent-held-lookup.test.ts` "the PostgreSQL atomic batch spends the producer's
exact RETURNING key" hits:

```
Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING
```

thrown at `src/query-engine/raptor3/shared/operation-context.ts:2319`, whenever a
Postgres-family driver that supports RETURNING/CTE mutations cannot thread a
provider-generated primary key through an atomic batch without a live scratch or
segmented RETURNING. This is the exact registered `batchPrimaryKeyDataflowContract`
(`tests/contracts/drivers/behaviors/batch-primary-key-dataflow-behavior.ts`,
contract id `drivers.batch-primary-key-dataflow`), registered against PGlite too
via `tests/providers/local/pglite-bulk-writes.test.ts`. `docs/architecture/raptor3-evidence/g4.md:1613`:
> the pg `batchPrimaryKeyDataflowContract` registration stays registered and red
> as a recorded engine limitation

and `g4.md:1626`:
> pg-nested-write-races 13 (base 0; 5 of them the restored
> `batchPrimaryKeyDataflowContract`, kept red as a recorded engine limitation)

The registration and the ruling both name the shape (a generated/produced key
that an atomic batch cannot thread without RETURNING/scratch on a
Postgres-family driver) generically, not this one PGlite file by name, but the
condition in the source (`adapter.capabilities.supportsReturning &&
adapter.capabilities.supportsCteWithMutations`) is provider-family-scoped, not
suite-scoped, so this cell is the same registered, ruled refusal reached through
a different (PGlite, not Docker `pg`) test file. **B-ruled.**

## Class C — 18 cells, four owners

**§1 — own-write ledger over-refuses a same-relation createMany+updateMany
composition** (`supplier-continuation.test.ts`, 1 cell). `program.ts:396-399`
(`analyzeDecisions`) refuses any later `scan` whose `where` selector could
overlap an earlier sibling `insert`'s literal values within the same nested
write — including when the `updateMany`'s effective target set is EXACTLY the
rows the sibling `createMany` on the same relation just produced (the
semantically safe, intended case the test pins as a success). No ruling or
registration names this composition as an accepted refusal; the mechanism
itself is real and used elsewhere in the same file as an EXPECTED refusal (a
different, disjoint-target shape), so this is the guard firing too broadly on
one particular same-relation-same-parent case, not a missing feature.

**§2 — the continuation's later-segment guard re-pins the captured target but
not the parent row** (`supplier-continuation.test.ts`, 1 cell). `OperationContext.submit()`
(`operation-context.ts:1104-1134`) builds its `guards` array purely from
`continuations` (captured-target re-pins); nothing in that function builds a
separate SELECT re-pinning the PARENT row's key. The test's own comment states
both guards are required for a batch-only driver with
`supportsOrderedCommittedSegments = true` to trust a later segment.

**§3 — a non-PK supplier-continuation reference is not re-verified against a
parent hijacked between segments** (`supplier-continuation.test.ts`, 1 cell).
`src/query-engine/raptor3/AGENTS.md:1055-1067` documents, in the present tense,
that "a parent reference taken over by another row" during a captured-member-set
write "would answer a raceable staleness instead of `parent record changed
across a committed segment`" — i.e. the design intends this exact race to be
caught by a parent premise "queued first, at the position where the captured
set is fixed." The reproduction is exactly that race (station `p1`'s `code`
changed away, then `p2` claims the vacated code, between the supplier's commit
and the continuation's re-verification) and the operation resolves with no
error at all instead of rejecting `PARENT_MOVED`. Message site:
`src/query-engine/raptor3/commands/execution.ts:771`.

**§4 — shared-primary-key transition does not consistently propagate the
post-transition key to sibling/descendant writes** (`shared-pk-update-root.test.ts`,
6 cells). All six failures are one family: when the ROOT of a "shared PK" update
(a to-one relation whose primary key IS the parent's own key, e.g.
`card.account.update({id: "cascade"})`) changes its own primary key in the same
operation that also writes descendants correlated through that key, the
descendants' guards/RETURNING reads sometimes still address the PRE-transition
key: an `UPDATE … RETURNING` matches zero rows (`operation-context.ts:2497-2499`,
`TypeError: "UPDATE RETURNING did not produce the required record"`), a sibling
`chits.update`'s own lookup/guard reports "target record was not found for this
parent" against the old key, a compound (multi-column) transition propagates
only some of its columns to a descendant's FK (raw `ForeignKeyError`), and one
`create`+`connect` composition refuses because a connect-resolved compound-key
member is not treated as "knowable" for a nested child's referenced-field
resolution (`commands.ts:436-450`). The test file's own docstring names exactly
this family as "the create-root defect this lift had to avoid reproducing" —
this is the known risk the suite exists to catch, and no ruling records any of
these six as an accepted loss.

## Class D — 9 cells, six premises

**§1 — `progressiveSeriesRefusal`/`runProgressiveFragmentOperation`/
`executeProgressiveFragment`** (`supplier-continuation.test.ts`, 1 cell): none of
these three names exist anywhere under `src/` (`grep -rn` returns zero hits for
all three). The shipped engine's actual refusal for the same reproduction (a
capacity-starved batch-only driver) is the generic, unrelated
`src/drivers/bind-parameter-capacity.ts:22` bound-value-limit `UnsupportedOperationError`
— a real, different mechanism with a different message shape
("cannot execute this operation because one indivisible statement needs N bound
values...").

**§2 — `OwnWritePreflight.assertUpdate` / `UpdateOperation.interpretRelation`**
(`nested-semantic-stability.test.ts`, 2 cells): neither `OwnWritePreflight` nor
`UpdateOperation` nor `interpretRelation` exists anywhere under `src/`. Raptor 3's
own own-write mechanism (`program.ts:396-399` `analyzeDecisions`, a compile-time
scan-vs-insert overlap check — see Class C §1) does not cover a `create` +
`connectOrCreate` pair naming the SAME literal key on one to-many relation; the
composition instead reaches the live database and surfaces as a raw
`Unique constraint violation`. No shipped fact is pinned for this exact shape.

**§3 — `CreateOperation.buildTreeFold`** (`nested-error-attribution.test.ts`, 1
cell): the test's own comment states this retired method is why a scalar-only
create tree folds into ONE CTE statement and therefore "keeps the operation's
[root] attribution" on a unique violation. `buildTreeFold` exists only inside
the retired-engine deletion patches (`docs/architecture/raptor3-evidence/g4/pattern-retirement/retirement.patch`,
`docs/architecture/raptor3-evidence/g4/cutover/cutover.patch`), never in current
`src/`. The shipped fact IS pinned, just differently: `context.model` is
attached per compiled statement (`driver-error-context.ts:361` `buildMeta`), and
for this exact reproduction it already reads `post` (the CHILD's table, matching
the constraint/table pair) — which is precisely what the original bug fix this
file documents (upstream Prisma #29628) was for. The test's own comment even
predicts this: "The day a merged statement can carry per-arm attribution, this
expectation goes red and the pin is deleted."

**§4 — the "before-root target" wording template** (`parent-held-lookup.test.ts`,
2 cells): `"… cannot resolve referenced field 'X' for the before-root target of
relation 'Y': it is neither that record's primary key nor a knowable value in
its own create data."` does not exist anywhere in `src/`; it appears only as
REMOVED (`-`) lines inside `docs/architecture/raptor3-evidence/g4/cutover/cutover.patch`
(and its three sibling stage patches), i.e. wording the cutover deliberately
retired from OTHER test files that this un-migrated contract file never
received. The shipped, kept sentence for the identical condition (a producer
whose `operation === "create"` cannot resolve a referenced field) is
`commands.ts:449`, `"query-engine-v2 create cannot resolve the parent id for
relation '${edge.name}'…"` — exactly the message this cell actually receives.

**§5 — `"Nested upsert premise changed for relation …"`**
(`parent-held-lookup.test.ts`, 1 cell): this exact phrase does not exist in
`src/`. The shipped, current fact for a target vanishing before a delegated
upsert's batch is the generic `NotFoundError` template `"No ${model} record
found for ${operation}"` (`src/errors/query.ts:126`), which is what the cell
actually receives ("No author record found for update").

**§6 — `UNRESOLVED_LOCATED_PK = /did not produce row field 'id'/`**
(`inverse-to-one-update-depth.test.ts`, 2 cells): `"did not produce row field"`
is the retired write-engine's `extractOutput`/`buildProducedRead` wording,
explicitly named as such in a design comment preserved inside
`docs/architecture/raptor3-evidence/g4/cutover/cutover.patch:7373-7387` ("the
failure arrives as `extractOutput`'s bare 'step did not produce row field',
without the model/operation attribution the terminal read's `terminalFailure()`
carries"). The SAME two constant names (`UNRESOLVED_LOCATED_PK`,
`UNRESOLVED_REFERENCED_COLUMN`) appear inside that same patch as lines the
cutover REMOVED from other, already-migrated test files — this un-migrated
contract file is the one place that wording is still pinned. The shipped
equivalent fact received instead is the same generic malformed-scalar message
as Class C §-adjacent rows (`operation-context.ts:534`).

## Unverified

- The exact current text of the "e7_stations"/"e7_badges" guard SQL for
  `supplier-continuation.test.ts` §2 (I read the assertion and the `submit()`
  guard-builder, not the compiled SQL itself — no fix attempted, so the
  compiled statement was not inspected beyond what the vitest failure printed).
- Whether `relation-body.ts`'s `commands.lookup(...)` abstraction (used by every
  C-classified `parent-held-lookup.test.ts` row) resolves its value from a
  write-time correlated subquery or from an earlier out-of-band probe read in
  general — I inferred "probe, not live lookup" from the three failing cells'
  behavior, but did not trace `commands.lookup`'s full implementation to
  confirm this for every relation shape in the file.
- Whether the 5 passing E1 U6 tests and the 39 skipped-then-passing subsets of
  `parent-held-lookup.test.ts` (run via `-t` splits) would still all pass in a
  single unsplit run — each split subset was green/red-consistent with the
  unsplit attempts, but no single process ran the whole file successfully.

## Blockers

- **`shared-pk-update-root.test.ts`, "PGlite transaction" and "PGlite atomic
  batch" substrates (~47 of the file's 71 tests) could not be run at all.**
  Five attempts (`-t "PGlite transaction"`, whole-file, and repeats), all
  exceeded the 1536 MiB process-group RSS ceiling (1539–1603 MiB observed)
  under this evening's heavy concurrent load (multiple sibling triage sessions
  running the same suite simultaneously; `top` showed load average 6.6–9.6
  throughout). The "better-sqlite3" substrate of the same file ran cleanly
  every time (1514–1532 MiB), so the PGlite legs' extra WASM-engine memory is
  what tips this file over under contention, not a code defect. Per the brief's
  method (run once, wait-and-retry on a lock refusal, never remove a lock — no
  provision for an RSS-ceiling refusal), I retried five times over roughly 15
  minutes without success and stopped rather than keep burning wall-clock on a
  resource contention that is exogenous to this family. Repro:
  `TMPDIR=/private/tmp/viborm-triage-misc-tmp node scripts/run-vitest-safe.mjs
  --project extended-local tests/contracts/engine/write/shared-pk-update-root.test.ts
  -t "PGlite transaction"` (and `"PGlite atomic batch"`), re-run later once
  system memory pressure has eased. Given the six better-sqlite3 reds are all
  one "shared-PK transition propagation" family (Class C §4), the PGlite legs
  are a reasonable candidate to show the same or a related defect, but this is
  a guess, not a measurement.
