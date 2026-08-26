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
        "posts": { "type": "toMany", "target": "post" }
      },
      "indexes": [{ "fields": ["email"], "unique": true }],
      "omit": ["passwordHash"]
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
    }
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
- **Typed default envelopes for non-JSON domains** (review C3 — defaults
  BYPASS validation at parse time, so a wrong-typed default is a late
  failure the parser must pre-empt): `bigint` defaults are decimal strings
  (→ `BigInt`), `blob` defaults are base64 strings (→ bytes), temporal
  defaults are ISO strings (already the bases' input domain; the
  serializer normalizes a `Date`-valued default to its ISO string).
  Anything else wrong-typed is a J-code refusal at parse.
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
- The parser validates DOCUMENT SHAPE only (exact keys per node, version,
  enum-ref and target-key existence, §2's envelopes); everything semantic
  stays with the factories and the resolution gate, re-thrown with the
  JSON path prepended. One guard per invariant.
- **Aggregation:** the parser collects all document issues, then throws
  one `ValidationError` (V4002, source `{kind: "schema-builder", builder:
  "schema-json"}`) with JSON-pointer paths. New `J0xx` code family.
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
tooling. Client config (`omit`, `decimal`, cache, extensions) is
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
