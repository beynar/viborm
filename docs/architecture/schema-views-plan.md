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

### 2.5 Relations to and from a view (PR 2)

```ts
const publishedPost = s
  .view(() => post, { where: { published: true }, select: { id: true, title: true, authorId: true } })
  .relations({ author: s.toOne(() => user).fields("authorId").references("id") });

const user = s.model({ id: s.string().id(), publishedPosts: s.toMany(() => publishedPost) });

await db.user.findMany({
  where: { publishedPosts: { some: {} } },
  include: { publishedPosts: { take: 5 } },
});
```

Declared like between two models, resolved by the same owner
(`relation-resolution.ts`): both sides declare their slot, one side holds
`.fields().references()`. The referenced side needs a key (a model's, or the
view's derived one). An edge with a view at either end creates no foreign key,
no delete action and no restriction; a many-to-many with a view is refused (no
junction table); no write verb reaches a view through a relation.

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

### 2.7 SurrealDB (PR 3)

`DEFINE TABLE <view> AS SELECT <fields> FROM <source> WHERE <own-field filters>`.
Admitted: scalars of the source, filters on the source's own fields. Refused
with a named message: any relation in the projection or the filter (measured
stale), `take`/`skip`/`orderBy` (parse error). Aggregated forms arrive with
PR 4. `.materialized()` changes nothing there.

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
the declared query (values JSON has no spelling for are tagged), the decoder
shape of a view row, and the resolved relations the query crosses.
The text is kept in the snapshot (a migration must be able to write the view
again, and a down migration the previous one) but is not compared. The hash is
40 hex characters, so its marker fits an identifier on every database.

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
  another type, an enum recreated under one of its columns. On SQLite, which
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

## 4. Pull requests

1. **Ordinary views end to end** (this branch): `s.view`, the derived
   read-only model with JSON columns and the derived key, the literal renderer,
   the body compile, identity, migrations (snapshot, differ, DDL, marker,
   introspection, reset) on PostgreSQL, MySQL and the SQLite family, refusals
   on Snowflake and (until PR 3) SurrealDB, schema JSON, Studio, docs.
2. **Relations between views and models.**
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
