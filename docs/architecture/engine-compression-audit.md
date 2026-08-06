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
6. explicit relation owners for membership and branch policy.

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
| legality | OwnWrite preflight |
| junction SQL | `ManyToManyStatements` |
| bulk writes | specialized bulk compilers |
| result contract | output/result shaping |

The record-compiler pass is mainly an ownership correction. It does not remove
`RelationMutationProgram`, `BoundRelation`, or relation Parts, because each says
something independent. It removes the false idea that selected-record update
semantics belong to a nested mode of the public update operation, together with
compatibility carriers that exposed that mode.

Documentation deletion is not production compression. Against the historical
boundary above, the final measured deltas are:

| Surface | Measure | Net |
| --- | --- | ---: |
| production TypeScript, `src/**/*.ts` | raw diff | **−758 lines** |
| changed production TypeScript | lexical token-bearing lines | **−168 lines** |
| owned Markdown | whole-file line count | **−4,675 lines** |

The lexical measure counts lines containing TypeScript tokens and excludes
comments and whitespace. It prevents the removal of historical comments from
masquerading as executable compression.

The durable concept count fell from approximately 18 to 17. The removed concept
is the selected-record `nestedTarget` operating mode of the public
`UpdateOperation`. `RecordUpdateCompiler` now owns that job directly. The pass
also deleted its compatibility vocabulary: `NestedTargetLocate`,
`selectedTargetReadId`, `selectedWriteId`, `locateNotFoundOptional`,
`selectedRequiredTargetFields`, `selectedPlanning`,
`selectedConditionalPlanning`, and `compileSelected`. Finally,
`SKIP_LEAF_PATTERN` and `INSERT_TARGET_PATTERN` disappeared when create-fold
decisions stopped recognizing rendered dialect SQL.

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
fresh subtree order. `createMany` remains specialized.

### RecordUpdateCompiler: one selected record

The update compiler receives scalar data, relation programs, a captured target,
and optional incoming FK assignments. It owns the root SET, nested relations,
required target projection, primary-key transition logic, and descendant order.
It returns no compiler for a true no-op before allocating a step ID.

### Relation Parts: why this record

Relation owners keep selector and parent correlation, membership, found/missing
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

Fresh many-to-many attachment requires target before-writes, target insert,
junction insert, then target descendants. A universal create hook would add a
lifecycle concept to hide one explicit domain order. The junction path remains
separate.

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
