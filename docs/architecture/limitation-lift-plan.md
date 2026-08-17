# Query-Engine Limitation Lift Plan

**Date:** 2026-08-09
**Status:** Decision-complete implementation plan
**Starting commit:** 2ca32ad45465bf9f2b75f9047ea8761df22b6670

> **RecordSeries history note (2026-08-14):** The transaction-first interface,
> executor algorithm, and delivery packages below record the original checkpoint.
> The later relation-bearing bulk and generated-output passes supersede their
> batch refusal: any no-transaction driver with native atomic batching may execute
> a safe progressive series after normalized success. The strong committed-segment
> flag adds callback-before-decode attribution; explicit `$transaction([...])`
> arrays remain indivisible. Sections 5.1, 7.3, 7.5, and 11 state the current
> RecordSeries contract.

## 1. Outcome

Lift the query-engine restrictions that have useful, coherent semantics while extending the concepts that already own record mutation:

- RelationMutationProgram continues to describe one parsed relation request.
- BoundRelation continues to describe physical relation topology.
- CreateOperation remains the only non-bulk fresh-record compiler.
- RecordUpdateCompiler remains the only selected-record update compiler.
- TargetProjection becomes the single owner of a selected record's ordered row
  key and required captured fields.
- Ordered reference keys describe what a relation points to; stored references
  describe where those key members live. Row addressing and relation storage
  remain distinct even when both use the same primary-key fields.
- Existing field-bound FinalReferenceSource values continue to carry literals, planning values, transitioned values, final references, and lookups.
- One new operation-level execution form, RecordSeriesOperation, expresses an
  ordered, data-dependent sequence of ordinary record operations.
- PostgreSQL receives an optional dependency-aware mutation CTE fold over the existing OperationValueReference graph.

The capability architecture is portable. The CTE fold is an optimization and never determines whether a public operation is supported.

The implementation must preserve every existing fast path. New round trips are allowed only for payload shapes that are currently refused and only when those round trips are required to express the requested semantics correctly.

The current query-engine census contains 31 UnsupportedOperationError
construction sites. That is a site count, not a count of distinct limitations.
After the capability work, perform an explicit ownership audit. The expected
result is approximately 8–12 uniquely justified sites. This range is a review
trigger, not a numerical substitute for proof: every survivor must catch a
failure that no earlier owner catches.

## 2. The CTE decision

### 2.1 What one PostgreSQL statement can express

PostgreSQL can pass a generated field from one mutation to a later mutation through the first mutation's RETURNING relation:

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
SELECT parent_record.id
FROM parent_record;
~~~

This is a good match for a guard-free create dependency graph:

~~~text
parent INSERT
  -> returned parent identity
  -> child INSERT
  -> returned child identity
  -> grandchild INSERT
~~~

It is not a universal nested-write representation. PostgreSQL data-modifying CTE arms share one snapshot. A later arm cannot observe an earlier arm by rereading the modified table; the explicit RETURNING relation is the communication channel. Independent arms do not have a reliable execution order, and one command must not attempt to modify the same row twice.

### 2.2 Provider matrix

| Provider family | Data-modifying CTE bodies | Composable mutation output | One-command generated-value flow |
|---|---:|---:|---:|
| PostgreSQL and PGlite | Yes | RETURNING relation | Yes |
| MySQL and PlanetScale | No | No PostgreSQL-style DML RETURNING relation | No |
| SQLite, libSQL, D1, and Bun SQLite | No | RETURNING is top-level only | No |

The current capabilities already state this truth:

- PostgreSQL sets supportsCteWithMutations to true.
- MySQL sets supportsCteWithMutations to false.
- SQLite sets supportsCteWithMutations to false.

Authoritative provider references:

- [PostgreSQL data-modifying WITH](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL RETURNING](https://www.postgresql.org/docs/current/dml-returning.html)
- [MySQL WITH](https://dev.mysql.com/doc/refman/8.0/en/with.html)
- [MySQL LAST_INSERT_ID](https://dev.mysql.com/doc/refman/8.4/en/information-functions.html)
- [SQLite RETURNING](https://sqlite.org/lang_returning.html)

### 2.3 Fixed architectural decision

Implement capabilities first with ordinary record compilers and transactional sequencing. Add the PostgreSQL CTE fold afterward as a strict optional lowering.

Do not:

- Make public capability depend on PostgreSQL.
- Build a second PostgreSQL relation compiler.
- Encode found/missing branches, OwnWrite analysis, membership decisions, retries, or validation inside the CTE lowerer.
- Add an nth-row output reference, bulk mutation DSL, strategy table, lifecycle framework, or runtime step kind.
- Infer SQL semantics by parsing generated SQL text.

The CTE lowerer consumes a final, already-selected, guard-free write dependency graph. If it cannot prove exact equivalence, it returns no fold and the portable transaction path executes unchanged.

## 3. Fixed compatibility contract

### 3.1 Existing operations

For every payload accepted before this work, preserve:

- Public input and result types.
- Runtime validation and validation timing.
- SQL text and parameter order.
- Planning and final step IDs.
- Planning outputs.
- Statement count and round trips.
- Execution order.
- Guards and postconditions.
- Race pins and retry ownership.
- Error class, message, metadata, and attribution.
- Direct execution, RETURNING, ON CONFLICT, mutation-projection CTE, planning-batch, and atomic-batch routes.

Six packages deviated from this contract. Every deviation was measured before it
was taken and ratified with a reason; they are listed with their witnesses in
[§12](#12-31-deviations-ratified).

### 3.2 Newly accepted operations

Newly accepted shapes may use more statements and round trips when the provider cannot express the semantics in one statement.

They must still:

- Execute atomically or refuse before any effect.
- Use the same relation semantics as the corresponding ordinary single-record operation.
- Preserve input order where the public operation is ordered.
- Validate and construct every record member before the first write in its transaction series.
- Retry the complete outer operation after a raceable failure. Never retry one member locally.
- Leave no partial effects on any failure.

### 3.3 Non-goals

This plan does not:

- Add compound many-to-many join sides. It does establish the ordered row-key,
  reference-key, and junction-side contracts that the later capability must use.
- Define skipDuplicates plus nested-effect semantics.
- Emulate database referential actions.
- Add adapter APIs solely for relation concepts.
- Change the public meaning of existing bulk scalar operations.
- Accept contradictory foreign-key values.
- Accept ambiguous competing suppliers for one to-one slot.

## 4. Final internal contracts

### 4.1 Row keys, reference keys, and membership keys

Use these terms consistently. Do not introduce a universal `Identity`, tuple,
or value-bag abstraction that erases their different owners.

- **Row key:** the ordered model fields used to address one record for a
  selected update, delete, guard, or result read. In this plan it is the
  complete primary key in schema order.
- **Reference key:** the ordered target fields to which a relation points. A
  reference key may be the primary key, but it may instead be a compound unique
  key or another legal referenced key.
- **Stored reference:** the ordered correspondence between storage members and
  reference-key fields. The storage may be ordinary model FK fields, private
  polymorphic columns, or one side of a junction table.
- **Membership key:** the complete physical association. An ordinary FK has one
  stored reference; polymorphic membership has a fixed discriminator plus one
  stored reference; junction membership has a source stored reference and a
  target stored reference.

These are deliberately not interchangeable. For example, a target may have row
key `[id]` while a child stores `(tenantId, targetCode)` referencing the target's
reference key `(tenantId, code)`. The target projection captures `id` to address
the selected target and also captures `tenantId` and `code` when relation
compilation needs them. The relation topology—not TargetProjection—owns the
mapping from child storage fields to those referenced fields.

Keep topology separate from execution provenance:

- Bound relation metadata owns ordered storage/reference correspondence.
- TargetProjection owns which target values a selected-record probe publishes.
- `ForeignKeyMember`, `CorrelatedForeignKeyMember`, and the existing planning
  and final source types own literal, captured, transitioned, and produced
  values for one compilation.
- Constant qualifiers such as a polymorphic discriminator remain topology data;
  they are not fabricated as referenced row-key members.

Do not add a generic `ReferenceShape` or `Identity` interface merely to rename
the existing arrays. A shared runtime type is earned only when it replaces the
same ordered correspondence in at least two live owners without introducing
storage-kind switches downstream. The semantic model above is fixed even when
the current ordinary-FK types remain the most truthful concrete representation.

### 4.2 Selected target row key

Extend the existing TargetProjection rather than adding CapturedIdentity, OperationValueTuple, or nth-row output concepts:

~~~ts
interface TargetProjection {
  readonly identityFields: readonly string[];
  readonly fields: readonly string[];
  readonly columns: readonly PolymorphicStorageColumn[];
}
~~~

Rules:

- identityFields is the target model's complete row key: its primary key in
  schema order.
- fields contains identityFields first, followed by other scalar fields required by compilation.
- fields contains no duplicate.
- columns contains private polymorphic storage columns required by exact-membership decisions.
- A caller never passes one external primary-key field beside a TargetProjection.
- The target-projection owner constructs a captured unique selector from all identity fields.
- Reference-key fields that are not row-key fields belong in `fields`, not in
  `identityFields`.
- TargetProjection never stores foreign-field, private-column, or junction-field
  mappings. It publishes values; bound relation topology explains their use.

Add or consolidate these owner functions in target-projection.ts:

~~~ts
buildTargetProjection(
  model: Model<any>,
  requiredFields: readonly string[],
  columns: readonly PolymorphicStorageColumn[]
): TargetProjection;

capturedTargetWhere(
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>
): Record<string, unknown>;

capturedTargetConstraint(
  model: Model<any>,
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>
): TargetConstraint;
~~~

Use the existing getPrimaryKeyValuesFromRecord and buildPrimaryKeyWhereUnique implementations. Do not duplicate compound-key extraction or arity checks.

### 4.3 Demand-driven record-field publication

Generalize CreateOperation's existing demand-driven generated-identity capture into demand-driven publication of a fresh record field.

FreshRecordPart keeps its current semantic API:

~~~ts
interface FreshRecordPart extends Part {
  readonly rootWriteId: string;
  rootReferenced(field: string): FinalReferenceSource | undefined;
}
~~~

The behavior becomes:

1. If the field was supplied by the user, return its existing literal or final source.
2. If the field is database-produced and the adapter can RETURNING it, add it to the root write output and return the existing finalRef source.
3. If the field is database-produced, RETURNING is unavailable, and the completed row has a stable full identity, emit INSERT then SELECT inside the same transaction and publish the selected field through the existing planning/final source vocabulary.
4. If an adapter's existing batchRefs can safely carry the field, use that existing substrate.
5. If the row cannot be named after insertion, return undefined and retain the focused refusal.

Do not add:

- captureIdentity or needsField flags.
- A GeneratedFieldSource union member.
- An operation-specific post-insert lookup branch.
- A second record-reference abstraction.

Demand is registered only by calls to rootReferenced(field). Existing calls that request no generated field retain their current SQL.

### 4.4 Historical transaction-first record-series design

The current fragment atom has one planning phase followed by one final compilation. It cannot truthfully represent a data-dependent number of record operations when every member may have its own planning.

Add one operation-level form:

~~~ts
interface RecordSeriesOperation {
  readonly executionKind: "recordSeries";
  readonly mode: "transaction";

  capture(): PlanningFragment;

  compileMembers(
    captured: Readonly<Record<string, unknown>>
  ): readonly ExecutableOperation[];

  compileResultReads(
    captured: Readonly<Record<string, unknown>>,
    memberResults: readonly unknown[]
  ): readonly ExecutableOperation[];

  parseSeries(input: {
    readonly captured: Readonly<Record<string, unknown>>;
    readonly memberResults: readonly unknown[];
    readonly resultReadResults: readonly unknown[];
  }): unknown;
}

type RoutedExecutableOperation =
  | ExecutableOperation
  | RecordSeriesOperation;
~~~

This interface is an execution fact, not a mutation language:

- capture fixes the root set. For createMany it is an empty planning fragment.
- compileMembers returns ordinary CreateOperation or UpdateOperation instances.
- Every member is constructed before the first member executes.
- Each member uses its existing planning, final compilation, guards, failures, and record compiler.
- compileResultReads runs only after all members complete. It creates ordinary reads for the final root identities when a returning projection is requested.
- parseSeries produces count or ordered selected records.

Executor behavior:

1. Require an interactive transaction-capable driver before any I/O.
2. Execute capture on the transaction driver.
3. Call compileMembers.
4. Validate every member's public envelope and reject every branch-independent or N-dependent illegal shape before the first write.
5. Execute members sequentially through the existing executor on the same transaction driver.
6. Do not call the routed retry boundary for individual members.
7. Call compileResultReads with member results.
8. Execute result reads sequentially on the same driver.
9. Parse the series.
10. If a member reports a raceable failure, roll back and let the outer routed operation retry the complete series.

Branch-dependent legality keeps its current timing. A found-arm check runs only
after that member's planning selects the found arm. If it fails after an earlier
member wrote, the enclosing transaction rolls every member back. Do not eagerly
analyze untaken arms merely to claim that all validation happened before the
first effect.

The operation form must be refused by:

- singleStatementPlan.
- PendingOperation.buildStatement.
- shared atomic-batch preparation.
- transaction-array merging on a driver that offers only a prebuilt batch and no interactive transaction.

No new OperationStep kind is added.

### 4.5 PostgreSQL write-dependency fold

Extend the existing mutation CTE owner with one module-local or private function:

~~~ts
compileMutationDependencyFold(
  scope: QueryScope,
  writes: readonly WriteStep[]
): WriteStep | undefined;
~~~

It lowers existing OperationValueReference values that name a predecessor's firstRowField output into a CTE-column SQL expression. It does not inspect relation payloads.

Eligibility is all-or-nothing:

- The adapter supports mutation CTEs.
- All planning and branch selection are complete.
- Every input is a WriteStep.
- Every dependency points to an earlier producer.
- The dependency graph is acyclic.
- Every consumed producer output is firstRowField and the producer returns exactly one row.
- No guard is associated with the sequence.
- No step has onUniqueConflict set to skip.
- No step uses insertId scratch.
- No step carries expects that cannot be represented on the combined result.
- No race pin attribution is lost. The first version declines every multi-write fold containing a race pin.
- No row can be updated or deleted twice.
- No same-table duplicate-sensitive arms compete.
- No independent arm relies on database-assigned identity ordering.
- No final projection rereads a table whose sibling CTE effects are hidden by PostgreSQL's shared snapshot.
- The existing order-insensitivity rule passes for independent arms.

Reference lowering uses Sql composition, never string parsing:

~~~text
OperationValueReference("parent.create", "id")
  -> SELECT id FROM __viborm_write_0
~~~

The first retained scope is deliberately narrow:

- One fresh record tree.
- INSERT-only descendants.
- Generated identities carried only through firstRowField.
- No connect, connectOrCreate, upsert, set, delete, update, skip, guard, or relation projection.

The second retained scope may include multiple trees only when:

- Every root identity is application-known.
- Trees do not target the same row.
- Their writes are order-insensitive.

The fold is kept only if a measured witness reduces statements without changing values, errors, or retry behavior. Otherwise remove the prototype with apply_patch and keep the transaction series.

### 4.6 File ownership

Use these exact owners:

| Responsibility | File |
|---|---|
| Complete captured row-key and projection helpers | src/query-engine/write-engine/target-projection.ts |
| Ordered ordinary/polymorphic reference bindings and execution provenance | src/query-engine/write-engine/relation-membership.ts |
| Row-key extraction and complete unique selectors | src/query-engine/operations/mutation-identity.ts |
| Fresh field demand and publication | src/query-engine/write-engine/CreateOperation.ts |
| Selected record mutation | src/query-engine/write-engine/RecordUpdateCompiler.ts |
| Relation target/membership orchestration | Existing RelationWritePart, RelationUpsertPart, RelationJunctionPart, and nested-target-parts modules |
| Record-series contract | src/query-engine/write-engine/record-series.ts (landed name; this row drafted it as `RecordSeriesOperation.ts`. `RecordSeriesOperation` is the *type* this module exports — the module is a contract, not an operation shell, so it takes the ordinary kebab-case filename rather than an architecture-name exemption) |
| Series execution and retry routing | src/query-engine/write-engine/OperationExecutor.ts |
| Pending direct/batch refusal | The live PendingOperation owner (src/query-engine/pending-operation.ts; the PendingOperationV2 contract fixture this row also named was test-only and was deleted by distinct-truth unit 9.3 — its contract tests moved onto the live class) |
| Root relation-bearing createMany shell | New src/query-engine/write-engine/CreateManyRecordSeries.ts |
| Root relation-bearing updateMany shell | New src/query-engine/write-engine/UpdateManyRecordSeries.ts |
| Existing scalar createMany fast path | src/query-engine/write-engine/CreateManyOperation.ts |
| Existing scalar updateMany fast path | src/query-engine/write-engine/BulkCountOperation.ts and ManyAndReturnOperation.ts |
| PostgreSQL-neutral dependency fold | src/query-engine/operations/mutation-projection-fold.ts |
| To-one input lattice | src/validation/relations/to-one-mutation-schema.ts |
| Relation-bearing bulk public schemas | Existing create/update operation-schema owners in src/validation/model and src/validation/relations |

The two concrete series shells are operation owners, not new record compilers.
They parse the bulk envelope, construct ordinary record operations, and shape
the public bulk result. They contain no relation-kind switches.

## 5. Bulk semantic contracts

### 5.1 Relation-bearing createMany

Portable semantics are equivalent to ordinary create calls executed left to right in one transaction:

~~~text
create row 0 and its complete record tree
create row 1 and its complete record tree
create row 2 and its complete record tree
~~~

This order is required because later inputs may observe effects produced by earlier inputs. Planning every row first and then executing every write is incorrect for duplicate connectOrCreate and upsert targets: multiple missing probes can select create against the same target.

Rules:

- Scalar-only rows retain the current grouped multi-row INSERT.
- The currently supported direct polymorphic bulk connect route retains its current SQL.
- Any row with a general relation program routes the whole operation to RecordSeriesOperation.
- Each row is parsed exactly once.
- Each member is a normal CreateOperation using the shared StepScope rules appropriate for independent root calls.
- Input row order is execution order and result order.
- count is the number of successfully inserted root rows.
- A returning selection is read after every member finishes, so later relation effects cannot make an earlier returned projection stale.
- A failure in any row rolls back every row.
- Same-operation connectOrCreate retains first-create-wins because row N observes committed-in-transaction effects from row N-1.

This plan originally left `skipDuplicates` with general nested effects refused until the public product meaning chose one of these incompatible contracts:

1. A skipped root suppresses every nested effect.
2. A skipped root adopts the existing row and applies its nested effects.

The later relation-bearing bulk plan chose contract 1: a skipped root suppresses
its complete nested subtree. Interactive drivers implement it with one member
savepoint. A batch route isolates a root-first skippable INSERT, suppresses
descendants when it inserts zero rows, and refuses before effects when a write or
nested record series would have to precede that root.

### 5.2 Relation-bearing updateMany

Portable semantics are:

1. Evaluate where and provider-specific limit once.
2. Lock and capture the complete root primary keys.
3. Apply the existing provider limit semantics before any in-memory deterministic sort.
4. Sort the captured complete key tuples in a deterministic engine order.
5. Build one ordinary selected-record update per captured root.
6. Execute complete record updates sequentially in one transaction.
7. Shape selected results after every record effect.

Do not emit one set-based scalar UPDATE followed by all relation Parts. That changes semantics for:

- Parent-held relation folds that belong in each root UPDATE.
- Root primary-key and referenced-field transitions.
- Before-root and after-root descendant ordering.
- Per-record OwnWrite analysis.
- Failure attribution tied to one captured root.

Rules:

- Scalar-only updateMany retains today's one statement.
- count is the number of captured roots, not the provider's affected-row total. MySQL can report zero affected rows for a no-op assignment.
- Empty capture emits no effects.
- Every record update addresses the captured complete primary key.
- A parent key transition reads the old captured value and writes descendants with the transitioned value.
- Returning reads use each member's final root identity.
- One member may observe the completed effects of an earlier member.
- Every member is constructed and all N-dependent capability checks run before the first write.

For more than one captured root, **create** a pre-write refusal for child-held connect, connectOrCreate, and set. (The draft said "retain": there was nothing to retain. Scalar-only `updateMany` could not express those shapes at all, so Package K minted this refusal. The later relation-bearing bulk pass moved the refusal to `relation-key-legality.assertSingleTargetMembershipMoveAppliesToRecords`, where root and nested series share one owner.) One child stores one parent membership; sequential last-parent-wins behavior does not satisfy “apply this update to every selected root.” M2M and parent-held equivalents remain meaningful and may execute.

Three boundaries of that refusal, each measured rather than inferred:

- The EMPTY spellings (`set: []`, `connect: []`, `connectOrCreate: []`) are NOT
  refused. They name no existing target, so there is no contention: `set: []`
  at N=1 clears that row's children, and at N rows it clears each row's own.
- It covers the ROOT's own relation keys only. The same arithmetic one level
  down — `{ posts: { create: { comments: { connect } } } }` — runs unrefused,
  leaving the shared target under the last root's fresh child. Refusing it would
  make the bulk spelling reject what N ordinary `update` calls execute, which is
  the kind-gated incoherence Package D removed. Pinned as behavior. Adding depth
  here needs a plan amendment, and it is Package L's neighborhood.
- Rule 4's "deterministic engine order" holds PER DEPLOYMENT, not across
  providers. Measured on a `bigInt` row key: node-postgres decodes it as the
  string `"9"`, PGlite as the number `9`, better-sqlite3 as `9n` — different
  comparator ranks, so `["10","9"]` against `[9,10]`. Visible in the `select`
  arm's row order. Teaching the comparator a column's declared type would make
  it a second reader of provider decoding, so it was left stated rather than
  fixed.

### 5.3 Historical Package L checkpoint — nested bulk relation operations

Root relation-bearing createMany and updateMany are mandatory goals. A relation-level createMany or updateMany whose row/data contains further relations is a second integration problem because it would place a record series inside an existing record tree.

Prototype nested reuse only after both root series consumers are green.

Keep the nested prototype only if:

- It reuses RecordSeriesOperation recursively on the same transaction driver.
- It does not add a series Part, transaction AST, callback protocol, or second planning model.
- The enclosing operation still constructs all nested members before its first effect.
- Step order, failures, retry ownership, and atomicity match repeated ordinary nested operations.
- No existing scalar nested createMany/updateMany path changes.

If any condition fails, remove the prototype and retain a focused nested-only refusal. Report it as the remaining architectural boundary rather than pretending root support implies nested support.

**OUTCOME (Package L, 2026-08-10): BOTH prototypes REJECTED, no commit.** The
nested walls stand, unchanged and truthful, and the four census sites that
express them are byte-identical to their pre-L text.

This outcome belongs to the transaction-first checkpoint. The later
relation-bearing bulk pass added the guarded nested `RecordSeriesStep` route;
sections 7.3 and 7.5 state its current restrictions.

The boundary, stated once and verbatim:

> The fragment atom's single planning phase is the wall; a record series is
> operation-level, so a nested capture has no home.

Per prototype:

- **L1 (nested `createMany`)** — the head clause is unsatisfiable, not merely
  unmet. A nested `createMany` row list has a CONSTRUCTION-TIME count: no
  capture, no data-dependent member count, no per-member planning, so the series
  buys nothing. Confirmed three ways at HEAD: Parts emit `OperationStep` only
  and the executor is reachable from five operation-level sites and never from a
  Part (both escapes are banned by name); §6 L1's `FinalReferenceSource`
  precondition holds only for literal and planning-field parents, never for a
  produced identity; and widening validation ALONE is silent data loss, because
  the nested insert path iterates `scalarFieldNames` with no unknown-key guard —
  the nested twin of Package J's `relationBearingRow` hazard.
- **L2 (nested `updateMany`)** — three keep-gate clauses fail provably. N
  per-child target reads need a planning phase whose rows are a precondition,
  while N is unknown at construction and planning is already spent (a second
  planning round inside `compile`, and per-member callbacks, are both banned by
  name). A Part carries no transaction or executor handle, while a series is
  `mode: "transaction"` and needs an interactive scope. And a nested series on an
  open scope emits SAVEPOINT/RELEASE pairs with crypto-random names, which
  diverges from repeated ordinary nested updates in any statement oracle;
  waiving the scope reintroduces the HIGH defect Package I's gate fixed.

**The future path is a DESUGAR, not a series.** It already exists on the
junction leg — `RelationJunctionPart` compiles a nested `createMany` case as a
per-row `freshTargetFold`, identical to its `create` case, and
`nested-target-parts.ts` does the same with `createFresh` +
`bindRelationMembership` — and it is extendable to the other three legs. That is
a NEW capability outside this plan's Package L, which tested series REUSE and
answered the question it was asked. Recorded here so the rejection is not read
as "nested relation-bearing bulk is impossible".

## 6. Ordered work packages

Each numbered unit is atomic. Run the named focused contracts plus test:types after each unit. Run the complete query-engine layer and package build after each package. Do not overlap test processes; use only the repository's memory-capped launchers.

### Package A — Refresh the ledger and pin the baseline

#### A1. Preflight

Before production edits:

1. Run git status --short.
2. Record git rev-parse HEAD.
3. Preserve all unrelated dirty and untracked files.
4. Stop if a dirty file overlaps a planned production edit.
5. Record the current refusal inventory from operation-construction-inventory.test.ts.
6. Record production physical LOC and token-bearing LOC for src/query-engine.
7. Record write-engine runtime import cycles.
8. Run three warm test:types executions sequentially and record the median.
9. Run:

~~~bash
pnpm test:types
pnpm test:layer:query-engine
pnpm package:build
pnpm test
~~~

Stop if the baseline is red.

#### A2. Correct the limitation inventory

Two items were already delivered and are removed from the working ledger. Each
was re-verified against the tree at the plan commit before removal:

| Item | Owner today | Removed from |
|---|---|---|
| L5 optional descendant planning publication | `conditionalArmPlanning` (write-engine/Part.ts:63) marks every descendant `firstRowField` output optional and drops `expects`; the flag is declared on `StatementOutputSource` (write-engine/OperationFragment.ts:37) and write-engine/OperationExecutor.ts:905 resolves an absent value to `undefined` instead of raising | forbidden-shapes-reference.md's future-work table. The refusal it replaced — a deeper write "whose planning read asserts that its own target exists" — has no occurrence left anywhere in `src` |
| S4 empty to-one payload no-op | `buildRelationMutationProgram` returns `undefined` when no kind is active (builders/relation-mutation-parser.ts:309, with `false` stripped at :227) and `buildParsedRelationPrograms` records no program for it (:354), so `{ profile: {} }` and `{ posts: {} }` reach no record compiler in either direction | forbidden-shapes-reference.md §1.1's parity note |

Two residues stay on the books, both as Package O material rather than as lifts:

- RecordUpdateCompiler.ts:1177 states the update direction's own empty-payload
  no-op a second time, downstream of the parser that already guarantees it.
- CreateOperation.ts:1377 counts parent-held arms with `!== 1` and its message
  still ends `|| "none"`. No route can build a zero-entry program, so the
  zero-kind half of that refusal is unreachable spelling. Its child-held twin
  already counts `> 1` (CreateOperation.ts:1685).

Obsolete vocabulary is replaced below. Each new name was confirmed to name live
code before the replacement was applied, and the old names now appear nowhere
else in either ledger document:

| Plan's name | Current owner | Evidence |
|---|---|---|
| PerFieldParentIdSource | field-bound relation membership sources: `ForeignKeyMember`, `CorrelatedForeignKeyMember`, `RelationMembershipBinding`, `CorrelatedRelationMembershipBinding` | write-engine/relation-membership.ts:33, :39, :43, :55; built by `pairForeignKeyMembers` (:73) and `pairCorrelatedForeignKeyMembers` (:86) |
| ParentIdSource.transitioned | `transitionedPlanningField`, one member of `FinalReferenceSource` | write-engine/relation-membership.ts:27, constructed by `transitionedParentId` (:109) |
| buildNestedTargetChildParts | `RecordCompilerSeam.updateSelected` | declared write-engine/RecordUpdateCompiler.ts:183; called from RelationWritePart.ts:198, RelationUpsertPart.ts:1113, RelationJunctionPart.ts:1972, CreateOperation.ts:397 |
| deferArmLegality | two found-arm legality closures, not one | update arm: `updateLegality` (RecordUpdateCompiler.ts:325, RelationUpsertPart.ts:163, UpsertOperation.ts:196). Create arm: `armLegalityChecks` behind `assertArmLegality()` (CreateOperation.ts:387 and :574, called from UpsertOperation.ts:655). §G2 and §K4 mean the update-arm closure |
| createManyAndReturn | `createMany` carrying `select` | the client surface is 16 families and no longer contains it (operation-construction-inventory.test.ts:2190). The string survives in `src` as the removed-name diagnostic and as the internal operation kind of ManyAndReturnOperation (query-engine/types.ts:121, write-engine/routing.ts:188, errors/validation.ts:56). That is the removal's error surface, not stale vocabulary, and must not be deleted |

One further stale name, outside those five: §C3's focused family is
`parent-held-compound-edge` (`.test.ts`, `-behavior.ts`, `-docker.test.ts`).
No `e64-` prefix exists in the tree.

The reclassifications below are already carried by the packages named. A2 only
records that the ledger agrees with them:

- L3, L4, and L9 are one stale-guard falsification package — Package B. The
  three guards are real and adjacent: `assertArmEdgeIsChildHeld`
  (RelationUpsertPart.ts:1202), `assertArmPkStable` (:1241), and
  `assertArmEdgeReferencesLocatedPk` (:1283), reached from one call site
  (:1071 through :1083).
- L6 and L7 are one old-read/new-write transition package — Package D.
- K6 belongs to the to-one composition lattice — Package H. This K6 is the
  limitation; Package K's unit K6 (Results) is a different thing with the same
  label.
- Compound many-to-many is a future capability, not a validation seal — §7.4
  and Package N2 own it. Its live refusal is
  `builders/relation-data-builder.ts:356` (`getRequiredSinglePrimaryKeyField`,
  since distinct-truth Phase 3), with
  a second owner in `src/migrations/serializer.ts:661`; the
  `CreateOperation.ts:1998` coordinate this line used to carry was wrong on both
  counts and is corrected at §7.4.

Add parity witnesses before each later production lift. A parity witness compares:

- Planning IDs and order.
- Planning SQL and parameters.
- Planning outputs.
- Final IDs and order.
- Final SQL and parameters.
- Guards and expects.
- Race pins.
- Exact errors.
- Statement and round-trip counts.

Suggested commit:

~~~text
test: refresh query engine limitation witnesses
~~~

### Package B — Trust the selected-record compiler

This package covers old L3, L4, and L9. RelationUpsertPart already sends the selected found arm through RecordUpdateCompiler, which owns primary-key transitions, parent-held folds, and descendant record compilation.

#### B1. Falsify assertArmPkStable

Add a found-arm upsert witness where:

- The selected row changes its primary key.
- A descendant relation mutation consumes the post-transition key.
- A wrong-row decoy owns the old or new key in the relevant race position.
- Transaction and atomic-batch substrates are covered.

Run the witness against the current code and record the current refusal.

Remove only assertArmPkStable. If the test passes with identical ordering and protection, delete the guard and its refusal. If it exposes a concrete missing transition source, stop this unit and move the failing case to Package D.

#### B2. Falsify assertArmEdgeReferencesLocatedPk

Add compound and non-primary referenced-edge found-arm witnesses. Ensure TargetProjection contains every consumed referenced field.

Remove only assertArmEdgeReferencesLocatedPk. Keep the deletion only if RecordUpdateCompiler produces the exact captured selectors and field-bound values without another read.

#### B3. Falsify assertArmEdgeIsChildHeld

Add a found-arm update with a parent-held to-one nested mutation. Pin that its produced or located target identity folds into the arm's existing root UPDATE.

Remove only assertArmEdgeIsChildHeld. Do not add a delegated second UPDATE.

Focused families:

- update-depth-upsert
- update-nested-upsert
- upsert-arm-referenced-edge
- upsert-untaken-arm-legality
- compiled-key-transition
- post-transition-adopt

Keep gate:

- Production guards and branches decrease.
- No new source kind or Part.
- Untaken arms remain inert.
- The found arm still uses one RecordUpdateCompiler.

Suggested commit:

~~~text
refactor: trust selected upsert record compilation
~~~

### Package C — Make selected row keys compound by construction

This package covers L1.

#### C1. Extend TargetProjection

Add identityFields and central captured-selector construction. Preserve existing field and private-column output order.

`identityFields` is a row-addressing key, not a declaration of every field that
can participate in a relation. Add non-primary reference-key fields to the
ordinary `fields` demand when a relation owner needs them. Do not make
TargetProjection aware of FK storage members or junction columns.

Add focused unit tests for:

- One scalar primary key.
- Two-member primary key.
- Required non-PK referenced fields.
- Private polymorphic columns.
- Duplicate requested fields.
- Missing captured identity member.

Use the existing internal error class and message style for an impossible missing captured member. Do not add a second arity validator.

#### C2. Remove scalar childPrimaryKey channels

Migrate in this order:

1. nested-target-parts.
2. RelationWritePart.
3. RelationUpsertPart.
4. RecordUpdateCompiler child-held paths.
5. RelationJunctionPart selected-target paths.
6. Polymorphic inverse selected-target paths.

Each consumer receives TargetProjection or the projection-derived complete selector. No configuration may carry TargetProjection and childPrimaryKey together.

#### C3. Preserve exact targeting

Every targeted update, delete, guard, set membership read, and upsert found arm must address all primary-key members captured from the probe. Never reconstruct identity from the original public selector.

Focused families:

- compound-key
- compound-locate-prototype
- compound-relation-adoption
- produced-compound-identity
- e64-parent-held-compound-edge
- polymorphic compound target contracts

Static gate:

~~~bash
rg -n "childPrimaryKey" src/query-engine/write-engine
~~~

The command must return no selected-target scalar identity channel. A name retained for genuinely scalar bulk SQL must be documented at its owner.

#### C4. Prove row-key/reference-key separation

Add one selected-target witness whose complete row key differs from the
relation's complete reference key, for example:

~~~text
target row key:        [id]
target reference key:  [tenantId, code]
child stored reference:[tenantId, targetCode]
~~~

The target probe must publish all three required values in deterministic order:

1. `id` as the row-key member used by captured update/delete targeting.
2. `tenantId` and `code` as additional reference-key fields consumed by the
   relation membership binding.

Assertions:

- The selected record is addressed only through the projection-derived complete
  row-key selector.
- Relation assignment pairs child storage fields with reference-key fields in
  schema order.
- No caller reconstructs either key from the original public selector.
- No configuration carries a scalar child PK beside TargetProjection.
- No `OperationValueTuple`, `CapturedIdentity`, or universal identity carrier is
  introduced.
- Existing ordinary compound-FK and polymorphic membership SQL remains
  byte-identical.

Suggested commit:

~~~text
refactor: capture complete selected record keys
~~~

### Package D — Unify old-read and new-write transition provenance

This package covers L6 and L7.

#### D1. Centralize membership transition input

Make transition legality and occupied-slot construction consume CorrelatedRelationMembershipBinding:

- readSource names the pre-transition referenced value.
- writeSource names the post-transition value.
- Every referenced field is handled in schema order.
- transitionedPlanningField applies the existing scalar transformation exactly once.

Delete branches that infer the old value from the new value or inspect only the first primary-key field.

#### D2. Lift non-cascading deeper edges

For a selected root that changes an unpinned referenced column:

- Capture the old referenced field during the existing target read.
- Use the old source for membership/removal probes.
- Use the transitioned source for create/adopt writes.
- Keep untouched existing memberships unchanged.
- Preserve database cascade behavior where a real FK with cascade already owns the effect.

#### D3. Generalize occupied guards

Build occupied-slot predicates from the complete correlated binding, not a pinned selector special case. Preserve conjunct and parameter order.

Focused families:

- compiled-key-transition
- nested-update-pk-transition-cascade
- pk-transition-junction-mixed-edge
- post-transition-adopt
- located-parent-ref
- polymorphic referenced-identity transition

Keep gate:

- No new reference source.
- No extra planning read when the existing target projection already captured the field.
- All membership reads use old values and all adoption writes use new values.

Suggested commit:

~~~text
refactor: unify relation transition provenance
~~~

### Package E — Lift shared-primary-key update roots

This package covers the shared-primary-key update root and nothing else. The
draft said "covers L2"; that is FALSE and was corrected by Package E's own
measurement (2026-08-10): `L2` labels Package L's nested-`updateMany` unit
below, which Package E does not touch.

#### E1. Extend the parent-held root fold

At an update root the record already exists and its identity is captured. Let the existing parent-held fold consume that captured or transitioned identity for shared-primary-key create, connectOrCreate, and upsert arms.

Rules:

- Fold the final value into the root UPDATE.
- Do not create a shared-PK Part.
- Preserve destination uniqueness checks.
- Preserve root primary-key transition ordering.
- Return the final identity in terminal results.
- Reject only if the exact final identity cannot be captured or derived.

Focused families:

- shared-pk-connect-or-create
- update nested upsert
- produced identity provenance
- primary-key transition contracts

Suggested commit:

~~~text
refactor: fold shared primary keys into selected updates
~~~

### Package F — Publish demanded fresh-record fields

This package re-audits K1, K2, and K4 under the accepted-round-trip policy.

#### F1. Generalize demand registration

Make rootReferenced(field) register demand for any referenced scalar field, not only the generated primary key.

The root create compiler determines the minimal output set after all descendants and junction consumers have registered their requests.

#### F2. RETURNING providers

On PostgreSQL and every adapter that already supports the required RETURNING shape:

- Add demanded database-produced fields to the root RETURNING projection.
- Preserve destination scalar casts.
- Publish each field through the existing finalRef.
- Keep generated identity output ordering stable.

#### F3. Non-returning transaction providers

When a demanded field is unknown until INSERT:

1. Require a stable complete root selector.
2. Emit the current INSERT.
3. Read only the demanded fields by that selector in the same transaction.
4. Publish those fields through existing planning/final references.
5. Refuse before the INSERT if no selector can name the row.

Do not use LAST_INSERT_ID as a substitute for a non-identity field. The existing insertId substrate may identify the row and then support the focused SELECT.

#### F4. Narrow the refusals

For every K1, K2, and K4 site, classify the value:

| Value state | Result |
|---|---|
| Explicit input value | Existing literal source |
| Earlier operation value | Existing finalRef |
| Database-produced and RETURNING-capable | Publish through root output |
| Database-produced, stable post-insert selector | INSERT then SELECT |
| Null or absent referenced value | Keep refusal |
| Row has no stable unique selector | Keep refusal |
| Batch-only substrate cannot carry/refetch value | Keep substrate-specific refusal |

Focused families:

- produced-identity-provenance
- produced-identity-race-pin
- shared-pk-connect-or-create
- junction produced identity
- compound adoption
- non-primary referenced edge

Keep gate:

- Existing create paths that request no additional field remain byte-identical.
- At most one post-insert read publishes all demanded fields for a root.
- No new source kind.

Suggested commit:

~~~text
refactor: publish demanded fresh record fields
~~~

### Package G — Finish inverse to-one upsert updates

This package covers L8.

#### G1. Parse the complete update program

Replace inverseUpsert's scalar-only parser with the existing complete parsed-record boundary. Parse once and retain scalarData, relations, and polymorphic programs.

#### G2. Delegate the found arm

Pass the captured target and complete parsed program to RecordCompilerSeam.updateSelected.

Rules:

- The relation owner keeps the correlated probe and found/missing decision.
- Found-arm OwnWrite legality runs only after the found arm is selected.
- Missing create does not bind or validate the update subtree.
- Empty found update emits zero steps.
- Relation-bearing selected updates recurse normally.
- The root update addresses the captured complete primary key.

Focused families:

- inverse-to-one update depth
- to-one update family
- nested-update-owned-fk
- staleness injection
- record-compiler parity

Suggested commit:

~~~text
refactor: compile inverse upsert updates as selected records
~~~

### Package H — Normalize to-one composition

This package covers former K6 (§A2 records that reclassification: the K6 that is
a *limitation* is the to-one lattice, and Package K's own unit K6 is a different
thing wearing the same label). The draft also said "L10". No `L10` entry exists
in this plan, in the forbidden-shapes reference, or in the ledger — searched by
Package H and again by Package N — so the citation is DROPPED rather than
invented a meaning for.

#### H1. Define the public lattice

Literal false is inactive.

Keep existing single intents and child-held vacate-then-supply pairs. Add these meaningful compositions:

- connect plus update.
- connectOrCreate plus update.
- create plus update.
- child-held disconnect plus supplier plus update.
- child-held delete plus supplier plus update.
- Parent-held vacate plus supplier when the final-slot fold proves one coherent root assignment.

Continue refusing:

- supplier plus supplier.
- upsert beside another target intent.
- vacate plus update with no supplier.
- two vacates.
- every ambiguous three-intent combination.

create plus update is meaningful because update data may contain relative scalar operations or relation effects. It must not be normalized by merely merging input objects.

#### H2. Extend one schema owner

Extend to-one-mutation-schema.ts at both type and runtime levels:

- Use one shallow mapped union.
- Keep false-only and empty payloads.
- Validate the existing object once before counting active intents.
- Preserve precise nested validation paths.
- Add no global V.Object conditional and no repeated recursive union validation.
- Never ship runtime-only support.

Measure three warm test:types runs before and after. If median increases by more than five percent, simplify the local type before proceeding.

#### H3. Compile one composed target

The relation owner, not RELATION_MUTATION_KEYS ordering, composes the operation:

1. Vacate the prior member when requested.
2. Create, connect, or connectOrCreate the supplier.
3. Capture or publish the supplied target's complete identity.
4. Pass that identity to RecordUpdateCompiler for modify.

Do not represent supply and modify as independent entries whose current fixed order happens to be changed. Add a normalized composition entry to RelationMutationProgram only if the relation owner otherwise cannot preserve the supplied identity. If added, it must be one exact semantic entry and must replace the independent entries.

Parent-held vacate plus supply is a final-slot fold:

- Compute the final FK value.
- Write that value once in the root INSERT or UPDATE.
- Do not emit a transient null assignment.

Focused families:

- vacate-then-supply
- boolean-noop-arm
- to-one create family
- to-one update family
- connectOrCreate found/missing races
- relation-bearing selected update recursion

Suggested commit:

~~~text
feat: compose to-one supply and selected update
~~~

### Historical Package I checkpoint — Add the transaction record-series atom

The bullets in this package record the first transaction-only implementation.
They are preserved as delivery history; the RecordSeries history note at the top
states the current native-batch route.

#### I1. Add contracts without consumers

Add RecordSeriesOperation and RoutedExecutableOperation beside the current executable operation boundary. Do not change OperationFragment, StatementStep, Part, adapters, or drivers.

#### I2. Extend routing

Teach PendingOperation and OperationExecutor to route the new form:

- Direct statement compilation returns undefined.
- Prepared batch compilation returns undefined.
- Interactive transaction execution uses the current driver override.
- Outer retry wraps the complete series.
- Member execution bypasses routed retry but retains each member's guard/race metadata.

#### I3. Add a fake-operation contract

Before bulk consumers, prove:

- Capture runs once per outer attempt.
- All members are constructed before member zero writes.
- Members plan and compile sequentially.
- Member one observes member zero's committed-in-transaction effect.
- Member failure rolls back member zero.
- Raceable member failure retries capture and every member once at the outer boundary.
- Result reads run after all members.
- Batch-only substrate refuses before provider access.
- No operation step kind was added.

Keep gate:

- One new durable execution concept only.
- No strategy, generic transaction program, callback array, or lifecycle event system.
- Existing ExecutableOperation paths do not branch differently.

Suggested commit:

~~~text
refactor: add transactional record series execution
~~~

### Package J — Lift root relation-bearing createMany

#### J1. Public and runtime schema

Allow each root createMany data element to use the ordinary create data shape, subject to existing root-createMany exclusions.

Keep:

- Existing scalar fields.
- Existing direct polymorphic connect.
- Full nested relation create surface.

Reject:

- Unknown keys beside a real key.
- The same edge supplied through a relation and its owned scalar FK when the ordinary create schema rejects it.
- skipDuplicates when any row contains a general nested effect.

Add public client probes for fresh literals and non-fresh variables.

#### J2. Fast-path router

At construction:

- If every row is current bulk-compatible, construct the existing CreateManyOperation or returning owner unchanged.
- If any row has a general relation program, construct CreateManyRecordSeries.

Do not add a relationMode flag to CreateManyOperation.

#### J3. Series members

For every input row in order:

1. Parse it exactly once.
2. Build ParsedRecordPrograms.
3. Construct a CreateOperation through an internal parsed-input route owned by CreateOperation.
4. Request the complete final root identity as the member result.
5. Execute the complete record subtree before advancing.

The parsed-input route is a discriminated constructor input, not another create compiler. Public CreateOperation validation remains unchanged.

#### J4. Results

- count returns the successful root count.
- Selected createMany results are read after all member effects.
- Read final roots in input order through ordinary reads by complete final identity.
- Preserve public selection, omission, scalar casts, and result shape.

Focused families:

- create-many
- create-many-return-fold
- create-many-skip-depth
- junction-create-many
- polymorphic createMany
- nested-create-context-grandchild
- duplicate connectOrCreate input
- rollback and race retry

Keep gate:

- Scalar and direct-polymorphic-connect plans are byte-identical.
- General rows execute left to right.
- No row's planning decision is made before earlier rows finish.
- No partial effects.

Suggested commit:

~~~text
feat: support relations in root create many
~~~

### Package K — Lift root relation-bearing updateMany

#### K1. Public and runtime schema

Allow full ordinary update data for root updateMany. Keep existing relation-key legality in the series constructor.

Public types and runtime validation must agree. Add fresh and non-fresh client probes with typos beside real keys.

#### K2. Fast-path router

- Scalar-only data constructs the current BulkCountOperation or returning owner unchanged.
- Relation-bearing data constructs UpdateManyRecordSeries.
- Do not add a mode flag inside BulkCountOperation.

#### K3. Capture

The capture query:

- Uses the current where semantics.
- Uses the provider's current limit semantics.
- Locks rows when the existing transaction/provider substrate supports the required lock.
- Selects every primary-key member. **Corrected as landed:** "and any root
  field needed to derive final identity" was over-specified. A primary-key-only
  projection is sufficient, because each member's own locate publishes that
  root's final key through `TargetProjection`; widening the capture would make
  it a SECOND owner of final-identity derivation (Package K, measured).
- Applies limit before deterministic in-memory sorting.
- Never evaluates the public where a second time.

#### K4. Pre-write legality

After capture and before any member write:

- Return zero for empty capture.
- For N greater than one, reject child-held connect, connectOrCreate, and set.
- Construct every selected update member.
- Run every member's parse boundary and branch-independent OwnWrite preflight.
- Ensure every member has a stable captured target identity.

Keep selected-arm legality deferred when the ordinary UpdateOperation defers it.
The series must preserve untaken-arm inertness. A later deferred failure aborts
and rolls back the complete series.

#### K5. Members

Use an internal parsed/captured input of UpdateOperation:

- Target is the captured complete primary key.
- ~~Parsed data is shared immutable ParsedRecordPrograms.~~ **AMENDED as
  landed (Package K, measured):** each member parses the shared RAW `data`
  itself. Client-side defaults are thunks the object primitive runs on every
  parse of an absent key, so one shared parse hands every root's nested `create`
  the SAME generated id — a unique violation on member 1 for a payload as
  ordinary as `updateMany({ data: { tickets: { create: { note } } } })`.
  Witnessed with `s.string().id().ulid()`: two roots, two distinct ids, one
  call. What is NOT redone per member is the ENVELOPE (`where`, `select`,
  `limit`, and `assertPortablePrimaryKeyUpdateInput`, which runs once under the
  public name `updateMany`) — one guard per invariant.
- Each member owns its full scalar root UPDATE, parent-held folds, transitions, descendants, guards, and failures.
- Member result publishes the final complete root identity.

Do not run one global scalar UPDATE first.

#### K6. Results

- count is captured root count.
- Selected results are read after all member effects using final identities.
- Preserve deterministic captured order in the output.
- If a transition causes two roots to converge on one identity, let existing uniqueness/error behavior abort the transaction.

Focused families:

- legality-gate
- relation-key-update-legality
- nested-arm-dispatch
- update family
- primary-key transition
- m2m mutation
- parent-held lookup
- count semantics with no-op scalar assignment
- limit semantics per provider
- rollback and outer retry

Keep gate:

- Scalar-only SQL and round trips are unchanged.
- Public where is evaluated once.
- Every root uses complete RecordUpdateCompiler semantics.
- N-dependent refusals happen before the first write.

Suggested commit:

~~~text
feat: support relations in root update many
~~~

### Package L — Prototype nested relation-bearing bulk

#### L1. Nested createMany

Attempt to reuse the record series under an enclosing transaction only after the parent root identity is available.

Keep only if:

- Incoming parent membership uses existing FinalReferenceSource values.
- Every row becomes an ordinary CreateOperation.
- Parent before/write/after ordering remains exact.
- No new Part carries a transaction or executor.

#### L2. Nested updateMany

Attempt to compile the captured nested target set as a nested RecordSeriesOperation on the same driver.

Keep only if:

- The enclosing root and nested series have one outer retry owner.
- The nested capture observes the intended point in parent transition order.
- Every selected child uses RecordUpdateCompiler.
- No OperationFragment contains nested planning or executor callbacks.

If either prototype fails its keep gate, remove only that prototype and retain the exact nested refusal. Root bulk support remains delivered.

Suggested successful commit:

~~~text
feat: compose nested record series
~~~

No commit is created for a rejected prototype.

**OUTCOME: both units REJECTED, no commit exists.** The reasons, the boundary
sentence and the desugar future path are recorded once, in §5.3, so the two do
not drift apart. Retention was verified rather than assumed: the four census
sites carrying the nested walls, and the ATOM section that states them, are
byte-identical to their pre-L text.

### Package M — Add PostgreSQL dependency-aware CTE folding

#### M1. Pure create DAG witness

Pin the portable multi-statement fragment for:

- Generated parent identity.
- Child insert consuming parent identity.
- Grandchild insert consuming child identity.
- Destination casts.
- Compound application-known identity members.

#### M2. Implement the lowerer

Add compileMutationDependencyFold beside the current mutation projection fold. Reuse:

- supportsCteWithMutations.
- OperationValueReference.
- StatementOutputSource.firstRowField.
- Existing adapter CTE quoting/composition.
- Existing SQL fragment lowering.

Do not add a relation import to the lowerer.

#### M3. Wire CreateOperation

After normal planning and branch selection, offer an eligible pure create tree to the lowerer. If it returns undefined, preserve the existing fragment without modification.

#### M4. Measure and keep

Required proof:

- PostgreSQL/PGlite statement count drops for the eligible generated-identity tree.
- MySQL and SQLite execute the portable series.
- SQL parameters and destination casts are correct.
- Injecting one guard, race pin, expects, skip, or branch makes the fold decline.
- A same-row double write makes the fold decline.
- A result projection that would see the shared-snapshot trap makes the fold decline.

Do not fold createMany trees with multiple database-assigned roots in the first version. Avoid relying on unspecified sequence allocation or RETURNING row order for persistent child links.

Keep gate:

- The lowerer contains no relation verb or topology branch.
- It reduces at least one measured round trip.
- It introduces no public feature dependency.
- It can be deleted without changing semantics.

Suggested commit:

~~~text
perf: fold PostgreSQL create dependencies through CTEs
~~~

### Package N — Validation cleanup and truthful remaining restrictions

#### N1. Omit owned FK fields in nested update

Build nested update data from the existing omitted-FK schema owner. Retain the engine guard until every public and internal construction route proves the field unreachable.

Delete the engine guard only when its falsifier can no longer construct the invalid program through any trusted internal boundary.

Three corrections this unit needed, all from Package N's own measurements:

- **Retention is MANDATORY, not merely cautious.** The unit's implicit premise —
  that the omission can make the field unreachable everywhere — is false as
  written. `getInverseRelationMap` tests `state.fields` for TRUTHINESS where
  `bindRelation` tests `fields && fields.length > 0`, so a relation spelled
  `.fields()` with zero arguments binds child-held in the engine while the parse
  boundary omits nothing. That schema is publicly constructible, and it is the
  guard's one live route.
- **The upsert arms must be SPLIT.** Omitting at the CREATE root's to-many
  `upsert.update` destroys an accepted payload — only a `literal` parent source
  is comparable, so that is the one position where the absorb branch can accept —
  while omitting at the UPDATE root's same arm removes only refusals.
- **The nested `updateMany` arm belongs in this list and was missing.** It was
  the one position with NO engine guard: measured on PGlite through the public
  client, `posts: { updateMany: { where, data: { userId: "thief" } } }` was
  ACCEPTED and silently reparented the row. Package N closed it at the parse and
  its gate wired the engine owner's fourth call position. Both halves are pinned
  in `nested-update-owned-fk.test.ts`.

#### N2. Do not seal compound M2M

Keep the current focused capability refusal. The limitation-lift implementation
must not absorb compound M2M, but it must leave the following design path open.

The future bound junction topology is two ordered reference sides, not two
scalar IDs and not parallel source/target arrays:

~~~ts
interface JunctionReferenceMember {
  readonly junctionField: string;
  readonly referencedField: string;
}

interface JunctionSide {
  readonly model: Model<any>;
  readonly members: readonly JunctionReferenceMember[];
}

interface JunctionRelation extends BoundRelationBase {
  readonly kind: "junction";
  readonly table: string;
  readonly source: JunctionSide;
  readonly target: JunctionSide;
}
~~~

This is a future contract, not a type to add during Package C unless it replaces
a live scalar junction representation in the same validated unit. When the
capability is implemented, the work includes:

- Schema metadata that derives one ordered side from every member of the source
  row key and one ordered side from every member of the target row key.
- Explicit junction field names for every member while retaining the current
  one-member shorthand.
- Migration serialization, differ, introspection, and DDL for all side columns,
  two compound foreign keys, and one membership uniqueness/primary constraint
  across `source.members + target.members` in that order.
- `ManyToManyJoinInfo` expressed as `source: JunctionSide` and
  `target: JunctionSide`; delete singular source/target PK and junction-field
  channels.
- Junction insert, connect, disconnect, set, update, delete, and membership SQL
  constructed by iterating complete side members.
- Portable correlated conjunctions/`EXISTS` for membership matching. Do not
  depend on provider-specific row-value `IN` syntax or tuple null semantics.
- TargetProjection publishing every selected target row-key member plus any
  additional reference-key field required by the side. JunctionSide—not the
  projection—maps those values to junction fields.
- OwnWrite many-to-many membership scopes containing both ordered sides rather
  than scalar `firstField` and `secondField` members.
- Self-relation, mapped-column, destination-cast, non-PK referenced-key, and
  wrong-member-order witnesses across all providers.

The first compound-M2M version may require both sides to reference complete
primary keys. The representation must nevertheless name them as reference-key
members so support for a legal compound unique reference does not require a
second junction architecture later.

Do not solve this by:

- Adding `sourceValues[]` and `targetValues[]` parallel to the current scalar
  fields.
- Introducing an `OperationValueTuple`, nth-row output, or generic identity bag.
- Treating the polymorphic discriminator as a referenced key member.
- Moving junction column ownership into TargetProjection.
- Adding a validation seal that makes the future topology unreachable.

Do not add a redundant validation rule merely to move the error earlier.

#### N3. Recount restrictions

Every remaining refusal must be classified as:

- Semantic contradiction.
- Missing stable identity.
- Provider/substrate impossibility.
- Deliberately deferred product contract.
- Unimplemented future feature.

Delete stale migration history and line-number claims. The refusal inventory test remains the executable census owner.

Suggested commit:

~~~text
refactor: make query engine refusals truthful
~~~

### Package O — Give every surviving guard one owner

This package is mandatory. Do not finish after merely making more payloads pass.
The engine must also stop expressing the same invariant at several downstream
sites.

#### O1. Build the guard ownership ledger

For every remaining new UnsupportedOperationError expression in
src/query-engine, record:

| Field | Required evidence |
|---|---|
| Site | File, function, and live public or internal route |
| Invariant | One sentence describing the invalid domain state |
| First knowable boundary | The earliest trusted owner that can determine it |
| Unique failure | A concrete input that this site catches and no earlier site catches |
| Falsifier | The test that fails if this guard is removed |
| Disposition | Keep, move to owner, replace with trusted representation, or delete |

Do not count comments, helper calls, or error instances. Count construction
sites that can independently reject an operation.

#### O2. Compress the known duplicate clusters

Apply these fixed dispositions:

| Repeated invariant | Current expression | Final owner |
|---|---|---|
| Complete selected row key | Several child-requires-one-PK guards | TargetProjection.identityFields; no downstream arity guard |
| Fresh referenced field publication | Repeated Create, Update, Junction, and Upsert cannot-resolve branches | CreateOperation demand publication, plus one selected-transition owner when the value comes from UPDATE |
| To-one composition legality | Repeated operation-count checks in create/update emitters | Public to-one lattice; at most one canonical-program guard if a trusted internal route can bypass public parsing |
| Relation-bearing bulk capability | Legality owner plus relation-emitter refusals | RecordSeriesOperation consumer before effects |
| Selected upsert arm safety | Three precompiler guards | RecordUpdateCompiler; delete guards whose falsifiers pass |
| Relation-owned FK disagreement | Separate create/upsert/update relation checks | Canonical relation-membership input boundary |
| Stable mutation identity | Separate readback and junction-addressability checks | Existing mutation-identity owner plus demand publication |

Do not replace repeated throws with a common unsupported function. That hides
duplication without removing any duplicated decision.

#### O3. Enforce the one-guard rule

A guard survives only if all statements are true:

1. The invalid state can first become known at this boundary.
2. No upstream validation or canonical representation already excludes it.
3. No sibling or downstream guard catches the exact same state.
4. Removing it makes its unique falsifier execute a wrong effect, lose
   atomicity, misattribute a failure, or accept an incoherent request.
5. Moving it earlier would not change untaken-arm validation timing.

If a representation makes the invalid state impossible, delete every guard
that previously defended it. Do not retain defensive duplicates.

Multiple guards for one user-facing limitation are permitted only when they
protect different trust boundaries. The ledger must name the bypass that makes
each boundary independently reachable. A hypothetical direct internal call is
not sufficient.

#### O4. Census gate

Run:

~~~bash
rg -n "new UnsupportedOperationError" src/query-engine
~~~

Expected result: 8–12 construction sites.

Rules:

- A result below 8 is acceptable when every required failure still has one
  owner and its falsifier remains green.
- A result above 12 blocks finalization until an architecture review examines
  every survivor.
- The review may approve a higher count only when every extra site has a
  distinct reachable trust boundary and unique falsifier.
- Never delete or weaken a correctness guard merely to enter the target range.
- Report both the raw site count and the number of distinct invariants. The
  distinct-invariant count is the more important measure.

Focused validation:

- operation-construction-inventory
- forbidden-shapes reference contracts
- OwnWrite dependency, ledger, and target contracts
- public validation/type probes for to-one composition
- compound row-key targeting and distinct compound reference-key membership
- mutation identity and produced identity contracts
- nested bulk substrate refusals

Suggested commit:

~~~text
refactor: give query engine guards one owner
~~~

## 7. Restrictions that remain after the plan

These restrictions have a concrete reason and must not be removed by weakening a guard.

### 7.1 Contradictory or ambiguous requests

- Two different values claimed for the same FK member.
- Two suppliers for one to-one slot.
- Upsert beside another independent target intent.
- A vacate followed by modify without a replacement target.

### 7.2 Unnameable records

- A demanded post-insert field when the provider cannot return it and no stable unique selector can refetch the row.
- A truly null referenced value.
- Two provider-assigned compound primary-key members when no complete alternate unique identifies the row portably.

### 7.3 Duplicate skipping without identity

- A skipped relation-bearing root suppresses its subtree and never needs to name
  or adopt the conflicting row. Interactive execution uses a savepoint; batch
  execution isolates a root-first skippable INSERT and observes its exact row count.
- A write or nested record series before that skippable root remains refused
  before operation effects, because suppression would strand the earlier work.

### 7.4 Topology features not implemented here

- Compound many-to-many join sides. This is an unimplemented future capability,
  not a semantic seal, and Package N2 fixes its future topology as two ordered
  `JunctionSide` reference keys and records the schema, migration, join-SQL,
  OwnWrite, and engine work it waits on. Do not restate it as a validation rule
  merely to move the error earlier.

  **Coordinate corrected (Packages N and O, both by measurement).** The draft
  named `CreateOperation.ts:1998`, which is wrong twice over: the coordinate
  moved, and that site was never the fact's owner. Driven through the public
  client with a compound-primary-key model carrying a many-to-many relation, the
  answer comes from `builders/relation-data-builder.ts:356`
  (`getRequiredSinglePrimaryKeyField`, throw at `:365` — it moved there with the
  junction binder at distinct-truth Phase 3), reached through the bound
  junction's lazy sides ←
  `RelationMembership.getRelationMembershipScope` ← `OwnWriteRelation.create` ←
  `OwnWriteAnalyzer.analyze` — the record-program boundary, before
  `CreateOperation` interprets any relation. The migration layer holds the
  second owner of the same fact at `src/migrations/serializer.ts:661`. The old
  `CreateOperation` site never reached it and Package O converted it to a
  `QueryEngineError` naming the structural invariant.

  One consequence is recorded rather than fixed: `getRequiredSinglePrimaryKeyField`
  raises a bare `QueryEngineError`, which `classifyFailure` reports as a DEFECT
  (`V9001 INTERNAL_ERROR`) rather than as a capability refusal. That is this
  section's own subject — an unimplemented capability — so it should reach
  callers as a refusal. See the ledger's named-future-work list.
- Any new polymorphic cardinality or identity form outside current relation contracts.

### 7.5 Substrate boundaries

- RecordSeriesOperation on a driver with neither an interactive transaction nor
  native atomic batching.
- A progressive RecordSeriesOperation inside explicit `$transaction([...])`;
  that API remains one indivisible atomic batch.
- Nested relation-bearing bulk without the compiler-owned complete parent or
  membership premise required by each later consuming batch.
- Child-held connect, connectOrCreate, or set across more than one updateMany
  root — at the ROOT's own relation keys, and only when the entry names an
  existing target (§5.2).

## 8. Validation matrix

### 8.1 Per atomic unit

Run the focused existing family named in the unit, then:

~~~bash
pnpm test:types
~~~

Use the repository memory-capped launcher. Run one process at a time.

### 8.2 Per package

~~~bash
pnpm test:layer:operation-schemas
pnpm test:layer:query-engine
pnpm package:build
~~~

Run only the layers touched by that package, sequentially.

### 8.3 Performance contracts

Pin these existing paths after every bulk or CTE package:

- batch-round-trip-baseline
- upsert-on-conflict-fold
- mutation-projection-cte-fold
- create-many-return-fold
- batch-mode-fold
- sql-generation

Existing fast paths must have identical SQL, parameters, statements, and round trips.

### 8.4 Final validation

Run sequentially:

~~~bash
pnpm test:layer:relations
pnpm test:layer:operation-schemas
pnpm test:layer:query-engine
pnpm test:layer:client
pnpm test:layer:adapters
pnpm test:types
pnpm package:build
pnpm test
pnpm test:all
pnpm test:coverage:write-engine
~~~

`pnpm test` does NOT include the `extended-local` project (the workspace defines
it as `tests/**/*.test.ts` minus `*.core.test.ts`), so run it by name —
`vitest run --project=extended-local` — or rely on `pnpm test:all`, which chains
it. Package N's gate found a file that had been red there since Package J while
every "all gates green" claim in that window was made from `pnpm test` alone.

Two harness facts, both measured and neither a test failure:

- Every `pnpm test:layer:*` launcher exits `FATAL ERROR: Ineffective
  mark-compacts near heap limit` AFTER printing an all-passed line. Reproduced
  on layers no package touched. Record the COUNTS, not the exit codes.
- `pnpm test:coverage:write-engine` ships `--wall-limit-ms=300000` and now runs
  at ~297s on the reference machine. A wall-kill with every visible file green
  is a harness budget, not a red suite; re-run at a higher limit for the count.

Run provider contracts when services are available:

~~~bash
pnpm test:providers
~~~

Report every unavailable provider as skipped. Do not call it passed.

Run three warm final type checks. The median may not regress by more than five percent from A1.

## 9. Static and architecture gates

Final acceptance requires:

- No new runtime step kind.
- No adapter relation API.
- No second fresh-record or selected-record compiler.
- No mutation DSL, lifecycle hooks, placement callbacks, strategy table, or operation-specific transaction executor.
- RecordSeriesOperation is the only new execution form.
- No selected-target relation Part carries one scalar childPrimaryKey when the target identity can be compound.
- No new reference-source kind.
- The CTE fold imports no relation mutation or topology concept.
- Scalar createMany and updateMany route through their original operation classes.
- Every newly relation-bearing bulk route uses ordinary record compilers.
- OwnWrite still runs at each complete record-program boundary.
- Write-engine runtime import cycle count remains zero.
- Type-level and runtime operation schemas agree.
- No existing fast path gains a statement or round trip.
- Every UnsupportedOperationError construction site has one unique reachable
  falsifier and names a distinct first-knowable invariant.
- The expected raw refusal census is 8–12. A higher result has received the
  explicit architecture review required by Package O.
- No shared error helper hides multiple independent guard decisions.

The final implementation report must include:

- Starting and ending commits.
- Physical and token-bearing production LOC delta.
- Tests and documentation LOC separately.
- Deleted guards and refusal sites.
- Initial and final raw UnsupportedOperationError counts.
- Final distinct-invariant count and ownership ledger.
- New durable concepts.
- Remaining refusal list with classification.
- Existing fast-path parity results.
- New relation-bearing bulk statement/round-trip costs by provider.
- PostgreSQL CTE fold eligibility and measured savings.
- Type-check medians.
- Exact test results.
- Provider skips.
- Residual correctness and performance risks.

## 10. Recommended commit order

Use one validated Conventional Commit per coherent unit:

~~~text
test: refresh query engine limitation witnesses
refactor: trust selected upsert record compilation
refactor: capture complete selected record keys
refactor: unify relation transition provenance
refactor: fold shared primary keys into selected updates
refactor: publish demanded fresh record fields
refactor: compile inverse upsert updates as selected records
feat: compose to-one supply and selected update
refactor: add transactional record series execution
feat: support relations in root create many
feat: support relations in root update many
feat: compose nested record series
perf: fold PostgreSQL create dependencies through CTEs
refactor: make query engine refusals truthful
refactor: give query engine guards one owner
docs: document lifted query engine limits
~~~

Skip the nested-series commit when Package L is rejected. Skip the CTE commit when its objective keep gate fails. Never keep a partial prototype.

As executed, `feat: compose nested record series` was skipped (Package L
rejected, §5.3) and every other line landed in the order above.

## 11. Final doctrine

The engine should gain capability by making its existing atoms more truthful:

- A selected record's row key contains all of its primary-key members.
- A relation's reference key names the ordered target fields it points to and
  may differ from that target's row key.
- A stored reference maps storage members to reference-key members; a membership
  key composes stored references and fixed qualifiers without erasing their
  topology.
- TargetProjection publishes selected target values; it does not own FK,
  polymorphic-column, or junction-column mappings.
- A fresh record can publish a demanded field once that field becomes knowable.
- A record compiler owns one complete record mutation.
- A relation owner owns membership and branch decisions.
- A record series owns ordered sequencing of ordinary record operations, inside
  one interactive transaction or across safe native-batch segments.
- A PostgreSQL CTE fold owns only lowering a proven write-value dependency graph.

That division keeps the portable semantics simple and lets PostgreSQL compress eligible work without turning provider-specific SQL into a second query engine.

## 12. §3.1 deviations, ratified

§3.1 says every payload accepted before this work keeps its result, its
validation timing, its statement count and its error class. Six packages
deviated from that, each measured first, each ratified by the coordinator, and
each reversible by a deliberate decision rather than by a patch. They are listed
here rather than left in package reports so a reader of the contract can find
what the contract did not survive.

| Package | The deviation | What it replaced | Why it was ratified | Measurement |
|---|---|---|---|---|
| **D** | A NEW refusal (`NestedWriteError`, nothing written) on a selected update whose root rewrites a referenced column over an ordinary child-held non-cascading edge, with a compound / non-PK / unpinned reference, nested kinds all `create`/`createMany`, and the old slot OCCUPIED. | The payload SUCCEEDED, by a regime-ordering accident: the old `pastSurface` branch returned before the occupied guard was pushed. The root moved and `ON UPDATE SET NULL` silently orphaned the old child. | The accepted outcome was a silent orphan — the class this project refuses by precedent — and the accident contradicted its own pinned single-member twin, which refused throughout. Reverting means restoring the kind-gated incoherence D2 removed. | `compiled-key-transition-behavior.ts` (all legs), `parity-d-transition.test.ts` (the block that replaced the `pastSurface` pins, with the deleted messages quoted) |
| **G** | Validation TIMING: the inverse-to-one upsert found arm's primary-key portability and relation-key legality moved from construction to the deferred found-arm closure, after the planning probe. Payloads that name a missing arm now succeed. | Both checks ran at construction, so an untaken arm's shape could fail the call. | Plan-mandated — §6 G rule 2 verbatim, and §4.4's "do not eagerly analyze untaken arms". The untaken-arm inertness IS the lift. Same retarget class as D's two. | `upsert-untaken-arm-legality.test.ts`, `inverse-to-one-update-depth.test.ts` |
| **E** | The shared-primary-key lift lands per SELECTED RECORD, not per update ROOT: `RecordUpdateCompiler` serves the root, parent-held targets, upsert found arms and G's inverse seam, so nested selected records gained it too. Separately, shared-PK `connect` by lookup now refuses at CONSTRUCTION with zero statements. | §6 E1 is written for "an update root". The lookup refusal previously arrived as a compile-time `QueryEngineError` AFTER one statement had been issued. | Root-only would need a positional switch (banned) and would re-create the incoherence: the relation spelling and the scalar spelling of the same nested move now AGREE on both edges. The retarget is strictly more truthful and strictly earlier. | `parity-e-shared-pk.test.ts`, `shared-pk-update-root.test.ts`, `shared-pk-connect-or-create.test.ts` |
| **F** | `targetGeneratesReferencedKey` split into `targetProducesKey`, lifting the create arm for DB-PRODUCED values while preserving the refusal everywhere it is not lifting; one refusal-to-refusal retarget recorded at its call site. | One predicate answered two questions, so the refusal covered values the engine could in fact publish. | Refusal-preserving where it does not lift, and the lifted half is exactly §4.3's demand publication. The retarget changes which sentence a refused payload gets, not whether it is refused. | `parity-f-fresh-field.test.ts`, `fresh-produced-field.test.ts` |
| **K** | A relation key in `updateMany.data` no longer raises `ValidationError: Unknown key` — it routes to the series. On the relation arm `count` is the captured root count, while the scalar arm still reports the provider's affected rows: one operation name, two count contracts. §6 K5's shared-parse and §6 K3's capture width were both amended (see those units). | The parse boundary rejected the key outright; `count` had one meaning. | The refusal was the limitation being lifted. The count divergence is §5.2's own mandate — a provider that counts changed rather than matched rows answers zero for a no-op assignment — and both halves are witnessed. | `parity-k-update-many.test.ts`, `update-many-relation-series.test.ts`, ATOM §17 |
| **N** | Three previously-ACCEPTED payload classes now refuse: (1) nested `updateMany` data spelling the relation's owned FK, refused at the parse on ordinary schemas; (2) the same spelling on the two-scanner-divergent schema, refused in the engine; (3) `{ <ownedFk>: undefined }` in nested update data. | (1) and (2) SUCCEEDED and silently reparented the row — measured on PGlite through the public client. (3) executed, because the engine guard keyed on what survived absence classification. | (1) and (2) are the silent-wrong-row class, and Prisma's own generated inputs omit the key there. (3) makes nested update data agree with nested create data, which has refused the identical spelling since it was written; it does bite the spread idiom, which is why it is recorded rather than buried. | `nested-update-owned-fk.test.ts` — every class pinned with before/after state |

Two further ratifications that are NOT §3.1 changes, recorded here so the set is
complete: Package C's `capturedTargetValues`-family signature takes
`(model, projection, captured)` rather than the amendment's
`(projection, captured)`, because the existing `buildPrimaryKeyWhereUnique` needs
the model and storing a `Model` inside the projection would be worse; and
Package H's R3 — an order for a normalized composition entry — was REJECTED on
measurement, because such an entry does not reach the child-held obstacle, which
is the locator rather than the entry (§5.3's neighbour: planning precedes every
write).

Named future work — the units this lift measured and deliberately did not do —
has one home: `docs/architecture/guard-ownership-ledger.md`, "Named future units".
