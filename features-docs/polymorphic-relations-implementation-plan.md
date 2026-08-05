# Polymorphic Relations — Implementation Plan

> **Design:** [`polymorphic-relations.md`](./polymorphic-relations.md) (rev 2, 2026-08-03) is normative for
> semantics; this plan is normative for build order, units of work, and per-phase validation.
> Section references (`§`, `Phase N`) point into the design doc.

**Plan date:** 2026-08-03 · **Status:** proposed, not started

---

## 0. Ground Rules

1. **Build order is dependency order.** Y0 gates everything; Y5 (writes) depends on Y1+Y2; Y7 depends on Y4+Y5. Phases within the same tier note when they can run in parallel.
2. **Surgical validation only, per phase.** Each phase lists the exact commands that prove it. Do **not** run the full suite (`pnpm test`) until Y9 — it is the closing gate, not the inner loop. `pnpm test:gates` runs **only** in phases that touch `src/query-engine-v2/` (Y5) — running it elsewhere proves nothing.
3. **`pnpm test:types` (`tsc --noEmit`) is the typing check** and runs in every phase that touches `.ts` types. It is fast and total; there is no partial tsc.
4. **Docker legs (pg 5434 serial, mysql 3307) run only in Y9** — plus once in Y6 if `tests/migrations/ddl-drivers.test.ts` turns out to need a live engine. Local behavioral coverage in inner phases uses pglite / sqlite3 / libsql (`pnpm test:drivers:local`), which need no containers. In a fresh worktree, run `npx prebuild-install` in the repo before any better-sqlite3-backed test.
5. **Validation-layer import discipline:** inside anything transitively imported by the builder, runtime `v` must be imported from `@validation/primitives/v`, **never** the `@validation` barrel — Biome's export sorting turns the barrel into a cycle. The new `discriminated-union.ts` primitive (Y2) is exactly such a file.
6. **New tests live next to their layer's existing tests** and follow the naming already there (`*-behavior.ts` + `*.test.ts` pairs in `tests/query-engine-v2/`, plan/snapshot tests in `tests/query-engine/`, compile-probe tests in `tests/client/`).

---

## Y0 — Typing Spike (hard gate; ~1 day)

**Goal:** prove the discriminated unions survive `getter: any` + phantom `T` (design: *Typing Constraint* callout) **before any other work exists**.

**Unit of work**

| File | Action | Content |
|---|---|---|
| `src/schema/relation/polymorphic.ts` | CREATE | Minimal `PolymorphicRelation<T extends PolymorphicModelsMap>` — state `{ type: "polymorphic", getter: any, optional }`, phantom `T` on the class, `.optional()` chainable. No validation wiring yet. |
| `src/schema/relation/polymorphic-types.ts` | CREATE | `PolymorphicModelsMap`, `PolymorphicResult<T>`, `PolymorphicKeys<T>`, connect/create variant types (design: *Type Definitions*, with the rev-2 `{ type, where }` connect shape) |
| `src/schema/index.ts` | MODIFY | Export `s.polymorphic()` |
| `tests/schema/polymorphic-typing-spike.test.ts` | CREATE | Compile-time probes (pattern: `tests/client/contextual-typing-gate.test.ts`) |

**The probes that decide the phase** — all against *mutually-recursive* consts (`comment` ↔ `post` ↔ `video`, the collapse-triggering shape):

1. Any-collapse witness: a scalar on `post` reached *through* the schema does not widen to `any` after `commentable` is added (assert with a `Expect<Equal<...>>`-style check, as the existing gate test does).
2. `PolymorphicResult<T>` resolves to the 3-variant union with literal `type` keys.
3. `@ts-expect-error`: a typo'd discriminator (`type: "pots"`) in the connect variant fails to compile.
4. Selective-include narrowing: `{ post: { include: ... } }` narrows the `data` type per variant.

**Validation (surgical):**

```bash
pnpm test:types
```
```bash
pnpm vitest run tests/schema/polymorphic-typing-spike.test.ts
```

**Exit / kill criterion:** all four probes green → proceed. Probe 1 fails (any-collapse) → **stop the feature** and redesign the carrier type; nothing downstream is worth building.

---

## Y1 — Schema Layer: Registration + Rules (parallel-safe with Y0 finishing)

**Goal:** models know their polymorphic relations; the schema validator enforces P001–P010 (design: *Schema Validation Rules*, rev 2).

**Unit of work**

| File | Action | Content |
|---|---|---|
| `src/schema/model/model.ts` | MODIFY | `polymorphicRelations` on `ModelState`; wired in `s.model()` field extraction |
| `src/schema/model/helper.ts` | MODIFY | `extractPolymorphicFields()` |
| `src/schema/validation/rules/relation.ts` | MODIFY | P001–P007 as specced **plus** P008 (shadow-column collision, error), P009 (single-column PK), P010 (duplicate inverse); P005 uses **exact registered-name matching** (no case folding); P002 at **DDL granularity** (via `MigrationDriver.mapScalarType`); CM004 updated per design |
| `src/schema/validation/rules/index.ts`, `src/schema/validation/index.ts` | MODIFY | Export `polymorphicRules` |
| `src/schema/validation/types.ts` | MODIFY | `polymorphicTargets` on `ValidationContext` |
| `tests/schema-validation/validate.test.ts` | MODIFY | One failing-fixture case per rule P001–P010 + one CM004 non-regression (manual `*_type`/`*_id` still warns; `s.polymorphic()` fields don't) |

**Validation (surgical):**

```bash
pnpm vitest run tests/schema-validation/validate.test.ts tests/model
```
```bash
pnpm test:types
```

**Exit:** every P-rule has a fixture that fires it and a fixture that passes; P008 fires on a user-declared `commentable_type` field.

---

## Y2 — Validation Factories (input schemas)

**Goal:** query inputs parse and infer (design: *Phase 1* factories, rev-2 correlated filter + `{ type, where }` connect).

**Unit of work**

| File | Action | Content |
|---|---|---|
| `src/validation/primitives/discriminated-union.ts` | CREATE | `v.discriminatedUnion()` — models-map + core-schema-path → union; memoize `build()` (design flags the per-parse rebuild); **import `v` from `@validation/primitives/v`** (rule 5 above) |
| `src/validation/index.ts` | MODIFY | Export it |
| `src/validation/relations/polymorphic/filter.ts` | CREATE | Correlated union: `null` \| `{ type }` \| `{ type, is?, isNot? }` — `is` **requires** `type` (v1 pin) |
| `src/validation/relations/polymorphic/create.ts` | CREATE | `connect: { type, where }`, `create: { type, data }` |
| `src/validation/relations/polymorphic/update.ts` | CREATE | `connect` / `disconnect: true` only (design §7.4) |
| `src/validation/relations/polymorphic/select-include.ts` | CREATE | `true` \| per-type `{ select?, include? }` |
| `src/validation/relations/index.ts` | MODIFY | Export the four factories |
| `src/validation/model/core/{where,filter,create,update,select}.ts` | MODIFY | Merge polymorphic entries via `v.fromObject` (design: *Phase 1*) |
| `src/validation/model/core/index.ts` | MODIFY | `forEachPolymorphicRelation()` iterator |
| `tests/relations/polymorphic-filter.test.ts`, `tests/relations/polymorphic-create.test.ts`, `tests/relations/polymorphic-select-include.test.ts` | CREATE | Parse accept/reject per factory (pattern: existing `tests/relations/*.test.ts`); reject cases include `{ type: "post", is: <video where> }` and untyped `is` |

**Validation (surgical):**

```bash
pnpm vitest run tests/relations tests/validation
```
```bash
pnpm test:types
```

**Exit:** all four factories round-trip valid inputs and reject the correlation violations; no barrel-cycle regression (the `tests/validation` leg catches it).

---

## Y3 — Client Typing Surface (parallel-safe with Y4)

**Goal:** end-user autocompletion and result inference — through the **driver import path**, the lesson from the client-omit incident.

**Unit of work**

| File | Action | Content |
|---|---|---|
| `src/client/result-types.ts` | MODIFY | `InferPolymorphicResult<T>`, selective-include narrowing into include-result inference |
| `src/client/types.ts` | MODIFY | Polymorphic keys in operation arg types (where/data/include/select) |
| `tests/client/polymorphic-types.test.ts` | CREATE | Contextual probes importing `createClient` from `@drivers/pglite` (not core): `@ts-expect-error` on typo'd include keys (`commentable: { pots: true }`), typo'd `connect.type`, `is` without `type`; positive assertions on the discriminated result union |

**Validation (surgical):**

```bash
pnpm test:types
```
```bash
pnpm vitest run tests/client/polymorphic-types.test.ts tests/client/relation-types.test.ts tests/client/select-include-result.test.ts
```

**Exit:** probes pass from the driver path; the two existing relation-typing suites stay green (regression fence for the arg-type merge).

---

## Y4 — Read Path: Include, Filter, Hydration

**Goal:** the only genuinely polymorphic path (design: *Phase 4* rev 2 closing note, *Phase 5*, *Phase 6*): CASE + correlated subqueries, single statement, JSON hydration.

**Unit of work**

| File | Action | Content |
|---|---|---|
| `src/query-engine/builders/polymorphic-include-builder.ts` | CREATE | `buildPolymorphicInclude()` — CASE over the type column, one correlated subquery per WHEN, `json_build_object('type', k, 'data', …)`; selective includes per type (design §6) |
| `src/query-engine/builders/relation-filter-builder.ts` | MODIFY | Polymorphic branch: type-only (`= 'post'`), correlated `is` (type-pinned IN-subquery), `null` check |
| `src/query-engine/context/index.ts`, `src/query-engine/types.ts` | MODIFY | Polymorphic relation info on `QueryContext` (lowering-friendly shape — see Y5) |
| `src/adapters/types.ts` | MODIFY | `polymorphic.buildTypeCase()` on the adapter interface |
| `src/adapters/databases/postgres/postgres-adapter.ts`, `src/adapters/databases/mysql/`, `src/adapters/databases/sqlite/` | MODIFY | Dialect JSON fns (`json_build_object` / `JSON_OBJECT` / `json_object`) — **three engines** |
| result flow (`src/query-engine/result-flow.ts` area) | MODIFY | Parse the JSON column like any include; `nullOnMissing` default for orphans |
| `tests/query-engine/polymorphic-include.test.ts` | CREATE | SQL plan assertions (pattern: `tests/query-engine/starts-with-prefix-plan.test.ts`): single statement, CASE arms per configured type, per-type nested includes only in their arm |
| `tests/drivers/` behavioral cases | MODIFY | Round-trip include/filter cases added to the pglite + sqlite3/libsql suites |

**Validation (surgical):**

```bash
pnpm vitest run tests/query-engine/polymorphic-include.test.ts
```
```bash
pnpm test:drivers:local
```
```bash
pnpm test:types
```

**Exit:** plan test proves one statement (no N+1 per type); pglite round-trip returns the correct `{ type, data }` union incl. orphan→`null`; sqlite3 + libsql behavioral parity.

---

## Y5 — Write Path: Parse-Time Lowering onto V2

**Goal:** design *Phase 4* (rev 2) verbatim — writes lower to a single-target FK edge + one literal column; the fragment vocabulary does not grow.

**Unit of work**

| File | Action | Content |
|---|---|---|
| `src/query-engine-v2/polymorphic-lowering.ts` | CREATE | The lowering seam: `type` → target model → synthetic single-target `RelationInfo` (`fields: ["<name>_id"]`, `references: [target pk]`) + literal-column rider (`<name>_type = '<key>'`) |
| `src/query-engine-v2/routing.ts` | MODIFY | Recognize polymorphic keys in `data`, dispatch through the lowering seam into the existing Parts |
| `src/query-engine-v2/parse-boundary.ts` | MODIFY | Accept the discriminated write shapes — **conscious ratchet widening, updated in the gate test in the same commit** |
| decline surface | MODIFY | `update`-through, `set`, `upsert`, `connectOrCreate` decline loudly, enumerated in `tests/query-engine-v2/decline-surface-gate.test.ts` |
| `tests/query-engine-v2/polymorphic-write-behavior.ts` + `polymorphic-write.test.ts` | CREATE | House pair pattern: create-with-connect, nested create, inverse create (type pinned by parent), disconnect — asserted in **both** tx and batch modes (the atom's promise: byte-identical statements, only materialization differs) |

**Validation (surgical):**

```bash
pnpm test:gates
```
```bash
pnpm vitest run tests/query-engine-v2/polymorphic-write.test.ts tests/query-engine-v2/create-family.test.ts tests/query-engine-v2/create-nested-upsert.test.ts
```
```bash
pnpm test:types
```

**Exit:** all five gates green with the two widened entries reviewed as deliberate; write tests prove the literal type column and the `Ref`-carried id in both modes; the two adjacent write families (create, nested-upsert) unregressed. **If the Parts reject the literal-column rider**, the fallback (a `polymorphic` `RelationInfo` variant) is a design change — go back to the design doc, don't improvise here.

---

## Y6 — Migrations (parallel-safe with Y5)

**Goal:** design *Phase 2* (rev 2) — snapshot-level synthetic columns; honest per-engine membership changes.

**Unit of work**

| File | Action | Content |
|---|---|---|
| `src/migrations/serializer.ts` | MODIFY | Emit `{name}_type` / `{name}_id` columns + composite index + half-null CHECK into the SchemaSnapshot (the **only** place snapshot consumers learn of them) |
| `src/migrations/differ.ts` | MODIFY | Membership diffing for the type column (enum/CHECK modes) |
| `src/migrations/drivers/postgres/` | MODIFY | ENUM mode via `supportsNativeEnums` / `getEnumColumnType`; removals through `src/migrations/push/enum-removals.ts` |
| `src/migrations/drivers/mysql/` | MODIFY | Inline ENUM mode |
| `src/migrations/drivers/sqlite/`, `src/migrations/drivers/libsql/` | MODIFY | CHECK mode; membership change = table rebuild (existing sqlite recreation machinery — see `tests/migrations/sqlite-recreation-indexes.test.ts`) |
| `tests/migrations/serializer.test.ts`, `tests/migrations/differ.test.ts`, `tests/migrations/ddl.test.ts`, `tests/migrations/ddl-drivers.test.ts` | MODIFY | Snapshot emission; add/remove-target diffs per storage mode; DDL per driver incl. the CHECK rebuild and half-null CHECK |

**Validation (surgical):**

```bash
pnpm vitest run tests/migrations/serializer.test.ts tests/migrations/differ.test.ts tests/migrations/ddl.test.ts tests/migrations/ddl-drivers.test.ts
```

**Exit:** add-target on sqlite produces a rebuild plan (not a no-op); PG enum removal routes through enum-removals; VARCHAR mode add-target is a genuine no-op.

---

## Y7 — Inverse Side (needs Y4 + Y5)

**Goal:** design *Phase 7* + the rev-2 scope decision — the inverse behaves as a normal has-many whose edge is `(type = '<key>', id = pk)`.

**Unit of work**

| File | Action | Content |
|---|---|---|
| `src/schema/relation/to-many.ts`, `to-one.ts` | MODIFY | Existing `.name()` chainable wired as the polymorphic back-reference; inference = exact registered-name match (P004/P005/P010 from Y1 enforce it) |
| `src/query-engine/builders/relation-filter-builder.ts`, `relation-count-builder.ts`, include machinery | MODIFY | Inverse edge lowers on the read side too: normal correlation on `<name>_id` **plus** the constant `<name>_type = '<key>'` conjunct — `some`/`every`/`none`, `_count`, include |
| `tests/query-engine/polymorphic-inverse.test.ts` | CREATE | Plan assertions: the type conjunct present in every inverse correlation (filter, count, include) |
| `tests/client/polymorphic-types.test.ts` | MODIFY | Inverse typing probes (`post.comments` result, `comments: { some }` args) |
| `tests/drivers/` behavioral | MODIFY | pglite inverse round-trip (include + some-filter + `_count`) |

**Validation (surgical):**

```bash
pnpm vitest run tests/query-engine/polymorphic-inverse.test.ts tests/relations
```
```bash
pnpm test:pglite
```
```bash
pnpm test:types
```

**Exit:** every inverse read carries the type conjunct (the plan test greps for it); `_count` and `some/every/none` work or are consciously declined — no silent gap.

---

## Y8 — Cache + Instrumentation (small; parallel-safe with Y7)

**Goal:** design *Phase 9* / *Phase 10* (rev 2 file corrections).

**Unit of work**

| File | Action | Content |
|---|---|---|
| `src/cache/key.ts` | MODIFY | Polymorphic include shape in key generation |
| `src/cache/cache-contract.ts` | MODIFY | Invalidation: a write to any target model invalidates queries including the polymorphic relation — **exact registered-name matching** (verify the seam; design flags it) |
| `src/instrumentation/spans.ts`, `tracer.ts` | MODIFY | `ATTR_POLYMORPHIC_FIELD` / `ATTR_POLYMORPHIC_TYPES` / `ATTR_POLYMORPHIC_SELECTIVE` on `SPAN_BUILD` |
| `tests/cache/cache.test.ts`, `tests/instrumentation/context-spans.test.ts` | MODIFY | Key stability + invalidation-on-target-write; attributes present |

**Validation (surgical):**

```bash
pnpm vitest run tests/cache tests/instrumentation/context-spans.test.ts
```

**Exit:** updating a `post` invalidates a cached `comment.findMany({ include: { commentable: true } })`; two different selective includes produce distinct keys.

---

## Y9 — Conformance + Closing Gate

**Goal:** the only phase that runs everything; live-engine truth for what pglite/sqlite could not prove.

**Unit of work**

1. Docker behavioral legs: polymorphic create/connect/include/filter/inverse cases in the pg + mysql driver suites (env inline per house practice; pg files serial — the `test:pg` script already enforces `--no-file-parallelism`).
2. Orphan behavior matrix: `nullOnMissing` default + `errorOnMissing` opt-in, on all engines.
3. Composite-index verification: `EXPLAIN` on the inverse lookup hits `idx_<table>_<name>` (pg leg; pattern: `tests/query-engine/starts-with-prefix-plan.test.ts`).
4. Resolve the two open design decisions with the maintainer before v1 tags: discriminator alias map (§8 item 5) and lifting P006 (§8 item 6).

**Validation (closing):**

```bash
pnpm test:pg
```
```bash
pnpm test:mysql
```
```bash
pnpm test && pnpm test:types && pnpm test:gates
```

**Exit:** three engines behaviorally identical on the conformance cases; full suite, types, and gates green in one run.

---

## Phase → Design-Doc Map

| Plan | Design doc |
|---|---|
| Y0 | Typing Constraint callout, Type Definitions |
| Y1 | Schema Validation Rules (P001–P010, CM004) |
| Y2 | Phase 1 factories, `v.discriminatedUnion()` |
| Y3 | Phase 3, §2 |
| Y4 | Phase 5, Phase 6, §6 |
| Y5 | Phase 4 (rev 2) |
| Y6 | Phase 2 (rev 2) |
| Y7 | Phase 7, §7.2 |
| Y8 | Phase 9, Phase 10 |
| Y9 | §9 Success Criteria |
