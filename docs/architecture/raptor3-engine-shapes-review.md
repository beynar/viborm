# Raptor 3: comparison of query/write engine designs

Date: 2026-09-07. Reviewed checkout: pattern-engine, 3a291a59, including the existing uncommitted plan amendment and differential-dump changes. This is a design review, not an approved replacement architecture. No engine implementation or compatibility rule is changed by this document.

**Historical review:** the later [clean-sheet investigation](./raptor3-clean-sheet-language.md)
replaces the reuse-first recommendation below. The
[central implementation plan](./raptor3-implementation-plan.md) is the current
owner of implementation order, class/context ownership, DST, and exit gates.

The strongest candidate is a small **structured mutation program** whose database actions retain their required assumptions, value dependencies, and execution scopes. Reuse the current parsed request, resolved topology, SQL builders, and physical OperationStep vocabulary. Its strongest competitor is a **functional, compositional refactor of the existing Part model**. Compare those two on the same difficult cases before committing to an additional intermediate representation.

The state-machine intuition is useful. It describes how execution changes local knowledge and database state. It does not by itself choose between functions, a syntax tree, a graph, or an interpreter, and it does not establish a size reduction.

## What the previous discussion got wrong

1. **The Pattern implementation already contains transitions.** Its [Row and Arm contracts](../../src/query-engine/pattern/pattern.ts) carry match/assert/retract modes, old/new keys, conditional arms, and bindings; its [Fragment](../../src/query-engine/pattern/fragment.ts) has deferred packing and execution boundaries. Describing the actual proposal as only a predicate over the final state understates it. The real question is whether those facts are complete and organized cheaply enough to lower without reconstructing intent.
2. **An unfinished implementation is not an impossibility proof.** Its growing packer, incomplete parity, and legacy dependencies undermine the proposed cost and delivery plan. They do not prove that every representation based on patterns or graphs must fail. To prove information loss, exhibit two requests whose complete representations are identical but whose required behavior differs. To prove poor compression, count the complete replacement, including its construction and lowering.
3. **The reported 43× threshold overrun uses incompatible units.** [The comparator](../../tests/pattern/pack/program-dump.ts) records a difference for each mismatched field of each aligned step in each corpus cell. The plan's [approximately 40 special-case threshold](./pattern-engine-ideal-state.md) concerns implementation exceptions. One missing rule can generate many differences. The difference count is useful, but dividing it by a rule budget does not measure architectural failure. The plan also specifies re-estimation at that threshold, rather than proving the representation impossible.
4. **The differential labels are coarse.** Every unmatched read is labeled an untaken-arm read difference, even if a label mismatch or another missing probe caused it. Compile error equality compares name and message, not all metadata or timing. These are triage signals rather than a complete semantic diagnosis.
5. **M2 is not yet a complete database-state oracle.** [Its execution fixture](../../tests/pattern/differential/execute.core.test.ts) synthesizes rows from selected aliases, skips record series, and only runs compile-equal cells. The [simulator](../../tests/pattern/sim/simulated-driver.ts) can support scripted state changes, but does not interpret SQL itself. A matching trace on these inputs cannot establish referential actions, isolation, final database state, or retry correctness under real races.
6. **The previous size forecast is not demonstrated.** The 40–46k LOC and 15–30kB gzip ranges were extrapolations from earlier proposals, not measured results of the state-machine design. The claimed 60–80% reduction in verb decision sites has no completed census behind it. Keep the measured historical baseline, withdraw the forecasts as commitments, and remove arbitrary success/failure gates based on those forecasts.
7. **Storage and capability knowledge cannot live exclusively in the executor.** Root-assignment folding, generated-output transport, bind limits, and legal statement combinations affect physical planning before dispatch. The desired boundary is that semantic intent does not depend on a driver; physical lowering necessarily does. A single late executor cannot infer everything from already-rendered SQL.

These corrections do not make the existing Pattern prototype ready to adopt. They make the comparison fair enough to choose its replacement.

## What must remain distinguishable

There is no useful proof of the smallest possible number of type names. One opaque function can encode the whole ORM, while explaining none of it. Minimize the combined cost of the representation, its construction, its interpretation, and its correctness arguments.

A proposed reduction must preserve distinctions in a surrounding operation and under concurrent changes, not only when run alone against a static database.

| Required distinction | Why composition needs it | What can be derived or shared |
|---|---|---|
| A value, a selected record, and a stored membership | An equal number does not grant equal addressing or existence guarantees; row keys and referenced unique keys can diverge | Reuse key catalogs and resolved slots; share tuple transport without erasing its role |
| Unknown, absent, SQL NULL, and a known value | They select different branches and produce different predicates | Closed result variants; no independent boolean per possible state |
| An observation and the period during which it can be relied on | A concurrent change can invalidate a selection before a later write | One description of the required fact; locks, in-batch guards, or constraints may enforce it |
| Inserting, updating, deleting a record, and changing a membership | UPDATE cannot generally become DELETE plus INSERT without changing triggers, defaults, constraints, and cascades | Share assignment and addressing machinery; preserve meaningful statement boundaries |
| Order, alternatives, and repetition | Untaken branches, repeated selectors, and a later series member have different visibility and failure behavior | Generic structured composition, with public verbs expanded once |
| Visibility, atomicity, and retry scope | A later member can see earlier writes while all members still share one transaction; a committed prefix cannot be replayed | Separate scoped facts, using existing record-series and fragment concepts |
| A known value and a value published by a successful statement | Knowing the proposed key does not establish that INSERT succeeded; a consumer may need another returned field | A common binding/reference mechanism with exact producer provenance |
| Domain outcome and diagnostic attribution | Two failed predicates may require different errors, timing, metadata, or retry treatment | Reuse Failure and target-constraint machinery; retain provenance without re-deciding the algorithm |

This is an inventory of distinctions, not a demand for eight new runtime node types.

In particular, sequence does not require a Sequence class if an ordered list is sufficient. Branching does not require a handler registry. A field publication may be an output reference rather than an executable node. A premise may be a typed predicate plus its failure contract. A dependency graph can be derived from an ordered program rather than stored as another authoritative model.

There is also a distinction between mathematical necessity and compatibility. OwnWrite restrictions, historical planning reads from untaken arms, and exact step labels are existing contracts or implementation commitments. They are not axioms of all ORMs. This review preserves them. Reconsidering them is a separate, explicit compatibility decision, not a hidden source of refactor savings.

## The meaningful design families

These families cover the materially different choices for this engine. Alternative class layouts, visitor syntax, or function names do not constitute additional architectures. Several families can be combined.

| Design | Where meaning lives | What it simplifies | Where complexity returns | Assessment for VibORM |
|---|---|---|---|---|
| **Functional composition over today's Parts** | Ordinary functions producing planning and final fragments, backed by shared domain operations | Parameter forwarding, repeated guard policy, mutable compile state, repeated per-verb coordination | Whole-program analysis may still need a parallel description when functions hide branches | Strongest baseline and migration path; must compete with a new IR |
| **Generators / effect handlers / continuations** | A suspended program requests observations and effects, then resumes with values | Local value threading and readable sequential algorithms | An opaque continuation cannot expose untaken branches before I/O; batching, preflight, retry, and eager errors need staging or an explicit representation | Useful authoring technique; weak as the sole canonical model under current contracts |
| **Structured mutation IR** | An inspectable program with ordered regions, alternatives, relational actions, and bindings | One interpretation of branch/visibility rules; shared analysis; stable representation for both execution paths | Excessive nodes, duplicated query ASTs, generic interpreters, and indiscriminate passes can reproduce the old mass | Leading candidate, if kept narrow and shown to delete current owners |
| **Dependency graph / SSA / dataflow** | Nodes describe operations; edges carry values and order constraints | Generated outputs, dependency ordering, shared producers, local fusion opportunities | Value edges alone do not encode write conflicts, error order, atomicity, or progressive iteration | Useful derived view inside a region; an unrestricted graph is an expensive default |
| **Explicit FSM / statecharts** | States, transitions, guards, and runtime context | Attempt lifecycle, retries, commit acknowledgment, failure recovery | Arbitrary nested writes require values and a stack; putting every verb/storage combination into states recreates the product grid | Good execution model; avoid a global statechart per mutation family |
| **Cell patterns / declarative constraints / rewrite rules** | Facts and rules express goals or transitions | Uniform addressing and local equivalences | Final facts omit causal behavior; transition rules can restore it, but then carry effects, order, and scopes too; a general solver adds its own cost | Useful for local predicates or assignment normalization; whole-engine advantage remains unproved |
| **Unit of work / object graph diff** | Pending record changes and relationships are flushed in dependency order | Shared assignment reconciliation and insert/update/delete scheduling | Reconstructing requested commands from state changes needs identity tracking and intent history; set-based predicates and failure timing become awkward | Borrow an operation-local change ledger; avoid introducing a full object session |
| **SQL-first / CTE / stored-program lowering** | Most composition is delegated to database statements | Round trips and some runtime branching on supported providers | Different SQL capabilities, visibility, triggers, and generated outputs require other paths | Keep as bounded physical optimizations; unsuitable as the universal cross-dialect model |
| **Flat bytecode or generated execution code** | Opcodes or compiled functions execute a lowered plan | Potential runtime allocation/dispatch improvements | Adds a compiler, decoding/runtime machinery, debug mapping, and another form to verify | A later measured optimization if needed; does not solve the semantic model first |

Two distinctions prevent this table from becoming a menu of competing buzzwords. A syntax tree or graph is a representation. A state machine is a model of execution. An interpreter or generated function is an implementation strategy. Choosing a state machine does not rule out a structured program; executing that program already realizes one.

The engine's nested input and database values are not a small finite set. An explicit implementation would be an extended machine with data and nested frames. An ordinary recursive interpreter can supply those frames without a large enum of states or a state-machine dependency.

Primary-source checks support the tradeoffs, without proving a size result for VibORM:

- [Prisma's query graph at the inspected revision](https://github.com/prisma/prisma-engines/blob/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/query-compiler/core/src/query_graph/mod.rs) distinguishes execution-order dependencies, projected data dependencies, conditional edges, and result expectations. Its [expression representation](https://github.com/prisma/prisma-engines/blob/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/query-compiler/query-compiler/src/expression.rs) also has bindings, sequencing, conditionals, database operations, and result processing. This demonstrates viable representation choices, not that VibORM should copy both layers or their costs.
- [MLIR's effect rationale](https://mlir.llvm.org/docs/Rationale/SideEffectsAndSpeculation/) explains why value flow alone cannot justify moving or removing effectful operations. The useful inference here is to retain effect and ordering information, not adopt a compiler framework.
- [SQLAlchemy's Session API](https://docs.sqlalchemy.org/en/20/orm/session_api.html#sqlalchemy.orm.Session.flush) describes flushing pending changes with a dependency solver. That is a useful model for a local assignment ledger, but a different center of gravity from VibORM's explicit commands.
- [PostgreSQL's data-modifying WITH rules](https://www.postgresql.org/docs/current/queries-with.html#QUERIES-WITH-MODIFYING) specify shared snapshots and communication through RETURNING. Sibling modifications do not become ordinary sequential statements merely because a graph connects them. This directly limits universal CTE lowering.

## The candidate I would pursue

Use the existing canonical request as input to a small structured write program. Give relational meaning one home, then specialize physical execution using the existing topology and provider capabilities.

~~~mermaid
flowchart TD
    A[Validated canonical request] --> B[Structured mutation program]
    S[Resolved schema and relation slots] --> B
    B --> C[Analyze required facts and early refusals]
    C --> D[Lower the next executable region]
    P[Topology and provider capabilities] --> D
    D --> E[Existing OperationStep fragments]
    E --> F[Execute in the required atomic scope]
    F --> G{More observation-dependent work?}
    G -->|Yes: bind outputs| D
    G -->|No| H[Project and decode the public result]
~~~

The feedback edge matters. Planning is not necessarily a once-only transformation into one static list. A generated field, selected branch, or next record-series member can determine later physical work. The program exposes enough structure for the current preflight obligations before the applicable effects, while leaving database-dependent values unresolved until their producer runs.

This is a **domain-specific program**, not an engine that simulates the whole database. Runtime state holds only the current operation's bindings, selected control path, and progress. The actual database remains the authority for facts the operation has not proven.

The representation should start with three groups, each using existing owners where possible:

| Group | Content | Representation discipline |
|---|---|---|
| Relational values and actions | Selections, record changes, membership changes, published fields | Reuse predicates, key catalogs, membership mappings, and SQL expression leaves; do not create a second general query language |
| Structured control | Ordered work, a selected alternative, ordered record iteration, completion | Preserve both alternatives for the analyses that need them; execute only the permitted work at its existing stage |
| Scoped requirements | Observation assumptions, atomic regions, retry boundaries, failure attribution | Describe what must hold independently of how a transaction or batch enforces it |

The exact node list is deliberately unresolved. A useful test is whether a proposed node allows its consumers to do something they cannot correctly derive from existing structure. Failure can be a terminal result. Iteration can carry the current RecordSeriesOperation meaning. A separate publication node is unnecessary when a statement's declared output already owns it.

Keep control structure explicit and derive local dependencies from it. Do not begin with a global topological sorter that must infer all sequencing from cell reads and writes. In particular, two writes with disjoint returned values can still conflict through membership, a uniqueness constraint, error precedence, or statement observers.

Keep the existing execution backend during the first comparison. The goal is to show that semantic compilation gets smaller before paying for another executor. A physical planner can later centralize lock/guard/constraint choices and generated-output transport, passing an already selected strategy to the backend.

Read predicates and result projections remain separate semantic objects. They can share resolved schema navigation and one projection contract without making the decoder run a mutation pattern backwards. Public schema inference, aggregate schema imports, and zero user code generation remain outside this redesign.

## Where the actual compression should come from

**A single description of branch meaning.** Today [RelationUpsertPart](../../src/query-engine/write-engine/RelationUpsertPart.ts) already shares connectOrCreate and upsert. The problem is how far that common meaning extends across parent-held, child-held, and junction paths. Its existing found-guard and decision logic are better starting evidence than an invented universal merge operation.

For a simple connectOrCreate, the semantic body is roughly:

~~~text
observe the requested target
  found   -> use the captured record, under the required premise
  missing -> insert the supplied record, with the applicable conflict contract
establish the requested membership using the chosen record's referenced fields
~~~

This is an expansion sketch, not a sufficient contract. The owner must also distinguish a global adoption from a correlated existing member, an exact unique selector from an extended filtered selector, and an earlier same-operation producer from a database match. Existing failure and retry policies belong in that expansion. Later storage lowering should receive the decided behavior, rather than re-infer it from the public verb.

**One assignment reconciliation rule.** A scalar update and a parent-held membership assignment can address the same physical column. [FinalRootAssignmentTruth](../../src/query-engine/write-engine/final-root-assignment.ts) already compares their sources. Extend the reach of that owner; do not replace it with a generic merge that silently chooses the last value. A root FK fold must still be able to become one INSERT or UPDATE.

**One description of a concurrency obligation.** The fact a write relies on is distinct from its enforcing statement. A found record may need its complete captured key and membership; an exact missing target may be protected by the INSERT's unique constraint. A transaction lock, an atomic-batch guard, and a constraint are not interchangeable for every fact. Centralize the valid mapping once, with exact failure behavior; do not reduce it to a universal exists/notExists guard.

**One source of effect facts for different analyses.** OwnWrite, ordering, and premise invalidation can consume the same resolved facts, while retaining their different questions and timing. A logical decision read may exist even when no SQL probe is emitted. Therefore deriving OwnWrite from the final SQL list is insufficient. Multiple passes are acceptable when they inspect one representation and each owns a distinct judgment.

**One temporal account of a selected record.** [RecordUpdateCompiler's final assembly](../../src/query-engine/write-engine/RecordUpdateCompiler.ts) presently resets compile-time fields, accumulates multiple guard/write buckets, reconciles assignments, and orders old-membership effects around the root transition. A plan can make that information explicit once. It must preserve old-key reads, new-key consumers, and database-owned cascades; changing the container alone does not remove those facts.

**Separate stable inputs from attempt state.** The parsed request and resolved schema can be immutable inputs. Captures, bindings, branch selections, and acknowledged progress belong to the appropriate attempt or series scope. A fresh attempt frame can remove reset-on-retry fields. It must not rerun non-idempotent validation or application defaults merely because compilation retries. A universal context with many optional fields would hide those lifetimes again.

**One canonical route with proven local fast paths.** Keep native scalar upserts, grouped bulk statements, returning folds, and exact mutation-DAG folds where they preserve the relevant contract. Give each optimization a precise eligibility predicate. One universal interpreter that turns every bulk write into row-at-a-time execution would save the wrong kind of code.

## Stress tests that decide the shape

Each of the following exposes information a small model can accidentally discard. These are a family of valid fixtures, not a requirement to combine every feature into one enormous query.

| Witness | What a successful representation must say | What would falsify the compression claim |
|---|---|---|
| connectOrCreate with an existing, missing, or concurrently created target | Capture, correlation/adoption rule, branch result, exact unique-conflict policy | Physical lowering reimplements found/missing policy separately for every relation storage |
| Extended unique selector with a nonmatching extra filter | No matching row is not proof that the unique key is absent | Every unique violation becomes retryable |
| Parent-held supplier plus scalar assignment to the same column | Both contributions reconcile before one root statement | Extra transient writes, a last-writer merge, or a second assignment ledger |
| Selected row changes its key, with cascading and non-cascading dependents | Which old values are read, which writes precede the change, and which final values are consumed | A simple producer-before-consumer sort strands an edge or repeats a cascade |
| Singular junction reconnect, transfer, and reconnect after a set clear | Occupant evidence and how an intervening clear invalidates it | An already-exact shortcut skips the insert after the membership was cleared |
| Duplicate connectOrCreate within one fragment versus across series members | Local first-producer agreement versus a later database observation | Global deduplication merges distinct visibility scopes or drops a required input occurrence |
| Generated field consumed in an indivisible array transaction | Exact publication transport or refusal before forbidden effects | Splitting commits simply to make the value available |
| Nested progressive series referring to a non-PK unique | Parent liveness plus the exact reference tuple across each commit boundary | A live parent key is accepted as proof of the old membership value |
| OwnWrite conflict plus an earlier missing target | Existing failure precedence and analysis scope | Executing the first read before the required earlier legality verdict |
| Untaken branch with a deferred legality failure | Which construction, planning, and execution work is eager or deferred | Either running every check early or making everything lazy |
| skipDuplicates root conflict followed by nested work | The boundary around the entire skipped subtree and committed prefix | Descendants run after a skipped root, or retry replays committed writes |
| Partial provider failure and malformed result after commit | Attempt outcome, acknowledged or uncertain progress, and error attribution | A matching final value hides a different committed prefix or silent failure |

For key transitions and singular transfer, reuse the existing [membership](../../src/query-engine/write-engine/relation-membership.ts), [transfer](../../src/query-engine/write-engine/junction-singular-transfer.ts), and [generated-output](../../src/query-engine/write-engine/generated-output-boundary.ts) contracts. They are concrete counterexamples to an algebra made only of final cells.

## A bounded way to choose, without another whole-engine bet

1. **Classify compatibility observations.** Separate public results, failures, side effects, concurrency, and lifecycle from diagnostic SQL/parameter/step snapshots. Preserve all current requirements initially. Any proposal to change the latter still needs review because statement extensions and instrumentation expose part of that behavior. The current plan's suggestion that set-diff versus clear-and-reinsert is only a byte difference is unsafe: triggers and statement effects can differ.
2. **Compare two implementations of one branch protocol.** Candidate A uses ordinary composition over current Parts. Candidate B uses a small inspectable structured program. Both cover the same connectOrCreate/upsert family across the meaningful storage and parent-state cases and reuse the same SQL and execution backend. Count construction, metadata, analysis, lowering, and compatibility glue, not only the new interpreter.
3. **Apply the adversarial witnesses before widening coverage.** Add selected-key movement and singular-slot transfer, then one sequential series with a later failure. These challenge ordering, shared root assignments, runtime-produced values, and commit scope. If either model needs a parallel truth table or arbitrary callbacks hiding behavior from analysis, include that cost and inspect whether the other representation avoids it.
4. **Choose the cheaper complete representation.** An explicit IR is justified only if its actual consumers share rules that ordinary functions cannot expose as cleanly. If functional composition yields the same deletion with less machinery, keep it. If the structured program removes repeated semantic decisions and their shadow analyses, adopt it at that seam.
5. **Replace one owner and measure net cost.** Temporary coexistence is acceptable in an isolated experiment. Before retaining the implementation, delete the superseded owner for the selected path and account for every retained helper. Removing the already-abandoned Pattern prototype is cleanup, not savings attributable to the winning design.
6. **Expand by responsibility.** Continue with branch semantics, membership/assignment composition, selected/fresh record assembly, then execution enforcement. Keep read/projection compression independently measurable. A new schema-wide frontend, general optimizer, or runtime should not arrive merely because it fits the diagram.

A strict trace oracle remains valuable during the comparison, but it must not be the only oracle. Execute valid differing plans against identical database setups, compare results and resulting state, and test controlled stale-premise and partial-commit schedules. A simulator answers the behaviors its scripts model; SQL, referential actions, and isolation still require the relevant real-provider evidence.

The first successful slice should identify actual deletable ownership, not announce a new whole-engine line target. Track physical LOC and token-bearing LOC at the same density, retained table/metadata size, minified and gzip bytes of the same public fixture, preparation allocations, round trips, and the established runtime/type-check benchmarks. A source reduction can coexist with an increased runtime bundle or slower preparation.

## How ELEGANCE applies

[ELEGANCE.md](../../ELEGANCE.md) is aligned with the objective: fewer independently maintained truths, precise ownership, and stronger representations. It does not require six primitives, one function, one pass, or a particular file count.

The current [write doctrine](../../src/query-engine/write-engine/ATOM.md) rejects generic mutation DSLs and branch runtime IRs, but explicitly permits reconsidering them when multiple owners implement the same rule. That is the review question now. Treating the rejection list as permanent would lock in the local complexity it was meant to prevent; treating it as permission for a generic VM would repeat the opposite mistake.

The recommendation is therefore conditional but concrete: **prefer a structured program with relational effects and scoped assumptions, implemented with ordinary functions, and prove that it beats a direct functional refactor on the same difficult branch protocol.** Use local dependency analysis and native SQL folds where they pay. The state machine describes execution; the program makes its meaning inspectable. Neither earns its place from its name or from an unmeasured LOC forecast.

## Evidence and limits

This review inspected the proposal, its amendment, both prior first-principles reports, ELEGANCE, current engine doctrine, the relevant production owners, the Pattern contracts/scheduler/packer, and the differential harness. No new architecture was implemented and no test or benchmark was rerun for this review. Historical test counts are not fresh validation or proofs of impossibility. The candidate still needs the comparative implementation described above.

Sources: [Prisma graph](https://github.com/prisma/prisma-engines/blob/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/query-compiler/core/src/query_graph/mod.rs), [Prisma expressions](https://github.com/prisma/prisma-engines/blob/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/query-compiler/query-compiler/src/expression.rs), [MLIR effects](https://mlir.llvm.org/docs/Rationale/SideEffectsAndSpeculation/), [SQLAlchemy flush](https://docs.sqlalchemy.org/en/20/orm/session_api.html#sqlalchemy.orm.Session.flush), [PostgreSQL WITH](https://www.postgresql.org/docs/current/queries-with.html#QUERIES-WITH-MODIFYING). The initial external search output is at /tmp/viborm-raptor3-engine-shapes-2026-09-07.json; the exact Prisma revision was resolved and read separately.
