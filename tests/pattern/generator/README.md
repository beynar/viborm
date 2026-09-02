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

`mutate(strategy, payload, schema, registry)` returns a mutant the schema must
refuse, labelled with its refusal class and, where the sentence is fixed, the
message:

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

A strategy returns `undefined` when the payload offers nothing to mutate.
