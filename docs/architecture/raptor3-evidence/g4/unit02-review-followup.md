# G4-02 independent review — follow-up after REVISE

Reviewer: independent (did not author the unit, did not repair it).
Unit: `G4-02 physical/provider envelope (phase 1)`.
Round-1 review: [`unit02-review.md`](unit02-review.md) (verdict **REVISE**: 1
blocking, 4 must-fix, 6 notes).
Note (with the Repair section R.0–R.7): [`unit02/note.md`](unit02/note.md).
Patch: [`unit02/production.patch`](unit02/production.patch), SHA-256
`8295d338569b68a5e181754c0deba94d6c22e5dc83247ce6ddccc3334936d974`.

Receipts for this follow-up:
`docs/architecture/raptor3-evidence/g4/unit02-review-followup-receipts/`.

## Source identity (verified before and after every probe)

- `git apply -R --check production.patch` → **OK**; the patch touches exactly
  eight files, all inside `src/query-engine/raptor3/`.
- All eight SHA-256s in §R.6 match the tree byte-for-byte (`operation-context.ts`
  `65aa6f5b…`, `commands.ts` `12442b94…`, `commands/index.ts` `546adce4…`,
  `assignments.ts` `1e9b7c52…`, `execution.ts` `54646ed4…`, `schema.ts`
  `c7a58c9c…`, `storage.ts` `752215df…`, `program/index.ts` `4aeb2c14…`).
- `src/query-engine/raptor3/shared/query.ts` is still **unedited** at the
  reviewed SHA `1cd9bcd217bbb1de955cec389b0818c1af29788bc77172524a841f76c093910b`.
- Nothing staged, nothing committed; `src/client/client.ts` carries only the
  pre-existing G4-03 route seam and is absent from this unit's patch.

---

## Outcome

**ACCEPT.**

The blocking finding and all four must-fix findings are resolved, each pinned by
my own probes rather than by the author's. The repair's new production code —
`OperationContext.packagedPresence` — survived six adversarial cells it had never
been attacked with (full error identity including `meta`, index offset when the
packaged member is not first, two guards of different models in one batch, a
premise broken by a sibling statement, a projected fold present and missing, the
root `update` fold): the packaged failure is **identical to the shipped packaged
failure in class, code, message and meta**, and the array's siblings no longer
commit. The published read facts now agree with the value actually published
across a 21-shape matrix, and per-statement model attribution now equals the
shipped engine's exactly across six nested shapes.

Nothing I found this round changes a public answer, an error class/code/message,
committed state, or breaks a stated invariant. Four items go to the integrator as
notes; one is a documentation sentence in production code that is measurably
false, and one is a meta-key difference on a live path that is a pre-existing
candidate trait (proved by a control cell on verbs this unit never touched).

The root-`create` envelope divergence (candidate 2 statements / 1 transaction vs
shipped 1 / 0) stays exactly where it belongs: a recorded, evidenced decision for
Arnaud (§8.3, falsifier 5, §12.1, queued at §10.12), not an unnoticed gap.

---

## Per-finding status

### 1. BLOCKING — packaged root `delete`/`update` let array siblings commit → **RESOLVED**

`OperationContext.packagedPresence` (`shared/operation-context.ts:740-771`)
queues one `adapter.assertions.exists` over the same `PreparedSelector` ahead of
the folded mutation and declares it through the existing
`PreparedBatchOperation.guards` boundary, which the array owner re-indexes at the
merge offset (`src/client/array-transaction-native.ts:94-96`) and
`attributeOperationBatchError` reconstructs. It is queued only when
`ownership === "batch-preparation"` and a `single` failure exists, and only on the
returning branch — the locate-then-mutate branches still raise
`incompletePreparation`, so no stale guard can be left behind.

- My round-1 falsifier `packaged-cardinality.review.test.ts` now passes **3/3**.
- New: `repair-packaged-guard.review.test.ts`, 6 cells, 5 green (the sixth is a
  NOTE evidence cell, below). Measured, candidate vs shipped, on the same
  batch-only driver:

  | probe | candidate | shipped |
  | --- | --- | --- |
  | missing delete, 1 member | `NotFoundError` / `V6001` / `No author record found for delete` / `{model:"author",operation:"delete"}`; both rows survive | identical |
  | missing delete as the **middle** of three members | identical error, no sibling `create` committed | identical |
  | two folds, different models, second missing | `No tag record found for delete`, `meta.model:"tag"` | identical |
  | premise broken by a **sibling** statement in the same batch | `NotFoundError`, nothing removed | identical |
  | projected fold, row present | array commits, member value `[{email:"present@example.test"}]` | identical |
  | projected fold, row absent | `NotFoundError`, both rows survive | identical |
  | missing root `update` behind a sibling `create` | `No author record found for update`, sibling not committed | identical |

- The unit's own pin `tests/raptor3/g4/unit02/packaged-array.test.ts` (5 cells)
  passes, including the `[EXISTS guard, DELETE]` plan shape and `deleteMany`
  carrying no premise.

I chose to check the author's stated reason for preferring the guard over
refusing packaging, and it holds: refusing would have raised `TransactionError`
where the shipped engine raises `NotFoundError`, so the probe's second assertion
would still have failed.

### 2. MUST-FIX — B-4 dropped the nested model → **RESOLVED**

`statementContext` (`operation-context.ts:192-203`) returns the caller's context
only while the models agree and otherwise calls the snapshot owner's own
`deriveStatementExecutionContext` (`src/drivers/execution-context.ts:144-152`),
which keeps the correlation id, instrumentation and resolved extension chain —
the shipped `statementExecutionContext` rule exactly. `read()` gained the model a
statement addresses and the three `commands/execution.ts` locate sites name it.

- My round-1 probe `statement-context.review.test.ts` passes.
- New and stronger: `repair-statement-context.review.test.ts` compares the
  per-statement `context.model` **tally** with the shipped engine over six nested
  shapes. All six agree exactly:

  | shape | shipped | candidate |
  | --- | --- | --- |
  | nested update | `author×3, post×2` | `author×3, post×2` |
  | nested create | `author×2, post×1` | `author×2, post×1` |
  | nested connect | `author×2, post×2` | `author×2, post×2` |
  | nested delete | `author×2, post×2` | `author×2, post×2` |
  | nested upsert | `author×2, post×2` | `author×2, post×2` |
  | relation-bearing create | `author×2, post×1` | `author×2, post×1` |

§4.2's false sentence is corrected in the note, and
`borrowed-envelope.test.ts` now pins model-parity against the shipped engine
instead of "every statement carries the root model".

### 3. MUST-FIX — the envelope rule was not the operative decision → **RESOLVED**

- The `createMany` **row-count** gate is gone (`commands.ts:1103`:
  `values.length === 0 || (!recoverableSkip && (!projection || returning))`).
  Measured: `createMany` of 2 rows is now **1 statement / 0 transactions**,
  equal to shipped; my round-1 agreement cell for it passes.
- The sentinel is reachable and driven by an **executed** check: the bind-cap-8
  cell in `physical-envelope.test.ts` instruments `restart` and asserts
  `restarts === 1`, 2 statements, 1 transaction, each of 3 rows written once.
- `get statementAtomic()` is deleted — repo-wide grep finds no `statementAtomic`
  anywhere in `src/query-engine/raptor3/` or `tests/` (the two remaining hits are
  the unrelated `pattern/execute/index.ts`).
- The note's §5 D-a row, falsifier 5 and §12.1 table now carry the `createMany`
  and root-`create` rows and name the exception explicitly.
- New: `repair-envelope-sentinel.review.test.ts` (4 cells, all green) drives a
  second construction path and confirms an admitted one-statement form still
  shows `restarts 0`, 1 statement, 0 transactions.

Residual, and correctly handled: root `create` remains 2 statements / 1
transaction against shipped's 1 / 0. It is evidenced (§8.3: folding it stops the
G2.9 malformed-result witness from witnessing), no frozen fast-path workload is a
root `create`, and it is queued for Arnaud. My round-1 agreement cell for root
`create` therefore stays red **by design**.

### 4. MUST-FIX — §8.4 withdrawn-work failures had no receipts → **RESOLVED**

`receipts/withdrawn-operation-region/` now holds three genuinely failing runs,
labeled failed, exit=1:

| receipt | what it shows |
| --- | --- |
| `g3-suppression-retry.log` | **2 failed** — `TransactionError: Transaction scope for driver "sqlite3" cannot be used while its nested transaction is active` |
| `g3-scope-composition-pg.log` | **1 failed** — same error, driver `"pg"`, port 65504 |
| `g3-scope-composition-mysql.log` | **1 failed** — same error, driver `"mysql2"`, port 65515 |

The "4 savepoints instead of 3" claim is explicitly **withdrawn** in §8.4 as
never measured. The conclusion (a `memberRollback` grant is member isolation, not
an operation-region grant) is unchanged and now evidenced to the standard §8.3
already met. I re-ran all three modes on the repaired tree and they are green
(`g3-suppression-retry` 2/2, `g3-scope-composition-pg` 2/2,
`g3-scope-composition-mysql` 2/2), so the experiment was fully reverted.

### 5. MUST-FIX — published read facts wrong for `count`/`exist` → **RESOLVED**

`publishesSingleRow` is deleted (grep clean across `src/` and `tests/`).
`publishedFacts` (`commands/index.ts:78-86`) derives `{shape, single, empty}`
from the prepared `Read` itself via `read.result([])`, memoized beside the
handle's admission.

New: `repair-read-facts.review.test.ts` walks **21 read shapes** (relation
`include`, nested `select`, `_count` select, `take`/`skip`/`distinct`/`cursor`,
every aggregate accumulator, `groupBy` with `having`, both `count` forms, `exist`,
and both `…OrThrow` verbs). Result:

- `read.single` agrees with the value the read owner actually publishes in
  **every** shape (`count` → false / `0`; `exist` → false / `false`;
  `count` with a select → true / `{}`; `aggregate` → true / `{}`;
  `findMany`/`groupBy` → false / `[]`).
- `read.empty`'s kind matches the published value's kind in every empty case.
- `prepare().read` never throws — including the `…OrThrow` verbs, whose
  missing-row failure still arrives at execute time, not at prepare time.
- `prepared.read === prepared.read` (review note 10, fixed).

### 6–11. Notes from round 1

| # | Status |
| --- | --- |
| 6 — obligation 10 has no caller/test | **Open, correctly recorded as incomplete** in §R.7. Exercising it needs `src/client/client.ts` and the route file, neither owned by this unit. Not delivered, not claimed. |
| 7 — two public entries admit twice | **Claim scoped**, not changed: §4.1 now says "exactly once per prepared handle". My evidence cell stays red by construction. Acceptable; §11.1's route consumption removes it. |
| 8 — `deleteMany` "latent-bug fix" unfounded | **Fixed**: §4.4 now states that admission refuses a relation `select` on a bulk write and that `deleteMany` never reaches the arm. |
| 9 — two registered G4 modes red for witness reasons | Unchanged and still correctly attributed; the `route-admission.test.ts` delete knock-on is passed to the witness author in §R.7. |
| 10 — `prepared.read` a fresh object | **Fixed and verified.** |
| 11 — verified claims | Recorded. |

---

## New notes (for the integrator; none is a REVISE trigger)

**N1. A LIVE root `delete`/`update` on a transaction-less driver adds
`meta.recordSeriesProgress`; the shipped engine does not.**
`operation-context.ts:415-422` — `run`'s catch wraps the failure whenever
`usesBatch && committedSegments > 0`, which a folded root write on a batch-only
driver now satisfies. Class, code and message agree with shipped; only the meta
key set differs, and the **packaged** path (what a batch-only driver actually uses
inside `$transaction([...])`) is byte-identical to shipped. A control cell in the
same probe shows `create`/`createMany` — untouched by this unit — already diverge
the same way (`statementIndex`), so this is a pre-existing candidate trait newly
reachable through the new verbs, not a repair defect. Probe:
`repair-packaged-guard.review.test.ts`, the two cells labelled `NOTE evidence`
(red by construction).

**N2. `run`'s doc comment states a false fact about `createMany`.**
`operation-context.ts:396-398`: "two rows with different column sets are two and
raise the sentinel". Measured false — `schema.scalars` normalizes every row to the
same column set first, so three rows presenting different keys are **1 statement,
0 transactions, `restarts 0`** (equal to shipped), and even a row presenting no
columns beside a valued row is one statement on both routes. The only reachable
sentinel path today is the bind-budget split, which is the one the unit pins.
Probe: `repair-envelope-sentinel.review.test.ts` (cells 1 and 2, both green with
the measured values). One-sentence fix.

**N3. The guard record's `failure.message` never reaches a caller.**
`createFailureError` ignores it for `kind: "notFound"`
(`write-engine/OperationFragment.ts:261-263`); it is read only by
`sameAttribution` in `batch-error-attribution.ts`, where its per-model constancy
is what makes two same-verb guards agree. Correct as written, but worth one line
of comment at `operation-context.ts:757-762` so a future editor does not treat it
as user-facing text.

**N4. `PhysicalPlan.single` is still six per-verb boolean expressions.**
The repair gives it a coherent meaning (admissibility) and a falsifier for
"admitted but actually multi-statement" (the bind-budget cell). There is no
falsifier for the other direction — "refused though actually one statement" —
which costs an unnecessary envelope. Root `create` is exactly that case and is the
one recorded exception. Worth a falsifier when §10.12 is taken up.

**N5. Reviewer-estate typecheck diagnostic, fixed by me.**
The author correctly proved `envelope-rule-owner.review.test.ts(224,41)` TS2345
pre-existing in my estate and correctly refused to edit it. I fixed it
(`operation as Operations`) and the two diagnostics my new probes introduced. The
whole-estate typecheck is now clean apart from the two permitted
`src/query-engine/pattern/pack.ts` errors.

---

## What I re-ran

All serially through the bounded runner / raptor3 runner. Receipts in
`unit02-review-followup-receipts/`.

| Suite / mode | This follow-up | Author (repair round) | Round-1 review |
| --- | --- | --- | --- |
| review probe suite (11 files, 34 cells) | **28 passed / 6 failed** (all six are evidence cells red by construction: root-`create` exception, notes 7/8, and N1's two) | 15/4 over 7 files | 15/4 |
| G4-02 author checks (5 files) | **31 passed** | 31 passed | 24 passed (4 files) |
| `g4-read-contracts` | **58 / 4 failed** (same four inherited cells) | 58 / 4 | 58 / 4 |
| `g4-route-transactions` | **10 / 1 failed** (stale LX-04 D-2 pin) | 10 / 1 | 10 / 1 |
| `g4-route-admission` | **4 / 1 failed** (pre-existing `findFirst`) | 4 / 1 | 4 / 1 |
| `g4-route-cache` / `g4-route-lifecycle` | **6 / 7 passed** | 6 / 7 | 6 / 7 |
| `g4-lifecycle-events` | **1 / 2 failed** (route-owned, §11.2) | 1 / 2 | 1 / 2 |
| `g4-lifecycle-admission` | **3 / 1 failed** (route-owned, §11.1) | 3 / 1 | 3 / 1 |
| `g4-generation-selftests` | **6 passed** | 6 | 6 |
| `g1-contracts` / `g2-contracts` | **143 / 216 passed** | 143 / 216 | 143 / — |
| `g3-bulk-series` / `g3-suppression-retry` / `g3-transaction-array` / `g3-depth-recurrence` | **6 / 2 / 4 / 6 passed** | same | 6 / 2 / 4 |
| `g3p05-contracts` / `g29-result-progress` | **21 / 2 passed** | same | same |
| `g3-scope-composition-pg` (native, :65504) | **2 passed** | 2 passed | not re-run |
| `g3-scope-composition-mysql` (native, :65515) | **2 passed** | 2 passed | not re-run |
| `g4-read-envelope-pg-contracts` (native, :65504) | **2 passed / 2 failed** (DATE fixture defect + §10.8 recursive gap) | 2 / 2 | 2 / 2 |
| `node scripts/run-typecheck.mjs` | **2 permitted diagnostics only** (6.78 s, 5,801 MiB) | 2 + the reviewer-estate one | 2 permitted |
| `node scripts/credential-free-test-manifest.mjs` | **exit 0** | exit 0 | exit 0 |

Containers verified `Up` at the recorded identities and ports
(`7dfda37e8eea` postgres:16 on 127.0.0.1:65504, `d6da412eec3c` mysql:8 on
127.0.0.1:65515).

Not re-run in this follow-up (author-reported, carried forward): the PGlite
lanes, `prep` / `post-prep` / `transitions` / `expanded` / `core-structure`,
the `cs03` extension-campaign selftest (falsified as pre-existing in round 1,
§F2), the remaining native pg/mysql modes, and
`g4-read-envelope-mysql-contracts`.

### Cost — recomputed, exact

Census function of `scripts/query-engine-structure.mjs` (`countTokenLines`, JSDoc
and EOF excluded), current tree vs the pre-unit content reconstructed by
reverse-applying `production.patch`:

| | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| before | 8 | 142,598 | 4,344 | 4,288 |
| after | 8 | 167,117 | 4,926 | 4,633 |
| increment | 0 | **+24,519** | **+582** | **+345** |

**Exactly §R.6** (and the repair round's own +54 / +121 / +5,612 follows from the
round-1 figure of +291).

The candidate **core** figure is now reproducible, which it was not in round 1:
12 files, **319,209 bytes / 9,435 physical / 8,982 token-lines**, reproduced to
the byte from `receipts/repair/candidate-source-cost.json`; every per-file
SHA-256 in that manifest matches the tree, and its `censusFunctionSha256`
`15889231a22297fcf001ae22ca01e6e8c9cd7489dd635c60529dfdc0ac06461e` is the same
value the G3 accounting records in
`g3/structure-correction/qualified-final/support/source-cost.json`.

---

## §7 decision-elimination gate, re-answered against the repaired diff

1. **Necessary decision or representation repair?** Yes. The reconciliation I
   named in round 1 is gone: the envelope classification is now one rule
   (`run`/`dispatch`) plus a separate, differently-typed question
   (`Commands.plan`'s admissibility), and the second statement of the read
   cardinality (`publishesSingleRow`) is deleted rather than reconciled. The
   packaged presence premise is a second *substrate* for one premise, not a second
   interpretation of it — the shipped fold's own rule, and the two routes are
   measurably identical in error identity.
2. **Exact deletion and replacement obligation?** D-a's falsifier now passes for
   `createMany` and names root `create` as the exception. D-d's falsifier passes in
   full (model-parity, six shapes). D-b, D-c, D-e, D-f unchanged and still verified.
3. **One rule across uses?** Yes for the read-result owner, the set-oriented
   owner and now the envelope. `single` remains a per-verb predicate bag in form
   (N4), but it answers a different question than the rule and is falsifiable in
   the direction that matters.
4. **What actually grew?** +345 token-lines / +582 physical / +24,519 bytes over
   eight files, reproduced exactly. `statementAtomic` is gone; `restart()`,
   `performed` and `requiresEnvelope` are now load-bearing and exercised;
   `ResolvedSchemaViews` remains unexercised (note 6, recorded as incomplete).

No second public-syntax walker, per-verb codec, duplicated result-shape
preparation, recreated lifecycle, projection rebuilt for a decoder, JavaScript
arithmetic beside SQL, policy-boolean bag, per-feature interpreter,
fixture-named flag, legacy import, fallback, cached absence or public contract
change appears in the repaired diff.

---

## Unverified author claims (still labeled unverified)

1. The **complete charged perimeter** (13,850 token-lines / 16,803 physical /
   583,127 bytes / 30 files). The author now labels it UNVERIFIED and explains
   why (no charged-file manifest was saved, the perimeter reaches outside
   `src/query-engine/raptor3/`). Correct handling; still unverified here. The
   **core** figure is verified.
2. `g4-read-envelope-mysql-contracts` was not re-run in the repair round and not
   re-run here; the round-1 seed-time diagnosis (MySQL rejecting an ISO-Z literal
   for `DATETIME(3)`) is plausible and self-consistent but unverified.
3. "`flat-scalar-update` is byte-equal to the shipped engine" — verified as value-
   and cost-equal only; byte-equality of the emitted SQL is asserted by nothing I
   ran.
4. PGlite lanes, `prep` / `post-prep` / `transitions` / `expanded` /
   `core-structure` and the `cs03` selftest counts are author-reported for the
   repair round; I re-ran none of them in this follow-up (the `cs03` red was
   independently falsified as pre-existing in round 1 §F2).
5. The §8.4 experiment's "restored from a scratchpad copy, SHA-256 re-verified"
   procedure is attested by the note only. It is consistent with what I can
   check: all eight file SHAs match §R.6 and the patch still reverse-applies.

---

## Route-owned items the integrator still needs (unchanged, correctly recorded)

- `g4-lifecycle-events` (2 red) and `g4-lifecycle-admission` (1 red) need
  `src/query-engine/raptor3/route/client-route.ts` to pass `execution.context`
  and to consume `prepare().read` (§11.1/§11.2). That file is G4-03's.
- `g4-route-transactions` LX-04 is a **stale** divergence pin: D-2 is genuinely
  resolved and the witness owns `route-transactions.test.ts:404-414`.
- `tests/raptor3/g4/route-admission.test.ts`'s
  `note.delete({ where: { slug: "present" } })` now really removes the row, so its
  later `SELECT slug` assertion is unreachable-but-false. Witness-owned.
- Obligation 10 (`EngineConfig.resolved`) is undelivered pending `client.ts` and
  the route file.
- Root `create`'s envelope divergence is a decision for Arnaud (§10.12).

## Review probes (kept)

`tests/raptor3/g4/review/unit02/` — 11 files, 34 cells, run with

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit02/review.workspace.ts \
  tests/raptor3/g4/review/unit02/
```

New this round: `repair-packaged-guard.review.test.ts`,
`repair-read-facts.review.test.ts`, `repair-envelope-sentinel.review.test.ts`,
`repair-statement-context.review.test.ts`.
