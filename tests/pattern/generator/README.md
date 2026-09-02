# Payload generator (pattern engine, unit B)

A seeded, deterministic, shrinkable generator of operation payloads, driven by
the operation schemas a `createSchemaRegistry(schema)` builds. The differential
(§13.5 M1/M2) runs both engines over the corpus it produces.

```ts
import { createSchemaRegistry } from "@validation";
import { generateCorpus, generatePayload, validatePayload } from "@tests/pattern/generator/generate";
import { shrinkPayload } from "@tests/pattern/generator/shrink";
import { mutate, mutateAll } from "@tests/pattern/generator/invalid";

const registry = createSchemaRegistry(schema);

const one = generatePayload(schema, registry, 42);          // { model, operation, args, path, trail, seed }
const corpus = generateCorpus(schema, registry, 42, 1000);  // member i is seeded by deriveSeed(42, i)

validatePayload(registry, schema, one);                     // parse-boundary.ts's parseValidated; throws ValidationError

const shrunk = shrinkPayload(failing, (p) => oracleDisagrees(p));  // { value, steps, attempts }

const mutant = mutate("set-under-create", one, schema, registry);  // InvalidPayload | undefined
```

## What a payload is

```ts
interface GeneratedPayload {
  model: string;                 // root model name (a key of the schema map)
  operation: RootOperation;      // findMany | findFirst | findUnique | create | update | upsert | delete
                                 // | createMany | updateMany | deleteMany | count | aggregate | groupBy
  args: Record<string, unknown>; // the payload, valid for registry.getModelSchemas(model).args[operation]
  path: string[];                // every relation verb emitted, as "<dotted path>:<verb>"
  trail: TrailEntry[];           // the same, structured: { path, kind: toOne|toMany, context, verbs }
  seed: number;                  // regenerate with generatePayload(schema, registry, seed, sameOptions)
}
```

`validatePayload` is the exact entry the write engine validates root args
through (`parseValidated` in `src/query-engine/write-engine/parse-boundary.ts`,
on `registry.getModelSchemas(model).args[operation]`); the read side
(`src/query-engine/validator.ts`) parses the same schema object.

## Seeds and determinism

`generatePayload(schema, registry, seed, options)` is a pure function of its
four arguments: one mulberry32 stream per payload, every choice drawn from it
in walk order. A corpus member's seed is `deriveSeed(corpusSeed, index)` (a
hash, so neighbours do not share a prefix) and is carried on the payload, so a
failing member is re-creatable from `{ seed, options }` alone.

## Options (coverage knobs)

| option | default | effect |
|---|---|---|
| `maxDepth` | 3 | relation nesting budget: relation keys are not opened past this depth (a required relation at the budget is satisfied with `connect`) |
| `maxObjectNesting` | 12 | hard cap on object nesting of any kind (to-one `orderBy` hops, deep filters); past it only leaf keys are added |
| `maxSelfRecursion` | 1 | how many times one schema object may re-enter itself on a path (`where.AND[i]` is the same `where`, scalar `not` the same filter); the last admitted re-entry is leaf-only, which is what keeps a self-recursive schema from growing geometrically |
| `weights` | findMany 2, create 3, update 3, upsert 2, others 1 | root operation weights; 0 disables one |
| `models` | every model | root models to draw from |
| `idPoolSize` | 3 | literals per field: strings are `<field>_1..N`, ints `1..N`, dates day `1..N`; the pool is what makes `connect` targets and `where` selectors repeat |
| `optionalKeyProbability` | 0.35 | chance of emitting each optional key |
| `nullProbability` | 0.15 | chance of `null` in a nullable slot (never under a JSON write, which refuses it) |
| `maxArrayLength` | 3 | arrays carry 1..N items (empty with p=0.1) |
| `composeToOne` | true | also propose the two-verb to-one compositions (`disconnect`+`connect`, `delete`+`create`, `connect`+`update`, …); the bag's own validator arbitrates and an `exactlyOne` surface falls back to a single verb |
| `allowEmptyObjects` | false | leave `{}` where the schema allows it instead of adding one key |

## How the walk works

The generator never asks the model which verbs a relation admits. It resolves
the root `args.<operation>` schema and walks the VibSchema graph:

- **object**: `entries` (thunks and `lazyRef`s resolved), honouring the option
  set the validator reads — `omit` (the nested-data projection), `partial:
  false`, `atLeast`, `requiresOneOf`, `requiresOneOfKeySets` (one key set per
  group; the untaken alternatives — a foreign key vs. its relation bag — stay
  out), `nonEmpty`, and the optional/nullable/array wrappers. Optional keys are
  added with `optionalKeyProbability`; `select`/`include`/`omit` are mutually
  exclusive; `omit` names exactly one field so a projection survives it.
- **to-one mutation bags** (entries ⊆ create/connect/connectOrCreate/update/
  upsert/disconnect/delete): exactly one verb, or one accepted composition.
- **to-many mutation bags** (entries include createMany/set/…): one or two verbs.
- **union**: one generatable option (preferring leaf options at the depth
  budget); **array**: 1..N items; **optional/nullable/wrapped** (transform,
  comparison_operand, field_ref_or, no_field_ref, json_null_or, json_write):
  the wrapped schema.
- **scalars**: string, integer, number, boolean, bigint, decimal (to the
  descriptor's scale), enum, literal, json, date, iso_timestamp, iso_date,
  iso_time, blob, vector (its dimension), point.
- **skipped**: `refused` entries, `rawRecord`/`anyValue`/`record`, an object
  without `entries` (the relation filter's bare `null` member), JSON null
  sentinels, operand callbacks and SQL fragments.

A relation entry is recognised structurally (its schema offers verbs, relation
filters or a projection), its cardinality read back from the keys it offers,
and it is recorded on `trail` with the verbs spelled there.

## Shrinking

`shrinkPayload(payload, fails)` removes one node at a time — object-valued keys
first, then array items, then primitive keys, each category swept in reverse
discovery order (descendants before ancestors, later array items first, so a
removal never invalidates a path still to be tried) — keeping a removal
whenever `fails` still holds, and repeating the sweep while it makes progress.
Every accepted step reduces the node count, so it terminates; the order is
fixed, so it is deterministic. Write `fails` as the failure SIGNATURE (this
error class, this message), not "any error": a coarse predicate lets the
shrinker wander to a different, smaller failure. `shrinkValue` does the same
for any JSON-like value; both report `steps` (accepted removals) and `attempts`
(predicate evaluations).

## Invalid mode

`mutate(strategy, payload, schema, registry)` returns a mutant labelled with the
STAGE that decides it (`expect.stage`) and, where the sentence is fixed, the
message. There are two halves, and the stage is the discriminant:

- `VALIDATION_STRATEGIES` — the parse boundary refuses them; `expect.class` is
  the validator's refusal class.
- `SEMANTIC_STRATEGIES` — the parse boundary ACCEPTS them, and the verdict comes
  from a §19 admit (`construction`), OwnWrite (`legality`), the packer
  (`packing`), an execution premise (`premise`), or is no refusal at all
  (`none`: the shape must reach a program). `expect.error` is today's error
  class, `expect.messageFor(N)` the sentence when it names a runtime count, and
  `expect.deferredKind` the `DeferredRefusal.kind` the pattern engine's
  construction records for the same shape.

`INVALID_STRATEGIES` is both halves. The M1 fuzz dashboard runs the semantic
half as its own cells (`fuzz-invalid:<strategy>:…`), so the differential
compares REFUSALS below validation, not statements.

### The validation half

| strategy | mutation | class |
|---|---|---|
| `unknown-key` | `__unexpected: 1` at the root | unknown-key (`Unknown key: __unexpected`) |
| `wrong-scalar-type` | a `Symbol` at the first primitive leaf | type-mismatch |
| `to-many-verb-on-to-one` | `{ set: [] }` on a to-one relation of a data arm | unknown-key (`Unknown key: set`) |
| `empty-where-unique` | `where: {}` on a unique-selector root | empty-selector (`cannot be empty`) |
| `set-under-create` | `{ set: [] }` on a to-many relation under a create arm | unknown-key (`Unknown key: set`) |
| `disconnect-on-required` | `{ disconnect: true }` on a to-one whose update bag publishes no `disconnect` | unknown-key (`Unknown key: disconnect`) |
| `missing-required` | a required create key removed | missing-required (`Missing required field`) |
| `select-and-include` | both projections at the root | exclusive-keys (`Mutually exclusive`) |

### The semantic half

Every mutant is ISOLATED: projections are dropped, the root selector is reduced
to the row key (a bulk root matches every row), and the mutated arm carries
exactly the tested shape — otherwise the base payload's own verbs decide the
cell before the mutation does.

| strategy | mutation | stage today | today's sentence |
|---|---|---|---|
| `bulk-membership-move-connect` | `updateMany` + `connect` on an edge stored on the target row (or a unique member slot) | construction (§5.2, after the capture counts rows) | `updateMany matched N rows, so it cannot apply 'connect' to relation '…'` |
| `bulk-membership-move-set` | the same with `set` | construction | the same sentence with `'set'` |
| `bulk-membership-move-disconnect` | the same with `disconnect` | **none** — a `disconnect` names no target to steal | — |
| `bulk-member-to-many-verb` | `updateMany` + a nested `updateMany` on a to-many | none (routes to a record series, ATOM §17) | — |
| `null-relation-key` | `{ fk: null, relation: { connect } }` | packing | ATOM §20.1's `conflicting final assignments for column '…'` (the null-key sentence is what construction defers) |
| `primary-key-two-operations` | `{ pk: { set, increment } }` on an int key | construction (§19) | `Primary key field '…' accepts exactly one update operation` — an `upsert` reaches `getUpdatedPrimaryKeyValue` first and words it differently |
| `primary-key-arithmetic` | `{ increment }` on a float/decimal key | construction (§19) | `Arithmetic updates are not portable for … primary key field '…'` |
| `relation-key-non-literal` | `{ fk: { increment }, relation: { connect } }` | construction | `Cannot update relation key field '…' with a non-literal operation` |
| `shared-key-ambiguous-arm` | a merge supplying a reference whose columns ARE the row key | packing | `does not support a shared-primary-key …` |
| `disconnect-then-connect` | the accepted to-one composition | **none** | — |
| `create-then-update-same-row` | nested `create` with a spelled key + `update` naming it | **none** (measured: OwnWrite does not call this feedback) | — |
| `set-then-connect` | `set` beside `connect` on one to-many | **none** | — |
| `unknown-variant` | `type: "__nope"` on a variant family | **validation** (measured: the discriminator is a literal union, so construction's `unknownVariant` arm is defensive and unreachable) | `did not match any union member` |
| `to-one-update-where-mismatch` | a to-one `update` whose filter selects another row | premise | `Cannot update relation '…': target record was not found for this parent.` |
| `set-orphans-required-child` | `set` on a to-many whose members hold a REQUIRED reference | premise | `Cannot set relation '…' because foreign key field(s) … are required` |

A strategy returns `undefined` when the payload offers nothing to mutate. Three
of the semantic shapes are absent from the generator's own fixture schemas
(`primary-key-arithmetic`, `relation-key-non-literal`,
`shared-key-ambiguous-arm`) and from the corpus schemas; the list is recorded in
`generator.core.test.ts`.
