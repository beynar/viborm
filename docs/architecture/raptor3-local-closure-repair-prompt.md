# Raptor 3 — repair the remaining consumption-boundary defects

Review of `bc18b4e2325a5f7dce1165e05a28482f78a83d72`, 2026-09-21.
This is the follow-up to the final local closure, **not the recursive-query plan**.

## Review verdict

**Request changes. The improvements and measurements are real, but “locally
ready; nothing pending” is not supported by the remaining behavior.**

The evidence audit verified the 38 retained gate logs, their hashes and reported
counts. The qualified integration commit and the squash have identical complete
`src`, `tests`, `scripts` and `benchmarks` Git trees. The source and bundle
reductions are real: 16,098 engine token-bearing lines, versus 16,040 before this
closure. R1 places the NULL-reference requirement with its actual consumer;
root captured mutations now carry their selector; neither needs another rewrite.

However, six focused native-provider falsifiers failed on unchanged production
source. They expose three repair families:

| Priority / family | Executed result | Why it matters |
| --- | --- | --- |
| P1 — unlocked FOUND observations | Three native MySQL cases: a parent connects to `b2` although its selector named `b1`; an upsert writes `42` after its `count: 7` condition changed to `8`; a nested upsert changes a profile after it moved to another owner. | The new post-UPDATE read proves existence, not the identity, membership and condition required by the effect. |
| P1 — nested membership after premises | On the existing PostgreSQL-backed forced batch profile, moving `m1` from `t1` to `t2` after the last premise still lets `t1` delete it. The original before-premises control passes. | D-65 bounds future joiners; it does not waive the membership required to consume a captured member. |
| P2 — result failure plus outcome-listener failure | Both captured UPDATE and DELETE publish only the listener error. The cardinality failure is lost and public progress is `undefined`, although part of the mutation committed. | The settlement boundary releases the listener failure before evaluating the operation's actual answer. |

The latter two families were executed on native PostgreSQL with the repository's
capability-forced batch fixture. They are **not** stock-pg route failures or live
Neon/D1 evidence. The three MySQL cases use the ordinary native interactive route.

The [retained review witnesses and logs](raptor3-evidence/g4/release/closure-review-bc18b4e23/README.md)
state exactly what was executed. These are review overlays, not registered
production regressions yet. Convert them into ordinary tests during the repair.

## Implementation prompt

Implement the bounded work below. Preserve the accepted engine, its measured
gains and unrelated work. Do not restart the architecture, complete recursive
queries, provision hosted services, push or publish. Hosted Neon and D1 remain
outside this checkpoint.

Read `ELEGANCE.md`, the applicable layer guides, the
[decided local-closure contract](raptor3-local-release-finish.md), and the review
receipts before editing. Preserve D-64, D-65's root/nested distinction, D-67's
no-deadlock-replay policy and the accepted performance decisions.

### 1. Repair the shared FOUND-consumption rule

**Necessary fact:** an unlocked observation may select a FOUND arm, but it does
not protect what that arm later consumes. A read after UPDATE is too late to
prevent a write to the wrong membership or a connection through a recycled key.

Start with `Selection`, `CommandExecution` and their existing requirement and
binding owners. Relevant baseline sites:

- `commands/selection.ts:240`: `query()` lets an INSERT-capable probe run unlocked.
- `commands/execution.ts:451`: retained requirements are only registered on the
  batch route.
- `commands/execution.ts:682`: matched condition requirements have the same
  route restriction.
- `commands/execution.ts:709`: a parent-held FOUND `connectOrCreate` without a
  found command forwards captured values.
- `shared/operation-context.ts:3035`: the interpreted UPDATE uses identity alone.
- `commands/relation-body.ts:935`: the new per-arm key demands detect a vanished
  row but do not express all continuing requirements.

Keep missing-key probes unlocked. Restore positive-observation protection at the
existing selection/requirement owner, **before effects depending on it**:

1. Confirm the exact located identity and the continuing requirements already
   owned by the operation: membership, parent identity, matched conditions and
   consumed references as applicable. Do not rerun a public selector and quietly
   adopt a replacement record.
2. On interactive execution, use a current/protected confirmation of the FOUND
   row under the existing transaction owner. Its lifetime must extend through
   the consuming effect. Reuse the established membership-confirmation path
   where it already provides this guarantee.
3. Spend the authoritative current reference binding for that same identity.
   Never reuse captured `G` to connect another row that acquired `G`. Preserve
   the existing current-value rules for legitimate earlier writes in the same
   operation; do not add comparisons against stale pre-sibling literals.
4. Where an established requirement has been lost, use its existing failure and
   attribution. Do not silently reselect, switch a previously selected arm or
   replay the transaction. Preserve conditional observation/legality ordering,
   skip semantics and the existing narrowly permitted batch recovery.
5. Do not turn every initial selection filter into a permanent requirement.
   In particular, D-65's nested worklist filter remains an admission/capture
   fact, not a continuing per-member filter.

The implementation must share the semantic requirement across placements while
using the actual substrate's mechanisms. Do not add a parent-held-only patch,
per-verb policy switches, a second interpreter or a general concurrency manager.

Required red-before/green-after schedules:

- **Reference reuse:** `b1(slug=chosen, code=G)` is observed; B commits
  `b1.code=M` and creates `b2(slug=unselected, code=G)`; A must never connect to
  `b2`. Use the witness's explicit `ON UPDATE CASCADE`: neither a valid
  before-B nor after-B connection to `b1` produces the observed wrong result.
  Use the existing identity/requirement contract, not a new target-selection rule.
- **Condition drift:** a found conditional upsert observes `count=7`; B commits
  `count=8` before A's effect; A must not apply the conditional update to `42`.
  Keep the established failure/skip distinction for an initially unmatched
  condition versus loss of a matched requirement.
- **Membership drift:** a to-one nested upsert observes `pr1` belonging to `o1`;
  B moves it to `o2`; A must not update it as `o1`'s profile.
- Cover parent-held and child-held FOUND consumers, root/nested placements,
  compound/mapped identity and reference keys, and borrowed execution. Preserve
  deleted-target witnesses, uncontended success, unique-key convergence,
  visible native deadlocks, once-only admission and caller-owned rollback.

Use deterministic hooks after the unlocked observation, **before the next
confirmation or effect**, so a correct locking repair does not deadlock a test
that waits for a concurrent write it now correctly blocks. Also retain a real
lock-held schedule to prove the protection lasts, rather than just moving the
test hook ahead of the race.

**Exit:** all three MySQL falsifiers are closed through the shared rule; the
existing missing-arm races still converge without absence locks or wider replay.
No valid uncontended operation becomes a new capability refusal.

### 2. Carry nested membership protection through its effect

The existing `pg-captured-set-concurrency` test checks a reassignment at
`before-premises`. Keep it. Add the same reassignment at
`between-premises-and-writes`; that one currently deletes `m1` incorrectly.

Own the repair in the existing membership/selection-to-mutation path. At baseline,
`CommandExecution.captureSeries` queues the requirement around line 1148, but
the consuming DELETE reaches `OperationContext.delete` around line 3484 with
identity alone. A requirement cannot expire after its earlier SELECT.

Protect the exact row, parent and reference/junction membership until consumption.
Use the existing adapter and transaction mechanisms; do not claim that an
earlier EXISTS statement, or a lock on a different row, proves a concurrently
mutable junction is still valid. If a predicate on the effect is the chosen
mechanism, test both a committed-between-statements change and an uncommitted
membership change whose commit the effect waits behind. A stale cross-table
snapshot is not protection merely because the check moved into SQL.

Preserve the decided distinctions:

- A future joiner stays outside the bounded worklist.
- An arbitrary initial filter may change after capture without removing that
  member from the worklist.
- A member that belongs to another parent cannot be written as this parent's
  member.
- No wider retry, no replay of acknowledged prefixes, no new implicit savepoint
  in borrowed work, and no invented rollback of a committed segment.

Exercise nested UPDATE and DELETE, reference and junction membership, and a
second applicable depth. Assert final database state, failure attribution and
truthful progress, not just rejection. Keep unit 1 and this unit under one
production author: these are related requirement lifetimes, not independent
permission frameworks.

**Exit:** the after-premises falsifier and cross-position witnesses pass while
the initial-filter and future-joiner controls retain their current behavior.

### 3. Settle the operation's answer before releasing listener failure

At baseline, `OperationContext.capturedMutation` calls `settleSubmitted` only
around response extraction. The row-count checks live later in `updateMany`
and `deleteMany`. A held write-outcome listener failure therefore escapes first.

Extend the **existing settlement owner** to include the actual semantic answer,
including captured cardinality and its progress attribution. Reuse
`retainWriteOutcomeFailure`; introduce no parallel error accumulator or public
metadata protocol. Keep the operation failure primary and retain the listener
failure according to the existing composition contract. Successful transport
does not imply successful result evaluation, and neither permits replay.

Convert the two retained public `onWriteOutcome` probes into normal regression
tests. They combine the current D-65 UPDATE/DELETE schedule with a throwing
listener. Assert:

- The established cardinality failure remains primary.
- The listener failure/cause remains available through the existing error model.
- The committed state is exact, and progress retains `atomicity: "segment"`,
  `phase: "result"`, and `committedSegments: 1` in these fixtures.
- No result is published and no acknowledged work is retried.
- A successful answer plus failed listener, and a failed answer plus successful
  listener, retain their existing behavior.

Check another existing consumer of the same settlement rule, including D-58
carry decoding. Do not replace independent observer semantics: this is the
write-outcome rail, not ordinary best-effort instrumentation.

**Exit:** both combined failures report the operation's real failure and outcome;
neither failure is discarded and the hold is released exactly once.

### 4. Close the two already-measured MySQL default gaps

These are **pre-existing migration defects disclosed by R2a**, not new engine
regressions. They still refuse ordinary valid declarations and should not be
hidden behind the green lane or counted as engine refusal reductions.

Repair only their existing MySQL migration owners:

1. String defaults containing backslashes/newlines must survive DDL spelling and
   catalog normalization without changing the value. The current backslash
   witness deliberately expects `MIGRATION_DRIFT` after MySQL stores a different
   default. Replace that containment pin with a successful round-trip once the
   owned defect is repaired; keep rejection of genuinely untranslatable catalog
   expressions. Do not weaken final attestation or change global SQL mode.
2. `.dateTime().now()` must use a default expression compatible with the resolved
   column precision. Do not scatter hardcoded `(3)` fixes or change the DateTime
   domain. The existing column/default owner must derive the expression from
   its resolved type. Check `.updatedAt()` only where its existing declaration
   shares this affected default rule.

For each: native initial push, unchanged no-op repush, actual declared schema
change and **raw INSERT omitting the column**. ORM admission defaults cannot
serve as the oracle for a database default. Retain apostrophe, Unicode, empty
string and applicable declared DateTime precision controls. Reuse the existing
strict-mode suite for supported SQL-mode assumptions; do not promise arbitrary
server modes that the ORM does not support.

Keep this unit outside the coupled engine files. It can run in a separate local
worktree alongside engine implementation, but native validation stays serial.

**Exit:** the two documented ordinary-declaration gaps are repaired at their
owners and the native schema-attestation protections remain intact.

### 5. Remove demonstrated duplication and correct the evidence

#### ELEGANCE and cost

The clearest violation is ELEGANCE §6: **an observation is not a lasting
requirement**. Repair that cause, not the four surface symptoms separately.

The shared FOUND rule should replace narrower arm-specific existence patches
where their guarantee is fully subsumed. Even before that repair,
`relation-body.ts:950–951` repeats a key demand already made by the broader
guard at `969–977` for the newly constructed binding. Remove that duplication
and consolidate its explanation; do not count comment removal as engine LOC
compression. Preserve key demands genuinely required for output or later effects.

For each repair, report the continuing invariant, its single owner, the old
branch/check that disappears, and a second applicable consumer. Do not promise
negative LOC before measurement. Recount engine, integration and other modified
shared owners separately against the **16,098 / 19,956 / 23,891** reference
denominators. No new rewrite, file splitting for its own sake or universal scope
object. Do not lower valid-operation coverage to reduce code or refusal counts.

#### Qualification and provenance

The final gate omitted two files registered in `provider-mysql2`:

- `tests/contracts/engine/query/decimal-wide-arithmetic-docker.test.ts` — 35 cells.
- `tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts` — 1 cell.

Their green receipts are from R2b's earlier source, not the final freeze.
735 passed / 1 skipped is accurate for the executed eleven files, not the whole
registered project. On the unchanged reviewed tree, adding those 36 cells would
make 771 passed / 1 skipped **if they pass**. Derive the repaired tree's actual
inventory; do not hardcode that total after adding tests.

The index's manifest digest excludes native entry files and imported fixtures.
For this checkpoint, complete Git tree equality establishes that the squash did
not change them. Record full test/source/script/benchmark tree identities and
relevant config/lockfile hashes alongside any narrower manifest digest. Name
each digest's scope and algorithm; do not present different algorithms as the
same harness identity. This provenance correction alone needs no rerun.

Correct the cost parenthetical in the old verdict through a dated correction:
the MySQL introspector is classified `excluded-shared-boundary`, **not**
`charged-integration`. Keep its cost visible separately. The 16,098 engine count
does not become false because that parenthetical was wrong.

State that the parity total 527 is project executions, not 527 independent
declared cases. Preserve historical receipts and the accurate performance gains.
Do not reopen D-60 because preparation cost remains accepted.

### Workflow and completion

Use the established production-author / independent-adversarial-review workflow.
Review stable units, return concrete findings to their owner, verify repairs, then
perform one integrated review. One author owns the coupled engine interfaces.
Parallelize isolated witness preparation, migration work and evidence audit;
never overlap imported-source edits with validation or run competing native lanes.

Run the focused falsifiers first. Require red-before/green-after evidence and
controls that distinguish a protected FOUND row from the old missing-key gap
lock. Do not consume another enormous full-gate cycle before these pass.

After all repairs and review, freeze source once and run the existing local
closure inventory, now including every registered MySQL file and the new
falsifiers. Retain typecheck, fixed/parity/conformance, G2, PGlite, native PG/MySQL
and the established receipt/harness checks under the existing resource ceilings.
Report skips by reason. Re-measure only affected performance cells and the final
source/bundle footprint using the existing protocol. Report any measured
regression honestly; do not invent a new budget or change a denominator.

Publish a new dated local verdict, update the decision/inventory records and
only the affected durable guide rules. Preserve the historical closure package.
Create one task-scoped local Conventional Commit of the reviewed work. Leave
the recursive-query documents and unrelated dirty files untouched. No push.

Completion means: six review falsifiers repaired through their existing owners;
missing-arm races and transaction authority preserved; the two bounded MySQL
schema gaps closed; complete final-source local evidence; and explicit costs and
deletions. It does not mean hosted qualification or recursive-query completion.

Apply the existing bounded repair/redesign stop rules. A need for a new
interpreter, broader replay authority or changed public semantics is a genuine
stop condition, not permission to hide the case behind a blanket refusal.
