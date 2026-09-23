# Raptor 3 — a clean-sheet relational program

Date: 2026-09-07. Status: design investigation, not an implemented engine or a size forecast.

**Implementation authority:** [the central implementation plan](./raptor3-implementation-plan.md)
owns G0–G4, assignable work units, parallel handoffs, the class/context design,
DST, size targets, and stop/review/adoption decisions. Size shortfalls do not
automatically abandon a candidate with demonstrated engineering benefits.
This document remains the derivation of the shared language. The representation
is not selected: the working preference is structured commands with shared query
expressions and construction-derived facts. The central plan costs that
hypothesis in G0-01, then compares it with a scoped relational program before
handoffs freeze. Confidence is moderate; exact dependency and scope obligations
may favor the separately analyzed representation.

The [trusted-argument rule](./raptor3-implementation-plan.md#23-validate-at-admission-trust-the-engines-arguments)
also governs this design: admit input at its existing highest applicable
boundary, trust parsed payloads and internal values below it, and allow narrow
TypeScript assertions instead of redundant runtime checks or type machinery.

## 1. The starting condition has changed

Design a new query/write engine from the public feature contract. Assume that **none of the current engine survives**. An existing mechanism may reappear only when a concrete requirement independently leads to it; its current existence is not evidence that its shape or cost is necessary.

This replaces the reuse-first premise of [the previous build plan](./raptor3-language-and-build-plan.md). Keeping the current executor, Part interface, physical builders, read engine, or parser is no longer an architectural constraint. The older plan remains a conservative alternative, not the boundary of this investigation.

The hypothesis developed here is **a scoped relational language**: queries describe shaped outputs over records and associations; changes consume and produce exact record occurrences; composition states dependencies and observation/commit boundaries. Nested public operations expand into that language. A small set of storage mappings translates association changes into row changes. A separately analyzed program and a structured command tree are competing representations of these meanings, not additional concepts the engine must carry together.

The important change is not renaming six primitives to three. It is moving from “a shared write vocabulary interpreted by existing machinery” to “one representation of the data being addressed, the effects requested, and the boundaries under which they are valid.” Reads are in scope too.

No production code is changed by this investigation. The derivations below are design arguments checked against public documentation, selected contract witnesses, and primary research. They are not executable conformance proofs.

## 2. Establish the contract without inheriting the implementation

### What must be carried into the new design

| Requirement | Evidence and consequence |
|---|---|
| Existing public operations, fluent schema API, inferred types, no user code generation or import-per-feature requirement | [Client surface](../content/docs/client/index.mdx). A new internal language does not require a new public language. |
| Root and nested filtering, selection, ordering, pagination, aggregates, and result shape | [findMany](../content/docs/client/(read)/find-many.mdx), [groupBy](../content/docs/client/(read)/group-by.mdx), [selection](../content/docs/client/selecting.mdx). “One engine” must not erase read-side work from its accounting. |
| Nested create/connect/update/upsert/disconnect/delete/set and relation-bearing bulk | [Nested writes](../content/docs/client/nested-writes.mdx). These are requested effects with specific failure and ordering meanings, not merely target database states. |
| Complete row/reference keys, mapped columns, scalar codecs, fixed and variant relation storage | [Compatibility](../content/docs/client/compatibility.mdx), [relation glossary](../../CONTEXT.md). Physical identity is a tuple, not an assumed `id` column. |
| Atomic callback/array transactions and explicitly segment-atomic dynamic routes | [Transactions](../content/docs/client/transactions.mdx), [D1](../content/docs/drivers/sqlite/d1.mdx). A batch-only transport does not supply a JavaScript continuation inside an open transaction. |
| Exact generated values, subtree skip ownership, legitimate unique-race recovery, committed-progress reporting | [Generated keys and execution substrate](../content/docs/client/compatibility.mdx#generated-keys-and-the-execution-substrate), [nested createMany](../content/docs/client/nested-writes.mdx#createmany-nested). These are correctness obligations even if every current implementation file disappears. |
| Extension, raw SQL, validation/default, failure, and result ownership boundaries | [Extensions](../content/docs/extensions/index.mdx), [raw SQL](../content/docs/client/raw-sql.mdx), [errors](../content/docs/client/errors.mdx), [project contracts](../../AGENTS.md). A smaller compiler does not acquire permission to bypass those boundaries. |
| Future recursive relationship traversal | [Recursive-query proposal](../../features-docs/recursive-query.md). It is a design witness, not a claim that this deferred feature already works. |

### What has no automatic right to survive

Current class/file boundaries; the `planning()`/`compile()` interface; a separate OwnWrite interpreter; string-indexed planning bags; fresh/selected relation dispatch families; physical fragment variants; parser class structure; a universal read-before-write schedule; exact internal step names; and current SQL formatting.

This does **not** mean all physical behavior is freely interchangeable. The nested-write documentation explicitly promises a single final parent-held FK assignment without transient NULL, clear/refill atomicity, supplied-row modification after supply, and specific bulk progress behavior. Locks, triggers, statement transformations, and failures can expose a changed schedule. Preserve those guarantees or explicitly propose a contract change.

Classify existing tests into three groups before making them rewrite gates:

1. **Contract witnesses:** public results, affected and untouched rows, error category/attribution, atomicity, progress, race behavior, input evaluation and lifecycle guarantees.
2. **Implementation pins:** private class calls, internal step IDs, SQL aliases, a particular intermediate fragment shape.
3. **Mixed witnesses:** an exact trace that currently protects a real ordering or concurrency property. Extract that property; retain the strict pin until its replacement witness is adequate.

For example, the [transition suite](../../tests/contracts/engine/write/parity-d-transition.core.test.ts) pins `org.locate` and exact planning SQL, but also protects the important distinction between an old reference tuple and the tuple new memberships must store. The first is not a new-language requirement; the second is. The [public conformance harness](../../tests/contracts/engine/query/nested-write-conformance-fixtures.ts) checks errors and persisted state across two substrates, but is not by itself a complete result, lifecycle, or concurrency oracle.

Existing documented refusals also need classification. A missing transport capability and an architectural inability to return a changed ancestor key are not the same kind of limitation. Preserve current admission initially; mark potentially liftable refusals separately instead of building their old justification into the new language. Lifting one is a distinct compatibility decision, not an incidental rewrite effect.

## 3. Derive the language from the data, not the current verbs

### 3.1 One relational vocabulary for addressing data

A model denotes stored records. A relation slot denotes an association view between source and target records. The view is determined by field correspondences, fixed qualifiers, and the schema's constraints.

Conceptual read notation:

```text
records(Model)
related(sourceOccurrence, slot)
where(query, predicate)
orderAndPage(query, ordering, page)
group(query, keys, aggregates)
project(query, shape)
```

`related` is not a second kind of model or a separately stored collection. It expands to the appropriate relational expression over the stored rows. Root and nested selection can therefore consume the same query operators.

This is a SQL-aware relational vocabulary, not mathematical sets silently substituted for SQL. Row multiplicity, NULL semantics, empty aggregates, ordering, per-parent pagination, field codecs, and scalar expression semantics remain explicit. An object projection is not just a flattened join: it retains its occurrence grouping and one/many result shape.

Each query describes its output fields/expressions, cardinality, codecs and
correlation scope. A grouped count is a shaped output, not a selected model
record with an invented identity. Pagination applies inside the query's scope,
so per-parent pagination is ordinary scoped composition, not another handler.
Pure reads consume these same query/projection owners without write machinery.

### 3.2 A relation's read meaning does not uniquely determine its write meaning

Removing a row from a join can mean removing an association, deleting a target, or deleting a source. We need the requested edit as well as the view. The original relational-lenses work addresses this ambiguity by composing explicit view-update policies; this supports the factoring direction, not automatic inference of every mutation. [Bohannon, Pierce, and Vaughan](https://www.cis.upenn.edu/~bcpierce/papers/dblenses-tr.pdf)

For VibORM the problem is narrower than arbitrary updatable SQL views. The user already says `connect`, `disconnect`, `delete`, or `set`, and the declared relation already determines where association storage lives. We can translate those explicit edits through a small set of schema-derived mappings.

| Association storage | Establish an association | Remove the association without deleting its endpoints |
|---|---|---|
| A stored row reference | Contribute the complete referenced tuple to the row that stores it | Clear the stored tuple if the storage permits it |
| A junction row | Insert the complete endpoint tuples and fixed qualifiers | Delete that membership row |

“Parent-held” and “child-held” become orientations of the first mapping, not separate mutation languages. A fixed variant qualifier is part of the mapping. Singular ownership adds an occupancy/transfer requirement; it does not introduce another public-verb interpreter.

This is not a claim that those two table rows implement all relation semantics. Replacement order, required membership, inverse uniqueness, cascades and failure policy still constrain a mapping's use. The claim is that each constraint gets one rule against a common representation, rather than a new implementation in every verb/storage combination.

Do not adopt a general lens framework as the engine. The cited original calculus itself restricts repeated references to a table; VibORM needs self-relations and repeated aliases. Its insight about explicit update policy is useful; its complete language and proofs are not a ready-made solution for this contract. [Original paper, §5.7](https://www.cis.upenn.edu/~bcpierce/papers/dblenses-tr.pdf)

### 3.3 Values name a producer, not a compiler phase

A value is an admitted value/expression or a reference to an exact producer's
output. Its query output shape does not imply addressable model identity.
An addressable record binding additionally identifies the exact record
occurrence/model and complete row/reference fields needed by its consumers.
A change can expose a before-image and a successful after-image; deleting a
record has no surviving after-image. These meanings need neither an all-optional
universal binding nor a separate value hierarchy for every query operator.

```text
field(selectedRecord, referenceField)
field(successfulChange, referenceField)
selectedBinding(alternative)
```

The program must distinguish intended assignments from stored/published values. A literal ID does not prove that its INSERT happened. A database expression does not become a known JavaScript value. Two opaque expressions are not proven equal because their SQL text matches.

Record versions here are relationships between occurrences in the operation, not a new database version column, a global identity map, or a promise to distinguish physical delete/reinsert incarnations. Equal row keys alone do not establish interchangeable occurrences.

Complete row-key and reference-key projections come from the same binding. Their roles remain different; no caller carries independently reconstructed old/new copies of them.

### 3.4 Requested changes remain effects

The storage-level effects are INSERT, UPDATE and DELETE over addressed rows, with demanded outputs and preconditions. They are not reduced to a final desired table: an UPDATE and a DELETE/INSERT may have different required effects even when their final row values agree.

An association edit first translates through its schema mapping. Its assignment contributions enter the owning record change before that change is materialized. This recovers one root INSERT/UPDATE without recovering the original relation verb inside the SQL backend.

A **record block** is a construction boundary, not a new runtime class family: declare one fresh/selected change, collect its scalar and association contributions, recursively construct nested work, then seal its column assignments and dependencies. Two intentional updates of the same physical record remain two effects. Only contributions to the same declared change are candidates for reconciliation.

This boundary is rediscovered because two nested intents may contribute to the same physical root column. It is necessary to decide their agreement before writing that column. The current root compilers are not necessary to express that rule.

### 3.5 Composition expresses time and choice

Programs require binding, conditional alternatives, body instantiation, ordered
repetition and execution scopes. Those meanings cannot all be inferred from
foreign keys. They describe composition, not a requirement for a node/class
implementing each word.

```text
query / change                 produce bindings
bind                           make a binding available to dependent work
case                           select one alternative and its outputs
ordered traversal              instantiate the same body for each occurrence
scope                          state observation, atomicity and recovery boundaries
```

This is a proposed normal form, not a finished TypeScript API or a target opcode count. Requirements, failure policies, projection descriptors and value expressions count toward its cost even when represented as annotations rather than nodes.

Within a region, construction describes dataflow; declaring a parent's change before a child's does not force the parent INSERT to execute first. The row-reference mapping can make the parent's assignment depend on the child's successful output. Explicit causal order remains where the contract needs it, such as clear before refill or supply before modify.

References and required ordering must admit an executable schedule. A dependency cycle is not solved by arbitrarily choosing a node, treating an uncreated row as present, or adding transient NULL. Use a genuinely supported physical strategy or refuse the shape before its effects.

Ordered repetition is not equivalent to a set-oriented bulk mutation. Relation-bearing members may observe earlier members; scalar bulk leaves preserve set-based execution and their count/returning semantics. The same body language serves a root, a nested record, or a series member.

A reusable body is not one already materialized member. At the existing
admission boundary, bind the current occurrence and obtain that instance's
trusted values; derive any value-dependent obligations from that exact instance
before its effects. Do not reuse a dependency answer computed for different
defaults. Preserve the existing distinction between new-member admission and
retry of an already prepared member; do not add another parser or eagerly
prepare later members. Deferred structure remains inspectable wherever
pre-effect admission needs it, without creating a second series compiler.

### 3.6 What is stored once, and what should be derived

| Program/schema fact | Derived consequences |
|---|---|
| Reference to an exact shaped producer output | Output demand, value availability, producer-before-consumer dependency, permitted value transport; record addressing only where the producer establishes it |
| Association storage mapping | Read correlation, stored column contributions, complete tuple projection, affected storage |
| Query binding plus its required premise at use | Exact target addressing and the predicate that needs physical protection |
| Effect inputs, outputs and affected rows/columns | Dependency/conflict analysis and which known premises an operation's own effects invalidate |
| Explicit ordering and scope | Which reorderings/fusions are legal, what can be batched, what can be retried, what can already be committed |
| Selected alternative | Which outputs and facts exist; no publication or effects from an unselected alternative |
| Public result projection | Required scalar decoding and nested grouping; not a second independent result-query interpretation |
| Admitted body instance in its occurrence/scope | The exact values/effects that are analyzed and executed; a template does not authorize all future instances |

Some choices remain inputs, not deductions: delete versus disconnect, skip versus fail, exact unique-race policy, promised atomicity, and whether an observation is merely a snapshot value or a condition that must still hold at use. The language gets smaller by deriving consequences, not by hiding those choices in a backend.

## 4. Public operations become compositions

The following recipes are semantic sketches. They do not specify one SQL statement per line.

| Feature | Composition |
|---|---|
| `findMany`, `findFirst`, `findUnique`, existence | Query + ordering/page + cardinality/result policy + projection |
| `count`, `aggregate`, `groupBy`, `having` | Query + grouping/aggregation + group predicate + projection |
| Relation filters, includes, relation ordering | The same association view consumed by predicates, projection, or ordering |
| Root/nested `create` | Construct a record change recursively; establish requested association contributions |
| `connect` | Select required target(s); establish the association |
| `connectOrCreate` | Bind a unique lookup; choose existing target or recursive create; establish the association |
| `update` | Bind the required selected record; contribute assignments and recursive relation edits; publish the change |
| `upsert` | Bind the decision target; choose update or recursive create; join the selected output |
| `disconnect` | Remove the selected/current association through its mapping; preserve endpoint lifetime |
| `delete` | Delete the selected target record, with required association/cascade consequences |
| `set` | Resolve requested targets; enforce departure policy; perform the required ordered removal/refill edits |
| Scalar bulk | One set-oriented change, with legal statement partitioning |
| Relation-bearing bulk | Capture roots once, then instantiate ordinary record bodies under each member's existing admission timing |
| Callback/array transactions | Compose ordinary programs under the requested atomic scope; callback input may depend on completed outputs |
| Recursive relation query | Recursive closure of the association query, followed by occurrence-aware projection |

Public semantics still distinguish targets: a nested correlated update must not mutate an unrelated globally matching row. A correlated upsert must distinguish missing globally from found-but-foreign. Cardinality expectations and failure contracts belong in these recipes, not in a second downstream verb switch. [Nested update/upsert contract](../content/docs/client/nested-writes.mdx)

The proposed factoring is approximately **public recipes + storage mappings + execution capabilities**, rather than complete algorithms for their Cartesian product. That is a design objective, not a proof that every interaction is separable. A genuine interaction must become one explicit law with a witness, not an unexamined exception in several consumers.

## 5. Four mechanisms to derive instead of rebuilding separately

### 5.1 Assignment and address continuity

All scalar and association contributions address the same declared change and physical columns. Agreement is defined on admitted values and exact producer references. The change's successful binding supplies later addresses.

An ancestor key update is therefore a new binding consumed by later work, not a callback that every child compiler must understand. A conditional re-entry can, in principle, return the ancestor's new binding to its enclosing continuation. This expresses the missing information behind the current key-changing-loopback refusal; it does not automatically establish safe scheduling or authorize lifting that refusal.

### 5.2 Premise protection

A query can supply a snapshot value without promising it remains true. A mutation can also require that its target or membership premise holds at the mutation boundary. These must be distinct in the program.

The backend proves each required premise with a legal lock/constraint/guard/postcondition strategy for the actual provider and scope. A transaction does not automatically protect every absence or predicate. Unsupported enforcement remains a refusal, never a silent assumption.

Track only the facts this program requires. Do not build an in-memory database or attempt to evaluate arbitrary SQL predicates. Equality/disjointness that cannot be proved remains unknown. The appropriate owner must conservatively enforce the requirement or apply the existing admission rule.

### 5.3 Same-operation dependency analysis

The semantic structure already exposes selections, changes, alternatives and
scope. Required dependency analysis consumes these exact admitted instances,
not a second walk of public mutation syntax or a previously materialized body.
Where construction establishes a fact, consumers use it directly. A separate
whole-program pass earns its place only for facts that require that broader
view; it is not a mandatory layer of the language.

There is still a real contract here: an ordinary create followed by a dependent connectOrCreate in one payload is currently refused. [Compatibility](../content/docs/client/compatibility.mdx) and [root-dependency witnesses](../../tests/contracts/engine/query/nested-write-conformance-root-dependency.test.ts) pin it. Removing a shadow interpreter must not silently turn that into read-your-writes behavior.

Likewise, permitted same-operation first-producer reuse is not permission to merge all equal-key effects. Its exact selector, branch and scope rules belong to the ensure-like recipe. Ordinary creates retain their duplicate behavior. A sparse, scope-local proof environment may share proven producer bindings; it may not act as a global identity map or invent SQL predicate answers.

This analysis is one of the serious remaining compression risks. A tiny execution loop with a second large per-verb analysis is not success.

### 5.4 Scheduling and continuation

Scheduling consumes dependencies, explicit order, premise requirements and provider capabilities. It does not start from a universal “all reads, then all writes” rule. A particular scope may still require a read frontier; it is derived or explicitly justified there.

An exact value may be carried as a parameter, a producer-returned field, or a legal statement-local expression. If it requires a round trip, an interactive transaction may keep the atomic boundary open. A batch-only route must have a legal same-submission form, cross an expressly permitted committed boundary, or refuse before effects.

At a committed cut, inspect the live references consumed afterward. Values do not expire, but claims about the continued existence or membership of the rows they identify can. Re-establish the required facts in the consuming atomic segment. Keep acknowledged progress outside replayable attempt state.

SQL fusion is a proved optimization, not the definition of the language. PostgreSQL's data-modifying CTEs share a snapshot, communicate changes through `RETURNING`, and do not provide reliable repeated modification of the same row in one statement. A dependency graph alone does not make arbitrary sequential work one CTE. [PostgreSQL WITH documentation](https://www.postgresql.org/docs/current/queries-with.html#QUERIES-WITH-MODIFYING)

## 6. Try to break the language

### A. Two contributions to one root column

Request: update a scalar foreign key while also connecting its relation.

The scalar contributes one value; the relation mapping contributes another to the same declared change. Proven equality permits one assignment. A conflict rejects before the root write. The rule is independent of whether the target was found, created, or selected by a branch. No per-verb root assignment assembler is required by this case.

Unresolved obligation: represent opaque expressions and provider-stored values without falsely equating them to intended inputs. A reference wrapper alone is not a proof.

### B. A parent-held nested create

The new target produces a field that the parent's stored reference needs. That field reference creates the ordering edge: target before parent. The parent's change remains unmaterialized until the contribution is known.

Reverse the storage orientation: now the target's stored reference consumes the parent's successful field, so the order reverses. The recursive create recipe has not changed. Only the storage mapping and resulting value dependency changed.

With all values known in advance, referential existence and explicit order still matter. Known IDs do not make either INSERT optional or prove the other endpoint exists.

### C. Found-but-foreign nested upsert

Conceptually:

```text
candidate := optional unique lookup in target domain
case candidate
  present:
    require candidate belongs to the selected source at use
    chosen := recursively update candidate
  absent:
    chosen := recursively create target
    establish its association with the source
```

A globally present foreign row fails the present arm; it is not an absent member that permits a duplicate insert. Exact unique-race recovery attaches to the absent target decision and replay boundary. It is not a property of every failed INSERT.

The same branch binding feeds a row-reference contribution or a junction-row change. The branch algorithm does not acquire a storage-specific copy.

### D. Reference-key movement

An existing association is addressed through the selected record's before-fields. New association storage can depend on the successful changed fields. A real cascade may carry an existing reference across that change; otherwise an occupied restrictive reference can make the change unavailable.

This requires versioned bindings, referential constraints and ordering. It does not require separate “planning source,” “final source,” and per-parent-state callback families. Compound and mapped keys use the complete field projection from the same binding.

### E. Singular junction transfer followed by clear/refill

Capture the slot's owner. A transfer must enforce its captured occupancy premise at use. If the desired association already exists, an ordinary reconnect may need no row change.

But a preceding clear removes that very fact. The later refill cannot eliminate its insertion using the pre-clear observation. Represent clear as an ordered effect with an affected membership set; invalidate that proof where it intersects. Do not introduce a new “after-clear reconnect” public-verb family.

Unresolved obligation: prove the necessary overlap with complete keys and qualifiers, without a large general predicate solver or accidentally weakening the required clear/refill protocol.

### F. Supplier followed by modifier

A create supplies a successful record binding. A later relative update consumes the stored row after that supply; it must not be folded into a pre-insert literal calculation when doing so changes statement/default/trigger semantics.

This is ordinary dependent program composition. The current membership re-locate is one possible physical strategy, not an independent semantic primitive. Use exact output transport when it proves the same target and requirements; otherwise retain a justified locate. Changing the currently documented extra round trip needs a deliberate compatibility/performance assessment, not a private assumption.

### G. Skippable root with descendants

The descendants depend on successful root insertion, not merely on its assigned key. A skip produces no successful root binding, so no descendant body runs.

An earlier child write needed to supply that root complicates suppression: it must roll back with the skipped root. An interactive savepoint can provide a suppression boundary. A route that has already committed that child cannot provide the same guarantee and must refuse before that member's effects. This distinction follows from dependency plus recovery scope, not from a special createMany engine.

### H. Later segment fails after an acknowledged prefix

Only the current replayable region may restart. Completed segments remain in the outer progress record. A provider failure after dispatch but before reliable acknowledgement must not be represented as “nothing happened.” Stable caller inputs/defaults and completed results have different lifetimes from attempt captures.

The runtime therefore has genuine state, but it is state of executing this program. It does not need a state machine for each public verb or relation storage.

### I. One body, two evaluated occurrences

Two selected roots each contain a nested create whose default supplies its key.
The same body must produce two independently evaluated identities. A changed
default can also change an own-effect dependency, so the admitted instance—not
an earlier template analysis—must justify its effects. This extends ordinary
binding/scope semantics, not a default-sensitive or updateMany-only handler.

### J. Query values without record identity

A grouped count describes several records; it is not itself one addressable
record. Two parents can each return their first related row, including the same
target in two output positions. Shaped outputs and correlation preserve both
meanings without fake keys or separate aggregate/paginated projection engines.

These cases suggest common laws, not proven physical implementations. The
[central plan](./raptor3-implementation-plan.md#6-work-packages-and-exact-milestone-exits)
owns the executable S1–S4 comparison and later falsifiers. A failing case
first revises its existing semantic owner; it does not automatically earn a
new flag, node, handler or pass. Necessary semantic/provider branches remain
explicit in their single owner.

## 7. Recursion should be structural

### Nested writes and re-entry

Each nested payload constructs another ordinary record body. Depth adds program occurrences, not compiler families. A self-relation reuses the same schema mapping with different aliases/bindings. Do not recursively expand the entire schema graph merely because a model points to itself.

Ancestor re-entry must explicitly name the selected occurrence and return any changed binding to later consumers. Equal keys do not automatically create that relationship. A branch-produced final key must be joined before a later sibling can consume it.

### Recursive reads

The deferred feature adds a recursive closure over the same association query:

```text
traverse(seed occurrences, relationship hop, termination/filter policy)
project traversal occurrences into the requested relation shape
```

The backend may express that closure with a recursive CTE. It is not an ordered write series and must not require a query per depth by construction. Compound keys, hop direction, multiple roots, repeated path occurrences, cycle policy, and hidden fields needed for assembly belong in the feature contract.

The [existing recursive-query sketch](../../features-docs/recursive-query.md) is not yet that contract: its `true` path omits the claimed hard depth limit; its sample hop takes only the first key pair; its assembler keys globally by one field and writes `children`; and the sample query does not implement the promised filter/order behavior. These are findings about proposed code, not shipped feature defects.

Sharing the relationship expression helps, but result assembly remains real work. Returning a nested graph is different from merely finding reachable records. Cycle cutoff and “filter prunes traversal versus only hides output” must be decided explicitly before implementation.

## 8. Compare representations of the shared language

| Candidate | Useful insight | What prevents it from being the whole answer |
|---|---|---|
| Desired final-state graph | Association changes can share a storage model | Effect history, success provenance, failure boundaries and clear/refill semantics cannot be recovered from final rows alone. Enriching it can converge toward an explicit effect program. |
| Direct recursive imperative execution | A small reference semantics; nested bodies compose naturally | Opaque callbacks hide future effects from batch planning and pre-effect admission. A production form needs inspectable structure or a demonstrated equivalent analysis. |
| Structured commands containing shared query expressions | Construction establishes semantic order and local dependencies directly; pure reads compile through common query/projection owners | Reversed storage, conditional producers and batch admission may still require deferred references and broader analysis. Inspectable commands are not opaque callbacks; test whether they can avoid a separate program/pass. |
| General fact/rule or constraint solver | Many consequences can be derived rather than enumerated | Deletes, absence, mutable keys and commits make fact lifetime non-monotone. A general solver may replace obvious code with a larger inference engine. Use bounded derivations with named owners. |
| Full statechart | Makes runtime progress and recovery explicit | Transition payloads still need query/mutation semantics. It organizes execution but does not compress the feature language by itself. |
| Scoped relational program with explicit effects | Shares addressing, association mappings, values and dependency analysis across reads/writes | Requires a small but real lowering/enforcement layer. Its whole cost must be measured, especially same-operation analysis and scope handling. |

The two inspectable candidates face the same small executable comparison in the
central plan. Neither is entitled to win. If they converge, retain one coherent
representation, not both behind public-verb or fixture-specific dispatch.
Compare all construction, analysis, lowering and execution cost, not a tiny
interpreter hiding complexity upstream.

Neither candidate prescribes a general-purpose VM, free-monad library, immutable graph framework, visitor hierarchy, or one class per operator. Following the implementation preference, use composed classes with one broad operation-owned context; use inheritance for actual substitutable implementations. Semantic values stay closed and inspectable where needed, and ordinary functions remain available. The [central plan](./raptor3-implementation-plan.md#21-one-broad-context-composed-classes) defines ownership and separates operation, attempt, frame, and committed-progress lifetimes without parameter cascades. Recursive syntax and producer references are useful only insofar as they remove independent reasoning.

## 9. Build it as a new engine, not a permanent adapter over the old one

The execution-ready G0–G4 sequence now lives only in the
[central implementation plan](./raptor3-implementation-plan.md#6-work-packages-and-exact-milestone-exits).
Its first assignment combines a costed blueprint with fixed contract evidence,
a small recorder/replayer and frozen baseline, followed by the bounded
representation comparison. Generation,
shrinking and fault coverage grow in the same harness with the selected slice.
The full feature
envelope, whole-cost measurements, and candidate-only package gates precede
cutover. Do not keep a second mutable implementation checklist here.

A small physical SQL helper may independently prove to be the right implementation and be reused. That is a finding, not a survival budget. Every retained owner gets a sentence naming its independently necessary responsibility and the new consumer that needs it, and is charged under the central plan's accounting rules.

## 10. Compression criteria and remaining uncertainty

The earlier 25–35% estimate described a narrower, reuse-first write rewrite. It is not a ceiling and is not transferred to this broader clean-sheet design. The central plan now requires a source-grounded cost forecast in G0-01: removal/replacement ownership, complete cost ranges, assumptions and falsifiers before candidate code. That forecast has not yet been produced. Its range is distinct from numerical size targets and from measured results; a missed target prompts an explicit trade-off decision, not automatic abandonment.

Count the entire candidate: public-to-program expansion, program/value definitions, storage mappings, analyses, SQL lowering, runner, projection/parser, runtime tables, retained dependencies and glue. Keep types and generated output visible in separate measurements; moving code into tables or generated programs is not disappearance.

The strongest tests of compression are structural:

- Adding nested depth uses the same body language and no new semantic handler.
- A public verb is expanded once; a storage mapping and backend do not reconstruct that verb's algorithm.
- Root and nested addressing use the same relationship/query vocabulary.
- Output transport and ordering consume producer references, not parallel old/new state bags.
- Execution and necessary dependency reasoning consume the same admitted
  instances; facts established during construction are not reinterpreted.
- A new feature such as traversal adds the missing query meaning and result handling, not a parallel engine.

There is no proof here of a unique minimal language or a tiny complete engine. The serious unknowns are the total cost of exact overlap analysis, scope-aware physical enforcement, type-safe recursive projection, and preserving performance without a second fast-path language. Those are where the candidate should be attacked, not dismissed by pointing at the current engine's LOC.

The decision to investigate this family is stronger than the previous proposal in one specific respect: **no existing engine layer is sheltered from replacement, and read/write addressing participates in the compression hypothesis.** Anticipate the gain from named responsibility eliminations and replacement costs; only a complete working slice can turn that forecast into a measured claim.

## Sources and verification

Repository sources are linked beside the contracts and witnesses they support. The primary external sources used were:

- [Relational Lenses: A Language for Updatable Views](https://www.cis.upenn.edu/~bcpierce/papers/dblenses-tr.pdf) — explicit update policies and the limits of the original calculus.
- [Incremental relational lenses](https://dl.acm.org/doi/10.1145/3236769) — a researched precedent for propagating view edits as changes rather than requiring full view replacement; not an ORM size forecast or an implementation dependency.
- [PostgreSQL WITH queries](https://www.postgresql.org/docs/current/queries-with.html#QUERIES-WITH-MODIFYING) — why SQL dataflow does not make all ordered mutations one statement.

Search records: `/tmp/viborm-raptor3-clean-room-primary-sources.json` and `/tmp/viborm-raptor3-view-update-sources.json`. Secondary search results were not used as technical evidence.

Validation for this investigation: source and contract inspection, link/whitespace checks, and the reasoning witnesses above. No candidate interpreter, conformance suite, benchmark, or bundle comparison was executed. Documentation-only changes record the revised premise and domain distinction; production source remains unchanged.
