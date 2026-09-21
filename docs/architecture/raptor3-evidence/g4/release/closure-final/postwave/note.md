# Postwave — the outstanding review findings, applied on the integrated tree

Branch `closure-r` in `/private/tmp/viborm-rint`, from `cdd787ac8` with R1, R3,
R2a, R2b, R2c and R4 all landed (`5499cbed3` at the start of this round).
MySQL 8.4.11 (`raptor3_g2`) and PostgreSQL 16 through the lane's own assigned
containers; the recorded MySQL port was stale (the container had been recreated
on a fresh ephemeral host port, the same drift R1 recorded) and was reached
through its live one. Receipts: `receipts/`.

Nine findings the unit reviewers left after their own repair rounds: **one
MAJOR** and eight minor. All nine applied; none declined.

---

## 1. R2c, MAJOR — `commands/relation-body.ts:596`, the third shape

**The finding.** The found-path cost of the `FOR UPDATE` withdrawal
(`insertsWhenAbsent`) was answered for two shapes and not for a third which the
same line opens: a nested `connectOrCreate` whose relation is CHILD-HELD, where
the found arm's later write can meet a row that moved under it without the
demanded set that makes `OperationContext.update`'s current-row read raise.

**The failing witness.** Measured on native MySQL before any edit
(`receipts/base-red-child-held-coc.log`): an `author.create` carrying a nested
`connectOrCreate` on its child-held `posts`, with the found target `DELETE`d on
another connection between the unlocked probe and the connecting UPDATE,
**returned `{ id: "new-author", name: "Connector" }` as a SUCCESS**. The author
committed. The connection did not exist. Nine of the file's ten cells passed;
this one was red.

**Why nothing caught it.** Where the PARENT holds the reference the connection
is a value in the parent's own statement, and a target that vanished is refused
by the provider. Where the CHILD holds it, `RelationBody.association` builds the
arm itself — `this.commands.update(lookup, {}, {}, true)`, an UPDATE that writes
the foreign key and nothing else. Its `Assignments` demands nothing, and
`OperationContext.update` reads back only `if (!this.usesBatch && demanded.size)`:
with an empty demanded set it runs `effect()` and returns, never learning
whether it addressed a row. R2c's own §10 named this shape as untouched and
"the read it would need does not exist today" — it does exist; it just had to be
asked for.

**The fact, its owner, the second consumer.** The fact is the one R2c already
states, carried one step further: *a statement chosen before its own answer is
known reads unlocked in both outcomes, so an arm whose probe did NOT lock the
row it found must ask what its own write did.* Owner:
`RelationBody.association`, the one place the child-held binding arm is built.
It reads the fact off the probe — `Selection.insertsWhenAbsent`, the same field
R2c introduced — and demands the target model's own keys, which is exactly what
makes `OperationContext.update` issue its CURRENT stored-row read and raise the
existing `UPDATE did not produce the required record`. The second consumer of
`insertsWhenAbsent` is therefore this arm: one field, read by the probe that
withdraws the lock and by the arm that pays for the withdrawal.

**What it does NOT reach**, because the guard is the probe's own answer: a
child-held `connect` and a `set` target have no missing arm, their probe still
takes `FOR UPDATE`, and they are untouched — no new statement, no new read. A
nested `upsert` / `update` arrives with its `found` command already built and
never enters this branch. On the batch route the demanded keys cost nothing:
`wholeValue(undefined)` is truthy for a key the payload does not write, so the
loop `continue`s, `observed` stays empty and no read is added.

**Deletion: no deletion.** The rule replaces no narrower rule. It completes one.

**Witness added.** `tests/providers/docker/mysql2-concurrency-policy.test.ts`,
section 4's second row: "a CHILD-HELD connectOrCreate whose found target moves
out from under it connects nothing, visibly" — the schedule asserted (the
delete really landed in front of the UPDATE), the probe asserted unlocked, the
failure asserted by message and asserted NOT to be a `UniqueConstraintError` or
a `DEADLOCK`, and the final state asserted empty on both tables with no INSERT
of the create arm on the wire.

| run | result | receipt |
| --- | --- | --- |
| `mysql2-concurrency-policy.test.ts`, before the repair | **1 failed / 9 passed** | `base-red-child-held-coc.log` |
| the same file, after it | **10 passed** | `after-green-concurrency-policy.log` |

---

## 2. R2c, minor — `mysql2-concurrency-policy.test.ts:180`, the unwitnessed probe

**The finding.** The repair to the interpreted upsert's `targetWhere` /
`setWhere` condition probes (`commands.ts:1816`) shipped with no witness, and
the repair round had removed the only cell that reached it.

**The change.** The cell, not the confession. `targetWhere` is the only public
spelling that puts those probes on the wire, and `rootUpsert` declines them, so
on MySQL the interpreted form is what every upsert takes anyway. The new cell
"the CONDITION probe of a conditioned upsert locks no absence either" runs a
conditioned upsert on a MISSING key — the outcome the gap lock was taken on —
and asserts: the create arm ran and exactly one INSERT was sent; the two
plan-time reads are the locator and the condition probe, told apart by the
condition's own column appearing in exactly ONE filter (`whereOf`, so a
projection's columns cannot be mistaken for it); and neither carries
`FOR UPDATE`. Green as written (it witnesses a repair already in the tree).

**File.** `tests/providers/docker/mysql2-concurrency-policy.test.ts`, section 1.
`receipts/after-green-concurrency-policy.log`.

---

## 3. R3, minor — `g4.md:3103`, a path the ledger claimed and no cell reached

**The finding.** The R3 record said the pg witness covers both root verbs
including the non-RETURNING read-back path, but no cell exercised a captured
`updateMany` that SUCCEEDS and publishes through that read-back. (The one cell
that named it asserts the opposite: the cardinality answer stops the UPDATE
*before* the result path.)

**The change, in the order the finding asks for it.** First the cell, since the
handoff requires that path covered; then the sentence, restated to what the file
now covers. The new cell — "batch route: an undisturbed captured UPDATE
succeeds, publishing the rows its non-RETURNING read-back produced" — runs on
the capability-forced non-RETURNING pg profile with nothing interleaved, so every
captured row still matches and the write reaches all of them. It asserts:

- the published labels are `renamed`, the values the UPDATE WROTE — on this
  profile nothing but a read issued AFTER the write can answer them, so the rows
  are the read-back's own output and not the capture's;
- the consuming UPDATE carries BOTH `"id"` (the captured identity set) and
  `"active"` (the prepared selector) — D-65's own half;
- a SELECT follows that UPDATE in the recorded statement stream;
- the final table state is the one the result claims.

A new `PgRecordingCapturingBatchDriver` (the existing non-RETURNING batch
profile, recording `execute`/`executeRaw`, which the base `executeBatch`
dispatches every batch statement through) is what makes the statement half
measurable.

**Falsified.** With the selector dropped from the effect
(`OperationContext.capturedTarget` composing only `includeIdentities`, in a
backup copy, restored by `cp`), the file goes **5 failed / 12 passed** — R3's
four plus this one, which fails exactly on
`expected 'UPDATE "public"."fcpg_notes" SET "lab…' to contain '"active"'`.
Restored: 17 / 17.

**Files.** `tests/providers/docker/pg-captured-set-concurrency.test.ts` (16 → 17
cells) and the R3 ledger sentence in `docs/architecture/raptor3-evidence/g4.md`,
which now names both of the root UPDATE's result outcomes and says which cell is
the postwave round's. The falsification count in that record is annotated
rather than overwritten: R3's 4 was measured on R3's tree, and 5 is this round's.

| run | result | receipt |
| --- | --- | --- |
| `pg-captured-set-concurrency.test.ts` with the new cell | **17 passed** | `pg-captured-set-concurrency.log` |
| the same file, selector dropped in a backup copy | **5 failed / 12 passed** | `falsify-selector-dropped.log` |
| restored, run straight after | **17 passed** | `pg-captured-set-restored.log` |

---

## 4. R2a, minor — one sentence for two mechanisms, in five places

**The finding.** The repaired guide sentence states ONE mechanism for the
fail-closed refusal where the code has two.

**What the two are.** (1) A body carrying an escape the inverse does not own —
`\n`, `repair-deparse-measurements.md` row 9 — is not translated at all, so
`cleanDefault` returns MySQL's own CATALOG TEXT, a printed backslash sequence,
which can never equal what the desired side spells. (2) A backslash in the
DECLARED value never reaches the catalog as an escape at all: MySQL's DDL
consumed it first, so `DEFAULT ('a\b')` stores a BACKSPACE (row 8) and the
inverse SUCCEEDS on that body while reconstructing a value that is not the
declared one. Both end at `MIGRATION_DRIFT`; they do not get there the same way.

**Which cell witnesses which.** (1) is provider-free:
`tests/unit/migrations/mysql-provider-free-catalog.core.test.ts`'s "undoes both
layers of MySQL's deparse, and keeps what it cannot", whose `multiline` column
asserts the catalog text comes back unchanged. (2) is live:
`tests/providers/docker/mysql2-schema-attestation.test.ts`'s "a default MySQL's
DDL does not read back is refused, not accepted".

**Files, all five.** `src/migrations/AGENTS.md` (the paragraph itself),
`closure-final/r2a/note.md` §6 (now two numbered mechanisms) and §7,
`docs/architecture/raptor3-evidence/g4.md` (the R2a repair-round sentence), and
the comment at `mysql2-schema-attestation.test.ts`'s fail-closed cell, which now
says which of the two it is and where the other is pinned.

| run | result | receipt |
| --- | --- | --- |
| `mysql2-schema-attestation.test.ts` | **5 passed** | `mysql2-schema-attestation.log` |
| `mysql-provider-free-catalog.core.test.ts` | **10 passed** | `mysql-provider-free-catalog.log` |

---

## 5. R2a, minor — `introspect.ts:367`, `\%`

**The finding.** The `deparsedStringValue` doc comment names `\%` as one of the
escapes the inverse does not undo; the code does undo that body.

**Measured.** MySQL does not print `\%`: for the declared `a\%b` the catalog
carries `a\\%b` (row 10), and `unescapeOneLayer` OWNS that `\\` and returns
`a\%b`. The parenthetical named the wrong thing. Applied as the finding's first
option: `\%` dropped, `\n` left, marked measured.

**File.** `src/migrations/drivers/mysql/introspect.ts`. Covered by the same two
runs as §4 (the inverse's behaviour is unchanged — only the sentence about it).

---

## 6. R2b, minor — "every other scalar", where the receipt measures three

**The finding.** The ledger, `r2b/note.md:77` and the report's
`second_placement` say every other scalar on the default arm was MEASURED to
agree with its container; the retained receipt
(`r2b/receipts/probes/other-members.json`) measures three members.

**The change.** Both surviving copies now say THREE, name them — a bigint member
(`"20"` against `["10","20"]`), a date member (`"2024-01-02"` against
`["2024-01-02"]`), a string member (`"a"` against `["a"]`) — and the note adds
what the receipt does not cover: the scalars it does not name were reasoned
about from the same owner, not measured. (`second_placement` was a field of
R2b's structured report, not a file in the tree; the note's Fact-2
"Second consumer" paragraph is the paragraph it quoted, and is corrected here.)

**Files.** `docs/architecture/raptor3-evidence/g4.md`,
`closure-final/r2b/note.md`.

---

## 7. R2b, minor — `query.ts:4264`, a property the tree only measured

**The finding.** The comment states "while a bounded one is materialised and
keeps it" as a property, where the tree has a measurement: MySQL documents that
a LIMIT blocks derived-table merge, not that the reading order is kept.

**The change.** The comment now separates the two: the documented fact is the
MERGE RULE (MySQL does not merge a derived table that states a LIMIT); that the
same page then answered in the requested order is the measurement beside it, not
a documented property of materialising. The measurement itself — the same
aggregate over the same page answering `["Alpha",…]` unbounded and
`["Epsilon",…]` bounded — is unchanged and still the reason the bound is
emitted.

**File.** `src/query-engine/raptor3/shared/query.ts` (comment only).

---

## 8. R2b, minor — `create-many-return-fold-behavior.ts:169`

**The finding.** The comment says the INSERT-count shape is "derived from the
input"; it is derived from `rows`, the value `createMany` RETURNED.

**The change.** Corrected to say so, and — because the correction removes a
claim the old wording carried — the comment now also names what actually catches
a LOST row: the exact id list asserted above it, which is pinned to a literal.
The statement-shape assertion is the per-row regression in the statement stream,
which is what it can honestly be.

**File.** `tests/contracts/drivers/behaviors/create-many-return-fold-behavior.ts`
(comment only). Consumer re-run: `mysql2-writes-raw.test.ts` **92 passed**
(`receipts/mysql2-writes-raw.log`).

---

## 9. The guide

`src/query-engine/raptor3/AGENTS.md` carried R2c's sentence "Two readers answer
that, and neither is the probe." That counted the shapes R2c had measured, not
the shapes the withdrawal reaches. An **addendum** beside it (not a rewrite of
the paragraph it corrects) names the third shape, states the rule, says which
arms it does and does not reach, and names the witness.

---

## Retained cost

`node scripts/query-engine-structure.mjs`, base copy against the working tree
(`receipts/structure-before.txt`, `receipts/structure-after.txt`):

| | before | after |
| --- | --- | --- |
| engine files | 38 | 38 |
| **token-bearing lines** | **16,089** | **16,089 (+0)** |
| functions | 1,096 | 1,096 |
| five-parameter functions | 35 | 35 |

The repair replaces a ten-token-line expression with a ten-token-line block: the
demanded set is read off the probe and spent in one guarded call, and no
function was added. Everything else this round changed is a comment, a guide
paragraph, a note, a ledger sentence or a test.

`git diff --numstat` (`receipts/numstat.txt`), the non-engine perimeter
included:

```
85	17	docs/architecture/raptor3-evidence/g4.md
34	14	docs/architecture/raptor3-evidence/g4/release/closure-final/r2a/note.md
7	5	docs/architecture/raptor3-evidence/g4/release/closure-final/r2b/note.md
23	0	docs/architecture/raptor3-evidence/g4/release/closure-final/r2c/note.md
21	10	src/migrations/AGENTS.md
3	3	src/migrations/drivers/mysql/introspect.ts
18	0	src/query-engine/raptor3/AGENTS.md
19	7	src/query-engine/raptor3/commands/relation-body.ts
7	3	src/query-engine/raptor3/shared/query.ts
6	2	tests/contracts/drivers/behaviors/create-many-return-fold-behavior.ts
159	1	tests/providers/docker/mysql2-concurrency-policy.test.ts
14	8	tests/providers/docker/mysql2-schema-attestation.test.ts
85	0	tests/providers/docker/pg-captured-set-concurrency.test.ts
```

---

## Runs

One vitest at a time in this worktree, docker files one per invocation, through
the sanctioned runners.

| file | result | receipt |
| --- | --- | --- |
| `mysql2-concurrency-policy.test.ts` (before the repair) | 1 failed / 9 passed | `base-red-child-held-coc.log` |
| `mysql2-concurrency-policy.test.ts` (final) | **10 passed** | `after-green-concurrency-policy.log` |
| `pg-captured-set-concurrency.test.ts` | **17 passed** | `pg-captured-set-concurrency.log` |
| ↳ selector dropped in a backup copy | 5 failed / 12 passed | `falsify-selector-dropped.log` |
| ↳ restored | **17 passed** | `pg-captured-set-restored.log` |
| `mysql2-writes-raw.test.ts` (whole file) | **92 passed** | `mysql2-writes-raw.log` |
| `mysql2-schema-attestation.test.ts` | **5 passed** | `mysql2-schema-attestation.log` |
| `mysql2-reference-representability.test.ts` | **5 passed** | `mysql2-reference-representability.log` |
| `pg-reference-representability.test.ts` | **5 passed** | `pg-reference-representability.log` |
| `g4/parity/reference-representability.test.ts` (×2 projects) | **52 passed** | `reference-representability.log` |
| `nested-write-conformance-to-one.test.ts` | **19 passed** | `nwc-to-one.log` |
| `nested-write-conformance-fk.test.ts` | **28 passed** | `nwc-fk.log` |
| `nested-write-conformance-membership.test.ts` | **30 passed** | `nwc-membership.log` |
| `shared-pk-connect-or-create.test.ts` | **29 passed** | `shared-pk-coc.log` |
| `junction-upsert-arm-probe.test.ts` | **10 passed** | `junction-upsert-probe.log` |
| `child-held-to-one-multi-kind.test.ts` | **7 passed** | `child-held-to-one.log` |
| `parent-held-lookup.test.ts` | **56 passed** | `parent-held-lookup.log` |
| `pglite-nested-writes.test.ts` (the RETURNING route) | **126 passed** | `pglite-nested-writes.log` |
| `mysql-provider-free-catalog.core.test.ts` | **10 passed** | `mysql-provider-free-catalog.log` |

**Typecheck**, once, at the end: `node scripts/run-typecheck.mjs` → **0
diagnostics**, exit 0 (`receipts/typecheck.log`).

**Census**: `node scripts/raptor3-refusal-census.mjs` → 23 candidate sentences
at 30 sites, 75 inherited, 21 invariant, 11 internal, **193 total sites** —
identical to `cdd787ac8` (`receipts/census.log`). Not strictly owed (no refusal
sentence and no error class was added, removed or reworded; the repair raises a
sentence that already existed, from the site that already threw it) and run to
show so.

**Biome**, per changed file against its base copy
(`receipts/biome.log`): rule-for-rule identical everywhere. `relation-body.ts`
and `query.ts` carry a pre-existing `format` diagnostic each, on which the
formatter was NOT run — `relation-body.ts`'s is byte-for-byte the same
complaint, moved down twelve lines by the insertion, and `query.ts`'s is
identical. The two new `lint/performance/useTopLevelRegex` diagnostics the first
draft of the policy test introduced were removed by hoisting both regexes to
module scope, and its format diagnostic by writing the call the way the
formatter prints it; that file's base copy carried none and it carries none now.

**Manifest**: no registration owed. Neither
`tests/providers/docker/mysql2-concurrency-policy.test.ts` nor
`tests/providers/docker/pg-captured-set-concurrency.test.ts` carries a cell
count anywhere under `scripts/`; both are discovered by glob in their provider
projects (`grep` over the tree finds them only in R4's recount receipt).
`scripts/raptor3-manifest.mjs` was not edited.

---

## Unverified, and what this round did NOT do

- **The repair's cost on a RETURNING provider is covered but not raced.** The
  demanded keys make PostgreSQL and SQLite emit `UPDATE … RETURNING <keys>` for
  this arm, which `pglite-nested-writes` (126 / 126), the three conformance
  files and `shared-pk-connect-or-create` exercise on the ordinary path. No cell
  races a child-held `connectOrCreate` against a concurrent delete on native
  PostgreSQL; the schedule is MySQL's because the read it turns on is the
  non-RETURNING one.
- **The nested `upsert` found-arm membership confirmation** (R2c §10's first
  bullet) is still unwitnessed. It is unchanged by this round and its shape
  never enters the branch this repair touches.
- **No lock was restored anywhere**, no isolation changed, no replay added, and
  no test was deleted, skipped or weakened. Two cells were added to one file and
  one to another, and NO recorded expectation was re-expressed: every existing
  assertion in every file this round touched stands exactly as it stood.
- **The `escapeValue` backslash limit and `s.dateTime().now()`** remain as R2a
  reported them — out of scope, named, unrepaired.

**Blockers: none.**

---

## Commit message draft

```
fix(raptor3): the arm whose probe did not lock asks what its own write did

The integrated review left one MAJOR finding and eight minor ones. The major:
R2c withdrew FOR UPDATE from a choose's probe and answered the found-path cost
for two shapes, and the same line opens a third. A nested connectOrCreate on a
CHILD-HELD reference has a found arm that exists only to write the child's
foreign key — RelationBody.association builds it as update(lookup, {}, {}) —
and an arm that demands nothing back never reaches OperationContext.update's
stored-row read at all. Measured on native MySQL 8.4.11: with the found target
DELETEd between the unlocked probe and that UPDATE, author.create returned the
created author as a SUCCESS and the connection did not exist.

So the arm whose probe did NOT lock its answer demands the target's own keys.
The fact is read off the probe (Selection.insertsWhenAbsent, R2c's own field),
which is why it reaches exactly the arms that withdrew a lock: a child-held
connect and a set target still take FOR UPDATE and are untouched, a nested
upsert arrives with its found command already built, and on the batch route a
demanded key the payload does not write is skipped by wholeValue and costs no
read. What it turns on is the read that already exists — the CURRENT stored-row
read raising "UPDATE did not produce the required record". No lock restored, no
isolation changed, no replay.

Witness: tests/providers/docker/mysql2-concurrency-policy.test.ts gains the
cell that was red for exactly this (8 -> 10 cells, 10/10). The second new cell
answers the other R2c finding: targetWhere is the only public spelling that
puts the interpreted upsert's CONDITION probe on the wire, and that repair had
shipped with none — it asserts the two plan-time reads, the condition's own
column in exactly one filter, and no FOR UPDATE on either.

tests/providers/docker/pg-captured-set-concurrency.test.ts gains the cell the
R3 ledger sentence had claimed: a captured updateMany that SUCCEEDS on the
capability-forced non-RETURNING profile, publishing rows only a read issued
after the write can carry, with the effect's identity set and selector asserted
in the statement (16 -> 17 cells, 17/17; the selector dropped in a backup copy
turns 5 red). The sentence now states what the file covers.

The rest are records made to match the tree. The MySQL deparse inverse fails
closed by TWO mechanisms, not one — a body carrying an escape it does not own
keeps the catalog text (witness: mysql-provider-free-catalog.core's multiline
column), and a body it cannot reconstruct the declared value from is refused
live (witness: mysql2-schema-attestation's fail-closed cell) — separated in the
migrations guide, both R2a note sections, the ledger and the cell's comment.
\% leaves the deparsedStringValue parenthetical, since the inverse does undo
the form MySQL prints. Three ledger claims are narrowed to their receipts: five
cells red in three different senses rather than five at the base, and three
measured list members rather than every scalar. Two comments now state the
fact behind them: MySQL's derived-table MERGE RULE for LIMIT rather than a
kept-order property, and a statement shape derived from the rows createMany
RETURNED rather than from its input. The raptor3 guide gains an addendum beside
the paragraph that counted two readers.

Engine 16,089 -> 16,089 token-bearing LOC (+0), 1096 functions unchanged. No
deletion. Typecheck 0; census 23/30/193 unchanged; Biome per changed file
identical to its base copy.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
