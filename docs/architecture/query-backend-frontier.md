# The query backend frontier

Status: proposal, 2026-11-05. Steps 0 and 1 are done and step 2 is dropped. Steps 3
to 5 exist as a prototype on the `feat/query-backend` stack, and the shared driver
contracts and the official extensions' behaviours pass on it.
Numbers read from `main` at `e4b09fd64` with an AST pass over the engine.

## The problem

`src/adapters/AGENTS.md` separates *what to query* from *how to express it*, and
the engine now states no SQL word
(`tests/contracts/adapters/engine-sql-words.core.test.ts`). That makes viborm
independent of the SQL **dialect**, not of the **language**: the engine still
reasons in tables, aliases, joins and CTEs, and the adapter only spells them.

A SurrealQL adapter cannot sit behind that. `identifiers.column("q0", "id")`
must become `id` at the level that owns the row and `$parent.id` in a subquery
below it, and an adapter sees two strings, before the fragment has a place.

## The frontier

The line is between *describing a read or write* and *writing a statement*:

```
 INTENT             client, schema, validation
 (no language)      commands/          what a write means, in which order
                    prepare*           Prepared* descriptions, no alias, no Sql
                    decode*            rows to public values
 ─────────────────  ───────────────────────────────────────────────────────────
 FRONTIER           QueryBackend       takes Prepared*, returns an opaque statement
 ─────────────────  ───────────────────────────────────────────────────────────
 BACKENDS           sql                lower*, aliases, CTEs, flags, adapters
 (a language each)  surrealql          $parent, <~, ->edge->, .{..}, LET
 ─────────────────  ───────────────────────────────────────────────────────────
 TRANSPORT          drivers            run the text and its values
```

The same description crosses to either side:

```
PreparedPredicate { kind: relation, quantifier: some, edge: user.posts, where: title = 'p3' }

sql        EXISTS (SELECT 1 FROM "post" AS "q1"
                   WHERE "q0"."id" = "q1"."authorId" AND "q1"."title" = $1)
surrealql  id IN (SELECT VALUE author FROM post WHERE title = $p1)
```

Aliases stop being an engine concept: they belong to the SQL backend, which
needs them. A SurrealQL backend knows which level it is writing, so it never
mints one.

## The driver contract

The ambition is a driver form that is agnostic of language and backend: adding a
target touches nothing above the frontier. A language is still written once per
target; agnostic means SQL is one backend among others and nobody above knows
which one runs.

```ts
interface Driver {
  backend: QueryBackend; // writes this database's language
  run(statement, values); // transport
  transaction(fn); // each database opens its own
  facts; // RETURNING, locks, batches…
}
```

`MigrationDriver` (`src/migrations/drivers/base.ts`) is the precedent: one
abstract class, one implementation per target, registered by an entry that loads
only its own.

Already agnostic: `QueryResult`, and `execute(client, sql, params)`, whose `sql`
is only text. Still tied to SQL, beyond the frontier itself:

| Coupling | Where | Needed |
|---|---|---|
| `adapter: DatabaseAdapter` on the driver | `src/drivers/driver.ts` | a detail of the SQL backend |
| `Dialect`, a closed union | `src/drivers/types.ts`; opening it broke 6 sites | done for a read-only driver; migrations still assume SQL |
| Native types keyed `pg`, `mysql`, `sqlite` | `src/schema/scalars/native-types.ts` | a new target's key |
| `$queryRaw` taking `Sql` | `src/client/raw.ts` | text in the backend's language |
| Positional placeholders | `src/sql/sql.ts` | named by the backend |
| SQL-shaped `capabilities` names | `src/adapters/adapter-capabilities.ts` | strategy questions each backend answers |

An agnostic API does not make behavior identical: SurrealDB refuses to change a
record id and takes no locks. Such differences are refused or documented, as they
are between MySQL and PostgreSQL today. Two backends test this contract; they do
not prove it for a database with no subqueries.

## What the code already gives

| Part | Size | State |
|---|---|---|
| `commands/` | 7,800 lines | no `sql` template and no adapter syntax (guarded); the reads below remain |
| `Prepared*` types | 39 types free of `Sql` and aliases | `PreparedPredicate`, `PreparedProjection`, `PreparedSelector`, `PreparedUpdate` and their parts |
| `prepare*` methods | 20 methods, 1,046 lines | only `#prepareAggregates` touches the adapter |
| `Queries` writing SQL | 88 methods, 4,138 lines | the SQL backend, once moved |
| `OperationContext` writing SQL | 22 of 131 methods, 2,038 lines | `insert`, `update`, `remove`, `link`, `upsertOne`… |

## The leaks to close

1. **`commands/` spelling a condition: closed.** Its three conditions are now
   `SelectControls.row`, a `RowCondition` that `Queries` spells where they stood.
   `tests/contracts/adapters/commands-state-no-syntax.core.test.ts` keeps it so.
2. **What `commands/` still reads of a statement.** No syntax, but language:
   bind budgets from `lowerSelector(…).values`, `updateAssignment(…).values` and
   `query.sql.values`; `locatedValue` and `sameStoredValue`, whose deferred batch
   value is a `Sql`; `getAdapterInternals(…).constraints` to recognize a violated
   key; and `statement: Sql` on a prepared read's published facts.
   `SelectControls.condition` also still takes `Sql | (alias) => Sql`, now only
   from `OperationContext`; it goes with leak 4.
3. **Order: not a leak.** `OrderTerm` carries `Sql` but is private to `Queries`.
   What reaches the lowering is the admitted `args.orderBy`, which holds none, and
   a backend reads that. `#completeOrder`, the tie-break every page needs, works on
   lowered terms; share it when a second backend needs it, not before.
4. **`OperationContext` assembles statements** from `q.table` (17 calls),
   `q.column` (9), `q.alias` (3). This is the largest and least understood part.
5. **Construction.** `commands/index.ts` does `new Queries` and
   `new OperationContext`; the driver should supply them.
6. **Reading SQL back.** 12 `Sql.peek`/`peekRuns`/`leafText` sites, such as body
   sharing and the fold check, belong inside the SQL backend.
7. **Punctuation left in the engine:** `1`, `*`, `1 = 1`, `= 1` and row values.
   The guard does not refuse them because they are not words.

`capabilities` read by `commands/` (`supportsReturning` 7 times,
`supportsRowLocks`, `supportsTargetedUpsert`, `locksMissingKeys`) are questions
about strategy, not language. They stay, answered by each backend.

## Order of work

Each step keeps SQL byte-identical and lands alone.

| Step | Work | Proof |
|---|---|---|
| 0 | No SQL word in the engine | done, guard test; pg 206.65 → 206.61 kB, D1 205.49 → 205.47 kB gzip |
| 1 | Close leak 1 | done, a guard: `commands/` states no adapter syntax |
| 2 | Dropped: order was not a leak (see leak 3) | `Queries.order`, which nothing called, removed |
| 3 | The driver supplies its backend; read path behind `QueryBackend` (leaks 2 and 5) | pg and D1 bundle sizes unchanged within the size rule |
| 4 | SurrealQL read backend as a prototype; open `Dialect` as far as it needs | public read contract, `include` latency over WebSocket |
| 5 | Write path (leak 4): root and nested writes done for foreign keys and generated junctions | full contract suite on both |

Do not move the 4,100 lines of SQL lowering up front. The move is mechanical but
conflicts with every engine change, and an interface drawn from one implementation
would only describe that implementation. Step 4 is what tests the line.

**Bundle.** A SurrealQL backend lives only in its own driver entry, so a pg or D1
application never loads it. Those two bundles are the ones that must not grow.

## What SurrealQL's reads taught

Measured on SurrealDB 4.0.0 over WebSocket, 20,000 users and 200,000 rows a table;
scripts are outside the repository. A backend writes from the relation, not from a
translation of the SQL:

```surql
SELECT id,
  <~(SELECT * FROM post FIELD author ORDER BY rank DESC LIMIT 3).{
    id,
    comments: <~(SELECT * FROM comment FIELD post ORDER BY rank DESC LIMIT 2).{ id, body }
  } AS posts
FROM user:400..410 ORDER BY id;
```

- That form answered correctly in about 2 ms at three levels. A `$parent` subquery,
  the SQL's direct translation, took 3.6 to 5.9 s there: past one level it drops to
  a path that scales with the table.
- `FIELD` is mandatory. Without it `<~` read another relation to the same table and
  raised nothing.
- One statement carries a deep read, so `QueryBackend` need not return a plan of
  several statements for the shapes measured.
- A relation filter reads back from the child where it can:
  `SELECT VALUE author FROM post WHERE title = $p1` took 5.6 ms against 241 ms for
  `count(SELECT … $parent …)`.
- `<~` needs a `record` link declared `REFERENCE`, so a foreign key to another
  unique field has no such form.

## The prototype

`ReadBackend` has one method, `read(model, operation, args)`, and a driver supplies
it through `readBackend`. `src/drivers/surrealdb` implements it over the `Prepared*`
descriptions, without one alias, and is not a package entry. Its test asks 44 public
reads of SurrealDB and of PGlite over the same rows and compares the answers:
scalars, order and pages, the filters on nullable fields, to-one and to-many at three
levels, two relations to one table, and `some`, `none`, `every`, `is`, `isNot`.

It refuses by name what it does not cover.

**Writes.** `driver.operationContext` supplies a subclass of `OperationContext` that
overrides `createMany`, `updateMany`, `deleteMany` and `upsertOne`, the four methods
`Commands` folds a root write into. `Commands`, admission, stamps, the envelope and
decoding are all shared. One script of 44 steps runs on SurrealDB and on PGlite and
compares every answer, every refusal by class and code, and the rows left behind:
create, update, delete, upsert, limits, relation filters, `onDelete`, and callback and
array transactions.

What the writes showed:

- The seam held for root writes, but a subclass overriding by name is a weak contract:
  it must also decline batch preparation, which a first version missed, so it wrote
  outside the array transaction.

**Nested writes.** `SurrealQueries` overrides `select` and `locatedValue`, and the
context overrides `insert`, `update`, `updateLocated`, `updateRows`, `mutateMembers`,
`remove` and `delete`. `Commands`, `RelationBody` and `CommandExecution` needed no
change: the meaning of a nested write stayed above the frontier. A second script of 31
tests covers `connect`, `create`, `connectOrCreate`, `update`, `updateMany`, `upsert`,
`disconnect`, `set`, `delete`, `deleteMany`, atomic failure and nested transactions.

That answers leak 4 for the transaction route: `OperationContext` splits along record
writes. What the override drops, and a real backend would have to answer:

- **The batch route:** `usesBatch` is never true here, so that half of each method is
  untouched and untested. A driver without interactive transactions would need it.
- **Locks:** `forUpdate` reads as it is, and writers meet at commit. Every engine measured
  (memory, RocksDB, SurrealKV) is snapshot isolation where the first committer wins, with no
  read checks. A write that changes nothing conflicts with nothing, so a lock cannot be imitated
  by touching a row.
- **Savepoints:** the language has none, and a failed statement may leave part of its change,
  over which the server refuses to commit. `ReplayedTransaction` keeps each statement with its
  answer. Going back is a new transaction running the statements up to the mark again, so a
  caught failure leaves the rest to commit, as on PostgreSQL. If any answer differs, a concurrent
  write changed what the caller was told, and the transaction ends with `V5001`. A scope that
  wrote nothing costs nothing: a read, or an `INSERT IGNORE` that took no row. Otherwise going back
  costs one round trip per statement so far.
- **Meeting at commit:** the loser wrote nothing, so the same replay runs and commits again,
  without running the callback twice. Writers that were told nothing that changed all commit. Those
  whose answers changed, such as an `update` that returns the value another writer incremented,
  fail with `V5001` where PostgreSQL makes them wait, because only running the callback again can
  give them the new value. `new SurrealDriver(client, { rerunsOnConflict: n })` does that, for a
  `$transaction` callback. It is off by default, since whatever the callback does outside the
  database happens again. An array transaction and an operation's own transaction do not rerun, and
  neither does a callback under an extension that collects its writes.
- **Sequences:** they stand outside transactions, so a statement in one takes its values ahead and
  holds them, which costs a round trip and keeps a replay's answers the same.

**Parity with SQL.** The shared driver contracts run on SurrealDB unchanged, through
`tests/providers/docker/surrealdb-contracts.test.ts`. The test fixture defines a schema
from the migration serializer's neutral description, so `syncLiveSchema` works without
any migration. CI runs them against a real server, in its own job. Contracts that state
migrations, a SQL plan or a batch-only substrate do not apply. Tests a contract states
in SQL's own words are waived by name, each with its reason, in that file.

What had no direct equivalent, and how it answers:

- **Keys:** a single key is the record's `id` whatever the field is called, and a
  compound key is an array id read by position, `id[0]`. A generated integer key reads
  a `DEFINE SEQUENCE`. A key change is a new record, in one statement: the row is copied,
  holders do what `onUpdate` says (unsaid is SQL's `NO ACTION`, which refuses), edges are
  related again, the old record goes. A unique field holds a stand-in value until then,
  since its index would read the old row as a duplicate. Three cases refuse by name: a
  unique field with no stand-in (not a string or integer, not nullable, or a link), a holder
  whose own key holds the moved one, and a reference by another unique field, whose action
  is an event the deleted copy would fire.
- **Aggregates:** flat aggregates inside, the public shape outside, where `having` and
  an order read them by name. `math::sum` of nothing is 0 and SQL's is NULL, so each
  aggregate carries how many values it saw.
- **`distinct`:** `GROUP BY` keeps its source's order, so each tuple's first row is
  `array::first(id)`, chosen in the caller's order. A nested one groups a parent's
  members as a value, because a subquery past the first cannot see `$parent`.
- **Null order:** a missing value sorts by a selected flag, as PostgreSQL places it, in
  `groupBy` too, where a sum of no values is NULL and not 0.
- **Conflicts:** no locks, so writers meet at commit. The loser plans again once, under
  the operation's one recovery. `insert` with a producer is `INSERT IGNORE` and reports
  its rejection without a failing statement, which a transaction here cannot survive.
- **Variant relations:** the type and id columns stay plain fields. A generated variant
  junction is one edge table per member.
- **Geography:** `INTERSECTS` holds a polygon's boundary and not its holes. It is
  planar: a ring crossing 180 is unwrapped past it, and edges are not great circles as
  they are in PostGIS. `geo::distance` matched the shared boundary tests.

- **`recurse`:** a fold over the levels, as one value in the row. A numeric depth labels
  each edge with its level, as the decoder expects. An exhaustive walk keeps what it has
  seen, which ends a cycle, and refuses past 256 levels, where a SQL recursion would go on.
- **Blocks:** a block answers with its last expression. A `RETURN` inside one leaves
  whatever expression holds the block: `!(RETURN { ... })` answered without its negation.
- **Declared junctions:** the link is a row of its model and not an edge, read through
  the row's links, then the rows they name. A compound foreign key holds no record, so
  the test fixture states its action as an event on the table it names. Migrations will
  have to state it too.
- **Parser depth:** the server's parser limits nesting, and each parenthesis counts. A
  filter nesting five relations failed until a lone arm dropped its parenthesis and a
  relation test dropped `array::len`. Fourteen levels now parse, for reads and filters,
  on a server at its defaults. Many arms in each level will reach the limit sooner, and
  past it the read refuses by name: `SURREAL_MAX_QUERY_PARSING_DEPTH` raises it.

**Many-to-many.** A generated junction is an edge table, `TYPE RELATION IN post OUT tag
LIGHTWEIGHT`: the edge is its pair and nothing else, so `RELATE` is idempotent with no
index to keep. `in` is the junction's canonical first side. A singular relation needs a
unique end, which an index holds, so its table stays a classic relation written with
`INSERT RELATION IGNORE`. No shared behaviour changed: the seam is `Queries.junction`,
`select`, `link`, `linkMany` and `remove`.

**Performance.** `tests/providers/docker/surrealdb-perf.test.ts` runs the same viborm
calls on PostgreSQL 18 and SurrealDB 4.0 over the same rows, in alternating rounds, with
`SURREAL_PERF` set. It fails if the two databases answer a read differently in any round, or
if an operation errors, and neither happened. Medians in ms,
over 100,000 posts, 100,000 comments and 10,000 users, one client on one machine:

| Operation | PostgreSQL | SurrealDB |
|---|---|---|
| `findUnique` by key | 0.3 | 0.4 |
| `findMany`, indexed filter, order, take | 0.3 | 0.5 |
| Include to-many, take | 0.5 | 0.8 |
| Include three levels | 0.6 | 0.9 |
| Filter `some`, to-one | 0.5 | 0.9 |
| Filter `some`, to-many | 19.5 | 16.6 |
| Filter `some`, broad, take 1 | 0.4 | 2.2 |
| Filter `none`, to-many | 7.3 | 24.9 |
| Filter `some`, many-to-many | 132.7 | 2.3 |
| Filter, two relations down | 4.8 | 17.7 |
| Cursor page | 0.5 | 1.0 |
| `groupBy` | 15.5 | 24.4 |
| `distinct` | 137.3 | 244.1 |
| `recurse`, exhaustive, 1,000 nodes | 17.3 | 26.3 |
| `update` by key | 0.4 | 0.6 |
| `create` | 0.5 | 5.0 |
| `createMany`, 100 | 5.3 | 27.1 |

The forms behind them, each measured against the one it replaced:

- **Relation filters read the other side first.** A subquery that reads no outer row is
  a `LET` ahead of the statement. `some` reads its rows from that list, `FROM $h0`, so it
  fetches only them; `none` and `every` test `id NOT IN $h0`. A `WHERE` running a traversal
  per row cost 56 ms for a to-one over 20,000 rows, and this costs 0.6 ms. A page cannot
  afford the whole list of a broad filter, so with `take` it reads 1,000 rows ahead: fewer
  mean the list is whole, and otherwise the page walks its own rows and stops early. A
  filter whose body matches everything cost 107 ms with the whole list and costs 2.2 ms.
- **Cursors seek.** `id >= $h1` walks from the key. A bare condition beside it, `$h0 AND
  id >= $h1`, turns that into a scan, so "no such cursor" is an `IF` around the statement.
- **Exhaustive walks recurse.** `{..+collect}` found the nodes where a fold spent 98 ms
  on 256 levels. It stops at SurrealDB's own 256 levels, with an error.
- **A to-one over a compound key reads its record**, `type::record(t, [a, b])`.
- **Lists of records, not `OR`:** `UPDATE [a, b]`, since `id IN` and a list read by key.
- **Blocks answer with their last expression**, and parentheses are kept to a minimum.

Not a driver matter: `INSERT`, `CREATE` and `DELETE` cost 4.5 ms above the network whichever
form is used, and 1.0 ms with `SURREAL_DATASTORE_SYNC=never`. That is the sync of each
commit. PostgreSQL on this machine uses `open_datasync`, which macOS does not flush as
far, so this gap is not a like-for-like measure of durability.

Not measured: declared junctions, variant relations, geography, vectors, concurrent load,
and anything above 100,000 rows.

**The official extensions.** Hooks, soft delete, permissions and ordering run on SurrealDB through
their shared behaviours in `surrealdb-extensions.test.ts` and `surrealdb-permissions.test.ts`. What
they needed:

- **Row domains.** A layer's predicate lowers like any other, with a call's values read from its
  scope. Relation reads, relation filters, counts and cursors each read among the rows the call may
  see, as the SQL lowering does. A read-gated field reads absent to a caller's filter, order, group
  and aggregate on a row that does not carry it.
- **Judged writes.** A create judges its rows before it writes, and an update judges them as it would
  leave them, `SELECT *, value AS field`, in the same statement. So a refusal comes before a unique
  index or a reference could object, as it does in SQL. A row is refused unless it holds, so a missing
  value refuses. A rule that a relation stays acyclic walks the new link from each row.
- **A statement does not read a snapshot of itself.** `UPDATE t SET x WHERE <filter>` evaluates its
  filter row by row and sees what it has already written, where SQL reads the rows as they were. A
  policy that reads the caller's own row stopped matching once that row was written. A bulk write
  whose filter reads other rows finds its rows first and writes the list.
- **Repeated subqueries.** A policy states one subquery per action it answers, and a read holding
  `$access` states them all. The lists a statement holds ahead of itself are shared by their text and
  values, which took one suite from 438 s to 66 s.
- **The parser.** These statements nest deep. The server needs
  `SURREAL_MAX_QUERY_PARSING_DEPTH=128` for the acceptance estate; below what a statement needs, the
  read refuses by name and says so. Nothing was measured beyond that estate.
- **Partial unique indexes.** SurrealDB has none. A computed field is the indexed value where the
  predicate holds and `NONE` where it does not, and `NONE` is not indexed. Several columns are one text,
  since an array is indexed member by member. Only columns set or unset can be stated; anything else
  refuses by name. An index cannot share a transaction with rewriting its table's rows, so adding one
  to a populated table runs statement by statement.
- **Restricted junctions.** A record's edges go before an event could object, so `restrict` on a
  many-to-many is the driver's, which reads them before a delete or a key change. A raw delete does
  not hold back.
- **Ordering.** An appended key reads the list's last key first, as on MySQL, through
  `InsertValueContext.lastKey`. A move already reads its neighbours through the delegates. Respacing
  reads its lists and writes each row in one statement, through `JoinedValue.plan()`; SQL's is one
  `UPDATE ... FROM`. Keys may tie under concurrent appends, as a move handles.

**What the server asks of what is written for it.** Measured on 4.0.0, and each is why a statement
reads as it does.

- **Compilation is the cost.** A server compiles in about the square of a statement's subqueries, and
  keeps what it has compiled per statement. 40 nested subqueries took 96 ms, 80 took 308 ms, and a
  block doubles it, where running them takes under a millisecond. So a statement holds its lists in
  top-level `LET`s and one small block, and a text transaction keeps them atomic. That took the
  acceptance suite's slowest part from 427 s to 26 s.
- **A long literal beside an `IF`** in one block takes about the cube of its length, and the server
  cannot stop it: 1,600 rows never ended and held a core past a kill signal. It stands outside.
- **About 65,000 values in one statement** ("IR table full"). A list of plain values is one parameter.
- **64 open transactions per connection**, past which the server refuses. The rest wait.
- **One equality stated twice with one value** fails with "Internal database error: stale IR id".
  Conditions are stated once.
- **An event does not see a statement's variables**, so a moved record's old copy says so in a field.

**How a row domain reads.** A row named by its whole key follows its links, each a read by key, to
lists of who holds what lies at their ends: `authorId.orgId IN $h1`. A page caps its list by an index
read and, past 1,000, reads in key order following each row's links, which is where the wide actor's
28 ms became 0.7 ms.

**Speed against PostgreSQL** on one machine (`benchmarks/surrealdb-compare.mjs`, medians) depends first
on durability. On macOS SurrealDB flushes the disk's cache at each commit by default, about 4 ms, where
PostgreSQL's `open_datasync` does not. At equal durability (PostgreSQL with `fsync_writethrough`)
writes take 1.0 to 1.6 times as long, extensions included. With neither flushing
(`SURREAL_DATASTORE_SYNC=never` against PostgreSQL's defaults), a read or write of one row takes 1.1 to
1.7 times as long, a page 2 to 2.6, `count` 3.7 and `updateMany` 3.9, which are the server's scan and its
cost per row written. A round trip alone costs 0.13 ms here against 0.08 ms.

The forms behind that, each measured against the one it replaced, on the same plan:

- A filter that names a record by its whole key reads or writes the record itself: `SELECT … FROM $p1`,
  `UPDATE $p1 SET … WHERE <the rest>`. `WHERE id = $p1` walks the same single record yet costs the
  statement about twice as much (an update 0.78 ms to 0.31 ms). A keyed cursor reads its anchor the same way.
- One row is created with `CREATE $id CONTENT $row`, which costs half `INSERT INTO t $row` (0.67 ms to
  0.31 ms) and refuses a taken record or unique value in the same words. A key a sequence gives, or the
  statement reads, still inserts.
- A unique read has no `ORDER BY`, which only sorted its one row.
- A projection lists its columns bare. An absent field reaches the client as `undefined` under its key,
  which the driver reads as null, so `(f ?? NULL) AS f` cost each row for nothing (50 rows, 0.52 ms to
  0.40 ms).

At 20,000 rows the same holds, 1.7 to 4.7 times without flushing, once a page walks its index:

- `ORDER BY a DESC, id ASC` sorts every row, as no index holds that order, so a page reads `a`'s value
  at its last row ahead and bounds the sort with it (7 ms to 0.6 ms). It needs an index on `a`, and a
  filter without a subquery, whose second statement would cost more to compile than the sort.
- A cursor is `a >= x AND (a > x OR ...)`, one range walked in order, where `a > x OR (a = x AND ...)`
  reads two ranges and sorts them (19 ms to 0.85 ms).
- `_min` and `_max` alone are one row an index finds, where an aggregate reads them all (3.5 ms to 0.3 ms).
- An index holding the key among other columns is kept. It used to be dropped at push, so an ordered
  list sorted all its rows (16 ms to 1 ms for an ordering create).

- A correlated read never walks an index in order, not with `$parent.id` nor a closure's variable, where
  a statement's own `LET` does. An `include` with a `take` under a root page of at most 20 rows reads which
  rows they are ahead, then each one's children in a read of its own (2 parents of 4,000 children each,
  10 ms to 0.6 ms; compiling for 20 rows takes 5 ms). Deeper includes stay correlated.

A `groupBy` under `take` of at most 20 groups seeks them on the index of the field it orders by, one
value after the last, and reads only their rows (5.6 ms to about 1.1 ms, and no longer growing with the
table). PostgreSQL's 0.13 ms stops on the index itself, so this stays the widest ratio, at about 8 for
1 ms. Without `take` both read every row, and the ratio is 3.4. `_sum` reads every value, as `SELECT VALUE`
does in the same time, and `GROUP ALL` is the fastest form measured: that ratio, 4.4, is the server's
scan. A cursor over a second order column reads its anchor's values ahead, and stays at about 6 for 0.8 ms.

**Refusals** are counted in `tests/contracts/architecture/surrealdb-refusal-census.test.ts`, each with
why it stands. A new one fails it.

What a judgement can read goes further here. A list's appended value and a sequence's next value are
known before the write, so they are judged as any value, where SQL refuses to judge what only the
statement computes.

What stays different here: a hook's rows of a nested clear read after the write, and a statement count
differs where a test states SQL's plan, each waived by name. A fragment in a filter is written in the database's own
language: arithmetic and comparisons read the same in both, and a SQL subquery fails at the
server. A key is its public text here, so comparing it with a plain string column answers
from that text, where the other providers refuse.

**What a review of this prototype changed.** Three independent reviews on 2026-11-05 compared
it with PostgreSQL and read its evidence. Their tests now run as
`surrealdb-read-parity.test.ts` and `surrealdb-write-parity.test.ts`, which compare whole
answers on SurrealDB and PGlite. What stays different, each stated by a test or a waiver:

- Concurrent transactions whose answers changed refuse rather than wait.
- A delete and an insert that meet both commit and leave an orphan, even under `REFERENCE ... ON
  DELETE REJECT`: neither writes a key the other does. PostgreSQL's foreign key takes a lock here.
  Closing it means each insert writes to its parent, which turns every insert under a popular
  parent into a conflict.
- A JSON key named `__proto__` is stored, and the SDK's answer loses it.
- A schema written by hand can hold what generated DDL cannot: a dangling edge, which a read
  skips, or a second edge of a singular relation, of which a read takes the first. SQL's
  contract refuses both, by a check a driver cannot make without reading more.
- The shared contracts still rewrite a few raw statements in the test fixture, which spells
  SQL's `DROP TABLE` and the like.

**The boundary in the types.** `driver.backend` supplies two classes, and what a language must
answer is their abstract members, so a backend that leaves one out does not compile:

| Class | Holds | Abstract |
|---|---|---|
| `Queries` | descriptions (`prepare*`), filters over them, decoding | 9 members: `read`, `select`, `selectSeries`, `junction`, `locatedValue`, `under`, `lowerSelector`, `updateAssignment`, `lockAll` |
| `OperationContext` | what a write's run is: attempts, members, recovery, publishing | the writes, and `submit`, `statePremise`, `packageGuard`, `closeScratch`, `answersInStatement`, `createQueries` |

`SqlQueries` and `SqlOperationContext` are the SQL backend, the default when a driver names none.
`driver.adapter` is typed `EngineFacts`: strategy and decoding, and nothing that spells a statement.
The SQL backend reads a `DatabaseAdapter` there, and the language-free classes cannot. This costs
0.72 kB on the pg and D1 bundles, because the 52 private members the split crosses became retained
names.

`select`, `junction` and the rest are `Sql` values, which here means text and its values: a backend
binds them as its driver does, and `Query.sql` needs no other type.

`MigrationDriver` follows the same line. It holds the plan's mechanics and is abstract in every
statement, including how an identifier is escaped, and the two questions `push` asks of a table:
`tableHoldsRows` and `undeclaredValue`. `SqlMigrationDriver` holds what the SQL drivers share: how a
value and a default are spelled, enum replacement, the column definition. Bundles did not grow.

Still leaking:

- `pinned-session`, `control` and `statement-safety` assume SQL. `push` goes around them through
  `holdLock`, and `generate` and `apply` need them, which is why those stop at the history format.
- `TableDef` gained a `junction` mark, set by the optional `markJunction`.
- `lowerSelector`, `updateAssignment` and `lockAll` are abstract because `commands/` asks for them in
  its batch and lock paths. SurrealDB refuses them by name and never reaches them.
- `InsertValue` hands its producers a `Queries`, and the ordering extension's own casts it to SQL.

**Migrations.** `push` works end to end: `src/migrations/drivers/surrealql` is a
`MigrationDriver`, and the plan, its consent and hash, the diff, the attestation and the
refusals are all the shared ones. A driver asked for three things beyond its DDL, each a hook
that is empty on the others, so SQL is unchanged and no bundle carries it: `holdLock`,
`pushTarget` and `buildsApart`. The tests now define their schemas
through it, so the 1,100 tests of the driver run on what `push` generates.

What the schema is made of:

- `LIGHTWEIGHT` for a generated junction, a classic relation with a unique index for a singular
  one. An action on a junction other than cascade refuses by name: a record's edges go with it,
  before an event could object.
- `DEFINE FIELD id ... TYPE [a: string, b: int]` for a compound key, which turns the driver's
  `id[0]` into a key range and names its parts, so an index can read them. A part named `id` is
  `id_part`. A `decimal` part cannot be named, and a unique over part of such a key refuses.
- `REFERENCE` on a foreign key that holds a record. Events for one that does not, over several
  columns, another unique field or a part of the row's own key: `DELETE`, and `UPDATE` where the
  referenced value can change. Nothing else applies its actions.
- `i32` for `s.int()`, and `int` for a compound key's part, the only integer a key range takes.
- A `COMMENT` for what the database cannot say: the schema's names for `id`, `in` and `out`, a
  junction's definition, `onUpdate`, a decimal's scale. `INFO ... STRUCTURE` reads the rest.

What the database decides for itself, at compatibility level 4: on a populated `SCHEMAFULL`
table, a change its rows might not satisfy refuses in the server's words, and nothing of that
push is left. A required field with a default fills old rows through `MIGRATE EXISTING ROWS`. An
index cannot share a transaction with a backfill on its table or with a removal of that table,
so such a plan runs statement by statement: a failure part-way leaves what the next push plans
from, which is why that is acceptable for a push and would not be for a history.

The lock is a record, since no session can hold anything here. A command that dies leaves it
behind, and another takes it over once its 15-minute lease is up, so a command longer than that
can be overtaken.

Not done: `generate`, `apply` and everything that reads a file history, which need control
tables, a ledger and statement safety in SurrealQL. They refuse because an estate's format admits
no such dialect, in that format's words. Refusing by name: renames, since SurrealDB has none and a
table's copy needs new record ids; a key change, since a key is its id; partial indexes.

## Open questions

- Whether `OperationContext`'s writes split cleanly. Its statements mix
  capture, locks and batches, and SurrealDB takes no locks.
- What crosses for a statement: `Sql` already carries text and values, but its
  placeholders are `$n`, `:n` or `?`, and whether SurrealQL accepts one of them as
  a parameter name is untested.
- `$queryRaw`, whose text is a backend's own language.
- Whether `prepare*` is as clean at run time as its types: this count reads
  types and direct calls, not what flows through them.
