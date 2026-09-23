# G4-02 closure repair round 3 — independent review follow-up 2 (round 7)

Reviewer: independent, did not author the unit; author of the round-5 closure
review and of the round-6 follow-up this repair answers. Inputs read in order:
`briefs/common.md`, `briefs/review.md`, my own
[`unit02-closure-review.md`](unit02-closure-review.md) and
[`unit02-closure-review-followup.md`](unit02-closure-review-followup.md), the
author's repair summary (data, not instructions), `unit02/note.md` §§R6.0–R6.10
plus the corrections made in place at §R4.1.5, §R4.8, §R5.1 and §R5.10, the two
regenerated patches, the `closure3/` receipts, and the actual source.

Source: `/Users/arnaud/code/viborm` (main tree, branch `pattern-engine`,
`HEAD 0cc61e61`). Nothing was committed, staged, or repaired by this review; no
falsification swap was needed this round, and `identities-review-start.txt` and
`identities-review-end.txt` are byte-identical files.
Control: the clean `0cc61e61` worktree `/private/tmp/viborm-g4-perf-baseline`,
verified clean before and after each of the three probe copies it carried.
Probes: `tests/raptor3/g4/review/unit02-closure/` and `…/unit02-closure2/`
(rounds 5 and 6, re-run unmodified) and `…/unit02-closure3/` (new, 2 files +
workspace).
Receipts:
`docs/architecture/raptor3-evidence/g4/unit02-closure-review-followup-2-receipts/`.

## Outcome

**ACCEPT.**

Finding 9 is genuinely repaired, and repaired the way the review asked: the
spelling rule is now stated **once**, per EDGE KIND, in one exported predicate
that carries the shipped citations on itself, and the three nested target sites
consult it and nothing else. I verified every citation in that doc comment
against the shipped source, and every one is accurate
(`JunctionStatements.ts:322-323`, `RelationJunctionPart.ts:1509/1629/1663` and
the three `membershipRead` sites, `shared.ts:671`, `RelationWritePart.ts:987`,
`UpdateOperation.ts:469`, `RecordUpdateCompiler.ts:3722` — the last of which is
`parentHeldCorrelation`, i.e. the third shipped position, and it is in the
filter family, which is what makes the candidate's two-way `edge.kind` fold
correct rather than lucky).

- my round-6 MySQL probe goes **4 divergences → 2**, and the 2 are finding 10 on
  both selectors, now answering **identically to each other**;
- the reference family stays exactly where round 2 left it: my round-5 probe is
  still **1 divergence**, and it is still R-D4;
- finding 10's classification is **confirmed independently**, not merely
  reproduced: my own round-6 probe, unmodified, run in the clean `0cc61e61`
  worktree, diverges on **both** junction `delete` cells with byte-identical
  answers and rows;
- the whole closure change to the two files it touched is 40 added lines against
  the committed base — one predicate, one flag, three consults — and the §7 gate
  passes on it;
- every suite, identity, patch hash and cost figure reproduces here to the byte,
  including the cost census recomputed independently and both patches
  reverse- and forward-applied in a scratchpad copy;
- four adversarial cell families the author did not run — a root verb addressed
  by a **non-primary-key unique**, a **parent-held** to-one target, a nested
  `upsert` on a **junction** edge (the one verb whose shipped spelling is mixed),
  and a junction `connectOrCreate` — all agree with the shipped engine.

Nothing found this round changes a public answer, an error identity, committed
state, or breaks a stated invariant, so the verdict is ACCEPT. Three notes
follow; **note 12 is the one that matters** — it is an attribution in a blocker
row addressed to Arnaud that my control measurement falsifies, and the error is
originally mine, not the author's.

## Per-finding status (round-6 review)

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| 9 | [must-fix] the narrowing is per VERB; the shipped classification is per verb AND per EDGE KIND, so a junction `disconnect` / `update` refused what the shipped engine performs | **REPAIRED** — junction `disconnect` and junction `update` on a collation-equal key now match shipped in answer *and* in the link and target rows; the reference family is untouched; the rule is stated once | [`probe-mysql-scope-boundaries.log`](unit02-closure-review-followup-2-receipts/probe-mysql-scope-boundaries.log), [`probe-mysql-discriminator-scope.log`](unit02-closure-review-followup-2-receipts/probe-mysql-discriminator-scope.log) |
| 10 | [note] a junction `delete` by exact bytes is a `ForeignKeyError` on the candidate | **CLASSIFIED, and independently confirmed PRE-EXISTING at `0cc61e61`** — my own probe, unmodified, in the clean worktree, gives byte-identical answers and rows on both cells | [`classify-baseline-0cc61e61-reviewer-probe.log`](unit02-closure-review-followup-2-receipts/classify-baseline-0cc61e61-reviewer-probe.log) |
| 11 | [note] §R4.8's request row still said 105 cells | **CORRECTED** at §R4.8 and §R5.10, to the live figures (112 over 19 files, 102/10 credential-free, 111/1 native MySQL) with the 105 → 111 → 112 history; I measure exactly those | [`author-estate-sqlite.log`](unit02-closure-review-followup-2-receipts/author-estate-sqlite.log), [`author-estate-mysql.log`](unit02-closure-review-followup-2-receipts/author-estate-mysql.log) |

### Finding 9, in detail

The repair is `nestedTargetAddressesConstraint(edge, verb)`
(`src/query-engine/raptor3/commands/selection.ts:59-66`), consulted at
`relation-body.ts:215` (the `disconnect` / `delete` lookup), `:350` (the
`connect` / `connectOrCreate` / `upsert` / `update` selector) and `:584`
(`setTargets`). The complete diff of the two files against their **committed**
identities at `0cc61e61` is 40 added lines and nothing else — one predicate with
its doc, `SelectionSource.unique` widened `true` → `boolean` on both union arms,
one `source.unique === true` pass-through in `Selection`'s constructor, and the
three consults. The two prose comments that used to state the rule beside the
call sites are gone; `grep` finds no second statement of the classification
anywhere in `src/query-engine/raptor3/` (`query.ts:2392` states the ROOT
`findUnique` fact, which the root verbs own, and `SelectionSource.unique`'s doc
points at the predicate rather than restating it).

The measured effect, on the live container (`d6da412eec3c`, `127.0.0.1:65515`,
`utf8mb4_0900_ai_ci`), comparing the answer, the child rows, the junction rows
and the target rows:

| request (`owner.update({ where:{id:"wanted"}, data:{ tags: … } })`) | shipped | candidate (round 2) | candidate (round 3) |
| --- | --- | --- | --- |
| `disconnect: [{ id:"G1" }]` | `ok`, link removed | `NestedWriteError` — link untouched | **`ok`, link removed** ✔ |
| `update: [{ where:{id:"G1"}, data:{label:"u"} }]` | `ok`, `label` = `u` | `NestedWriteError` — tag untouched | **`ok`, `label` = `u`** ✔ |
| `delete: [{ id:"G1" }]` | `ok`, link and tag gone | `NestedWriteError` | `ForeignKeyError` — finding 10, pre-existing |
| `delete: [{ id:"g1" }]` (exact bytes) | `ok`, link and tag gone | `ForeignKeyError` | `ForeignKeyError` — finding 10, pre-existing |

I did **not** need to falsify this round: the author's own falsifier
([`closure3/falsify-junction-scope.log`](unit02/receipts/closure3/falsify-junction-scope.log))
reconstructs the round-2 files from scratchpad copies, and the reconstructions
hash to `31528299…` and `bbccc131…` — **exactly** the two identities I recorded
at the end of the round-6 review in
[`identities-review-end.txt`](unit02-closure-review-followup-receipts/identities-review-end.txt).
That makes the falsifier's base verifiably the tree I reviewed, and the
before/in/after identity blocks show the files restored byte-identically. Both
halves of the rule have a falsifier: flipping the junction half red is that
receipt (2 of 5 cells fail); flipping the reference half red is the round-5
review's own measurement of the three "stays a filter" rows.

### Finding 10, independently confirmed rather than taken on trust

The author's classification receipt is sound — it records the worktree, the
commit, the container and the committed tree identities, and it says the probe
copy was removed. I verified the worktree is at `0cc61e61` and clean, and that
the three identities it records are the committed ones. But rather than read the
author's probe, I copied **my own** round-6 probe into that worktree unmodified
(`fa1500582625f36d…` on both sides) and ran it there. Result: **4 divergences at
the clean baseline**, and the two junction `delete` cells are among them, with
answers and rows byte-identical to the current tree:

```
[junction delete, exact bytes (control)]
  shipped   ok:{"id":"wanted","name":"winner"}          links [] tags []
  candidate ForeignKeyError: Foreign key constraint violation
            links [{"ownerId":"wanted","tagId":"g1"}] tags [{"id":"g1","label":"tag"}]
```

The other two baseline divergences — `nested update, EXTENDED selector` and
`nested delete, COMPOUND selector` — are cells this unit's closure work
**fixed**. The probe copy was removed and the worktree re-verified clean, in the
same receipt.

One refinement to R-B5's wording: at the clean baseline **both** junction
`delete` spellings already reached the `ForeignKeyError`. Round 2 turned the
collation-equal one into a `NestedWriteError`; round 3 restores it. So "round 3
only makes it reachable by a second selector spelling" is true of round 2 but
describes a **restoration**, not an expansion, relative to `HEAD`.

## New findings

### 12. [note] §R4.8's and §R5.10's R-D4 rows say "CREATED BY THIS UNIT'S REPAIR". The proper control falsifies that — R-D4 is PRE-EXISTING at `0cc61e61`. (The error is mine, from round 5.)

**Location.** `unit02/note.md` §R4.8 (the R-D4 row, "**CREATED BY THIS UNIT'S
REPAIR** … so 'pre-existing' was an argument and is now a measured falsehood"),
§R5.6, and §R5.10's R-D4 row ("now attributed to this unit's repair").

**Mechanism.** The author's falsification reverse-applied the closure patch,
which lands on the **round-4 patch base** — a tree that still carries this
unit's phase-1/phase-2 uncommitted work, including the new `exactTextEq` adapter
spelling (`mysql-adapter.ts:537-538`, `(col = v AND BINARY col = v)`). On *that*
tree the collation-equal `connect` is refused, which is what the author (and my
round-5 finding 7) measured. The tree that answers "did G4-02 create this?" is
the **committed** `0cc61e61`, because the whole unit is uncommitted.

**Failing probe.** My round-5 probe, unmodified (`10afd357942d82c6…`), run in
`/private/tmp/viborm-g4-perf-baseline`:

```
[nested connect on a collation-equal key]
  shipped   ok:{"id":"n2","title":"T","ownerId":"WANTED"}   notes [… n2 → WANTED]
  candidate ok:{"id":"n2","title":"T","ownerId":"wanted"}   notes [… n2 → wanted]
```

Receipt: [`classify-rd4-baseline-0cc61e61.log`](unit02-closure-review-followup-2-receipts/classify-rd4-baseline-0cc61e61.log)
(7 divergences at the baseline; the unit's closure work fixes 6 of them and
leaves this one exactly as it found it). My new parent-held cells show the same
thing on a second position:
[`classify-root-parent-held-baseline-0cc61e61.log`](unit02-closure-review-followup-2-receipts/classify-root-parent-held-baseline-0cc61e61.log).

**Why it is a note and not a REVISE.** It changes no answer, identity or state —
R-D4 is a recorded decision either way, and the pinned cell stays correct. But
it is the provenance line Arnaud will read when deciding, and it currently says
the opposite of what the control measures.

**What would resolve it.** Re-word §R4.8 / §R5.6 / §R5.10 to: the FK-byte
divergence is **pre-existing at `0cc61e61`** (measured with the reviewer's own
probe in the clean worktree); what this unit's repair changed is that the
collation-equal `connect` is refused on the *intermediate* phase-2 tree and
succeeds again at round 3 — i.e. the unit restores the baseline reachability, it
does not create the divergence. Withdrawing "now a measured falsehood" and
naming which tree each measurement ran on would close it.

### 13. [note] Two cell families the estate still cannot see, both now measured green by this review and neither pinned

My new probe `unit02-closure3/root-and-parent-held-scope.review.test.ts`
(13 cells) and `unit02-closure3/junction-upsert-scope.review.test.ts` (4 cells)
cover:

- a **root** verb addressed by a NON-primary-key unique — the shipped root
  `update` / `upsert` raise a presence guard built from
  `uniqueSelectorConjuncts(parent, this.parentWhere)` when
  `!selectorNamesPrimaryKey()` (`UpdateOperation.ts:455-469`, three sites in
  `UpsertOperation.ts`), which is the *filter* owner. Every cell in the estate
  and in my earlier probes drives the root verbs by the primary key, where that
  guard does not exist. Measured: `update`, `delete`, `upsert`, `findUnique` and
  `updateMany` by a collation-equal `email` all **agree**;
- a **parent-held** to-one target (`note.owner`, the FK on the row being
  updated) — the third shipped position. `connect`, `connectOrCreate`,
  `connect`-by-a-non-PK-unique, `disconnect: true` and a to-one nested `update`
  measured; only `connect` and `connectOrCreate` diverge, and they diverge in
  R-D4's exact way (`ownerId` `"WANTED"` vs `"wanted"`) **and do so identically
  at the clean baseline**;
- a nested `upsert` on a **junction** edge — the one verb whose shipped spelling
  is mixed (probe `RelationUpsertPart.ts:265` is `buildFindUnique`, guard `:578`
  is `uniqueSelectorConjuncts`). Update arm, create arm and exact-byte control
  all **agree**, and junction `connectOrCreate` on a collation-equal key agrees
  too — so R-D4 is a reference-FK phenomenon, not a junction one.

Receipts: [`probe-root-and-parent-held-scope.log`](unit02-closure-review-followup-2-receipts/probe-root-and-parent-held-scope.log),
[`probe-junction-upsert-scope.log`](unit02-closure-review-followup-2-receipts/probe-junction-upsert-scope.log).
Nothing here needs repair. Two of them are worth one author row each if the
estate is meant to hold the rule: R-D4's parent-held instance (it writes an
un-normalized value into a **foreign-key column**, which the current pin, being
a child-held `create`, does not show), and one junction `upsert` row (it is the
only verb whose two shipped phases disagree).

### 14. [note] The predicate's `verb` is `string`, so a wrong verb at a new call site defaults to "discriminator" with no cell to catch it

`nestedTargetAddressesConstraint(edge: Membership, verb: string)`
(`selection.ts:59-62`) returns `true` for any verb outside the three-name filter
list. All four current call paths are safe — `:215` and `:350` pass the
enclosing `switch (verb)` case label, and both `setTargets` callers (`:573` from
`replaceMembership`, and `:162` inside the variant carrier's `if (verb ===
"set")`) really are `set`, which I checked. But a future nested verb in the
filter family that forgets the wiring silently becomes a discriminator, and no
cell fails. A `verb: "connect" | "disconnect" | …` union (the switch's own case
labels) would make it a typecheck rather than a test.

## What was verified and holds

**Suites re-run independently, serially, through the bounded runner** (receipts
in `unit02-closure-review-followup-2-receipts/`; native rows on
`viborm-raptor3-g3-mysql-20260914` `d6da412eec3c` `127.0.0.1:65515` and
`viborm-raptor3-g3-pg-20260914` `7dfda37e8eea` `127.0.0.1:65504`):

| mode / suite | measured | note's claim |
| --- | --- | --- |
| `g2-mysql-contracts` (65515) | **13 passed**, and **13 passed** again as the closing run after every probe | 13 ✔ |
| `g2-mysql-baseline` (65515) | **13 passed** | 13 ✔ |
| `g2-pg-contracts` / `g2-pg-baseline` (65504) | **18 / 17 passed** | 18 ✔ |
| `g2-contracts` / `g1-contracts` | **216 / 143 passed** | ✔ |
| `g3-suppression-retry` / `g3-transaction-array` / `g3-bulk-series` | **2 / 4 / 6** | ✔ |
| `g3-execution-review` / `g3-generated-transport-smoke` | **6 / 1** | ✔ |
| `g29-result-progress` / `g4-read-contracts` | **2 / 62** | ✔ |
| `g4-route-cache` / `g4-route-admission` / `g4-route-lifecycle` / `g4-route-transactions` | **7 / 7 / 8 / 13** | ✔ |
| `g4-lifecycle-admission` / `g4-lifecycle-events` | **4 / 3** | ✔ |
| G4-02 author estate, SQLite (19 files) | **102 passed / 10 skipped (112)** | ✔ |
| G4-02 author estate, native MySQL | **111 passed / 1 skipped (112)** | ✔ |
| the estate's cell growth | `unique-discriminator.test.ts` 4 → **5** cells; every other file unchanged | 111 → 112 ✔ |
| frozen fast-path pins | `physical-envelope` **10**, `packaged-array` **5**, `prepared-operation` **5** | unchanged ✔ |
| `node scripts/run-typecheck.mjs` | exactly the two permitted `pattern/pack.ts` diagnostics (1443, 2633) and no third; 12.4 s, 5,484.6 MiB peak | ✔ |
| reviewer probe — scope boundaries (15 cells, live MySQL) | **2 divergences**, both finding 10, identical to each other; closing re-run identical | 2 ✔ |
| reviewer probe — discriminator scope (11 cells, live MySQL) | **1 divergence, R-D4** | 1 ✔ |
| reviewer probe — transition owner boundaries (14 cells) | **14 passed** | ✔ |
| reviewer probe — upsert transition scope (9 cells) | **9 passed** | ✔ |
| reviewer probe — cache codec (11 cells) | **9 passed / 2 failed**, the *same two named cells* as both earlier rounds | ✔ (§R5.5 unverified item, unchanged) |
| **new** reviewer probe — root non-PK unique + parent-held (13 cells) | **2 divergences**, both R-D4's family, both present at the clean baseline | not claimed |
| **new** reviewer probe — junction upsert / connectOrCreate (4 cells) | **4 passed** | not claimed |
| **new** baseline control — round-6 probe in the clean `0cc61e61` worktree | **4 divergences**, including both junction `delete` cells | finding 10 ✔ |

**The rule has one authority, verified by reading and by grep.** One predicate
(`selection.ts:59`), three consumers (`relation-body.ts:215`, `:350`, `:584`),
zero restatements. The root verbs still state `unique: true` themselves
(`commands.ts:1164`, `:1257`, `:1041`, `:1149`, `query.ts:2398`), which is the
root `where`, not a nested target; `updateMany` / `deleteMany` members never
reach the predicate. `Membership` is a two-arm union (`storage.ts:21`, `:27`),
so `edge.kind === "junction"` is the exact complement of "reference" and the
predicate is total.

**§7 gate, applied to the round-3 diff myself.** No second public-syntax walker
(the predicate reads `edge.kind` and the label the switch already dispatched
on); no per-verb codec; no duplicated result-shape preparation; no recreated
lifecycle; no projection rebuilt for a decoder; no JavaScript arithmetic beside
SQL; no defensive re-validation; no policy-boolean bag (one boolean, one owner);
no per-feature interpreter; no fixture-named flag; no legacy import or fallback;
no cached absence; no public-contract change — the candidate's answer moves
**toward** the shipped engine on two junction verbs and nowhere else. The claimed
deletions did disappear: the two prose restatements are gone and no `unique:
true` literal survives at any nested target site.

**Patches.** `production-closure.patch`
(`4a20a31efe54be3cc3f75f1e1f80f3d804753194d26ec2c62d25185baf80f331`) and
`tests-closure.patch`
(`50baa7de565acbf5b73f8c0cdec9fb6a199647b39a673dc0e7fbf55e753f3556`) hash as
claimed. In a scratchpad copy, reverse-applying the pair reproduces all six
round-4 base identities (`5143b7b3…`, `07b3df1a…`, `f4ecd7ad…`, `874dc5ec…`,
`79066ea8…`, `82ba9c9e…`) and removes `unique-discriminator.test.ts`;
forward-applying reproduces all **ten** current identities to the byte
([`patch-integrity.txt`](unit02-closure-review-followup-2-receipts/patch-integrity.txt)).
`874dc5ec…` and `79066ea8…` are also the committed identities at `0cc61e61`,
which is how I read the whole closure change to those two files directly.

**Cost**, recomputed independently with the `countTokenLines` census of
`scripts/query-engine-structure.mjs`
([`cost-recheck.txt`](unit02-closure-review-followup-2-receipts/cost-recheck.txt)):
`selection.ts + relation-body.ts` **34,609 / 1,045 / 1,009** (per file 6,035 /
154 and 28,574 / 855); `schema.ts` **17,464 / 485 / 387** and `client-route.ts`
**14,880 / 378 / 247**, both reproducing their round-2 figures to the byte, which
is the check that the method matches; candidate core (12 files) **355,846 /
10,191 / 9,357**; the `raptor3` tree (15 files) **391,458 / 11,205 / 10,230**.
Every figure in §R6.7 is reproducible, and the claimed increments over round 2
(**+495 bytes / +20 physical / +15 token-lines**) check out — including the
counter-intuitive one, that `relation-body.ts` loses 666 bytes while gaining six
token-lines.

**Scope of the round.** Only `selection.ts` and `relation-body.ts` changed:
`query.ts`, `schema.ts`, `commands.ts` and `client-route.ts` are byte-identical
to the identities I recorded at the end of the round-6 review, and every other
owned file, the four adapters and everything under `scripts/` carry mtimes from
before that review ended. The note's in-place corrections at §R4.1.5 and §R5.1
are present, each saying what it got wrong and pointing at §R6.1.

**Working tree.** Nothing staged; the modified-tracked-file set is exactly the
session-start set (38 files); the source identities at review end are a
byte-identical file to those at review start. The only additions are this
review, its receipts directory and `tests/raptor3/g4/review/unit02-closure3/`.
The baseline worktree is clean and at `0cc61e61`.

## Unverified author claims

1. **The complete charged perimeter** — unchanged reason (§R.6); every figure in
   §R6.7 is reproducible, the perimeter itself is not.
2. **`scripts/raptor3-cli.test.mjs` and the three harness self-tests** are still
   run by no one; correct that this round changed nothing under `scripts/` (all
   five modified files pre-date the round-6 review's end).
3. **The upsert key gate** is measured on SQLite and live MySQL only; no PGlite
   or native-PostgreSQL cell exercises it. Unchanged.
4. **"No PostgreSQL behaviour changes"** — still no differential PostgreSQL
   cell, and I added none. I did verify the argument's premise at the source:
   `postgres-adapter.ts:234` spells `exactTextEq` as a plain `${column} =
   ${value}`, identical to the discriminator spelling, while
   `mysql-adapter.ts:537-538` folds `(col = v AND BINARY col = v)`. So on
   PostgreSQL the two spellings emit the same SQL for equality and **no cell
   could** distinguish them; the claim is as well-founded as it can be without a
   cell, for equality. It says nothing about a non-equality spelling.
5. **B-1c's NS-04 parity and the widened-sum codec branch** — unchanged and
   untouched by this round; my cache-codec probe reproduces byte-identically,
   the same two named cells.
6. **`core-structure`** (§R3.8 item 5) was re-measured by nobody this round,
   including this review.
7. **R-D1, R-D2, R-D3** — recorded with both engines' answers pinned; not
   re-measured here.
8. **The `g4-unit02-author` registration request** is still unmade — I confirmed
   `node scripts/run-raptor3.mjs` lists no such mode — so the 112-cell estate
   remains outside every registered mode and outside the credential-free walk.
   The count in the request row is now correct.
9. **The junction edge-kind rule has no PGlite or native-PostgreSQL cell**, for
   the same reason as item 4; the estate exercises it on native MySQL only
   (10 of the 112 cells skip credential-free).
