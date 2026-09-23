# G4-02 phase 2 (`shared/query.ts` and the physical envelope) — repair round 4, independent verification

Reviewer: independent (did not author the unit, did not repair it, repaired
nothing here). Source: main tree `/Users/arnaud/code/viborm`, nothing applied.
Prior reviews: [`unit02-phase2-review.md`](unit02-phase2-review.md) (REVISE —
1 blocking, 4 must-fix, 5 notes) and
[`unit02-phase2-review-followup.md`](unit02-phase2-review-followup.md)
(REVISE — 1 blocking (A), 4 notes (B–E)).
Repair record: [`unit02/note.md`](unit02/note.md) §R3.0–§R3.8.
Patches: [`unit02/production-phase2.patch`](unit02/production-phase2.patch)
(`f2ef4598…`, nine files) and [`unit02/tests-phase2.patch`](unit02/tests-phase2.patch)
(`21727106…`, 24 files) — both hashes as the note states.
Reviewer probes: `tests/raptor3/g4/review/unit02-phase2-followup2/`
(2 files, 19 cells). Receipts and identities:
[`unit02-phase2-review-followup2-receipts/`](unit02-phase2-review-followup2-receipts/).

## Outcome

**REVISE.**

Round 4's blocking finding is **resolved, and resolved the right way.** All four
`upsert` shapes finding A measured are byte-identical to the shipped engine
again (I re-ran my own round-3 probe file: 15 passed / 1 failed / 3 skipped, and
the one red is finding B's pre-existing `number`-key `increment`). The
placement claim checks out against the shipped source: `namesRelation` mirrors
`updateHasRelations` (`UpsertOperation.ts:291-293`, `:496-504`) and the found-arm
attachment mirrors `compileFoundArm`'s deferral (`:845-853`) through an existing
legality channel (`execution.ts:260`, `:391`) — no new mechanism, no second
sentence, no policy boolean. The whole author estate is 88 passed / 6 skipped,
`g3-execution-review` 6, `g4-read-contracts` 62/62, `g2-contracts` 216,
`g1-contracts` 143, the typecheck exactly the two permitted `pattern/pack.ts`
diagnostics. Every cost figure in §R3.6 reproduces to the byte, all 41 receipt
identities match the tree, `production-phase2.patch` reverse-applies to exactly
the five phase-1 identities it claims, and the three falsifier receipts fail
exactly the cells their ledger names. Findings B, C, D, E are all addressed.

What holds acceptance back is that §R3.1's central claim — "All four review
shapes are now identical to the shipped engine … a fifth shape (relation-bearing
payload on a missing row) … is closed with them" — is **falsified by the
operator the author did not probe**. The shipped gate has a **third** owner,
earlier than both halves the note models: `RecordUpdateCompilerState.interpretReferencedKeyTransition`,
reached from the `UpsertOperation` constructor (`UpsertOperation.ts:480`), which
raises its own sentences for a relation-bearing payload **whichever arm is
selected**. Two shapes inside the newly gated family therefore still diverge:
one in **error identity**, one in **committed state** — the candidate writes a
row the shipped engine refuses to write. Neither is recorded.

Both are *pre-existing* against the accepted phase-1 baseline (I falsified that
myself, below), so this is not a regression and the repair did not cause it.
The ask is small: record them, or extend the mirror; and correct the two
sentences in §R3.1 that state parity the tree does not have.

## Per-finding status (round-3 review)

| # | Prior severity | Finding | Verdict now |
| --- | --- | --- | --- |
| A | **blocking** | the key-portability mirror fires on `upsert` where shipped does not; four shapes diverge, one loses a row creation | **RESOLVED** for all four shapes, verified independently (§“What I verified”). The placement matches the shipped source I read. **Incomplete as *described*** — see new findings 1 and 2 |
| B | note | a `number` primary key `increment` diverges and is not in R-D2's table | **RESOLVED** — pinned at `key-arithmetic.test.ts:297` ("supports a number key increment where the shipped engine refuses it"), R-D2 unchanged as asked |
| C | note | §R2.4's falsification row does not cover the estate it claims | **RESOLVED** — §R2.4's row now carries 32 failed / 48 passed / 6 skipped over the 17-file / 86-cell estate, and cites my re-run |
| D | note | R-D1's stated reachable shape was not reproducible | **RESOLVED in substance** — §R2.1 carries a bracketed withdrawal and §R3.3 states the refusal as unreachable. Residual nit: finding 5 |
| E | note | §R2.7's `schema.ts` identity is stale | **RESOLVED** — §R2.7 now carries `761d5943…`, which is the round-3 receipt's and was the tree's |

## Findings

### 1. [must-fix] A relation-bearing `upsert` that divides the key by zero: the candidate raises the wrong refusal, and on a missing row raises none at all and writes the row

`src/query-engine/raptor3/commands/commands.ts:1220-1224` (the new found-arm
gate) and `src/query-engine/raptor3/shared/schema.ts:222-242`
(`keyPortabilityRefusal`).

The shipped engine reaches a key refusal for a relation-bearing update payload
from **three** places, not two. The third is the update compiler's key
transition, and it runs in the `UpsertOperation` **constructor**, before any arm
exists. Stack, captured from the shipped engine itself
([`attribution-1.log`](unit02-phase2-review-followup2-receipts/attribution-1.log)):

```
QueryEngineError: Cannot divide a primary key by zero.
  at calculateNumericPrimaryKey (src/query-engine/operations/mutation-identity.ts:357)
  at getSafeUpdatedScalarValue (…:319)
  at getUpdatedPrimaryKeyValue (…:180)
  at RecordUpdateCompilerState.interpretReferencedKeyTransition (src/query-engine/write-engine/RecordUpdateCompiler.ts:3319)
  at RecordUpdateCompilerState.resolveOrdinaryChildHeld (…:2229)
  at RecordUpdateCompilerState.interpretChildHeldRelation (…:2181)
  at RecordUpdateCompilerState.interpretRelation (…:2164)
  at new RecordUpdateCompilerState (…:1101)
  at buildRecordUpdateCompiler (…:264)
  at new UpsertOperation (src/query-engine/write-engine/UpsertOperation.ts:480)
```

Measured, differential, one world per cell, answer **and** provider rows
compared — `tests/raptor3/g4/review/unit02-phase2-followup2/upsert-gate.review.test.ts`,
receipt [`probes-final.log`](unit02-phase2-review-followup2-receipts/probes-final.log):

| request (`upsert`, child-held relation in the update payload) | shipped | candidate (round 4) |
| --- | --- | --- |
| `intOwner`, row **present**, `update:{ id:{ divide:0 }, items:{ create:[…] } }` | `QueryEngineError: Cannot divide a primary key by zero.` | `QueryEngineError: Cannot divide primary key field 'id' by zero.` — **different identity** |
| the same with `where:{id:99}`, row **absent** | `QueryEngineError: Cannot divide a primary key by zero.`, **no row written** | `ok:{"id":99,"label":"fresh"}` — **the row is created** |

The second row is the exact mirror image of round 3's blocking finding: there
the candidate refused a creation the shipped engine performed; here it performs
a creation the shipped engine refuses. §R3.1's sentence "a fifth shape
(relation-bearing payload on a missing row) … is closed with them" is true only
for `multiply` (I re-measured that one: both engines `ok`, row created,
identical). With `divide: 0` the same shape is not closed.

**Attribution — falsified, not asserted.** I backed the nine production files
into the scratchpad, reverse-applied `production-phase2.patch` (which reproduced
`6f39f82a…`, `65aa6f5b…`, `c7a58c9c…`, `12442b94…`, `546adce4…` and left the
four adapters at HEAD — exactly as §R3.6 claims), re-ran both probe files, then
restored and re-hashed to the round-4 identities
([`falsify-on-phase1-tree.log`](unit02-phase2-review-followup2-receipts/falsify-on-phase1-tree.log),
[`identities.txt`](unit02-phase2-review-followup2-receipts/identities.txt)).
On the **accepted phase-1 tree** the missing-row cell answers
`ok:{"id":99,"label":"fresh"}` and writes the row **too** — the create arm never
builds the expression, so phase 2's "not implemented" never fires. So:

- the missing-row divergence is **pre-existing**, not round 4's and not phase 2's;
- round 3's admission hook masked it (the note's falsifier 1 shows that cell red);
- round 4 restores the accepted baseline's behavior — **no regression**;
- and it is **not recorded anywhere**, while §R3.1 states the opposite.

**Resolution (either).** (a) Record it: a third decision beside R-D1/R-D2
pinning both engines' answers for the two rows above (and for finding 2's), the
way R-D2 pins its family — the brief's own route for a pre-existing observable
divergence. (b) Mirror the third owner: answer
`keyPortabilityRefusal`'s divide-by-zero sentence from the position the shipped
engine answers it — at analysis, not on the found arm — for a relation-bearing
payload, with the shipped sentence. Either way §R3.1's two sentences (the
"TWO halves" model and the "fifth shape … closed with them" claim) need
correcting, and a cell needs to pin whichever answer is chosen: none of the
author's 94 cells exercises `divide` beside a relation write.

### 2. [note] `set` beside an operator on the gated arm: a third sentence, unchanged since phase 1

Same probe file, cell "answers `set` beside the operator on the gated arm".
`owner.upsert({ where:{id:6}, create:{…}, update:{ id:{ set:8, multiply:2 }, notes:{ create:[…] } } })`:

| | answer |
| --- | --- |
| shipped | `QueryEngineError: Cannot determine the updated primary key for model 'owner' because field 'id' uses an unsupported operation.` (`mutation-identity.ts:187`, same third owner) |
| candidate | `NestedWriteError: Cannot update relation 'notes' with onUpdate('restrict') while the current relation is occupied.` |

Identical on the phase-1 tree, so this predates phase 2 entirely. It belongs to
R-D2 (c) ("`set` winning over an accompanying operator"), whose table pins the
`update`/`updateMany` sentence — the `upsert`-with-relations sentence is a
different one. Worth one line in R-D2 so the family is decided once, as finding
B's arm already is.

### 3. [note] The atomic-batch profile diverges on the scalar-only half — pre-existing, and it closes §R3.8 item 4 the other way

§R3.8 item 4 records the batch (`usesBatch`) profile as unmeasured. I measured
it with a D1-shaped driver (`supportsTransactions = false`, `supportsBatch = true`):

- **the gate itself works there**: the relation-bearing refusal is raised
  identically to the shipped engine on a batch profile (cell "raises the gated
  refusal on an ATOMIC BATCH profile"), so the found-arm channel is not
  profile-dependent. That half of item 4 can be closed **green**;
- **the scalar-only half diverges**: `numKey.upsert({… update:{ id:{ multiply:2 } } })`
  answers `ok:{"id":12,…}` on the shipped engine and
  `Error: Raptor 3 update expression publication requires an integer field` on
  the candidate — a bare `Error` from `shared/operation-context.ts:1550-1554`,
  an internal invariant leaking to a public caller.

Pre-existing, and not this unit's: the guard is byte-identical at `HEAD`
(`:1227`), and `{ id: { increment: 1 } }` — implemented long before phase 2 —
reaches the same `Error` on the same profile while the shipped engine answers
`ok:{"id":7,…}` ([`attribution-1.log`](unit02-phase2-review-followup2-receipts/attribution-1.log)).
An `int` key `multiply` and a non-key `decimal` `multiply` are both green on the
batch profile on both engines, so the gap is exactly "non-`int` field whose
expression update is demanded under a batch". Recording it as a known
environment-shaped divergence (or handing it to whoever owns the batch
publication) would keep §R3.8 item 4 from being read as untested rather than
as measured-and-divergent.

### 4. [note] `namesRelation` is not yet "the one spelling"

`src/query-engine/raptor3/shared/schema.ts:186-188` is a good consolidation and
its own JSDoc is accurate ("asked by the upsert's create arm below and by the
found-arm key-portability gate"). §R3.1's prose is wider — "becomes the one
spelling of 'this payload names a relation'" — while
`commands/commands.ts:1036`, `:1065` and `:1256` still ask the same question
inline on their own payload variables (`:1091` asks it of a *row*, so it is a
different question). Nothing is wrong in the code; the sentence overstates it.

### 5. [note] R-D1's own row still carries the reachability §R3.3 withdraws

§R2.1 carries the bracketed withdrawal and §R3.3 states the refusal as
unreachable, which is what finding D asked for. But the decision table Arnaud
will actually read — §R2.9's R-D1 row — still says "Reachable shape: a decimal
RELATION key on a non-RETURNING provider, where the shipped engine computes the
key in JavaScript." One bracketed pointer to §R3.3 in that row would finish the
correction.

## What I verified and found sound

Serial, through the bounded runner, on the identities in
[`identities.txt`](unit02-phase2-review-followup2-receipts/identities.txt)
(all 41 entries of the author's `repair4/identities.txt` re-checked against the
tree with `shasum -c`: **every one matches**).

**Finding A is closed.**

1. The author's new witness `tests/raptor3/g4/unit02/upsert-key-portability.test.ts`
   is 7 cells, all differential against the client's own shipped engine,
   comparing the answer *and* the provider's rows — the right shape for this
   contract — and all 7 pass.
2. My round-3 probe file re-run: **15 passed / 1 failed / 3 skipped** (was
   11 / 5 / 3). All four `upsert` cells of finding A are green; the red is
   finding B's `number`-key `increment`, now pinned
   ([`review-followup-probes.log`](unit02-phase2-review-followup2-receipts/review-followup-probes.log)).
3. My phase-2 probe file re-run: **54 passed / 2 failed**, the two being R-D2's
   recorded divergences — unchanged
   ([`review-phase2-probes.log`](unit02-phase2-review-followup2-receipts/review-phase2-probes.log)).
4. The placement matches the shipped source, read line by line:
   `updateHasRelations` at `UpsertOperation.ts:291-293`, the closure built only
   under it at `:496-504` (with `assertPortablePrimaryKeyUpdateInput` inside),
   and `compileFoundArm`'s `this.updateLegality?.()` before conditional
   selection at `:845-853`. The candidate's channel is the existing one:
   `CommandOccurrence.refusal` is raised at `commands/execution.ts:260` (found
   record runs) and `:391` (after `fields.activate()`, before the conditional
   probe) — I read both. The assignment is placed **after**
   `analyzeOccurrence`, so it does not disturb the analyzer's `??=` propagation,
   and `=` rather than `??=` puts portability ahead of a nested-write refusal.
5. Adversarial cells the author did not write, all **green**: a decimal key
   multiply beside a relation write; a *supported* int key `increment` beside a
   relation write (the gate does not over-fire — both engines answer the same
   `NestedWriteError`); a **matched** conditional (not just an unmatched one);
   the portability refusal ordered against a real nested-write refusal
   (both engines answer portability first); the relation-bearing refusal on an
   **atomic-batch** profile; a scalar-only missing-row `divide: 0` (both create);
   a **nested** `upsert` whose update multiplies the target key (both
   `ok`, both write `id 140`); and the `update`/`updateMany` contract, which
   still fires at admission with the shipped sentences, including for a
   relation-bearing `update` payload.

**Nothing registered regressed.**

| Suite / mode | My result | Author's figure |
| --- | --- | --- |
| G4-02 author checks (18 files, 94 cells) | **88 passed / 6 skipped** | same |
| review probes `unit02-phase2` (10 files) | 54 passed / 2 failed | same |
| review probes `unit02-phase2-followup` (3 files) | 15 passed / 1 failed / 3 skipped | same |
| review probes `unit02-phase2-followup2` (2 files, mine) | 15 passed / **4 failed** | — |
| `g3-execution-review` | **6 passed** (the registered decimal-key-`increment` witness intact) | same |
| `g4-read-contracts` | **62 passed** (SC-13 and RF-16 green) | same |
| `g2-contracts` | **216 passed** (runner exits 1 on the drifting harness fingerprint only: "Stale Raptor 3 evidence") | same |
| `g1-contracts` | **143 passed** | same |
| `g3-transaction-array` / `g3-bulk-series` | 4 / 6 passed | same |
| `g29-member-dependency` (batch-profile witness) | **14 passed** | same |
| `node scripts/run-typecheck.mjs` | exactly the two permitted `pattern/pack.ts` diagnostics (1443, 2633); 13.18 s, 5,114.5 MiB | same |

**Evidence integrity.** `production-phase2.patch` reverse-applies cleanly and
reproduces `6f39f82a…`, `65aa6f5b…`, `c7a58c9c…`, `12442b94…`, `546adce4…` plus
the four adapters at HEAD, exactly as §R3.6 claims; both patch hashes match. The
three falsifier receipts carry swapped-in **and** restored identities at head and
foot, and each fails exactly the cells §R3.1's ledger names — falsifier 1 the
four review shapes plus the relation-bearing missing row (5), falsifier 2 the
two relation-bearing cells plus the four `key-arithmetic` contract cells (6),
falsifier 3 the missing-row creation alone (1). They ran at the pre-JSDoc
identity `999b3c8d…`, which §R3.6 discloses, and the estate was re-run at the
final `07b3df1a…`. Nothing is relabeled.

**Cost**, recomputed with the same script as the previous round
(`../unit02-phase2-review-followup-receipts/cost.mjs`):

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| the four phase-2 files (`query`, `operation-context`, `commands`, `index`) | 4 | **257,754** | **7,307** | **6,699** |
| `shared/schema.ts` | 1 | **14,409** | **426** | **365** |
| the four adapters | 4 | **140,389** | **3,423** | **1,635** |
| candidate core (`commands/` + `shared/`) | 12 | **346,131** | **9,991** | **9,277** |
| `src/query-engine/raptor3` tree | 15 | **376,033** | **10,861** | **10,047** |

**Every figure in §R3.6 reproduces to the byte**, including the increment
(+1,737 B / +23 physical / **0** token-lines: `commands.ts` gains the five
token-lines `schema.ts` loses). The complete charged perimeter remains correctly
reported unverified.

## Unverified author claims after round 4

1. The **complete charged perimeter** — unchanged reason; the core, adapter and
   tree figures are reproducible and I reproduced them.
2. `scripts/raptor3-cli.test.mjs` and the three harness self-tests — still run by
   neither of us; `scripts/*.test.mjs` matches no project in the current
   `vitest.workspace.ts`, which another stream owns.
3. §P.11.1's two witness cells (SC-13, RF-16) are green in `g4-read-contracts`
   62/62, but the repair is the witness stream's; this unit neither made nor
   attributed it.
4. §R3.8 item 4 (the atomic-batch profile) — **half closed by this review**: the
   relation-bearing gate is raised identically on a batch profile; the
   scalar-only half diverges (finding 3). A native PostgreSQL/PGlite cell for
   the gate still does not exist, though the refusal is provider-independent by
   construction (raised before any statement).
5. §R3.8 item 5 (`core-structure` 92/2 attributed to another stream) — not
   re-measured here.
6. R-B3 (`g2-mysql-contracts` 10/13 on native MySQL) — not re-measured this
   round; round 3's pre-unit falsification stands and the reassignment request
   is unchanged. The G2.9 specimen settlement is likewise still open.
