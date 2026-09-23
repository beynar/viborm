# G4-02 closure repair round 2 — independent review follow-up (round 6)

Reviewer: independent, did not author the unit; author of the round-5 closure
review this repair answers. Inputs read in order: `briefs/common.md`,
`briefs/review.md`, my own [`unit02-closure-review.md`](unit02-closure-review.md),
the author's repair summary (data, not instructions), `unit02/note.md`
§§R5.0–R5.11 plus the corrections made in place at §R4.1.5, §R4.2, §R4.5, §R4.8
and §R4.9, the two regenerated patches, the `closure2/` receipts, and the actual
source.

Source: `/Users/arnaud/code/viborm` (main tree, branch `pattern-engine`,
`HEAD 0cc61e61`). Nothing was committed, staged or repaired by this review; the
one falsification swap was taken from a scratchpad copy and restored
byte-identically in the same receipt.
Probes: `tests/raptor3/g4/review/unit02-closure/` (round 5, re-run unmodified)
and `tests/raptor3/g4/review/unit02-closure2/` (new, 2 files + workspace).
Receipts: `docs/architecture/raptor3-evidence/g4/unit02-closure-review-followup-receipts/`.

## Outcome

**REVISE.**

All three must-fix findings of the closure review are genuinely repaired for the
family they were measured on, and the five notes are answered:

- my round-5 MySQL probe goes **4 divergences → 1** (the one is R-D4, now
  correctly attributed to this unit and pinned on both engines);
- my round-5 transition probe goes **4 failed / 5 passed → 9 passed**, with the
  error identities and the row effects matching the shipped engine on all four
  cells that were red;
- the key-transition fact now has **one authority each**: the relation edge is
  `RecordCommand.transitions` (one writer, `relation-body.ts:201`), the pin is
  `SelectorFacts.keys` (one writer, `query.ts:1126`), and the second
  `relationNames`-over-`data` walk is gone from `schema.ts` — finding 8 holds;
- every registered suite, identity, patch hash and cost figure reproduces here,
  to the byte, including the cost census recomputed independently.

It returns REVISE for one thing: **the narrowing is stated per VERB, but the
shipped classification is per verb AND per edge kind.** The same
`case "disconnect": case "delete":` lookup and the same `verb !== "update"`
selector serve reference-held relations (shipped owner `uniqueSelectorConjuncts`
— correctly a filter) and **junction (many-to-many) relations**, whose shipped
owner is `buildWhereUnique` (`JunctionStatements.ts:322-323`,
`RelationJunctionPart.ts:1509`, `:1629`, `:1663`). On a case-insensitive
collation the candidate now **refuses a junction `disconnect` and a junction
`update` that the shipped engine performs**, and leaves the provider's rows
untouched (finding 9, measured on the live container, falsified both ways
against this round's own hunk). It is the exact mirror image of round 5's
finding 1, on the edge kind neither the author's cell nor my round-5 probe
covered — the author's new scope cell uses a model set with no junction in it.

## Per-finding status (round-5 review)

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| 1 | [must-fix] the discriminator rule widened to the nested `disconnect`/`delete`/`update` targets | **REPAIRED for reference edges** — the three cells agree in answer *and* rows; a compound-selector nested `delete` I had not measured is fixed by the same hunk. **NOT repaired for junction edges → finding 9** | [`probe-mysql-discriminator-scope.log`](unit02-closure-review-followup-receipts/probe-mysql-discriminator-scope.log), [`probe-mysql-scope-boundaries.log`](unit02-closure-review-followup-receipts/probe-mysql-scope-boundaries.log) |
| 2 | [must-fix] the refusal pinned from equalities the shipped owner never reads | **REPAIRED** — `facts.keys` is written only where `key: true` is, an arm cannot pin by construction (`query.ts:1060` vs `:1087`), and both AND-arm cells match shipped in identity and effect | [`probe-upsert-transition-scope.log`](unit02-closure-review-followup-receipts/probe-upsert-transition-scope.log) (9 passed) |
| 3 | [must-fix] the refusal fired for a COMPOUND reference key | **REPAIRED** — `edge.pairs.length === 1` mirrors `RecordUpdateCompiler.ts:3310`; both compound cells match, and the absent row is created | same receipt |
| 4 | [note] §R4.1.5 misidentified the nested call sites | **CORRECTED in place**, per verb, and it says what it got wrong. (The corrected list is still per-verb only — that is finding 9) | `note.md` §R4.1.5 |
| 5 | [note] `g4-route-lifecycle` reported as 3 | **CORRECTED to 8** at §R4.2 and §R4.5; I measure 8, and the attribution checks out: `scripts/raptor3-manifest.mjs:509-511` registers 8 under "Owned by the G4-03 author", and no file of this unit's is in that mode | [`g4-route-lifecycle.log`](unit02-closure-review-followup-receipts/g4-route-lifecycle.log) |
| 6 | [note] B-1c's widened-sum branch unreachable | **RECORDED as unverified** at §R4.9 item 5; my probe reproduces byte-identically (9 passed / 2 failed, same two cells) | [`probe-route-cache-codec.log`](unit02-closure-review-followup-receipts/probe-route-cache-codec.log) |
| 7 | [note] R-D4 is created by this round | **RE-ATTRIBUTED** in §R4.8, §R4.9 item 7 withdrawn, both engines' FK bytes pinned in an author cell; it remains the single red cell of my round-5 probe, which is the prescribed handling (`common.md`: a new observable compatibility choice is Arnaud's decision) | §R4.8, `unique-discriminator.test.ts:671` |
| 8 | [note] the refusal re-derived a fact the command tree owns | **REPAIRED** — `keyTransitionRefusal` takes `transitions`; `grep` shows one writer (`relation-body.ts:201`) and the schema walk deleted; `schema.ts` token-lines fall 390 → **387**, which I recomputed | [`cost-recheck.txt`](unit02-closure-review-followup-receipts/cost-recheck.txt) |

## New findings

### 9. [must-fix] The narrowing is per VERB, but the shipped classification is per verb AND per EDGE KIND: a junction `disconnect` / `update` now refuses what the shipped engine performs

**Location.** `src/query-engine/raptor3/commands/relation-body.ts:214`
(the `case "disconnect": case "delete":` target lookup, which no longer states
`unique`) and `:357-361` (`prepareSelector(edge.target, conditional.where,
verb !== "update")`). Both sites are reached for **every** edge kind:
`relation()` is called with `edge` = a reference membership *or* a junction
membership (`relation-body.ts:318-330`).

**Mechanism.** §R5.1's table names one shipped filter owner —
`uniqueSelectorConjuncts` (`write-engine/shared.ts:671`), reached from
`RelationWritePart.ts:987` / `UpdateOperation.ts:469` /
`RecordUpdateCompiler.ts:3722`. Those are the **reference-held** relation parts,
and for them the narrowing is right. A **junction** target is compiled by a
different owner, which spells the target selector as a discriminator in both
phases:

```
JunctionStatements.ts:322-323   if (isRecord(args.whereUnique))
                                  predicates.push(buildWhereUnique(child, args.whereUnique, table));
RelationJunctionPart.ts:1509    : buildFindUnique(this.childScope, { where, … })
RelationJunctionPart.ts:1629    statement: buildFindUnique(this.childScope, { where: item.where, … })
RelationJunctionPart.ts:1663    statement: buildFindUnique(this.childScope, { where: item.where, … })
```

`membershipRead` takes `whereUnique` (→ `buildWhereUnique`) and `where`
(→ `buildWhere`) as two separate arguments in one statement: the shipped engine
keys the spelling on **which half of the selector it is**, never on the verb. So
round 2 turned the junction targets of `disconnect` / `delete` / `update` from
discriminators into filters, which drops the case-sensitivity difference on a
MySQL `_ci` collation in the opposite direction from finding 1.

**Failing probe.**
`tests/raptor3/g4/review/unit02-closure2/mysql-scope-boundaries.review.test.ts`

```
VIBORM_RAPTOR3_PROVIDER=mysql VIBORM_RAPTOR3_PROVIDER_PORT=65515 \
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit02-closure2/review.workspace.ts \
  tests/raptor3/g4/review/unit02-closure2/mysql-scope-boundaries.review.test.ts
```

Receipt: [`probe-mysql-scope-boundaries.log`](unit02-closure-review-followup-receipts/probe-mysql-scope-boundaries.log)
and the closing re-run [`probe-mysql-scope-boundaries-closing.log`](unit02-closure-review-followup-receipts/probe-mysql-scope-boundaries-closing.log)
(container `viborm-raptor3-g3-mysql-20260914`, `d6da412eec3c`, `127.0.0.1:65515`,
`utf8mb4_0900_ai_ci`; 15 cells, each re-seeded and run on both engines,
comparing the answer, the child rows, the junction rows and the target rows):

| request (`owner.update({ where:{id:"wanted"}, data:{ tags: … } })`) | shipped | candidate |
| --- | --- | --- |
| `tags: { disconnect: [{ id:"G1" }] }` | `ok`, the link row is **removed** | `NestedWriteError: Cannot disconnect relation 'tags': target record was not found for this parent.` — link untouched |
| `tags: { update: [{ where:{id:"G1"}, data:{label:"u"} }] }` | `ok`, the tag row's `label` is **`u`** | `NestedWriteError: Cannot update relation 'tags': target record was not found for this parent.` — tag untouched |
| `tags: { delete: [{ id:"G1" }] }` | `ok`, link and tag row deleted | `NestedWriteError: Cannot delete …` (pre-existing divergence too — finding 10) |
| controls: junction `connect`, junction `set`, junction `disconnect` by exact bytes | agree | agree |

**Falsification (this round introduced it).** `relation-body.ts` swapped back to
the round-5 spelling (`unique: true` on the `disconnect`/`delete` lookup, `true`
on the shared selector), from a scratchpad copy, identities recorded before, in
and after the swap and the file restored and re-hashed to
`bbccc1313821e2d75f753ac85b98d7e380a02980d6eac1985b716977463688f5` in the same
receipt: [`falsify-junction-scope.log`](unit02-closure-review-followup-receipts/falsify-junction-scope.log).
Under the round-5 spelling **`junction disconnect` and `junction update` are
GREEN** and the reference-family cell `nested delete, COMPOUND selector` is RED
— i.e. this hunk is exactly what trades one family's parity for the other's.
`g2-mysql-contracts` is 13/13 either way, so no registered gate sees it.

**Why it went unmeasured.** The author's own new scope cell
(`unique-discriminator.test.ts:567`, ten differential rows) declares models
`owner`, `note`, `pair` — **no junction relation exists in it**, so its five
"must stay filters" rows and five "must address through the constraint" rows are
all reference-family rows. My round-5 probe had the same gap.

**What would resolve it.** Either state the rule where the shipped engine states
it — on the half of the selector, i.e. mark the target selector `unique` when
the edge is a junction (and keep the filter for `edge.kind === "reference"`
targets of `disconnect` / `delete` / `update`) — or keep one rule for both and
record the junction divergence as an observable compatibility decision for
Arnaud with both engines' answers pinned, as R-D4 is. It is currently neither,
and §R4.1.5's corrected call-site list and `SelectionSource.unique`'s doc
(`selection.ts:21-31`) both assert the stronger claim ("the call sites whose
shipped counterpart is `buildWhereUnique`") that the junction family falsifies.
Whichever is chosen, the author's scope cell needs a junction relation in its
model set, or the next round cannot see this either.

### 10. [note] Pre-existing, not this round's: a junction `delete` is a `ForeignKeyError` on the candidate even with exact bytes

In the same probe, `tags: { delete: [{ id: "g1" }] }` (exact bytes, the control
row) answers `ok` on the shipped engine — link row and tag row both gone — and
`ForeignKeyError: Foreign key constraint violation` on the candidate, with
nothing written. It is **not** caused by this round: the cell is red under the
round-5 spelling too ([`falsify-junction-scope.log`](unit02-closure-review-followup-receipts/falsify-junction-scope.log)),
which is also why the collation-equal junction `delete` row above cannot isolate
the scope question. Recorded here because no receipt in this unit's evidence
mentions it and it is adjacent to what finding 9 asks the author to touch; it is
for whoever owns the junction delete ordering, not for this repair.

### 11. [note] §R4.8's registration-request row still says the estate is 105 cells

§R5.10 correctly says **111** (102 passed / 9 skipped credential-free, 110
passed / 1 skipped on native MySQL — both of which I reproduce). §R4.8's
standing `request` row, which is the text an integrator will act on, still reads
"stable at **105 cells** over 19 files (98 passed / 7 skipped credential-free;
104 passed / 1 skipped on native MySQL)". One number, two places, and the stale
one is in the row addressed to someone else.

## What was verified and holds

**Suites re-run independently, serially, through the bounded runner** (receipts
in `unit02-closure-review-followup-receipts/`; native rows on
`viborm-raptor3-g3-mysql-20260914` `d6da412eec3c` `127.0.0.1:65515` and
`viborm-raptor3-g3-pg-20260914` `7dfda37e8eea` `127.0.0.1:65504`, both up 17 h):

| mode / suite | measured | note's claim |
| --- | --- | --- |
| `g2-mysql-contracts` (65515) | **13 passed**, and **13 passed** again as the closing run after the falsifier swap | 13 ✔ |
| `g2-mysql-baseline` (65515) | **13 passed** | 13 ✔ |
| `g2-pg-contracts` / `g2-pg-baseline` (65504) | **18 / 17 passed** | 18 / 17 ✔ |
| `g2-contracts` / `g1-contracts` | **216 / 143 passed** | ✔ |
| `g3-suppression-retry` / `g3-transaction-array` / `g3-bulk-series` | **2 / 4 / 6** | ✔ |
| `g3-execution-review` / `g3-generated-transport-smoke` | **6 / 1** | ✔ |
| `g29-result-progress` / `g4-read-contracts` | **2 / 62** | ✔ |
| `g4-route-cache` / `g4-route-admission` / `g4-route-lifecycle` / `g4-route-transactions` | **7 / 7 / 8 / 13** | 7 / 7 / 8 / 13 ✔ (finding 5 closed) |
| `g4-lifecycle-admission` / `g4-lifecycle-events` | **4 / 3** | ✔ |
| G4-02 author estate, SQLite (19 files) | **102 passed / 9 skipped (111)** | ✔ |
| G4-02 author estate, native MySQL | **110 passed / 1 skipped (111)** | ✔ |
| frozen fast-path pins | `physical-envelope` **10**, `packaged-array` **5**, `prepared-operation` **5** | unchanged ✔ |
| `node scripts/run-typecheck.mjs` | exactly the two permitted `pattern/pack.ts` diagnostics (1443, 2633); 16.0 s, 5,583 MiB peak | ✔ |
| reviewer probe — discriminator scope (round 5, unmodified) | **1 divergence: `nested connect` = R-D4** (was 4) | ✔ |
| reviewer probe — transition owner (round 5, unmodified) | **9 passed** (was 4 failed / 5 passed) | ✔ |
| reviewer probe — cache codec (round 5, unmodified) | **9 passed / 2 failed**, byte-identical to both earlier runs | ✔ |
| **new** reviewer probe — transition-owner boundaries (14 cells, SQLite differential) | **14 passed** | not claimed |
| **new** reviewer probe — scope boundaries (15 cells, live MySQL) | **4 divergences**, 3 of them junction (finding 9), 1 pre-existing (finding 10) | not claimed |

**The new transition owner survives attack.** 14 adversarial differential cells
the author did not run all agree with the shipped engine
([`probe-transition-owner-boundaries.log`](unit02-closure-review-followup-receipts/probe-transition-owner-boundaries.log)):
an `{ equals }`-spelled locator, an **empty** relation array beside the divide
(both engines still raise the transition sentence), a child-held `disconnect` /
`set` / `update` / `connect`-of-a-missing-child beside the divide, a **junction**
relation beside the divide (both answer the *validator's* sentence), a relation
named only in the `create` arm (row present and absent), a non-key-unique
locator (row present and absent), and the refusal's new placement against a
malformed nested `create` (both engines answer the same `ValidationError`, so
moving the refusal four statements later changed no order).

**One authority, verified by grep.** `RecordCommand.transitions`: one writer
(`relation-body.ts:201`), read by `commands.ts:1204` (this refusal) and
`execution.ts:66` (pre-existing consumer). `SelectorFacts.keys`: one writer
(`query.ts:1126`, under `key`), one merge (`andSelectors`, `:948-949`), one
reader (`commands.ts:1203`). `key: true` prepared columns: one reader
(`query.ts:1501`). The sentence `"Cannot divide a primary key by zero."` has one
candidate home (`schema.ts:298`). No second walker was added; the one deleted
stayed deleted.

**Patches.** `production-closure.patch`
(`5e0b62d4728bca44595799a2bb6183549e25af07c29177940ad6e45a345f0cdb`) and
`tests-closure.patch`
(`38920ca800c4d3fc6e236b550cde97c58cfd32545b4a7dd7ab01ba1cac2e9f87`) hash as
claimed. The production patch reverse-applies cleanly in a scratchpad copy and
reproduces all six round-4 base identities the note names — `query.ts 5143b7b3…`,
`schema.ts 07b3df1a…`, `commands.ts f4ecd7ad…`, `selection.ts 874dc5ec…`,
`relation-body.ts 79066ea8…`, `client-route.ts 82ba9c9e…`. The round-2 base
identities in `closure2/identities-round2-base.txt` are byte-identical to the
six I recorded at the start of the round-5 review, so the repair was built on
the exact tree I reviewed.

**Cost**, recomputed independently with the `countTokenLines` census of
`scripts/query-engine-structure.mjs`
([`cost-recheck.txt`](unit02-closure-review-followup-receipts/cost-recheck.txt)):
four phase-2 files **262,286 / 7,402 / 6,738**; `schema.ts` **17,464 / 485 /
387**; `selection.ts + relation-body.ts` **34,114 / 1,025 / 994**;
`client-route.ts` **14,880 / 378 / 247**; candidate core (12 files) **355,351 /
10,171 / 9,342**; the `raptor3` tree (15 files) **390,963 / 11,185 / 10,215**.
Every figure in §R5.8 is reproducible to the byte, and the claimed increments
(+2,755 bytes, +43 physical over the round-5 core, which I measured at
352,596 / 10,128 last round) check out.

**Working tree.** Nothing staged; the modified-tracked-file set is exactly the
session-start set (38 files); the only additions are this review, its receipts
directory and `tests/raptor3/g4/review/unit02-closure2/`. The one falsification
swap was restored byte-identically and re-hashed in its own receipt and again in
[`identities-review-end.txt`](unit02-closure-review-followup-receipts/identities-review-end.txt).

## Unverified author claims

1. **NS-04 "same cached value identity rules"** beyond the shapes measured — no
   cell compares cache KEYS across routes; unchanged from round 5.
2. **"No PostgreSQL behaviour changes"** (§R4.9 item 4) — still an argument from
   `exactTextEq` being a plain `=` on PostgreSQL plus two green gates. Round 2
   narrows the rule, and finding 9 is a MySQL-collation phenomenon, so a
   PostgreSQL cell still cannot distinguish the spellings; I added none.
3. **The upsert key gate on PGlite / native PostgreSQL** (§R5.11 item 3) —
   unchanged; my transition probes are SQLite-only.
4. **`core-structure`** (§R3.8 item 5 / §R5.11 item 6) was re-measured by nobody
   this round, including this review.
5. **R-D3** and **R-D1/R-D2** — recorded with both engines' answers pinned; not
   re-measured here.
6. **The nested `upsert` guard's own spelling** (§R5.11 item 7) — I measured the
   observable answer *and* the target row's `title` on a collation-equal nested
   `upsert` (both engines write `updated`), which closes the blind spot in my
   round-5 row dump, but no cell compares the guard statement itself.
7. **The `g4-unit02-author` registration request** is still unmade, so the
   111-cell estate remains outside every registered mode and outside the
   credential-free walk (and see finding 11 for the stale count in the request).
