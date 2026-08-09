# Query-Engine Limitation Lift Plan

**Date:** 2026-08-09
**Status:** Decision-complete implementation plan
**Starting commit:** 2ca32ad45465bf9f2b75f9047ea8761df22b6670

## 1. Outcome

Lift the query-engine restrictions that have useful, coherent semantics while extending the concepts that already own record mutation:

- RelationMutationProgram continues to describe one parsed relation request.
- BoundRelation continues to describe physical relation topology.
- CreateOperation remains the only non-bulk fresh-record compiler.
- RecordUpdateCompiler remains the only selected-record update compiler.
- TargetProjection becomes the single owner of a selected record's ordered identity and required captured fields.
- Existing field-bound FinalReferenceSource values continue to carry literals, planning values, transitioned values, final references, and lookups.
- One new operation-level execution form, RecordSeriesOperation, expresses a transaction containing a data-dependent sequence of ordinary record operations.
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

- Add compound many-to-many join sides.
- Define skipDuplicates plus nested-effect semantics.
- Emulate database referential actions.
- Add adapter APIs solely for relation concepts.
- Change the public meaning of existing bulk scalar operations.
- Accept contradictory foreign-key values.
- Accept ambiguous competing suppliers for one to-one slot.

## 4. Final internal contracts

### 4.1 Selected target identity

Extend the existing TargetProjection rather than adding CapturedIdentity, OperationValueTuple, or nth-row output concepts:

~~~ts
interface TargetProjection {
  readonly identityFields: readonly string[];
  readonly fields: readonly string[];
  readonly columns: readonly PolymorphicStorageColumn[];
}
~~~

Rules:

- identityFields is the target model's complete primary key in schema order.
- fields contains identityFields first, followed by other scalar fields required by compilation.
- fields contains no duplicate.
- columns contains private polymorphic storage columns required by exact-membership decisions.
- A caller never passes one external primary-key field beside a TargetProjection.
- The target-projection owner constructs a captured unique selector from all identity fields.

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

### 4.2 Demand-driven record-field publication

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

### 4.3 Transactional record series

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

### 4.4 PostgreSQL write-dependency fold

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

### 4.5 File ownership

Use these exact owners:

| Responsibility | File |
|---|---|
| Complete captured identity and projection helpers | src/query-engine/write-engine/target-projection.ts |
| Fresh field demand and publication | src/query-engine/write-engine/CreateOperation.ts |
| Selected record mutation | src/query-engine/write-engine/RecordUpdateCompiler.ts |
| Relation target/membership orchestration | Existing RelationWritePart, RelationUpsertPart, RelationJunctionPart, and nested-target-parts modules |
| Record-series contract | New src/query-engine/write-engine/RecordSeriesOperation.ts |
| Series execution and retry routing | src/query-engine/write-engine/OperationExecutor.ts |
| Pending direct/batch refusal | src/query-engine/write-engine/PendingOperationV2.ts and the live PendingOperation owner |
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

skipDuplicates with general nested effects remains refused. The public product meaning must first choose one of these incompatible contracts:

1. A skipped root suppresses every nested effect.
2. A skipped root adopts the existing row and applies its nested effects.

Do not guess this contract during implementation.

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

For more than one captured root, retain a pre-write refusal for child-held connect, connectOrCreate, and set. One child stores one parent membership; sequential last-parent-wins behavior does not satisfy “apply this update to every selected root.” M2M and parent-held equivalents remain meaningful and may execute.

### 5.3 Nested bulk relation operations

Root relation-bearing createMany and updateMany are mandatory goals. A relation-level createMany or updateMany whose row/data contains further relations is a second integration problem because it would place a record series inside an existing record tree.

Prototype nested reuse only after both root series consumers are green.

Keep the nested prototype only if:

- It reuses RecordSeriesOperation recursively on the same transaction driver.
- It does not add a series Part, transaction AST, callback protocol, or second planning model.
- The enclosing operation still constructs all nested members before its first effect.
- Step order, failures, retry ownership, and atomicity match repeated ordinary nested operations.
- No existing scalar nested createMany/updateMany path changes.

If any condition fails, remove the prototype and retain a focused nested-only refusal. Report it as the remaining architectural boundary rather than pretending root support implies nested support.

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

Remove already-delivered items from the working ledger:

- L5 optional descendant planning publication.
- S4 empty to-one payload no-op.

Replace obsolete vocabulary:

- PerFieldParentIdSource with field-bound relation membership sources.
- ParentIdSource.transitioned with transitionedPlanningField.
- buildNestedTargetChildParts with RecordCompilerSeam.updateSelected.
- deferArmLegality with found-arm legality closure.
- createManyAndReturn with createMany using select.

Reclassify:

- L3, L4, and L9 as one stale-guard falsification package.
- L6 and L7 as one old-read/new-write transition package.
- K6 as part of the to-one composition lattice.
- Compound M2M as a future capability, not a meaningless validation seal.

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

### Package C — Make selected identity compound by construction

This package covers L1.

#### C1. Extend TargetProjection

Add identityFields and central captured-selector construction. Preserve existing field and private-column output order.

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

Suggested commit:

~~~text
refactor: capture complete selected record identities
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

This package covers L2.

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

This package covers L10 and former K6.

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

### Package I — Add the transaction record-series atom

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
- Selects every primary-key member and any root field needed to derive final identity.
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
- Parsed data is shared immutable ParsedRecordPrograms.
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

#### N2. Do not seal compound M2M

Keep the current focused capability refusal. Document the required future work:

- Compound join-side schema metadata.
- Migration and introspection support.
- Join SQL with ordered multi-column halves.
- Engine membership and identity projection.

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
| Complete selected identity | Several child-requires-one-PK guards | TargetProjection.identityFields; no downstream arity guard |
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
- compound identity targeting
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

- skipDuplicates when no exact unique identifies which existing row caused the skip.
- skipDuplicates plus nested effects until the public contract chooses suppress-effects or adopt-and-apply.

### 7.4 Topology features not implemented here

- Compound many-to-many join sides.
- Any new polymorphic cardinality or identity form outside current relation contracts.

### 7.5 Substrate boundaries

- RecordSeriesOperation on a batch-only provider with no interactive transaction.
- Nested relation-bearing bulk if Package L fails its objective reuse gate.
- Child-held connect, connectOrCreate, or set across more than one updateMany root.

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
refactor: capture complete selected record identities
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

## 11. Final doctrine

The engine should gain capability by making its existing atoms more truthful:

- A selected record identity is all of its primary-key members.
- A fresh record can publish a demanded field once that field becomes knowable.
- A record compiler owns one complete record mutation.
- A relation owner owns membership and branch decisions.
- A record series owns only transactional sequencing of ordinary record operations.
- A PostgreSQL CTE fold owns only lowering a proven write-value dependency graph.

That division keeps the portable semantics simple and lets PostgreSQL compress eligible work without turning provider-specific SQL into a second query engine.
