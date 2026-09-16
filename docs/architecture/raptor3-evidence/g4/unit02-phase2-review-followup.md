# G4-02 phase 2 (`shared/query.ts` and the physical envelope) — repair round 3, independent verification

Reviewer: independent (did not author the unit, did not repair it). Source:
main tree `/Users/arnaud/code/viborm`, nothing applied, nothing repaired.
Prior review: [`unit02-phase2-review.md`](unit02-phase2-review.md) (REVISE —
1 blocking, 4 must-fix, 5 notes).
Repair record: [`unit02/note.md`](unit02/note.md) §R2.0–§R2.10.
Patches: [`unit02/production-phase2.patch`](unit02/production-phase2.patch)
(`9f9adfd739c0aed7a02cdd27fcd8ecf2c441f7296241536f80601ec018d4326c`, nine
files), [`unit02/tests-phase2.patch`](unit02/tests-phase2.patch)
(`680a2956166337b350a1dac9a688211e8401c5d4aa137b60482235d60b93a12d`, 23 files).
Follow-up probes: `tests/raptor3/g4/review/unit02-phase2-followup/` (3 files,
19 cells). Receipts and identities:
[`unit02-phase2-review-followup-receipts/`](unit02-phase2-review-followup-receipts/).

## Outcome

**REVISE.**

The five findings the previous round raised are all genuinely addressed, and I
re-measured every one of them: the blocking divergence is closed on the real
non-RETURNING provider, the portability mirror preserves the registered G3
contract it was in danger of breaking, the RETURNING gate is narrowed and now
has a falsifier that actually fails when the gate is widened, both revision-5
regressions are measured and attributed (I reproduced the harder attribution —
the pre-unit tree — myself), and both lint diagnostics are gone. Every cost
figure reproduces to the byte, both patches reverse-apply to the exact baseline
identities, and the whole receipt's file identities match the tree.

What blocks acceptance is a **new** divergence the repair itself introduced.
The mirror the author added at `EngineSchema.admit` is narrower than the shipped
assertion for `update`/`updateMany`, as the note says — but it is **wider** for
`upsert`, where the shipped engine does not apply that assertion at all on the
scalar path. The candidate now refuses four public `upsert` shapes the shipped
engine performs, including one where the row does not exist yet and the
arithmetic is never applied: **the shipped engine creates the row, the candidate
creates nothing**. Falsified against the phase-1 `schema.ts`: the same cells are
green there, so this arrived with round 3. It is neither recorded as a decision
nor witnessed.

## Per-finding status

| # | Prior severity | Finding | Verdict now |
| --- | --- | --- | --- |
| 1 | blocking | `updateValue` refuses `multiply`/`divide`; live divergence on MySQL; four record defects | **RESOLVED** (verified below, incl. live MySQL 5/5 and a new live PostgreSQL arm 3/3) |
| 2 | must-fix | `multiply`/`divide` newly reachable on primary keys where shipped refuses | **PARTLY RESOLVED — new defect (finding A)**. The `update`/`updateMany` shapes are fixed and the G3 contract is preserved; the same hook introduces four `upsert` divergences |
| 3 | must-fix | revision-5 regressions neither delivered nor recorded | **RESOLVED**; I reproduced the pre-unit attribution independently |
| 4 | must-fix | two falsifier-ledger claims do not survive re-measurement | **RESOLVED in substance, still mis-stated in counts (finding C)** |
| 5 | must-fix | RETURNING-safety widening unfalsifiable, note describes a mechanism that did not land | **RESOLVED**; the new falsifier fails when I widen the gate |
| 6 | note | G2.9 specimen is another stream's file, one assertion weakened | restated in §R2.6 as the review asked; settlement still owed (unchanged) |
| 7 | note | both `g4-read-contracts` reds are witness defects | unchanged, still 60 passed / 2 failed |
| 8 | note | LX-04 / LX-14 stale divergence pins | unchanged, still 9 passed / 2 failed |
| 9 | note | `PreparedRead.value` has no consumer | unchanged, G4-03b's |
| 10 | note | two new lint diagnostics | **RESOLVED** — neither `useImportType` nor `useSimplifiedLogicExpression` appears in my own `biome check` of the nine files |

## Findings

### A. [blocking] The new key-portability mirror fires on `upsert`, where the shipped engine does not — and an `upsert` that would CREATE a row is refused

`src/query-engine/raptor3/shared/schema.ts:199-227`
(`EngineSchema.assertPortableKeyUpdate`), specifically the operation arm at
`:204-209`:

```ts
const data =
  operation === "upsert"
    ? args.update
    : operation === "update" || operation === "updateMany"
      ? args.data
      : undefined;
```

The shipped engine reaches `assertPortablePrimaryKeyUpdateInput` for an upsert's
update payload **only when that payload names relations**
(`src/query-engine/write-engine/UpsertOperation.ts:499-504`, inside
`updateHasRelations ? … : undefined`); a scalar-only root upsert never has the
assertion applied. Measured, one world per row, SQLite (RETURNING), candidate vs
the client's own shipped engine — probe
`tests/raptor3/g4/review/unit02-phase2-followup/key-repair.review.test.ts`,
receipt `followup-probes-final.log`:

| request (`upsert`) | shipped | candidate (round 3) |
| --- | --- | --- |
| `{ where:{id:6}, create:{…}, update:{ id:{ multiply:2 } } }`, **number** key, row present | `ok:{"id":12,…}`, row written | `QueryEngineError: Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value.` — nothing written |
| the same on a **decimal** key (`{ multiply:"2.00" }`) | `ok:{"id":"12",…}`, row `1200` | `… not portable for decimal primary key field 'id' …` — nothing written |
| `{ where:{id:3}, create:{…}, update:{ id:{ divide:0 } } }`, **int** key | `QueryError: Query execution failed` (statement issued) | `QueryEngineError: Cannot divide primary key field 'id' by zero.` — different identity |
| `{ where:{id:99}, create:{id:99,label:"new"}, update:{ id:{ multiply:2 } } }`, **row absent** | `ok:{"id":99,"label":"new"}` — **row created** | same refusal — **no row created** |

The last row is the sharpest: the arithmetic is never applied on that path, and
the candidate loses a creation the shipped engine performs.

**Attribution, falsified.** With `shared/schema.ts` alone swapped to its
phase-1 accepted content (`c7a58c9c…`, the only file carrying the mirror; backup
copy in the scratchpad, restored and re-hashed to `761d5943…` afterwards) the
same probe file answers: all four `upsert` cells **green**, and the
`updateMany` divide-by-zero cell the mirror exists to fix **red**
(`falsify-upsert-on-phase1-schema.log`). Round 3 traded one divergence family
for another.

The note's own characterization is therefore inaccurate as written: §R2.2 says
the mirror is "deliberately NARROWER than the shipped assertion". It is narrower
for `update`/`updateMany` and **wider for `upsert`**, and per `common.md`
("A new observable compatibility choice is a decision for Arnaud") a wider
refusal is exactly the thing that had to be recorded or avoided.

**Resolution.** Either scope the hook to the operations finding 2 measured
(`update`, `updateMany`) — the two shapes phase 2 made reachable there are what
the review asked for — or mirror the shipped condition (assert on the upsert
update payload only when it names relations), or record the four shapes above
as a third decision with both engines' answers pinned. Whichever is chosen needs
a cell; none of the 86 author cells covers `upsert` key arithmetic.

### B. [note] A `number` primary key `increment`/`decrement` diverges too, and is not in R-D2's table

Same probe file, cell "answers a FLOAT key increment the way the shipped engine
does": `update({ where:{id:6}, data:{ id:{ increment:1 } } })` on a
`s.number().id()` key — shipped refuses
(`Arithmetic updates are not portable for number primary key field 'id'…`), the
candidate writes `7`. Measured pre-existing: the mirror does not cover
`increment`, and the cell answers identically with the phase-1 `schema.ts`.

This is the same family as R-D2 (a), which records only the **decimal** key
`increment`. R-D2's table should name the `number` arm too, so Arnaud decides
once over the whole family rather than twice.

### C. [note] §R2.4's falsification still does not cover the estate it claims

The receipt `receipts/phase2/repair/falsify-author-checks-on-phase1-tree.log`
(09:28) reports `32 failed | 46 passed | 1 skipped` over **16 files / 79 cells**;
`key-arithmetic.test.ts` is 13 cells there and `native-key-arithmetic.test.ts`
is absent. The final estate (files last edited 09:46) is **17 files / 86 cells**.
§R2.4 labels that run "the FINAL 17-file author estate re-run … (86 cells)".

I re-ran the same swap myself against the final estate — four phase-2 files →
phase-1 accepted, `shared/schema.ts` → `c7a58c9c…`, four adapters → HEAD, all
identities verified before and after
(`falsify-author-checks-on-phase1-tree.log`, `identities.txt`):

**32 failed | 48 passed | 6 skipped (86 cells, 17 files)** — the failure count is
identical, `key-arithmetic.test.ts` is 13 of 15 red, `returning-safety-gate.test.ts`
is 5/5 red, and `borrowed-envelope.test.ts` / `packaged-array.test.ts` are green,
which is precisely the correction finding 4(a) asked for. **No conclusion
changes**; the row's counts should read 48/6 instead of 46/1.

### D. [note] R-D1's stated reachable shape was not reproducible

R-D1 asks Arnaud to decide about a refusal whose "reachable shape is a decimal
RELATION key under multiply/divide on a non-RETURNING provider". I built three
constructions on a non-RETURNING driver
(`decimal-relation-key.review.test.ts`, receipt `decimal-relation-key.log`):

1. a decimal `unique` key referenced by a dependent row, multiplied — **both
   engines answer `ForeignKeyError: Foreign key constraint violation`**;
2. the same with no dependent row — **both answer `ok:{"code":"12"}`**, row
   `1200`;
3. the dependent's own decimal FK column multiplied, with
   `.onUpdate("restrict")` — **both answer `ok:{"holderCode":"12"}`**.

None reaches `updateValue`'s decimal refusal; the refusal is pinned only at the
`Queries.updateValue` unit level (`key-arithmetic.test.ts:360`). Its
row-key arm is genuinely unreachable (admission refuses first, as §R2.1 says).
Either name a construction that reaches it or state the refusal as currently
unreachable from the public surface, so the decision is not spent on a shape
nothing can produce.

### E. [note] §R2.7's identity for `shared/schema.ts` is wrong

The table gives
`6e58d9207cd4d62cbe0ceef6579c22b70d8d1dcd7d2d02904111b7824d2b1ad7`. The tree —
and the round-3 receipt `receipts/phase2/repair/identities.txt`, which was
captured after the last edit — both carry
`761d5943f991b548e76335e2acbdab3e5f60b46dbc11c3362c14ab1a564a85ae`. The receipt
is right, the note's cell is stale; the §R2.7 byte counts were computed on the
tree file and reproduce exactly. Every other identity in §R2.7 matches the tree.

## What I verified and found sound

Recorded so the integrator does not re-do it. Serial, through the bounded
runner, on the identities in
[`identities.txt`](unit02-phase2-review-followup-receipts/identities.txt).

**Finding 1 (blocking) is closed.**

1. My own phase-2 review probes (`review/unit02-phase2/`, 10 files, 56 cells) are
   **54 passed / 2 failed** (`review-probes-all.log`); the five key cells that
   were red are green — `multiply` and `divide` on a non-RETURNING provider, the
   decimal-PK and number-PK multiply refusals, and the int-PK divide-by-zero
   refusal. The two that remain red are exactly the two shapes R-D2 records as
   decisions, both of which the previous review had already classified as
   pre-existing.
2. `native-key-arithmetic.test.ts` on the live MySQL container
   (`viborm-raptor3-g3-mysql-20260914`, `127.0.0.1:65515`): **5 passed**,
   including `7 / 2 = 3` — the case that separates truncation from real division
   on the project's only non-RETURNING provider (`native-key-arithmetic-mysql.log`).
3. **New: the PostgreSQL arm of `expressions.integerDivide`, end to end.** The
   note lists it as unverified (§R2.10 item 5, "No cell exercises a PostgreSQL
   provider with supportsReturning forced off"). I wrote that cell —
   `native-pg-key-arithmetic.review.test.ts`, a live `PgDriver` on `:65504` with
   `capabilities.supportsReturning` forced to `false` — **3 passed** (multiply,
   exact and non-exact quotient), candidate identical to shipped and to the row
   the provider holds (`native-pg-key-arithmetic.log`). That unverified item can
   be closed.
4. **New: the cascading half of falsifier 3**, which §R2.10 item 2 lists as
   unverified: a DEPENDENT's foreign key carried through a MULTIPLIED and a
   DIVIDED parent key on a non-RETURNING driver — both **green**, candidate
   identical to shipped (`key-repair.review.test.ts`, first two cells).
5. Negative integer quotients and products on a `bigint` key (`-7 / 2`,
   `-7 * 3`) match the shipped engine — the truncation direction the new seam
   has to get right.
6. The adapter seam is real, minimal and in the right place:
   `database-adapter.ts:294` declares it, each dialect spells its own truncation
   (`sqlite (…/CAST(? AS INTEGER))`, `postgres (… / …)`, `mysql TRUNCATE(…,0)`),
   and the contract test family `tests/contracts/adapters/` is **182 passed**
   (`adapter-contracts.log`).

**Finding 2's narrowing is sound where it applies.**

7. `g3-execution-review` is **6 passed** (`g3-execution-review.log`): the
   registered G3 witness that a whole mirror would have broken —
   `review-execution-boundaries.test.ts` "reads a supported decimal key
   increment through its provider expression" — is intact. I confirmed that
   witness exists at clean `HEAD` (`git show HEAD:…` asserts
   `updateMany` on a DECIMAL primary key with `{ increment: "2.00" }`), so the
   narrowing is forced, not chosen.
8. The mirror does not over-fire on non-key arithmetic (a decimal NON-key column
   under `multiply` still matches shipped) and a non-finite operand on an int key
   answers identically on both engines. A model with **no** row key — the shape
   that would make `EngineSchema.keys`' `rowKey!` throw — cannot exist: schema
   validation refuses it (`[M001] 'keyless' must have an ID field`), measured.

**Finding 3's attributions hold, including the one the previous review did not do.**

9. `g2-mysql-contracts` on `:65515` is **10 passed / 3 failed**
   (`g2-race-selected-unique-recovery`, `g2-race-unrelated-unique-refused`,
   `g2-race-wrong-insert-same-constraint`). I then rebuilt the **pre-unit** tree
   myself — reverse-apply of `production-phase2.patch` then of `production.patch`
   in the scratchpad, giving `schema.ts d747abb4…`, `operation-context.ts
   05d1f722…`, `commands.ts 20f07393…`, `execution.ts eb0551e5…`, `query.ts` at
   the G4-01 r5 identity `6f39f82a…` — swapped those nine files in over backups,
   and re-ran the mode: **the same three cells fail**
   (`falsify-g2-mysql-on-preunit-tree.log`). Restored and re-hashed to the
   round-3 identities. **R-B3's reassignment request is correct.**
   `g2-pg-contracts` is **18 passed** on `:65504`, so the family is MySQL-only.
10. `g3-generated-transport-smoke` fails at exactly the cell and with exactly the
    message §R2.5 records (`g3-transport:script-shape; Unscripted statement:
    g3-c11-8027-0:recurrence-0; actual=INSERT; expected=INSERT,SELECT`), and the
    §5.4 recipe record names the right function and the right condition
    (`ordinaryRecurrenceReplies`, `depth === 0`). R-B4 is a correct hand-off.

**Finding 5's gate is now falsifiable.**

11. `returningSafeProjection` is `fields.every(kind === "scalar")`, and §P.4.8 /
    §P.9 / §P.5 are restated as the relocation. I falsified the new witness:
    re-adding `|| field.kind === "distance"` in a scratchpad-backed copy of
    `query.ts` turns `returning-safety-gate.test.ts`'s `_distance` cell **red**
    (`falsify-returning-gate-widened.log`); restored to `5143b7b3…`.

**Suites, cost and evidence integrity.**

| Suite / mode | My result | Author's figure |
| --- | --- | --- |
| G4-02 author checks (17 files) | **80 passed / 6 skipped** | same |
| G4-02 native MySQL key arithmetic (`:65515`) | **5 passed** | same |
| review probes `unit02-phase2` (10 files) | **54 passed / 2 failed** | same |
| review probes `unit02-phase2-followup` (3 files, mine) | 11 passed / **5 failed** / 3 skipped | — |
| `g4-read-contracts` | 60 passed / 2 failed (SC-13, RF-16) | same |
| `g4-unit01-review` / `g4-unit01-author` | **200** / **83 passed** | same |
| `transitions` (33 credential-free files) | **434 passed** | same |
| `post-prep` | **49 passed** | same |
| `prep` | **37 passed** | same |
| candidate core (7 files) | **100 passed** | same |
| `expanded` (7 files) | **281 passed** (RSS ceiling hit at teardown) | 293 with ownership+polish |
| `core-structure/` | 81 passed / **13 failed** | same |
| `g4-route-transactions` / `-admission` / `-cache` / `-lifecycle` | 9/2, 4/1, 6, 7 | same |
| `g4-lifecycle-events` / `-admission` | 1/2, 3/1 | same |
| `g4-generation-selftests` | 6 passed | same |
| `g3-execution-review` | **6 passed** | same |
| `g3-suppression-retry` / `-bulk-series` / `-transaction-array` / `-depth-recurrence` | 2 / 6 / 4 / 6 | same |
| `g29-result-progress` | 2 passed | same |
| `tests/contracts/adapters/` (9 files) | **182 passed** | same |
| `g3-generated-transport-smoke` | **1 failed** (recorded, R-B4) | same |
| native pg `:65504`: `g2-pg-contracts` / `g4-read-envelope-pg` / `g3-scope-composition-pg` | 18 / 5 / 2 passed | same |
| native mysql `:65515`: `g4-read-envelope-mysql` / `g3-scope-composition-mysql` | 5 / 2 passed | same |
| `g2-mysql-contracts` (`:65515`) | 10 passed / **3 failed** | same (R-B3) |
| `node scripts/run-typecheck.mjs` | exactly the two permitted `pattern/pack.ts` diagnostics | same |
| `biome check` (nine production files) | 37 diagnostics, **none** `useImportType` / `useSimplifiedLogicExpression`; the only `schema.ts` format drift is a pre-existing constructor line | "both fixed" |

**Cost** recomputed with the census function's own definition
([`cost.mjs`](unit02-phase2-review-followup-receipts/cost.mjs),
[`cost-recount.txt`](unit02-phase2-review-followup-receipts/cost-recount.txt)):
four phase-2 files round 3 **257,036 B / 7,296 / 6,694**; phase-1 accepted
236,563 / 6,864 / 6,461; `schema.ts` 10,116 → 13,390, 341 → 414, 327 → 370;
four adapters 138,743 → 140,389, 3,393 → 3,423, 1,629 → 1,635; core (12 files)
**344,394 / 9,968 / 9,277**; tree (15 files) **373,660 / 10,826 / 10,046**.
**Every figure in §R2.7 reproduces exactly**, and the complete charged perimeter
is still correctly reported unverified.

**Evidence integrity.** `production-phase2.patch` reverse-applies cleanly and
reproduces `6f39f82a…`, `65aa6f5b…`, `c7a58c9c…`, `12442b94…`, `546adce4…` and
the four adapter HEAD identities exactly; `production.patch` then reverse-applies
on top of that to the pre-unit content; both patch hashes and all 23 test-file
identities match `receipts/phase2/repair/identities.txt`, which matches the
tree — with the single exception in finding E.

## Unverified author claims after round 3

1. The **complete charged perimeter** — still unverified, unchanged reason; the
   core and adapter figures are reproducible and I reproduced them.
2. `scripts/raptor3-cli.test.mjs` and the three harness self-tests — still not
   run by either of us (`scripts/*.test.mjs` matches no project in the current
   `vitest.workspace.ts`, which another stream owns). Round 3 changed nothing
   under `scripts/`.
3. The two witness cells of §P.11.1 (SC-13, RF-16) — still diagnosed, not
   measured-as-fixed; the changed witness files belong to another stream.
4. §R2.10 item 5 (`expressions.integerDivide` never exercised on a PostgreSQL
   provider with RETURNING off) — **closed by this review**, 3/3 on the live
   container.
5. §R2.10 item 2 (the cascading half of falsifier 3) — the dependent-through-a-
   multiplied-key half is **closed by this review** on a non-RETURNING transport;
   no native cascading cell exists.
6. Newly qualified here: §R2.4's counts (finding C), §R2.7's `schema.ts`
   identity (finding E), and R-D1's reachability (finding D).
