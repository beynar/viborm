# Schema-declared database views: API and plan

Status: proposal of 2026-11-18, implementation started on branch `views`.
Scope decided by the maintainer the same day: ordinary views on PostgreSQL,
MySQL and the SQLite family (SQLite, D1, libSQL, Durable Objects),
PostgreSQL materialized views, SurrealDB `DEFINE TABLE … AS SELECT`. Snowflake
is out: a schema holding a view is refused on a Snowflake client. A view is
derived from a VibORM query (no hand-written SQL), VibORM's migrations own it
(`push` and `migrate` create, replace and drop it; no "existing view" mode),
and the client reads it as a read-only model.

This file is normative for the work: a unit that needs to leave it says so in
its report instead of deciding alone.

## 1. What was measured before writing this (2026-11-18)

On PostgreSQL 18, MySQL 8.4, SQLite 3.51 and SurrealDB 4.0.0:

- A view body wrapped as `SELECT * FROM (<body>) AS "<marker>"` keeps the
  marker alias in what each catalog returns (`pg_get_viewdef`, MySQL
  `VIEW_DEFINITION`, `sqlite_master.sql`), always as the last token. All three
  planners flatten the wrapper: an outer `WHERE id = …` is an index lookup on
  the base table. MySQL lowercases the alias in column references but keeps it
  as written after the body, so the marker is lowercase.
- A correlated JSON subquery is a legal view column on all three; the column is
  `json` on PostgreSQL and MySQL and text on SQLite.
- PostgreSQL refuses `ALTER COLUMN … TYPE` on a column a view reads and
  `DROP TABLE` under a view; it follows a column rename. MySQL breaks the view
  on a rename (error 1356 at read). SQLite rewrites the view text on a rename
  and loses the column alias (the view's column is renamed too).
- `REFRESH MATERIALIZED VIEW CONCURRENTLY` runs inside a transaction and needs
  a unique index.
- SurrealDB: `DEFINE TABLE v AS SELECT … FROM t WHERE … [GROUP BY …]` is kept
  up to date for writes to `t` (insert, update, delete; `count`, `math::sum`,
  `math::max` and `time::floor` buckets included). It PARSES a link traversal
  (`author.name`) and a subquery in the projection or the filter, but those go
  STALE: a later change to the linked record is never applied. `ORDER BY` and
  `LIMIT` are a parse error. `INFO FOR DB STRUCTURE` reports `view` and
  `comment`. A view on a view works. The database refuses writes to it.

## 2. API

### 2.1 An ordinary view

```ts
const publishedPost = s
  .view(() => post, {
    where: { published: true },
    select: {
      id: true,
      title: true,
      authorId: true,
      author: { select: { name: true } },               // JSON column "author"
      comments: { orderBy: { createdAt: "desc" }, take: 3 }, // JSON column "comments"
      _count: { select: { comments: true } },             // JSON column "_count"
    },
  })
  .map("published_posts");

const db = createClient({ schema: { user, post, comment, publishedPost }, driver });

await db.publishedPost.findMany({
  where: { title: { contains: "orm" } },
  orderBy: { title: "asc" },
  take: 20,
});
// { id, title, authorId, author: { name }, comments: Comment[], _count: { comments: number } }[]
await db.publishedPost.findUnique({ where: { id } }); // the view projects post's key
await db.publishedPost.count({ where: { authorId } });
// db.publishedPost.create: absent from the type, refused at run time
```

- `s.view(source, query)`: `source` is a thunk to a model or to another view
  (schema rule 3); `query` is what `findMany` takes on that source, typed and
  refused like a client call. The view is a `Model` whose state is derived on
  first read; a modifier chained on it (`.map()`) reads the source at once.
- The view's columns are: each selected scalar of the source, stored as the
  table stores it under the same column name; and one JSON column per
  non-scalar selection (`include`d or selected relation, `_count`,
  `_aggregate`), named by its key. A JSON column holds exactly the document a
  read carries today, and the client decodes it with the read's own decoder.
- Root scalars are NOT the transported spellings of a read (bigint as text,
  compact ids as hex): the view keeps stored types so that a filter, an order
  or an aggregate on the view means what it means on the table.

### 2.2 What a query may say

Everything `findMany` reads, with these refusals, each named in the message:

| Refused at the root | Why |
| --- | --- |
| `cursor`, a negative `take` | a paging anchor and a result-side reversal, not a row set |
| `orderBy` or `skip` without `take` | a view has no order; order at the read |
| an operand that is not a plain value (caller `Sql`, callbacks) | nothing to render as a literal, nothing to hash |
| recursive projections, polymorphic variant slots | their reads can refuse while decoding; a view would refuse on every read (lifted later if asked) |
| `orderBy` by vector distance | binds a query vector per call |

Inside a relation everything stays allowed (`where`, `orderBy`, `take`,
`skip`, `cursor`, nested relations): it is inside the document.

### 2.3 The key is derived, not declared

A findMany view returns source rows, so a key of the source whose fields are
all projected is a key of the view: `findUnique`, cursors and relations follow
from selecting it. Nothing is asserted that the database cannot guarantee. (An
aggregated view's key is its `by` list: PR 4.) A view that projects no key has
`findMany`, `findFirst`, `count`, `aggregate`, `groupBy`, `exist` only.

This replaces "if the view declares a key" by "if the view has a key". A
declared `.id()` can be added later if a case needs one the query cannot show.

### 2.4 JSON columns at the client

Selectable (`select`, `omit`, returned by default: a view row is the declared
query's row). Not in `where`, `orderBy`, `by`, `cursor`, `distinct`, and no
nested arguments: the document is frozen. On PostgreSQL the column is `json`,
which has no equality, and on MySQL and SQLite it is text or a JSON value with
other comparison rules; a filter on it would mean three things.

### 2.5 Relations of a view (PR 2)

Decided by the maintainer on 2026-11-20, replacing the first draft (relations
declared with `.extends()` on the view and on its targets): a view inherits
its source's relations.

```ts
const livePost = s.view(() => post, {
  where: { published: true },
  select: { id: true, title: true, authorId: true },
});

await db.livePost.findMany({
  where: { author: { name: "Ann" }, comments: { some: {} } },
  include: { author: true, comments: { take: 5 }, _count: true },
});
```

1. A view inherits each relation of its source whose key columns it keeps:
   the `.fields()` of a to-one, and for a to-many the source columns it
   references. Nothing is declared.
2. On those relations a view reads exactly as its source: relation filters,
   an order by a relation, `include`, nested `select`, `_count`, joined when
   the view is read (no JSON, no repeated row).
3. A relation whose key columns the view does not keep is not available:
   absent from the types, refused at run time with the missing column named.
4. Read only: the view has no write operation, so nothing writes through it.
5. No inverse on the target models.
6. No `.extends()` on a view.
7. A `select` of a relation in the view's definition stays a JSON column.
8. Aggregated views (PR 4) inherit nothing.
9. Materialized views (PR 3) inherit the same way, joined to the live source
   tables; on SurrealDB too.

**As built.**

- **The slot is the source's.** `s.view` holds, in its derived state, every
  relation of its source whose name none of its columns takes (the targets
  are not read there: `.map()` derives the state at declaration, before they
  exist). The resolver declares no slot for a view (`collectSlotNodes`) and,
  once the schema's slots are resolved, gives each view the source's
  `ResolvedSlot` for each of those relations whose key columns it keeps
  (`buildIndex`, `slotKeyFields`), in its source's order, a view after the
  view it reads. No edge is published for it: no constraint, no snapshot
  change, no id-domain edge, no migration.
- **Read at the slot's own model.** Every reader that tells a slot's two ends
  apart asks the slot's model (`resolved.slot.source`), not the model it is
  read at: the engine's membership (`buildMembershipView`), `slotTarget`, and
  the identity's crossing walk. A view's membership is its source's with the
  view's rows in place of the source's, under the same field names.
- **Refused with its reason.** A relation the view names but does not inherit
  has refusing schemas for every use (`refusedRelationSchemas`, from
  `uninheritedRelationMessage`), and `_count: true` counts the slots the view
  has. A relation declared with `.extends()` on a view is `W003`; one that
  targets a view is `R002`, with a message that says why.
- **Types.** `ViewState` picks the source relations whose key fields
  (`SlotKeyFields`, the type twin of `slotKeyFields`, proven at the source
  table) the view keeps, under a name no column takes. A view's to-one is as
  nullable as its source's: the client relinks a view's source with it
  (`ViewSourceLink`, `LinkedView`), and the emptiness of a slot read at a view
  is asked at that source (`StateSlotOwner`). A junction or a variant inverse
  whose source references a non-primary key is typed as joining on the row
  key; a widened or unproven graph inherits nothing in the types.
- **Cost.** A schema without views, on the packed 50- and 100-model fixtures
  (TypeScript 5.9.3): `base` +0, `deep` +103, `filter` +132, `create` +55,
  and `extended` +313 at 50 models, +763 at 100. A schema with three views,
  checked from source against the first draft (`.extends()`): +7,175
  instantiations (+3 %) where no relation is read, the views now holding
  their source's relations in their types; the same relation read through a
  view, +13,275 (+5.7 %), with one more relation inherited (the junction).
- **Bytes.** The pg application +555 B and the D1 Worker +532 B (gzip): the
  resolver's inheritance, the refusal of an uninherited relation with its
  reason (about 220 B of it), and `_count: true` counted from the slots.

### 2.6 Materialized views (PR 3)

```ts
const authorDigest = s
  .view(() => user, { select: { id: true, name: true, posts: { where: { published: true } } } })
  .materialized()
  .index("name");

await db.authorDigest.$refresh();                       // REFRESH MATERIALIZED VIEW
await db.authorDigest.$refresh({ concurrently: true }); // readers are not blocked
```

- PostgreSQL: `CREATE MATERIALIZED VIEW … WITH DATA`. The derived key becomes
  a unique index (what `CONCURRENTLY` needs); `.index()` creates real indexes.
  `$refresh({ concurrently: true })` without a key is refused.
- MySQL, SQLite family: an ordinary view (maintainer's decision); `.index()`
  creates nothing; `$refresh()` resolves without sending a statement. The docs
  say plainly that every read then pays the whole query.
- SurrealDB: the table is kept up to date by the database; `$refresh()`
  resolves without sending a statement.
- No incremental refresh (`pg_ivm`) and no trigger emulation in this project.

As built (2026-11-19):

- **One fact says a database stores a view's rows**:
  `MigrationDriver.materializesViews()`, true on PostgreSQL. Where it is
  false the snapshot of a `.materialized()` view, its hash and its program
  are those of the same ordinary view, `.index()` included.
- **Snapshot**: `ViewDef.materialized` and `ViewDef.indexes` (a table's
  `IndexDef`), both absent on an ordinary view. `materialized` is in the
  hash, only when true: a change of kind replaces the view by the one
  existing rule. The declared indexes are not in the hash. The view's keys
  are: each is a unique index on stored rows, and one its source gains would
  be built on the rows of the last refresh, which the source's new
  constraint says nothing of (a review probe: the migration failed on a
  duplicate the source no longer had). Replacing the view computes them
  first.
- **Indexes**: a unique index per key the view derives
  (`getModelKeyCatalog(view).addressableKeys`), named as a table's primary
  key and uniques are, then each declared `.index()`. A view that keeps its
  hash has its indexes diffed into the existing `createIndex`/`dropIndex`
  operations against its name, so an index change keeps the stored rows; a
  replaced view is created with its indexes by its `createView`
  (`withViewReplacements` leaves out an index operation on a view it
  replaces).
- **`.index()` on a view** (W002): only when materialized, on scalar columns,
  never unique. A unique index is a key (`keys.ts`), and a view's keys are
  the ones its query shows; MySQL and SQLite would not hold the rows to
  another.
- **`$refresh`** is the adapter's statement (`DatabaseAdapter.refresh`,
  PostgreSQL's alone) sent as the delegate's own `$executeRaw`: in its
  transaction, and what a raw statement is to an extension (no permissions
  policy, no soft delete, no cache invalidation). It is sent when awaited
  (a thenable), so the array form of `$transaction`, which takes operations
  alone, refuses it with nothing sent. Typed on a materialized view's
  delegate only (`MaterializedView`, asked in the view arm of `Client`).
- **Measured on PostgreSQL 18**: `pg_get_viewdef` of a materialized view ends
  with the marker; under one, a column type change, a column drop and a table
  drop are refused, a rename is followed, a primary key change and an added
  column are survived. So `changedTables` is the ordinary view's.

### 2.7 SurrealDB (PR 3)

`DEFINE TABLE <view> AS SELECT <fields> FROM <source> WHERE <own-field filters>`.
Admitted: scalars of the source, filters on the source's own fields. Refused
with a named message: any relation in the projection or the filter (measured
stale), `take`/`skip`/`orderBy` (parse error). Aggregated forms arrive with
PR 4. `.materialized()` changes nothing there.

As built (2026-11-19):

- The body is `SELECT id, <stored fields> FROM <source> [WHERE id != NONE
  AND (<filter>)]`, written by the migration driver's own writer
  (`drivers/surrealql/view.ts`). The filter is the read backend's lowering,
  its bound values written as SurrealQL literals; a value with no exact
  literal is refused. `id != NONE` is there because the server evaluates a
  view's filter on a deleted row whose fields are all `NONE`.
- A view row keeps its source record's id, compound ids included, so a
  view's key order is its source's and `findUnique` holds when the view
  projects the key.
- The marker is the table's `COMMENT`; introspection reads a view table as a
  view, and reset leaves out a view VibORM did not create.
- The writer takes the read backend from the client the migration is bound
  to: no migrations bundle imports the SDK, and an unbound driver refuses to
  write a body.
- A foreign key added or dropped on a table a view reads replaces the view
  (`links` in `withViewReplacements`): the column then holds a record link,
  or stops holding one, and the view's filter on it was written for the
  other form. So does any change to a column: the filter is lowered for the
  column as it was (a column that becomes nullable needs a `!= NONE` guard
  its filter did not have, without which every write of `NULL` to the table
  fails), and the hash holds neither the body nor a column the query only
  filters by. A golden body in the SurrealDB provider tests stands where the
  SQL dialects' stand: a release that lowers a filter differently fails it
  and must raise `VIEW_REVISION`.
- A view inherits its source's relations on SurrealDB too. A view's row is
  its source record under the view's own table, and its column copied from
  the source's link holds a record of the table that link targets: a slot
  read at the view compares records with that table, and the view's own key
  by the key it names (`#heldAs`); an edge table is walked from the source
  record (`edgeOf`'s `from`), and a relation filter of a view is asked row by
  row, since no holder list names a view's records (`#holders`). A write that
  moves a key follows the links tables hold, never a view's (`slotsHeld`).

### 2.8 Aggregated views (PR 4)

Reporting views are part of the need, in a following PR because they need one
more decision the plain views do not: an aggregate must be a flat, typed,
filterable column (the point of such a view is `where: { total: { gt: … } }`
and an index on a materialized one), where `groupBy` today answers nested
documents (`_sum: { amount }`). Sketch, to be confirmed in that PR:

```ts
const salesByDay = s.view(() => order, {
  by: [{ createdAt: "day" }, "currency"],
  timeZone: "Europe/Paris",
  _sum: { amount: true },
  _count: { _all: true },
}); // columns: createdAt, currency, sumAmount, count; key: (createdAt, currency)
```

Time steps exist on PostgreSQL only, as in `groupBy`.

As built (2026-11-19), the sketch confirmed with one difference (a stepped
column is text):

- **A query with `by` is an aggregated view's.** `s.view` has two overloads,
  so an ordinary view never instantiates `groupBy`'s types (`by?: never` on
  `ViewQuery` is what sends a grouping query to the second). The query is
  what `groupBy` takes, under the root rule ordinary views have (an order or
  a skip only with a `take`).
- **Columns**: a grouped field under its name; `count` for `_count: true` or
  `_all`, `countField` for a counted field; `sumField`, `avgField`,
  `minField`, `maxField`. Two columns of one name are W004's.
- **Each column is a scalar the view derives** (`derivedScalar`,
  `ViewFacts.aggregated.scalars`), named by the view: no `.map()`, default,
  key or generator flag of the field it reads carries over. `_min`/`_max`:
  the field's scalar, nullable. `_avg`: a number, the field's decimal for a
  decimal. `_sum`: a number for an int or a double (what `groupBy` answers
  past the int range), a bigint for a bigint, and for a decimal one of the
  field's scale as wide as every provider that stores the field stores one:
  18 - s digits where SQLite stores it (p + s <= 18), 65 - s where MySQL does
  and SQLite does not, 1000 beyond. A first form, `max(p, 18 - s)`, left a
  field with p + s >= 18 no room above its own range (a review probe: two
  rows of `decimal(20, 2)` near its maximum failed every read of the view on
  PostgreSQL, and would have blocked the refresh of a materialized one). `_count`: an int. A stepped `by`
  member: a string, the `YYYY-MM-DD` text `groupBy` publishes for a period.
- **One fact says where a column comes from**: `ViewFacts.aggregated.origins`
  and `heldField(facts, column)`, which the identifier domains read: `_min`/
  `_max` of an identifier keep its stored format that way.
- **No relation.** An aggregated view's columns are not its source's, so it
  inherits none of its source's relations (§2.5, rule 8), and a call that
  names one is refused as an unknown key.
- **The key is the `by` list** when no member is nullable: one member is a
  single-field key, several a compound key named as `.id([...])` names one.
  A materialized aggregated view therefore has its unique index, and a
  concurrent refresh, with nothing added.
- **The body is the read compiler's own `groupBy`** (`view-body.ts`), its
  root projected flat, and without the order `groupBy` gives its groups when
  the query takes no window (`groupOrderTerms`): a view has no order. A column is always a column of its scalar: the
  dialect's migration driver casts an aggregate to the scalar's column type
  (`ViewColumnSql.viewCast`) where the cast keeps its value. MySQL casts
  doubles only: its `CAST` to `SIGNED` or `DECIMAL` clamps an out-of-range
  value with a warning, where its own `COUNT` and `SUM` are exact. A total
  past what its column holds is a refused read, never another number.
- **On SurrealDB** an aggregated view is `DEFINE TABLE … AS SELECT <by>,
  <aggregates> FROM <source> [WHERE …] GROUP BY <by>`, which the database
  keeps current through an insert, an update of an aggregated, grouped or
  filtered field, and a delete down to an empty group (measured). A group's
  record id is the list of its `by` values, even of one, so the view's key
  order is its `by` list and `findUnique` fetches the record; a key or a
  link in `by` is grouped by its value (`record::id`, behind `IF` where the
  link may be unset: `record::id` of none fails every such write), an
  integer as an `int` (`<option<int>>` where it may be unset: the column is
  an `i32`, which a lookup by value does not find in a record id), and a
  key or a link that is a decimal or an instant as that value (`<decimal>`,
  `<datetime>`: a record's key holds its text, which a lookup by value does
  not name). Each aggregate is written so that the view holds what
  `groupBy` answers (a bigint sum on a decimal accumulator, which a write
  never overflows, `<option<decimal>>` where the field may be unset: a plain
  cast of none fails every such write; a decimal average rounded as the read
  rounds it; `NULL` for a group with no value). Refused, with the view named: a `having`, a
  time step, a sum or an average of doubles (the stored total drifts after
  deletes), a minimum or a maximum of text, an enum or a boolean, and any
  aggregate of a key or a link (a record there).
- **A derived column is no key in its type either.** `columnOf` clears what
  the source declared for its own column, and the type does the same
  (`Keyless`): `.extends()`, which W003 refuses on a view but the types
  admit, reads a view's keys from its columns again, and typed the least id
  of a group, or one member of a compound `by`, as a key that the run time
  refuses.
- **A list in a query** (`in: [...]`, `orderBy: [...]`, `OR: [...]`) is a
  read-only tuple under `const`. The constraint of both overloads takes
  every list read-only (`ReadonlyLists`): with a mutable one the inference
  failed in silence and the view was typed with every scalar of its source,
  a defect of the first views PR found here.

## 3. Hard points

### 3.1 No parameters in DDL

The body is compiled by the read compiler itself (a `Queries` subclass that
only changes how root scalars are projected: no second compiler), then rendered
by `inlineLiterals(dialect, statement)` (`src/adapters/inline-literals.ts`),
which walks the `Sql` tree and writes each bound value as a literal of its
dialect. It is a sibling of `Sql.toStatement`, so value positions are exact and
no SQL text is parsed; casts are already in the text around each value. It is
a module only the migrations import, not an adapter member, so no application
bundle carries it.

Each literal is what the dialect's reference driver sends for the value in the
same position, so the inlined text reads the rows the bound statement reads
(57 engine reads compared bound and inlined on PostgreSQL 18, MySQL 8.4,
SQLite and PGlite). PostgreSQL: quoted constants of unknown type, numbers and
booleans included (`'10'`, as node-postgres sends them; a bare `10` is
`int4`), `E'…'` when the string holds a backslash, `…::bytea`, one array
literal for a JavaScript array. MySQL: `mysqlStringLiteral`, bare numbers,
`X'…'`. SQLite: numbers as REAL (`10.0`, as the drivers bind them), negatives
in parentheses (`5 --3` opens a comment), `X'…'`. A value kind no read of the
dialect binds is a refusal, not a guess (`Date`, a string holding NUL on
PostgreSQL and SQLite). The compile uses a fixed adapter configuration (no
shared relation bodies, no transport bounds), so two drivers of one dialect
write the same text.

### 3.2 Identity

The identity of a view is a hash of what was DECLARED and of what the client
will DECODE, not of the SQL text (`viewDefinition`,
`src/migrations/view-definition.ts`): a revision number, the source table,
the declared query, the decoder
shape of a view row, and the resolved relations the query crosses.
The text is kept in the snapshot (a migration must be able to write the view
again, and a down migration the previous one) but is not compared. The hash is
40 hex characters, so its marker fits an identifier on every database.

The declared query is written without loss (`identityValue`): a value JSON
has no spelling for is tagged, a record that would read as a tag is wrapped in
`$raw` (the schema document's rule), a column named by a field reference or by
the callback that hands one out is `$field`, and no schema-object filter of
the identity ever reads the query's own values. Two queries that differ never
hash as one, which a first encoder got wrong three ways (Devin, 2026-11-18): a
`JsonNull` and the object spelling its tag, a JSON operand with a member named
`~`, and two callbacks naming different columns.

The relations are in because a relation can move between two columns that both
stay, with the same foreign keys: the body changes, and no column, shape or
query does. Only the relations the query crosses are in, found by walking the
query's keys against the resolved index: a relation added elsewhere on a
table the view reads changes nothing. Field names are the schema's, not the
columns': a field renamed over the same column changes the identity, and the
view is replaced once (the decoder shape is keyed by field names too).

The body is not in the identity, so nothing notices by itself that a release
writes a JSON column in another encoding under the same decoder shape. A
golden body per dialect (`view-definition.core.test.ts`) fails on any change
of the text and states the choice: update the text, or raise the revision.

Why not the text: every engine change that respells a read would produce a
migration per view on the next VibORM upgrade, and a materialized view would
be recomputed for nothing. Why the decoder shape is in: JSON columns are
positional arrays since #191; a view written for another shape would decode
wrong in silence. Why the tables' columns are NOT in the hash: the differ has
both snapshots and applies one rule (3.3). `revision` is a constant of the view
owner: a release that must rewrite every view body (a fixed lowering bug)
bumps it on purpose.

In the database the identity is the lowercase marker alias of the wrapper
(`viborm_view_<hash prefix>`), one mechanism for PostgreSQL, MySQL and SQLite,
written by the `CREATE` itself (MySQL has no comment on a view; a separate
`COMMENT` step would need its own stepwise probe). SurrealDB: `COMMENT`. A view
without the marker under a declared name is refused, as today.

### 3.3 Order and dependencies

- A snapshot view lists what it reads (`dependsOn`: tables and views, found by
  walking the relations the query names).
- Two operations, `createView` and `dropView`. A replacement is a drop and a
  create (PostgreSQL's `CREATE OR REPLACE` refuses a changed column list; one
  path for every change and every dialect).
- One rule, held by the program and not by the differ
  (`withViewReplacements` in `src/migrations/view.ts`, the last step of
  `prepareSchemaProgram`): a view is dropped before and created again after
  when its identity changed, when the program changes a table it reads in a
  way the view does not survive, or when a view it reads is dropped. The
  differ alone cannot hold it: the resolver diffs again from a snapshot where
  accepted renames are applied and keeps the last diff only.
- What a view does not survive depends on the dialect. Everywhere: a table
  renamed, dropped or created again, a column dropped, renamed or given
  another type, an enum recreated under one of its columns, and a primary key
  added or dropped (no database refuses that under a view, but a body orders
  its rows and its relations' rows by the key: which row a `take` or a
  `distinct` keeps). On SQLite, which
  rebuilds a table to change it and refuses the rebuild under a view: every
  other change too, except an index. PostgreSQL and MySQL keep a view through
  an added column and a key, unique or foreign key change, so a `GRANT` on it
  is not lost for those, and a materialized view (PR 3) is not recomputed.
- Drops run first, dependents before what they read; creates run last, in the
  other order. They are not placed next to the operation that needs them:
  with several tables and views on views that is one order to prove per
  shape, for a gain on MySQL alone (the time a replaced view is missing).
- Dropping a view loses no data and asks no consent. A materialized view is
  recomputed by its `CREATE`; the plan says so.
- Reset drops views before tables. Neki: `CREATE VIEW` resolves names, so
  `catalogCommitBoundaries` puts a commit before it after an unseen change.

### 3.4 `include` in a view

Answered in 2.1 and 2.4: documents are stored as the read carries them, decoded
by the read's decoder compiled from the same shape, and that shape is in the
identity. The client allows `select`/`omit` on them and nothing else.

### 3.5 Materialized

Answered in 2.6.

### 3.6 Extensions

One principle: an extension acts per call on a client; a view is compiled once
from the schema. So only schema facts go into the body.

- Schema `.omit()`: a hard exclusion of a projection already
  (`projectableScalarNames`): the field is in no `select` and no default
  projection, at the root and in every relation. A view cannot select it.
- Soft delete, permissions, client `omit`, `defaults`: not in the body. They
  apply when the view is READ, to the view as its own model. Soft delete: the
  body shows deleted rows unless the query filters them
  (`where: { deletedAt: null }`), or the view projects the column and is
  listed in the extension. Permissions: a view has no policy until one is
  written for it, so a governed client refuses to read it (R9, deny by
  default); the source model's policy does not carry over, as with any SQL
  view. The docs state both.

An aggregate reads a field the schema omits, as in any read today
(`_max: { secret: true }` answers it on `aggregate`, `groupBy` and a
relation's `_aggregate`): `aggregate.ts` builds its keys from every scalar.
So a view can hold one through `_aggregate`. That is the read path's rule,
not the views': it is reported to the maintainer apart from this work.

### 3.7 Everything that enumerates schema objects

- Snapshot: optional `views` key, absent when empty (existing hashes and state
  ids unchanged). Closed parser, own hash domain, one owner module
  (`src/migrations/view.ts`) with its row in the single-owner table.
- Fingerprint and the PostgreSQL catalog digest gain views only when present.
- Introspection: declared views are read through the marker; a declared table
  whose name is a foreign view keeps today's refusal. SurrealDB stops reading
  a view table as a table (`kind`/`view` is reported and ignored today, so
  push would plan a `dropTable` on one).
- `viborm/schema/json`: a `views` section (source key, query with JSON values,
  table, materialized).
- `viborm/schema/introspect` (pull): a database view stays skipped; SQL cannot
  be read back into a query.
- CLI model discovery, Studio (listed, always read-only), type renderer.

A view is a `Model`, so whatever a model can be told can be told to a view.
What a view cannot hold is refused by one owner, W002, which reads each such
fact by name; the list is kept closed in two places, neither of them a guard:

- `STATE_KEYS` (`src/schema/view/view.ts`) is exhaustive by type. A key added
  to `ModelState`, optional or not, fails the build until a view derives it.
- A census (`tests/unit/schema-validation/view-declaration.core.test.ts`)
  lists every method of `Model` and every fact of `model["~"]` with its answer
  for a view, admitted or refused by a named rule. A method or a fact added
  to `Model` fails it until classified; a refusal it claims is proven by
  declaring it on a view; and a key a table's state can carry that a view
  neither derives nor is refused fails it too.

### 3.8 Type and size cost

- A schema without a view must cost nothing: the read-only surface is chosen
  per schema key (one conditional per key, none per operation), measured with
  `pnpm test:types` and the packed type budgets before each push.
- The declaration keeps `s.view` to what the client needs to read (source,
  query, derived shape). Measured: a view's query is typed against its
  source's `findMany` arguments for about 4,000 instantiations, provided the
  signature never instantiates those arguments for `Model<any>` (TS2589 and
  +10 M otherwise: see `ViewQuery`). The compile, the literal renderer's caller, identity
  and DDL live in migrations. `pnpm package:build && pnpm size` before each
  push; the pg application and the D1 Worker are the two numbers that count.
- A view's body is written by its migration driver's own writer
  (`MigrationDriver.viewWriter().write`): the SQL dialects compile the read
  with their own adapter (`sqlViewWriter`), SurrealDB lowers it with its read
  backend. The adapter is never an import of the three:
  the first form put the MySQL and SQLite adapters in the PostgreSQL
  migrations bundle (measured on the pg + migrations Worker: 299.53 kB with
  the three, 294.17 kB with its own, 288.23 kB before views).

## 4. Pull requests

1. **Ordinary views end to end** (this branch): `s.view`, the derived
   read-only model with JSON columns and the derived key, the literal renderer,
   the body compile, identity, migrations (snapshot, differ, DDL, marker,
   introspection, reset) on PostgreSQL, MySQL and the SQLite family, refusals
   on Snowflake and (until PR 3) SurrealDB, schema JSON, Studio, docs.
2. **Relations a view inherits from its source.**
3. **Materialized views, `$refresh`, SurrealDB.**
4. **Aggregated views.**

2, 3 and 4 depend on 1 and not on each other.

## 5. Units of PR 1

| Unit | Folder | Depends on |
| --- | --- | --- |
| A. Literal renderer | `src/adapters`, `src/sql` | — |
| B. `s.view`, derived model, definition validation | `src/schema` | — |
| C. Migrations: snapshot, differ, operations, DDL, marker, introspection | `src/migrations` | contract of D |
| D. Body compile and identity | `src/query-engine/raptor3`, `src/migrations/view.ts` | A, B |
| E. Client: read-only surface, JSON columns | `src/client`, `src/validation`, `src/query-engine` | B |
| F. Schema JSON, CLI, Studio, docs | `src/schema/json`, `src/cli`, `packages/studio`, `docs` | B |
