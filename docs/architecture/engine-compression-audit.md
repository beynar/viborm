# Query-Engine Compression Audit

**Current as of:** 2026-08-08

**Historical boundary:** `db3317770ce7e589ba1da849570eda6925c4c478`

That commit is the last revision that contains the full implementation ledgers
retired by this documentation pass. Use Git history when an old phase decision
must be reconstructed. The live architecture is documented in
[`ATOM.md`](../../src/query-engine/write-engine/ATOM.md).

## Result

The engine is smaller in responsibility count than the pre-compression design,
but it is not a tiny compiler. Nested writes have irreducible differences in
topology, target ownership, race premises, referential actions, and bulk
semantics.

The retained compression is semantic:

1. one execution vocabulary: read, write, guard;
2. one lossless representation of parsed relation intent;
3. one topology representation for a bound relation position;
4. one fresh-record compiler;
5. one selected-record update compiler;
6. exact relation owners for child-held and junction membership policy.

This is not a claim that all relation code can merge. The record compiler owns
the mutation of a row. The relation owner owns why that row was selected and
how it belongs to its parent. Merging those responsibilities would replace
visible branches with strategies, callbacks, or mode flags.

## Honest concept outcome

The current architecture has approximately 17 durable concepts when related
types are grouped by responsibility rather than counted as individual TypeScript
symbols:

| Group | Durable concept |
| --- | --- |
| public orchestration | `QueryEngine`, `PendingOperation`, and executable operation shells |
| execution | statement/guard atom |
| phase boundary | planning fragment |
| final program | operation fragment |
| execution service | operation executor |
| composition | Part |
| identity | step scope and output references |
| parsed relation meaning | relation mutation program |
| topology | bound relation |
| value provenance | source-bound relation membership and field-bound FK members |
| fresh record | `CreateOperation` |
| selected record | `RecordUpdateCompiler` |
| edge policy | relation Parts |
| legality | OwnWrite analysis |
| junction SQL | `ManyToManyStatements` |
| bulk writes | specialized bulk compilers |
| result contract | output/result shaping |

The record-compiler passes are mainly ownership corrections. They do not remove
`RelationMutationProgram`, `BoundRelation`, or relation Parts, because each says
something independent. It removes the false idea that selected-record update
semantics belong to a nested mode of the public update operation, together with
compatibility carriers that exposed that mode.

Documentation and comment deletion are not executable compression. The
structural census therefore records both physical lines and non-trivia
TypeScript token-start lines. The token census now walks parser-owned tokens. Its
previous standalone scanner lost lexical state after template expressions and
could count backticks in later comments as code. The corrected figures below
supersede the older token-line claims.

At the last pre-polymorphic compression checkpoint, the historical boundary
above measured:

| Measure | Historical | Current | Net |
| --- | ---: | ---: | ---: |
| production TypeScript files | 110 | 109 | **−1** |
| physical production lines | 35,992 | 34,435 | **−1,557** |
| non-trivia token-start lines | 25,515 | 25,640 | **+125** |
| measured functions | 1,406 | 1,379 | **−27** |
| branch nodes | 3,110 | 3,082 | **−28** |

The final refinement started at `4f696b46ddee4f44c954e3370d98cc371f73a5ee`:

| Measure | Before | After | Net |
| --- | ---: | ---: | ---: |
| physical production lines | 35,207 | 34,435 | **−772** |
| non-trivia token-start lines | 25,595 | 25,640 | **+45** |
| comment/blank physical remainder | 9,612 | 8,795 | **−817** |
| measured functions | 1,399 | 1,379 | **−20** |
| branch nodes | 3,084 | 3,082 | **−2** |
| write-engine runtime cycles | 1 | 0 | **−1** |
| `RelationJunctionPart.ts` | 2,565 | 2,242 | **−323** |

That closure pass changed six executable-owner production files:

| Measure | Before | After | Net |
| --- | ---: | ---: | ---: |
| physical production lines | 5,745 | 5,574 | **−171** |
| non-trivia token-start lines | 4,592 | 4,583 | **−9** |
| measured functions | 256 | 253 | **−3** |
| branch nodes | 399 | 395 | **−4** |

Comment-only corrections in two supporting production files remove another 15
physical lines without changing token-start lines. The task-owned total is
therefore **−186 physical lines** and **−9 token-start lines**. Concurrent
work in `execution-context.ts` accounts for another 16 physical and 14
token-start lines in the working-tree total and is not attributed to this
pass. Architecture Markdown is also excluded from production compression.

The corrected token measure changed the conclusion: the long compression series
removed physical size, functions, branches, cycles, false concepts, and ownership
surfaces, but it did not reduce token-start production lines against the
historical boundary. That closure pass itself removed 9 such lines.

The durable concept count remained approximately 17. Exact junction state and
the type-only compiler seam are representations of existing responsibilities,
not new semantic owners. This refinement instead deleted or merged compatibility
carriers: `OwnWritePreflight`, `canonicalRecordUpdateData`,
`UpdateRecordBuilder`, `NestedFreshCreatePart`,
`buildNestedTargetFreshCreatePart`, duplicate fresh-record builders, the
`ArmSeam`/`FreshArmBuilder` vocabulary, `JunctionKind`, junction parallel
configuration channels, the inverse-upsert local selected-update builder, and
`updateArmUsesCompiler`.

The closure pass added no durable concept. It removed the `RelationWriteKind`
carrier and the false optional inverse-upsert subtree state, reuses the bound
relation already present in an OwnWrite footprint, and removes the junction
disconnect slot's dummy update payload. The resulting exact slot aliases are
representations of existing operation kinds, not new owners.

Three false ownership surfaces disappeared: OwnWrite's pass-through preflight,
the duplicate nested fresh-record compiler surface, and the inverse to-one
upsert's private selected-update path. The junction's optional aligned arrays
also became one exact input variant and one exact allocated plan.

The inverse-polymorphic feature then expanded the engine. The source-bound
membership pass started at `2751a454c638f111e7d2467a347a6366d52875eb` and
compressed the feature without removing behavior:

| Measure | Before | After | Net |
| --- | ---: | ---: | ---: |
| query-engine physical lines | 37,408 | 37,166 | **−242** |
| query-engine token-start lines | 28,525 | 28,354 | **−171** |
| query-engine branch nodes | 3,345 | 3,304 | **−41** |
| write-engine physical lines | 19,637 | 19,395 | **−242** |
| write-engine token-start lines | 14,637 | 14,466 | **−171** |
| write-engine branch nodes | 1,467 | 1,426 | **−41** |
| write-engine runtime cycles | 0 | 0 | **0** |

This pass replaced the dual incoming-FK/private-storage compiler channels with
one exact membership binding. It also deleted `UpsertParentBinding`, the
planning/final polymorphic identity wrappers, and the relation emitters' local
assignment, clear, correlation, projection, storage, and found-row helper
families. The stronger carrier adds no durable responsibility, so the grouped
concept count remains approximately 17.

`QueryMetadata` remains only as a deprecated compatibility alias. It is not a
runtime concept and does not increase this count.

## Final ownership model

### RelationMutationProgram: what was requested

The program records schema-transformed payload meaning. It preserves mutation
kind order, item order, duplicates, empty set, filters, and normalized target
forms. It does not contain topology or execution deduplication.

### BoundRelation: where the edge is stored

The bound relation classifies an edge as parent-held to-one, child-held to-one,
child-held to-many, polymorphic child-held to-many, or junction. It carries
ordered topology only. It does not contain scopes, identities, value sources,
transition values, SQL, or branch policy.

Parent and child are recursive, edge-relative roles: parent is the enclosing
source record whose relation field is being compiled, and child is its target.
`parentHeldToOne` means that source record stores the FK.

### CreateOperation: one fresh record

The create compiler receives parsed data and one optional source-bound incoming
membership.
It owns the root insert, generated identity demand, nested record effects, and
fresh subtree order. The explicit inline junction-target insert and
`createMany` remain specialized. A fresh parent stores its post-insert
create-many groups in `CreateOperation`; a selected parent uses
`nested-target-parts.ts`; junction create-many remains in
`RelationJunctionPart`. The top-level form stays in `CreateManyOperation`.

### RecordUpdateCompiler: one selected record

The update compiler receives scalar data, relation programs, a captured target,
and one optional source-bound incoming membership. It owns the root SET, nested
relations, required target projection, primary-key transition logic, and
descendant order.
It returns no compiler for a true no-op before allocating a step ID.

For `parentHeldToOne`, the compiler also owns the inline FK fold and branch that
constructs the record's root statement. The top-level scalar upsert fold stays
in its operation shell because it preserves the one-statement `ON CONFLICT`
path.

### Relation Parts: why this child-held or junction record

Child-held and junction owners keep selector and parent correlation, membership,
found/missing decisions, not-found behavior, guards, race pins, junction writes,
and standalone edge effects. They pass the captured target to the record compiler.

### One source-bound membership value

Ordinary child-held relations and polymorphic inverse relations have different
physical storage, but the write engine asks the same questions of both: how to
assign membership, clear it, correlate a planning or final statement, project
the columns needed by a branch, and decide whether a captured row belongs to the
parent. `relation-membership.ts` answers those questions from one discriminated
value. Link, set, targeted-write, upsert, create, and selected-update code no
longer reconstruct those rules from parallel relation/source/storage inputs.

This does not merge direct polymorphic intent or junction membership. Direct
intent selects a target variant from the payload; junction membership is a join
row. Neither has the same invariant as a child-held edge.

## Why the remaining branches are real

### Branch pins

A found row can vanish between an unlocked planning read and an atomic batch.
The batch path guards the captured row. A missing arm that inserts the same
unique target uses the database constraint and a root-write race pin. A
same-operation duplicate needs neither. These are different premises, not
syntax variants.

A conditional-skip batch arm has two premises. A non-raceable presence guard
first proves that the selector still names the captured row. A raceable absence
guard then proves that this same row still does not match the conditional. The
second check uses an absence query, so SQL UNKNOWN remains a no-match. Keeping
the failures separate preserves both wrong-row refusal and false-to-true retry.

### Captured-primary-key targeting

An extended selector can stop matching or match another row after planning.
The write therefore addresses the primary key captured by the owner read.
This is the wrong-row invariant and cannot be compressed into selector reuse.

### Parse once

Validation transforms are not necessarily idempotent. Re-parsing canonical
output can apply a transform twice or reinterpret an envelope. Parsed relation
programs and transformed record data cross compiler boundaries directly.

### Old read, new write

A primary-key transition reads membership with the old key and assigns edges
with the new key. One inferred parent value cannot serve both jobs. Correlated
foreign-key members keep independent read and write sources.

### First-create-wins

Repeated connect-or-create entries in one operation can name a row created by
an earlier sibling. The later entry adopts that local row without a database
race guard. This deduplication belongs to connect-or-create and is not applied
to upsert.

### Junction placement

Fresh many-to-many attachment has two pinned orders. An inline target emits its
INSERT, the junction INSERT, then inline descendants. A delegated target emits
its complete fresh-record subtree before the junction INSERT. A universal create
hook would either change the delegated order or add placement policy. The
junction path therefore remains explicit and stores its input and allocated
state as exact discriminated variants instead of parallel optional arrays.

## Deliberately retained specializations

- `createMany`, `updateMany`, and `deleteMany`;
- relation `set`;
- skip-duplicate grouping and preparation writes;
- direct top-level scalar folds;
- many-and-return folds;
- junction SQL in `ManyToManyStatements`;
- adapter `batchRefs` and executor generated-ID scratch.

These mechanisms express set semantics or substrate capabilities. Absorbing
them into one-record compilation would add policy switches rather than remove
meaning.

## Rejected shapes

The audit rejects a generic mutation DSL, payload walker, branch-step IR,
universal locator, adopt strategy, operation base class, lifecycle callbacks,
junction placement flags, and a shared utility landfill.

An abstraction is acceptable only when at least three consumers implement the
same semantic rule and must change together. Similar syntax is not enough.

## Acceptance rules

The final design must preserve public APIs, result types, SQL meaning,
parameters, step allocation, execution order, guards, race pins, errors, and
transaction behavior. It adds no runtime step kind and no adapter policy.

Proof includes both transaction and forced atomic-batch paths, wrong-row decoys,
same-operation duplicates, generated identities, compound edges, key
transitions, and junction membership. PostgreSQL and MySQL suites must be
reported as not run when Docker is unavailable; skipped is not passed.

## Closing note — the distinct-truth plan executed against this audit

**Added 2026-08-12.** The historical body above is unchanged; this note only
records what happened next.

`query-engine-distinct-truth-compression-plan.md` took this audit as its
starting statement and ran phases 0 through 12 against it. It did not revisit
the rejected shapes — no mutation DSL, payload walker, branch-step IR, locator
or strategy was proposed or added — and it kept every acceptance rule above:
public APIs, result types, SQL bytes, parameters, step allocation, execution
order, guards, race pins, errors and transaction behavior.

What it changed is the number of places a single fact is stated. Relation
topology became one bound value on three orthogonal axes; the read side gained
one physical traversal; membership views, cardinality and clearability became
derived rather than stored. Phase 10 (a compiled selection fact) was
implemented in its only byte-safe form, MEASURED, and REJECTED at its own gate;
its falsifier is recorded in `guard-ownership-ledger.md` so it is not re-run on
the same evidence, and Phase 11, which was conditional on it, did not run. The
census of what the plan deleted and what it left with one owner is
`distinct-truth-final-census.md`.

The rule the plan ends on, and the one this audit's successors should apply:
**one stored topology, several derived views**.
