# Prisma Parity v2 — Phased Execution Plan

**Goal:** close every gap that stops viborm from being a drop-in Prisma Client replacement, without regressing any existing superset. Baseline: `fix/three-defects` + the two in-flight chips (findFirst `take` semantics, enum `columnValueReplacements` DDL). Source of truth for the gap list: [capability-matrix-2026-07.md](capability-matrix-2026-07.md).

**Unit-of-work convention:** every unit is one drive through the established harness — implementer (commit-first) → contract attacker (independent live probes) → theater attacker (falsify-by-mutation, gate-loosening check) → ≤2 fix rounds. One commit (or two) per unit. Full estate + `test:gates` green per unit; Docker MySQL/pg legs at each wave boundary.

**Sizing:** S = one agent-drive, hours. M = one drive, substantial (a day-scale unit). L = multiple coordinated units. XL = its own multi-unit wave.

**Naming:** waves `W1..W7` (deliberately not `P#` — that namespace belongs to the engine-unification history).

---

## 0. Decision register (sign-off needed before the affected unit starts)

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D-1 | **`*AndReturn` fate.** Maintainer dislikes the explicit methods; wants implicit return when `select`/`include` is present on `createMany`/`updateMany`. | **RESOLVED 2026-07-26 (maintainer): REMOVE `createManyAndReturn`/`updateManyAndReturn` entirely — no aliases, no deprecation period.** The implicit form is the only surface. Accepted as a deliberate breaking divergence from Prisma's method names; document the migration (`createManyAndReturn(args)` → `createMany({ ...args, select })`). | W3-U4 |
| D-2 | **Transaction options doctrine.** `isolationLevel`/`timeout`/`maxWait` are *deliberately* rejected today ("portable transactions accept no options"). 1-1 replacement requires them. | Reverse the doctrine partially: accept the Prisma options object; honor `isolationLevel` + `timeout` on transaction-capable drivers, keep a **typed refusal** (V8003) on drivers that can't (D1, Neon HTTP) and for `maxWait` where no pool wait exists. Never silently ignore an option. | W5-U3 |
| D-3 | **Decimal representation.** `s.decimal()` is a lossy JS `number`. | String-backed by default (decode `numeric` → string, accept string \| number on write), with an optional `.as(DecimalClass)` hook for decimal.js users. Breaking change → needs a major-version flag or an opt-in `decimal: "string"` client option for one release. | W6-U1 |
| D-4 | **Full-text search scope.** Currently a non-goal; Prisma ships it as preview. | Defer (W7, optional). If done: PG `tsvector` + MySQL `MATCH…AGAINST`, typed refusal on SQLite (FTS5 needs virtual tables — out of scope). | W7 |
| D-5 | **`orderBy` to-one chain depth cap** (currently 3). | Lift to 8 with the existing strict-schema recursion; unbounded requires lazy self-reference in the orderBy schema — do that only if a user asks. | W1-U7 |

---

## W1 — Validation-layer alignment (all S, engine paths already exist)

Everything in this wave is schema-layer work where the SQL engine already handles the shape (or the desugared shape). Lowest risk, highest count.

| Unit | What | Files | Acceptance |
|---|---|---|---|
| W1-U1 | **`not` arbitrary nesting.** Validation allows one level; `not: { not: {…} }` rejected though `where-builder.ts:379-389` handles it. Make the `not` entry lazily self-referential per scalar filter schema. | `src/validation/scalars/*.ts` (shared helper), tests | `not:{not:{contains}}` and 3-deep both validate and produce correct SQL on all 3 local drivers; double negation returns the non-negated set |
| W1-U2 | **Blob `in`/`notIn`.** `scalars/blob.ts:41-47` falls to `{equals,not}`; Prisma's `BytesFilter` has `in/notIn`. | `src/validation/scalars/blob.ts`, adapter param serialization if bytea arrays need it, tests | `blob: { in: [u8a, u8b] }` matches on pg/sqlite/mysql-local suites; empty `in: []` → FALSE (Prisma semantics) |
| W1-U3 | **`having: { AND \| OR \| NOT }`.** Engine implements it (`groupby-having.ts:17-36`); `getHavingSchema` rejects it. Add the three boolean keys (lazy recursion). | `src/validation/model/args/aggregate.ts:291-301`, tests | the exact payload from the audit (`having: { OR: [...] }`) executes; nested AND-in-OR works |
| W1-U4 | **`_count: true` shorthand.** Prisma: `include: { _count: true }` = count **all** relations of the model (sugar for `_count: { select: { <every relation>: true } }`). Desugar in validation. | `src/validation/model/core/select.ts:128,182`, tests | `include:{_count:true}` returns every relation's count; mixed with explicit select rejected same as Prisma |
| W1-U5 | **To-one filter shorthand.** `{ author: { name: "x" } }` desugars to `{ author: { is: { name: "x" } } }`. Disambiguation: if the object's keys are exactly a subset of `{is, isNot}` treat as explicit form, else desugar (Prisma's rule). `author: null` unchanged. | `src/validation/relations/filter.ts:15-57`, tests | shorthand equals explicit `is` on to-one; a field literally named `is` on the target model still reachable via explicit form (document the collision rule) |
| W1-U6 | **`distinct` on `findFirst` + scalar shorthand.** Accept `distinct` on findFirst (Prisma does) and accept a bare string as `distinct: 'name'`. | `src/validation/model/args/find.ts:53-98,124-152`, `ReadOperation.ts` (pass-through), tests | `findFirst({distinct:'name', orderBy})` returns first distinct row; string and `[string]` equivalent |
| W1-U7 | **orderBy to-one chain cap 3 → 8** (per D-5). | `src/validation/relations/order-by.ts:60`, tests | 5-hop chain orders correctly on pglite |

**Parallelism:** U1+U2 touch `scalars/*` — same stream. U3, U4, U5, U6, U7 are pairwise disjoint. **Run as 3 parallel lanes:** (U1→U2), (U3→U4→U6), (U5→U7).

---

## W2 — Filter-engine extensions (JSON + field references)

| Unit | Size | What | Acceptance |
|---|---|---|---|
| W2-U1 | M | **JSON `lt/lte/gt/gte`.** Numeric and string comparison on an extracted JSON path, per dialect: PG `(col #> path)` with `jsonb` ordering or numeric cast, MySQL `JSON_EXTRACT` native comparison, SQLite `json_extract` typed result. Match Prisma's semantics: comparison applies when the extracted value is a number (or lexicographic for strings) — pin the exact behavior with cross-dialect conformance tests, including mixed-type rows (no match, no error). | `gt: 5` on `$.score` selects correctly on all 3 dialects; string comparison consistent; null/absent path never matches |
| W2-U2 | S | **JSON `mode: "insensitive"`.** Apply the existing ASCII-A–Z fold to `string_contains`/`string_starts_with`/`string_ends_with` on the extracted text. | insensitive JSON string filters agree byte-for-byte across dialects (extend the prisma-parity-behavior suite) |
| W2-U3 | M | **Field references (Prisma `FieldRef`).** Zero-codegen shape: `client.$fields.user.age` (or `s.ref("age")` schema-side — implementer proposes, reviewer challenges). Where-builder emits a column reference instead of a bound param when the operand is a FieldRef; valid only against the same model (Prisma's rule); groupBy/having excluded (Prisma excludes too). | `{ views: { gt: client.$fields.post.likes } }` compiles to `"views" > "likes"`; cross-model ref rejected at validation; type-level: FieldRef<Model,'Int'> only assignable to Int filter slots |
| W2-U4 | S (optional) | **JSON string-path sugar.** Accept Prisma-MySQL's `path: '$.a.b'` string form by parsing to the array form (same portable-segment restrictions). | string and array forms produce identical SQL; `"` / `\` segments still rejected pre-SQL |

**Parallelism:** U1→U2 same file (`json-filter-builder.ts`) — serial pair. U3 disjoint (where-builder + client). U4 after U1. **2 lanes:** (U1→U2→U4), (U3).

### W2-U3 — DELIVERED (lane W2-B)

Surface: `client.$fields.<model>.<field>` returns a `Symbol.for("viborm.field-ref")`-branded,
frozen token carrying `{ model, field, type, list }`. The whole surface is a lazy Proxy pair —
nothing is walked until a model, then a field, is read — so a client that never compares columns
pays one object allocation for it (`src/schema/field-ref.ts`, pinned by
`tests/query-engine/field-reference-sql.test.ts`).

**Where each rule is enforced, and why.** The two rules do not live in the same place, because
they are not decidable in the same place:

- **Scalar type** — validation. `v.fieldRefOr(<type>, operand)`
  (`src/validation/primitives/field-ref.ts`) is a discriminating wrapper, not a `v.union`: a
  non-reference value is handed straight to the wrapped operand schema, so every pre-existing
  operand failure message is byte-identical to before.
- **Same model** — the where-builder (`fieldRefColumn` in `where-builder.ts`). "The model being
  filtered" is a property of the QUERY SCOPE, not of the schema: a nested relation `where`
  re-scopes to the relation's target while reusing that model's filter schemas, and those schemas
  are *interned across models* by design (`validation/scalars/intern.ts` — they deliberately carry
  no model identity). The builder must resolve the reference against the current scope to emit a
  column at all, so the check is intrinsic there rather than a duplicated guard. It raises at
  SQL-build time — before any I/O — exactly like a validation failure from the caller's view.

**In:** `equals`, `not`, `lt`, `lte`, `gt`, `gte` on int/float/decimal/bigint/string/datetime/
date/time, `equals`/`not` on boolean/enum, and string `contains`/`startsWith`/`endsWith` (the
adapters implement those with `POSITION`/`instr`/`LOCATE` + `LEFT`/`RIGHT`, never LIKE patterns,
so a column operand composes exactly like a literal). Operands mirror the LHS's collation
treatment (`caseSensitiveText` / `asciiCaseFold`), so `mode: "insensitive"` stays symmetric. The
bare form `{ views: <ref> }` normalizes to `{ equals: <ref> }` like any other shorthand.

**Out (fails closed, with a message):** `in`/`notIn`, list operators (`has`/`hasEvery`/`hasSome`/
`isEmpty`), list-scalar references, JSON/blob/vector/point operands, `orderBy`, `whereUnique`,
create/update data, and `having`/`groupBy`. The `having` exclusion is Prisma parity and needed an
explicit re-close (`v.noFieldRef`): `getHavingSchema` reuses the model's own scalar filter, so it
would otherwise have inherited the operand by accident.

**Correction (W2 review, fixed after the wave merged).** `v.noFieldRef` shipped with a
four-level cap on its scan, justified by "filter values nest at most a couple of levels". The
sibling W1 change on this same branch (94e0bb0, "Let scalar `not` filters nest arbitrarily") had
already falsified that premise: `having: { views: { not: { not: { not: { not: { gt: ref }}}}}}`
put the token at depth 5, the scan never saw it, and the reference was emitted into HAVING as a
raw alias-qualified column — which Postgres rejects as an ungrouped column while SQLite and LibSQL
accept it and return a silently wrong row. The cap is gone; the scan is now exhaustive, and
terminates by structure (each object visited at most once) rather than by budget, with an explicit
worklist so depth cannot overflow the stack. Pinned at both layers: the scanner itself in
`tests/validation/field-ref.test.ts` (depths 0…500, cycles, shared subgraphs) and end-to-end
through `groupBy` in `tests/query-engine/field-reference-sql.test.ts` (depths 0…64, plus each of
`AND`/`OR`/`NOT`), with a live per-dialect pin in `tests/drivers/field-reference-behavior.ts`.

**Correction 2 (W2 adversarial review) — JSON was NOT out, it only looked out.** The "Out" list
above claimed JSON operands were refused. They were not: every other closed surface refuses a
reference *for free*, because a token is not a string/number/date/blob, but JSON accepts an
arbitrary object, so `{ [FIELD_REF_BRAND]: true, model, field, type, list }` is an ordinary
document to `v.json`. `where: { data: { equals: <ref> } }` bound the token as a parameter and
matched nothing, `array_contains`/`array_starts_with`/`array_ends_with` did the same with or
without a `path`, and — worse — `create`/`update` **persisted** the ORM's own token into the
user's JSON column. Closed with the same `v.noFieldRef` wrapper `having` uses, on the four
whole-document filter operands and on the json create/update schemas
(`src/validation/scalars/json.ts`); the scan is exhaustive, so a token buried inside an otherwise
legal document is refused too. The JSON-Schema converter gained the matching `no_field_ref` case —
its default branch throws, so the wrapper would otherwise have taken JSON-Schema emission down for
any payload containing one.

**Correction 3 (W2 adversarial review) — `mode: "insensitive"` was accepted and ignored for a
referenced `equals`/`not`.** The claim above that "operands mirror the LHS's collation treatment"
was half true. The insensitive branch of `equals` gated on `typeof value === "string"`, and a
reference is an object, so it fell through to the exact predicate: `equals` stayed case-sensitive
while `contains`/`startsWith`/`endsWith` in the same filter object folded. `not: <ref>` inherited
it through the shorthand coercion to `{ equals: <ref> }`. Fixed in `where-builder.ts` by admitting
a reference to the insensitive path.

The coverage gap behind it is worth recording, because the two halves of the "mirroring" are not
the same kind of claim. The FOLD is behavioral — dropping it on the operand compares folded text
against unfolded text and silently returns fewer rows — and is now discriminated on every dialect
by rows that carry the upper case in the REFERENCED column. `caseSensitiveText` on the operand is
NOT behavioral: all three dialects let a one-sided wrapper govern the whole comparison (checked on
live MySQL 8.4: `'A' = BINARY 'a'` and `BINARY 'A' = 'a'` both answer 0; removing the operand
wrapper leaves the whole Docker MySQL leg green). It is therefore pinned as emitted SQL per
dialect rather than claimed as behavior no test could witness. The field-reference behavior suite
is now wired into the MySQL, pg and postgres.js legs as well — MySQL is the only one whose own
default collation is case- and accent-insensitive, so it is the only place "default mode is
case-sensitive" is a claim about the builder rather than about the server.

---

## W3 — Read surface: nested pagination trio + implicit returns

| Unit | Size | What | Acceptance |
|---|---|---|---|
| W3-U1 | M | **Nested negative `take`.** Inside include/select relation args: flip order directions inside the lateral/correlated subquery, keep Prisma's returned-order semantics (mirror the top-level findMany behavior already tested as "negative take pages backward in logical order"). Removes the deliberate rejection at `relations/select-include.ts:59-71`. | last-2 posts per user matches Prisma ordering on all 3 dialects; interacts correctly with nested `where` + `skip` |
| W3-U2 | M | **Nested `cursor`.** Cursor-condition (already dialect-neutral, `cursor-condition.ts`) applied inside the relation subquery; compound cursors included. Strict-schema key added. | per-parent cursor pagination pages correctly; cursor row absent → empty (Prisma semantics); works under both lateral and correlated strategies |
| W3-U3 | M | **Nested `distinct`.** ROW_NUMBER-partition emulation (the machinery from `select-assembly.ts:97-166`) applied per relation subquery. | nested distinct on a to-many matches Prisma result shape on all 3 dialects |
| W3-U4 | M/L | **Implicit returns + `*AndReturn` REMOVAL (per resolved D-1).** `createMany`/`updateMany` accept optional `select`; when present the operation routes to the ManyAndReturn machinery and the return type conditionally becomes `T[]` instead of `{count}`. `createManyAndReturn`/`updateManyAndReturn` are **deleted** from the client surface, validation, types, and routing (deliberate edits to the routing exhaustiveness guard and executor operation-token gate). All existing tests calling the old names rewritten to the implicit API; docs mentions updated. Constraints inherited: `include` still rejected (same as the old `*AndReturn` restriction, clear error), `skipDuplicates`+`select` on a non-returning driver keeps the V8003 refusal. | type-level: `updateMany({where,data})` → `{count}`, `updateMany({where,data,select})` → `T[]`; runtime matches types; old method names are gone (clean error, not silent); MySQL capture-PK path exercised via shared suite |
| W3-U5 | S (optional, superset) | **`deleteMany` with `select`** — implicit "deleteManyAndReturn" (Prisma has none). RETURNING on capable drivers; pre-read+delete inside tx on MySQL. | rows returned match what was deleted, atomically |

**Parallelism:** U1→U2→U3 share `select-builder`/`include-builder`/`relations/select-include.ts` — one serial lane. U4 (routing/validation/types) is disjoint — parallel lane. U5 after U4. **2 lanes:** (U1→U2→U3), (U4→U5). W3 can start as soon as W1 lands (W1-U6 touches find args; trivial merge).

---

## W4 — Write surface parity (contains the one genuinely risky unit)

| Unit | Size | What | Acceptance |
|---|---|---|---|
| W4-U1 | **L** | **Extended `whereUnique`** (Prisma ≥4.5): non-unique filters + `AND`/`OR`/`NOT` mixed into `findUnique`/`update`/`delete`/`upsert` `where`, while still **requiring at least one full unique discriminator** (Prisma's own rule). ⚠️ This touches the engine's load-bearing assumption that whereUnique values are compile-time literals: **pinning (Pin Rule), racePin attribution, upsert's probe-first locate, and mutation identity may only consume the unique-discriminator portion** — extra filters must never contribute pins. Semantics to pin with conformance tests: update/delete where the unique key matches but the extra filter doesn't → `NotFoundError` (P2025-equivalent), state unchanged; upsert in that situation takes the **create** arm and surfaces the unique violation exactly like Prisma (P2002-equivalent). Dual-mode (tx + batch) + full nested-write interaction sweep (a pinned nested create under an extended where must still pin from the discriminator only). | The riskiest unit in the plan. Runs alone, with the full harness plus a dedicated staleness/falsification round on the Pin Rule (the staleness-injection suite exists). Docker legs mandatory before merge. |
| W4-U2 | M | **`updateMany`/`deleteMany` `limit`** (Prisma 6.x). MySQL: native `UPDATE … LIMIT`. PG/SQLite: `WHERE pk IN (SELECT pk … LIMIT n)` subquery (orderBy-less, like Prisma). Count reflects the limit. | limit smaller/larger/equal to matching set; limit 0; interaction with relation filters (derived-table wrapper on MySQL) |
| W4-U3 | S | **To-one nested `update` `{where, data}` form** (Prisma 5). `where` filters the current related record; no match → P2025-equivalent NestedWriteError, state unchanged. Bare-data form stays. | both forms accepted; filter-miss aborts atomically |
| W4-U4 | M | **JSON null sentinels** `DbNull` / `JsonNull` / `AnyNull` (exported values). Write: `DbNull` → SQL NULL, `JsonNull` → JSON `null` value. Filter: `equals: AnyNull` matches both, etc. Cross-dialect (SQLite TEXT-json needs care distinguishing SQL NULL from `'null'`). | Prisma's documented truth table reproduced on all 3 dialects |

**Parallelism:** U1 exclusive first (its blast radius overlaps everything). Then U2, U3, U4 fully parallel (disjoint files).

---

## W5 — Client surface & errors (all units independent → fully parallel)

| Unit | Size | What | Acceptance |
|---|---|---|---|
| W5-U1 | M | **Raw SQL overhaul.** `$queryRaw` becomes a tagged template (safe-by-construction); the current `(string, params)` form moves to `$queryRawUnsafe` (keep an overload on `$queryRaw` detecting a plain string for one release, with a deprecation warning in the `warning` log channel). Add `$executeRaw` tagged + `$executeRawUnsafe`. Export `sql`/`join`/`empty`/`raw` from the package root (`Sql` class already dialect-renders via `toStatement`). Wire `tx.$queryRaw`/`tx.$executeRaw` into the tx proxy (today it throws `Model "$executeRaw" not found`). | tagged interpolation parameterizes on all dialects; `join` accepts plain values (Prisma parity); tx raw runs inside the open transaction (single-connection drivers verified) |
| W5-U2 | S/M | **Prisma error-code compatibility.** Add `prismaCode` to `VibORMError` (V3001→`P2002`, V3002→`P2003`, V3003→`P2011`, V6001→`P2025`, V4001→validation, per the matrix table); map the missing **P2000** (PG `22001`, MySQL `1406` value-too-long) to a typed error instead of generic `QueryError`; add a typed client-construction error (PrismaClientInitializationError-equivalent). | `e.prismaCode === 'P2002'` works in a catch written for Prisma; P2000 mapping covered in the error-mapping suite for all dialects |
| W5-U3 | M | **Transaction options (per D-2).** Accept `{ isolationLevel, timeout, maxWait }` on both `$transaction` forms. Honor isolationLevel (SET TRANSACTION ISOLATION LEVEL per dialect) + timeout (driver-side timer aborting/rolling back) on transaction-capable drivers; V8003 typed refusal on D1/Neon HTTP and for unsupported levels (SQLite has only its journal modes — map or refuse, pin the choice). Replaces `assertNoTransactionOptions` and its 11-driver pinned tests deliberately. | Serializable conflict produces the dialect's serialization error, mapped; timeout rolls back cleanly; refusals typed, never silent |
| W5-U4 | M | **`omit`** — query-level (`omit: { field: true }` on every read/write-returning op, exclusive with `select`) and client-level (`createClient({ omit: { user: { password: true } } })`), matching Prisma's local-overrides-global rule (`omit: { field: false }` re-includes). Composes with the existing model-level `.omit()`. | type-level result excludes omitted keys; nested omit in include; global+local precedence matrix tested |
| W5-U5 | S (optional) | **`$metrics`** — expose the internal `PerfTracker` counters in Prisma's json/prometheus shapes. | `$metrics.json()` returns counters; no-op cost when unused |

---

## W6 — Type fidelity (breaking-change wave, own release)

| Unit | Size | What |
|---|---|---|
| W6-U1 | L | **Decimal (per D-3).** String-backed decode for `numeric`/`DECIMAL(65,30)`; accept `string \| number` on write; filters compare via SQL (no JS float math); SQLite column type moves `REAL` → `TEXT`-with-numeric-affinity decision (pin with migration note). Migration path: one release with `decimal: "number"` legacy opt-in. |
| W6-U2 | S | **BigInt hole on `bun-sqlite`** — add the missing safe-integers opt-in (matrix defect §2.9-6; belongs here since it's the same "types are exact" theme). |

---

## W7 — Ecosystem: extension system (XL) + optional stretch — **DEFERRED**

**DEFERRED 2026-07-26 (maintainer): too complex for now; revisit after W6 ships.** Preserved below for when it reopens. Sequenced so each stage ships value alone:

| Unit | Size | What |
|---|---|---|
| W7-U1 | M | **`$use` middleware.** `(params, next) => result` around every operation; the seam already exists (`PendingOperation.wrapExecutor`, used today only by cache-flow). Ordered registration, async, error pass-through. |
| W7-U2 | M | **`$extends` result extensions** — computed fields with `needs`, type-level result augmentation. |
| W7-U3 | M | **`$extends` model + client extensions** — custom methods on models/client, `Prisma.getExtensionContext` equivalent. |
| W7-U4 | L | **`$extends` query extensions** — per-op/`$allOperations` interception with typed `args`/`query`; subsumes `$use` internally. |
| W7-U5 | — | **Optional stretch (per D-4, decide later):** full-text `search`/`_relevance` (PG+MySQL, typed refusal SQLite); `db pull` TS emitter; `db seed`. |

---

## Explicitly out of scope (with reasons)

- **Mongo-only surface** (`isSet`, composite types, `auto()`) — no Mongo adapter.
- **`relationLoadStrategy` as public API** — viborm auto-selects and is always one round trip; exposing a knob would only allow worse plans.
- **Preview-feature flag system** — viborm ships GA-or-absent.
- **Studio** — separate product, not client parity.
- **`Unsupported()` column type / views / multiSchema** — schema-system work, tracked in the matrix, not client parity.

## Superset non-regression list (guarded by existing tests; reviewers must check each wave)

Nested upsert-under-create, unlimited nesting depth, `targetWhere`/`setWhere`, optional-`where` nested updateMany, insensitive mode + list filters + list `push/unshift/set` on MySQL/SQLite, PK arithmetic gate, nested transactions/savepoints, write-race retry, caching, `exist`, vector search, down migrations.

---

## Execution map

```
W1 (3 parallel lanes, all S)          ──┐
W2 (2 lanes; U3 parallel to U1→U2)    ──┼── W1+W2+W3-U4 can run CONCURRENTLY
W3 lane A (U1→U2→U3)  lane B (U4→U5)  ──┘   (disjoint files; merge order: W1 first)
        │
W4-U1 extended whereUnique  ← runs ALONE (engine blast radius), Docker gate
        │
W4-U2 ∥ W4-U3 ∥ W4-U4                 (parallel after U1)
        │
W5-U1 ∥ U2 ∥ U3 ∥ U4 ∥ U5            (fully parallel, client layer)
        │
W6 (breaking, own release)          W7 DEFERRED (maintainer, 2026-07-26)
```

Decisions D-2 (transaction options with typed refusals), D-3 (string-backed Decimal with legacy opt-in), and D-5 (orderBy chain cap → 8) were approved as recommended with the plan sign-off on 2026-07-26. D-4 (full-text search) stays deferred with W7.

Rough totals: W1 ≈ 7 S-units, W2 ≈ 3–4, W3 ≈ 4–5, W4 ≈ 4 (one L), W5 ≈ 4–5, W6 ≈ 2, W7 ≈ 4. **~30 harness drives**; the long pole is W4-U1 and W7.

Wave boundaries = full estate + `test:gates` + Docker MySQL/pg + benchmark spot-check (no scalar-write regression beyond the accepted D1 trade-off) + capability-matrix doc updated so it never drifts from shipped truth.
