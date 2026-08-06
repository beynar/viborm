# Query-Engine Compression Audit

**Current as of:** 2026-08-06

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
| public orchestration | operation shell and `QueryMetadata` |
| execution | statement/guard atom |
| phase boundary | planning fragment |
| final program | operation fragment |
| execution service | operation executor |
| composition | Part |
| identity | step scope and output references |
| parsed relation meaning | relation mutation program |
| topology | bound relation |
| value provenance | field-bound FK members |
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
TypeScript-token lines. Against the historical boundary above, the query engine
now measures:

| Measure | Historical | Current | Net |
| --- | ---: | ---: | ---: |
| production TypeScript files | 110 | 109 | **−1** |
| physical production lines | 35,992 | 34,576 | **−1,416** |
| non-trivia token lines | 16,396 | 15,979 | **−417** |
| measured functions | 1,406 | 1,376 | **−30** |
| branch nodes | 3,110 | 3,084 | **−26** |

The final refinement started at `4f696b46ddee4f44c954e3370d98cc371f73a5ee`:

| Measure | Before | After | Net |
| --- | ---: | ---: | ---: |
| physical production lines | 35,207 | 34,576 | **−631** |
| non-trivia token lines | 16,225 | 15,979 | **−246** |
| comment/blank physical remainder | 18,982 | 18,597 | **−385** |
| measured functions | 1,399 | 1,376 | **−23** |
| branch nodes | 3,084 | 3,084 | **0** |
| write-engine runtime cycles | 1 | 0 | **−1** |
| `RelationJunctionPart.ts` | 2,565 | 2,242 | **−323** |

Owned architecture Markdown changed by **+69 physical lines** because the live ownership doctrine replaced older claims; it is not counted as production compression.

The token measure excludes comments and whitespace. The comment/blank remainder
is reported separately so historical narrative removal cannot masquerade as
executable compression.

The durable concept count remains approximately 17. Exact junction state and
the type-only compiler seam are representations of existing responsibilities,
not new semantic owners. This refinement instead deleted or merged compatibility
carriers: `OwnWritePreflight`, `canonicalRecordUpdateData`,
`UpdateRecordBuilder`, `NestedFreshCreatePart`,
`buildNestedTargetFreshCreatePart`, duplicate fresh-record builders, the
`ArmSeam`/`FreshArmBuilder` vocabulary, `JunctionKind`, junction parallel
configuration channels, the inverse-upsert local selected-update builder, and
`updateArmUsesCompiler`.

Three false ownership surfaces disappeared: OwnWrite's pass-through preflight,
the duplicate nested fresh-record compiler surface, and the inverse to-one
upsert's private selected-update path. The junction's optional aligned arrays
also became one exact input variant and one exact allocated plan.

## Final ownership model

### RelationMutationProgram: what was requested

The program records schema-transformed payload meaning. It preserves mutation
kind order, item order, duplicates, empty set, filters, and normalized target
forms. It does not contain topology or execution deduplication.

### BoundRelation: where the edge is stored

The bound relation classifies an edge as parent-held to-one, child-held to-one,
child-held to-many, or junction. It carries ordered topology only. It does not
contain scopes, identities, value sources, transition values, SQL, or branch
policy.

### CreateOperation: one fresh record

The create compiler receives parsed data and field-bound incoming FK members.
It owns the root insert, generated identity demand, nested record effects, and
fresh subtree order. The explicit inline junction-target insert and
`createMany` remain specialized.

### RecordUpdateCompiler: one selected record

The update compiler receives scalar data, relation programs, a captured target,
and optional incoming FK assignments. It owns the root SET, nested relations,
required target projection, primary-key transition logic, and descendant order.
It returns no compiler for a true no-op before allocating a step ID.

For `parentHeldToOne`, the compiler also owns the inline FK fold and branch that
constructs the record's root statement. The top-level scalar upsert fold stays
in its operation shell because it preserves the one-statement `ON CONFLICT`
path.

### Relation Parts: why this child-held or junction record

Child-held and junction owners keep selector and parent correlation, membership, found/missing
decisions, not-found behavior, guards, race pins, junction effects, and terminal
relation effects. They pass the captured target to the record compiler.

## Why the remaining branches are real

### Branch pins

A found row can vanish between an unlocked planning read and an atomic batch.
The batch path guards the captured row. A missing arm that inserts the same
unique target uses the database constraint and a root-write race pin. A
same-operation duplicate needs neither. These are different premises, not
syntax variants.

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
- skip-duplicate grouping and E6.9 planning writes;
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
