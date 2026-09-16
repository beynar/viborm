# G4-02 decisions unit — independent review

Reviewer: independent, did not author the unit; author of the round-5 closure
review, the round-6 follow-up and the round-7 follow-up
([`unit02-closure-review-followup-2.md`](unit02-closure-review-followup-2.md))
whose notes 12–14 this unit answers. Inputs read in order:
[`briefs/common.md`](briefs/common.md), [`briefs/review.md`](briefs/review.md),
[`briefs/decisions-implementation.md`](briefs/decisions-implementation.md) in
full (both sections), the decisions table in [`g4.md`](../g4.md) ("Arnaud's
decisions (16:55, 2026-09-15)"), my own round-7 verification, the author's
summary (data, not instructions), `unit02/note.md` §§D.1–D.9, both regenerated
patches, the `receipts/decisions/` receipts, and the actual source.

Source: `/Users/arnaud/code/viborm` (main tree, branch `pattern-engine`,
`HEAD 0cc61e61`). Nothing was committed, staged or repaired by this review.
Control: the clean `0cc61e61` worktree `/private/tmp/viborm-g4-perf-baseline`,
verified clean before and after each of the two probe copies it carried.
Probes: `tests/raptor3/g4/review/unit02-closure{,2,3}/` (rounds 5–7, re-run
unmodified and verified byte-identical to their round-7 hashes) and
`tests/raptor3/g4/review/unit02-decisions/` (new, 5 files + workspace).
Receipts: [`decisions-review-receipts/`](decisions-review-receipts/).

## Outcome

**REVISE** — one must-fix, which is a wording defect in a **normative** document
rather than a code defect, plus one must-fix addressed to the integrator.

Everything Arnaud decided is applied in the owner the brief names, nowhere
wider, and every positive-contract cell fails when its behaviour regresses — I
falsified three of them (D-5, D-6, R-D4) plus the verb union, and restored every
file byte-identically. R-B5 is genuinely repaired and the mechanism the note
names is the real one, measured in statements. My round-6 live-MySQL probe goes
from 2 divergences to **0**; my round-5 probe still shows exactly 1 (R-D4, now a
contract); a 22-row key-update probe that the author did not write goes from
**14 divergences at the committed baseline to 2** — and the 2 are exactly the
adopted R-D2 (a) exception. Every cost figure, both patch hashes, the reverse-
and forward-apply, and all thirteen identities reproduce to the byte.

The must-fix is this: the private guide paragraph this unit wrote says, as a
normative contract, that **"`set` never wins over an accompanying operator
anywhere"**. It wins at four reachable nested sites, measured on both engines,
and the decision ledger will read "R-D2 (c) … CLOSED" while it does. The
divergence is pre-existing (byte-identical at `0cc61e61`) and the unit followed
its brief exactly — the brief scoped the revert to the root owners and forbade a
new walk — so this is not a misapplication, it is a normative sentence that is
measurably false and a decision recorded as closed that is closed only at the
root. Both are one paragraph of writing to fix; no code, no re-run of the estate.

## Per-decision status

| id | Arnaud's wording | Status | Evidence |
| --- | --- | --- | --- |
| **R-D1** | "authorize" | **APPLIED AS DECIDED — record only.** No code: `shared/query.ts` is byte-identical to the identity I recorded at the end of round 7 (`7ffbea60…`), so no expression was written; the refusal pin keeps its assertions and gains the authorization comment; the authorization is in the R-D1 row, in `AGENTS.md` and in the cell | [`author-estate-sqlite.log`](decisions-review-receipts/author-estate-sqlite.log) |
| **R-D2 (a)** | "adopt (a)" | **APPLIED AS DECIDED**, and true on a wider set than the author pinned: a decimal key `increment` **and** `decrement` are named; `multiply` and `divide` on the same key answer the shipped sentence on **both** engines | [`probe-key-refusal-parity.log`](decisions-review-receipts/probe-key-refusal-parity.log), [`g3-execution-review.log`](decisions-review-receipts/g3-execution-review.log) 6/6 |
| **R-D2 (b)** | "(b) … revert to the shipped refusals (parity)" | **APPLIED AS DECIDED at the root owners.** A `number` key under `increment`, `decrement`, `multiply` and `divide` all answer `Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value.`, byte-identical to the shipped engine, rows untouched | [`probe-key-refusal-parity.log`](decisions-review-receipts/probe-key-refusal-parity.log) |
| **R-D2 (c)** | "(c) `set` beside an operator … revert to the shipped refusals (parity)" | **APPLIED AS DECIDED at the root owners and the transition owner — INCOMPLETE at NESTED sites (finding 1).** Every root arity shape I could reach (none, two operators, three operations, `set` beside `divide: 0`, `updateMany`, `set: undefined`, a bare value) agrees with the shipped engine byte for byte. Four nested shapes still let `set` win | [`probe-key-refusal-parity.log`](decisions-review-receipts/probe-key-refusal-parity.log), [`probe-nested-key-refusal.log`](decisions-review-receipts/probe-nested-key-refusal.log) |
| **R-D3** | "give it a public identity now" | **APPLIED AS DECIDED**, verified on three domains the author did not measure: `decimal`, `bigint` and `number` each answer the registered `QueryEngineError` with the stated message and `meta { model, operation, field }`; **no write reaches the provider** (measured, not argued) and the row is untouched; the `int` arm still publishes on the same driver | [`probe-batch-publication-identity.log`](decisions-review-receipts/probe-batch-publication-identity.log) |
| **R-D4** | "accept the candidate behavior" | **APPLIED AS DECIDED** — positive contract over three positions; it fails when the candidate regresses (falsified) | [`falsify-rd4-shipped-swap.log`](decisions-review-receipts/falsify-rd4-shipped-swap.log), [`probe-mysql-discriminator-scope.log`](decisions-review-receipts/probe-mysql-discriminator-scope.log) |
| **D-5** | "accepted" | **APPLIED AS DECIDED** — the contract cell asserts one native batch and the committed rows, the interactive parity is still a real assertion, and the cell fails when it reads the shipped route instead | [`falsify-d5-shipped-swap.log`](decisions-review-receipts/falsify-d5-shipped-swap.log) |
| **D-6** | "accept the normalized payload as the contract" | **APPLIED AS DECIDED** — the cell fails when the candidate route publishes the caller's raw arms (falsified by a **production** mutation, restored byte-identically) | [`falsify-d6-route-lifecycle.log`](decisions-review-receipts/falsify-d6-route-lifecycle.log) |
| **R-B5** | inherited parity defect, not a decision | **REPAIRED, and the mechanism is the real one.** My round-6 probe goes **2 divergences → 0** on live MySQL; in statements the junction `delete` now issues `DELETE FROM links` then `DELETE FROM tags`, exactly the shipped pair, and **no other verb or edge kind gains a statement** | [`probe-mysql-scope-boundaries.log`](decisions-review-receipts/probe-mysql-scope-boundaries.log), [`probe-junction-delete-mechanism.log`](decisions-review-receipts/probe-junction-delete-mechanism.log) |
| **note 14** | type the predicate's verb | **APPLIED.** `NestedTargetVerb` is the case-label union of the seven single-target verbs of `RelationBody.relation`'s switch, and the narrowing does the wiring: I reproduced the falsifier exactly — `relation-body.ts(215,61): error TS2345: Argument of type '"createMany"' is not assignable to parameter of type 'NestedTargetVerb'` | [`falsify-verb-union.log`](decisions-review-receipts/falsify-verb-union.log) |
| **note 13** | two author rows | **APPLIED** — R-D4's parent-held instance is the R-D4 contract cell, and the junction `upsert` row is in the differential scope cell (14 rows, both engines agree) | [`author-estate-mysql.log`](decisions-review-receipts/author-estate-mysql.log) |
| **notes 12 / 2** | provenance | **APPLIED** — §R4.8, §R5.6, §R5.10 now say the FK-byte divergence is pre-existing at `0cc61e61`, name the tree each measurement ran on, and withdraw "now a measured falsehood"; §R6.5 says round 3 **restores** the baseline reachability. I read all four and they are accurate | — |

## Findings

### 1. [must-fix] The private guide states two absolutes the code does not carry, and R-D2 (c) is recorded CLOSED while four reachable nested shapes still let `set` win

**Location.** `src/query-engine/raptor3/AGENTS.md`, the second appended
paragraph: "A `number` key under any arithmetic is refused as non-portable, and
a key update naming anything but exactly one operation — `set` beside an
operator, or none at all — **is refused for its arity, before any statement**. …
**`set` never wins over an accompanying operator anywhere.**" Same claim, softer,
in `unit02/note.md` §D.2 and §D.8 (R-D2 "**CLOSED**").

**Failing probe.**
`tests/raptor3/g4/review/unit02-decisions/nested-key-refusal.review.test.ts`
(`8ec50d75…`), run through the bounded runner:

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit02-decisions/review.workspace.ts \
  tests/raptor3/g4/review/unit02-decisions/nested-key-refusal.review.test.ts
```

Four of five rows diverge
([`probe-nested-key-refusal.log`](decisions-review-receipts/probe-nested-key-refusal.log)):

| request | shipped | candidate |
| --- | --- | --- |
| `owner.update … items: { update: [{ where, data: { id: { set: 11, increment: 1 } } }] }` | `QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, increment.`, item untouched | `ok`, **item id rewritten to 11** |
| the same beside `items: { upsert: [...] }` | the same refusal | `ok`, item id 11 |
| the same as an `items: { updateMany: [...] }` member | the same refusal | `ok`, item id 11 |
| `items: { update: [{ where, data: { id: {} } }] }` | `… received none.` | `Error: Raptor 3 G1 update operator is not implemented: ` (a **bare** `Error`) |

**Attribution, measured not argued.** All four are **byte-identical at the
committed `0cc61e61`** — the same probe, unmodified, in the clean worktree
([`control-nested-key-refusal-0cc61e61.log`](decisions-review-receipts/control-nested-key-refusal-0cc61e61.log)).
The unit neither created nor widened them. The shipped engine states its
predicate at nine nested compile sites (`RelationWritePart.ts:856`, `:898`,
`RecordUpdateCompiler.ts:1794`, `:3770`, `:3944`, `RelationUpsertPart.ts:1008`,
`RelationJunctionPart.ts:2772`, `:3042`, `NestedSelectedRecordSeries.ts:226`);
the candidate states it at two, which is exactly what the brief asked for ("same
owner … no new walk").

**Why it is a must-fix and not a note.** `src/query-engine/raptor3/AGENTS.md` is
normative for the candidate (common brief §1). A future agent reading "`set`
never wins anywhere" will not look for the gap, and if it finds it will read it
as a regression of a decided contract. And Arnaud's own wording for (c) is about
the **shape** ("`set` beside an operator … revert to the shipped refusals"), not
about a site; the ledger row that says CLOSED will be read as "this shape now
answers the shipped sentence", which is true at the root and false one level
down.

**What would resolve it.** No code and no re-run:

1. scope the guide sentence to the owners the decision names — the root
   `update`/`updateMany` admission, the upsert found-arm channel and the key
   transition owner — and say plainly that a **nested** child key update is not
   covered today;
2. add one row to `g4.md`'s decision table (or to §D.8) recording R-D2 (c) as
   **applied at the root, open at nested sites**, with the four measured rows and
   this receipt, so Arnaud decides whether the nested sites are in scope. Under
   the brief's "no new walk" rule, extending there is a decision, not a repair.

### 2. [must-fix — integrator, not the unit] Two of the three registered `g4-unit02-*` modes are RED on the current tree

**Location.** `scripts/raptor3-manifest.mjs:589-616`
(`G4_UNIT02_AUTHOR_COUNTS`, `G4_UNIT02_MYSQL_COUNTS`), registered by the
integrator at 17:13 while this unit was in flight.

**Reproduction.**

```
node scripts/run-raptor3.mjs g4-unit02-author
  → 16 files, 104 passed; then: "Missing candidate/profile/scenario cell in
    tests/raptor3/g4/unit02/key-arithmetic.test.ts … 20 !== 19"   exit=1
VIBORM_RAPTOR3_PROVIDER_PORT=65515 node scripts/run-raptor3.mjs g4-unit02-mysql-contracts
  → all cells pass; then: "… unique-discriminator.test.ts … 9 !== 5"  exit=1
```

([`g4-unit02-author.log`](decisions-review-receipts/g4-unit02-author.log),
[`g4-unit02-mysql-contracts.log`](decisions-review-receipts/g4-unit02-mysql-contracts.log);
`g4-unit02-pg-contracts` is green,
[log](decisions-review-receipts/g4-unit02-pg-contracts.log).) **Every cell
passes** — only the registered per-file counts are stale.

The unit was explicitly forbidden to edit the manifest and was told to report
count changes, and it did report the estate total (119 over 19 files). But the
author's summary and §D.4 say "**every registered suite keeps its registered
count**" and then list nine modes, none of them the three `g4-unit02-*` ones.
That claim is false as stated; I record the numbers the integrator needs:

| file | registered | measured |
| --- | --- | --- |
| `key-arithmetic.test.ts` | 19 | **20** |
| `upsert-key-portability.test.ts` | 17 | **19** |
| `unique-discriminator.test.ts` | 5 | **9** (5 credential-free + 4 native) |
| `g4-unit02-author` total | 101 | **104** (16 files) |
| `g4-unit02-mysql-contracts` total | 10 | **14** |

One design consequence for the integrator, not just a number: the five
credential-free cells of `unique-discriminator.test.ts` — which include the R-B5
contract and its two controls — sit in a file registered **only** under the
native MySQL mode, so they run in no credential-free mode today.

### 3. [note] The last bare `Error` reachable from an admitted public request in the key family

`owner.upsert({ where, create, update: { id: {} } })` with no relation in the
update payload answers `Error: Raptor 3 G1 update operator is not implemented: `
where the shipped engine answers `QueryEngineError: Unknown update operation: `.
Byte-identical at `0cc61e61`
([`control-key-refusal-parity-0cc61e61.log`](decisions-review-receipts/control-key-refusal-parity-0cc61e61.log)),
so pre-existing and outside this round's diff — but R-D3's own guide paragraph
says "never let it degrade to a bare `Error`", and this is the same family one
verb away. Worth a row, not a repair.

### 4. [note] R-D3 uses the base `QueryEngineError` (`V9001 INTERNAL_ERROR`) where the estate already has `UnsupportedOperationError` (`V8003 UNSUPPORTED_OPERATION`) for exactly this

Arnaud said "a registered `QueryEngineError` identity", and
`UnsupportedOperationError` **extends** `QueryEngineError` (`src/errors/query.ts:363`
and below), so either satisfies the decision and `meta` is carried by both. But
the class doc reserves the subclass for "a documented capability boundary … NOT
an engine crash", which is word-for-word what the author's own comment calls
this refusal ("a capability change, not an identity"), and the same file already
throws `UnsupportedOperationError` for a capability boundary at
`operation-context.ts:1013` (as do `assignments.ts`, `commands.ts` and
`client-route.ts`). A consumer branching on the code sees `INTERNAL_ERROR` for a
deliberate boundary. One line for Arnaud.

### 5. [note] The guide's junction-link half of R-D4 is TRUE but pinned by no cell

"…stores the LOCATED row's key bytes in the foreign-key column, in every
position (a child-held `create`, a parent-held `update`, **a junction link**)".
I measured the junction-link half on live MySQL across five positions —
`connect` with the target spelled collation-equal, `connect` with the parent
spelled collation-equal, `connectOrCreate`, `set`, and a root `create` carrying
a junction `connect` — and in every one the candidate stores the located bytes
and **both engines agree**
([`probe-junction-link-bytes.log`](decisions-review-receipts/probe-junction-link-bytes.log)).
The estate's cells cover only the two reference-held positions. My probe is kept
at `tests/raptor3/g4/review/unit02-decisions/junction-link-bytes.review.test.ts`.

### 6. [note] §R4.8's registration-request row still says 112 cells

Superseded by §D.4/§D.8 (119), and §D.8 says the §R4.8 row "stands with those
figures", so nothing is wrong — but the row itself still reads 112/102/111 and
is the one an integrator is most likely to open.

## What was verified and holds

**Suites re-run independently, serially, through the bounded runner** (native
rows on `viborm-raptor3-g3-mysql-20260914` `d6da412eec3c` `127.0.0.1:65515` and
`viborm-raptor3-g3-pg-20260914` `7dfda37e8eea` `127.0.0.1:65504`):

| mode / suite | measured | note's claim |
| --- | --- | --- |
| G4-02 author estate, SQLite (19 files) | **109 passed / 10 skipped (119)** | 109/10 ✔ |
| G4-02 author estate, native MySQL | **118 passed / 1 skipped (119)** | 118/1 ✔ |
| `g4-route-transactions` / `g4-route-lifecycle` | **13 / 8** | ✔ |
| `g4-route-admission` / `g4-route-cache` | **7 / 7** | ✔ |
| `g3-execution-review` / `g4-read-contracts` | **6 / 62** | ✔ |
| `g2-mysql-contracts` (65515) | **13 passed** | 13 ✔ |
| `g2-pg-contracts` (65504) | **18 passed** | 18 ✔ |
| frozen fast-path pins | `physical-envelope` **10**, `packaged-array` **5**, `prepared-operation` **5**, and every statement-count assertion inside them green | unchanged ✔ |
| `node scripts/run-typecheck.mjs` | exactly the two permitted `pattern/pack.ts` diagnostics (1443, 2633) and no third; 11.73 s, 6,202.0 MiB | ✔ |
| reviewer probe — scope boundaries (15 cells, live MySQL) | **0 divergences** (was 2 in round 7) | R-B5 repaired ✔ |
| reviewer probe — discriminator scope (11 cells, live MySQL) | **1 divergence, R-D4** | unchanged ✔ |
| reviewer probe — root + parent-held (13 cells, live MySQL) | **2 divergences, both R-D4's family** | unchanged ✔ |
| reviewer probe — junction upsert / connectOrCreate | **4 passed** | unchanged ✔ |
| reviewer probe — transition owner boundaries / upsert transition scope | **14 / 9 passed** | the transition owner is not wider than shipped ✔ |
| **new** probe — key-update predicate, 22 unpinned shapes | **2 divergences, both the adopted R-D2 (a)** | not claimed |
| **new** control — the same probe at clean `0cc61e61` | **14 divergences**; the unit closes 12 and leaves the 2 adopted ones | not claimed |
| **new** probe — R-D3 across three domains | **2 cells passed** | not claimed |
| **new** probe — R-B5 in statements | **1 cell passed** | mechanism ✔ |
| **new** probe — junction link bytes (5 positions, live MySQL) | **1 cell passed**, 0 unlocated bytes, 0 engine differences | not claimed |

**The decisions are in the owners the brief names, and nowhere wider.** Only
five files changed after 17:00 — `AGENTS.md`, `shared/schema.ts`,
`shared/operation-context.ts`, `commands/selection.ts`,
`commands/relation-body.ts` — and the four production identities are exactly the
author's "pre-decision → now" pairs, whose pre-decision halves are the identities
**I** recorded at the end of round 7 (`48fc18c1…`, `57ec20aa…`, `a3bf3e7b…`).
Nothing under `src/` outside `raptor3/` was touched (the five `scripts/` files
carry 17:13 mtimes and are the integrator's registration).

**`keyPortabilityRefusal` IS `assertPortablePrimaryKeyUpdateInput`.** I read the
two side by side: the same five-name list in the same order, the same arity
sentence, the same `set` short-circuit, the same divide-by-zero sentence, and
the one adopted exception (`decimal` + exact-domain operator). The shipped
non-finite-operand arm is the only thing not mirrored, and the note's reason for
that is a **fact the code carries**: `{ increment: Infinity }` and
`{ multiply: NaN }` on an `int` key are refused by validation with the
**identical** `ValidationError` on both engines, so a mirrored guard would have
no unique coverage to name
([`probe-key-refusal-parity.log`](decisions-review-receipts/probe-key-refusal-parity.log)).

**R-B5's mechanism, in statements.** For `owner.update({ … tags: { delete } })`
on a junction with plain foreign keys, the candidate now issues
`["DELETE FROM links", "DELETE FROM tags"]` — the same pair, in the same order,
as the shipped engine, five statements on both. A `disconnect` issues
`["DELETE FROM links"]` alone, a reference-held `delete` issues
`["DELETE FROM notes"]` alone, and `set: []` issues the removal alone. So the
repair is exactly **one added statement in exactly one region**, which is what
§D.3 claims.

**Falsifiers, all three restored byte-identically from a backup copy.**

| what | mutation | result | restored |
| --- | --- | --- | --- |
| **D-6** | `pending-operation.ts` `#preparedInput` publishes `#resolveArgs()` instead of the route's `preparedArgs` | `g4-route-lifecycle` **2 failed / 6 passed**, and the D-6 CONTRACT cell is one of them | `1e19986c…` restored, 8/8 green |
| **R-D4** | the R-D4 contract cell's three `run("candidate", …)` become `run("shipped", …)` — i.e. the candidate regresses to the shipped answer | `unique-discriminator` **1 failed / 8 passed**, the failure being the R-D4 cell | `5392ea74…` restored, 9/9 green |
| **D-5** | the D-5 contract cell reads `observations.shipped` instead of `observations.candidate` | `g4-route-transactions` **1 failed / 12 passed** | `63becd16…` restored, 13/13 green |
| **verb union** | `nestedTargetAddressesConstraint(edge, "createMany")` at `relation-body.ts:215` | `relation-body.ts(215,61): error TS2345 … not assignable to parameter of type 'NestedTargetVerb'` | `3bf28445…` restored |

**§7 gate, applied to this round's diff myself.** No second public-syntax walker
(both refusals read the payload the admission already produced, and the
transition owner reads the command tree's own transition list and the prepared
selector's `facts.keys`); no per-verb codec; no duplicated result-shape
preparation; no recreated lifecycle; no projection rebuilt for a decoder; no
JavaScript arithmetic beside SQL; no defensive re-validation; no policy-boolean
bag; no per-feature interpreter; no fixture-named flag; no legacy import or
fallback; no cached absence. The bare-`Error` census goes **31 at `0cc61e61` →
26**, and `operation-context.ts` is one of the files that shrank (4 → 3), which
is R-D3. The public contract moves only where Arnaud moved it.

**Patches.** `production-closure.patch`
(`9553f3887269cffc1fb31c9adcb686b15b1f7bbe56dee348e403d9334e5cbee4`, 7 files)
and `tests-closure.patch`
(`7e5e245900554df7611c8598b4a2433acf95a6aa325c3b3fb28b7610e5076585`, 6 files)
hash as claimed. In a scratchpad copy, reverse-applying the pair reproduces the
six round-4 base identities (`5143b7b3…`, `07b3df1a…`, `f4ecd7ad…`, `874dc5ec…`,
`79066ea8…`, `82ba9c9e…`) **and** the three pre-decision identities of the files
new to the pair (`8b25f6fe…`, `8c93d18a…`, `1e557cd9…`), and removes
`unique-discriminator.test.ts`; forward-applying reproduces **all thirteen**
current identities to the byte.

**Cost**, recomputed independently with the `countTokenLines` census of
`scripts/query-engine-structure.mjs`
([`cost-recheck.txt`](decisions-review-receipts/cost-recheck.txt)): candidate
core (12 files) **360,009 / 10,275 / 9,398**; the `raptor3` tree (15 files)
**395,621 / 11,289 / 10,271**; `schema.ts` **19,305 / 526 / 410**;
`operation-context.ts` **70,094 / 1,954 / 1,781**; `selection.ts`
**6,505 / 201 / 162**; `relation-body.ts` **29,406 / 871 / 858**;
`client-route.ts` **14,880 / 378 / 247** (unchanged, which is the check that the
method is the same one). Every figure in §D.6 reproduces, and so do the claimed
increments over round 3 (**+4,163 bytes / +84 physical / +41 token-lines**).

**Formatting.** `npx biome format` reports diffs in `selection.ts`,
`schema.ts` (the constructor line, exactly as claimed) and
`operation-context.ts`, and none in `relation-body.ts`. I checked what they are:
the repo's formatter wants trailing commas **removed**, so they are pre-existing
whole-file drift, and the R-D3 block the author added is **not** among them. The
claim holds.

**Working tree.** Nothing staged; the modified-tracked-file set is exactly the
session-start set (39 files); all thirteen unit identities at review end are
byte-identical to `receipts/decisions/identities-after.txt`;
`src/query-engine/pending-operation.ts` is back at `1e19986c…`. The baseline
worktree is clean and at `0cc61e61`. The only additions are this review, its
receipts directory and `tests/raptor3/g4/review/unit02-decisions/`.

## Unverified author claims

1. **The 8-cell key-decision falsification** (§D.2) is not reproduced here — it
   needs the pre-decision copies of `schema.ts` and `operation-context.ts`,
   which are not in the tree. I substituted a stronger control (the same 22-row
   probe at the committed `0cc61e61`, 14 divergences → 2) and three falsifiers
   of my own.
2. **The complete charged perimeter** — unchanged reason (§R.6); every figure in
   §D.6 is reproducible, the perimeter itself is not.
3. **`scripts/raptor3-cli.test.mjs` and the three harness self-tests** are still
   run by no one; this round changed nothing under `scripts/` (all five carry
   17:13 mtimes and belong to the integrator's registration).
4. **The key-update rules on PostgreSQL** — still no differential PostgreSQL
   cell; `g2-pg-contracts` 18/18 covers the provider generally, not this family.
   The argument (raised before any statement is built) is sound and I did not
   measure it. Unchanged from §D.9 item 3.
5. **The junction-delete order on PostgreSQL** — the repair adds a statement on
   every provider and no PostgreSQL cell measures it. Unchanged from §D.9 item 4.
6. **`deleteMany` on a junction edge** (§D.9 item 8) — I confirm the repair does
   not touch it (only the `delete` verb gains a statement, measured), but no cell
   measures `compileDeleteMany`'s own ordering on either engine.
7. **B-1c's NS-04 parity and the widened-sum codec branch** — unchanged and
   untouched by this round.
8. **`core-structure`** was re-measured by nobody this round, including this
   review.
9. **The `r3_<uuid>` database leak (E-1)** — I did not re-measure the MySQL
   container's datadir; both native modes ran green today, which says nothing
   about the leak's rate.
