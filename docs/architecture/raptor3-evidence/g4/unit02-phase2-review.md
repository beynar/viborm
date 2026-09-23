# G4-02 phase 2 (`shared/query.ts` and the physical envelope) — independent review

Reviewer: independent (did not author the unit). Source: main tree
`/Users/arnaud/code/viborm`, nothing applied.
Unit note: [`unit02/note.md`](unit02/note.md) (phase-2 part, §P.0–§P.14).
Patches: [`unit02/production-phase2.patch`](unit02/production-phase2.patch)
(`17e8632626da4aefc10e468a2576eecc565794f2fc7840a647d26c72db935dcc`),
[`unit02/tests-phase2.patch`](unit02/tests-phase2.patch)
(`496a9b30d981d8d0ef9e7c05f167f6cfc256a1768d6db89a8938bb4564c1b273`).
Review probes: `tests/raptor3/g4/review/unit02-phase2/` (10 files, 56 cells).
Receipts: [`unit02-phase2-review-receipts/`](unit02-phase2-review-receipts/).

## Outcome

**REVISE.**

The engineering this unit claims is, in the main, real and reproduces: I
verified the arithmetic assignment language against the shipped engine over
seventeen payloads, the folded root `create` over the generated surface the
phase-1 note gave as the reason not to fold, the tagged-quantifier rule over a
twenty-cell matrix, the counted-slot owner, the recursive TEXT path carrier
(cycle stop, overlapping occurrences, an identity needing JSON escaping, exact
`bigint`), the statement-atomic `NotFoundError` meta on two transports, the
`operationRegion` grant's behaviour **on failure** (which no cell pinned), and
both witness-defect diagnoses. Every cost figure reproduces to the byte, the
production patch reverse-applies to the phase-1 accepted identities exactly,
and the typecheck is the two permitted diagnostics.

What blocks acceptance is the record, not the machinery. One scope item is
reported **done** that is half-done, and the half that is missing is a refusal
the candidate raises where the shipped engine answers — on MySQL, the project's
only non-RETURNING provider. Two regressions the brief's revision 5 assigns to
this author by name do not appear in the note at all. And two of the ledger's
own evidence claims do not survive re-measurement.

## What I ran

Serial, through the bounded runner, on the identities in
[`identities.txt`](unit02-phase2-review-receipts/identities.txt).

| Suite / mode | Result | Author's figure | Receipt |
| --- | --- | --- | --- |
| G4-02 author checks (14 files) | 60 passed / 1 skipped | 60 / 1 skipped | `unit02-author.log` |
| `g4-read-contracts` | 60 passed / **2 failed** (SC-13, RF-16) | same | `g4-read-contracts.log` |
| `g4-unit01-review` (29 files) | **200 passed** | 200 | `g4-unit01-review.log` |
| `g4-unit01-author` (10 files) | **83 passed** | 83 | `g4-unit01-author.log` |
| phase-1 review probes (`review/unit02/`) | 31 passed / 3 failed (red by construction) | same | `review-unit02-phase1probes.log` |
| `transitions` (33 files) | **434 passed** | 434 | `transitions.log` |
| `post-prep` (9 files, incl. the edited G2.9 specimen) | **48 passed** | 48 | `post-prep.log` |
| `core-structure` (10 files) | 74 passed / **12 failed** | 74 / 12 | `core-structure.log` |
| `g4-route-transactions` | 9 passed / **2 failed** (LX-04, LX-14) | same | `g4-route-transactions.log` |
| `g4-lifecycle-events` / `-admission` | 1/2 and 3/1 | same | `g4-lifecycle-*.log` |
| `g4-route-admission` / `-cache` / `-lifecycle` | 4/1, 6, 7 | same | `g4-route-*.log` |
| `g4-generation-selftests` | 6 passed | 6 | `g4-generation-selftests.log` |
| `g29-result-progress` | 2 passed | 2 | `g29-result-progress.log` |
| `g3-suppression-retry` / `-bulk-series` / `-transaction-array` | 2 / 6 / 4 passed | same | `g3-*.log` |
| **`g2-mysql-contracts` (native :65515)** | 10 passed / **3 failed** | *not in the note* | `g2-mysql-contracts.log` |
| `g2-pg-contracts` (native :65504) | **18 passed** | — | `g2-pg-contracts.log` |
| `g4-read-envelope-pg-contracts` (:65504) | **5 passed** | 5 | `g4-read-envelope-pg.log` |
| `g4-read-envelope-mysql-contracts` (:65515) | **5 passed** | 5 | `g4-read-envelope-mysql.log` |
| `g3-scope-composition-pg` / `-mysql` | 2 / 2 passed | 2 / 2 | `g3-scope-*.log` |
| **`g3-generated-transport-smoke`** | **1 failed** | *not in the note* | `g3-transport-smoke.log` |
| `node scripts/run-typecheck.mjs` | exactly the two permitted `pattern/pack.ts` diagnostics | same | `typecheck.log` |
| review probes `unit02-phase2` (10 files) | 49 passed / **7 failed** (all EVIDENCE cells) | — | `review-probes-all.log` |

Falsification I performed myself (scratchpad copies, never `git checkout`;
SHA-256 re-verified after every restore — see `identities.txt`):

| Swap | Result | Receipt |
| --- | --- | --- |
| four phase-2 files → phase-1 content, author checks re-run | **14 failed / 46 passed / 1 skipped** (author recorded 12/45/1 over 58 cells; the estate is 61) | `phase1-author-checks.log` |
| same swap, my arithmetic + key probes | the whole assignment language is red there (`Raptor 3 G1 update operator is not implemented`) | `phase1-keyarith.log` |
| same swap, `g2-mysql-contracts` | **the same 3 cells fail** → phase 2 did not cause them | `g2-mysql-on-phase1.log` |
| reverse-apply of `production-phase2.patch` | reproduces `6f39f82a…`, `65aa6f5b…`, `12442b94…`, `546adce4…` exactly | `identities.txt` |

**Cost.** Recomputed with the census function's own definition
([`cost.mjs`](unit02-phase2-review-receipts/cost.mjs),
[`cost-recount.txt`](unit02-phase2-review-receipts/cost-recount.txt)):
four files 255,888 B / 7,276 physical / 6,687 token-lines; phase-1 baseline
236,563 / 6,864 / 6,461; core (12 files) 339,972 / 9,875 / 9,227; tree (15
files) 369,238 / 10,733 / 9,996. **Every figure in §P.10 is exact, including
the +19,325 / +412 / +226 increment.** The complete charged perimeter is
correctly reported as unverified.

## Findings

### 1. [blocking] `updateValue` refuses `multiply`/`divide`: brief item 3 is half-delivered, and the refusal diverges from the shipped engine on MySQL

`src/query-engine/raptor3/shared/query.ts:787-812` (`updateValue`), guard at
`:797`.

Brief item 3 and note §10.1 ask for one owner answering **both** lowerings —
"`adapter.set.multiply`/`divide`/`decrement` for the mutation assignment **and
`expressions.multiply`/`divide`/`subtract` for the symbolic updated-key
expression** … `OperationContext.updatedIdentity` and
`CommandExecution.requireTransitions` already call `updateValue` and need no
change once the operators exist."

What landed answers the assignment only:

```ts
if (update.kind === "list" || update.operator === "multiply" || update.operator === "divide")
  throw new QueryEngineError(
    `Raptor 3 cannot name the updated value of '…': the provider owns that operator's rounding inside its own assignment.`,
  );
```

The three callers that need the name are
`shared/operation-context.ts:1358` (`updatedIdentity`, the **non-RETURNING**
readback), `:1561` (`requireTransitions`) and `commands/execution.ts:94`.
`src/adapters/databases/mysql/mysql-adapter.ts:929` declares
`supportsReturning: false`, so this is live on a qualified provider for an
ordinary request. Measured on a non-RETURNING driver:

| request | shipped | candidate |
| --- | --- | --- |
| `update({ where: { id: 3 }, data: { id: { multiply: 2 } } })` | `{ id: 6, label: "a" }`, row written | `QueryEngineError: Raptor 3 cannot name the updated value of 'parent.id' under 'multiply'…`, **nothing written** |
| `… { id: { divide: 3 } }` | `{ id: 1, … }`, row written | same refusal |

Probe: `tests/raptor3/g4/review/unit02-phase2/key-arithmetic-parity.review.test.ts`
(first two cells), receipt `probe-keyarith.log`.

The record does not carry this. §P.12.6 item 2 lists "10.1 arithmetic
operators" as **done**; §P.12.7 falsifier 3 says the key half is "covered
**indirectly**" by the shared owner and a green transitions estate — but the
shared owner *refuses*, so there is nothing to cover; §P.14 item 2 calls the
property unverified rather than refused. The only statement of the refusal is a
JSDoc sentence whose cross-reference ("note §P.11.1") points at the section
about the two witness cells. Per `common.md` ("A new observable compatibility
choice is a decision for Arnaud: record it as a blocker in your note") this
needed to be a recorded blocker.

**Resolution.** Either name the value where it is exact (`int`/`bigint`
`multiply` through `expressions.multiply`; `divide` needs the adapter's
integer-truncation spelling, which is a named seam question, not a silent
refusal), or keep the refusal and (a) record it as a decision for Arnaud with a
registered identity, (b) correct §P.12.6 item 2, §P.12.7 falsifier 3 and §P.14
item 2, (c) fix the JSDoc cross-reference. Unrelated nit on the same statement:
`` `${update.kind === "list" ? update.operator : update.operator}` `` has two
identical branches.

### 2. [must-fix] Phase 2 makes `multiply`/`divide` reachable on primary keys, where the shipped engine refuses them by contract

`src/query-engine/raptor3/shared/query.ts:693-736` (`prepareUpdate`) has no
equivalent of the shipped `assertPortablePrimaryKeyUpdateInput`
(`src/query-engine/operations/mutation-identity.ts:191-253`). Measured on
SQLite (RETURNING), one world per case:

| request | shipped | candidate |
| --- | --- | --- |
| decimal PK `{ increment: "1.00" }` | `QueryEngineError: Arithmetic updates are not portable for decimal primary key field 'id'. Use an explicit set value.` | writes `id = 7` |
| decimal PK `{ multiply: "2.00" }` | same refusal | writes `id = 12` |
| number PK `{ multiply: 2 }` | `… not portable for number primary key field 'id' …` | writes `id = 12` |
| int PK `{ divide: 0 }` | `QueryEngineError: Cannot divide primary key field 'id' by zero.` | issues the statement, answers `QueryError: Query execution failed` |
| int PK `{ increment: 1, set: 9 }` | `QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, increment.` | writes `id = 9` |

Probe: `key-arithmetic-parity.review.test.ts` (last five cells).

Attribution, measured: the `increment` and two-operation rows are **pre-existing**
(they fail the same way on the phase-1 tree); the `multiply`/`divide` rows are
**newly reachable because phase 2 implemented the operators** — phase 1 answered
`Raptor 3 G1 update operator is not implemented`. The int-PK divide-by-zero row
went from a clean "not implemented" to a statement issued against the provider.

**Resolution.** State the shipped portability refusals once at the candidate's
admission boundary (they are the same sentences), or record the divergence as a
decision with the shapes above. Note that the unit *did* land the decimal
divide-by-zero refusal verbatim for ordinary fields — the primary-key sentence
is the neighbouring one.

### 3. [must-fix] The brief's revision-5 regressions are neither delivered nor recorded

The brief in the tree (`briefs/unit02-physical-provider.md`, "Regressions
measured against the clean baseline (revision 5, 08:05) — phase-2 author and
reviewer") assigns two items to this author:

- **`g2-mysql-contracts`**, 13/13 on clean `0cc61e61`, now 10 passed / **3
  failed** (`tests/raptor3/transitions/unique-races-live-commands.test.ts`:
  `g2-race-selected-unique-recovery`, `g2-race-unrelated-unique-refused`,
  `g2-race-wrong-insert-same-constraint`) — "Reproduce …, minimize, repair in
  the owning candidate file, and pin."
- **`g3-generated-transport-smoke`**, 1/1 on clean HEAD, now **1 failed** —
  "Record the new shape per recipe so the harness reconciliation can re-script
  it."

`note.md` contains no occurrence of `g2-mysql`, `unique-race`, or
`transport-smoke`: they are absent from §P.1, §P.12.2, §P.12.6, §P.11.5 and
§P.14. This is in contrast to CS-02/CS-03, which the author classified with a
falsification (§P.11.3) — the right treatment, simply not applied here.

I reproduced both (`g2-mysql-contracts.log`, `g3-transport-smoke.log`) and did
the attribution the note owes: with the four phase-2 files reverted to their
phase-1 accepted identities, the same three MySQL cells fail identically
(`g2-mysql-on-phase1.log`). **So phase 2 did not cause them** — but the
assignment was neither answered nor handed back with that evidence. `g2-pg-contracts`
is 18/18 on the pg container, so the family is MySQL-only.

**Resolution.** Add the measurement and the attribution to the note (or minimize
and repair, if the owning file is a candidate one), so the integrator can
reassign rather than discover it.

### 4. [must-fix] Two claims in the falsifier ledger do not survive re-measurement

- §P.12.7 row 1 cites `borrowed-envelope.test.ts` (5 cells, "incl. 'a failing
  single-statement write poisons the caller's transaction, as shipped'") as
  part of the evidence that "**failed as required on the phase-1 tree**". In the
  author's own receipt
  (`unit02/receipts/phase2/falsify/unit02-author-checks-on-phase1-tree.log`)
  those five cells are **green** on the phase-1 tree, as are
  `packaged-array.test.ts`'s five. Only
  `phase2-envelope-and-arithmetic.test.ts`'s cells are load-bearing there. The
  obligation E-a *is* exercised — by those cells — but the cited evidence is
  wrong.
- §P.12.4 records the swap as "**12 failed / 45 passed / 1 skipped**" = 58
  cells. The author-check estate is 61 cells in 14 files. Re-running the same
  swap myself gives **14 failed / 46 passed / 1 skipped**
  (`phase1-author-checks.log`): the receipt predates
  `decimal-having-operand.test.ts` (3 cells, 2 of them load-bearing), one of
  "the two author checks added at the end of the round" (§P.12.5).

**Resolution.** Re-run the falsification against the final estate and correct
row 1's evidence column. Nothing about the conclusions changes; the receipt
simply has to cover what it claims to cover.

### 5. [must-fix] The RETURNING-safety widening has no falsifier, and the note describes a mechanism that did not land

`src/query-engine/raptor3/shared/query.ts:164-169`:

```ts
export function returningSafeProjection(projection: PreparedProjection): boolean {
  return projection.fields.every(
    (field) => field.kind === "scalar" || field.kind === "distance",
  );
}
```

That is the deleted `namesRelation` kind-test, relocated into the projection
owner's module and widened by one kind. §P.4.8 and §P.9 answer 1 describe
something else: "`PreparedProjectionField` gains `returningSafe`, **stated where
the field is prepared**", and "`returningSafeProjection` **over
`PreparedProjectionField.returningSafe`**". `PreparedProjectionField`
(`query.ts:118-146`) carries no such field — grep for `returningSafe` in
`query.ts` returns exactly one line, the function above.

The widened arm is also unwitnessed. `grep -rn "_distance" tests/raptor3/g4/unit02/`
is empty; the only `_distance` in the whole G4 witness estate is an `orderBy`
(`read-recursive-fit`/`read-ordering.test.ts:192`). §P.5 row E-d states the
falsifier "A `_distance` projection on a folded root write must fold; a
`_count` projection must not" — the `_count` half is covered, the `_distance`
half has no cell, and no provider in this environment declares the distance
tier, so the branch cannot currently be exercised at all.

**Resolution.** Either land the per-field fact §P.4.8 describes, or restate
§P.4.8/§P.9 as the relocation it is; and either pin the `distance` arm on a
capable provider or leave the gate at `kind === "scalar"` until one can witness
it. (The behaviour is not wrong as far as I can tell — it is unfalsifiable,
which the §7 gate treats as the same problem.)

### 6. [note] The G2.9 specimen is another stream's file, and one of its assertions was weakened

`tests/raptor3/post-prep/g29-result-progress.test.ts` and
`-pglite.test.ts` are not in "Files you own", and §10.12 of the note itself says
the change "must first be settled with the owner". No settlement is recorded.

Widening the fault cut from `^SELECT` to any row-bearing response is a
strengthening and is well argued. But the same edit also changed, for the
transaction-capable profile, `finalDatabase` from `[]` (the write rolled back)
to `[{ id: 1, label: "written" }]` (durable). §P.12.6 says the cut was "WIDENED
…, **never weakened**"; that sentence does not cover this. The justification is
shipped parity, and I verified that parity independently — on the same
corrupting driver both engines answer the same identity and leave the same
committed state (`statement-atomic-parity.review.test.ts`, last cell,
`probe-atomic.log`) — so the change is defensible. It should be stated as what
it is, and acknowledged by the specimen's owner.

### 7. [note] Both remaining `g4-read-contracts` reds are witness-estate defects — confirmed independently

- **SC-13.** My own probes (`witness-defect-checks.review.test.ts`,
  `probe-witness.log`) show both engines refusing the vector **write** with one
  identity, and agreeing on the vector **read** — over an empty table *and* over
  a row seeded with raw SQL. The witness's second `observeFailure` demands a
  refusal that neither engine raises, so the cell cannot pass from production
  code. The author's requested one-line change is the right one.
- **RF-16.** Confirmed by reading `read-recursive-fit.test.ts:232-242`: `walk`
  pushes every object with a string `code`, and each row's own
  `document: { code }` payload is such an object, so `new Map(flat…)` keeps the
  payload instead of the row and `root.amount` is `undefined`. My own recursive
  probes with a correct flatten (`recursive-carrier.review.test.ts`,
  `probe-recursive*.log`) are green on the properties RF-16 exists for,
  including exact `bigint` at every depth, a real cycle stopped path-locally,
  two seeds keeping separate occurrences, and an identity whose text needs JSON
  escaping (`a"b\c\n…`) — the shapes the new TEXT path element could have
  broken.

Both are correctly labelled unverified in §P.14 item 4 (the changed witness
files were not measured).

### 8. [note] `g4-route-transactions` LX-04 and LX-14 are stale divergence pins, as classified

LX-14's own comment says it "goes red the day either shape changes, including
the day the B-1 seam lets the route mirror the shipped condition"; the tape lost
exactly the re-read statement the fold removed. LX-04 now answers `ok:` because
a read is packageable. Both belong to the witness estate. No action for this
unit beyond what §P.11.2 already records.

### 9. [note] `PreparedRead.value` has no consumer, and `empty` is still derived from behaviour

`commands/index.ts:60-66` adds `value` (and `query.ts` adds `Read.value` /
`Read.single`). Nothing in production reads `PreparedRead`:
`route/client-route.ts:124` still throws for `cacheResultCodec`. §P.4.11 says
`publishedFacts` "forwards them instead of deriving them from `result([])`" —
true for `single`, not for `empty`, which is still `value.result([])`
(`commands/index.ts:93`). The seam is planned for G4-03b, so this is a note, not
a defect; it is the one place the §7 answer "what actually grew" grew a public
field with no use.

### 10. [note] Two new lint diagnostics and formatter drift on the four files

`biome check` over the four files: 25 errors on the phase-1 content, **27** now.
The two added are `commands.ts:8` `lint/style/useImportType`
(`import { type OperationContext } from …` should be `import type { … }`,
FIXABLE) and one `lint/complexity/useSimplifiedLogicExpression`. `biome format`
would also reflow phase-2 lines (e.g. `commands.ts:1141`, the
`returningSafeProjection` conjunction, and `query.ts:797`, the multiply/divide
guard). `CLAUDE.md` asks for `pnpm dlx ultracite fix` before committing.

## What I verified and found sound

Recorded so the integrator does not re-do it:

1. **Arithmetic assignments are at parity with the shipped engine** over 17
   payloads across `int`/`number`/`bigint`/`decimal` — multiply, divide
   (including negative operands and integer truncation toward zero), increment,
   decrement — plus int/float divide-by-zero, which both engines leave to the
   provider (`arithmetic-parity.review.test.ts`, `probe-arith.log`). All of it
   is red on the phase-1 tree, so the whole language is a phase-2 fact.
2. **The folded root `create` keeps the generated surface** that §8.3 gave as
   the reason not to fold: an omitted auto-increment key, a generated string id,
   `now()`/`updatedAt` defaults, the unique-violation identity, and a partial
   `select` all match the shipped engine (`root-create-fold.review.test.ts`).
3. **The statement-atomic `NotFoundError`** matches shipped in class, name,
   code, message and meta for `update` and `delete`, on a transaction-capable
   and on a batch-only transport (`statement-atomic-parity.review.test.ts`).
4. **The `operationRegion` grant on failure** — not pinned by any author cell —
   behaves as brief item 11 promises: a granted multi-statement borrowed write
   rolls back only its own work and leaves the caller's transaction usable, and
   a single-statement one has the same effect on the caller with and without the
   grant (`operation-region.review.test.ts`).
5. **The tagged quantifier rule** agrees with shipped on 18 further shapes:
   `some`/`none`/`every` with and without `is`/`isNot`, two quantifiers in one
   slot, under a `NOT`, and over an empty collection (`tagged-quantifier.review.test.ts`).
6. **The counted-slot owner** agrees with shipped for a variant carrier's plain
   `_count`, its `_count` ordering, and the two refusals public validation owns
   (`counted-slot.review.test.ts`). The `where`-carrying `_count` over a variant
   carrier — the shape where one prepared selector would be lowered inside every
   arm — is refused at admission on both engines, so the non-null assertions in
   `countedMemberships` are not reachable from the public surface.
7. **A JSON document whose top-level key spells an operator**
   (`{ push: 1 }`, `{ multiply: 2 }`, `{ divide: 0 }`, `{ unshift: "x" }`) is
   handled identically by both engines — validation normalises it, so the new
   operator ladder does not re-read a whole value (`json-operator-keys.review.test.ts`).
8. **Natives**: `g4-read-envelope-pg-contracts` and
   `-mysql-contracts` 5/5 each (including `g4-native-recursive-read-fit`),
   `g3-scope-composition-pg`/`-mysql` 2/2 each, `g2-pg-contracts` 18/18, on the
   containers the note names, at the ports it names.
9. **Evidence integrity**: both patches reverse-apply cleanly, the production
   patch reproduces the four phase-1 accepted identities exactly, all nine owned
   files match §P.10, and every cost figure recomputes to the byte.

## Unverified author claims (unchanged or newly qualified)

1. The complete charged perimeter — correctly reported unverified; the core
   figure is reproducible and I reproduced it.
2. §P.14 item 2 ("falsifier 3's second half is covered indirectly") — this is
   not merely unverified: the code refuses the shape (finding 1).
3. §P.14 item 3 (`scripts/raptor3-cli.test.mjs` not re-run) — I did not re-run
   it either; it runs the whole credential-free lane as a child.
4. §P.14 item 4 (the two witness cells go green once changed) — still a
   diagnosis; I confirmed the diagnosis itself on both cells (finding 7) but did
   not change another stream's files either.
5. §P.12.6 item 4's "the reviewer's own probes are byte-identical in the tree" —
   the review probes are untracked, so git cannot witness it; I did verify that
   this unit's `k-competing-refusals.test.ts` /`k-refusal-order-history.test.ts`
   are faithful copies of `review/unit01-followup3/` apart from the header and
   the world import path.
6. Newly qualified by this review: §P.12.4's falsification counts and §P.12.7
   row 1's evidence (finding 4), and the absence of any statement about
   `g2-mysql-contracts` / `g3-generated-transport-smoke` (finding 3).
