# `viborm/ordering` — plan v2 (after adversarial review round 1)

Status: v2, 2026-10-31, base `origin/main` 35317ca73 (VibORM 1.6.0).
Owner decisions: entry `viborm/ordering`; reads of an ordered model are sorted
by its key automatically; no unique constraint on the key; studio
drag-to-reorder later.

Round 1 reviewers: Opus and GPT-6.1 Sol, independently. Section 12 lists what
changed and why.

## 1. Goal

Order the members of a list (kanban cards in a column) so that a move writes
one row in the common case, an ordered read is an index range scan, and the
same code works on PostgreSQL, MySQL, SQLite, libSQL, PGlite and D1.

```ts
const card = s.model({
  id: s.string().id().ulid(),
  columnId: s.string(),
  rank: s.string(),
  column: s.toOne(() => column).fields("columnId").references("id"),
}).index(["columnId", "rank", "id"]);

const db = client.$extends(ordering({ card: { key: "rank", within: ["columnId"] } }));

await db.card.create({ data: { columnId, title } });              // `rank` optional: last of its column
await db.card.move({ where: { id }, after: { id: otherId } });   // or before / first / last
await db.card.move({ where: { id }, to: { columnId: other } });  // last of another column
await db.card.rekey({ where: { columnId } });                    // respace a column's keys
await db.column.findMany({ include: { cards: true } });          // cards in key order
```

## 2. Keys: decimal fractional keys

### 2.1 Alphabet: digits only

A key is a string of the digits `0-9`. Measured on ICU (Node `Intl.Collator`,
89 locales and tailorings, both sensitivities, random strings of length 1-7):

- base 36 (`0-9a-z`) disagrees with byte order in 18 locales (cs, sk, da, nb,
  nn, hu, hr, lt, lv, et, cy, sq, az, uz, ha, yo, es-trad, no): contractions
  such as Czech `ch` and Danish `aa`;
- digits only agree with byte order in all 89.

So digit keys sort identically under binary collations, MySQL `*_0900_ai_ci`
and tailored MySQL collations, PostgreSQL glibc and ICU locales, and SQLite
BINARY, with no collation declaration and no migration support. The one
documented exception is a collation with numeric ordering (ICU `kn-true`),
which no default uses. The test plan re-checks this on real MySQL and
PostgreSQL collations (section 8), including glibc, which ICU does not cover.

Cost: decimal keys are about 1.56 times longer than base-36 keys for the same
history. Section 2.4 bounds the length.

### 2.2 Grammar

`key = head integer-digits [fraction]`:

- `head` is one digit giving the sign and length of the integer part, with an
  extension digit for long integers, so that appends at the end and prepends
  at the start increment or decrement the integer part and keep keys short
  (O(log n) digits for n appends). The exact head table, forbidden boundary
  integers and overflow rule are specified in the key module before code, and
  property-tested.
- `fraction` has no trailing `0`, so every key has one spelling and a key is
  never a prefix-equal of another value.
- `keyBetween(a, b)` with `null` for an open end; `keysBetween(a, b, n)` for n
  ordered keys in one gap.

### 2.3 Jitter

Every generated key, including the first key of an empty group, is drawn
uniformly from the middle third of the gap `(a, b)`, at a fixed precision of
6 random digits below the gap's first differing position (never by appending
a suffix to a midpoint, which can leave the interval). Open ends use the
integer step as the gap. Two writers placing into one gap collide with
probability about 1e-6; a collision is a tie (2.5), never an error.

### 2.4 Length bound and respacing

Uniform jitter in the middle third shrinks a gap by at most 3x per insert:
about 0.5 digit per insert into one hot gap. A key is capped at 64 digits,
which fits every provider's index including MySQL's VARCHAR(191) default for
an indexed string. When a generated key would exceed the cap, the operation
respaces the neighbourhood (2.5) instead of failing. Explicit keys over the
cap are refused.

### 2.5 Ties and respacing

There is no unique constraint, so ties can exist: explicit keys, a backfill,
a 1e-6 jitter collision. Reads always end with the primary key (the engine's
`#completeOrder`, `query.ts:7093`, appends it when the model has a row key;
configuration requires one). A placement that needs a gap where there is none
(tied neighbours, or a key that would exceed the cap) respaces the tied or
crowded run: the run's rows get fresh, evenly spaced keys in their current
`(key, primary key)` order, inside the bounds around the run, in the same
operation. This is the only multi-row write, and it is rare.

### 2.6 Validation

Every write of the key field (create, update, `updateMany`, upsert arms,
nested writes at any depth) is validated against the grammar and the cap
(`ValidationError`). A stored key that is invalid (raw SQL, migration) makes
the next placement in its group fail with an error that names the row and
points to `rekey`.

## 3. Core change A — the `order` capability (default ordering)

Verified (both reviews): a `request` handler cannot do it (it never sees
`select`/`include`, and fires for the root model only); the `rows`
capability reaches every read through `Queries.under(domain)`.

- New capability `order: { card: [{ columnId: "asc" }, { rank: "asc" }] }`.
  The ordering extension contributes `[...within, key]` (not `[key]`, which
  would interleave groups in `card.findMany()` and defeat the index). The
  primary key tie-break comes from `#completeOrder`.
- Admission (`definition.ts`): scalar terms only, the model must have a row
  key; a later extension in the chain wins per model.
- Carrier: the order is a per-chain constant, so it keys the engine's view of
  the chain (the `Queries` instance) instead of forcing a per-call `CallRows`
  on every call of every model (`commands/index.ts:144-152, 191-196`). No
  allocation per call when the chain has no `order`.
- Applied with `args.orderBy ?? domain order` at:
  - `#read` for `findMany`/`findFirst`;
  - `#prepareRelationProjection` for to-many edges (`query.ts:8198-8222`):
    include and select, polymorphic arms (`:7903`, `:7943`), any depth,
    recursive sibling order (`:9257`), write results' projections;
  - `aggregated` exactly when it builds a window (take/skip/cursor,
    `:7600-7654`), so `count(args)` equals the length of `findMany(args)`.
  Never in `#page` (internal lock/probe/capture selects rely on key order).
  Never for `groupBy`, unpaged aggregates or `findUnique`. The findUnique
  batcher's merged `findMany` gets a harmless root sort (rows matched by key).
- An explicit `orderBy` replaces the default (no merge); `orderBy: []` as an
  explicit "no order" is tested.
- Cache identity (`cache-flow.ts:101`, `client.ts:932`) includes the chain's
  order for the root model and for every model a nested projection reaches,
  even when the root's own `orderBy` is explicit.
- Documented on its own in `extensions/create.mdx`.

## 4. Core change B — keys for created rows

### 4.1 Input types and admission

`rank` is declared `s.string()` with no schema default (a default on the key
field is refused at `$extends`). With the extension, the key becomes optional
in create inputs, root and nested, at both levels:

- runtime: the create admission accepts an omitted key the way it accepts
  omitted stamped fields (`commands/index.ts:175-192`);
- types: the client's create input types treat the key as stamped
  (`client/types.ts:556`, `:885`), root and nested.

### 4.2 Where the key is computed

Principle: compute keys before the operation, outside its envelope, whenever
the group is known from the caller's data; inside the operation only when the
group comes from membership.

- Group known from the data (root `create`, `createMany`, `upsert`, a nested
  create whose group fields are in its data): the pending operation reads the
  group's last key first, then runs the operation with explicit keys. A plain
  `create` costs one read plus the INSERT (2 round trips), not BEGIN + read +
  INSERT + COMMIT (`operation-context.ts:866-880`). `upsert` always reads and
  keeps its single `INSERT … ON CONFLICT` fold (`commands.ts:2002-2045`); the
  read is wasted when the existing row wins, which is documented.
- Array transactions `$transaction([...])`: the async pre-pass in
  `executeInterceptedArray` computes the keys of every member before the
  batch is built (the batch itself refuses dynamic reads, `raptor3/AGENTS.md`
  D-46), with a per-group memo of the last key handed out, so
  `[create(A), create(B)]` in one group puts B after A.
- Group from membership (a nested create under a parent, connectOrCreate's
  create): the key is computed inside the operation after membership
  resolution (`commands.ts:401-409`), where the operation already has an
  envelope. A parent created by the same operation has an empty group: no
  read. Generated parent ids and branch-dependent children are resolved per
  dependency stage, with the same per-group memo so later children follow
  earlier ones (pending explicit and generated keys included). Promise: one
  lookup per necessary stage, not one per operation.
- D1: in-operation lookups join the read-ahead (`readTogether`,
  `operation-context.ts:1145`) when there are several; a single one is one
  extra round trip, stated honestly. The memo covers reads that cannot see the
  batch's queued writes.
- Root `create`/`createMany` fast paths (`commands.ts:2169-2172`,
  `2220-2239`) are covered by the pre-pass (their keys are explicit by the
  time they run).

### 4.2b Appends computed in the INSERT (one round trip)

When the group is known from the data, the append key is computed by the
INSERT itself instead of a read first:

```sql
INSERT INTO card (id, column_id, title, rank)
SELECT ?, ?, ?, <append(k)>
FROM (SELECT MAX(rank) AS k FROM card WHERE column_id = ?) m
```

`append(k)` only increments the integer part of the last key (no midpoint)
and adds the random fraction: `length(n) || n || rtrim(lpad(random 6
digits), '0')` with `n = int(k) + 1`, `0` for an empty group or a group whose
keys are all in the prepend region. Measured on 2026-10-31 (scripts in
`/tmp/ordering-probe`): PostgreSQL 18, MySQL 8.4 (`utf8mb4_0900_ai_ci`) and
SQLite, 300 sequential appends each: order equals insertion order, 300
distinct keys, 10 characters at most.

Concurrency, 4 clients x 150 appends into one column:

- PostgreSQL: 600/600, 0 errors, 600 distinct keys.
- MySQL, `REPEATABLE READ` (the default): 321/600 failed with deadlock 1213.
  `INSERT … SELECT` takes shared next-key locks on the rows it reads, and two
  appenders then wait on each other's insert intention locks.
- MySQL, `READ COMMITTED`: 600/600, 0 errors.
- SQLite, libSQL, D1: one writer at a time, no deadlock possible.

So: one round trip on PostgreSQL, PGlite, SQLite, libSQL and D1. On MySQL the
append stays a consistent-read `SELECT MAX` (no locks) followed by the
INSERT: two round trips, no deadlock, whatever the session's isolation level.
`createMany` with a known group uses the same form over a VALUES list, with
`n = int(k) + ROW_NUMBER() OVER (PARTITION BY group ORDER BY ordinal)`. The
`append` arithmetic exists in SQL per dialect and in the JS key module; a test
checks that both produce keys of the same grammar and order.

### 4.3 The lookup

One scalar subquery per group (positional), built with the engine's null-safe
`where` builder: a `NULL` group is a group, and no matching of GROUP BY rows
back to JS values (which breaks under `_ai_ci` and for Decimal/DateTime, as
the findUnique batcher already knows, `find-unique-batch.ts:22-27`).

The lookup is physical: it ignores `rows` (soft delete) and read permissions,
so "last" is after every row of the group, hidden ones included. A restored
soft-deleted card comes back at its old place. The only disclosure is that a
generated key sits after hidden keys; documented.

### 4.4 Permissions

Generated keys are part of the proposed row, so create permissions and
field-write rules judge them like caller data (`row-scope.ts:24-81`). A key
field gated for writing makes appends fail for that actor, like any write of
the field.

### 4.5 Concurrency

Two appenders that read the same last key get distinct jittered keys after
it; both end after every row that existed at read time; their mutual order is
arbitrary. Under PostgreSQL SERIALIZABLE, concurrent appends inside
interactive transactions can fail with 40001 like any read-then-write;
documented. Rejected: monotonic-clock keys with no read (another server's
clock or a `move` to last can sit after them).

### 4.6 Changing a row's group outside `move`

`update`, `updateMany`, nested `connect`/`set` and other membership changes
keep the row's key: the row lands at a deterministic position in the new
group (its old key's), the order stays total. `move({ to })` is the supported
way to change group and place. Documented as a v1 limit (round 1 split: Opus
"documented gap", Sol "v1 or refuse"; owner decides, section 11).

## 5. `move`

```ts
db.card.move({
  where: CardWhereUniqueInput,          // the moved row
  after?: CardWhereUniqueInput,         // exactly one of after / before / first / last / to
  before?: CardWhereUniqueInput,
  first?: true,
  last?: true,
  to?: { columnId: string },            // alone: last of that group; with first/last: that end
  select?, include?, omit?,             // like update
  ...per-call controls                  // soft-delete, permissions `as`, …
});
```

Steps:

1. Read, one statement where possible: the moved row and the anchor through
   the call's domain (visibility and read permissions: missing or hidden →
   `NotFoundError`), and the bound physically (the next row after the anchor
   in `(key, primary key)` order for `after`, the previous for `before`, the
   group's first or last key for `first`/`last`/`to`), excluding the moved
   row. Group matching is null-safe.
2. If the moved row already lies strictly between the bounds in the same
   group, return it unchanged (no write: repeated drops on the same spot do
   not grow keys).
3. If the bounds tie or the new key would exceed the cap, respace (2.5).
4. One `update` through the current-scope delegate, guarded on the moved
   row's observed group and key: `{ key, group fields when they change }`.
   The delegate keeps permissions, soft delete, `updatedAt`, validation and
   `on()` update hooks. If the guard fails (the row was moved or regrouped
   concurrently), re-read and retry, at most 3 times, then fail with a
   conflict error.

Semantics, documented as is: the row is placed between the anchor and its
neighbour as observed by the read. If the anchor moves concurrently (even to
another group), the row lands where the anchor was: in the anchor's old
group. Concurrent moves of one row: the guard makes one win and the other
retry against the new state.

Transactions: no transaction or lock is needed. On `tx`, both statements run
in that transaction. In an array transaction, `move` returns a lazy thenable
that refuses admission without starting any work (an eager Promise would have
committed its effects before the refusal); tested by asserting no statement
reached the provider.

Errors: missing or hidden row or anchor → `NotFoundError`; anchor = moved
row, zero or several placements, `to` with `after`/`before` →
`ValidationError` (`INVALID_INPUT`); guard conflict after retries → the
existing conflict error class if one fits, else a new code (to verify).

## 6. `rekey`

`db.card.rekey({ where, orderBy? })`: gives every row of the matched groups
fresh, evenly spaced keys in their current order (default `(key, primary
key)`; `orderBy` lets an existing table adopt the extension in another order,
e.g. by creation time). One batched `UPDATE … CASE` per group chunk, in a
transaction where available, one atomic batch on D1. This is the adoption
path: add `rank` with any constant, deploy, run `rekey`.

## 7. Configuration (`$extends`)

`ordering({ [model]: { key, within? } })`, refused with
`ClientInitializationError` (V1004):

- `key`: a non-nullable, non-list string field with no schema default, not
  in `within`, not part of the primary key;
- `within`: distinct scalar fields (nullable allowed: `NULL` is a group);
  absent or `[]` means one global list;
- the model has a row key;
- one ordering registration per model in a chain.
- The index `(within…, key, primary key)` is the user's, documented.

## 8. Tests

- Key module: property tests over random sequences of between, prepend,
  append and respace: strict order, grammar, canonical spelling, cap, jitter
  inside the middle third, first key of an empty group jittered. Collation
  agreement: ICU across all locales (as measured), plus `ORDER BY` and `MAX`
  on real MySQL (`utf8mb4_0900_ai_ci`, `utf8mb4_cs_0900_ai_ci`,
  `utf8mb4_da_0900_ai_ci`) and PostgreSQL (`en_US.UTF-8`, `cs_CZ.UTF-8` glibc,
  ICU `und` and `cs`).
- `order`: every site in section 3, cursor both directions, distinct,
  negative take, explicit `orderBy` wins, `orderBy: []`, paginated count,
  cache identity (two clients, one cache store), findUnique batching, groupBy
  untouched; golden SQL per dialect.
- Appends: every create path, depth 2, generated parent ids, batch order, array
  transaction `[create, create]` in one group, upsert both arms, D1 read-ahead
  and single lookup, `NULL` group, explicit key accepted / malformed refused,
  permissions on generated keys, statement counts cold and warm.
- `move`: all placements, within and across groups, `to` alone, no-op, ties,
  cap respacing, guard conflict and retry, hidden anchor, self anchor, on
  `tx`, refused in array transaction with no provider effects, composition
  with soft-delete, permissions and `on()` (one update hook per move).
- `rekey`: adoption from a constant backfill, `orderBy`, large group chunking.
- Providers: SQLite, libSQL, PGlite, PostgreSQL, MySQL, D1 (workers lane).
- Types: optional key in create inputs root and nested, `move`/`rekey`
  argument and result types, config typos.
- Packed-package consumer smoke; size fixtures.

## 9. Packaging and budgets

As `viborm/on` (#124), plus what round 1 found missing:

- `package.json` exports, size-limit entries (`viborm/ordering`, "pg +
  ordering" and "D1 + ordering" app fixtures), `tsdown.config.ts`,
  `scripts/bundle-fixtures/*`, `scripts/measure-bundle.mjs`,
  `scripts/coverage-policy.mjs`, `vitest.workspace.ts`,
  `scripts/release-package-contract.json`;
- reserved official name and identity registration (`writes.ts:52`,
  `chain.ts:552` pattern), `canRequireInterceptedArray`
  (`array-transaction.ts:207`);
- AGENTS.md task table, `src/query-engine/raptor3/AGENTS.md` section for the
  create-key hook, `docs/content/docs/internals/performance.mdx` cost table,
  `extensions/ordering.mdx`, `extensions/create.mdx` (`order`), meta, index,
  CHANGELOG.
- Budget: the pg app has about 330 B of headroom (198.17 of 198.5 kB). The
  core part (order carrier, create-key slot, optional-key admission) is
  measured; any raise is argued against the hot-path rule (only the pg/D1
  querying app bundle matters).

## 10. Phasing

1. Key module, its specification, property and collation tests.
2. `order` capability (generic, shippable alone).
3. Create keys: optional-key types and admission, pre-pass, in-operation
   stages, array pre-pass.
4. `move` and `rekey`.
5. Packaging, docs, size, CHANGELOG.

## 11. Decisions for the owner

1. Group changes outside `move` (4.6): keep the key (documented), or append
   automatically in v1, or refuse?
2. Key cap 64 digits and automatic respacing: OK?
3. Physical (not visibility-filtered) last-key and bound reads (4.3, 5): OK?
4. One PR or one per phase?

## 12. Changes from round 1

| Finding (reviewer) | Change |
|---|---|
| Base 36 breaks under tailored locales (both; blocker) | Digits-only keys, measured on 89 ICU locales; real-DB collation tests (2.1, 8) |
| Append read inside the envelope: 4 round trips, breaks array route and upsert fold (both; blocker) | Pre-pass outside the envelope, array pre-pass with memo, upsert always reads (4.2) |
| Omitted key refused by create admission and types (Sol; blocker) | Optional key at runtime and in types, root and nested (4.1) |
| Invalid stored keys, adoption on existing tables (Opus; blocker) | Validation on every write, `rekey` in v1 (2.6, 6) |
| Ties place after the whole tie block (both) | `(key, pk)` bounds and respacing of tied runs (2.5, 5) |
| Unbounded growth vs VARCHAR(191) (both) | Middle-third jitter, 64-digit cap, automatic respacing (2.3, 2.4) |
| `IN (…) GROUP BY` misses NULL, breaks under ai_ci (Opus) | One positional null-safe subquery per group (4.3) |
| D1 read-ahead claim too strong; stale reads within a batch (Opus) | Honest counts, per-group memo (4.2) |
| Visible vs physical reads undefined (both) | Visibility for moved row and anchor, physical for bounds and last key (4.3, 5) |
| Eager Promise refused in array tx still commits (Sol) | Lazy thenable, no-effect test (5) |
| Stale moved-row overwrite (Sol) | Guard on observed group and key, bounded retry (5) |
| Default order `[key]` interleaves groups (Opus) | `[...within, key]`, index `(within…, key, pk)` (3) |
| Per-call carrier on every call (Opus) | Order keys the chain's engine view (3) |
| Unproven "one lookup per operation" (Sol) | One per necessary stage (4.2) |
| `move` API gaps (Opus) | Unique inputs, `to` alone, no-op, per-call controls (5) |
| Trello/Linear/Figma claim unverified (both) | Removed; semantics stated directly (5) |
| Packaging list incomplete (Opus) | Completed (9) |

## 13. As implemented (2026-10-31)

Where the implementation departs from v2, and why:

- **Appends (4.2, 4.2b).** No pre-pass in the pending operation: the
  extension's `data` create stamp is an `InsertValue`
  (`raptor3/shared/insert-value.ts`), kept out of create admission by
  `Commands.stamp` and computed by `OperationContext.#computed` on every
  INSERT path (`insert`, `insertMany`, the upsert fold) once the rows are
  final. So every create path (nested, `createMany`, `upsert`,
  `connectOrCreate`, array transactions, the batch route) is covered by one
  seam, and a create is one statement on PostgreSQL, PGlite, SQLite, libSQL
  and D1 (tested by statement count). MySQL reads the last key inside the
  operation with a consistent read (no lock): one more statement than a
  create without the extension (3 instead of 2, MySQL already re-reads the
  created row). In batch preparation (array transactions) MySQL falls back
  to the one-statement form; documented with its deadlock risk.
- **Validation (2.6).** Not through `request` (its errors reach the caller
  wrapped and redacted): `orderingKey`, a Standard Schema validator the key
  field declares (`s.string().schema(orderingKey)`), checks every write,
  nested ones included, with a real `ValidationError`.
- **`move` reads (5).** Through the public delegate: the row (`findUnique`),
  then the anchor and its neighbour in one `findMany` with `cursor` and
  `take: ±2` under the default order (or `findFirst` for an end). The bound
  is therefore visibility-filtered, not physical: placement is correct among
  the rows the caller sees. The update is guarded on the row's observed key
  and list (`where: { …unique, rank, columnId }`), retried 3 times. 3 round
  trips (2 reads, 1 write).
- **Respacing (2.5).** A tie or a key past 64 digits respaces the whole list
  (`rekey`'s path, one array transaction of updates), not just the run.
- **Transactions.** Model factories now receive the client scope as their
  second argument (`model: { card(delegate, scope) {…} }`), which `rekey` and
  respacing use for `$transaction`. `move` and `rekey` return lazy thenables:
  an array transaction refuses them before any statement (tested).
- **4.6.** Group changes outside `move` keep the row's key (decision §11.1
  applied as recommended).
- **Measured.** pg application +670 B (198.85 kB), D1 +730 B (197.8 kB);
  `viborm/ordering` entry 11.94 kB; pg application with ordering 203.01 kB.
  Same-gap growth ≈0.6 digit per insert; 2,000 appends stay ≤ 11 characters.

## 14. Adversarial review of the code (PR #127, 2026-10-31)

Opus and GPT-6.1 Sol, independently, on 4ce86bc. Fixed in the PR:

| Finding (reviewer) | Fix |
|---|---|
| Respacing rewrote only the visible rows, so hidden rows and rows outside `rekey`'s `where` interleaved (both) | Respacing is one UPDATE per call over whole physical lists (`ROW_NUMBER() OVER (PARTITION BY list ORDER BY key, id)`), lists named by the rows `where` matches |
| Respacing sent 2 statements per row, too many for D1's per-invocation limit (Opus) | One statement per call, whatever the list's length |
| Respacing overwrote a row moved concurrently (Sol) | Each row is matched by key, list and its key as read: a row moved meanwhile keeps its new key |
| Respacing dropped per-call controls (Sol) | Only the read of the lists takes them; the UPDATE is maintenance |
| A computed key was published as its SQL expression, so a nested foreign key to it re-evaluated it (Sol) | Interactive route reads it back with RETURNING; batch route publishes a read of the stored row by its key |
| `move` with a compound unique input, or an anchor named by a secondary unique field, failed (Sol) | Rows are identified by their row key once read; the anchor is found by position in the cursor read; the moved row is skipped by identity |
| Adoption: a backfilled constant broke creates differently per dialect (Opus) | The append's MAX only reads digit strings; MySQL's JS path reads only the integer of a malformed last value (`keysAfter`). Documented backfill: `""` |
| Docs said MySQL array transactions use the one-statement form (Opus) | Corrected: MySQL always reads first |
| `move` loop unbounded on respace paths; overflow threw RangeError (Opus) | Every pass counts toward 3 attempts; an overflow respaces |
| Random digits biased (byte % 10) (Opus) | Rejection sampling |
| Lazy thenable had no catch/finally (Opus) | Added |

Accepted, not fixed: a `createMany` split into several statements by a bind
budget numbers each statement's rows from the start of the call, so integers
skip ahead (3,000 rows under D1's budget end at integer 46,499; order intact;
the 10^9 cap is far).

## 15. Adversarial review, round 2 (PR #127, 2026-10-31)

Opus and GPT-6.1 Sol, independently, on 2f980ac. Fixed in the PR:

| Finding (reviewer) | Fix |
|---|---|
| `rekey()` without `where` rewrote every list, whatever the caller could see; its count leaked hidden rows (Opus) | Lists are always named through the caller's view (`findMany` distinct on the list fields); a list with no visible row is left alone |
| Respacing named the table without the client's namespace: on PostgreSQL with `namespace`, it rewrote a same-named table in `public` (Sol) | Respacing renders with the client's own engine `Queries` (namespace, physical column names, encodings), read from a registry the engine fills when it is built (`renderers`, by schema then adapter, in `insert-value.ts`). Importing `Queries` into the entry instead split the shared chunks so that every application bundle grew about 0.2 kB; the registry costs them about 30 B |
| Respacing bound list values as given, not as the column stores them (SQLite INTEGER DateTime, decimals, compact ids): no row matched (Sol) | List values bound through `Queries.fieldValue` |
| A list field in a compound row key was selected twice: PostgreSQL 42702, MySQL 1060 (Sol) | Each column selected once |
| Respacing bound one value per list field per list: past D1's 100 values, refused (both) | As many lists per statement as the driver's `maxBindParametersPerStatement` allows |
| `rekey` left the official cache's reads stale (both) | `rekey` calls the client's `$invalidate("model:*")` (captured at apply time: the method scope has none) |
| `rekey({ orderBy })` broke ties by id, scrambling equals (Opus) | The current key orders equals, then the row key |
| A written key with a 9-digit integer part blocked every later append to its list (Opus) | `orderingKey` refuses keys of 10^8 or more |
| `move` compared Date list values through `String()`, to the second (Opus) | Dates compared by instant |
| An anchored `move` with a nullable list field scanned the table (the engine's cursor cannot seek past a nullable leading column; 22 ms vs 0.2 ms at 200k rows) (Opus) | With a nullable list field, the anchor is read first and its neighbours within its list, in (key, row key) order: one more statement, bounded by the list |
| `to` and the placements were untyped; `{ after, before }` compiled (both) | `to` keyed by the `within` fields with their types; placements exclusive (`?: never`); `rekey` generic so per-call controls pass, `orderBy` limited to scalar fields |
| `NotFoundError` did not say which row (Opus) | `move` vs `move anchor` |
| Adoption needed two deploys: push refused a required column on a populated table, `ordering()` refused a default (Opus) | A literal string default is admitted; documented recipe `s.string().default("")`, push, `rekey`, then optionally the validator |
| Docs: `orderBy: []`, digit backfills, client keys after a respace, unique constraint on the key, MySQL snapshot reads, "pays nothing" (both) | Corrected or added |

Not fixed, documented: list fields under a case-insensitive collation (Sol:
`"a"`/`"A"` are one list to the database, two to the extension).

Not done, for a later round:
- **The core cost of the hooks.** The pg/D1 app bundle without the extension
  is about 0.9 kB gzip larger than on `main` (measured by Sol: pg 198,190 →
  199,115 B). Trimming candidates: `admitOrder`, the `#computed` scan.
- **MySQL `move` takes 6 statements** (the generic guarded update path on
  MySQL), against 3 elsewhere.
- **Fewer statements per `move`.** A no-op `move` could skip its final
  re-read (3 → 2).
- **Batch moves** for multi-select drags.
- **Typed config.** `key`/`within` are checked at startup, not at compile time.

## 16. `move` in two statements (2026-10-31)

The owner found three statements per move (six on MySQL) too many. A move no
longer reads the row it moves:

- **The read:** one statement, the anchor's window (or the two rows at a
  list's end). The moved row is recognised among the rows read by the fields
  its `where` names, a compound selector's included.
- **The write:** its key alone, on `{ ...where, ...list }`, where the row is
  already in the target list. The list fields are never written on a reorder,
  so a field permission on them (`fields.columnId.write`) still allows
  reordering within a column. Where that matches no row, a second `update`
  writes the key and the list. `to` tries the change of list first.
- **No-op:** detected from the window. The row already next to the anchor, or
  at that end, is read back in its projection without a write.
- **Given up:** the guard on the row's key as read. Two moves of one row at
  once: the last write wins (each still lands between real neighbours).
  Attempts now bound only the respace loop.

Statements on PostgreSQL, SQLite, libSQL and D1: within a list 2 (was 3),
into another list 3, `to` 2, `first`/`last` of its own list 3, no-op 2.

MySQL: 5 statements (was 6). The rest is the engine's MySQL `update`, which
takes 4 statements for any update (`SELECT`, `UPDATE`, `SELECT … FOR UPDATE`,
`SELECT`), against 1 for `updateMany`. That belongs to the engine and every
MySQL user, not to this extension.

## 17. `move` in one UPDATE (2026-10-31)

Owner: "the key needs to be computed inside the update, that's it."

- **Engine.** An `update`'s data may hold an `InsertValue`, the hook appends
  already use. It is set aside from admission (`EngineSchema.#admitArguments`)
  and replaced by its expression before the SET is built (`#settled` in
  `update`, `updateLocated`, `updateMany`). On the batch route it is read
  back after the write, never published as its expression.
- **The key** (`between.ts`, PostgreSQL and SQLite): any key strictly
  between the two around the place, read by scalar subqueries in the same
  statement.
  - The integer after the lower one where the gap holds one.
  - Else the lower one extended by two random digits, behind as many zeros
    as keep it below the upper one where the upper one extends it.
  - NULL for tied or unordered bounds, a missing anchor, or a key past 64
    digits.
  - A key grows by one or two digits per placement into one gap (the JS
    midpoint grew by about half a digit).
- **The write.** `update({ where: { ...where, rank: { equals: () => CASE
  WHEN <key> IS NOT NULL AND <row in the anchor's list> AND <not already in
  place> THEN rank END } }, data: { rank: Computed(<key>) } })`. One
  statement. On a miss (the row is in another list), a second UPDATE writes
  the key and the list, guarded on the row being outside it. On a miss of
  both (tie, gap used up, missing row or anchor, already in place), the read
  path of §16 runs: reads, respace, write.
- **Statements.** Within a list 1, into another list 2, `to` 1,
  `first`/`last` 1. MySQL keeps the read path (it refuses a subquery on the
  table an UPDATE writes, and its reads there lock).
- **Given up.** Anchors and neighbours are read from the table, not through
  the caller's extensions: a soft-deleted or forbidden row can be an anchor
  or a neighbour.
- **Removed.** `keyBetween` and `keysBetween` are no longer exported (owner:
  the browser use case is not wanted). `isKey` and `MAX_KEY_LENGTH` stay.
- **Tests.**
  - Every provider replays a seeded 200-move model check.
  - The statement counts are asserted on SQLite.
  - A write hook receives a moved row's stored key.

## 18. MySQL (2026-10-31)

Owner: five statements per move on MySQL is too many.

- **Engine: a MySQL `update` goes from 4 statements to 3.** Without
  RETURNING it sent:
  1. the locating `SELECT … FOR UPDATE`;
  2. the `UPDATE`;
  3. a confirming `SELECT … FOR UPDATE` of the demanded fields;
  4. the terminal read of the result.

  The confirming read now selects the columns a RETURNING would carry, both
  the result's projection and the demanded fields
  (`OperationContext.update`). Its row answers the operation as a RETURNING's
  does. `execution.#answeredByRoot` offers that answer to a root `update` on a
  driver without RETURNING (`answersAfterUpdate`: scalar projections that
  refuse nothing while decoding); `answersInStatement` is untouched. The whole
  MySQL provider suite passes (1,366 tests).
- **`move` on MySQL keeps the read path: 4 statements** (was 6), 5 with a
  nullable list field. The one-statement move was tried there. It works with
  every read in a derived table, at 3 statements, but MySQL locks every row a
  statement's subqueries read (the locating `SELECT … FOR UPDATE`, the
  `UPDATE`'s SET). Under four writers moving cards in two lists, 37 moves of
  240 failed with deadlock 1213; the read path had none and ran faster
  (126 ms vs 206 ms).
- **Tests.** Every provider asserts the statements a move within a list and
  an update take: 1 and 1, on MySQL 5 and 3.
