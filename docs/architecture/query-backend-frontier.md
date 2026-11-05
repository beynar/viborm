# The query backend frontier

Status: proposal, 2026-11-05. Steps 0 and 1 are done; nothing else below is built.
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
surrealql  count(SELECT 1 FROM post WHERE author = $parent.id AND title = $p1) > 0
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
| `Dialect`, a closed union of three | `src/drivers/types.ts`, named in 21 `schema`, 11 `migrations` and 6 `drivers` files | an open target; the largest work outside the engine |
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
3. **`OrderTerm` carries `Sql`.** Order has no `Prepared*` form yet.
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
| 2 | Prepare the order (leak 3) | `OrderTerm` free of `Sql`; read latency measured |
| 3 | The driver supplies its backend; read path behind `QueryBackend` (leaks 2 and 5) | pg and D1 bundle sizes unchanged within the size rule |
| 4 | SurrealQL read backend as a prototype; open `Dialect` as far as it needs | public read contract, `include` latency over WebSocket |
| 5 | Write path (leak 4), shaped by what step 4 learned | full contract suite on both |

Do not move the 4,100 lines of SQL lowering up front. The move is mechanical but
conflicts with every engine change, and an interface drawn from one implementation
would only describe that implementation. Step 4 is what tests the line.

**Bundle.** A SurrealQL backend lives only in its own driver entry, so a pg or D1
application never loads it. Those two bundles are the ones that must not grow.

## Open questions

- Whether `OperationContext`'s writes split cleanly. Its statements mix
  capture, locks and batches, and SurrealDB takes no locks.
- What crosses for a statement: `Sql` already carries text and values, but its
  placeholders are `$n`, `:n` or `?`, and whether SurrealQL accepts one of them as
  a parameter name is untested.
- `$queryRaw`, whose text is a backend's own language.
- Whether `prepare*` is as clean at run time as its types: this count reads
  types and direct calls, not what flows through them.
