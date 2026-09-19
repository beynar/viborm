# Validation layer: fewer independent truths

Plan for the validation library (`src/validation/primitives`, `src/validation/
scalars`, `src/validation/json-schema`, the kind-owned codecs), written to the
standard in [`ELEGANCE.md`](../../ELEGANCE.md). Source lines and the number of
independent decisions are the objectives; bundle bytes are measured separately
and not claimed. The operation schemas (`model/`, `relations/`) are out of
scope until Raptor 3 freezes what it consumes.

Baseline is the WS1 tree (VibORM's own `Decimal`, in-house SHA3) plus WS2's
family builders. Counted production lines, excluding tests:

| Group | Files | Lines |
|---|---|---|
| Scalar primitives (string, number, boolean, bigint, date, blob, vector, json, enum, literal, point) | 11 | 889 |
| Record family (object, record, raw-record, from-object, omit) | 5 | 1,417 |
| Combinators + `helpers.ts` + `v.ts` | 13 | 1,899 |
| Decimal (value, codec, primitive, family, descriptor, class) | 6 | 2,853 |
| Temporal (iso, values, physical codec, three classes, three families) | 9 | ~1,200 |
| Geo (area codec, point codec, values, family, class) | 5 | 944 |
| Identifiers (formats, codec, binary shapes, sha3, domain, generators) | 6 | 1,759 |
| Operand | 1 | 483 |
| Families (`validation/scalars`, after WS2) | 12 | ~2,750 |
| JSON-Schema converter | 4 | 916 |
| **Validation perimeter** | | **≈ 14,000**, 33% comment lines in the primitives |

Extension-cost witness, measured: adding the identifier kind (Stage D) touched
62 source files across five layers. That is the number this plan exists to
lower.

## 1. What the layer must express

Required behaviour, from which everything else is derived:

1. **Admission.** A public value for a declared scalar, in each operation
   position (create, update, filter, unique selector, order, cursor), becomes
   the trusted private value or a list of issues with paths. Standard Schema V1
   is the outward shape.
2. **Kinds.** Fourteen scalar kinds, each with: a value grammar, options
   (nullable, optional, array, default, transform, custom `.schema()`), and the
   state-derived facts that narrow it (decimal descriptor, identifier domain,
   enum values, timezone).
3. **Families.** The operation-position shapes a kind offers (comparison,
   list, update bags) and their TypeScript types.
4. **Codecs.** For the kinds whose stored form differs from the public one
   (decimal, temporal, geo, identifiers): the logical ↔ physical conversions
   the engine and adapters consume, and the DDL and provider-limit facts the
   migrations consume.
5. **Projections.** JSON Schema of any admission schema, and the inferred
   input/output TypeScript types.
6. **Hostile-input posture.** Query arguments are untrusted; every public
   record and array crosses one reflection-safe walker. Schema declarations are
   the developer's own source code and are trusted.

Point 6 is the one that most of the deletions rest on. Today the layer treats
`s.decimal({ precision: 10, scale: 2 })` like a request body: 385 lines refuse
getters, proxies and prototype keys on an object the developer typed into a
schema file. There is no boundary there. Principle 5: validate where untrusted
input becomes a domain value, and trust below it.

## 2. Facts, views, observations

| | Owner |
|---|---|
| **Declared facts** | `ScalarState`: kind, nullable, array, default, transform, custom schema, descriptor, identifier domain, enum values, timezone. Written once by the scalar class; never re-parsed. |
| **Derived views** | admission schemas per position (from state, via the kind's row and the family table); JSON Schema (from the schema's own `type` and options); TypeScript types (from the schema); the physical representation per dialect (from the kind plus the adapter's promise). |
| **Observations** | query arguments at admission; provider row values at decode. The only two trust boundaries the layer owns. |

Anything that today holds a second copy of a declared fact, or re-derives a
view from the public vocabulary instead of from the state, is a candidate for
deletion.

## 3. One authority per meaning

| Meaning | Authority after this plan | Replaces |
|---|---|---|
| "A scalar primitive is a guard plus a message plus the option wrappers" | one factory in `core/primitive.ts`; each kind is a row (guard, message) | eleven files spelling the same wrapper |
| "Walk a record's keys, one validator per key, a policy for unknown keys" | one walker in `core/record.ts` with a key policy (`known`, `rest`, `omit`, `raw`) | five files |
| "nullable / optional / array / default / transform / custom schema" | the combinators, composed by `buildValidator` | `buildValidator` re-implementing each one |
| "A decimal is exact" | the `Decimal` value type: constructor is admission and canonical form; `fits(p, s)`, `toCoefficient(s)`, `fromCoefficient(n, s)` are methods | three `canonicalize*` functions, `toDecimal`, 180 lines of string coefficient arithmetic, `describeDescriptorRefusal`, `descriptor.ts` |
| "date, time and datetime are one temporal value at three precisions" | one temporal kind with a precision parameter | three primitives, three classes, three families |
| "A geographic record is an ordinary record" | `v.object` / `v.array` with range guards | `snapshotGeoRecord`, `readExactGeoRecord`, `readGeoVariantRecord`, `prefixGeoFailure` and the bespoke ring walkers |
| "JSON Schema follows the schema's type" | one table keyed by primitive `type` | one converter arm per primitive |
| "The `v` namespace is the primitives" | re-exports | `v.ts` re-declaring every primitive's types |

## 4. What disappears, and the invariant that makes it unnecessary

| Deleted | Lines | Invariant |
|---|---|---|
| `descriptor.ts` hostile parsing, `normalizeDecimalDefault` | ~480 | a `ScalarState` is constructed only by VibORM's factories from developer arguments; no untrusted boundary exists there |
| decimal string arithmetic and the three canonicalizers | ~400 | the value type is exact by construction; a `Decimal` VibORM built is trusted |
| `number` input to decimals (decision D1) | ~40 + docs | a field admits only values that already name an exact decimal |
| geo record readers and issue-path prefixing | ~250 | every public record crosses the one walker, which already owns the hostile posture |
| ring intersection and open-ring pre-checks (decision D2) | ~120 | polygon validity is the database's execution fact (PostGIS/MySQL raise; SQLite prefilters by bounds); VibORM owns the shape, not the geometry |
| per-kind primitive wrappers | ~640 | one factory; a kind's unique content is its guard and message |
| record-family duplicates | ~800 | one walker; the variants are a key policy |
| `buildValidator`'s modifier re-implementations, `v.ts` type re-declarations | ~800 | one rule per modifier; the namespace is a projection of the primitives, not a second declaration |
| second and third temporal spellings | ~400 | one kind, one precision parameter |
| operand per-operator spellings | ~150 | one table |
| JSON-Schema per-primitive arms | ~300 | one table keyed by `type` |
| comments on the survivors, 33% → ~15% | ~1,300 | prose that restates the plan documents is not a second owner of anything |
| **Total** | **≈ 5,700** of ≈ 14,000 | |

Not deleted, and why:

- **The lazy/intern layer.** It has a lifetime story (per process, keyed by the
  state bits that change the schema) and a measured reason (cold-start cost on
  Workers). WS2 kept it and named the invariant; this plan does not reopen it.
- **The identifier formats and SHA3.** Six formats are six irreducible facts;
  the differential proofs are their witnesses. Only the comment share moves.
- **Polygon holes.** `adapters/shared/geo-point.ts` emits them as rings, so
  they are consumed. They become `v.array(ring)`, not a deletion.
- **The `.jsonSchema` projection.** Public through `schema["~standard"]`; it
  keeps its getter and loses its per-arm converter.
- **Provider decimal limits and DDL spelling.** Three facts about three
  databases; a table, not a deletion.

## 5. What must remain intact

- Every issue message and path that a test or document pins, and the order of
  issues (the walker returns the first failing entry in insertion order, which
  `toJsonSchema` and the object validator both observe).
- Standard Schema output identity; the custom `.schema()` seeing the real
  public value; the ordering base → custom schema → descriptor for decimals.
- Default materialization timing: defaults are produced inside the create
  schema and cross the same validator as explicit input.
- Interning identity: two fields with the same state bits share one validator;
  two with different identifier domains never do.
- The public inferred types of every schema, proven by mutual-assignability
  probes before and after, not by reading.
- The hot path: one closure per schema, frozen error constants, one `ok()`
  allocation per step. Every factory and table in this plan runs at
  construction, once.

## 6. Decisions for the owner

- **D1** Decimal admission becomes `Decimal | string`; the class constructor
  takes `string | Decimal | bigint`. A public narrowing, pre-1.0. It deletes the
  `String(number)` shortest-spelling rule and the documented `0.1 + 0.2` case.
- **D2** Geo polygons drop the ring-intersection and open-ring pre-checks. A
  malformed polygon becomes a database error instead of a VibORM validation
  error. Holes stay.
- **D3** Optional and in the schema layer, not this one: the ten scalar
  classes (1,870 lines) share seven modifier bodies; a base class with per-kind
  subclasses keeping their own State generic saves about 900 more without
  touching the public types. Separate workstream if wanted.

## 7. Target shape

```
src/validation/
  core/
    schema.ts        buildSchema, ok/fail, results, Standard Schema bridge
    primitive.ts     the one scalar primitive factory + the kind rows
    record.ts        the one keyed walker + key policies
    combinators.ts   nullable, optional, array, single-or-array, shorthand, union, pipe, transform, lazy, refused
    operand.ts       one table
    v.ts             re-exports
  kinds/
    decimal/         value.ts (is the codec)  storage.ts (limits, DDL, coefficient/list containers)
    temporal/        iso.ts  codec.ts  (one kind, precision parameter)
    geo/             values.ts  codec.ts  (ordinary validators + the bounds prefilter helper)
    identifier/      formats.ts  sha3.ts  codec.ts  domain.ts
  families.ts        WS2's builders plus every kind's row, including string, enum, json, decimal
  json-schema/       one table
  model/ relations/  unchanged
```

A kind without a codec is a row in `primitive.ts` and a row in `families.ts`.
A kind with one is a folder. Nothing about a kind lives outside those two
places within this layer.

## 8. Witnesses

- **Shape census**, byte-identical: WS2's lock-free harness runs every
  `.core.test.ts` under `tests/unit/scalars`, `tests/unit/validation` and
  `tests/unit/operation-schemas` without vitest; 1,218 assertions at the WS2
  baseline. Any drift is a finding, not a fixture update.
- **Type probes**: for every public schema type, old and new mutually
  assignable, compiled with a direct `tsc` on the probe file.
- **Falsification per deletion**: for each removed guard, name the input that
  reached it and show the surviving owner refuses the same input with the same
  message and path.
- **Extension witness**: after the plan, re-derive one existing kind through
  the factory and the table as if it were new (`vector` is the smallest) and
  count the files and independent rules it touches. The claim is "one folder or
  two rows"; the number replaces the 62 files Stage D needed.
- **Reachability after removed refusals**: the geo pre-checks and the decimal
  number path each open inputs that previously stopped early. Their new
  outcome (a database error; a validation refusal) is asserted, including the
  empty and list cases.

## 9. Sequencing

Non-overlapping by file. Forks from a branch carrying WS1 and WS2.

| # | Workstream | Files | Depends on |
|---|---|---|---|
| V1 | core: primitive factory, record walker, combinators compose `buildValidator`, `v` re-exports, operand table | `core/**`, `primitives/{string,number,...,object,record,...,helpers,v,operand}.ts` | — |
| V2 | kinds: decimal (D1), temporal, geo (D2), identifiers comments | `kinds/**`, `schema/scalars/decimal/descriptor.ts`, the datetime and point families | D1, D2 |
| V3 | families rows for string, enum, json, decimal; JSON-Schema table | `families.ts`, `json-schema/**` | V1 (uses the factory) |
| V4 | comments pass on survivors | everything above | V1–V3 |

V1 and V2 run in parallel. Nothing waits for Raptor 3. Under the no-lock rule
the round is implementation plus static review; the test round follows with
the runner lists each workstream leaves behind.

## 10. Measurement and reporting

Count the production perimeter before and after per group (table in §0),
separately from tests and evidence; state moved lines as moved, not saved.
Report for each consolidation: the authority that replaced several, the special
case that became ordinary, or the mechanism removed without reappearing. Report
the extension witness's file count. Bundle bytes, if measured, are reported
under their own heading and never inferred from lines.
