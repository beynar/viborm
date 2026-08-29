# Schema JSON Plan (JSON-defined schemas)

**Status:** RATIFIED 2026-08-22 (all four §7 questions answered by the
maintainer); implementation authorized
**Scope:** a JSON document format for VibORM schemas, `parseSchema`
producing a client-usable schema, and `serializeSchema` producing the
document from a coded schema. Type inference is deliberately absent — the
surface is for programmatic (AI-agent) use, and the format optimizes for
**being easy for an AI to generate** (maintainer directive, Q1).
**Method:** two scout surveys + one adversarial review; corrections carry
their finding IDs. Base: branch `by-client-extensions` (concurrent
extension work in the tree — this feature is strictly additive).

## 1. The one idea

**The parser is an interpreter over the existing public builders.** It reads
a JSON document and calls `s.model`, `s.string()`, `s.toOne(...)` — the same
factories a human calls — producing real `Model` instances. There is no
second schema representation, no alternate trust path, and nothing to keep
in sync: hydration, the relation-resolution gate, the registry, the query
engine, and migrations consume the parsed schema unchanged and emit their
existing diagnostics (R002/R009/R010/FK004/M003/…) for free.

This works because of two verified facts: the schema value has **no nominal
brand** — every discriminator is structural, so parser-built models ARE the
same classes; and **relation laziness is sound for a two-pass build** —
nothing invokes a target getter before the resolution gate, so getters
close over a registry that pass 1 populates:

```ts
const registry: Record<string, Model<any>> = {};
// pass 1: construct every model; relation targets are `() => registry[key]`
// pass 2: nothing — the gate settles targets after the registry is complete
```

The getter returns the registered object by identity (the gate requires
it). Parsing one document twice yields two independent graphs (fine);
reusing one parsed schema across clients is same-key idempotent (the
write-once naming contract). The parser NEVER interns models or relation
terminals across parses — write-once naming and the settleTarget once-cell
both forbid it.

```ts
import { parseSchema, serializeSchema } from "viborm/schema/json";

const schema = parseSchema(input);           // JSON string OR plain object
const db = createClient({ schema, driver }); // UntypedClient
await push({ schema, driver });              // migrations work unchanged
const doc = serializeSchema(schema);         // the reverse direction
```

Module: `src/schema/json/`, exported as `viborm/schema/json` (maintainer
naming, Q2). Distinct from `src/validation/json-schema/` (Draft-07
conversion of validation schemas), which keeps its name.

## 2. The document format

The format is the declaration-state algebra spelled as data, with model-key
strings where getters go. `version: 1` required; an unknown version is a
J-code refusal naming the supported set, and a document key never changes
meaning across versions — evolution adds keys (review m6).

```jsonc
{
  "version": 1,
  "enums": { "role": { "values": ["admin", "member"], "name": "user_role" } },
  "models": {
    "user": {
      "table": "users",
      "fields": {
        "id":    { "type": "string", "id": true, "generate": { "kind": "ulid", "prefix": "usr" } },
        "email": { "type": "string", "unique": true },
        "role":  { "type": "enum", "enum": "role", "default": "member" },
        "bio":   { "type": "string", "nullable": true },
        "posts": { "type": "toMany", "target": "post", "name": "PostAuthor" }
      },
      "indexes": [{ "fields": ["email"], "unique": true }],
      "omit": ["bio"]
    },
    "post": {
      "fields": {
        "id":       { "type": "string", "id": true, "generate": { "kind": "ulid" } },
        "authorId": { "type": "string" },
        "author":   { "type": "toOne", "target": "user", "name": "PostAuthor",
                      "fields": ["authorId"], "references": ["id"], "onDelete": "cascade" },
        "topic":    { "type": "toOne", "variants": { "thread": "thread", "review": "review" },
                      "values": { "thread": "topic.thread.v1", "review": "topic.review.v1" },
                      "optional": true }
      }
    },
    // Every model a reference names must be declared: the example is a whole
    // document, and the docs page's copy of it is executed by the test suite.
    "thread": { "fields": { "id": { "type": "string", "id": true } } },
    "review": { "fields": { "id": { "type": "string", "id": true } } }
  }
}
```

Coverage is the complete declaration surface — scout-1's field-by-field
checklist is the normative inventory: the 16 scalar/relation factories;
every chainable modifier as an explicit field (`id`, `unique`, `nullable`,
`array`, `default`, `column` for `.map()`, `generate` as
`{kind, prefix?, length?}`, `values`/`enum`, `dimension`,
`withoutTimezone`); `native` as `{db, type}` (the factory's argument, not a
modifier — review m1); model config (`table`, `omit`, `indexes` with
name/unique/type — **`where` refused in v1, see §5**, compound
`ids`/`uniques` as accumulating arrays with optional names); relations
exactly per the unified language: `target` string XOR `variants` map,
`name`, `fields`/`references`, `onDelete`/`onUpdate`, junction overrides
spelled `junction: {table?, source?, target?, onDelete?, onUpdate?}` (at
least one key — `{}` refused, matching `AtLeastOne`; the nesting avoids the
`target` key collision), variant `through` map, variant `optional`,
`values`.

Format rules, each forced by a review finding:

- **`id: true` means exactly what `.id()` means** (review C1 + maintainer
  Q3: no builder change — the implicit ULID on string ids is fine because
  callers can always supply an explicit id at create time). The serializer
  emits the `generate` the state actually holds (`{kind:"ulid"}` for
  string ids).
- **Enum identity is explicit** (review C2): a named enum def yields one
  DB type (`.name()`); a def or inline `"enum": ["a","b"]` without a name
  keeps today's per-column derived type. Instance sharing is irrelevant —
  the DB-type fact lives in `enumName` alone.
- **`values` is all-or-nothing** (review M1): when present it is exact
  over the variant keys; the serializer emits the full bag, or omits it
  iff every stored value equals its public key.
- **Tagged, recursive defaults for non-JSON domains** (review C3 — defaults
  BYPASS validation at parse time, so a wrong-typed default is a late
  failure the parser must pre-empt; AMENDED by external review findings 2
  and 5, see §9.5): a value from a domain JSON cannot spell takes a TAG, a
  one-key object naming the domain — `{"$bigint": "5"}`, `{"$bytes":
  "AQID"}`, `{"$date": "<iso>"}` — plus `{"$raw": <value>}` for a literal
  whose own shape collides with a tag. Tags are read at ANY DEPTH, by one
  recursive codec (`src/schema/json/default-codec.ts`), in both
  directions. A bare ISO string on a temporal field stays a STRING: the two
  are different declarations, and DDL emits them differently. The
  `$`-prefixed one-key object is a reserved namespace; an unknown one is
  refused rather than read as a literal. Anything else wrong-typed is a
  J-code refusal at parse.
- **`native.type` is a CLOSED PER-DIALECT CATALOG, not a grammar** (external
  review finding 1 in §9.5, re-opened as round-2 finding 1 in §9.6): the
  migration drivers emit it into DDL verbatim, and no grammar over SQL words
  can separate a multi-word type name from a constraint clause — `TEXT
  REFERENCES victims(id)`, `TEXT UNIQUE` and `TEXT CHECK(0)` are letters and
  spaces with an optional parenthesized group, exactly like `double
  precision`. So the admissible set is enumerated, per dialect, DERIVED at
  module load from the one owner that already lists native types: the
  shipped `PG`/`MYSQL`/`SQLITE` constant trees
  (`src/schema/json/native-catalog.ts`). A string leaf contributes its exact
  value; a function leaf is probe-called to learn its base name and the
  argument arities it publishes, which are then admitted with INTEGER
  arguments at those arities only. A value is matched against the catalog of
  its DECLARED `db` and nothing else; everything else is `J011`.
  `serializeSchema` applies the same rule, so the document never carries what
  parse refuses. A native type outside the catalog is therefore a
  CODED-SCHEMA capability: the TS surface is a trusted author and takes any
  `NativeType` it likes, and growing the catalog is additive format
  evolution — a new constant in the trees is a new catalog member with no
  document change.
- **An `enums` key is a reference, not a database name** (external review
  finding 4, §9.5): the key is a document-local identifier (`J005`); the
  database type name lives in `name` alone and may be anything the database
  allows. The serializer uses the name as the key when it already passes
  the identifier grammar, and derives `enum_1`, `enum_2` … by declaration
  order otherwise.
- **Modifier legality is probed against the one existing truth** (review
  M4): before applying a modifier the interpreter checks the scalar class
  actually has it (`typeof scalar[mod] === "function"`); a miss is a
  J-code naming the type and modifier. Blob's deliberate throws are
  re-thrown with the JSON path. No legality table — the class surface is
  the table.
- **Fixed modifier application order** (array → nullable → id/unique →
  generate → default → column), because three builder modifiers rebuild
  the base schema from current flags. `.schema()` is absent by design
  (§3); `attachFieldSchemas` applies it last for the same reason.
- **No derived fields in the format**: `disallowZero` (implied by
  `generate.kind === "increment"`), `optional`, `hasDefault` are not
  spellable (review M7).
- **Field order is a declaration fact**: DDL column order follows it, and
  the format binds it to JSON key order — stable under `JSON.parse`,
  destroyed by key-sorting producers; stated so agents know (review m7).
  `omit` is an array; canonical form sorts it (review m9).
- **Dialect caveat** (review m2): `native` has one slot per scalar, and
  decimal precision has no other spelling — a document pinning precision
  is dialect-tainted by construction. The format is dialect-neutral
  exactly as far as the builders are.
- **AI-generability rule** (maintainer Q1): every field is flat, explicit,
  and JSON-natural; no field's meaning depends on another field's presence
  except where the builders themselves couple them. If a format choice
  trades exactness against generation simplicity, simplicity wins as long
  as the parser can refuse loudly.

## 3. Refusals and their escape hatches

Exactly two function-valued surfaces exist:
1. **`.default(fn)`** — refused with a diagnostic naming the alternatives:
   the seven generator kinds (`uuid|ulid|nanoid|cuid|increment|now|
   updatedAt`, with `prefix`/`length` where the closures take them),
   literal defaults per §2's envelopes, or a database-side default via
   `native`.
2. **`.schema(standardSchema)`** — refused in the document; the escape
   hatch for hybrid human/agent codebases is
   `attachFieldSchemas(schema, { "user.email": z.string().email() })`,
   which calls the real `.schema()` builder per field (ratified for v1,
   Q4-adjacent recommendation accepted by silence — lands in U3, ~30
   lines). A future JSON-Schema→Standard-Schema adapter can lift the
   restriction; the format reserves the `"schema"` field name.

Model `.omit()`'s unknown-field refusal is type-level in code; the parser
re-implements it at runtime (omit names secrets — a typo'd entry must be
loud; the one genuinely unowned check). `.extends()` has no document
spelling: documents state complete shapes. **`indexes[].where` is refused
in v1** (maintainer Q6 = option B): see §5.

## 4. Serialization (`serializeSchema`)

Walks `model["~"].state` per model, **without mutating the schema**
(review M3): target keys come from an identity scan of the caller's own
record (invoking the getter directly), never from hydration — serializing
neither binds names write-once nor settles once-cells, so an unbound or
even topologically broken schema stays dumpable for diagnosis.

**One prerequisite src fix (RATIFIED, Q1):** generator `prefix`/`length`
are baked into default closures — declaration facts that escaped
declaration state. `ScalarState.autoGenerate` widens to
`{ kind, prefix?, length? }` (one owner, two consumers: default
materialization and this serializer). Keep the change minimal; if it
grows complex, stop and report (maintainer reserved judgment on
complexity).

Round-trip theorems, both gated:
- **T1 (semantic):** `parseSchema(serializeSchema(S))` and `S` produce
  identical resolved relation indexes and byte-identical migration
  snapshots — the DDL corpus is the oracle (its declaration cases get a
  round-trip leg).
- **T2 (idempotence — review M2 replaced the dropped `canonicalize`):**
  `serializeSchema(parseSchema(serializeSchema(parseSchema(J)))) ===
  serializeSchema(parseSchema(J))`. The canonical form IS
  `serializeSchema ∘ parseSchema` — one owner of every builder coupling.
  Agents diff canonical documents by running the pair once.
- **Refusal witnesses:** a schema carrying a function default, a custom
  `.schema()`, or an `indexes[].where` serializes with a loud error naming
  the field — never a silent drop.

## 5. Hostile input, errors, and the untyped client

- `parseSchema(input: string | object)`: the string path wraps
  `JSON.parse` failures into the J-code family; the object path treats the
  input as caller-controlled (accessors are executable — reads go through
  the existing `readCallerProperty`/`isPlainRecord`/`declaredKeys`
  helpers) (review m5).
- **Key validation runs BEFORE the first registry write** (review m3):
  model and field keys pass the existing `isValidSchemaIdentifier` owner
  at the parser boundary — same rule, first boundary with a JSON path —
  closing the `__proto__`-swallowing timing hole. Slots differ (review
  m4): model/field/variant keys and junction tokens are identifiers;
  relation `name` is a free-form non-empty pairing label; variant stored
  values follow their own grammar.
- **`indexes[].where` is REFUSED in v1** (maintainer ruling, Q6 option B):
  it is the declaration surface's one raw-SQL string, interpolated
  unescaped into DDL — an injection channel in machine-written documents.
  The parser refuses it with a J-code naming the reason; the serializer
  refuses schemas that carry it (witnessed). It returns only when a
  structured predicate form exists.
- **`native.type` is the OTHER string that reaches DDL** (external review
  finding 1, §9.5), and it was missed when `where` was ruled on: the three
  migration drivers emit `nativeType.type` as a column's type with no
  escaping. The gate is the FIRST and only owner of that channel: nothing
  downstream sanitizes it, and nothing else may, because sanitizing
  arbitrary SQL is not something a boundary can do. Round 1 answered with a
  grammar and round 2 proved a grammar cannot work (§9.6 finding 1); the
  answer is now a CLOSED CATALOG per dialect (`J011` both directions),
  which decides membership by NAME rather than by shape. The rule the
  round-2 witness states: no word a constraint clause is built from —
  `references`, `unique`, `check`, `primary`, `key`, `not`, `null`,
  `default`, `constraint`, `foreign`, `on`, `collate`, `generated`, `as`,
  `always`, `stored` — belongs to any dialect's catalog in any case, so
  there is nothing to append a clause with.
- **Every read of caller-supplied input goes through ONE guarded accessor**
  (external review finding 6, §9.5): document nodes, ARRAY ELEMENTS by
  index, recursive default values, and the options bag. What a throwing
  accessor threw survives as the refusal's cause, normalized through a
  stringifier that survives a throwing `toString`. The default walk — the
  one node whose depth the format does not bound — is cycle-checked in both
  directions, so a cyclic value is a J-code and never a `RangeError`.
- **Every record built from DATA keys is prototype-free** (external review
  findings 4 and 5, §9.5): `record[key] = value` sets a prototype and
  creates no own key when `key` is `__proto__`, losing the entry silently.
  `src/schema/record.ts` owns the construction and the own-property
  read; the document READER needs neither, because model, field, variant
  and enum-reference keys pass `isValidSchemaIdentifier` before anything is
  written. It sits beside `json/` rather than inside it because
  `s.model(...)`'s own classified member maps (`model/helper.ts`) are built
  from shape keys and have the same exposure.
- The parser validates DOCUMENT SHAPE only (exact keys per node, version,
  enum-ref and target-key existence, §2's envelopes); everything semantic
  stays with the factories and the resolution gate, re-thrown with the
  JSON path prepended. One guard per invariant.
- **The `validate` option (maintainer request 2026-08-26, §9.4).** Both
  entry points take an options object — `parseSchema(input, options?)`,
  `serializeSchema(schema, options?)` — with one key, `{ validate?:
  boolean }`, defaulting to `false`. The options bag is read at the CALL
  boundary with the same `isPlainRecord`/`declaredKeys`/guarded-accessor
  discipline the document gets, under pointers rooted at `/options` (a
  segment no document node has): an unknown key is `J003`, a non-boolean
  `validate` or a non-record bag is `J004`. At the TYPE level both
  signatures take `ExactSchemaJsonOptions<Options>` — the house structural
  exactness pattern — so a typo is refused whether or not the bag is a
  fresh literal (external review finding 9, §9.5). **Ownership rule:** `validate: true`
  INVOKES `validateSchemaOrThrow` — the existing owner, the whole rule
  list, exactly what `push` and the CLI run — preceded by
  `hydrateSchemaNames`, the same two ordered phases every other boundary
  runs. It never re-implements, filters or reorders a rule, and it never
  translates a `SchemaValidationError` into a J-code: **the `J0xx` family
  describes the ARTIFACT's shape and nothing else; a graph is refused in
  the graph's own `M0xx`/`R0xx`/`P0xx` vocabulary.** Placement differs by
  direction, and each is a contract:
  - `parseSchema`: AFTER interpretation, on the constructed schema. This
    hydrates and write-once-binds the models under the DOCUMENT's keys —
    idempotent for the `createClient` that follows with the same record.
  - `serializeSchema`: BEFORE serialization (garbage in, refuse loudly).
    **This deliberately gives up §4's non-mutating guarantee**: an
    opted-in call binds the passed record's keys and settles its relation
    targets, exactly as `createClient` would. The default keeps the
    guarantee, and keeps a broken schema dumpable for diagnosis; the M3
    witnesses pin the default and are untouched.
- **Aggregation:** the parser collects all document issues, then throws
  one `ValidationError` (V4002, source `{kind: "schema-builder", builder:
  "schema-json"}`) with JSON-pointer paths. New `J0xx` code family. "All"
  means all (external review finding 8, §9.5): an array reader reports every
  bad element rather than the first, and a field whose `type` names nothing
  still reports the sibling keys NO arm declares — the arm being undecided
  is exactly why the union is the key set used there.
- **The untyped client is honest, not accidental** (measured):
  `Record<string, Model<any>>` yields stringly model access, the exact
  closed operation set, `any` args/results, and no type-level crashes.
  `type UntypedClient` is the named surface, plus one `tests/types` pin
  proving the degradation and that the guards stay inert.

## 6. What this is for (recorded intent)

The agent loop: emit JSON → `parseSchema` → `createClient` → `push` →
query — no TypeScript authoring, full validation and migration fidelity.
The document is the project's first builder-level neutral schema
description: the natural seed for a future `db pull` and for schema-diff
tooling. Client config (`omit`, cache, extensions) is
deliberately NOT in the document — it describes the schema, not a client.

## 7. Maintainer rulings (2026-08-22)

1. `autoGenerate` widening: **APPROVED**, with a simplicity watch — the
   JSON is for an AI to generate; if the widening or its format surface
   grows complex, stop and report.
2. Naming: **`viborm/schema/json`**, **`parseSchema`**,
   **`serializeSchema`** (maintainer's own spelling; no collisions in
   src/).
3. Generator-free string ids: **NOT NEEDED** — the auto-generator is only
   a default; explicit ids at create time already override it. No builder
   change; `id: true` mirrors `.id()` exactly.
4. `indexes[].where`: **REFUSED in v1** (option B).

## 8. Implementation shape (authorized)

One package, three units, each with falsifiers. The tree carries ~234
dirty files of concurrent extension work: every edit is ADDITIVE except
the named integration points (`package.json` exports, the `autoGenerate`
state widening in the scalar layer, the docs nav) — never revert or
reformat concurrent work; check the process table before any vitest/tsc
run (another session may be testing).

- **U1 format + parser** (`src/schema/json/`): the document type (from
  scout-1's checklist), the interpreter, J-codes, hostile-input corpus
  (prototype pollution incl. the pre-registry key timing, wrong-typed
  nodes and defaults, unknown keys beside real ones, dangling refs,
  partial `values`, empty `junction`, `where` refusal, unknown version),
  and the acceptance corpus: every code fence under
  `docs/content/docs/schema/**` not in the refusal set transliterated to
  a document and proven to produce the same resolved index as its coded
  twin, plus one refusal witness per excluded fence, both counts recorded
  (review M5).
- **U2 serializer + round-trip:** the `autoGenerate` widening, the
  non-mutating walker, T1 over the DDL corpus, T2 idempotence, refusal
  witnesses, the Date/bigint/bytes default normalizations.
- **U3 client + docs:** `UntypedClient` + type pins, `attachFieldSchemas`,
  the `viborm/schema/json` export wired through `test:package`, an
  agent-oriented docs page.
Layer placement: `src/schema/json/` inside the schema layer's 100%
coverage globs (verify which coverage project owns it and satisfy the
gate); tests in `tests/unit/schema-json/` + type pins in `tests/types/`.
\n

## 9. As landed (2026-08-26)

Implemented as specified, with three corrections the implementation MEASURED and
this plan predicted wrongly. They are recorded here because the plan is the
architecture record, not a task log.

1. **§5's untyped-client prediction was half wrong.** Arguments and results do
   NOT degrade to `any`. Measured through the public API in
   `tests/types/schema-json/untyped-client.core.types.ts`: model access is
   stringly AND possibly-undefined (`noUncheckedIndexedAccess` reaches the index
   signature a loose schema produces), clause keys are still REFUSED because a
   model with no known fields publishes no field clauses,
   `NoExtraOperationKeys` still bites, and a result is an empty row whose fields
   cannot be read. The load-bearing half held: nothing answers `never` and
   nothing crashes tsc.
2. **The `enums` reference is owned by the interpreter, not the parser.** §5
   lists "enum-ref … existence" with document shape, but the parser and the
   interpreter would then both refuse a dangling reference. The interpreter is
   the first boundary that needs the definition, so it owns the refusal alone.
   Target-key existence and `omit` stay with the parser, where aggregating
   across many fields is the point.
3. **Two format types became unions rather than optional-key bags.** A relation
   node is `ModelTargetDocument | VariantTargetDocument` and a scalar node is
   `ValueFieldDocument | EnumFieldDocument`, so "both target domains",
   "neither", and "`enum` on a non-enum field" are unrepresentable in the
   published type as well as refused at parse. Same rule §2 already stated; the
   type now states it too.

`ScalarState.autoGenerate` widened as ratified in §7.1 —
`{ kind, prefix?, length? }`, written by the eight generator modifiers and read
by DDL default emission, the increment checks in the write engine, and this
serializer.

### 9.4 Maintainer request — a `validate` option (2026-08-26)

Requested after landing: "add a validate boolean to schema parsing/serializing."
Adjudicated and implemented as §5's new bullet spells it. The two decisions
worth recording, because both were live:

1. **Who validates.** The option is a second CALLER of `validateSchemaOrThrow`,
   never a second copy of it and never a filtered subset. A `validate` that ran
   its own rule list would be a second definition of what a valid schema is —
   the failure this whole module exists to avoid, since a parsed schema's only
   claim is that it IS an ordinary schema. Consequently the error a caller sees
   is a `SchemaValidationError`, not a `ValidationError`: the `J0xx` codes stay
   a vocabulary for the document, and the graph keeps its own.
2. **What it costs the serializer.** §4's non-mutation is a real guarantee with
   a real user — dumping a schema you do not own, for diagnosis, without
   consuming it. Validating cannot preserve it: the validator hydrates and
   settles by construction. Rather than weaken the validator or fork it, the
   option is off by default and its cost is stated at every surface (JSDoc,
   docs page, here). `serializeSchema(schema)` is still non-mutating;
   `serializeSchema(schema, { validate: true })` is not, and says so.

Landed in `src/schema/json/validate.ts` (the option's shape, its hostile
reading, and the two-phase call), wired into `index.ts` and `serialize.ts`.
Witnessed by 15 tests across the existing `tests/unit/schema-json/` suites, of
which 5 go red when `validateGraph` is made a no-op and 3 when the unknown-key
refusal is dropped.

### 9.5 External adversarial review — ten findings, all fixed (2026-08-26)

An external review probed the landed feature and found ten defects. **Every one
reproduced**, each as an executable probe before anything was changed, and each
probe became the regression pin for its fix. What follows is the architecture
record: what the review proved, and what the format now says because of it.

Method note, because it decided several of the answers below: the probe came
first, red. Three findings (2, 4, 5) were only visible from OUTSIDE the module —
in DDL, or in a document the module's own parser then rejected — which is why a
suite that was 233-green and 100 %-covered had not caught them. Coverage
measures which lines ran, not which round trips hold.

1. **`native.type` was a raw SQL channel (P0).** `{"native":{"type":"TEXT);
   DROP TABLE victims; --"}}` produced `"id" TEXT); DROP TABLE victims; --
   NOT NULL` in SQLite DDL. The v1 ruling on `indexes[].where` (§7.4) had named
   the declaration surface's "one raw-SQL string" — there were two. Same answer,
   same shape: a grammar gate at the untrusted boundary (`J011`), the identical
   refusal in the serializer, and no sanitizing anywhere. §2 and §5 carry the
   rule; the grammar is proven against every value the shipped `PG`/`MYSQL`/
   `SQLITE` constant trees can produce.
2. **A `Date` default changed the DATABASE after a round trip.** `s.dateTime()
   .default(new Date(...))` emitted `"at" TEXT NOT NULL`; the round trip emitted
   `"at" TEXT NOT NULL DEFAULT '...'`, because the serializer flattened the
   `Date` to its ISO string and `getDefaultExpression` treats a string as a SQL
   default and an object as an application one. That falsifies T1 outright. The
   distinction is now a TAG, and the witness lives in the migration layer where
   the difference is observable.
3. **A caller's function default could become a generator.** `.uuid()
   .default(() => "fixed")` serialized as `generate: {kind: "uuid"}` and the
   function vanished; the round trip produced random UUIDs. `autoGenerate !==
   undefined` was never evidence about the closure standing in `default`,
   because a generator writes both facts and `.default(fn)` replaces only one.
   Closure IDENTITY decides now, recorded by a `WeakSet` beside `AutoGenerate`
   in `scalars/common.ts` and written by the eight generator modifiers — one
   owner, next to the declaration it belongs to.
4. **A database enum name was used as a document reference key.** `.name(
   "status-v2")` wrote a document its own parser refused with `J005`; `.name(
   "__proto__")` crashed serialization with a raw `TypeError`, because the
   `enums` map resolved the inherited prototype. Two different things had one
   spelling. §2 splits them.
5. **Default serialization was shallow, aliased and not JSON-safe.** A
   `bigint[]` default produced a document `JSON.stringify` throws on; mutating a
   serialized object default mutated the scalar's declaration state; an own
   `__proto__` key in a parsed default silently became `{}`. One recursive,
   detached, cycle-aware codec in its own module replaces the positional
   envelopes — findings 2 and 5 are one design, which is why they were fixed
   together.
6. **The hostile boundary leaked raw exceptions.** Five probes: a throwing
   accessor on the options bag, a throwing array-index accessor, a cyclic
   default (`RangeError`), a lost `originalCause`, and a thrown value whose own
   `toString` threw. Every read now goes through the one guarded accessor, the
   cause survives normalized, and the unbounded walk is cycle-checked.
7. **`pnpm test:layer:schema-json` was red.** 233 runtime tests passed, then the
   type half exited 1: `tests/types/schema-json/tsconfig.json` did not exist.
   Nothing had ever run the pnpm script. It is now in the verification ladder.
8. **Aggregation stopped early in two places.** An array reader reported only
   its first bad element; a field with an unknown `type` reported nothing else.
   Both now report everything, which is what "collects all document issues"
   claimed.
9. **Options were exact only for fresh literals.** A non-fresh `{validate: true,
   validat: true}` compiled. Both signatures take the house structural
   exactness generic now, with fresh AND non-fresh type pins.
10. **The primary documentation example could not parse.** It named variant
    targets `thread` and `review` and declared neither (`J006`) — and, once
    that was fixed, failed `R010` as well, because one endpoint of its
    `PostAuthor` pair carried the name and the other did not. Both are fixed,
    and every ```json fence in the schema docs is now parsed, canonicalized and
    validated by the docs corpus, so a documented document cannot rot again.

New modules: `src/schema/json/default-codec.ts` (the codec, both directions) and
`src/schema/record.ts` (records keyed by data, shared with `model/helper.ts`).
New code: `J011`. The
format is still **v1** — nothing has shipped, so the amended default spellings
and enum ref keys are not a version bump; they are what v1 is.

### 9.6 External adversarial review, round 2 — seven findings, all fixed (2026-08-27)

The same reviewer re-probed the hardened feature: four merge blockers and three
contract gaps. **All seven reproduced**, and each reviewer probe is now a
regression pin. The theme of the round is that a boundary's job is to decide
MEMBERSHIP, not to recognize shapes, and that "guarded read" has to mean every
way caller code runs — not only property access.

1. **A grammar cannot gate `native.type` (P0).** The round-1 gate refused
   quotes, semicolons and comments, and still admitted `TEXT REFERENCES
   victims(id)`, `TEXT UNIQUE` and `TEXT CHECK(0)` — each of which appends a
   CONSTRAINT to a column in real DDL. The reviewer is right that no regex can
   fix this: a constraint clause and a multi-word type name (`double
   precision`, `timestamp with time zone`) are the same shape. The gate is now a
   closed per-dialect CATALOG derived from the shipped constant trees (§2, §5,
   `native-catalog.ts`). What makes it an answer rather than a patch over three
   spellings: no constraint WORD is a catalog member in any dialect, so there is
   nothing to build a clause out of — not `TEXT UNIQUE`, and not bare `UNIQUE`
   either. The enumerated proof is retargeted rather than dropped: all **115**
   values the three trees produce (**91** distinct; pg 45, mysql 41, sqlite 5)
   parse, each against its own dialect's catalog. The 8 remaining strings
   round 1 counted (123 = 115 + 8) were `varchar(undefined)`-style artifacts of
   probe-calling a required-argument function with none — values no constant
   yields, and the catalog is witnessed to refuse them, so the derivation cannot
   admit its own probing artifacts.
2. **A joined string compared enum value sets.** `["a b", "c"]` and `["a", "b
   c"]` both join to `"a b c"`, so a second enum silently inherited the first's
   values on round trip. Compared element for element now.
3. **Prototype inspection and key enumeration are executable input too.** Round 1
   guarded property ACCESS and stopped there: `version: 1n` escaped as a raw
   `TypeError` from `JSON.stringify`, and a proxy whose `getPrototypeOf` or
   `ownKeys` trap throws escaped through the shared predicates. The JSON
   boundary now has a TOTAL guarded inspection owner beside `member` in
   `issues.ts` — `inspectPlainRecord`, `inspectKeys` and `renderValue` — and
   every json-side call site goes through it. The predicates in
   `relation/terminal.ts` stay the RULE owners and are unchanged: the wrappers
   own only the hostile-trap guarding and the J-code conversion, which is
   boundary adaptation, not a second copy of the rule.
4. **The outbound codec read hostile values raw.** `s.json().default(obj)` with
   a throwing getter leaked the thrown value out of `serializeSchema`. Encoding
   now reads elements and members through the same guarded owner as decoding,
   at `J009` — the serializer's own vocabulary — with the cause preserved.
5. **The document aliased scalar state.** `document…native.type = "INTEGER"`
   changed the scalar. `{db, type}` is copied now, and the invariant is pinned
   as a whole rather than at one site: a witness vandalizes every container in a
   document of the complete surface and proves the schema still serializes
   identically. The sweep found no other state object escaping by reference —
   index fields, compound fields, `omit`, `generate`, enum values, foreign keys,
   junctions and variant bags were already rebuilt or copied.
6. **Malformed default tags were fail-fast.** Unknown `$`-tags threw during
   interpretation, after issue collection had finished, so two bad tags reported
   one issue. The tag ENVELOPE is now checked in the accumulating walk
   (`readDefaultValue`), where every other shape fact is decided; decoding keeps
   only payload well-formedness for a KNOWN tag. The decode-time unknown-tag
   throw became unreachable and was DELETED rather than left as a backstop —
   one guard per invariant.
7. **An own `default: undefined` silently meant absence.** Object input
   describes exactly what JSON text can, and JSON text cannot spell `undefined`,
   so an own key whose value is `undefined` is refused (`J004`) with a message
   telling the producer to omit the key. It is implemented once, in the one
   key walk every node passes through, not per key. The OPTIONS bag is the
   deliberate exception and keeps tolerating `{validate: undefined}`: the TS
   type admits it through optional-property syntax, and refusing what the type
   allows would fight the language. Both halves of that split are witnessed.

No new J-code: round 2 is entirely a narrowing of existing refusals. The format
is still **v1** for the same reason as §9.5 — nothing has shipped.
