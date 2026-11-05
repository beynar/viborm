# The query backend frontier

Status: proposal, 2026-11-05. Steps 0 and 1 are done and step 2 is dropped. Steps 3
to 5 exist as a prototype on the `feat/query-backend` stack, and the shared driver
contracts pass on it. Extensions are next, if they are wanted before migrations.
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

It refuses by name what it does not cover: write hooks, tombstones and row domains (so
soft delete and permissions).

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
- **Locks:** `forUpdate` reads as it is. Writers meet at commit instead: of eight callback
  transactions that touch one row, one commits and the others fail with `V5001`, where
  PostgreSQL makes them wait and commits all eight.
- **Savepoints:** a nested scope runs in its parent, and what it wrote cannot be taken back
  alone. So a nested scope that fails marks the whole transaction rollback-only, through the
  driver's existing `transactionCleanupFailed`: a caller that catches the failure gets
  `TransactionError` on its next statement and at commit, and nothing commits. PostgreSQL
  would have rolled back to the savepoint and gone on. The one exception is a skipped
  `skipDuplicates` member refused at its own row, having written nothing.

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

Migrations will have to state what these forms rely on:

- `LIGHTWEIGHT` for a generated junction, and a classic relation with a unique index for a
  singular one.
- `DEFINE FIELD id ... TYPE [a: string, b: int]` for a compound key, which turns the
  driver's `id[0]` into a key range. A part named `id` is refused, and the driver reads by
  position, so the schema may name it anything. A `decimal` part cannot be named.
- `REFERENCE` on every foreign key, an index on what a filter reads, and events for a
  foreign key that holds no record, over several columns or another unique field: `DELETE`,
  and `UPDATE` where the referenced value can change. Nothing else applies its actions, so a
  schema without them leaves orphans silently.
- `i32` for `s.int()`, since a plain `int` holds what SQL's `integer` refuses, and `int` for a
  compound key's part, the only integer type a key range takes.
- `INLINE EDGES` and `INLINE REFERENCES` are not tried here. They cost each write.

Not measured: declared junctions, variant relations, geography, vectors, concurrent load,
and anything above 100,000 rows.

Not yet covered: write hooks, tombstones and row domains. A row domain's `{ $row, up }`
reads an outer row, so a filter holding one cannot be hoisted: `#holders` must learn to
decline it when row domains arrive. A fragment in a filter is written in the database's own
language: arithmetic and comparisons read the same in both, and a SQL subquery fails at the
server. A key is its public text here, so comparing it with a plain string column answers
from that text, where the other providers refuse.

**What a review of this prototype changed.** Three independent reviews on 2026-11-05 compared
it with PostgreSQL and read its evidence. Their tests now run as
`surrealdb-read-parity.test.ts` and `surrealdb-write-parity.test.ts`, which compare whole
answers on SurrealDB and PGlite. What stays different, each stated by a test or a waiver:

- A caught failure ends a transaction, and concurrent transactions refuse rather than wait.
- A JSON key named `__proto__` is stored, and the SDK's answer loses it.
- A schema written by hand can hold what generated DDL cannot: a dangling edge, which a read
  skips, or a second edge of a singular relation, of which a read takes the first. SQL's
  contract refuses both, by a check a driver cannot make without reading more.
- The fixture holds much of this behaviour: assertions, events, sequences, indexes. The raw
  statements of the shared contracts are rewritten by it, and `syncLiveSchema` plans nothing
  (`operations: []`). Until migrations generate that DDL, these tests prove the driver against
  a schema nothing ships.

The boundary is not closed. These still leak, and a second real backend must answer them:

- `Driver` must declare a `DatabaseAdapter`, here a proxy over row facts that refuses the rest.
- `Queries` is concrete, and `selectSeries`, `select` and `junction` are overridden by name.
- `operationContext` is `typeof OperationContext`, and a method left out refuses at its first
  adapter read rather than at compile time.
- `Query.sql` is `Sql`, and `SelectControls.condition` is a fragment bearing an alias.
- A unique refusal's recovery compares constraint identities, which this driver must install
  and never matches: its refusals name no constraint, and a lost race recovers at commit.
- `Dialect` widened to `surrealql`, but the migration serializer still casts it to
  `SqlDialect`: left alone, this dialect would take SQLite's decimal limit.

## Open questions

- Whether `OperationContext`'s writes split cleanly. Its statements mix
  capture, locks and batches, and SurrealDB takes no locks.
- What crosses for a statement: `Sql` already carries text and values, but its
  placeholders are `$n`, `:n` or `?`, and whether SurrealQL accepts one of them as
  a parameter name is untested.
- `$queryRaw`, whose text is a backend's own language.
- Whether `prepare*` is as clean at run time as its types: this count reads
  types and direct calls, not what flows through them.
