# Query Engine Write Engine

The write engine is the live nested-write implementation. It compiles validated
create, update, upsert, delete, and many-write requests into two linear phases:
a guard-free planning fragment and one selected final fragment.

## Lifecycle

```text
whole-args validation
→ scalar/relation partition
→ lossless relation mutation programs
→ OwnWrite legality
→ guard-free planning
→ selected final fragment
→ generic execution
→ declared result parsing
```

The operation owns meaning. `OperationExecutor` owns provider execution,
transaction or atomic-batch envelopes, symbolic-value materialization, guard
attribution, and strict result handling. It must not learn relation or mutation
semantics.

## Step and fragment model

`OperationFragment.ts` has three runtime step kinds:

```ts
interface ReadStep extends StatementStepBase {
  readonly kind: "read";
}

interface WriteStep extends StatementStepBase {
  readonly kind: "write";
  readonly racePin?: TargetConstraintPin;
  readonly onUniqueConflict?: "skip";
}

type StatementStep = ReadStep | WriteStep;

interface PlanningFragment {
  readonly steps: readonly StatementStep[];
  readonly outputs: Readonly<Record<string, FragmentOutputSource>>;
}
```

Final fragments may also contain guards. Planning fragments cannot. Planning is
not read-only: E6.9 skip-duplicate capture intentionally performs preparation
writes and publishes their outputs for final compilation. Nested
`Part.planning()` currently contributes reads.

`racePin` and `onUniqueConflict` belong only to writes. A read carrying either
effect is a type error. Fragment validation enforces unique IDs, backward local
references, resolvable outputs, and guard Pin-Rule classes.

## Canonical relation mutation program

`builders/relation-mutation-parser.ts` transforms schema-parsed relation data
into:

```ts
interface RelationMutationProgram {
  readonly relationInfo: RelationInfo;
  readonly entries: readonly RelationMutationEntry[];
}
```

The program is lossless for operation meaning:

- mutation kinds keep schema order;
- source array order and duplicates survive;
- `set: []` survives;
- false boolean no-ops are removed;
- to-one filters and normalized target forms survive;
- execution-specific deduplication is not stored in the program.

OwnWrite and every emitter consume `entries`. A consumer must not reopen the raw
payload, normalize arrays again, or recreate the old optional per-kind bag.

## Field-bound foreign-key provenance

`foreign-key-reference.ts` owns all source kinds and lowering:

```ts
interface ForeignKeyMember {
  readonly foreignField: string;
  readonly referencedField: string;
  readonly writeSource: FinalReferenceSource;
}

interface CorrelatedForeignKeyMember extends ForeignKeyMember {
  readonly readSource: PlanningReferenceSource;
}
```

Each source is bound to its edge member before resolution. A transitioned key
reads the old planning field and writes the transformed final value. A final
operation reference cannot enter planning SQL. A lookup is a final SQL source;
the root operation still owns its existence and null checks.

Many-to-many membership uses the same split: membership reads and batch guards
use the old source, while assignments use the final source. Junction SQL remains
owned by `ManyToManyStatements`.

## Record compilation and relation position

`bindRelation` classifies a relation at its first topology decision:

```ts
type BoundRelation =
  | ParentHeldToOne
  | ChildHeldToOne
  | ChildHeldToMany
  | JunctionRelation;
```

The bound relation stores ordered foreign and referenced fields for an FK edge.
It does not store scopes, identities, value sources, transition state, junction
metadata, SQL, or execution policy. `RelationMutationProgram` remains separate:
it describes the request, while `BoundRelation` describes the edge position.

`CreateOperation` is the one compiler for a non-bulk fresh record subtree.
Nested callers provide parsed data, field-bound incoming FK members, and an
optional root race pin. The fresh-record Part publishes its planning and final
steps, root write ID, and root referenced values. Relation Parts still own
membership and found/missing decisions. `createMany` remains specialized.

A prototype selected-record compiler was removed after falsification. Existing
paths do not share one target-read contract: scalar target updates reuse an
outer rows-only probe, deep updates perform a second locate with stricter
cardinality, and empty updates currently allocate suppressed IDs that preserve
later sibling suffixes. A universal compiler either changed those observable
plans or required position policy that exceeded the deletion gate. The current
depth-specific update compiler therefore remains live.

## Branch premises

Branch sites explicitly compile the selected arm:

- batch found arm: captured-row presence guard, `raceable: false`;
- transaction found arm: locked read, no duplicate guard;
- missing arm inserting the unique target: constraint + write `racePin`;
- same-operation duplicate: neither guard nor pin;
- retained materialized-set or orphan premises: their existing `notExists`
  guards, `raceable: true`.

The `AdoptProbe` prototype was rejected. It required arm compiler callbacks and
a duplicate exception across the four sites, so it became a strategy object and
failed the negative-line gate. The previous declaration-only `Probe` and
`validateProbe` were deleted because they did not enforce consumption.

## Ordering invariants

1. Step IDs and SQL/parameter order are stable observable contracts.
2. Planning contains no guards.
3. Final batch guards run before writes; relative order within both buckets is
   preserved.
4. A symbolic reference points backward inside the same fragment.
5. Planning values cross into final compilation as known values, not references
   to the discarded planning fragment.
6. Read-before/write-after key transitions keep independent sources.
7. First-create-wins duplicate behavior remains local to connect-or-create.
8. Wrong-row protections address the captured row, not a re-evaluated selector.

## Kept boundaries

- `QueryMetadata`
- adapter `batchRefs`
- `ManyToManyStatements`
- E6.9 planning preparation writes
- adapter-owned SQL, casts, assertions, conflict syntax, and locking
- explicit junction-create attachment order

Do not add a universal operation program, generic mutation DSL, payload walker,
strategy framework, branch-step IR, or shared utility landfill.

## Validation

Run the focused nested-write and race tests for a changed path, then:

```bash
pnpm test:types
pnpm test:gates
pnpm package:build
```

Use both PGlite transaction and forced atomic-batch witnesses. Run PostgreSQL
and MySQL parity suites when Docker is available.
