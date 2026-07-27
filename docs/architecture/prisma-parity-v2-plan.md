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
| W5-U1 | M | **Raw SQL overhaul.** `$queryRaw` becomes a tagged template (safe-by-construction); the current `(string, params)` form moves to `$queryRawUnsafe` (keep an overload on `$queryRaw` detecting a plain string for one release, with a deprecation warning in the `warning` log channel). Add `$executeRaw` tagged + `$executeRawUnsafe`. Export `sql`/`join`/`empty`/`raw` from the package root (`Sql` class already dialect-renders via `toStatement`). Wire `tx.$queryRaw`/`tx.$executeRaw` into the tx proxy (today it throws `Model "$executeRaw" not found`). | tagged interpolation parameterizes on all dialects; `join` accepts plain values (Prisma parity); tx raw runs inside the open transaction (single-connection drivers verified) |
| W5-U2 | S/M | **Prisma error-code compatibility.** Add `prismaCode` to `VibORMError` (V3001→`P2002`, V3002→`P2003`, V3003→`P2011`, V6001→`P2025`, V4001→validation, per the matrix table); map the missing **P2000** (PG `22001`, MySQL `1406` value-too-long) to a typed error instead of generic `QueryError`; add a typed client-construction error (PrismaClientInitializationError-equivalent). | `e.prismaCode === 'P2002'` works in a catch written for Prisma; P2000 mapping covered in the error-mapping suite for all dialects |
| W5-U3 | M | **Transaction options (per D-2).** Accept `{ isolationLevel, timeout, maxWait }` on both `$transaction` forms. Honor isolationLevel (SET TRANSACTION ISOLATION LEVEL per dialect) + timeout (driver-side timer aborting/rolling back) on transaction-capable drivers; V8003 typed refusal on D1/Neon HTTP and for unsupported levels (SQLite has only its journal modes — map or refuse, pin the choice). Replaces `assertNoTransactionOptions` and its 11-driver pinned tests deliberately. | Serializable conflict produces the dialect's serialization error, mapped; timeout rolls back cleanly; refusals typed, never silent |
| W5-U4 | M | **`omit`** — query-level (`omit: { field: true }` on every read/write-returning op, exclusive with `select`) and client-level (`createClient({ omit: { user: { password: true } } })`), matching Prisma's local-overrides-global rule (`omit: { field: false }` re-includes). Composes with the existing model-level `.omit()`. | type-level result excludes omitted keys; nested omit in include; global+local precedence matrix tested |
| W5-U5 | S (optional) | **`$metrics`** — expose the internal `PerfTracker` counters in Prisma's json/prometheus shapes. | `$metrics.json()` returns counters; no-op cost when unused |

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
