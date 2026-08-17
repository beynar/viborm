# Relation-Bearing Bulk Capability and Round-Trip Plan

**Date:** 2026-08-12

**Status:** Implemented capability pass with measured prototype decisions;
final repository validation is recorded by the task report, not inferred here

**Starting architecture:** distinct-truth compression at commit
<code>0dc8306e68c5cfba26812a830c884708da626220</code>, stacked on the
record-series implementation at
<code>a04c59999e6a04a764108062af262f98c76d0b7e</code>

**Depends on:** only the retained outcomes of
[query-engine-distinct-truth-compression-plan.md](query-engine-distinct-truth-compression-plan.md):
<code>ModelKeyCatalog</code>, derived planning publication, orthogonal bound
relation axes, the mode-free <code>RecordSeriesOperation</code>, and the reduced
write-engine vocabulary. The rejected <code>CompiledSelection</code> prototype
and the unexecuted <code>OperationResultContract</code> phase are explicitly not
dependencies.

**Public API:** existing bulk methods gain the relation-bearing combinations
defined below; method names and success result types remain unchanged.
No-transaction drivers with native atomic batching can expose segment-atomic
progress; a strong committed callback makes that attribution precise before
result decoding, while an ambiguous weak-seam failure reports possible progress.

**Residual follow-up:**
[residual-write-limitation-lift-plan.md](residual-write-limitation-lift-plan.md)
records the delivered residual lifts, their measured provider boundaries, and
the restrictions that remain on top of this architecture.

## 1. Outcome

Complete the relation-bearing bulk surface, then reduce its latency and SQL
overhead while stating each provider's real commit boundary. Interactive
drivers preserve operation-wide atomicity. Batch-only drivers may trade that
atomicity for capability by executing one ordered record series as several
individually atomic committed segments.

The implementation must preserve this architecture:

~~~text
RecordSeriesOperation
  owns data-dependent, left-to-right record sequencing

CreateOperation
  owns one fresh record subtree

RecordUpdateCompiler
  owns one selected-record update

OperationFragment + OperationValueReference
  own statement order and value dependencies inside one record operation

ModelKeyCatalog
  owns the ordered complete row key

OperationFragment.outputs + ExecutableOperation.parse
  keep final output transport and parsing operation-specific

series-result-read
  owns K bounded final set reads and source-order reconstruction
~~~

The capability pass makes four decisions:

1. <code>skipDuplicates</code> on a relation-bearing root
   <code>createMany</code> suppresses the complete record subtree for a skipped
   root. It never adopts or mutates the conflicting row.
2. A nested relation-bearing <code>createMany</code> lowers its known rows
   through the existing fresh-record compiler in input order.
3. A nested relation-bearing <code>updateMany</code> captures its correlated
   target keys and runs the existing selected-record compiler once per target.
4. Batch-only drivers execute the same ordered record-series meaning with the
   strongest commit scope their transport supports. Any no-transaction driver
   with native atomic batching can run a safe series after each prior batch
   returns normalized success. One public operation may therefore commit several
   segments, and a later failure can leave earlier segments committed.

The retained performance change replaces N final per-row result reads with K
bounded set reads, normally one. It does not claim a measured network-latency
improvement. Provider requests depend on the concrete driver and deployment.

Three objective prototypes were not retained. Terminal row-key publication had
no owner that could also prove the root was still live. The installed libSQL
SDK did not report the exact failing statement index needed to preserve failure
attribution. PostgreSQL writable CTEs could not preserve ordered sibling
visibility and the existing first-failure contract. Static fragment batching
remains deferred rather than being built on either rejected premise.

The dynamic series remains the semantic reference implementation. Batch drivers
do not gain a second mutation language: they run the same ordinary record
compilers and commit at record-series segment boundaries.

### 1.1 Delivery record

This table records the original package checkpoint. Section 1.2 and the live
acceptance criteria in section 24 supersede its provider-specific limits.

| Package | Outcome | Durable result |
|---|---|---|
| A | Retained in part | Transport and statement censuses are pinned. No remote-latency number is claimed because no representative remote benchmark was run. |
| B | Retained | A skipped relation-bearing root suppresses its complete record subtree on an interactive transaction substrate. |
| C | Retained | Nested relation-bearing `createMany` reuses `CreateOperation` through one nested record-series placement. |
| D | Retained | Nested relation-bearing `updateMany` captures exact correlated targets and reuses `RecordUpdateCompiler`. |
| E | Retained | Returning series use K bind-budgeted set reads, normally one, and reconstruct exact source order. |
| F | Rejected | A final key is not a sufficient replacement for the terminal read without one owner that also proves root liveness. No partial demand abstraction survives. |
| G | Rejected | The installed libSQL SDK does not provide an exact failing-statement index for native batch failure attribution. |
| H | Deferred | Static fragment batching remains possible future work, but no transport abstraction was added without a truthful G result. |
| I | Retained | D1 runs root and exactly guarded nested record series as ordered committed atomic segments. Unsupported placements fail closed. |
| J | Rejected | PostgreSQL writable CTE siblings do not provide the required sequential visibility or first-failure semantics. |
| K | Deferred | No cross-member relation probe cache or speculative update-series fold was added. |
| L | Retained | Public and internal documentation state the shipped API and provider commit boundaries. |

### 1.2 Current remaining restrictions

- A root-first skippable fresh-record member can run on a batch driver: the root
  write is isolated, and zero inserted rows suppress every descendant. A write or
  nested `RecordSeriesStep` before that skippable root remains a typed pre-effect
  refusal because suppression would strand the earlier effect. A many-to-many
  member is routed independently: a vacuous flag is dropped and one exact selector
  adopts and links.
- One child-held target cannot be moved to more than one parent by one
  `updateMany`; the child stores one parent membership.
- A nested series on any batch driver runs only when the compiler can re-assert
  the complete parent or membership premise in each later batch. Other
  placements fail closed before their containing member writes.
- D1 can carry one database-generated integer identity across a segment through
  the binding's official per-statement `meta.last_row_id`, normalized as
  `QueryResult.insertId`. The engine never infers adjacent or ranged IDs.
- A dynamic record series cannot be placed inside explicit
  `$transaction([...])`, because that API promises one atomic batch.
- A driver with neither an interactive transaction nor native atomic batching
  still refuses dynamic relation-bearing series.
- Returning bulk projections remain scalar-only.
- No native libSQL batch optimization, terminal-read elision, PostgreSQL
  whole-series writable CTE, or inferred generated-ID arithmetic was added.

## 2. Why this plan exists

### 2.1 The current implementation is correct

Relation-bearing bulk writes already work across transaction-capable
PostgreSQL, MySQL, and SQLite drivers.

The engine models a relation-bearing <code>createMany</code> as N ordinary
<code>CreateOperation</code> instances executed from left to right in one
transaction. It models a relation-bearing <code>updateMany</code> as one locked
root-set capture followed by N ordinary selected updates in deterministic key
order.

That sequencing is necessary. Member N may need to observe effects from member
N−1:

~~~text
row 0: connectOrCreate(label = "shared")
  probe: missing
  create label

row 1: connectOrCreate(label = "shared")
  probe: found because row 0 already created it
  connect existing label
~~~

Planning both rows before either write would make both probes miss. The second
row would try to create the same target, and a retry of the whole rolled-back
series could repeat the same stale decision forever.

The work here therefore targets redundant transport, not semantic sequencing.

### 2.2 Atomicity and capability are separate provider contracts

One SQL command is not inherently safer than several statements in one
transaction. An interactive transaction already gives all-or-nothing effects.
Conversely, several committed native batches cannot provide that guarantee,
even when every individual batch is atomic.

A smaller command count primarily improves:

- network latency;
- driver and protocol overhead;
- SQL parsing and planning work;
- instrumentation volume;
- JavaScript result handling.

It must not be described as an integrity fix unless a separate correctness
defect is proved.

For a no-transaction native-batch driver, the implementation chooses successful-
operation capability over operation-wide rollback for dynamic record series. The
contract is:

- each submitted batch is atomic;
- batches execute in record-series order;
- a provider-confirmed atomic rollback leaves that batch unapplied; an ambiguous
  dispatched failure is reported as possibly committed;
- earlier successful batches remain committed;
- the thrown error reports committed or possibly committed progress according to
  the driver's acknowledgement seam;
- automatic retry never replays a committed segment.

Normalized batch success is enough to continue. The strong
`supportsOrderedCommittedSegments` capability adds a callback after provider
resolution but before result decoding, which gives exact commit attribution at
that earlier boundary; it is not the eligibility gate for progressive execution.

This is **segment-atomic execution**, not operation-atomic execution. Public
documentation must use those terms and must not imply transaction parity.

### 2.3 PostgreSQL, MySQL, and SQLite have different composition powers

PostgreSQL can feed an INSERT result into later DML inside one command:

~~~sql
WITH parent_record AS (
  INSERT INTO parent (name)
  VALUES ($1)
  RETURNING id
),
child_record AS (
  INSERT INTO child (parent_id, body)
  SELECT parent_record.id, $2
  FROM parent_record
  RETURNING id
)
SELECT id
FROM parent_record;
~~~

MySQL and SQLite cannot express the same writable-CTE graph.

- MySQL <code>LAST_INSERT_ID()</code> returns one generated identity. It does
  not turn two INSERT statements into one statement or return an ordered
  row-to-identity map for a multi-row INSERT.
- SQLite <code>last_insert_rowid()</code> returns the most recent row identity.
  SQLite RETURNING output cannot feed another DML statement or a writable CTE.
- Inferring N generated IDs from a first or last ID is invalid. Gaps, triggers,
  explicit IDs, skipped rows, allocator configuration, and compound keys break
  the arithmetic.

Identity transport and SQL-command composition are different facts. VibORM
already transports one generated identity between sequential statements. This
plan does not pretend that transport makes MySQL or SQLite writable-CTE
databases.

## 3. Measure four different costs

The word “round trip” is too imprecise for this work. Every benchmark and test
report must record four values separately.

| Metric | Meaning |
|---|---|
| SQL statements | Individual SELECT, INSERT, UPDATE, or DELETE statements executed by the database |
| Driver body calls | Calls to the driver's single-query or batch execution body |
| Provider requests | Actual remote protocol or HTTP requests |
| Transaction envelope | BEGIN, COMMIT, ROLLBACK, savepoint, and release protocol work |

Examples:

- A native D1 batch may contain six SQL statements in one driver batch call and
  one provider request.
- The default transaction-driver <code>_executeBatch</code> loop still sends
  one provider call per statement.
- Embedded SQLite has SQL statements and driver calls but zero network round
  trips.
- A remote transaction normally adds BEGIN and COMMIT requests around the body.

No result may say “one round trip” merely because the executor called
<code>_executeBatch</code> once.

## 4. Current measured baseline

The counts below are engine-visible SQL statements. They exclude BEGIN and
COMMIT. Let N be the number of root records.

### 4.1 Scalar fast path

~~~text
createMany({
  data: [
    { id: 1, title: "a" },
    { id: 2, title: "b" },
  ],
})
~~~

Same-shape scalar rows use one multi-row INSERT:

~~~text
SQL statements = 1
~~~

This path is already correct and fast. It is a permanent non-regression
baseline.

### 4.2 Relation-bearing create series

~~~text
createMany({
  data: [
    { title: "a", children: { create: { body: "a1" } } },
    { title: "b", children: { create: { body: "b1" } } },
  ],
})
~~~

On MySQL, SQLite, or an ineligible PostgreSQL member:

~~~text
for each root:
  INSERT root
  INSERT child using root identity
  SELECT final root key

count arm:
  3N statements

select arm:
  the 3N member statements
  + N final public-result reads
  = 4N statements
~~~

When each PostgreSQL member qualifies for the existing create-tree CTE fold:

~~~text
for each root:
  one writable-CTE command

count arm:
  N statements

select arm:
  N member commands
  + N final public-result reads
  = 2N statements
~~~

The entire root <code>createMany</code> is not currently one PostgreSQL CTE.
Only each qualifying member is folded independently.

### 4.3 Parent-held before-root create

~~~text
for each root:
  INSERT or locate the parent-held target
  INSERT root carrying that target key
  SELECT final root key
~~~

The root INSERT is not first, so the current PostgreSQL create-tree fold
declines.

~~~text
count arm = 3N
select arm = 4N
~~~

### 4.4 Child-held connect

A simple child-held connect normally adds a membership write:

~~~text
for each root:
  probe target
  INSERT root
  UPDATE child membership
  SELECT final root key

count arm = 4N
select arm = 5N
~~~

The exact count varies with the ordinary single-record relation path. The
series does not add its own mutation statements; it adds only key/result
transport around the ordinary member.

### 4.5 Data-dependent connectOrCreate

For N=2 in the measured mixed found/missing case:

~~~text
count arm = 7 statements
select arm = 9 statements
~~~

These members must remain left-to-right. This plan may remove redundant
terminal and final reads, but it may not pre-plan the two branches.

### 4.6 Relation-bearing update series

For the measured N=2 parent-held connect case:

~~~text
capture and lock root set                    1
member 0 locate + probe + update + terminal 4
member 1 locate + probe + update + terminal 4
count total                                  9

public final reads                           2
select total                                11
~~~

The initial root capture is necessary. It fixes the selected set before member
effects can change the caller's filter.

### 4.7 Direct polymorphic createMany connect

Direct polymorphic connect-only rows use an intentional grouped fast path, not
a record series.

For three rows spanning two discriminator variants:

~~~text
two grouped target probes
one grouped root INSERT
= three SQL statements
~~~

This path remains unchanged.

## 5. Target cost model

Let:

- N be the number of record-series members;
- K be the number of final-read chunks required by the provider's bind
  parameter budget, normally 1;
- Bᵢ be member i's necessary statements excluding its terminal key/liveness
  read;
- C be the root-set capture cost, 0 for createMany and normally 1 for
  updateMany.

Starting point:

~~~text
count  = C + Σ(Bᵢ + 1)
select = C + Σ(Bᵢ + 1) + N
~~~

Delivered:

~~~text
count  = C + Σ(Bᵢ + 1)
select = C + Σ(Bᵢ + 1) + K
~~~

Savings:

~~~text
select saves N - K statements
~~~

The per-member terminal read remains. It is a liveness witness, not redundant
key transport: a later member can delete or re-key an earlier root. Work package
F was rejected because no existing owner could prove that liveness after all
later effects. The only shipped statement reduction in this pass is N to K for
the public final reads.

For D1, statement reduction and request reduction are separate. A progressive
series normally uses:

~~~text
provider write requests = committed ordinary segments
provider read requests  = planning/capture reads + final result reads
transaction envelope    = 0
operation atomicity      = segment
~~~

An eligible static D1 series may still collapse to one provider request. The
benchmark must report which route ran; it must not average the two contracts
together.

## 6. Fixed architecture

### 6.1 Keep two semantic execution forms and make series composable

~~~ts
type RoutedExecutableOperation =
  | ExecutableOperation
  | RecordSeriesOperation;
~~~

Root routing keeps those two forms. Nested relation-bearing
<code>updateMany</code>, however, needs to suspend one record tree at an exact
ordered position, capture N targets, execute N ordinary record operations, and
then resume the tree. The existing one-planning-phase Part contract cannot
express that sequence.

Authorize one exact placement fact:

~~~ts
interface RecordSeriesStep {
  readonly id: string;
  readonly kind: "recordSeries";
  readonly series: RecordSeriesOperation;
}
~~~

The final <code>OperationStep</code> union may contain this step. Planning
fragments may not. On an interactive driver, the executor runs it on the
already-open transaction and never opens a nested transaction. On a batch-only
driver, the step is a legal commit boundary: the executor flushes the preceding
ordinary steps as one atomic segment, executes the nested series, and then
continues with a later segment. A member may itself compile a
<code>RecordSeriesStep</code>, so arbitrary relation depth reuses the same
series semantics.

The compression baseline already removed
<code>RecordSeriesOperation.mode: "transaction"</code>. Preserve that result:
series is a semantic sequencing fact, not a substrate declaration. Extend the
executor to select:

- interactive execution when the driver offers a callback transaction;
- one static atomic batch when the complete series already satisfies the
  existing atomic-batch contract;
- ordered segment-atomic execution when the driver offers ordered atomic
  batches but no interactive transaction;
- a typed refusal only when a required boundary cannot be lowered with its exact
  compiler-owned premise, or when suppression would strand an earlier effect.

This is one new runtime placement for the already-existing execution form. It
is not a third mutation compiler, a generic continuation callback, or a
transaction AST. Root and nested series must call one executor-owned
<code>runRecordSeries</code> implementation.

Do not add:

- BulkProgram;
- BatchGraph;
- RecordSeriesPlan;
- a bulk mutation DSL;
- a third operation form;
- a mutation strategy table;
- lifecycle callbacks;
- before/after hooks;
- placement booleans.

### 6.2 Separate semantic sequencing from transport

The engine must recognize these layers:

~~~text
semantic sequencing
  RecordSeriesOperation decides when member N may be planned

statement dependency
  OperationFragment and OperationValueReference order one member's statements

transport
  a driver may send already-selected statements in one native ordered batch

SQL folding
  a provider may lower a proven static write graph into one SQL command

segment-atomic execution
  a batch-only provider may execute the same semantic series as ordered,
  separately committed atomic batches
~~~

A transport optimization cannot make a dynamic series static. Segment-atomic
execution keeps JavaScript decisions at their ordinary ordered positions. It
preserves successful-operation order and branch visibility, but deliberately
does not promise operation-wide rollback after a prior segment commits.

### 6.3 Reuse only the retained compression owners

This plan executes on <code>0dc8306e</code>. Its live owners and boundaries are:

- ModelKeyCatalog owns the complete ordered row key.
- PlanningFragment contains only statement steps; OperationExecutor derives
  every declared planning output at <code>planningKey(stepId, output)</code>.
- BoundRelation expresses topology through orthogonal
  <code>position</code>, <code>cardinality</code>, and
  <code>membership</code> facts. Bulk lowering consumes those axes and never
  reconstructs the deleted cross-product kinds.
- Final <code>OperationFragment.outputs</code> remains explicit, and each
  <code>ExecutableOperation.parse()</code> remains the parser for that concrete
  operation.
- The existing select builders own SQL projection and ResultParser owns result
  decoding. They remain separate because the measured CompiledSelection
  prototype added 101 physical lines and regressed representative reads and
  mutations by 6–9%.

Phase 10's <code>CompiledSelection</code> was rejected and Phase 11's
<code>OperationResultContract</code> therefore did not run. Do not revive either
as a prerequisite and do not recreate them under bulk-specific names.

Work package F did not pass its keep gate. The existing terminal read and
<code>suppressTerminal</code> fact remain. No `RecordResultDemand`, series-key
carrier, or generic result contract was added.

Do not introduce:

- SeriesIdentity;
- CapturedSeriesKey;
- BulkRowReference;
- an identity tuple;
- another selection descriptor;
- another result-mode boolean;
- a generic operation result contract.

### 6.4 Add one unavoidable provider-capacity fact

There is currently no owner for a provider's maximum bound parameters per
statement. A grouped result read cannot safely assume that an arbitrary N fits
one statement.

Add one driver-owned conservative capacity:

~~~ts
abstract readonly maxBindParametersPerStatement: number | undefined;
~~~

The exact spelling may follow the live driver capability style.

Rules:

- The driver, not the query engine or SQL builder, owns the value.
- Each built-in driver uses a verified conservative capacity for its actual
  provider/runtime.
- <code>undefined</code> means “unknown”; the optimizer keeps one row per read
  rather than guessing.
- Chunking counts every value in the compiled SQL, including projection
  expressions, filters, and row-key predicates.
- A single-row query that already exceeds the declared budget follows the
  existing single-row behavior; the chunker must not loop or hide the error.

This is capacity metadata, not an execution abstraction.

### 6.5 Make the commit scope explicit

One public operation may have one of two execution contracts:

~~~text
interactive driver
  any number of reads and writes inside one callback transaction
  commit scope: complete public operation

batch-only driver
  ordered planning and atomic write segments
  commit scope: one segment
~~~

Prefer one atomic batch whenever the complete operation already lowers to one.
Do not introduce conditional SQL solely to force dynamic work into that shape.
Without an interactive transaction, a native-batch driver executes safe work as
several committed segments and documents committed or possibly committed progress.

Every premise learned before a segment is rechecked inside that segment when
the existing compiler requires it. A stale premise rolls back the current
segment. Once any earlier segment has committed, the executor must not retry
the complete public operation.

### 6.6 Segment execution reuses ordinary operations

The progressive batch route consumes the same planning and final fragments produced by
<code>CreateOperation</code>, <code>RecordUpdateCompiler</code>, and relation
Parts. It does not re-derive BoundRelation's position, cardinality, or
membership axes and does not introduce a conditional mutation compiler.

At a batch-only execution boundary:

1. Run the ordinary planning reads for the next record or nested series.
2. Compile only the selected arm with the existing compiler.
3. Submit that member or contiguous ordinary fragment as one atomic batch.
4. Attribute provider failures to the existing guards, pins, and root write.
5. With the strong callback, acknowledge and invalidate after provider resolution
   but before result decoding. Otherwise, returned normalized success establishes
   segment completion and then triggers invalidation.
6. Continue from the new database state. A weak-seam failure after dispatch is
   conservatively reported as possibly committed and suppresses whole-operation retry.

The executor coordinates segment boundaries; adapters still own SQL and
drivers still own transport. No scratch workset, SQL activation predicate,
branch token, or second mutation representation is added.

## 7. Hard semantic barriers

The following shapes forbid naive preplanning or whole-series transport
batching. They use left-to-right execution: inside one transaction when the
driver supports it, or across ordered native-batch segments otherwise.

### 7.1 Planning that may observe a predecessor

Do not pre-plan as though predecessor writes did not exist:

- connectOrCreate;
- upsert;
- connect when an earlier member can create, move, or delete its target;
- update or delete target probes;
- membership probes;
- same-target duplicate-sensitive work;
- any selector whose answer can change after a predecessor.

On a no-transaction batch driver, the probe for such a decision executes after
the predecessor segment returned normalized success. JavaScript selects the arm,
the existing compiler emits it, and the selected member runs in the next atomic
batch. This is why the route has branch parity on success but only segment
atomicity on failure.

### 7.2 Guards and postconditions

A native batch cannot move later effects ahead of a JavaScript guard or
postcondition.

Ordinary native-batch eligibility still requires:

- no GuardStep;
- no mid-batch <code>expects</code>;
- no <code>onUniqueConflict: "skip"</code>;
- no unresolved branch decision;
- no race pin whose exact statement attribution the native driver cannot
  preserve.

A later provider-specific prototype may admit postconditions only if it proves:

1. every statement result remains available;
2. the first failing premise keeps precedence over every later provider error;
3. the error class, message, metadata, constraint, and statement attribution
  remain exact;
4. failure occurs before outer COMMIT.

“The transaction can roll back” is necessary but not sufficient. Error order is
part of the contract.

For progressive batch execution, every legality guard that must prevent a write keeps
the existing in-batch assertion lowering. A provider failure rolls back that
member batch before the executor advances. A parse or result-integrity failure
detected only after a successful batch counts that batch as committed and
reports it in progress metadata. Neither case can roll back an earlier
committed member.

### 7.3 Retry follows the commit boundary

On an interactive driver, a raceable member failure rolls back:

- the root capture;
- every completed predecessor;
- the failing member;
- every selected statement in the current attempt.

The routed retry owner may then retry the complete series once.

On a segment-atomic driver:

- before the first committed segment, the existing complete-operation retry is
  still legal;
- after any segment commits, never retry or replay the complete series;
- a failing current segment may be replanned and retried once only when that
  whole segment rolled back, its race pin is exact, and replay cannot duplicate
  an external effect;
- otherwise throw immediately with the committed segment/member prefix.

Never hide partial progress by returning a shortened successful result.

### 7.4 Final projections

Public result reads run after every member effect.

They use K bounded set reads, normally one, after the series completes. The
engine then restores source order and fails exactly when a promised root is
missing. The rejected PostgreSQL whole-series CTE cannot replace this boundary:
data-modifying siblings share one command snapshot and do not provide the
series' ordered visibility or first-failure semantics.

### 7.5 Generated identities

Never:

- infer a range from MySQL LAST_INSERT_ID;
- infer a range from SQLite last_insert_rowid;
- assume generated IDs are gap-free;
- use one insert ID as the value of an arbitrary generated field;
- assume output row order from a multi-row RETURNING statement;
- flatten a compound row key into one scalar.

Use existing field-bound publication and OperationValueReference values.

### 7.6 skipDuplicates with nested effects

The product meaning is fixed:

> A skipped root suppresses its complete record subtree.

It never adopts or mutates the conflicting row.

Rules:

- Pre-existing collision: no root, before-root, descendant, junction, connect,
  or adoption effect from that input row remains.
- Duplicate input rows: the first row that inserts wins; later colliding rows
  and their complete subtrees are skipped.
- <code>count</code> is the number of inserted roots.
- <code>select</code> returns inserted roots only, in input order.
- Only a unique conflict from that member's root INSERT is skippable.
- A descendant conflict, validation failure, guard failure, or unrelated
  provider error aborts the complete operation.
- A concurrent root winner has the same outcome as a pre-existing collision;
  it is skipped, not adopted and not retried as a missing-arm race.
- Skipped roots publish no identity. Inserted roots use existing field-bound
  generated and compound key publication.

On an interactive driver, place the complete member subtree inside one
savepoint. A root skip rolls back that savepoint and continues the outer
series. If a before-root descendant fails before execution reaches the root
INSERT, that existing first failure remains an error; do not add a speculative
root uniqueness probe merely to reorder failures.

On a batch driver, a safe skippable member starts with an isolated root INSERT.
The executor inspects that statement's exact row count: zero suppresses the
complete descendant subtree, while one permits the descendants to run in later
guarded segments. A descendant conflict remains fatal. If any write or nested
<code>RecordSeriesStep</code> must precede the skippable root, refuse the member
before the operation's first write; a later root skip would otherwise strand the
earlier effect.

### 7.7 Relation-bearing updateMany

Do not attempt a whole-series update CTE in this plan.

The remaining series shapes are exactly the hard shapes:

- old-read/new-write primary-key transitions;
- parent-held folds inside each root UPDATE;
- descendants ordered before and after each root;
- self-relation moves and deletes;
- failure attribution to one captured root;
- later members observing earlier effects.

Scalar-only updateMany already has its set-oriented fast path.

One existing refusal remains a cardinality truth. When N greater than one roots
match, a non-empty child-held <code>connect</code>,
<code>connectOrCreate</code>, or <code>set</code> cannot assign one named child
to every root because the child stores one parent identity. Keep the refusal.
Continue accepting N equals one, parent-held edges, junction edges, fresh child
creation per root, and empty target collections.

### 7.8 Nested relation-bearing bulk

A record tree is one root record plus its nested mutation subtree. A record
series is an ordered sequence of those ordinary trees whose members may plan
after predecessor effects.

Nested relation-bearing <code>createMany</code> has an application-known row
list. Each row becomes one existing fresh-record operation with the enclosing
membership injected. Scalar-only nested <code>createMany</code> keeps its grouped
INSERT. Relation-bearing rows are never regrouped.

Nested relation-bearing <code>updateMany</code> executes at the relation Part's
existing ordered position:

~~~text
prefix effects
  -> capture matching correlated targets once
  -> sort complete row keys
  -> one RecordUpdateCompiler member per captured target
  -> suffix effects
~~~

The capture uses the parent identity valid at that position: the old referenced
value for pre-transition membership reads and the final value for post-transition
writes. Empty capture is a no-op. On an interactive driver, a member failure
rolls back the parent and all completed members. On a no-transaction batch driver,
the prefix and completed members remain committed and the failure reports exact
or possible progress according to the acknowledgement seam.

### 7.9 Batch-only dynamic work

A native batch contains a fixed number of prepared statements, but one public
operation may submit several batches. Therefore dynamic cardinality is no
longer a substrate refusal:

- known nested create rows become ordinary fresh-record members;
- root updateMany captures keys, then submits one selected-update member at a
  time;
- nested updateMany captures its correlated keys at the exact series position,
  then instantiates the ordinary selected-record compiler once per key;
- generated values flow through the existing per-member output references;
- later planning observes every committed predecessor.

The remaining refusals are semantic: every crossed boundary needs its exact
compiler-owned continuation premise, and a skippable root cannot follow a write
whose effect it might strand. Explicit <code>$transaction([...])</code> arrays
remain one indivisible batch and never take this progressive route.

## 8. Execution protocol

> **Historical package record.** Sections 8–23 retain the D1-first design and
> delivery language from the implementation checkpoint. D1 was the first proved
> progressive provider. Current eligibility is capability-based: any
> no-transaction driver with native atomic batching may run a safe series after
> normalized success; `supportsOrderedCommittedSegments` adds callback-before-
> decode attribution. Current restrictions are in §§1.2, 6, 7, and 24. D1-only
> refusal statements inside the package record are historical, not live gates.

### 8.1 Preflight

Before implementation:

1. Run <code>git status --short</code>.
2. Stack the implementation branch on
   <code>0dc8306e68c5cfba26812a830c884708da626220</code> and record
   <code>git rev-parse HEAD</code>.
3. Preserve every unrelated dirty and untracked file.
4. Confirm the retained state of:
   - ModelKeyCatalog and its ordered <code>rowKey</code>;
   - planning output derivation with no PlanningFragment output map;
   - mode-free RecordSeriesOperation;
   - BoundRelation's position/cardinality/membership axes;
   - explicit final OperationFragment outputs and operation-local parsing.
5. Confirm there is no production <code>CompiledSelection</code> or
   <code>OperationResultContract</code>. Their absence is the expected baseline,
   not missing work.
6. Rebase every file name and interface in this plan to that retained state.
7. Confirm the CUID2 3.3.0 lazy-initialization repair remains present and the
   D1 provider suite still collects and passes before changing D1 execution.
8. Record three warm <code>pnpm test:types</code> timings.
9. Run the green baseline through the repository's memory-capped launchers.

Do not recreate a rejected abstraction under a bulk-specific name. Work package
F failed its keep gate, so the current terminal reads remain and no partial
demand abstraction survives.

### 8.2 Change discipline

- Complete work packages in order.
- Keep each numbered unit independently revertible.
- Use the ordinary record compilers; never copy their relation logic.
- Preserve scalar fast paths byte-for-byte.
- Preserve every previously accepted fallback plan byte-for-byte. Replace only
  the refusals explicitly lifted by B–D and the D1 routes explicitly proved by
  I.
- Run tests sequentially through package scripts.
- Never run overlapping Vitest or TypeScript processes.
- If an objective prototype fails, remove only that prototype and continue to
  the next independent unit.

### 8.3 Required instrumentation

Add a test-only transport census that records:

~~~ts
interface TransportCensus {
  readonly sqlStatements: number;
  readonly executeCalls: number;
  readonly nativeBatchCalls: number;
  readonly providerRequests: number | "not-measured";
  readonly atomicity: "statement" | "operation" | "segment";
  readonly committedWriteSegments: number;
  readonly transactionEnvelope: {
    readonly begin: number;
    readonly commit: number;
    readonly rollback: number;
    readonly savepoints: number;
  };
}
~~~

This is test instrumentation, not a production query-engine type.

PGlite and embedded SQLite may assert SQL shape and driver calls. They may not
claim remote wire behavior.

## 9. Work package A — Pin the transport baseline

### A1. Extend existing behavior suites

Use the rebuilt suites:

- <code>create-many-relation-series.test.ts</code>;
- <code>update-many-relation-series.test.ts</code>;
- <code>mutation-dependency-fold.test.ts</code>;
- <code>batch-round-trip-baseline.test.ts</code>;
- <code>record-series-contract.test.ts</code>;
- <code>parity-j-create-many.test.ts</code>.

Add N=1, 2, 10, and 100 witnesses for:

- pure child-held nested create;
- nested scalar createMany;
- parent-held before-root create;
- child-held connect;
- M2M create/connect;
- duplicate connectOrCreate;
- upsert found and missing arms;
- application-known IDs;
- one generated ID;
- compound row keys;
- referenced non-primary keys;
- count versus select;
- updateMany parent-held mutation;
- updateMany child-held mutation;
- primary-key transition;
- later-member move;
- later-member delete.

Pin:

- SQL statement count;
- driver call count;
- execution atomicity and committed write-segment count;
- planning/final step IDs and order;
- SQL and parameters;
- member-result count;
- public row order;
- exact errors;
- retry count;
- rollback effects.

### A2. Add real latency benchmarks

**Outcome:** not run in this implementation. The local transport census records
statements and driver calls, but no representative remote deployment was
available. Do not convert local PGlite timing into a provider-request or latency
claim. A future benchmark must keep the requirements below.

Extend <code>benchmarks/nested-write.bench.ts</code> or add one cohesive
relation-bulk benchmark beside it.

Measure:

- N=1, 2, 10, 100;
- local CPU/allocations;
- injected 1 ms, 10 ms, and 50 ms provider latency;
- p50 and p95;
- count and select arms;
- current and optimized candidates.

Use a TCP proxy or driver-level remote harness for PostgreSQL/MySQL wire
latency. Do not use a PGlite spy as a network benchmark.

Suggested commit:

~~~text
test: measure relation bulk transport costs
~~~

## 10. Work package B — Define subtree skipDuplicates

### B1. Pin the public contract first

Extend the existing root relation-bearing <code>createMany</code> contract files
before removing the refusal.

Cover transaction and atomic-batch substrates with:

- one pre-existing root collision;
- two inputs colliding with each other;
- a collision on each declared unique constraint;
- one row colliding with two different existing records through different
  unique constraints;
- a generated root key;
- a compound root key;
- parent-held before-root create/connect work;
- child-held and junction descendants;
- a descendant unique failure;
- a concurrent external root winner;
- count and select results;
- member 0, middle-member, and final-member skips.

Pin this sentence:

~~~text
Only the root INSERT may skip the member. A skipped member leaves no effect from
its complete record subtree and contributes no public result row or count.
~~~

Reverting the production change must make the witnesses fail.

### B2. Give one series member an exact disposition

Remove the constructor refusal from <code>CreateManyRecordSeries</code>.

Represent the series-owned result of one create member as exactly:

~~~ts
type CreateSeriesMemberOutcome =
  | {
      readonly kind: "inserted";
      readonly rowKey: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "skipped" };
~~~

This is not a public result type or a generic operation result. It exists only
at the series boundary that must distinguish N inputs from M inserted roots.

Expose from <code>CreateOperation</code> the existing root write identity and
its root-unique conflict disposition. Do not scan SQL, infer the root from step
order, or mark descendant writes as skippable.

The series:

- counts only <code>inserted</code> outcomes;
- builds result reads only for their row keys;
- preserves their original input ordinals;
- publishes no identity for <code>skipped</code> outcomes.

### B3. Execute one skippable member transactionally

On interactive drivers, run the complete ordinary <code>CreateOperation</code>
member inside one savepoint owned by the record-series executor.

Rules:

1. A SQL-leaf skip that reports zero inserted root rows raises one internal
   non-public control signal inside the savepoint.
2. A recoverable root unique error raises the same signal after exact root-step
   attribution.
3. The savepoint rolls back before-root, root, and after-root effects.
4. The outer series catches only that signal, records <code>skipped</code>, and
   continues.
5. Every descendant failure and every non-unique root failure escapes and rolls
   back the complete outer transaction.
6. Do not retry a skipped member. External missing-arm race pins retain their
   existing whole-operation retry semantics.

The control signal must never cross the query-engine boundary or become a
runtime step kind.

### B4. Preserve first-failure ordering

Do not pre-probe root uniqueness on interactive drivers. A parent-held
before-root descendant may fail before the root INSERT, and that is the current
ordinary-create order. Preserve it.

The D1 route uses the complete member batch as the rollback scope. Its exact
root-write attribution belongs to I8: a root conflict rolls back that batch and
becomes <code>skipped</code>; a descendant conflict remains fatal. No active-bit
lowering or uniqueness pre-probe is added.

Keep gate:

- The old UnsupportedOperationError disappears.
- Skipped subtrees leave zero effects.
- Existing roots are never adopted or mutated.
- Descendant unique failures remain fatal.
- Count/select include inserted roots only and preserve input order.
- No new mutation Part, public result type, or uniqueness pre-probe owner is
  added.

Suggested commit:

~~~text
feat: skip duplicate relation-bearing create trees
~~~

## 11. Work package C — Compose nested relation-bearing createMany

### C1. Widen the existing nested createMany data projection

At the operation-schema boundary, allow each nested <code>createMany.data</code>
row to carry the same relation-bearing create data accepted by one nested
<code>create</code>, while still omitting the enclosing relation key supplied by
the parent.

Keep:

- scalar-only rows on the existing grouped INSERT schema and execution path;
- required-relation satisfaction analysis;
- exact unknown-key rejection for fresh and non-fresh variables;
- existing destination scalar transformations;
- relation payload refusal where the target model still has another
  unsatisfied required relation.

Do not add another row schema. Derive the relation-bearing row projection from
the existing nested create projection.

### C2. Reuse the fresh-record compiler per row

When at least one nested row carries relations, build one nested record series
at the relation Part's current position. Each input row becomes one ordinary
<code>CreateOperation</code> through the existing <code>createFresh</code>
seam, with the enclosing membership injected as field-bound input.

Execute rows left to right. This is required for sibling
<code>connectOrCreate</code> and upsert decisions to observe predecessor effects.
Do not plan every row before the parent tree writes and do not introduce a
cross-row selector cache.

Placement remains:

~~~text
child-held relation
  parent root
  -> row 0 complete child subtree
  -> row 1 complete child subtree
  -> following after-root relation work

junction relation
  row 0 complete target subtree
  -> row 0 junction insert
  -> row 1 complete target subtree
  -> row 1 junction insert
~~~

Scalar nested <code>createMany</code> remains one grouped INSERT. Never regroup
relation-bearing rows.

### C3. Reuse subtree skip semantics

Nested <code>skipDuplicates</code> uses Work package B's exact member
disposition:

- skipped child root means no child subtree and no junction row;
- first inserted sibling wins;
- descendant failures remain fatal;
- the enclosing operation keeps its existing public result;
- a nested series returns no independent public count.

On an interactive driver the member savepoint sits inside the one outer
transaction. It is not a nested public transaction and does not own retry.

### C4. Prove identities and order

Cover literal, generated, compound, non-primary referenced, transitioned, and
polymorphic parent identities. Every row uses existing
<code>ForeignKeyMember</code>/<code>PolymorphicStorageValue</code> publication;
no bulk identity carrier is introduced.

Keep gate:

- Relation-bearing rows use <code>CreateOperation</code>.
- Scalar nested createMany SQL is byte-identical.
- Sibling planning occurs after predecessor effects.
- Step IDs, subtree order, guards, race pins, and first-create-wins match N
  equivalent ordinary nested creates.
- On operation-atomic routes, member failure rolls back the parent and all
  siblings.
- On D1 segment execution, member failure rolls back only the failing batch and
  reports the committed parent/sibling prefix.

Suggested commit:

~~~text
feat: support relations in nested create many
~~~

## 12. Work package D — Compose nested relation-bearing updateMany

### D1. Widen data through the selected-record schema owner

Allow nested <code>updateMany.data</code> to carry the relation-bearing update
projection accepted by one selected target update. Preserve scalar-only
<code>updateMany</code> on its set-based SQL path.

The public payload still supplies one data program for every matched target.
Keep the N-greater-than-one child-held named-target refusal: one target row
cannot belong to several parents.

### D2. Emit one scoped RecordSeriesStep

At the relation Part's exact ordered position, emit the
<code>RecordSeriesStep</code> authorized by §6.1.

Its series:

1. Captures connected targets matching the entry's <code>where</code> once.
2. Uses exact parent correlation and optional to-one filtering.
3. Sorts captured complete row keys using
   <code>ModelKeyCatalog.rowKey.fields</code> as the ordered field list.
4. Builds one ordinary selected <code>UpdateOperation</code> per key.
5. Lets each member use <code>RecordUpdateCompiler</code> and plan after its
   predecessor.
6. Resumes the enclosing operation after every member finishes.

The capture happens when the step executes, not during the enclosing operation's
initial planning phase. This preserves preceding relation effects.

### D3. Reuse one series runner across commit scopes

Factor one executor-owned <code>runRecordSeries</code> routine used by root and
nested series.

For a nested series:

- retain prefix -> capture -> members -> suffix order;
- treat empty capture as a no-op;
- on an interactive driver, pass the already-bound transaction, open no nested
  transaction, and retain outer rollback/retry;
- on D1, flush prefix/member/suffix as the committed segments defined by I4;
- never replay a committed nested member;
- report the nested ordinal path on segment-atomic failure.

A member may contain another <code>RecordSeriesStep</code>. Recursion is bounded
by the validated payload, not by a new depth option.

### D4. Preserve transition and membership meaning

Membership capture reads the parent identity valid at that position:

- pre-transition value for existing membership/removal reads;
- transitioned value for new membership writes after the parent update.

Each target update addresses the captured complete row key, never a
reconstructed selector. Later members may observe earlier members exactly as N
ordinary selected updates would.

Keep gate:

- One new <code>RecordSeriesStep</code> is the only execution-vocabulary
  addition.
- No SeriesPart callback, stage list, lifecycle hook, or copied update compiler
  exists.
- Scalar nested updateMany SQL is byte-identical.
- Prefix/capture/member/suffix order and exact errors are pinned.
- Arbitrary-depth behavior uses the same executor routine.

Suggested commit:

~~~text
feat: compose nested record update series
~~~

## 13. Work package E — Coalesce final result reads

This is the highest-confidence portable optimization.

### E1. Give row-key set predicates one owner

Add one row-key-set predicate beside the retained model-key catalog/correlation
owner.

It must:

- use the complete row key in schema order;
- use IN for one field when the existing where builder can preserve exact
  scalar lowering;
- use OR of ordered AND groups for compound keys;
- preserve destination scalar casts;
- accept no partial row key;
- reuse the existing primary-key where construction;
- remain an internal query-engine filter;
- know nothing about createMany or updateMany.

Delete any now-identical record-series key-set predicate or private
<code>capturedFilterWhere</code>/<code>capturedTargetSetWhere</code> spelling
whose only meaning is the same complete row-key set.

Keep decoded row-key values with their existing query-engine owner. Extend
<code>target-projection.ts</code>, or keep the index private to
<code>series-result-read.ts</code>, with operations for reading and indexing
decoded row keys. <code>ModelKeyCatalog.rowKey.fields</code> supplies the single
ordered metadata input; <code>src/schema/model/keys.ts</code> must not learn
driver-decoded Date, BigInt, Decimal, or byte-array value semantics. A
representative surface is:

~~~ts
readRowKey(
  catalog: ModelKeyCatalog,
  record: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>>;

rowKeyToken(
  catalog: ModelKeyCatalog,
  record: Readonly<Record<string, unknown>>
): string;

rowKeysEqual(
  catalog: ModelKeyCatalog,
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>
): boolean;
~~~

These are query-engine operations derived from the existing catalog order, not
another key carrier and not new schema-model responsibilities.

Rules:

- Values are scalar-decoded before token construction.
- Tokens use explicit value-type tags and length boundaries.
- BigInt, Date, Decimal, byte arrays, mapped scalars, null, and strings cannot
  collide by textual accident.
- A token lookup confirms equality with <code>rowKeysEqual</code> before it
  accepts a row.
- Do not use bare <code>JSON.stringify</code>.
- Do not import cache-key serialization into the query engine; cache identity
  and model row addressing have different owners.

### E2. Add one shared final-series read owner

Replace the duplicate private <code>FinalRootRead</code> classes in
<code>CreateManyRecordSeries.ts</code> and
<code>UpdateManyRecordSeries.ts</code> with one cohesive internal owner, for
example:

~~~text
write-engine/series-result-read.ts
~~~

It is not a new execution form. It builds ordinary read operations for one
final root set.

For each chunk:

1. Build one set predicate over complete final row keys.
2. Build one read after all series members have completed.
3. Start from the already-validated public <code>select</code> (public
   <code>omit</code> is already desugared there) and add only missing row-key
   fields as <code>true</code> in one local internal select object.
4. Build the read with the existing find/select builders and that internal
   select. Do not add a second projection compiler.
5. Parse the returned rows exactly once through the existing
   <code>ResultParser</code>, using a local copy of the validated args whose
   <code>select</code> is the internal select. This decodes public values and row
   keys through the same scalar middleware without a second traversal owner.
6. Index the parsed rows by the series-result owner's exact decoded row-key
   representation, derived from <code>ModelKeyCatalog.rowKey.fields</code>.
7. Replay rows in expected member order.
8. If the expected list contains the same key twice, replay the same fetched row
   twice. Do not silently deduplicate the public result.
9. Remove only row-key fields injected by this owner; preserve any key the
   caller selected explicitly.
10. Return the reordered, stripped rows through the existing series
    <code>parseSeries</code> boundary.

The local internal select is an ephemeral argument to one existing SQL builder
and one existing parser. It is not a retained <code>CompiledSelection</code>, a
read-footprint owner, or a new result contract.

Database result order is arbitrary. Never trust it.

### E3. Chunk by actual bind budget

Let K be the number of chunks.

Build the candidate SQL and count its actual values. Split until every chunk
fits the driver-owned parameter budget.

Rules:

- N=0 emits no read.
- N=1 may keep the existing findUnique SQL.
- Unknown provider budget keeps the current per-row fallback.
- Parameter chunking must preserve expected ordinal order after parsing.
- Chunking does not expose partial public results.
- A failure in any chunk rolls back the transaction.

The truthful acceptance target is N reads to K reads, not universally N to one.

### E4. Preserve exact missing-row failures

The grouped read must produce the existing exact error when any expected key is
missing.

Create series:

~~~text
createMany with 'select' could not read back one of the created rows at the primary key it reported. A later row in the same call moved that row's primary key; use the '{ count }' form, or write those rows in separate calls.
~~~

Update series:

~~~text
updateMany with 'select' could not read back one of the updated rows at the primary key it reported. A later row in the same call moved or removed that row; use the '{ count }' form, or write those rows in separate calls.
~~~

The cardinality check runs inside the transaction callback, before COMMIT.

Keep gate:

- Select arms save N−K SQL statements.
- Count arms are unchanged.
- Compound keys and destination casts remain exact.
- Duplicate expected keys preserve ordinal multiplicity.
- Missing rows retain exact errors and rollback.
- The two private FinalRootRead implementations disappear.
- No new key carrier or result contract appears.

Suggested commit:

~~~text
refactor: coalesce record series result reads
~~~

## 14. Work package F — Rejected: publish final row keys directly

**Outcome:** rejected. A published final key proves an address, not that the
address still contains the root after later members run. The existing terminal
read remains the liveness witness. No `RecordResultDemand` or partial
replacement for `suppressTerminal` was retained.

This package removes terminal SELECTs only when the record compiler can prove
equivalence.

### F1. Make internal result demand explicit

The global OperationResultContract did not land. Do not revive it for this
optimization. Replace CreateOperation's positional
<code>suppressTerminal</code> fact with one private record-compiler demand:

~~~ts
type RecordResultDemand = "none" | "rowKey" | "public";
~~~

The internal demands are:

~~~text
none
  nested fresh subtree and count-only series member

rowKey
  select-bearing series member

public
  ordinary create/update shell
~~~

The union is private to the record-operation/record-compiler seam. It contains
no selection, parser, cardinality, output channel, step placement, or provider
policy:

- <code>none</code> emits no logical final output;
- <code>rowKey</code> requests exactly
  <code>ModelKeyCatalog.rowKey.fields</code> through the compiler's existing
  field-publication path;
- <code>public</code> uses the operation shell's already-validated public args
  and its existing result parser.

Final transport remains the existing explicit
<code>OperationFragment.outputs</code> map. The concrete operation's existing
<code>parse()</code> method remains the result parser. The series already owns
whether its public answer is count or rows; RecordResultDemand does not become a
second series mode.

Use the same union for CreateOperation and the selected-update shell only if it
replaces their existing positional result choices without adding adapter or
operation branching. Do not generalize it to reads, aggregates, or all public
operations.

Do not add:

- <code>suppressTerminal</code> beside RecordResultDemand;
- captureIdentity;
- returnGenerated;
- needsRowKey;
- a series result mode;
- CompiledSelection;
- OperationResultContract;
- a generic result carrier.

Logical result demand and root-liveness proof are separate. “No result” does
not by itself authorize deletion of a terminal liveness witness.

The no-result create path must still offer the complete write tree to
<code>buildTreeFold</code>. The current <code>suppressTerminal</code> early
return happens before that fold; reusing it unchanged would regress an eligible
PostgreSQL member from one CTE command to several writes. Result demand replaces
that positional early return. It does not bypass create-owned folding.

Keep gate:

- RecordResultDemand deletes <code>suppressTerminal</code>; it is not an
  additional concept beside it.
- Existing top-level create/update output maps and parsers stay byte-identical.
- No selection traversal or result-shape logic moves into the record compiler.
- If the union cannot remain this narrow, revert only F and retain current
  terminal reads; the capability packages do not depend on it.

### F2. Reuse fresh-field publication

For create members, request every
<code>ModelKeyCatalog.rowKey.fields</code> member through CreateOperation's
existing demand-driven fresh publication owner.

Each key field may lower from:

- a literal or parse-time generated value;
- a returned database field;
- an insertId-backed single generated integer primary key;
- an existing final OperationValueReference;
- a fallback read selected by the fresh publication owner.

Do not create a second identity extractor.

### F3. Publish selected-record final keys

In RecordUpdateCompiler, factor the values currently used by
<code>updatedPrimaryKeyWhere()</code> into one compiler-owned final row-key
value map.

The existing SQL where builder consumes that map. The operation shell may also
publish it for the series.

The CreateOperation or UpdateOperation shell assembles the row-key record in
its existing parse boundary from:

- literal/known members held by the operation;
- named statement outputs already declared by the compiler;
- final generated-identity outputs.

Do not add a record-shaped FragmentOutputSource or a generic output-value bag
just to assemble a compound key.

The map must preserve:

- complete compound key order;
- old-read/new-write transition provenance;
- user scalar transforms;
- derived incoming FK assignments;
- relation-only updates with no root UPDATE;
- final field-bound sources.

Do not reconstruct a final key from the original selector.

### F4. Keep terminal reads as liveness witnesses when needed

A terminal read currently does two jobs:

1. transports the final row key;
2. proves that the root still exists after the member's descendants.

Deleting it merely because the key is known is wrong.

Reachable hazards include:

- a self-related descendant deleting the root;
- a parent-held target deletion cascading into the root;
- a relation-only update with no root UPDATE;
- a descendant re-keying the root;
- an update whose provider affected-row count cannot distinguish no-op from
  missing, especially MySQL.

Reuse the existing OwnWrite/compiled-effect owner to prove:

~~~text
no effect after the root locate/write can remove this root
and every final row-key member has one publishable source
~~~

Do not add a separate TerminalSafetyAnalyzer.

The record compiler may expose the result of its existing effect proof through
its result compilation. The series must not guess from operation kinds, model
inequality, or field names.

Mixed series are legal:

- a proved member publishes its key without a terminal read;
- an unproved member retains its terminal read;
- both feed the same grouped final-result owner.

### F5. Preserve current cross-member semantics

Terminal elision proves only member-local post-root liveness.

A later member may still move or remove an earlier root. The count arm already
does not recheck earlier members after later effects; keep that behavior. The
select arm's grouped final read remains the final all-member cardinality check.

Keep gate:

- Every elided member removes exactly one terminal SELECT.
- Every retained member keeps byte-identical SQL and errors.
- PostgreSQL members already folded with their terminal do not gain another
  change.
- Self-delete and cascade witnesses retain their current failure.
- No identity tuple, terminal-safety analyzer, or second record compiler exists.
- Existing create/update public result SQL is unchanged outside record-series
  use.

Expected full targets after B and C:

~~~text
simple non-folded create:
  count 3N -> 2N
  select 4N -> 2N + K

child-held connect create:
  count 4N -> 3N
  select 5N -> 3N + K

measured updateMany:
  count 1 + 4N -> 1 + 3N for proved members
  select 1 + 5N -> 1 + 3N + K
~~~

Suggested commit:

~~~text
refactor: publish record series keys without refetch
~~~

## 15. Work package G — Rejected: native libSQL batching

**Outcome:** rejected against the installed SDK. Its batch failure surface does
not identify the exact failing statement, so the executor could not preserve
the existing first owned failure and statement attribution. Ordinary libSQL
execution is unchanged; no native-batch capability is advertised.

This package improves provider requests, not SQL statement count.

### G1. Implement the installed client capability

The installed libSQL client exposes:

~~~text
Client.batch(statements)
Transaction.batch(statements)
~~~

The current LibSQLDriver does not expose that capability to VibORM.

Add a native ordered batch implementation in the driver:

- advertise native batch only after the implementation exists;
- use Client.batch outside an interactive transaction;
- use Transaction.batch on a transaction-bound client;
- convert parameters through the existing libSQL value converter;
- normalize every result through the existing result parser;
- preserve one result slot per input statement;
- preserve statement order;
- preserve statement-index error attribution;
- preserve atomic rollback;
- preserve instrumentation context per statement or document one batch span plus
  exact statement metadata.

Do not open a second transaction inside Transaction.batch.

### G2. Prove actual request behavior

For remote HTTP and WebSocket libSQL:

- N input statements produce one native batch body call;
- the transport produces one provider batch request as measured by the client
  harness;
- failures leave no effects;
- the failing statement index is exact.

For local file or in-memory libSQL:

- report driver and SQL reductions;
- do not call them network round trips.

### G3. Keep MySQL honest

Do not:

- enable mysql2 <code>multipleStatements</code>;
- concatenate semicolon-separated SQL;
- report the base <code>_executeBatch</code> loop as one request;
- enable <code>supportsBatch</code> without a native API;
- use a stored procedure as an ORM execution primitive.

The current MySQL win from this plan is:

- fewer terminal SELECTs;
- K final set reads instead of N reads.

One-request MySQL relation bulk is not a deliverable unless a future supported
driver API provides an ordered, atomic, multi-result batch.

Keep gate:

- LibSQL executes N batch inputs in one real batch body call.
- Ordered results and rollback are exact.
- Non-batch libSQL calls are unchanged.
- MySQL configuration and security surface are unchanged.

Suggested commit:

~~~text
feat: execute libsql batches natively
~~~

## 16. Work package H — Deferred: batch already-selected static fragments

**Outcome:** deferred. The work remains an optional transport optimization, but
the implementation did not add it after the libSQL attribution premise failed.
There is no partial static-batching abstraction in the engine.

This package is executor-local. It does not change when a member is planned.

### H1. Batch one selected final fragment

After an operation completes its normal planning and chooses its branch, offer
its final OperationFragment to an executor-private native-batch lowerer.

Reuse:

- OperationFragment;
- OperationValueReference;
- the existing batch-entry materializer;
- adapter batchRefs;
- existing runtime value windows;
- existing statement contexts.

Initial eligibility:

- the current transaction-bound driver has a real native ordered batch;
- the fragment has at least two statements;
- no GuardStep;
- no <code>expects</code>;
- no <code>onUniqueConflict: "skip"</code>;
- no un-attributable race pin;
- every OperationValueReference is already materialized or lowerable through
  the existing batchRefs owner;
- no branch selection remains.

If any condition fails, run the current linear path.

Do not add boolean options to record compilers.

### H2. Preserve generated identity provenance

The first implementation may batch only fragments with application-known
dependency values.

Then prototype one improvement to the existing output-source owner:

- Add one exact <code>StatementOutputSource</code> variant, with representative
  semantics:

  ~~~ts
  {
    readonly kind: "generatedIdentity";
    readonly field: string;
  }
  ~~~

- Emit it only for one database-generated primary-key field whose
  adapter/driver insertId contract identifies that exact field.
- Linear lowering reads RETURNING[field] when the statement returned the field,
  or the driver insertId when that is the provider's existing identity carrier.
- Native SQLite batch lowering stores the immediate insertId and reads it
  through existing batchRefs.
- Arbitrary database-produced fields still use RETURNING or a stable
  post-insert selector.
- Generated compound keys remain governed by their existing publication rules.
- insertId is never treated as an arbitrary field value.

Retain this prototype only if it adds at most one truthful output-provenance
fact and replaces the current firstRowField-versus-insertId branches in
CreateOperation, upsert create arms, and junction create arms. If it would
parallel those branches instead of deleting them, remove the prototype and keep
generated-ID fragments on the linear path.

### H3. Coalesce consecutive static create members

CreateManyRecordSeries has an empty root capture. Build all ordinary members
before the first effect as it does today.

This unit executes only after J1 gives CreateOperation one retained static
RecordPlan view. Empty planning alone is insufficient: the current series
constructs every member before effects, but compiles member N only after members
0…N−1 have run. Precompiling member N could otherwise surface its deferred
legality failure before a provider failure that current execution would surface
from member 0.

Coalesce only a maximal consecutive run where every member's create-owned
RecordPlan proves that final compilation and parsing are total after
construction and every member:

- has empty planning;
- has no remaining terminal witness;
- compiles to a native-batch-eligible fragment;
- needs no result before the next member;
- carries no guard, race pin, skip effect, or postcondition.

Rules:

- Keep each member's RuntimeValues and output namespace separate.
- Do not merge OperationFragments into one fragment.
- Do not make step IDs globally unique by changing their public diagnostic
  spelling.
- Concatenate prepared query windows only at the driver boundary.
- Parse/check every member result before outer COMMIT.
- A planned member is a barrier.
- Resume coalescing after the barrier only when later members again satisfy all
  conditions.

connectOrCreate and upsert remain sequential because their planning is a
barrier.

### H4. Do not batch postcondition barriers speculatively

The fact that a native batch runs inside a transaction does not preserve
first-failure order by itself.

If a later SQL statement can fail after an earlier <code>expects</code> would
have failed, a batch API may surface the later provider error first.

Therefore the first retained implementation batches no mid-run postconditions.
A provider-specific expansion requires an adversarial proof of exact first
failure precedence.

Keep gate:

- Two or more eligible final statements use one libSQL native batch request.
- Two or more consecutive static members use one batch body call.
- Planning count and order remain unchanged.
- Any planning member remains a barrier.
- Duplicate connectOrCreate preserves first-create-wins.
- Every ineligible fragment emits the current SQL, IDs, and order
  byte-for-byte.
- On this eligible operation-atomic batch route, failure rolls back the whole
  series and retains exact attribution.

Suggested commits:

~~~text
refactor: unify generated identity outputs
perf: batch eligible operation fragments
perf: batch static record series fragments
~~~

The static-record-series commit is made after J1. The first two commits do not
depend on cross-member precompilation.

## 17. Work package I — Execute D1 series as committed segments

D1 can execute one submitted batch atomically and in statement order, but it
cannot pause that batch while JavaScript observes a probe and compiles the next
arm. This plan chooses capability over operation-wide atomicity: execute the
existing record series progressively, with one atomic D1 batch per executable
segment.

This package extends only the executor for the existing
<code>RecordSeriesOperation</code> and <code>RecordSeriesStep</code>. It does not
add a D1 mutation compiler, SQL branch language, scratch workset, or third
operation form.

### I1. Pin the D1 batch boundary

Run local and real-Workers D1 contracts proving:

- one submitted batch is atomic;
- statements inside it execute in submitted order;
- later statements observe earlier statements in the same batch;
- one failing statement rolls back the complete submitted batch;
- result order and error attribution remain stable enough for the existing
  atomic-batch executor;
- a later submitted batch observes a prior successful committed batch.

Name the two contracts precisely:

- **operation-atomic**: every write of the public operation commits or rolls
  back together;
- **segment-atomic**: each submitted segment commits or rolls back together,
  while an earlier successful segment survives a later failure.

Do not add these as mutation modes to <code>RecordSeriesOperation</code>. The
executor derives the contract from the selected route and records it in
instrumentation and failure metadata.

### I2. Add one progressive series route to the executor

Keep one executor-owned <code>runRecordSeries</code>. Give it two transports:

~~~text
interactive transaction
  capture -> plan member -> execute member -> ... -> final read -> commit

ordered committed segments
  capture/read
  -> plan member 0 -> atomic batch 0 -> commit
  -> plan member 1 -> atomic batch 1 -> commit
  -> ...
  -> final result read
~~~

The second route is eligible when:

- the driver has no interactive transaction;
- it has a real ordered atomic-batch primitive;
- each ordinary member can execute through the existing atomic-batch path;
- every required value is published through existing operation references or
  member outputs;
- no single member exceeds a verified provider limit.

Implement this selection from existing driver capabilities, not a D1 name
switch. D1 is the first enabled provider because this package proves its batch
contract. Another batch-only driver may enable the same route only after an
equivalent ordered-atomic-batch and error-attribution contract passes.

It is a standalone-operation fallback. Do not place progressive segments inside
an explicitly atomic <code>$transaction([...])</code> contract. A dynamic series
there refuses before any member write. Static operations that do not require a
record series keep the existing one-batch route. Never make an API named
<code>$transaction</code> commit a partial prefix.

Planning stays just-in-time. Never precompile member N before predecessor
effects when N can observe them. Do not merge step scopes, runtime-value maps,
or failure windows across members.

### I3. Validate everything knowable before the first commit

Before submitting the first write segment:

1. Parse and validate the complete public payload.
2. Build every construction-safe operation shell whose cardinality is already
   known.
3. Run whole-payload legality that does not depend on a selected runtime arm.
4. Check static provider capacities for known members.
5. Run the N-greater-than-one child-held named-target refusal after the root
   target set is known and before its first member write.

Do not eagerly bind or validate an untaken runtime arm merely to improve the
preflight. Data-dependent legality still occurs at the ordinary member position
and may fail after an earlier segment committed. That is an explicit
consequence of segment atomicity, not a reason to duplicate validation.

### I4. Make nested RecordSeriesStep a commit boundary

On a batch-only driver, execute an enclosing record fragment as:

~~~text
ordinary prefix steps -> atomic batch and commit
nested RecordSeriesStep -> its ordered committed members
ordinary suffix steps -> atomic batch and commit
~~~

Flush only at a real series boundary or an existing planning/branch barrier.
Do not split a contiguous ordinary fragment gratuitously. Generated values and
captured keys cross the boundary only after the segment runner resolves the
committed fragment's declared outputs. The runner materializes each demanded
boundary value as the existing literal <code>FinalReferenceSource</code> for the
next operation before validating or compiling that operation.

Keep <code>OperationValueReference</code> fragment-local. Do not weaken
<code>FragmentValidator</code>, carry a prior fragment's step ID into the next
fragment, or add a cross-fragment reference union.

A commit boundary is also a new concurrency boundary. Before a later segment
uses a parent row, captured target, or membership fact established by an
earlier segment, the consuming batch must carry the existing exact target or
membership guard. It must fail before its write if the row was deleted,
replaced, re-keyed, or moved meanwhile. For polymorphic membership, both the
stored type and identity participate. If the existing pin/guard vocabulary
cannot protect one consumed fact exactly, refuse that segment route for the
shape; never create an orphan or address a replacement row.

A nested series may contain another <code>RecordSeriesStep</code>. Recursion
reuses the same runner and reports progress with a series path of ordinals; it
does not create another executor abstraction.

### I5. Define partial-progress failure data

Successful public results remain identical across providers. On failure, keep
the existing error family, message, relation metadata, constraint attribution,
and cause, then add exact execution progress:

~~~ts
interface RecordSeriesProgress {
  readonly atomicity: "segment";
  readonly phase:
    | "capture"
    | "planning"
    | "prefix"
    | "member"
    | "suffix"
    | "result"
    | "invalidation";
  readonly committedSegments: number;
  readonly completedMembers: number;
  readonly committedWriteMembers: number;
  readonly memberPath?: readonly number[];
  readonly totalMembers?: number;
}
~~~

Add one errors-layer operation such as
<code>attachRecordSeriesProgress(error, progress)</code>. It sanitizes the
progress, enriches the error's public metadata and trusted diagnostic
serialization together, and returns the same concrete <code>VibORMError</code>
instance. Preserve class, code, Prisma code, message, cause, stack, timestamp,
constraint, and relation attribution. The executor must not mutate readonly
error fields or attach untrusted properties itself. Do not create a new public
error class. Do not expose row keys, private relation fields, payload values, or
SQL.

Extend the diagnostic allowlist with exactly one
<code>recordSeriesProgress</code> shape. Validate its enum strings,
non-negative safe-integer counters, bounded integer <code>memberPath</code>, and
optional total before disclosure. Do not make arbitrary nested error metadata
serializable.

Rules:

- zero committed segments means no user effect survived;
- a failing batch is not counted as committed;
- <code>completedMembers</code> counts the finalized input prefix, including a
  deliberately skipped duplicate, across the complete depth-first public
  operation execution;
- <code>committedWriteMembers</code> counts only members whose user-table writes
  became durable, across that same global execution order;
- <code>memberPath</code> identifies the current nested ordinal path; the two
  counters are deliberately global and therefore never change meaning with
  nesting depth;
- a failure in the final public read reports that every write member committed;
- never return a partial row array or partial count as success;
- preserve the original error as the owned failure.

### I6. Retry only work that has not committed

The retry rule changes with commit scope:

- before the first committed segment, retain the existing one-time complete
  operation retry;
- after a committed prefix exists, never restart capture or replay earlier
  members;
- one current member may be replanned and retried once only when its complete
  batch rolled back and its exact race pin proves the failure belongs to that
  member;
- a stale captured update target after prior commits is a terminal error with
  progress metadata, not a reason to recapture the series;
- never use compensation writes to simulate rollback.

Compensation is rejected because concurrent work can make an inverse write
incorrect, and because it would create another mutation semantics owner.

### I7. Execute root createMany progressively

For relation-bearing root <code>createMany</code>:

1. Preserve input order.
2. Plan row N after row N−1 committed.
3. Execute one ordinary <code>CreateOperation</code> member in one atomic batch.
4. Record its inserted/skipped outcome.
5. Continue until all rows finish or one fatal member fails.

This preserves duplicate <code>connectOrCreate</code> first-create-wins and
upsert branch visibility without conditional SQL. Database-generated and
compound keys use the existing per-record publication owner.

### Historical I8 checkpoint — reject suppression-requiring rows on D1

**Pre-residual outcome:** the required attribution was not available. D1 batch
failures cannot prove that a unique conflict came from the member's root insert
rather than a descendant. Residual F later narrowed this from one list-wide
decision to a row-local route: a many-to-many member with a vacuous flag drops
it, one exact selector adopts and links, and only a member that still needs
root-versus-descendant suppression refuses before its write. A child-held fresh
record still needs the interactive savepoint when its root can skip. The
following rejected design records why a duplicate pre-probe is not an acceptable
substitute for the remaining suppression route.

The entire candidate subtree executes inside one atomic D1 member batch.

- Emit the annotated root INSERT as a real constraint-enforcing write, not a
  root-only <code>DO NOTHING</code> that would let descendants continue.
- If that exact root INSERT raises a skippable unique conflict, the D1 batch
  rolls back every before-root and descendant effect from the member.
- Translate the rolled-back member to <code>skipped</code> and continue.
- A descendant unique conflict or any other failure aborts the public operation
  and leaves only earlier committed members.

Keep gate: the driver must attribute the unique conflict to the exact root
write. If D1 cannot distinguish root and descendant conflicts for a candidate,
refuse <code>skipDuplicates</code> for that shape before its first member write.
Do not replace exact attribution with a duplicate pre-probe.

### I9. Execute root updateMany progressively

Root <code>updateMany</code> keeps its existing capture semantics:

1. Apply public <code>where</code> and <code>limit</code> once.
2. Capture complete row keys.
3. Sort the captured set deterministically.
4. Run data-dependent capability checks before the first update member.
5. Plan and execute one ordinary selected update per captured key.

New rows matching the filter after capture are ignored. Each member uses the
existing wrong-row and membership guards. Count remains the captured-root
count only on complete success. A fatal member failure reports the committed
prefix and returns no count.

### I10. Execute nested createMany progressively

At the enclosing <code>RecordSeriesStep</code> position:

1. Commit the enclosing prefix segment.
2. Instantiate one ordinary fresh-record member per nested input row.
3. Execute those members in input order, each through the existing atomic-batch
   path.
4. Continue with the enclosing suffix only after every child member succeeds.

The parent identity, discriminator, junction identity, and generated values
flow through existing field-bound sources. A later failure may leave the parent
and earlier children committed; its progress path identifies the nested member.

### I11. Execute nested updateMany progressively

At the exact relation-Part position:

1. Commit the enclosing prefix segment.
2. Capture the correlated target keys from the now-current database state.
3. Apply the existing filter and limit semantics once.
4. Sort complete keys.
5. Instantiate and execute one <code>RecordUpdateCompiler</code> member per key.
6. Commit the suffix segment after all selected targets succeed.

This directly solves the dynamic-workset problem that one prepared D1 batch
could not solve: JavaScript enumerates the captured set between committed
segments. It adds no SQL workset representation and no set-oriented duplicate
update compiler.

The child-held N-greater-than-one named-target move remains refused because its
meaning is invalid, not because D1 lacks a transport.

### I12. Preserve atomic fast paths

Segment execution is a fallback, not a reason to split work that is already
atomic:

- scalar createMany/updateMany keep their one-statement paths;
- an ordinary single-record nested write that fits one D1 batch remains one
  atomic batch;
- static work that does not require a record series remains one batch.

Do not build the conditional-SQL/workset system previously considered for D1.
It duplicates branch, guard, generated-value, and selected-update truths merely
to recover atomicity that this product decision no longer requires.

### I13. Keep cache and instrumentation truthful

After every committed write segment:

- emit one exact internal <code>committedWriteSegment</code> notification through
  the pending-operation/client execution boundary;
- let the existing mutation-cache wrapper consume that notification and run its
  existing invalidation closure, including when a later segment fails;
- emit one child span with member path, statement count, and commit outcome;
- increment committed progress only after the driver confirms success.

This notification is not a generic lifecycle or observer framework. It exists
only because the cache owner sits above the executor and must learn that a
database commit survived. Do not move cache options or cache-driver access into
<code>OperationExecutor</code>. A skipped member and a read-only segment emit no
write-commit notification.

If invalidation itself fails, the database segment is already committed. Stop
the operation, attach <code>phase: "invalidation"</code> and the updated progress
to the cache error, and do not replay the segment.

The parent operation span records
<code>viborm.write.atomicity = "operation" | "segment"</code> and the final
committed segment, completed-member, and committed-write-member counts. Do not
log row keys or payload values.

### I14. D1 keep and reject gates

Keep the progressive route only if:

1. Every submitted member/fragment batch is genuinely atomic.
2. Member N planning observes committed member N−1 effects.
3. A failed batch contributes no effects of its own.
4. Every legality guard that must prevent a write executes inside its member
   batch before that write can commit.
5. Every cross-segment value is resolved to a literal boundary source; no
   fragment references a prior fragment's step ID.
6. Every prior-segment row or membership fact consumed by a later write is
   re-pinned inside the consuming batch.
7. Progress metadata exactly reports every committed segment, including one
   whose post-commit parsing fails.
8. The error's direct metadata and trusted serialization expose the same
   sanitized progress.
9. No whole-operation retry can replay a committed segment.
10. Cache invalidation survives a later operation failure.
11. Successful result value and order match the interactive reference route.
12. No conditional mutation IR, SQL activation predicate, typed workset, or
   second record compiler is introduced.

Refuse the current progressive placement before its containing write segment
when:

- that ordinary member cannot lower to one existing atomic D1 batch;
- exact root-versus-descendant skip-conflict attribution is unavailable;
- the member exceeds a provider limit and cannot remain atomic;
- an existing operation reference cannot cross the selected segment boundary
  without guessing a value;
- the compiler cannot provide an exact complete-parent or membership guard for
  every later write segment.

Refuse the complete operation before writes when progressive execution is
requested inside an explicit operation-atomic transaction/batch contract.

Suggested commits:

~~~text
test: pin d1 segment atomicity
refactor: execute record series in committed segments
feat: execute dynamic create series on d1
feat: execute captured update series on d1
feat: execute nested record series on d1
refactor: notify committed write segments
fix: report partial d1 write progress
~~~

## 18. Work package J — Rejected: PostgreSQL whole-series create CTE

**Outcome:** rejected. PostgreSQL data-modifying CTE siblings share one command
snapshot and do not form the required left-to-right visibility chain. Their
error observation also cannot preserve the series' existing first-failure
contract. Per-record PostgreSQL behavior remains on the portable series path.

This is an objective prototype over the existing create-tree fold.

### J1. Reuse the existing RecordPlan

CreateOperation already constructs a structured record tree before it emits
steps. Promote or expose that existing private RecordPlan only as much as
needed for a second lowering.

Do not:

- parse generated SQL;
- build a second bulk create graph;
- duplicate relation interpretation;
- add a series compiler;
- put relation position, cardinality, or membership decisions in the CTE
  lowerer.

The same RecordPlan must feed:

- current ordinary create emission;
- current per-member create-tree CTE;
- candidate whole-series CTE emission.

If this cannot be done without parallel representations, remove the prototype.

### J2. Exact v1 eligibility

The whole series is eligible only when:

- operation is root relation-bearing createMany;
- capture is empty;
- every member's planning is empty;
- every member is a root-first pure INSERT tree;
- only nested create and scalar nested createMany appear;
- every arm is already accepted by the existing create-tree fold;
- no connect, connectOrCreate, upsert, set, update, delete, or junction decision;
- no GuardStep;
- no <code>expects</code> that would disappear;
- no skip effect;
- no race pin;
- no unresolved forward reference;
- every dependency is an existing backward firstRowField reference;
- the union of all arm semantics passes the existing
  <code>foldArmsAreOrderInsensitive</code> proof;
- no two arms can modify the same row;
- no same-table duplicate-sensitive effect;
- no public relation projection inside the command;
- database-assigned identity ordering remains exact.

Retain the existing conservative global gate:

~~~text
at most one database-assigned identity arm across the whole command
~~~

Multiple generated roots would otherwise receive sequence values in
provider-chosen CTE-arm execution order rather than input order.

### J3. Preserve member namespaces

Different ordinary members may use the same local step IDs. The combined CTE
lowerer must scope its private CTE aliases by member ordinal without changing
logical step IDs or OperationValueReference meaning.

It may build a private map:

~~~text
(member ordinal, local step id) -> private CTE alias
~~~

That map exists only inside the lowerer. It is not a new engine identity.

References may cross statements inside one member. The v1 fold permits no
cross-member value reference.

### J4. Result handling

Count:

- one successful command means N completed roots;
- any failure aborts the command.

Scalar select:

- retain input ordinal explicitly;
- never trust RETURNING row order;
- reorder through the same series-result row-key index derived from
  <code>ModelKeyCatalog.rowKey.fields</code>;
- keep a separate grouped read when the command cannot return the exact public
  projection.

Relation select:

- always perform K post-write grouped reads;
- never read sibling effects from the writable-CTE base snapshot.

### J5. Keep/reject gate

Keep the PostgreSQL whole-series fold only if:

- N eligible members become exactly one SQL command for count;
- fallback remains byte-identical for every ineligible shape;
- input-to-result order is exact;
- statement-level trigger count remains equivalent because original DML arms
  remain distinct CTE arms;
- generated identity assignment remains deterministic under the stated gate;
- constraint and error attribution remain exact enough to preserve the public
  error;
- no second RecordPlan or create compiler remains;
- production complexity is smaller than an independent bulk compiler.

Suggested commit if retained:

~~~text
perf: fold static create series into one postgres command
~~~

## 19. Rejected portable “one statement” designs

### 19.1 MySQL multi-statements

Rejected:

~~~text
INSERT root ...;
INSERT child ... LAST_INSERT_ID();
~~~

sent as one semicolon string.

Reasons:

- it remains multiple SQL statements;
- mysql2 multipleStatements changes the connection security surface;
- result and error attribution become multi-result parsing concerns;
- the current driver explicitly refuses the option;
- it does not solve N generated identity correlation.

### 19.2 SQLite writable CTE

Rejected because SQLite cannot use DML RETURNING output as another DML input.

### 19.3 Generated-ID arithmetic

Rejected:

~~~text
firstId + rowOrdinal
lastId - rowOrdinal
~~~

The database does not guarantee the required gap-free allocation.

### 19.4 Generic cross-member cache

Rejected. It would make first-create-wins, found/missing decisions, membership
moves, and race pins depend on a second semantic owner.

### 19.5 Portable multi-row regrouping

Do not automatically replace N ordinary INSERT statements with one multi-row
INSERT.

The current relation-bearing createMany contract is left-to-right ordinary
creates. Regrouping changes statement-level trigger behavior and can change
failure attribution. It requires a separate product-contract decision.

Native batching is preferred because it preserves the individual statements
while reducing transport calls.

## 20. Work package K — Conditional updateMany optimizations

Do not build a general update-series fold.

After packages E–H, count remaining repeated immutable probes with
<code>rg</code> and measurements.

One optional prototype is allowed:

~~~text
hoist one identical immutable parent-held or direct-polymorphic connect probe
before the N members
~~~

Keep it only if a proof shows:

- target is identical for every member;
- no member can create, move, update, or delete that target;
- no self-relation reaches it;
- no branch depends on membership;
- no race pin or wrong-row guard changes;
- one probe result can feed every ordinary compiler without a cache abstraction;
- N member plans become one probe with exact error timing.

If the proof needs a generic cross-member memoization layer, reject it.

No other updateMany optimization is part of this plan.

## 21. Work package L — Document the final bulk contract

Update:

- public nested-write and bulk-write documentation;
- provider compatibility documentation;
- query-engine AGENTS doctrine;
- write-engine README/ATOM;
- the capability matrix;
- this plan's measured outcome section.

Document the API as it exists after implementation, not as migration history:

- scalar bulk keeps grouped set-oriented SQL;
- relation-bearing bulk means ordered ordinary record semantics;
- <code>skipDuplicates</code> suppresses the complete skipped record subtree;
- nested relation-bearing <code>createMany</code> accepts relation data per row;
- nested relation-bearing <code>updateMany</code> applies one update program to
  each captured related target;
- one named child cannot be moved to several parents by one
  <code>updateMany</code>;
- interactive drivers use one operation-wide transaction;
- no-transaction native-batch drivers use ordered segment-atomic batches for
  safe dynamic record series;
- a failed segmented operation can leave committed or possibly committed progress;
- no automatic retry replays that committed prefix;
- static shapes still use one atomic batch whenever possible;
- dynamic progressive series are refused inside an explicitly atomic
  <code>$transaction([...])</code> call;
- statement count, provider request count, and transaction envelope are
  different metrics.

Include short examples for subtree skip and both nested bulk operations. Add a
prominent D1 failure example showing <code>completedMembers</code>,
<code>committedWriteMembers</code>, and <code>committedSegments</code>, and
explain that successful results are portable while rollback scope is
provider-specific. Do not expose step IDs or private identity columns in public
documentation.

Suggested commit:

~~~text
docs: document relation-bearing bulk semantics
~~~

## 22. Validation matrix

### 22.1 Behavioral parity

Run transaction and atomic-batch witnesses where applicable:

- simple child nested create;
- scalar nested createMany fast path;
- relation-bearing nested createMany;
- relation-bearing nested updateMany;
- root and nested subtree skipDuplicates;
- parent-held create;
- child-held connect;
- M2M;
- polymorphic direct connect;
- connectOrCreate found/missing/duplicate;
- upsert found/missing;
- count/select;
- compound row key;
- non-primary reference key;
- generated identity;
- primary-key transition;
- later-member move/delete;
- empty series;
- member 0 failure;
- member N failure.

Assert:

- public results;
- exact order;
- statement order;
- SQL parameter order;
- destination casts;
- guards;
- postconditions;
- race pins;
- retry count;
- exact errors and metadata;
- zero partial effects on operation-atomic routes;
- on segment-atomic routes, exactly the reported committed prefix and no effect
  from the failing segment.

### 22.2 Provider transport

PostgreSQL/PGlite:

- existing per-member fold parity;
- grouped final reads and bind-budget chunking;
- compound and generated row-key reconstruction.

MySQL:

- grouped final reads;
- LAST_INSERT_ID remains per-record transport only;
- no multipleStatements;
- no false native-batch claim.

SQLite3 and Bun SQLite:

- grouped final reads;
- no network-round-trip wording.

libSQL:

- ordinary execution remains unchanged;
- no native-batch capability is advertised without exact statement failure
  attribution.

D1:

- existing grouped polymorphic fast path;
- ordered atomic rollback for each submitted segment on the real binding;
- visibility of one committed segment to the next planning read;
- root createMany sibling branch visibility across committed members;
- a routed member that still needs root-versus-descendant suppression refuses
  before its write; vacuous and exactly adoptable many-to-many members proceed;
- captured root updateMany member execution;
- guarded nested createMany and updateMany at their exact series positions;
- an unguardable nested placement refuses before its containing write segment;
- prefix/member/suffix commit order;
- exact committed-segment, completed-member, and committed-write-member failure
  metadata, both directly and through <code>toJSON()</code>;
- generated and compound boundary values materialize without cross-fragment
  step references;
- parent deletion, same-key replacement, membership move, and polymorphic
  wrong-type replacement between segments fail before the consuming write;
- no retry of a committed prefix;
- cache invalidation after partial failure;
- cache invalidation failure reports a committed invalidation-phase segment;
- one-batch preservation for existing static paths;
- dynamic series inside <code>$transaction([...])</code> refuses before writes;
- static non-series operations remain eligible inside that explicit atomic
  contract.

### 22.3 Parameter and size stress

For each built-in driver:

- row-key arity 1, 2, and the largest supported compound key fixture;
- N immediately below, at, and above one chunk boundary;
- public select with additional bound values;
- maximum SQL-size sanity;
- no chunk exceeds the declared bind budget;
- K chunks reconstruct exact input order.

### 22.4 Adversarial failures

Inject:

- missing final row;
- wrong-row replacement;
- same-key later occupation;
- unique conflict in member 0;
- unique conflict in member N;
- raceable missing-arm loser;
- failing child INSERT after root INSERT;
- later provider error after an earlier potential postcondition;
- rollback cleanup failure.

Also inject:

- a skipped root with successful before-root effects;
- a skipped root whose before-root descendant fails first;
- two input rows colliding with each other;
- one root colliding through two unique constraints;
- a D1 member-0 failure before any commit;
- a D1 member-N failure after several commits;
- a D1 suffix failure after all nested members commit;
- a D1 final-result-read failure after all writes commit;
- a stale captured D1 update target after an earlier member commits;
- a retryable D1 current-member race after a committed prefix;
- a parent deleted or replaced between prefix and nested child segments;
- a polymorphic parent membership changed to a same-ID wrong-type value between
  segments;
- direct and serialized error progress disagreeing;
- invalidation failure immediately after a committed segment;
- cache reads immediately after a partially committed D1 failure.

The optimized route must preserve the first owned failure. It may not return a
plausible shorter row list or a later unrelated provider error.

## 23. Sequential commands

Use repository launchers one process at a time.

Per unit:

~~~bash
pnpm test:types
pnpm test:layer:query-engine
~~~

Focused write tests:

~~~bash
pnpm test:layer:query-engine
~~~

The focused contract files are listed in A1. Do not launch them with raw
Vitest. The layer script owns the workspace lock, memory cap, timeout, and
process-group cleanup.

Per major package:

~~~bash
pnpm test:layer:relations
pnpm test:layer:operation-schemas
pnpm test:layer:query-engine
pnpm test:layer:drivers
pnpm package:build
~~~

Final:

~~~bash
pnpm test:types
pnpm package:build
pnpm test
pnpm test:all
pnpm test:coverage:write-engine
~~~

Run provider contracts when services are available:

~~~bash
pnpm test:providers
~~~

Report every skipped provider. Do not mark it passed.

Run three warm final type checks. Median regression must remain below 5%.

## 24. Acceptance criteria

### 24.1 Architecture

- RecordSeriesOperation remains the only data-dependent bulk execution form.
- RecordSeriesStep is the one authorized nested placement of that existing
  form; no other runtime step kind is added.
- CreateOperation remains the only fresh-record compiler.
- RecordUpdateCompiler remains the only selected-record update compiler.
- No new bulk mutation interpreter exists.
- Root and nested series use one executor-owned runner.
- Progressive batch execution runs existing operation fragments and does not
  re-derive relation position, cardinality, or membership independently.
- No conditional SQL branch IR, batch workset, or D1 record compiler exists.
- No identity tuple or series key carrier exists.
- ModelKeyCatalog owns complete row-key order.
- PlanningFragment has no manually maintained output map.
- Final OperationFragment output selection and concrete operation parsing stay
  explicit.
- Work package F is rejected: current terminal reads and
  <code>suppressTerminal</code> remain, and no partial demand abstraction
  survives.
- No CompiledSelection or generic OperationResultContract is introduced.
- One shared owner builds final series reads.
- Write-engine runtime import cycles remain zero.

### 24.2 Correctness

- Dynamic members still plan left-to-right.
- Duplicate connectOrCreate still keeps first-create-wins.
- Complete-series retry remains outer-owned only while no segment has committed.
- Operation-atomic failures roll back all effects.
- Provider-confirmed segment rollback preserves exactly the committed prefix;
  weak post-dispatch failures remain conservatively ambiguous.
- Compound keys remain complete and ordered.
- Generated IDs are never inferred arithmetically.
- Final result order matches member order.
- Missing final rows keep exact errors.
- A skipped root leaves no effect from its complete subtree and never adopts an
  existing row.
- A batch route isolates that skippable root before descendants; any prior write
  or nested series makes the shape a pre-effect refusal.
- Nested relation-bearing createMany executes sibling record trees in input
  order.
- Nested relation-bearing updateMany captures once at its ordered position and
  executes selected targets in complete row-key order.
- The N-greater-than-one child-held named-target move remains refused.
- Every submitted native-batch segment is atomic; the public operation may contain
  several committed segments.
- A provider-confirmed rollback leaves no effect from the failing member batch;
  an ambiguous dispatched failure reports possible commit.
- No retry replays an already committed or possibly committed segment.
- Segmented progress distinguishes completed inputs, durable write members,
  committed segments, and possible commit. Strong callback drivers can attribute
  completion before result decoding; weak seams stay conservative.
- Cross-segment values are materialized; cross-segment row and membership facts
  are re-pinned before a later write.
- Every residual progressive refusal is tied to one named semantic gate.

### 24.3 Performance

- Grouped result reads reduce N to K.
- Existing scalar createMany/updateMany paths are byte-identical.
- Existing direct polymorphic grouped createMany is byte-identical.
- LibSQL does not advertise a native-batch optimization.
- MySQL results never claim a one-request batch.
- Embedded SQLite results never claim a network round trip.
- PostgreSQL keeps the portable per-member series route.
- Eligible dynamic decisions on native-batch drivers execute between ordered
  atomic segments; planning requests and committed batches are reported separately.

### 24.4 Fallback

For every ineligible optimization shape, preserve the selected semantic route:

- public result;
- validation timing;
- planning/final IDs;
- SQL;
- parameters;
- statement count;
- statement order;
- guards;
- expects;
- race pins;
- error class, message, and metadata;
- retry behavior within its commit scope.

The intentional D1 capability route is not required to preserve the previous
construction-time refusal or operation-wide rollback. It must instead preserve
successful results and ordered mutation semantics while exposing segment
atomicity exactly.

## 25. Delivery commit

~~~text
feat: expand relation-bearing bulk writes
~~~

The implementation is one task-level change. Rejected prototypes leave no
partial owner or advertised capability behind.

## 26. Final report

Report:

- starting and ending commits;
- production, test, and documentation LOC separately;
- SQL statement counts before/after;
- driver body calls before/after;
- measured provider requests only for providers and deployments actually run;
- BEGIN/COMMIT envelope separately;
- no latency claim when a representative remote benchmark was not run;
- final K chunk counts for each provider;
- the F rejection and retained terminal-liveness read;
- the libSQL native-batch rejection and installed-SDK attribution limit;
- D1 root create, root update, nested create, and nested update results
  separately;
- D1 operation-atomic versus segment-atomic route counts;
- partial-progress failure witnesses for member, suffix, result, and
  invalidation phases, including completed versus durable-write members;
- every D1 member-level reject gate still reachable after the work;
- the PostgreSQL whole-series CTE rejection;
- MySQL explicitly unsupported one-request result;
- exact test commands and outcomes;
- provider suites run or skipped;
- type-check median;
- residual correctness and performance risks.

## 27. Expected final shape

The expected architecture is:

~~~text
relation-bearing createMany/updateMany
          |
          v
RecordSeriesOperation
  - fixes root set
  - preserves member order
  - preserves branch visibility
          |
          +--> dynamic member
          |      plan -> execute -> observe -> next member
          |
          +--> static member/run
                 same ordinary fragment
                 -> current linear transaction or existing atomic batch
          |
          +--> nested RecordSeriesStep
          |      same series runner
          |      interactive: one open transaction
          |      native batch when exactly guarded:
          |        committed prefix -> members -> suffix segments
          |      otherwise: fail closed before the containing write segment
          |
          +--> progressive native-batch lowering
                 planning/capture at the ordinary ordered position
                 -> one atomic committed segment
                 -> observe -> compile the next segment
                 -> exact partial-progress failure if a later segment fails
          |
          v
K bounded final set reads
  - complete row keys
  - deterministic replay order
  - exact missing-row failure
~~~

The engine becomes faster by transporting fewer redundant facts. It does not
become “smarter” by guessing database behavior.
