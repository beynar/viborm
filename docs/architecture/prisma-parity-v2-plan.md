# Prisma Parity v2 — Phased Execution Plan

**Goal:** close every gap that stops viborm from being a drop-in Prisma Client replacement, without regressing any existing superset. Baseline: `fix/three-defects` + the two in-flight chips (findFirst `take` semantics, enum `columnValueReplacements` DDL). Source of truth for the gap list: [capability-matrix-2026-07.md](capability-matrix-2026-07.md).

**Unit-of-work convention:** every unit is one drive through the established harness — implementer (commit-first) → contract attacker (independent live probes) → theater attacker (falsify-by-mutation, gate-loosening check) → ≤2 fix rounds. One commit (or two) per unit. Full estate + `test:gates` green per unit; Docker MySQL/pg legs at each wave boundary.

**Sizing:** S = one agent-drive, hours. M = one drive, substantial (a day-scale unit). L = multiple coordinated units. XL = its own multi-unit wave.

**Naming:** waves `W1..W7` (deliberately not `P#` — that namespace belongs to the engine-unification history).

---

## Delivery status (2026-07-28)

**This table is the summary of record.** Each wave's own `### Wx-Uy — DELIVERED` section below is the
delivery *detail* — surface, evidence, falsifications, and the corrections applied on top. Those
sections are kept verbatim, including their strikethroughs and their "correction" subsections;
where a later round changed what shipped, the correction is written in place and this table names
the commit it landed in. Nothing below this table has been deleted to make it agree.

Every commit reference here is on `prisma-parity-v2` and resolvable with `git log --oneline main..HEAD`.
Waves were built in parallel worktrees and cherry-picked, so a unit's commits are not always contiguous;
post-merge review fixes are listed with the unit they corrected, not with the merge.

Status vocabulary: **delivered** = shipped as briefed · **delivered, scope note** = shipped with a
stated divergence or a narrowed surface · **not shipped** = deliberately dropped, reason recorded ·
**deferred** = not attempted in this branch.

### W1 — Validation-layer alignment

| Unit | Status | Landing commit(s) | Deliberate divergence / scope note |
|---|---|---|---|
| W1-U1 `not` arbitrary nesting | delivered | `94e0bb0`; JSON-Schema fallout `b2f8f79` | None. `not` is lazily self-referential per scalar (`src/validation/scalars/negatable-filter.ts`), matching the builder that always recursed. |
| W1-U2 Blob `in`/`notIn` | delivered | `f64a315` | None. `BytesFilter` parity; empty `in: []` → FALSE. |
| W1-U3 `having: { AND \| OR \| NOT }` | delivered, scope note | `6a0c252` | Opening the surface exposed two engine bugs, both fixed in the same unit: empty `OR` dropped the key (now FALSE), and array-`NOT` computed `NOT(c1 AND c2)` instead of Prisma's `NOT c1 AND NOT c2`. See matrix §1.3. |
| W1-U4 `_count: true` shorthand | delivered, scope note | `5b8af31` | Desugars in validation to `{ select: { <every to-many relation>: true } }`. A model with **no** to-many relations expands to `{ select: {} }`; Prisma emits no `_count` field at all there. |
| W1-U5 To-one filter shorthand | delivered, scope note | `a6ae6b4` | Prisma's own disambiguation rule (keys ⊆ `{is, isNot}` ⇒ explicit form). A target model owning a field literally named `is`/`isNot` is reachable only through the explicit form — documented collision, same as Prisma's. |
| W1-U6 `distinct` on `findFirst` + string shorthand | delivered | `8f03b20` | None. Still not accepted on `groupBy` (Prisma parity). |
| W1-U7 `orderBy` to-one chain cap 3 → 8 | delivered, scope note | `391b634` | Per D-5: raised, **not** unbounded. The cap is mirrored in two places by design — `src/validation/relations/order-by.ts` and `relation-orderby-builder.ts:42`. |

Post-wave cleanup: `78f3a0c` deleted the two guards W1-U1/W1-U3 made unreachable (`where-unique-builder.ts`, `groupby-having.ts`).

### W2 — Filter-engine extensions

| Unit | Status | Landing commit(s) | Deliberate divergence / scope note |
|---|---|---|---|
| W2-U1 JSON `lt/lte/gt/gte` | delivered, scope note | `494362a` | One portable comparison contract across all three dialects; the operand's class (number vs string) picks numeric vs lexicographic comparison (`src/validation/scalars/json.ts:10-11`). Mixed-type rows do not match and do not error. |
| W2-U2 JSON `mode: "insensitive"` | delivered | `724b6eb` | Same ASCII A–Z fold as the scalar path — diverges from `ILIKE` on accented text, as the whole `mode` surface already did. |
| W2-U3 Field references (`FieldRef`) | delivered, scope note | `e766b5d`; corrections `3aeaa06`, `c987b71`, `afb21b2`, `dd86dc6`, `615c6ec`, `66712aa`, `2249860`; doc correction `11bc32a` | Surface is `client.$fields.<model>.<field>` (zero codegen). Refused, each with a message: `in`/`notIn`, list operators, JSON operands **and JSON write data**, blob/vector/point, `orderBy`, `whereUnique`, create/update data, and `having`/`groupBy` (the last is Prisma parity). Enum references answer identically on every dialect or are refused (`2249860`). |
| W2-U4 JSON string-path sugar | delivered, scope note | `126eb77` | Prisma-MySQL's `'$.a.b'` is parsed to the array form. Grammar accepted is `'$'`, `'$.key'`, `'$.key[0]'` and nothing else — quoted labels and wildcards are refused rather than half-supported (`json-filter-builder.ts:54-63`). |

### W3 — Read surface

| Unit | Status | Landing commit(s) | Deliberate divergence / scope note |
|---|---|---|---|
| W3-U1 Nested negative `take` | delivered | `143ca92` | None. Same pipeline as the top level (`builders/nested-read-window.ts`). |
| W3-U2 Nested `cursor` (incl. compound) | delivered | `497c129` | None. A cursor matching no row leaves that parent's window empty (Prisma semantics). |
| W3-U3 Nested `distinct` | delivered | `8455013`; test fix `2868ae2` | None. Dedup happens before the take/skip window, per parent. |
| W3-U4 Implicit returning + `*AndReturn` REMOVAL | delivered, scope note | `c9de15f`; docs `27d8e53`; fixes `9295461`, `25a620d`, `0bf3afd`, `9e8cdbb` | **Deliberate break from Prisma's method names** (resolved D-1): `createManyAndReturn`/`updateManyAndReturn` are gone from the client surface — calling one is a loud "Unknown operation" (`pending-operation.ts:134`), never a silent no-op. The names survive **only** as internal operation tokens (`query-engine/types.ts`), and errors report the spelling the caller used, not the internal returning arm (`0bf3afd`). The implicit `select` is **scalar-only**: a relation key, `_count` or `include` is refused at the parse boundary (`9295461` — it used to be accepted and answered with wrong data). |
| W3-U5 `deleteMany` with `select` | delivered (superset) | `ccecfd2` | Past Prisma, which has no returning `deleteMany`. |

### W4 — Write surface parity

| Unit | Status | Landing commit(s) | Deliberate divergence / scope note |
|---|---|---|---|
| W4-U1 Extended `whereUnique` | delivered, scope note | `ec8a72c`, `6fcab71`, `3d8eb6d`, `3ccd057`; review fixes `53631f8`, `ea1f637`, `51a995a` | Two divergences, both refused rather than half-answered: **relation filters** inside a unique `where` (the filter half compiles into UPDATE/DELETE, where MySQL rejects a subquery reading the mutated table — error 1093), and **nested relation-write target selectors plus `cursor` keep the strict discriminator-only schema**. Top-level five operations only. Upsert's create arm carries no `racePin` under an extended `where`, and its read-back addresses the write's own identity, never the `where` (`ea1f637`, `51a995a`). |
| W4-U2 `updateMany`/`deleteMany` `limit` | delivered, scope note | `127cd2f`; merged `656d40a` | The contract is **how many, not which** — a bulk write takes no `orderBy`, the two dialect spellings genuinely reach different rows, and nothing invents an ordering. Stated as a warning in the docs; no test asserts row identity. |
| W4-U3 To-one nested `update` `{where, data}` | delivered, scope note | `ba1f586`; merged `656d40a`; fixes `5cd5268`, `406794b`, `8bd2cc9`; doc corrections `dad1dec`, `f5446dd` | On a target model that owns an update key named `data` the two spellings collide and viborm **refuses** the shape (Prisma picks one silently). The `where` is the target's ordinary non-unique `where` — a precondition on the one connected record, not a selector. |
| W4-U4 JSON null sentinels | delivered, scope note | `78bd10a`; merged `656d40a` | A bare top-level `null` in JSON **write** position is refused (type-level and runtime), matching Prisma's `InputJsonValue`. Breaking; **D-6 sign-off is still open** — the reversal is ~10 lines and localized (see the D-6 row). A sentinel under a `path` is refused too (use `path` + `equals: null`). |

Merge record: `656d40a` (U2/U3/U4 cherry-picked in that order; disjoint engine surfaces, conflicts were prose and test wiring only).

### W5 — Client surface & errors

| Unit | Status | Landing commit(s) | Deliberate divergence / scope note |
|---|---|---|---|
| W5-U1 Raw SQL overhaul | delivered, scope note | `ad9901f`; merged `b9f7814` | **Breaking return types**: `$queryRaw` → `T[]`, `$executeRaw` → `number` (was the driver's `QueryResult<T>` envelope; `$executeRaw` also lost its type parameter). The pre-1.0 `(string, params?)` form survives **one release** behind a `warning`-channel deprecation notice. `$transaction([...])` refuses a raw operation with a typed V8003; `$queryRawTyped` does not exist (generated-client machinery viborm has no analogue for). |
| W5-U2 Prisma error codes | delivered, scope note | `5ce89c8`; merged `b9f7814` | **Deliberately partial.** Every error keeps its own `V####` code and adds `prismaCode` only where a Prisma counterpart exists. viborm-only families (transactions, nested writes, cache, migrations, V8003) report `undefined` rather than inventing a code. No SQLite P2000 — SQLite does not enforce declared column lengths, so there is no error to map. |
| W5-U3 Transaction options | delivered, scope note | `812a750`; merged `b9f7814` | Per D-2, the old "portable transactions accept no options" doctrine is reversed **partially**: each driver declares a contract and the resolver either honors the option or refuses it with a typed V8003 naming the reason. D1 / Neon HTTP refuse outright; SQLite honors `Serializable` by construction and refuses the weaker three. Never accept-and-ignore. Per-call only — there is still no client-construction `transactionOptions` default. |
| W5-U4 `omit` | delivered, scope note | `dd69992`; merged `b9f7814`; typing follow-up `49e611a` | Query-level and client-level `omit` desugar in validation into the `select` they denote — `omit` never reaches the engine. In the same unit, model-level `.omit()` became a **hard** exclusion: the field has neither a `select` nor an `omit` key, so the three layers rank schema > client > query. That is a divergence from Prisma's `@ignore`, which hides a field from the client while leaving it writable. |
| W5-U5 `$metrics` | **not shipped** | — | Withdrawn on a false premise, recorded in the W5 table: `PerfTracker` has no counters to expose and is never called by the client, engine or any driver. Shipping an empty or fabricated `$metrics` would be accept-and-ignore. Honest path recorded in the same row. |

### W6 — Type fidelity (breaking wave)

| Unit | Status | Landing commit(s) | Deliberate divergence / scope note |
|---|---|---|---|
| W6-U1 Decimal, string-backed | delivered, scope note | research `3014fa9`; core `8a74507`; legacy hatch `b399628`; docs `990fe1f`, `3b35a93`; migration surfacing `e76d144`; corrections `6f9c3d1`, `b0d320b`, `ad5803e`, `289530d` | **SQLite stores `TEXT`, not `REAL`** (`migrations/drivers/type-mapping.ts:45-50`): reads, writes and equality are exact, while **ordering, aggregation and atomic arithmetic are a typed `UnsupportedOperationError`** rather than a double-precision guess. The refusal is capability-driven (`supportsExactDecimal`), and after `6f9c3d1` it fires in **every spelling** — the first cut gated four call sites and missed six, so the common `orderBy` + `take` spelling walked past it and answered lexicographically. Decimal results are `string` everywhere, including `_sum`/`_avg`/`_min`/`_max` and through relations. A one-release `decimal: "number"` client option (`client.ts:186-196`) restores the old decode at runtime only. `CastType` gained `"decimal"`, split off from `"numeric"` — a public-adapter break taken deliberately in the breaking wave (`ad5803e`). |
| W6-U2 bun-sqlite BigInt hole | delivered, scope note | `eab63b3` | `safeIntegers(true)` on the typed read path only — `executeRaw` deliberately stays driver-native. Declared **required** on the internal `BunSQLiteStatement` interface, so a hand-written client object must provide it (deliberate break); an older Bun fails closed with `FeatureNotSupportedError` V8001 rather than returning a rounded number. The unit also fixed the constructor bug that meant this driver had **never executed a query**. |

Merge record: `42016f4` (both lanes; the four doc conflicts and their resolutions are tabulated in "W6 — integration record"). `6f9c3d1`, `b0d320b`, `ad5803e`, `289530d`, `3b35a93` landed on top of the merge.

### W7 — Ecosystem

| Unit | Status | Landing commit(s) | Note |
|---|---|---|---|
| W7-U1…U5 | **deferred** | — | Deferred 2026-07-26 by the maintainer ("too complex for now; revisit after W6 ships"). `$extends`, `$use`, full-text search, `db pull` emitter and `db seed` are all unshipped; the plan text is preserved below for when it reopens. D-4 stays deferred with it. |

### Decision register outcomes

D-1 removed `*AndReturn` (W3-U4). D-2 reversed the transaction-option doctrine partially (W5-U3). D-3 shipped string-backed Decimal with the one-release hatch (W6-U1). D-5 lifted the orderBy cap to 8 (W1-U7). **D-4 stays deferred with W7, and D-6 — the breaking refusal of a bare `null` in JSON write position, shipped in W4-U4 — is still awaiting explicit maintainer sign-off.**

---

## 0. Decision register (sign-off needed before the affected unit starts)

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D-1 | **`*AndReturn` fate.** Maintainer dislikes the explicit methods; wants implicit return when `select`/`include` is present on `createMany`/`updateMany`. | **RESOLVED 2026-07-26 (maintainer): REMOVE `createManyAndReturn`/`updateManyAndReturn` entirely — no aliases, no deprecation period.** The implicit form is the only surface. Accepted as a deliberate breaking divergence from Prisma's method names; document the migration (`createManyAndReturn(args)` → `createMany({ ...args, select })`). | W3-U4 |
| D-2 | **Transaction options doctrine.** `isolationLevel`/`timeout`/`maxWait` are *deliberately* rejected today ("portable transactions accept no options"). 1-1 replacement requires them. | Reverse the doctrine partially: accept the Prisma options object; honor `isolationLevel` + `timeout` on transaction-capable drivers, keep a **typed refusal** (V8003) on drivers that can't (D1, Neon HTTP) and for `maxWait` where no pool wait exists. Never silently ignore an option. | W5-U3 |
| D-3 | **Decimal representation.** `s.decimal()` is a lossy JS `number`. | String-backed by default (decode `numeric` → string, accept string \| number on write), with an optional `.as(DecimalClass)` hook for decimal.js users. Breaking change → needs a major-version flag or an opt-in `decimal: "string"` client option for one release. | W6-U1 |
| D-4 | **Full-text search scope.** Currently a non-goal; Prisma ships it as preview. | Defer (W7, optional). If done: PG `tsvector` + MySQL `MATCH…AGAINST`, typed refusal on SQLite (FTS5 needs virtual tables — out of scope). | W7 |
| D-5 | **`orderBy` to-one chain depth cap** (currently 3). | Lift to 8 with the existing strict-schema recursion; unbounded requires lazy self-reference in the orderBy schema — do that only if a user asks. | W1-U7 |
| D-6 | **Bare `null` in JSON write position.** Before W4-U4 it meant "SQL NULL". With `DbNull`/`JsonNull` in the language it no longer says which null it means. Prisma refuses it (`InputJsonValue` disallows a top-level `null`, `@prisma/client` `runtime/client.d.ts`). | **SHIPPED AS REFUSED in W4-U4** (type-level + runtime, message names the sentinel to use) — the parity-exact and fail-closed reading. **This is a breaking change and wants explicit maintainer sign-off.** If the answer is "keep the old meaning", the reversal is small and localized: drop the `value === null` branch in `jsonWrite` ([validation/primitives/json-null.ts](../../src/validation/primitives/json-null.ts)) and widen `JsonWriteSchema`'s input back from `Exclude<…, null>`; the five estate call sites updated to `DbNull` can stay as they are. | W4-U4 (shipped) |

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

### W4-U1 — DELIVERED

**Surface.** `getWhereUniqueExtendedSchema` (`src/validation/model/core/where.ts`) is the
`where` of the five TOP-LEVEL operations only. It is the discriminator entries applied LAST over
a scalar-only recursive `where`, so a unique field keeps Prisma's bare-value spelling at the top
level and is an ordinary filter inside `AND`/`OR`/`NOT`. The at-least-one rule is the object
schema's existing `requiresOneOf`, which its type level already renders as Prisma's `AtLeast<…>`
union — **no new type machinery, so the recursive-model-inference landmine was never touched**
(`tsc --noEmit` clean, and the client/model expectTypeOf suites pass unchanged). The strict
`whereUnique` stays on `cursor` and every nested relation-write target selector.

**Where the discriminator/filter split lives, and why there.** In the EXTRACTION function
(`partitionWhereUnique`, `src/query-engine/builders/where-unique-builder.ts`), not at the call
sites. `buildWhereUnique` compiles `discriminator ∧ filters`; `getWhereUniqueEntries` returns the
discriminator alone. Every compile-time-literal consumer already went through that one door, so
none of them changed:

| Consumer | How it gets the discriminator now |
|---|---|
| Pin Rule — nested-create parent pin (`UpdateOperation.resolveLiteralCreateParent`, ×2 sites) | `getWhereUniqueEntries` — unchanged call, filters are simply not in the returned entries |
| racePin attribution (`uniqueConflictTarget` → `racePinMatches`) | `partitionWhereUnique`; **fixed** — the constraint NAME was read from the first raw `where` key, which an extended `where` can make a filter |
| Occupied-guard / referenced-key transition (`interpretReferencedKeyTransition`) | `getWhereUniqueEntries` — unchanged |
| Own-write ledger target constraints (`TargetConstraint`, `getKnownSelectorValues`) | `getWhereUniqueEntries` — unchanged; a discriminator-only constraint is a SUPERSET of thetrue target, so overlap analysis stays conservative (fails closed) |
| upsert probe-first locate (`buildConditionals`) | `getWhereUniqueEntries` for the equalities, **plus** the filter half ANDed in — a probe wants the same predicate the locate used |
| upsert create-arm terminal read | **fixed — it does not read the `where` at all** (see the correction below). The row a write produced is addressed by the identity of that write: the literal PK the `create` data carries, or the DB-generated identity the INSERT captures |
| Cursor comparison (`find-pagination`) | unreachable — `cursor` keeps the strict schema |

**The racePin decision.** With an extended `where`, upsert's create arm carries NO `racePin`. A
racePin asserts "the locate proved key K free"; with filters the locate proved only that no row
matches `K ∧ filters`, so a violation is a genuine conflict a re-plan cannot converge on. The
`UniqueConstraintError` surfaces on the first attempt — the P2002-equivalent this unit's brief
named — instead of buying one pointless retry and labelling it raceable.

**Divergences from Prisma, both refused rather than half-answered** (stated in
`docs/content/docs/client/{find-unique,update,delete,upsert,compatibility}.mdx`): relation
filters inside a unique `where` (the filter half compiles into UPDATE/DELETE, where the target
carries no alias and MySQL rejects a subquery reading the mutated table — error 1093), and nested
target selectors / `cursor`, which keep the strict schema.

**Evidence.** `tests/query-engine-v2/extended-where-unique-behavior.ts` — 21 cases × PGlite
tx/batch, SQLite3 tx/batch, LibSQL tx/batch, pg tx/batch, MySQL2 tx (a batch-only MySQL is
non-returning, so the routed layer refuses this write family before I/O). Three staleness
injections in `staleness-injection.test.ts` (filter premise under update and delete, discriminator
premise unchanged), both filter cases falsified by making the root-presence guard drop the
filters — the update case then returned a successful no-op, which is the exact silence this unit
forbade. The Pin Rule falsification is structural: the create-arm racePin asserted PRESENT for a
plain `where` and ABSENT for an extended one.

**Correction (review round U1) — the create-arm read-back reads the WRITE, not the `where`.**
The first cut of this unit answered the create arm's terminal read with the unique DISCRIMINATOR
of the `where`, on the premise that "the created row satisfies the discriminator, not the
filter". That premise is false: Prisma never requires `create` to satisfy `where`, so a `create`
that writes a *different* value for the discriminator's column produces a row the discriminator
does not name. W4-U1 is what made the falsifying state reachable — with a plain `where` a
discriminator matching a live row always takes the UPDATE arm, so the create arm could never
coexist with a live row on that key; the extended `where` makes exactly that reachable (unique
key matches, filter excludes → create arm), and the discriminator-only read-back then addressed
the EXCLUDED row. The upsert returned a pre-existing row it had never touched, silently, on every
dialect and both substrates. (With a plain `where` the same class failed loudly instead — the
read matched zero rows.)

The fix removes the `where` from this decision entirely. `UpsertOperation.createArmIdentity`
decides, from the CREATE DATA, how the row about to be inserted will be addressed.
`getWhereUniqueDiscriminator` had no other consumer and is deleted, so the wrong door is gone
rather than merely unused.

**Amendment (review round U1b) — three identity sources, capture-free first.** The first cut of
the fix accepted only two sources, and reviewers falsified two of the claims made around it with
live probes. The decision now runs through three sources, in this order:

1. **literal primary key** — the create data carries every PK field;
2. **a COMPLETE unique constraint of the model carried by the create data** — a single
   `.unique()` column, or every column of one compound unique. The database enforces that at most
   one row holds those values, and this INSERT just wrote a row holding them, so the constraint
   names exactly that row. Like (1) it is derived from the create data and never consults the
   `where`, so it is immune to the wrong-row bug even when a different LIVE row satisfies the
   `where`;
3. **a captured DB-generated identity** — a single `increment` PK the create data omits, captured
   as `… RETURNING pk` on a returning driver in transaction mode, else the driver's `insertId`
   scratch-threaded by the executor.

A create payload spelling none of the three names no row this operation can read back and is
refused with a typed `UnsupportedOperationError`, raised only when the create arm is actually
taken. A value that is NULL, raw `Sql`, a batch-value reference, a list or a JSON object is not
an identity for (2): SQL unique constraints do not equate NULLs, and the rest are not values the
compile-time read-back can be sure the INSERT wrote.

**Why (2) outranks (3) uniformly, not just in batch mode.** All three are equally correct; (1)
and (2) are additionally CAPTURE-FREE — a plain INSERT with no output — while (3) makes the
statement depend on the execution mode and the driver. That `insertId` scratch is per-operation
state a SHARED driver batch cannot isolate, so `OperationExecutor.prepareSharedBatch` refuses an
operation carrying it: before this amendment, `client.$transaction([ ticket.upsert({…}) ])` on a
batch-only driver (D1/Neon class) threw `TransactionError` whenever the create arm was taken —
data-dependently, since the update arm captures nothing. Compile cannot see whether it will be
merged into a shared batch, so a batch-mode-only preference would leave that reachable for the
mainstream model (single `increment` PK plus a unique in the create data). Preferring the
capture-free identity always yields ONE compiled shape per (model, args) pair on every substrate
and driver, and shrinks the refusal to the shapes that genuinely have no other identity.

**What the refusal costs — the corrected claim.** The first cut's census note asserted "no shape
that previously ANSWERED is refused". That was false, and reviewers proved it: a compound PK with
one `increment` member whose `create` carries some other complete unique — `.id(["tenantId",
"seq"])` with `seq` generated and a unique `email` — answered at `ea1f637^` and then threw. It
had answered only *through* the discriminator read-back, i.e. by the very mechanism that returned
wrong rows; source (2) restores it on a create-data identity, so it answers again and answers
correctly (witnessed on both arms, and with a wrong-row case, in
`extended-where-unique.test.ts`). What stays refused is a create payload with no complete identity
of any kind — chiefly a generated COMPOUND PK with no other unique. That cost is bounded, and the
bound is now pinned by a test rather than asserted: a single-row `create` on such a model is
ALREADY refused upstream by `mutation-identity.ts`'s generated-compound-PK guard, while
`createMany` and reads work.

**Witnesses.** Each identity source has its own behavioral witness on its own fixture, so no
witness can pass because another source happens to agree with the `where`: `account` (literal PK)
with a `create` that reproduces neither the `where`'s discriminator nor its PK; `ticket`
(generated PK, unique `email` in the create data) for source (2); and `note` — generated PK and
NO other unique, added precisely because `ticket` no longer reaches the capture — for source (3).
Restoring the discriminator read-back on the literal-PK branch fails the `account` witness on both
substrates with the seeded row returned in place of the created one; restoring it on the source-(2)
branch fails the `ticket` witnesses the same way. The counter-falsification is retained — a
MATCHING filter on a generated-PK model still takes the update arm, so no source is passing by
turning every extended-`where` upsert into a create. The array form is covered in the shared
conventions (create arm, update arm, and a plain multi-operation array), so the batch-only leg
exercises the shared-batch merge on every one; the refusal that legitimately remains is pinned
against `note` on the batch-only driver, alongside the proof that the same operation still runs on
its own atomic unit.

### W4-U2 — DELIVERED

**Surface.** An optional non-negative integer `limit` on `updateMany` and `deleteMany`
(`bulkWriteLimit`, `src/validation/model/args/pagination.ts`, wired into `getUpdateManyArgs` /
`getDeleteManyArgs`). Because the client's arg types are inferred from those schemas, the key
appears on the typed surface with no separate type work. It covers the implicit-returning arm too
— `updateMany`/`deleteMany` **with a `select`** hand back exactly the affected rows, so a capped
call returns at most `limit` of them.

**The contract is HOW MANY, not WHICH.** A bulk write takes no `orderBy`, so the affected subset
is whatever the database reaches first, and the two dialect spellings genuinely reach different
rows. This is Prisma's hole as much as ours, and it is stated as a divergence-shaped warning in
`docs/content/docs/client/{update-many,delete-many}.mdx` rather than papered over: nothing in the
implementation invents an ordering, and no test asserts row identity. What IS portable, and is
pinned on every dialect: the count is `min(matching, limit)`; rows outside the `where` are never
touched at any limit; the `select` arm returns exactly the rows that changed.

**Two spellings, chosen by capability.** A new `supportsMutationRowLimit` capability
(`src/adapters/adapter-capabilities.ts`) — true on MySQL only — selects between them in
`buildBulkLimitWhere` (`src/query-engine/operations/bulk-limit.ts`), which both `buildUpdateMany`
and `buildDeleteMany` call:

| Dialect | Form | Why not the other one |
|---|---|---|
| MySQL | native `UPDATE\|DELETE … LIMIT n` suffix; `WHERE` untouched | the PK subquery would read the mutated table — ERROR 1093, the same restriction the relation-filter derived-table wrapper already exists for. Leaving the `WHERE` alone is also why the cap composes with that wrapper for free |
| PostgreSQL, SQLite | `WHERE (pk…) IN (SELECT pk… FROM t WHERE <filter> LIMIT n)` | neither dialect has `UPDATE … LIMIT` (SQLite needs `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, off in better-sqlite3 / libSQL / D1) |

The subquery is built by `buildFind` on a fresh scope, so it carries the user's filter verbatim
and gets its own alias. **Compound primary keys are supported, not refused**: the row-value form
`(a, b) IN (SELECT a, b …)` is accepted by PostgreSQL and by SQLite ≥ 3.15, verified behaviorally
on PGlite, better-sqlite3 and libSQL — so the `v.refused` escape the brief allowed for was not
needed.

**The non-returning `select` arm caps its capture, not its write.** On MySQL,
`ManyAndReturnOperation` already locks the target PK set at planning and addresses both the write
and the re-read by those captured PKs. `limit` is therefore applied to that capture
(`buildPkCapture` passes it to `buildFind`), which caps everything downstream — the native
`UPDATE … LIMIT` is never needed in this arm.

**`limit: 0` sends no statement.** Both arms short-circuit in the operation layer
(`BulkCountOperation.write` is `undefined`; `ManyAndReturnOperation` takes the empty static plan)
and answer `{ count: 0 }` / `[]` from nothing. A `LIMIT 0` write would be a pointless round trip,
and on the PK-subquery dialects it would still take locks.

**Evidence.** `tests/drivers/bulk-write-limit-behavior.ts` — 16 cases wired into PGlite, SQLite3,
LibSQL and MySQL2 (the Docker MySQL leg is where the ERROR 1093 composition and the native-LIMIT
arm are actually executed). `tests/query-engine-v2/bulk-write-limit-plan.test.ts` — 13 structural
cases for the two things a behavioral test cannot see: that `limit: 0` compiles to zero steps, and
which spelling each dialect got. Falsified three ways: making `buildBulkLimitWhere` ignore the
limit fails 9 driver cases + 5 plan cases; removing the `limit: 0` short-circuit fails 3 plan
cases; uncapping the MySQL planning capture fails 1. Each falsification has a paired control (no
`limit` ⇒ neither form appears; `limit: 1` ⇒ a write is compiled) so the assertions cannot pass
vacuously.

### W4-U3 — DELIVERED

**Surface.** A to-one relation's nested `update` accepts bare data OR Prisma 5's
`{ where?, data }` envelope. The envelope's `where` is the target model's ordinary
(NON-unique) `where` — a to-one has exactly one connected record, so it is a
**precondition on that record**, not a selector among candidates. A connected row that
fails it makes the operation a `NestedWriteError` (`Cannot update relation '…': target
record was not found for this parent.`, the P2025-equivalent this family already
raises) and the whole tree — the root scalar SET and every sibling nested write — rolls
back, identically in transaction and atomic-batch mode.

**The one home for the discrimination rule** is `src/validation/relations/to-one-update-form.ts`:
an object carrying a `data` key whose value is a plain object has the envelope's SHAPE,
anything else is bare data — Prisma's own rule, applied STRUCTURALLY rather than by union
try-order. The relation update schema dispatches on it (`toOneUpdateTargetFactory`,
mirroring `toOneFilterFactory`'s deterministic-dispatch union, so a malformed envelope
reports the envelope's own error instead of a union-wide miss). On a target that owns an
update key named `data` that shape has two meanings and the rule REFUSES it — see the
collision paragraph below.

**The trap this unit had to disarm, and how it is actually disarmed.** The rule may only
be read off the USER's payload, never a schema output: `core.update` rewrites the scalar
shorthand, so on a model that owns a field named `data` the BARE `{ data: 7 }` parses to
`{ data: { set: 7 } }` — which the structural rule then reads as an envelope, silently
dropping the assignment ("No fields to update"). The first delivery threaded the raw
payload alongside the parsed one (`splitToOneUpdateTarget(parsed, raw)`) and took the
FORM from `raw`. That works only where a raw payload exists, i.e. at an update ROOT: one
level deeper the engine walks the enclosing whole-args parse OUTPUT, so `raw` defaulted
to `parsed` and the two readings disagreed again — the `data`-named collision regressed
at depth ≥ 2 (in-place, "No fields to update") and under an X1c delegated target
(re-parse, "Unknown key: set"). **The fix round replaced the threading with
canonicalization**: `toOneUpdateTargetFactory` emits the SAME `{ data, where? }` envelope
for BOTH spellings, so the rule is applied exactly ONCE, at the only place that sees the
user's payload, and no later reader re-derives it. `splitToOneUpdateTarget(parsed)` is now
a projection of that envelope and fails closed on anything else. The envelope is also
SELF-DESCRIBING — on a `data`-owning target it carries the empty `where` marker, so it
reads back as the envelope rather than as bare data, and no reader can resolve the form
differently than the schema did. Witnessed by `a target field named 'data' reads the same
way at depth` and `… under a delegated target`.

**Superseded by the parse-once fix (X1c re-parse defect).** This paragraph used to justify
the marker by IDEMPOTENCE — "the envelope always takes the wrapper arm the second time,
which is what makes the X1c nested-target delegation, which re-parses an already-parsed
subtree, meaning-preserving". Both halves are now wrong. The delegation no longer re-parses
anything: re-parsing a parse OUTPUT is not a no-op, and doing it persisted the ORM's own
`{ set: … }` JSON envelope as the user's data (fixed in `Parse the delegated update
target's data once, not twice`; recorded in [ATOM §X1c](../../src/query-engine-v2/ATOM.md)
and [PLAN §X1c](../../src/query-engine-v2/PLAN.md)). And idempotence at the ENVELOPE level
never protected what was inside it — which is exactly why the JSON write broke through it.
What keeps the two witnesses green is that the form is decided ONCE, at the parse boundary,
from the user's payload; nothing re-derives it downstream.

Consequently the `where: {}` marker is now INERT for the engine — nothing re-reads the
envelope through the schema. **Measured, not assumed:** with `toOneUpdateEnvelope` mutated
to drop the marker (`return { data }` unconditionally), `to-one-update-where.test.ts` still
passes 38/38, both named witnesses included. So the old closing claim — "both of which fail
if the canonicalization is removed" — no longer holds for the marker. The marker is kept
because it keeps the output honest about its own form for any future reader, not because a
compiled step depends on it; `splitToOneUpdateTarget` drops an empty `where`.

**The collision, and why it is a REFUSAL (fix round 2).** On a target that owns an update
key named `data`, the envelope's shape is ALSO how bare data spells that field. The first
two deliveries resolved it by fiat — "the object payload reads as the envelope" — and the
only witness was `box.data`, an INT, where the envelope reading errors by accident
(`{ set: 9 }` is not a valid `box` update). On a JSON column every object is both a legal
value and a plausible update payload, and the fiat then WROTE THE WRONG COLUMN with no
error: on `blob { id, data: json, label, owner }`, `update: { data: { label: "x" } }` set
the `label` COLUMN and left the document alone, and `update: { data: { owner: { disconnect:
true } } }` executed a real FK disconnect from what was meant to be stored data. Resolving
it by validity instead — "whichever arm parses" — would have been worse: the FORM would
depend on the DATA, so the same spelling would store `{ seed: true }` and rewrite columns
for `{ label: "x" }`.

So the shape is REFUSED on such a target (`AMBIGUOUS_TO_ONE_UPDATE`), before any write,
and the message names the two spellings that are not ambiguous — both explicit envelopes,
since a `where` key cannot be bare update data:

```
update: { where: {}, data: { … } }          update the target's fields
update: { where: {}, data: { data: … } }    write the target's `data` field
```

Nothing else changes: a non-object payload (`update: { data: 7 }`, or any class instance —
a `Date`, a `Decimal`, a `JsonNull` sentinel, which `isPlainObject` now excludes) never had
the envelope's shape and stays bare, and a target without a `data` key reads exactly as
before. The refusal is a RUNTIME one: the declared union still accepts both spellings at
the type level, because narrowing it would mean a conditional over the target's own update
input on a mutually-recursive model type.

The canonical envelope for such a target carries an empty `where` marker (`{ where: {},
data }`), so the output stays honest about its own form for any reader that meets it;
`splitToOneUpdateTarget` drops an empty `where`, so not one compiled step changes.
Falsified: forcing the old "always the envelope" reading fails 8 cases.

**Amended by the parse-once fix.** This paragraph used to add that the marker "is what
stops the X1c delegated re-parse from re-reading the schema's own output as the ambiguous
spelling", falsified by "dropping the marker fails the delegated-target case with the
ambiguity refusal". Neither survives: the delegation no longer re-parses (see the
superseded-claim note under W4-U3 above), so there is no second read for the marker to
protect, and the falsification no longer falsifies — **measured**, with
`toOneUpdateEnvelope` returning `{ data }` unconditionally, `to-one-update-where.test.ts`
passes 38/38. The marker is retained as an honest self-description, not as load-bearing
machinery; only the "always the envelope" mutation above still bites.

Prisma has the same collision and resolves it by fiat. This is a deliberate, documented
divergence: under this repo's doctrine an accepted write that lands somewhere other than
where the caller wrote it is not shippable, and a typed refusal is.

**Where the filter is compiled.** Into the planning LOCATE, and in batch mode into the
existing split-witness presence guard — never into the WRITE, which addresses the
primary key the locate captured. No new step, no new guard, no fragment-vocabulary
change: `NestedTargetLocate.filter` (the X1c delegated paths),
`RelationWriteConfig.targetFilter` (the inverse-side in-place path) and
`parentHeldProbeStatement`'s filter argument (the parent-held in-place path) all AND one
extra `WhereInput` term into a read that already existed. Because it never reaches the
write statement, a RELATION filter inside the envelope's `where` IS portable here —
unlike inside a top-level extended unique `where`, which W4-U1 refuses for exactly that
reason (MySQL error 1093 on a subquery reading the mutated table).

**Evidence.** `tests/query-engine-v2/to-one-update-where-behavior.ts` — 16 cases ×
PGlite tx/batch, SQLite3 tx/batch, LibSQL tx/batch, pg tx/batch, MySQL2 tx — covering
all four engine paths a to-one `update` can take (parent-held in-place, parent-held
delegated, inverse-side in-place, inverse-side delegated) plus the depth path, each with
filter hit AND filter miss, the miss asserting a full-tree snapshot equal to the seed.
Plus a relation filter in the envelope `where`, `AND`/`OR`/`NOT`, an empty `where`, the
`data`-named-field refusal and its escape at the ROOT, at DEPTH and under a DELEGATED
target, and bare-form regression witnesses on both directions and at depth. The 16th case
is the JSON witness the int-typed `box` could not carry — `blob.data` with the two
wrong-writes above and a document naming nothing at all, each asserting the ambiguity
refusal AND a whole-tree snapshot equal to the seed, plus the escape, plain bare data and
a `JsonNull` sentinel all still writing what they say.

`to-one-update-where.test.ts` pins the mechanism per direction (parent-held and
inverse-side build their guards from different code, so both are asserted):
- WHERE the filter lands — present in the probe SQL, absent from the write SQL, with the
  bare form as the falsification (its probe carries no filter at all, and its write SQL
  is byte-equal to the envelope's);
- that the batch guard's **premise** carries the filter (`guard.premise.statement`), not
  merely that a guard exists — the count-only version of this assertion passed with the
  filter deleted from the parent-held guard, so it was replaced;
- a STALENESS-INJECTION witness (PLAN P2a instrument 3): a before-batch hook makes the
  connected record stop matching the envelope `where` after planning decided it did, and
  the batch must abort with the typed not-found failure, whole tree unchanged. This is
  the only protection on the transaction-less drivers (MySQL, D1), and both it and the
  premise assertion fail when the filter is dropped from the guard.

### W4-U4 — DELIVERED

**Surface.** `DbNull` / `JsonNull` / `AnyNull` are exported from the package root and from
`viborm/schema` ([src/schema/json-null.ts](../../src/schema/json-null.ts)). They are frozen
CLASS instances, not plain objects, and that is load-bearing: `v.json()` accepts an arbitrary
plain object, so a plain-object token would type-check as an ordinary document and could be
PERSISTED — the same hazard field references have. A class prototype fails `isJsonValue`, so a
sentinel nested anywhere inside a document (`{ a: DbNull }`) is refused structurally instead of
landing in the column as `{}`. The `kind` is an own ENUMERABLE string key as well as a symbol
brand, because the cache key builder walks `Object.keys`: three symbol-only tokens would all
hash as `{}` and collide `equals: DbNull` with `equals: JsonNull` in one cache entry.

**Where the two nulls part ways.** Exactly two places, both in the V1 SQL substrate.
Writes: `jsonNullWriteValue` in [values-builder.ts](../../src/query-engine/builders/values-builder.ts)
(`DbNull` → `literals.null()`, `JsonNull` → `literals.json(null)`), reached from the two value
chokepoints `buildScalarSqlValue` and `scalarValueLiteral`, so create, createMany, update SET,
upsert arms and nested writes all inherit it. Filters: `buildJsonNullSentinelFilter` in
[json-filter-builder.ts](../../src/query-engine/builders/json-filter-builder.ts), which both
`equals` and `not` consult BEFORE their generic branches (a sentinel is an object; the `not` arm
would otherwise have read its keys as filter operations). The portability argument is one line:
the filter compares against `adapter.json.value(null)` and the write stores
`adapter.literals.json(null)` — the SAME `'null'` parameter on every dialect — pinned per dialect
in `tests/query-engine/json-null-sentinel-sql.test.ts`.

**The truth table** (identical on PG jsonb, MySQL JSON, SQLite TEXT-json): `equals: DbNull` →
`IS NULL`; `equals: JsonNull` → `= 'null'`; `equals: AnyNull` → the disjunction; `not: DbNull` →
`IS NOT NULL` (total — it matches JSON nulls); `not: JsonNull` → `<> 'null'` (SQL-NULL rows drop
out, exactly as they already do for `not: { equals: <document> }`); `not: AnyNull` → the
conjunction of both complements.

**Deliberate refusals.** `AnyNull` in write position (Prisma: filter-only — "either null" is a
question, not a value). `DbNull` on a non-nullable JSON field, by name, instead of deferring to a
NOT NULL violation from the database. A sentinel combined with `path`: `DbNull` would have to
ignore the path, and "JSON null at this path" already has a pinned spelling (`path` +
`equals: null`), so answering a different question than the one asked is refused.

**BREAKING (needs maintainer sign-off — see D-6): a bare top-level `null` in JSON write position
is now refused**, at the type level and at runtime, with a message naming the sentinel to use.
This is Prisma's own rule, verified against the shipped client rather than from memory:
`@prisma/client`'s `runtime/client.d.ts` documents `InputJsonValue` as disallowing `null` at the
top level because its meaning would be ambiguous, and directs callers to `Prisma.JsonNull` /
`Prisma.DbNull`. Only the TOP level is affected — `{ a: null }` is an ordinary document. The
write type is exported as `InputJsonValue`. Blast radius measured before the change: five estate
call sites, all updated to `DbNull` (`list-json-filter-behavior.ts` ×2, `all-field-types.test.ts`
×2, `relation-types.test.ts`), plus the `scalar-roundtrip` fixture retyped to `InputJsonValue`
and the json scalar-schema pins rewritten to the new rule.

**What did NOT change, and is pinned so it cannot drift:** a bare `null` in FILTER position keeps
its pre-sentinel meaning — the SQL NULL at the root, the JSON null under a `path`. Regression
witnesses were captured BEFORE any edit and kept, in all three suites (validation, per-dialect
SQL, execution).

**Evidence.** `tests/drivers/json-null-sentinel-behavior.ts` (19 tests, wired into pglite, pg,
sqlite3, libsql and mysql2 — Docker legs pick up the last two);
`tests/query-engine/json-null-sentinel-sql.test.ts` (30, three dialects including MySQL, which
has no local execution leg); `tests/validation/json-null-sentinels.test.ts` (13, including the
cache-key collision and the nested-sentinel hazard); type-level assertability in
`tests/client/all-field-types.test.ts` (three `@ts-expect-error` directives, falsified by
inverting one and watching `tsc` report the unused directive).

### W4-U2/U3/U4 — merge note

The three lanes were developed in parallel worktrees and cherry-picked onto `prisma-parity-v2`
in the order U2 → U3 → U4. They touch **disjoint** engine surfaces (bulk-write `LIMIT`
realization; the to-one nested-`update` envelope; the JSON null sentinels), so the only
conflicts were shared prose and shared test wiring:

- **`prisma-parity-v2-plan.md`** — each lane appended its own `### W4-Ux — DELIVERED` section at
  the same offset. Resolved by keeping all three, in unit order. No sentence from any lane was
  dropped or rewritten.
- **`capability-matrix-2026-07.md`, `compatibility.mdx`** — different rows of the same tables,
  auto-merged; each lane's row was re-read after the merge and says what its lane shipped.
- **`tests/drivers/{pglite,sqlite3,libsql,mysql2,pg,postgres}.test.ts`** — U2 and U4 both add a
  `run…Behavior` import and registration to the same driver files; U3 adds one to four of them.
  All registrations survive; the import blocks were re-sorted (`biome check --write`, assist
  only) because the three-way merge left `bulk-write-limit-behavior` and
  `json-null-sentinel-behavior` out of order, which `assist/source/organizeImports` reports as
  an error. Import order only — no registration added, removed or reordered.

Post-merge estate: `tsc --noEmit` clean, full `vitest run` **7238 passed / 0 failed** (215 files,
3 skipped), `test:gates` **43/43**. Biome on the 46 touched files reports **31 errors, identical
to the pre-merge baseline on the same files** (`noMisplacedAssertion` ×26 in
`scalar-roundtrip-behavior.ts`, `noDelete` ×2, `useTopLevelRegex`, `useForOf` — all pre-existing),
plus 4 `suppressions/unused` **warnings** in the new `json-null-sentinel-behavior.ts`
(`biome-ignore lint/suspicious/noExplicitAny` comments over `as any` casts the rule does not
actually flag there). The merge introduced no new Biome error.

**Docker legs are NOT covered by the above** — none of the three lanes ran them, by instruction.
MySQL carries the most unverified surface: it is the only dialect taking U2's native
`UPDATE|DELETE … LIMIT` path (and the only place that cap has to coexist with the ERROR 1093
derived-table wrapper), the only one needing an explicit `CAST(? AS JSON)` for U4's JSON-null
operand, and it is transaction-only for U3. Real-pg carries U2's bound-`LIMIT`-inside-a-subquery
parameter ordering.

**Two open maintainer decisions carried in from the lanes, neither resolved by this merge:**
D-6 (U4's breaking refusal of a bare top-level `null` in JSON write position — reversal is
~10 lines, see the D-6 row); and U2's deliberately unspecified "which rows" contract for a
capped bulk write (PG/SQLite pick the lowest PKs because the subquery inherits `buildFind`'s
stability ordering, MySQL picks whatever it reaches first — an `ORDER BY pk` on MySQL's
`UPDATE … LIMIT` would make the choice portable at the cost of a forced sort on every capped
bulk write, for a guarantee Prisma does not make).

---

## W5 — Client surface & errors (all units independent → fully parallel)

| Unit | Size | What | Acceptance |
|---|---|---|---|
| W5-U1 ✅ | M | **DELIVERED.** See "W5-U1 — delivered" below. **Raw SQL overhaul.** `$queryRaw` becomes a tagged template (safe-by-construction); the current `(string, params)` form moves to `$queryRawUnsafe` (keep an overload on `$queryRaw` detecting a plain string for one release, with a deprecation warning in the `warning` log channel). Add `$executeRaw` tagged + `$executeRawUnsafe`. Export `sql`/`join`/`empty`/`raw` from the package root (`Sql` class already dialect-renders via `toStatement`). Wire `tx.$queryRaw`/`tx.$executeRaw` into the tx proxy (today it throws `Model "$executeRaw" not found`). | tagged interpolation parameterizes on all dialects; `join` accepts plain values (Prisma parity); tx raw runs inside the open transaction (single-connection drivers verified) |
| W5-U2 ✅ | S/M | **DELIVERED.** See "W5-U2 — delivered" below. **Prisma error-code compatibility.** Add `prismaCode` to `VibORMError` (V3001→`P2002`, V3002→`P2003`, V3003→`P2011`, V6001→`P2025`, V4001→validation, per the matrix table); map the missing **P2000** (PG `22001`, MySQL `1406` value-too-long) to a typed error instead of generic `QueryError`; add a typed client-construction error (PrismaClientInitializationError-equivalent). | `e.prismaCode === 'P2002'` works in a catch written for Prisma; P2000 mapping covered in the error-mapping suite for all dialects |
| W5-U3 ✅ | M | **DELIVERED.** See "W5-U3 delivered" below. **Transaction options (per D-2).** Accept `{ isolationLevel, timeout, maxWait }` on both `$transaction` forms. Honor isolationLevel (SET TRANSACTION ISOLATION LEVEL per dialect) + timeout (driver-side timer aborting/rolling back) on transaction-capable drivers; V8003 typed refusal on D1/Neon HTTP and for unsupported levels (SQLite has only its journal modes — map or refuse, pin the choice). Replaces `assertNoTransactionOptions` and its 11-driver pinned tests deliberately. | Serializable conflict produces the dialect's serialization error, mapped; timeout rolls back cleanly; refusals typed, never silent |
| W5-U4 ✅ | M | **DELIVERED.** See "W5-U4 — DELIVERED" below. **`omit`** — query-level (`omit: { field: true }` on every read/write-returning op, exclusive with `select`) and client-level (`createClient({ omit: { user: { password: true } } })`), matching Prisma's local-overrides-global rule (`omit: { field: false }` re-includes). Composes with the existing model-level `.omit()`. | type-level result excludes omitted keys; nested omit in include; global+local precedence matrix tested |
| W5-U5 ❌ | S (optional) | **NOT SHIPPED — false premise.** "Expose the internal `PerfTracker` counters" assumes counters that do not exist: `src/instrumentation/perf-tracker.ts` is a start/end tree timer with no counters, gauges or histograms, and `createPerfTracker` is called only from `scripts/perf-test.ts` — never by the client, engine or any driver, so nothing collects at runtime. A Prisma-shaped `$metrics.json()` would need the counter substrate built first (always-on instrumentation in the execution and connection paths, an overhead budget, and per-driver pool introspection the driver interface does not expose). Shipping an empty or fabricated `$metrics` would be accept-and-ignore, so nothing shipped. Honest path if wanted: the logging pipeline already emits per-query durations (`LogEvent.duration`), enough to back `queries_total` + a duration histogram; pool gauges have no source today. | — |

### W5-U1 — delivered (raw SQL overhaul)

Landed as `src/client/raw.ts` (the whole surface, one module) wired into the
client proxy and the interactive-transaction proxy in `src/client/client.ts`.

**The deliberate break: return types.** `$queryRaw` and `$executeRaw` used to
answer the driver's `QueryResult<T>` envelope (`{ rows, rowCount, insertId? }`).
They now answer Prisma's shapes:

| Method | Before | After |
|---|---|---|
| `$queryRaw` | `Promise<QueryResult<T>>` | `Promise<T[]>` — the rows |
| `$executeRaw` | `Promise<QueryResult<T>>` | `Promise<number>` — the affected count |

`$executeRaw` also lost its type parameter (a count has no row type). Every
call site in the repo was migrated deliberately, not shimmed:
`tests/drivers/client-raw-behavior.ts` (the cross-driver suite, rewritten
around the tagged forms and the new Unsafe ones), `tests/client/operations.test.ts`,
`tests/client/batch-transaction.test.ts` and `tests/cli/migrate.test.ts`
(string-form cleanups → `$executeRawUnsafe`/`$queryRawUnsafe`), and
`tests/instrumentation/driver-context-concurrency.test.ts` (→ `$queryRawUnsafe`,
so the pinned operation token is now `$queryRawUnsafe`).

The rest of the unit as delivered:

- **Tagged templates.** `$queryRaw`/`$executeRaw` detect a `TemplateStringsArray`
  first argument and build an `Sql`, so every interpolation is a bound
  parameter rendered per dialect by `toStatement`. A prebuilt `Sql` fragment is
  accepted too; a fragment **plus** extra values is refused (`V4002`) rather
  than silently dropping the extras.
- **One release of compat.** A plain-string first argument still runs the old
  `(sql, params?)` path — including its "one array argument is the parameter
  list" spelling — and emits a deprecation notice once per method, per client,
  on the `warning` log channel. That notice rides a new `deprecation` key added
  to the log-metadata allowlist in `src/errors/diagnostics.ts` (ORM-authored
  constant text, never user data).
- **Unsafe variants.** `$queryRawUnsafe(sql, ...params)` /
  `$executeRawUnsafe(sql, ...params)` with Prisma's exact signatures.
- **Helpers exported.** `sql`, `join`, `empty`, `raw`, `Sql`, `isSql` from the
  package root, plus a new `viborm/sql` subpath (`package.json` exports +
  `tsdown.config.ts` entry). `join` now takes `RawValue[]`, so plain values
  become bound parameters (Prisma parity) while nested fragments still splice.
  `raw` gained Prisma's `raw(string)` unsafe-splice overload alongside the
  tagged-template form the adapters already use.
- **Transaction client.** `tx.$queryRaw` / `tx.$executeRaw` / both Unsafe
  variants exist on the interactive tx proxy, bound to the **transaction-bound
  driver**, so they share the single connection with model operations and roll
  back with them. New exported type `TransactionClient<C>` names that surface.
- **Array form stays model-only.** A raw promise is tagged with a symbol, and
  `$transaction([...])` refuses it with a typed `UnsupportedOperationError`
  (V8003) naming the interactive form — distinct from the generic
  `InvalidTransactionInputError` a non-operation still gets.

Coverage: `tests/client/raw-sql.test.ts` (40 tests, PGlite + better-sqlite3)
probes the real query log to prove binding vs splicing, plus tx visibility and
rollback, helper semantics, the once-per-method notice, the array-form refusal,
and the type-level `T[]`/`number` contract. Falsified: removing the once-guard,
removing the raw-in-batch refusal, splicing instead of binding, and pointing
tx raw at the root driver each turn the suite red. Docs:
`docs/content/docs/client/raw-sql.mdx` (new page), compatibility matrix rows,
README.
### W5-U2 — delivered (Prisma error codes)

`VibORMError` gained a `prismaCode` getter backed by
`PRISMA_CODE_BY_VIBORM_CODE` in `src/errors/base.ts` — a `ReadonlyMap` keyed by
`VibORMErrorCode`, so a typo'd code fails `tsc` rather than silently never
matching. Claimed: V3001→P2002, V3002→P2003, V3003→P2011, V3004→P2004,
V3005→P2000, V6001→P2025, V4001→P2009, V1001→P1001, V1002→P1002, V1003→P1017,
V1004→P1012.

**Partial on purpose.** Everything else reports `undefined`. The transaction
family (V5xxx), nested writes (V7xxx), cache, migration, pending-operation,
V8xxx (including `UnsupportedOperationError`) and the generic `QueryError` are
viborm concepts Prisma has no code for; inventing one would be a lie a catch
block would act on. `tests/errors/prisma-codes.test.ts` carries an
**exhaustiveness tripwire**: every `VibORMErrorCode` must be either claimed or
listed in `EXPECTED_UNMAPPED`, so a new code fails the suite until someone
writes down its Prisma disposition.

Serialization carries the code through the *trusted snapshot*
(`src/errors/diagnostics.ts`) rather than reading it off the instance, so
`toJSON()` and the sanitized clone handed to logging callbacks both have it, and
the key is omitted entirely when unclaimed. `sanitizeTrustedPrismaCode`
(`/^P\d{4}$/`) drops anything else.

**P2000** is a new `ValueTooLongError` (V3005), mapped from PG SQLSTATE `22001`
and MySQL errno `1406` / `ER_DATA_TOO_LONG` (including PlanetScale's
errno-in-message shape). **SQLite is a documented absence, not an omission**:
SQLite does not enforce declared column lengths, and `SQLITE_TOOBIG` is the
~1 GB `SQLITE_MAX_LENGTH` cap — a different failure. Prisma agrees (quaint's
SQLite error module has no arm for it). A test pins `SQLITE_TOOBIG` →
`QueryError` with `prismaCode === undefined`.

**`ClientInitializationError`** (V1004 → P1012) is thrown at three
construction-time sites in `src/client/client.ts`: unknown-model access on the
plain and cached surfaces, and `VibORM.create` (a new missing-driver guard plus
`assertConstructed`, which re-types bare failures from schema hydration and
registry construction while letting already-typed VibORM errors through). Note
the behavior change: `createClient({ schema })` with no driver now throws at
construction instead of failing later.

Two judgment calls worth re-reading: V1003 `CONNECTION_CLOSED` claims **P1017**
("server has closed the connection"), not P1001/P1002 as the unit table above
sketched; and `TransactionError` stays unclaimed rather than taking P2034,
because the family also carries `SQLITE_BUSY` and timeouts — use
`isRetryable()`.

**W5-U5 (`$metrics`) was not shipped from this unit either** — see the table row
above for why the premise was false.

### W5-U3 delivered — the transaction-option contract

`assertNoTransactionOptions` and its 11-driver "rejects every removed option"
pins are gone, replaced deliberately per D-2. The shape is:

- **One parse boundary.** `src/drivers/shared/transaction-options.ts` validates
  the raw options object (`V5005` for a non-object, unknown key, unknown level,
  or non-positive duration) and resolves it against the driver's declared
  contract, producing either an executable plan or an `UnsupportedOperationError`
  (`V8003`) naming the option **and the reason**. Refusal always precedes
  provider dispatch.
- **Per-driver declarations.** Each driver overrides `transactionOptionSupport()`
  with `{ isolationLevel: placement, timeout, maxWait: mode }` plus a reason for
  anything it cannot fully honor. `TransactionBoundDriver` declares the *nested*
  (savepoint) contract separately: `timeout` honored, `isolationLevel` and
  `maxWait` refused.
- **Placement is per-family, not per-driver-guesswork.** `post-begin` for the
  PostgreSQL family (first statement inside the transaction, applied by the
  base class), `pre-begin` for the MySQL family (threaded into the driver's own
  `transaction()` because MySQL rejects the statement once a transaction is
  open), `serializable-only` for SQLite (no SQL: honored by construction).
- **`timeout`** is consumed by `withTransaction`, not forwarded to
  `_transaction`, because only that layer can drain the transaction-bound
  scope's in-flight statements before the lifecycle rolls back — which is what
  keeps the connection reusable rather than poisoned.
- **`maxWait`** is bounded either by the serialized connection queue (a
  bounded-out transaction never reaches `BEGIN`) or by a pooled acquisition the
  driver can abandon *and release*, so an over-waited transaction cannot leak a
  checked-out connection. Drivers with neither refuse it.
- **Array form takes `isolationLevel` only**, matching Prisma's sequential API:
  an array of preplanned operations has no interactive window for `timeout` or
  `maxWait` to bound, so both are refused there on every driver.

Tests: `tests/drivers/transaction-portability.test.ts` (the pinned matrix —
every driver × every option, declaration and refusal),
`tests/drivers/transaction-options-behavior.test.ts` (statement placement,
"honored by construction" meaning zero SQL, timeout rollback + post-probes,
bounded queue wait, nested contract), `tests/drivers/transaction-options-live.test.ts`
(Docker-gated: PostgreSQL Serializable write-skew conflict mapped to `V5004`
with a ReadCommitted control; MySQL dirty-read proof that the level is really in
force, plus a no-leak check on the pooled connection).

One finding worth carrying forward: the obvious MySQL probes are both wrong.
`@@transaction_isolation` reports the *session* default and shows
`REPEATABLE-READ` no matter which level the transaction is running at (the
next-transaction-only form deliberately leaves the session alone — which is what
makes it safe on a pooled connection), and
`information_schema.innodb_trx` is served from a snapshot this server hands back
stale. Only the isolation *behavior* distinguishes them, so the live test proves
the level with a dirty read.

### W5-U4 — DELIVERED

**Surface.** `omit: { field: boolean }` on every operation that returns a model
row — the five reads, `create`/`update`/`upsert`/`delete`, and the three bulk
writes — plus every relation node inside `select`/`include`. Client-level:
`createClient({ omit: { user: { passwordHash: true } } })`.

**`omit` never reaches the query engine.** `withOmitProjection`
([validation/model/args/omit.ts](../../src/validation/model/args/omit.ts))
wraps each args schema: it refuses `select` + `omit` on the RAW payload, then —
after the payload validates — rewrites a surviving `omit` into the explicit
`select` it denotes and drops the key. Downstream there is exactly one
projection vocabulary, the engine's default-projection branch is untouched, and
`include` is untouched: the result carries a scalar-only `select` NEXT TO the
original `include`, which is the shape the V2 write operations already hand the
read builder (`defaultSelect` + `parsedInclude`). The relation `include` nodes
have desugared the same way since before this unit (`buildSelectionFromState`),
so nested `omit` is the same wrapper applied to the node schema.

**Two operations needed the parse output they were throwing away.**
`UpdateOperation` validated the whole args and then read the projection from the
RAW `args.select` — an omit-only payload has nothing there. It now reads the
parsed value (which also removes a double parse). `UpsertOperation` has NO
whole-args parse by design (its arms must receive the raw payload, and the
untaken arm must not be validated), so it gained a three-key
`core.upsertProjection` schema — `{ select?, include?, omit? }` through the same
wrapper — rather than a second implementation of the rule inside the engine. Its
delegated arms are forwarded the DESUGARED select whenever the caller projected
at all, so both arms of an omit-carrying upsert answer the same columns.

**Bulk writes: `omit` is a projection, so it returns rows.** `returnsRows`
([query-engine-v2/routing.ts](../../src/query-engine-v2/routing.ts)) now reads
`select !== undefined || omit !== undefined`, and `BulkWriteResult` discriminates
on the same pair with the same three-case honesty (`undefined` → `{count}`,
definite → rows, maybe-`undefined` → the union). Accepting a projection on the
`{ count }` arm would have been accept-and-ignore.

**Fail-closed edge:** an `omit` that names every projectable scalar denotes
`select: {}`, which the read builder refuses. Answering it with the DEFAULT
projection would return precisely the columns the caller asked to hide, so it is
refused at the parse boundary, naming the model. Prisma refuses the same payload.

**THE PRECEDENCE DECISION (new doctrine, documented in
[client/omit.mdx](../content/docs/client/omit.mdx)).** Three layers can hide a
field, and they are deliberately NOT the same kind of thing:

| Layer | Kind | Undoable by a query? |
|---|---|---|
| model-level `.omit()` | schema truth | **no** |
| client-level `omit` | this client's default | yes — `{ field: false }`, or an explicit `select` |
| query-level `omit` | this call | — |

Model-level is now a HARD exclusion, which is a **behavior change**: the field is
removed from the `select` schema, from the `omit` schema, and from the result
type, so `select: { secret: true }` is an "Unknown key" failure where it
previously re-included the column. That is the only reading under which
`.omit()` is usable for secrets — the feature's stated purpose — and the whole
estate stayed green through the change (no test relied on the old permissiveness).
One definition backs all of it: `projectableScalarNames` /
`ProjectableScalarKeys` in
[validation/model/core/projection.ts](../../src/validation/model/core/projection.ts).

**Client-level is an ARGS REWRITE, not an engine default**
([client/omit.ts](../../src/client/omit.ts)). The validation schemas are shared,
so a per-client default that changed what VALIDATES would make two clients over
the same models disagree about which payloads are legal. Instead the client walks
the `select`/`include` tree once per query (only when configured — otherwise the
resolver is never built and the walk never runs) and injects its defaults into
each node's `omit`, where the caller's own flags override per field. It never
injects into a node that carries an explicit `select`, and never into a bulk
write with no projection of its own: a global default must not flip a return
shape. A config naming an unknown model or field throws at construction (the
config site cannot be typed per-model — `VibORMConfig` is not generic in the
schema — so the check is runtime and eager).

**Types.** `ApplyOmit` drops a literal-`true` key, keeps a literal-`false` one,
and makes a WIDENED `boolean` flag OPTIONAL rather than guessing — the same
"only the runtime knows" honesty `BulkWriteResult` already used. Relation nodes
route through one `InferRelationNodeResult`, so `{ select }`, `{ include }`,
`{ omit }` and pagination-only nodes are decided in one place.

**Pinned by:** [tests/model/omit-validation.test.ts](../../tests/model/omit-validation.test.ts)
(desugaring, refusals, model-level hardness),
[tests/client/omit-result-types.test.ts](../../tests/client/omit-result-types.test.ts)
(the type claims, including the optional-key case),
[tests/drivers/omit-behavior.ts](../../tests/drivers/omit-behavior.ts) wired into
every driver leg (live, cross-dialect, all three layers and their interaction).
The live suite asserts whole objects with `toEqual`, which is load-bearing: the
result parser refuses a row carrying a known scalar the request did not ask for,
so a projection that still FETCHED the column would throw rather than pass.

---

## W6 — Type fidelity (breaking-change wave, own release)

| Unit | Size | What |
|---|---|---|
| W6-U1 ✅ | L | **DELIVERED.** See "W6-U1 — DELIVERED" below. **Decimal (per D-3).** String-backed decode for `numeric`/`DECIMAL(65,30)`; accept `string \| number` on write; filters compare via SQL (no JS float math); SQLite column type moves `REAL` → `TEXT`-with-numeric-affinity decision (pin with migration note). Migration path: one release with `decimal: "number"` legacy opt-in. |
| W6-U2 ✅ | S | **DELIVERED.** See "W6-U2 — delivered" below. **BigInt hole on `bun-sqlite`** — add the missing safe-integers opt-in (matrix defect §2.9-6; belongs here since it's the same "types are exact" theme). |

### W6-U2 — delivered (bun-sqlite integer safety, and the driver underneath it)

**What shipped.** The typed read path opts each reader statement into
`safeIntegers(true)`, byte-for-byte the arrangement `sqlite3` already had:
`execute` opts in, `executeRaw` deliberately does not (raw rows bypass the
result parser and stay driver-native), and a statement that decodes nothing is
never switched. `bun-sqlite` now answers a `s.bigInt()` field with
`9007199254740993n` — the same value the shared scalar round-trip suite pins on
`sqlite3` and `libsql`.

**Fail-closed, not optional.** `safeIntegers` landed in Bun 1.1.14. On an older
build the method is absent, and the driver throws `FeatureNotSupportedError`
(V8001) *before* fetching the row rather than returning a rounded number. The
method is declared required on the internal `BunSQLiteStatement` interface, so
a hand-written `client` object must now provide it — a deliberate break, small
enough to belong in this wave, and the runtime guard catches the JS-only case
the type cannot.

**The blocker found on the way — this driver had never run.** `initClient`
passed `options ?? {}` to `new Database(path, options)`, and bun:sqlite rejects
an options object that names no access mode:
`SQLITE_MISUSE — flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE`.
The documented default (`createClient({ schema })`, no options) therefore threw
`ConnectionError` on connect and had **never executed a single query**. Fixed in
the same unit: an options bag with no keys is omitted so Bun applies its own
default (readwrite + create); a bag that says something is still passed through
untouched. Nothing caught this because every `bun-sqlite` test was a `vi.fn()`
fake — the exact failure mode the capability matrix's §2.10 warns about, caught
the first time a real query ran.

**Two matrix claims corrected** (§2.9-6): the loss was **not** silent for
`bigint`-typed fields — a rounded value past 2^53 is not a canonical integer, so
the shared result parser already rejected it with `QueryEngineError V9001`;
silent rounding was confined to `int`-typed columns and raw reads. And
`bun-sqlite` is no longer one of the five drivers that have never executed a
real query.

**Pinned by:**
[tests/drivers/bun-sqlite-runtime.test.ts](../../tests/drivers/bun-sqlite-runtime.test.ts)
+ [its probe](../../tests/drivers/bun-sqlite-runtime-probe.ts) — spawns Bun
(`test.runIf`, skipped when absent) on a script that drives the real client
against a real in-memory `bun:sqlite`: push, create, findUnique, findMany,
`include`, tagged `$queryRaw` (exact) and `$queryRawUnsafe` (rounded, the
witness that the opt-in is what saves the typed path). vitest cannot load
`bun:sqlite`, which is why the assertions live in a spawned script.
[tests/drivers/sqlite-integer-safety.test.ts](../../tests/drivers/sqlite-integer-safety.test.ts)
pins the same split at unit level — against a fake that rounds exactly like the
real provider — plus the refusal, and asserts the `sqlite3` contract it matches
side by side against a real better-sqlite3.

**Falsified:** flipping the two opt-in flags fails 3 of the 5 unit assertions
and the runtime probe; hoisting the call out of the reader branch fails the
fourth. Before the constructor fix the probe failed with `ConnectionError`;
before the `safeIntegers` fix it failed with `V9001 malformed bigint scalar`.

### W6-U1 — DELIVERED

Shipped as pinned below. What landed, and the two things worth knowing that the
contract alone does not say:

- **A dead-code DDL bug surfaced.** `getSQLiteType()` routed `decimal` to the
  FLOAT default, so `SQLITE_TYPE_DEFAULTS.decimal` had never been read. The
  first `TEXT` mapping therefore did nothing, and the conformance test caught it
  by reading a 30-digit value back as `"1"`. Both are fixed.
- **The refusal is capability-driven, not dialect-driven.** A new adapter flag
  `supportsExactDecimal` carries it, so the query engine never names SQLite (the
  Rule 1 boundary holds). ~~The four refusal sites are the where-builder's
  ordered comparisons, the orderby-builder, the aggregate builder, and the
  set-builder's arithmetic.~~ **Corrected: those four were real but not
  sufficient — six more were needed, and the six they missed carried the
  common spellings. See "W6-U1 correction" below.**
- **`_avg` had to move.** It normally widens to a JS number; for a decimal field
  it now routes through the typed field parser like `_sum`/`_min`/`_max`, since
  an average of decimals is still a decimal.

**Public breaks, all carried through internally and in tests:** decimal result
types are `string` (including through relations, in `_min`/`_max`, and now in
`_sum`/`_avg`); `.schema()` on a decimal refines the string form; the SQLite
column type is `TEXT`.

**Verification:** `tsc` clean; a new shared driver suite
(`tests/drivers/decimal-exactness-behavior.ts`) wired into every driver leg
including docker, with fixtures chosen to discriminate numeric from
lexicographic ordering (`"9"` vs `"10"`, `"0.10"` vs `"0.9"`) and from float
corruption (30-digit values, 2^53+1, `0.1 + 0.2`); gates 43/43.

### W6-U1 — Decimal: the research, and the contract it pins

#### What Prisma actually does

| | Postgres | MySQL | SQLite |
|---|---|---|---|
| Column | `numeric` (unconstrained: exact, arbitrary precision) | `DECIMAL(65,30)` (exact, fixed 65-digit/30-scale) | `DECIMAL` — **a type SQLite does not have.** It parses to NUMERIC affinity, so every value is stored as `INTEGER` or, the moment a fraction appears, `REAL` (IEEE-754 double) |
| Exact in the DB? | ✅ | ✅ | ❌ **no** |
| Client value | `Prisma.Decimal` — a `decimal.js` instance | same | same |

Prisma's client type is the important part: it is **not** a JS `number`. `Prisma.Decimal`
is `decimal.js`, whose `toJSON`/`toString` produce a **string**, which is how a Prisma
`Decimal` survives `JSON.stringify` and an HTTP boundary intact. Writes accept a
`Decimal`, a string, or a number, and `new Prisma.Decimal(0.1 + 0.2)` famously carries
the float error in — the number overload is a convenience that cannot undo damage its
caller already did.

**How Prisma avoids float corruption on SQLite: it does not.** There is no trick to
find. `DECIMAL` on SQLite has NUMERIC affinity, values land in a double, and reads come
back rounded — [prisma#20635](https://github.com/prisma/prisma/issues/20635) ("Decimal
values are stored correctly but read values do not match", SQLite) is confirmed and open,
and Prisma contributors have stated on the tracker that there is no reliable way to store
a Decimal in SQLite. Prisma ships the lossy column and returns a `Decimal` object wrapped
around an already-rounded double. **We are not copying that**: returning an
arbitrary-precision-looking type over a value the database already destroyed is exactly
the "accept-and-ignore" this codebase forbids.

#### Why viborm's current state is a defect, not a trade-off

`s.decimal()`'s runtime base is `v.number()` ([scalar.ts:11](../../src/schema/scalars/decimal/scalar.ts:11))
while the DDL is a real `numeric` / `DECIMAL(65,30)`. The column is exact and the JS
value is not, so the round-trip loses precision **silently** on the two dialects that
were storing it perfectly. Anyone using `s.decimal()` for money is wrong today and gets
no error.

#### The pinned contract

**Everywhere:** a decimal **reads as a `string`** — the canonical decimal spelling of the
stored value, exact at any precision. Writes accept `string | number`. A string must be
an exact numeric literal (`-?\d+(\.\d+)?`: optional sign, digits, at most one dot, **no
exponent**); anything else is a typed validation refusal. A number is accepted as a
convenience and documented as **already possibly carrying float error** — `0.1 + 0.2`
binds as `0.30000000000000004` because that is the value the caller actually has. All
comparison and all arithmetic happen **in the database**; no decimal ever passes through
JS float math.

Values are **canonicalized** before binding and after decoding (strip a leading `+`,
strip insignificant leading/trailing zeros, normalize `-0` to `0`, `.5` to `0.5`), so one
number has exactly one spelling. This is what makes text equality on SQLite equal
numeric equality, and it makes `"1.10"` and `"1.1"` the same value everywhere.

| | Postgres | MySQL | SQLite |
|---|---|---|---|
| Column | `numeric` (unchanged) | `DECIMAL(65,30)` (unchanged) | **`TEXT`** (was `REAL`) — **breaking, see migration note** |
| Storage exact | ✅ | ✅ | ✅ (exact spelling, any precision) |
| Read exact | ✅ | ✅ | ✅ |
| `equals`/`not`/`in`/`notIn` | ✅ exact — operand bound as `CAST(? AS NUMERIC)` | ✅ exact — `CAST(? AS DECIMAL(65,30))` | ✅ exact — canonical **text** equality, which *is* numeric equality once canonicalized |
| `lt`/`lte`/`gt`/`gte`, `orderBy`, `_min`/`_max` | ✅ exact | ✅ exact | ⛔ **typed refusal** |
| `_sum`/`_avg`, `increment`/`decrement`/`multiply`/`divide` | ✅ exact, server-side | ✅ exact, server-side | ⛔ **typed refusal** |

`orderBy` and the aggregates in that table mean **every spelling of them** — the
paginated one, the relational one, and `groupBy`'s. The first shipped version
gated only the bare spellings; see "W6-U1 correction" for the full list and the
surface test that now pins it.

**Why MySQL needs the cast.** Binding the operand as a plain string and letting MySQL
compare it against a `DECIMAL` column does not work: when MySQL compares a number to a
string it converts *both to double* and compares as floating point. The column is exact,
the comparison would not be, and nothing would say so. `CAST(? AS DECIMAL(65,30))` keeps
the comparison in the exact domain. Postgres infers `numeric` from context but is cast
explicitly for the same reason — so the emitted SQL states the intent instead of relying
on inference that a `::text` in the wrong place would silently change.

#### The SQLite decision, and the three alternatives it rejects

SQLite has no exact decimal type and no exact decimal comparison. Any *ordered* answer it
can give is a double comparison. So: **store the truth, and refuse the questions that
cannot be answered truthfully.**

- **`REAL` (today, and Prisma's behaviour).** Rejected: silently lossy in *storage*. The
  value you wrote is not the value in the file. This is the defect being fixed.
- **`TEXT` + lexicographic comparison.** Rejected outright, and explicitly ruled out by
  the doctrine: `"9" > "10"` and `"0.10" < "0.9"` are wrong answers dressed as SQL.
- **`TEXT` + `CAST(col AS REAL)` comparison.** Rejected. It *is* numeric, not
  lexicographic, and it is exact for ordinary money — but it silently gives a wrong
  answer past ~15 significant digits, and the wrongness is on the *stored* side where no
  operand check can catch it (`amount > '1'` misses a stored `1.00000000000000000001`).
  That is precisely "silent precision loss", which this codebase treats as a defect
  rather than a compromise. Refusing loudly and being usable for exact storage beats
  answering approximately and looking exact.
- **`TEXT` in a sort-order-preserving encoding** (fixed-width zero-padded, ten's-complement
  negatives) would make ordering exact and lexicographic at once. Rejected: it makes the
  stored bytes unreadable to `$queryRaw`, to `sqlite3`, and to every other tool pointed at
  the file. A database whose contents you cannot read is not honest either.

The refusal is a typed `UnsupportedOperationError`, names the field and the dialect, and
points at the two escapes: `s.float()` if approximate ordering is what you want, or a
scaled `s.bigInt()` if you need exact ordered money on SQLite.

#### Migration note (SQLite, breaking)

The SQLite DDL for a decimal field changes `REAL` → `TEXT`. **Verified, not assumed**
(`tests/migrations/decimal-sqlite-text.test.ts`): a second `push` against a database
created with the old schema reports

```
{ type: "alterColumn", tableName: "…", columnName: "amount",
  from: { type: "REAL" }, to: { type: "TEXT" } }
```

— naming the column and both types. It is not silent, and it is not mistaken for a fresh
table. SQLite cannot alter a column type in place, so the change is realized by the
standard rebuild (create `__new_…`, `INSERT … SELECT`, drop, rename), which carries the
existing rows across.

What the copy cannot do is undo the old storage: **a value the old `REAL` column already
rounded stays rounded**, because the digits were discarded at write time, not at migration
time. Re-import from the source of truth if the old rows carried more than ~15 significant
digits.

*(The first version of this test passed vacuously — it fell back to a fresh driver, so the
second push saw an empty database. Tightened to share one driver and assert the exact
operation shape; that is when it started telling the truth.)*

#### Legacy escape hatch (one release)

`createClient({ decimal: "number" })` restores the old `number` decode at **runtime
only**. The static types stay `string`, so the hatch is deliberately type-incoherent —
it exists to unblock a deploy, not to be a supported mode, and it is removed in the
release after this one.

### W6-U1 correction — the refusal was present in the rare spelling and absent in the common one

**Found by W6 review; fixed on top of the W6 head.** The contract above was
written as a claim about *operations*; it shipped as a gate on four *call
sites*. Anything that built its own ORDER BY or its own aggregate — which is
most of the engine — walked past all four and answered lexicographically, with
no error. Witnesses on better-sqlite3, with the numerically correct answer
alongside (the first three re-run here against the pre-fix tree; the fourth is
the review's, and follows from the same byte ordering the others demonstrate):

| Query | SQLite answered | Correct |
|---|---|---|
| `findMany({ orderBy: { amount: "desc" }, take: 1 })` over `9`, `10`, `1` | `9` | `10` |
| `groupBy({ by: ["amount"], orderBy: { amount: "asc" } })` over `9`, `10`, `1` | `1, 10, 9` | `1, 9, 10` |
| `groupBy({ having: { amount: { _max: { gt: 5 } } } })`, group `c` = `{1}` | `c` returned | `c` excluded |
| `findMany({ orderBy: { amount: "asc" }, skip: 1, take: 2 })` over `0.1`,`0.9`,`9`,`10` | `[0.9, 10]` | `[0.9, 9]` — a different row **set** |

`take` is the ordinary spelling of a sorted list and `findFirst` is `take: 1`,
so the refusal was missing from the common case and present only in the rare
one. That is worse than no gate: the unwindowed query throws, the caller adds
`take`, and the error disappears along with the correctness.

**Cause.** Windowed reads (`take`/`skip`/`cursor`, `findFirst`, nested read
windows, and the `count`/`aggregate` input window) do not call `buildOrderBy` at
all — `buildFindPagination` hands off to `normalizeCursorOrder`, which builds
its own ORDER BY. `groupBy` likewise builds its own, and `groupBy`'s `having`
builds its own aggregates. Each private builder needed its own copy of the gate.

**Six sites added**, every one falsified individually against the surface test
(remove it → that spelling stops refusing):

| Site | Spelling it covers |
|---|---|
| `cursor-order.ts` `parseRequestedScalarOrder` | `orderBy` under any window, `findFirst`, `count`/`aggregate` windows, nested reads |
| `cursor-order.ts` `appendTieBreakers` | a decimal PK/unique added as the tie-breaker the caller never named |
| `relation-orderby-builder.ts` leaf | `orderBy: { author: { fee: "asc" } }`, at any depth |
| `groupby.ts` `buildGroupByOrderBy` | `groupBy({ orderBy: { amount } })` on a grouped decimal |
| `groupby.ts` `buildOrderByAggregate` | `groupBy({ orderBy: { _max: { amount } } })` |
| `groupby-having.ts` aggregate loop | `having: { amount: { _min/_max/_sum/_avg } }` |

`_count` is exempt at every site — counting rows needs no ordering, so refusing
it would be a false refusal. The shared rule lives in one helper,
`assertExactDecimalAggregate`.

**One binding hole closed with it.** `having` bound its operands with
`literals.value`, bypassing `literals.decimal` — the very `CAST(? AS
DECIMAL(65,30))` this section calls load-bearing. HAVING operands now route
through `scalarValueLiteral`, the same lowering `where` uses, so every aggregate
comparison lands in the column's own domain. (Scope note, measured not assumed:
`havingScalarSchema` types every aggregate operand as `v.number()`, so today
only JS numbers can reach it — the fix is exactness-preserving and consistent
rather than a repair of a witnessed MySQL wrong answer. The inability to write
an exact *string* bound in `having`, unlike `where`, is a separate gap and is
not closed here.)

**The test that would have caught it.** `tests/drivers/decimal-exactness-behavior.ts`
had zero `groupBy` and zero relation-`orderBy` cases, so nothing in the estate
could see any of this. Two things replace that:

- `tests/query-engine/decimal-refusal-surface.test.ts` — 31 ordered/derived
  spellings and 12 controls, each run on **both** PGlite and SQLite3. A refused
  spelling must also *resolve* on PGlite, so a typo cannot masquerade as a
  refusal; a control must resolve on both, so a gate that refuses everything
  fails.
- the shared driver suite gains windowed ordering, `groupBy` ordering and
  `groupBy` `having` cases on every leg including docker MySQL — with a `9.5`
  row added so `alpha`'s byte-max (`"9"`) and numeric max (`10`) straddle
  another group's, making the group ordering itself discriminating.

### W6 — integration record (both lanes merged)

W6-U1 and W6-U2 were built in parallel worktrees, both from the W5 head
(`b9f7814`), and cherry-picked onto `prisma-parity-v2` in that order —
U1's five commits, then U2's one.

**Code overlap: none.** U1 touches the decimal path (validation primitive,
adapters, builders, result parsers, migrations type mapping); U2 touches
`src/drivers/bun-sqlite/index.ts` and the sqlite driver tests. The only files
both lanes edited are this plan and the capability matrix.

**Conflicts, and how they were resolved — both intents kept, neither weakened:**

| Where | U1's claim | U2's claim | Merged |
|---|---|---|---|
| matrix §0.4 *Prisma parity* | drops "`Decimal` is a JS `number`" from the gap list; credits W6-U1 | (unchanged text, still listing it) | U1's — the gap is closed |
| matrix §0.4 *Interoperability* | "**Five** drivers have never executed a query" | "**Four** … (W6-U2 moved `bun-sqlite` out)" | U2's — the count changed under it |
| matrix §2.4 *Decimal* row | `TEXT` on SQLite, exact everywhere, named SQLite refusals | still `REAL`/lossy | U1's |
| matrix §2.4 *BigInt* row | notes `bun-sqlite` has no opt-in "at all" | `bun-sqlite` now opts in, proven on real Bun | U2's — U1's line was true only before U2 landed |

**Two integration fixes** carried in the merge commit rather than rewriting
either lane's history: the W6 table row for U1 was not marked delivered (U2's
was), and the raw-SQL comment U2 flagged as inaccurate but out of its lane
(`tests/drivers/client-raw-behavior.ts`) is corrected here — tagged
`$queryRaw` routes through `driver._execute`, which is exactly the path that
opts into `safeIntegers(true)`, so INTEGER columns arrive as `BigInt` on the
whole sqlite3 family, not only on LibSQL. Only `$queryRawUnsafe` and the legacy
string form take `_executeRaw` and stay driver-native.

**Post-merge verification:** `tsc` clean; full estate green; `test:gates`
43/43. Docker legs belong to the gate agent and were not run here.

### W6-U1 correction 2 — the exactness contract stopped at the foreign key

**Found by W6 review; fixed on top of the W6 head.** W6-U1's contract says a
decimal is *stored and compared through the dialect's exact-decimal path*, and
it held for every column the caller names — except the one column the caller
never names. A relation-correlated foreign key is lowered by `referenceSql`
(`src/query-engine-v2/fragment-builders.ts`), which bound the value with
`literals.value` under `getScalarCastType`. That function answered `"numeric"`
for a decimal. So the PARENT key and the CHILD foreign key holding *the same
logical value* were bound two different ways inside one statement pair:

| Dialect | parent key | child FK | child's effective domain |
|---|---|---|---|
| PostgreSQL | `CAST($1 AS NUMERIC)` | `CAST($2 AS NUMERIC)` | exact — the control that passed |
| MySQL | `CAST(? AS DECIMAL(65,30))` | `CAST(? AS DECIMAL)` | `DECIMAL(10,0)` |
| SQLite | `?` (canonical TEXT) | `CAST(? AS NUMERIC)` | REAL |

Two of three dialects wrote a lossy FK against a lossless key, so the two ends
of one relation stopped matching. This was never confined to high-precision
values: MySQL's bare `DECIMAL` is `DECIMAL(10,0)`
(`src/migrations/drivers/type-mapping.ts`), which rounds away **every**
fraction — a key of `9.5` lands as `10`.

**How it presented depended on one PRAGMA, which is why it read as a rare edge
case rather than a data-loss bug.** With foreign keys ON (sqlite3, libsql) a
legal `parent.create({ data: { key, kids: { create: [...] } } })` threw
`ForeignKeyError` against a parent row that demonstrably existed. With them OFF
(bun:sqlite's default) the write reported success, the FK column held
`1.23456789012346e+18`, and the parent's `include` answered `kids: []` — silent
precision loss on the write plus a silently wrong read. `connect: { key }` failed
the same way.

**This was a W6 regression, and W6 is where it had to be fixed.** Before W6,
SQLite mapped decimal to `REAL`, so parent and child rounded *identically* and
the FK matched — consistently lossy, therefore consistently joinable. W6's
REAL→TEXT move made the parent exact and left the child rounding, turning a
uniformly-lossy pair into a mismatched one. (MySQL's `DECIMAL(10,0)` child was
wrong before W6 too; nothing in the estate wrote a decimal relation key, so
nothing saw it.)

**Fix, in two halves — both falsified independently:**

1. **`CastType` gains `"decimal"`, split off from `"numeric"`** — a deliberate
   public-type break, taken in W6 because W6 is the breaking wave.
   `"numeric"` remains the float cast (`float` still maps to it); `"decimal"` is
   the exact-decimal domain and maps to what each adapter's `literals.decimal`
   already casts into: `NUMERIC` on PG, `DECIMAL(65,30)` on MySQL, `TEXT` on
   SQLite. `getScalarCastType` returns it for decimal fields. This fixes every
   cast-path FK, including deferred `Ref` and batch-scratch values that cannot
   be canonicalized at build time. **Blast radius:** `CastType` is exported from
   `@adapters/database-adapter`; a third-party adapter's `createCastExpression`
   type map must gain a `decimal` entry or fail to compile — which is the point,
   since a silently-missing entry is exactly this defect.
2. **`referenceSql` routes a CONCRETE decimal through `decimalLiteral`** — the
   same exact-decimal literal, canonicalization included, that every other
   decimal write uses. The cast alone is not sufficient: SQLite stores the
   canonical spelling, so `connect: { key: "9.50" }` against a stored `9.5`
   matches nothing however it is cast. `decimalLiteral` moved from private-to-
   `values-builder` to exported (taking an adapter, not a `QueryScope`) so
   there is exactly **one** decimal binding in the codebase; two spellings
   drifting apart is what produced this.

**Why it shipped green: nothing in the estate wrote a decimal relation key.**
`s.decimal().id()` appeared in two test files, neither of which wrote an FK
through a relation. `tests/query-engine/decimal-relation-key-write.test.ts`
replaces that with 34 cases: live nested `create` / `createMany` / `connect` /
`connectOrCreate` / non-canonical spelling on PGlite **and** SQLite3, asserting
on the *link and the stored FK* (never on the absence of a throw — the
bun:sqlite witness proves an absent throw means nothing); plus, for all three
dialects including MySQL which has no local leg, that the FK expression is
byte-identical to the referenced column's own write lowering. That is the
invariant — *an FK is written like the key it references* — rather than a
dialect spelling, so it survives a change to any adapter's decimal literal. Two
further cases pin the deferred-`Ref` cast and pin that `float` was **not**
dragged into the exact-decimal domain by the split.

**Claims this restores to true** (they were false as shipped, and are now
correct as written — no doc text needed changing, only the code beneath it):
`src/query-engine/builders/decimal-portability.ts` "Reads, writes, and equality
filters … stay exact"; the `docs/content/docs/schema/scalars/decimal.mdx` matrix
row "Read / write round-trip | exact | exact | exact"; and
`docs/architecture/capability-matrix-2026-07.md` "exact everywhere — decodes to
a canonical string, never a double".

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
