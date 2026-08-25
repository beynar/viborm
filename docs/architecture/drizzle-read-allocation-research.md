# Cross-provider result-transport research record

Status: measured disposition. Performance evidence in this program is limited
to SQLite3 and PGlite. Other providers remain correctness controls or deferred
work; this record does not claim a cross-provider speedup.

## Final disposition

| Candidate | SQLite3 | PGlite | Disposition |
|---|---:|---:|---|
| Positional provider rows | full allocation +11.11%; CPU +2.17% | full allocation +1.33% | Removed |
| Broad provider-owned named rows decoded in place | allocation improved, but final mixed-provider wall time +1.976% | control acceptable | Removed |
| Executor-proven consumable named rows | wide six-column allocation -6.1903%; CPU -1.8124%; wall -2.1588% | mixed-scalar allocation -3.4737%; CPU/wall non-regressing | Retained |
| Parser-owned relation JSON graph | about 17-27% less allocation in exact fixed/variant controls | native object carriers that need decoding remain borrowed and copied | Retained |

The broad ownership path was not free for operations that could not reuse a
row. Removing `WeakSet` churn and per-row mode work did not remove its final
SQLite wall-time regression. It remains rejected. The retained replacement is
narrower: the executor can consume same-key inner rows only when an exact stock
producer remains active across the typed execute call and the already compiled
row parser says `reusable`. The proof exists only on the execute → prove →
parse stack. It is not a provider-row ownership claim.

The exact retained comparison uses baseline
`766e4e68d96a1ba8a50ce7072ba153a5a2f83b01` and temporary measured candidate
`b8a46c3ec01c1511d9b5182dd4c9de621b14fd95`. Final active tree
`0ce1997eaa5cd71f3ae6c521e513a5f67cc1f0a2` was confirmed as an exact match to
that candidate. Five alternating fresh-process pairs ran on Node 24.19:

| Exact final workload | Baseline bytes/op | Candidate bytes/op | Allocation delta | CPU | Wall |
|---|---:|---:|---:|---:|---:|
| SQLite3 `scalar-find-many-1000/full` | 1,531,699.288 | 1,436,882.040 | -94,817.248 (-6.1903%) | -1.8124% | -2.1588% |
| PGlite `provider-mixed-scalar-1000/full` | 7,123,755.04 | 6,876,296.48 | -247,458.56 (-3.4737%) | -1.1859%, inside noise | -1.2904%, inside noise |
| PGlite `provider-identity-1000/full`, 128-byte diagnostic | 1,121,435.28 | 1,121,100.56 | -334.72 (-0.02985%), neutral | not rerun | not rerun |

The governing user plan says **KEEP**: both declared allocation families clear
2xMAD, CPU and wall time do not regress, identity and full-operation controls
stay within the 10% ceiling, and the semantic digests and SQL witnesses are
exact. Authoritative reports:

- `/tmp/viborm-final-exact-sqlite-512.json`, SHA-256
  `221d0c71f87beab981e147b4018a758e74b9df20d273dcf29cccff158405d9c2`;
- `/tmp/viborm-final-exact-pglite-mixed-512.json`, SHA-256
  `0a9e019b33af76942fcf5d2a0c3f1f04d0214d649fac17f5501e7a8122f36055`;
- `/tmp/viborm-final-exact-pglite-identity-128.json`, SHA-256
  `62752aeedd7d1e71beee08f7e513284b9ba7099a91b663adc07ce398389c218e`.

An extra-strict 512-byte PGlite identity diagnostic remains recorded as red:
+261 B/op (+0.186%), just beyond 2xMAD. That movement is smaller than the
approximately 3.39 KB independent A/B HeapProfiler sampling standard error.
Two 128-byte diagnostics reversed its sign, and the exact-runtime final
diagnostic above is neutral. The strict label is preserved as a diagnostic; it
does not replace the governing target plan. Its combined artifacts are
`/tmp/viborm-final2-all-baseline.ndjson` (SHA-256
`379cd0b90146a0a72d542107b5e56afc8c700e24e6f656a520240aa0d41c722a`),
`/tmp/viborm-final2-all-candidate.ndjson` (SHA-256
`9c51b204963c20697cc4029a2bfbd69f7676c1a33c39724daec16d50dd237ca5`),
and `/tmp/viborm-final2-all-order.tsv` (SHA-256
`84f3fe1aea6e8f86aede7a30c9cdf3ef1614c868575e6cb427cb5cb9e1bd5f37`);
the candidate was `3f2d3568...` under protocol `99ef6884...`.

The earlier full matrix was measured on the exact predecessor tree. It showed
SQLite identity -9.24%, SQLite mixed -6.03%, and PGlite mixed -3.47%, with all
RSS changes below 1%. The final runtime change was only the allocation-free
replacement of a concrete-operation check by the operation shell's cohesive
prepared-row capability. Exact-final RSS was not rerun, so the predecessor RSS
result must not be presented as an exact-final measurement.

The earlier broad-ownership baseline was
`52eef9ebfc710407e1e5fe6042e2ed5a11adf19e`. Its rejection reports are
`/tmp/viborm-cross-provider.p4rgFL/reports/sqlite-pglite-owned-row-final.json`
(SHA-256 `fb8cecf22dafbd1a70f25ab9627b6d8eae91b66185534a0427b8e21b59bb1a49`)
and `sqlite-pglite-owned-row-trusted.json`
(SHA-256 `7dc51ceb1ff188018b3c1a06eadfb8ef602cb693aeeb9a399f3feb88d3775d47`).
These temporary reports establish rejection, not a repository artifact. The
17-27% relation-JSON range comes from earlier exact controls; no final combined
keep report exists, so it is not a cumulative end-to-end result.

Retained-memory deltas in that earlier program are signed diagnostics because
forced-GC measurements can be negative. Its keep gate used total
`peakRssBytes`; SQLite3 -2.19% and PGlite +0.96% were neutral controls, not a
reason to retain the rejected broad ownership prototype.

### Retained ownership boundary

The retained implementation adds no result representation and no public mode:

1. SQLite3 and PGlite register a candidate only for the exact stock driver,
   internally created active client, supported stock options, canonical typed
   execution entry, and unchanged driver/adapter parser surfaces. A supplied
   client, subclass, override, or middleware replacement fails closed.
2. `QueryEngine` resolves the candidate once. Its ordinary executor may use the
   proof; cache-managed reads use a candidate-free executor. Transaction-bound
   drivers, array batches, raw calls, custom drivers, and manual parser calls
   remain borrowed.
3. `OperationExecutor` compiles the parser, expected shape, and row program as
   execution-local values. It executes the exact typed entry, rechecks the same
   active producer after the await, and parses the exact result synchronously in
   that continuation. The generic executor sees one optional prepared-row
   capability and imports no concrete operation.
4. The compiled parser is the only `identity` / `reusable` / `copy` decision
   owner. Every collection returns a fresh public outer array. Native identity
   rows may pass through without mutation; only a proved `reusable` same-key row
   may be updated in place; shape-changing rows copy.
5. Provider-supplied nested object carriers are never mutated. If their nested
   row requires decoding it is copied. A graph created by the relation parser's
   own `JSON.parse` may reuse safe same-key nested rows, but only after structural
   validation of the complete fixed/variant carrier and full row set, including
   envelopes, discriminators, orphans, and row shapes, finishes before mutation.

The candidate and active producer live in internal weak maps. No marker, token,
symbol, result property, operation field, or public API transports the proof.

## Drizzle comparative source audit

This appendix asks one narrow question: what does Drizzle actually do between a
SQLite read declaration and the returned JavaScript objects, and which of those
choices are useful evidence for VibORM's remaining large-read allocation gap?

DeepWiki was used to find the two relevant pipelines and their owners. Every
behavioral claim below was then checked against Drizzle's own source. The
benchmark in this repository resolves `drizzle-orm` 0.43.1, so the stable source
links use tag `0.43.1`, commit
`ad28dcd494d043fc39fa15a1622bb7a51deb6090`.

DeepWiki orientation queries:

- [ordinary `better-sqlite3` select pipeline](https://deepwiki.com/search/trace-the-exact-bettersqlite3_a001389a-e521-4c85-b891-bf7bb63bb29b)
- [relational `db.query.*` pipeline](https://deepwiki.com/search/trace-the-exact-bettersqlite3_a66b48ad-cd75-4f5a-8684-04569683191c)
- [prepared-query ownership](https://deepwiki.com/search/in-drizzle-orms-bettersqlite3_6c1232ad-90ba-4ddd-bf65-831c83f118e5)
- [integer and statement modes](https://deepwiki.com/search/does-drizzles-bettersqlite3-dr_19bd275f-fab9-4ae1-9596-ad117f589dcb)
- [allocation-visible mapper choices](https://deepwiki.com/search/identify-allocationrelevant-in_7695f390-cad2-4977-9bde-f73188da9e8d)

DeepWiki is a map here, not evidence. Where its generated explanation was
looser than the source—for example, calling result caching prepared-statement
caching or implying that an iterator necessarily allocates an array—the source
wins.

### Comparative conclusion

Drizzle's measured advantage is not explained by a hidden identity mapper, an
automatic statement cache, or a zero-allocation decoder:

- ordinary mapped selects request positional rows with `stmt.raw()` and then
  allocate one public result object per row;
- Drizzle still allocates a parameter array, an output array for `.all()`, a
  result object and `nullifyMap` per row, and dynamically dispatches a decoder
  for each cell;
- relational reads build positional JSON arrays in SQLite, `JSON.parse` them,
  and recursively allocate named public objects;
- an ordinary call without explicit `.prepare()` rebuilds the query, ordered
  selection, native statement, and Drizzle prepared-query wrapper.

The strongest useful contrast is representation ownership. Drizzle's ordinary
mapped path crosses the native boundary as an array and creates the named row
once. At the audited VibORM baseline, SQLite3 asked the native driver for a
named object and the strict parser usually created another named object. A
disposable directional probe attributed more allocation to that double
representation than to exact-integer transport. The retained implementation
does not adopt Drizzle's positional wire shape; it removes only the second
same-key object shell when execution and parser policy prove that safe.

That evidence originally justified measuring a built-in SQLite positional-row
prototype. The measurements above rejected it. Drizzle's representation is
evidence about a mechanism, not evidence that the mechanism wins in VibORM.

## 1. Ordinary `select().all()` / `select().get()`

### 1.1 Build and preparation

For an ordinary SQLite select, `SQLiteSelectBase._prepare()` does three relevant
things on every direct `.all()` or `.get()` call:

1. `orderSelectedFields(this.config.fields)` flattens the selected object into
   ordered `{ path, field }` descriptors.
2. `this.getSQL()` and `dialect.sqlToQuery(...)` materialize the SQL and params.
3. The session prepares a query with those ordered fields and attaches the
   query's `joinsNotNullableMap`.

Direct `.all()` and `.get()` call `_prepare()` each time. Explicit `.prepare()`
calls `_prepare(false)` once and returns the retained prepared query. These
facts are visible together in
[`SQLiteSelectBase`](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sqlite-core/query-builders/select.ts#L888-L925).

At 0.43.1, `prepareOneTimeQuery()` simply delegates to `prepareQuery()`; it is
not an automatic prepared-statement cache
([`SQLiteSession.prepareOneTimeQuery`](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sqlite-core/session.ts#L121-L136)).
`BetterSQLiteSession.prepareQuery()` calls `client.prepare(query.sql)` and
constructs a new Drizzle `PreparedQuery`
([source](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/better-sqlite3/session.ts#L43-L59)).

Therefore:

- **verified:** an unprepared ordinary call rebuilds ordered selection metadata,
  SQL/query data, the native statement, and the wrapper;
- **verified:** an explicitly prepared query retains the native statement,
  query, selected-field descriptors, logger, execute mode, and later the join
  nullability map;
- **verified:** execution of even an explicitly prepared query still fills a
  fresh params array, obtains fresh native rows, and maps fresh public rows;
- **inference:** statement preparation is fixed per operation, so it cannot by
  itself explain an allocation gap that grows roughly per returned row.

`orderSelectedFields()` recursively walks the selected object and constructs
path arrays and descriptor objects
([source](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/utils.ts#L72-L91)).
That work is retained by explicit `.prepare()`, but it is not retained across
ordinary builder executions.

### 1.2 Execution and native row shape

For a mapped `.all()`:

1. `PreparedQuery.all()` calls `values()` because ordinary select builders pass
   `fields`.
2. `values()` creates bound params with `fillPlaceholders()` and calls
   `stmt.raw().all(...params)`.
3. `all()` maps every positional row through `mapResultRow(fields, row,
   joinsNotNullableMap)`.

For a mapped `.get()`:

1. params are filled;
2. `stmt.raw().get(...params)` returns one positional row or no row;
3. that row is passed directly to `mapResultRow()`.

The exact branches are in
[`BetterSQLitePreparedQuery.all/get/values`](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/better-sqlite3/session.ts#L116-L156).
The fallback branches with neither fields nor a custom mapper call `stmt.all()`
or `stmt.get()` directly, but ordinary typed select builders supply fields and
therefore do not use that direct-object branch.

`fillPlaceholders()` is a `params.map(...)`, so it creates a params array on
every execution, including executions with no user placeholders
([source](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sql/sql.ts#L597-L617)).

Drizzle's `better-sqlite3` source calls no `safeIntegers()`,
`defaultSafeIntegers()`, `pluck()`, `expand()`, or `iterate()` in this pipeline.
The source-visible calls are `raw().all()`, `raw().get()`, `all()`, `get()`, and
`run()`
([source](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/better-sqlite3/session.ts#L110-L156)).
This statement is intentionally limited to Drizzle's code. The pinned
`better-sqlite3` documentation supplies the other half: raw mode returns arrays
instead of objects specifically as a high-row-count performance option, and
number integers are the default unless safe integers are enabled
([raw rows](https://github.com/WiseLibs/better-sqlite3/blob/v12.6.0/docs/api.md#rawtogglestate---this),
[integer modes](https://github.com/WiseLibs/better-sqlite3/blob/v12.6.0/docs/integer.md#the-bigint-primitive-type)).

### 1.3 `mapResultRow()` and ownership

`mapResultRow()` performs the following work for every positional native row:

- allocates `nullifyMap = {}`;
- reduces the ordered column descriptors into `result = {}`;
- dispatches the field decoder with `is(field, Column | SQL | ...)` for every
  cell;
- walks the field's path and creates missing nested objects;
- writes `null` unchanged or calls `decoder.mapFromDriverValue(rawValue)`;
- records enough table identity in `nullifyMap` to replace a nullable joined
  object with `null` after mapping.

All of this is directly visible in
[`mapResultRow`](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/utils.ts#L14-L69).

Ownership is consequently precise:

- the native positional row is local input to the mapper;
- the returned row is the newly constructed `result` object;
- nested result objects are created only as demanded by descriptor paths;
- raw rows are not exposed by the mapped `.all()` / `.get()` result;
- the ordered descriptors and join-nullability map are retained by an explicit
  prepared query, but `nullifyMap` and `result` are per row.

Important negative finding: Drizzle does **not** precompile field-kind decoder
steps. It repeats decoder-kind dispatch inside `mapResultRow()` for every cell.
VibORM already compiles row steps once per result set. Copying this part of
Drizzle would discard an existing VibORM optimization.

## 2. Relational `db.query.<table>.findMany()` / `findFirst()`

This is a different pipeline. It does not call `mapResultRow()`.

### 2.1 Query object and SQL construction

`BaseSQLiteDatabase` creates one `RelationalQueryBuilder` per registered table
when the database is constructed
([source](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sqlite-core/db.ts#L32-L88)).
Each `findMany()` call still creates a `SQLiteSyncRelationalQuery`; `findFirst()`
also creates a config object with `limit: 1`
([source](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sqlite-core/query-builders/query.ts#L41-L94)).

Execution calls `_toSQL()`, which runs `dialect.buildRelationalQuery(...)` and
`dialect.sqlToQuery(...)`, then asks the session to prepare either `all` or
`get` with `fields: undefined` and a custom result mapper
([source](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sqlite-core/query-builders/query.ts#L128-L193)).
There is no hidden retained relational query plan in a normal call. Explicit
`.prepare()` retains the produced statement and mapper.

### 2.2 Positional JSON carrier

For each selected relation, `buildRelationalQuery()` recursively builds the
relation selection and records a selection descriptor with `isJson: true`
([source](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sqlite-core/dialect.ts#L665-L710)).

At a nested relation boundary, SQLite SQL is built as:

- `json_array(selectedValue0, selectedValue1, ...)` for one row;
- `coalesce(json_group_array(json_array(...)), json_array())` for a to-many
  collection.

The source constructs a positional JSON value, not an object carrying field
names
([source](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sqlite-core/dialect.ts#L724-L811)).
The recursive selection descriptors retain the association between ordinal and
TypeScript field name.

### 2.3 Execution and `mapRelationalRow()`

Because a custom result mapper is present, `BetterSQLitePreparedQuery.all()`
still obtains positional native rows through `values()` and passes them to the
mapper. `findMany` then runs `rawRows.map(mapRelationalRow)`; `findFirst` uses
the `get()` branch, which wraps the single row as `[row]`, invokes the same
array mapper, and takes `rows[0]`
([query mapper](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sqlite-core/query-builders/query.ts#L142-L160),
[prepared get](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/better-sqlite3/session.ts#L131-L150)).

`mapRelationalRow()` then:

- allocates one named `result = {}` for the current row;
- indexes every scalar by ordinal and dispatches its decoder;
- parses string relation carriers with `JSON.parse`;
- recurses directly for a to-one positional sub-row;
- maps a to-many array into a new public array of recursively built objects.

The exact implementation is
[`mapRelationalRow`](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/relations.ts#L666-L724).

Source-visible allocation consequences are therefore:

- `JSON.parse` materializes positional intermediate arrays;
- every relational row level gets a new named public object;
- each to-many level gets a new mapped output array in addition to the parsed
  intermediate array;
- `findFirst` with the custom mapper creates the one-element `[row]` wrapper and
  the mapper's one-element `rows` output before returning its first element.

This is compact, not free.

## 3. What differed at the audited VibORM baseline

The comparative source audit below is pinned at the historical implementation
commit
`52eef9ebfc710407e1e5fe6042e2ed5a11adf19e`.

### 3.1 SQLite native rows are objects and integers are globally exact

At that commit, `SQLite3Driver.runStatement()` did the following:

- prepared a `better-sqlite3` statement;
- enabled `stmt.safeIntegers(true)` for every ORM reader;
- called `stmt.all(...)`, not `stmt.raw().all(...)`;
- returned those named row objects in `QueryResult.rows`.

See
[`SQLite3Driver.runStatement`](https://github.com/beynar/viborm/blob/52eef9ebfc710407e1e5fe6042e2ed5a11adf19e/src/drivers/sqlite3/index.ts#L113-L133).
The source comment stated the invariant: integer columns arrived as `BigInt` so
values outside the safe number range survived until typed parsing. Raw public
queries deliberately left safe-integer mode off.

### 3.2 The strict parser usually constructed a second named row

VibORM validated that every provider row was a non-null object with the
`[object Object]` tag, checked its keys against the expected shape, precompiled
field/relation steps once per result set, and then normally allocated
`result = {}` for every row
([row contracts](https://github.com/beynar/viborm/blob/52eef9ebfc710407e1e5fe6042e2ed5a11adf19e/src/query-engine/result/result-parser-contract.ts#L91-L139),
[expected keys](https://github.com/beynar/viborm/blob/52eef9ebfc710407e1e5fe6042e2ed5a11adf19e/src/query-engine/result/result-parser-contract.ts#L188-L219),
[compiled row steps](https://github.com/beynar/viborm/blob/52eef9ebfc710407e1e5fe6042e2ed5a11adf19e/src/query-engine/result/result-row-parser.ts#L200-L411)).

The whole-row identity path could not apply to that SQLite baseline: it had
driver field middleware for boolean and JSON conversion, and the adapter did
not declare native scalar passthrough. Thus the large flat SQLite read paid for
the native named row and the parser's named result row.

One profile was later summarized as approximately 666 KB in
`parseResultRows`, then described as the direct cost of a "second copy." That
description was wrong. The profile value was inclusive stack attribution, not
the function's self allocation. `parseResultRows` directly creates the fresh
outer result array. The compiled row builder separately creates object shells
and property storage and assigns references to existing scalar values; it does
not duplicate every scalar payload or account for all provider allocation.

The six-column directional probe below is the useful mechanism estimate:
named-safe-copy minus named-safe-in-place is about 73.9 KB/op. The faithful
final `scalar-find-many-1000/full` workload saves about 94.8 KB/op. That is
consistent with avoiding row rebuilding plus nearby work, but it supports
neither a 666 KB direct-copy claim nor a 50% total-allocation claim.

### 3.3 Per-cell callback middleware was the dominant remaining parser cost

`ResultParser.createFieldChain()` compiled the scalar's metadata once, which was
good, but that middleware composition created callback closures inside the
value path:

- driver field parsing receives a newly written continuation that calls the
  adapter decoder;
- adapter field parsing receives a newly written continuation that selects the
  transformed or original value.

See
[`createFieldChain`](https://github.com/beynar/viborm/blob/52eef9ebfc710407e1e5fe6042e2ed5a11adf19e/src/query-engine/result/ResultParser.ts#L458-L535).
For SQLite, `sqliteResultParser.parseField()` uses this chain for booleans and
JSON and delegates every other scalar unchanged
([source](https://github.com/beynar/viborm/blob/52eef9ebfc710407e1e5fe6042e2ed5a11adf19e/src/drivers/shared/sqlite-utils.ts#L42-L71)).

Those continuation expressions were evaluated on the per-cell path. A
six-column, 1,000-row result therefore created about 12,000 short-lived function
objects: one driver continuation and one adapter continuation per scalar cell.

The retained implementation keeps the existing callback contract but compiles
the continuations once per scalar chain. The adapter decoder itself is the
driver continuation. One stable adapter continuation implements the documented
`next()` fallback, while save/restore of its active input preserves synchronous
reentrant parsing.

The repository's five-pair alternating SQLite comparison measured the complete
`scalar-find-many-1000/full` operation as follows:

| Metric | Baseline | Retained implementation | Delta |
|---|---:|---:|---:|
| Allocation | 1,472,366.80 B/op | 1,139,139.84 B/op | -333,226.96 B/op (-22.6321%) |
| Framework CPU | 901.23 us/op | 868.31 us/op | -3.6528% |
| Wall time | 752.96 us/op | 731.01 us/op | -2.9162% |
| Retained heap | 1,137.20 B/op | 1,159.20 B/op | +1.9346% |
| Peak RSS | 95,502,336 B | 93,945,856 B | -1.6298% |

Allocation, CPU, and wall improvements cleared 2xMAD. Retained heap stayed
inside the 10% ceiling and absolute peak RSS fell, so the repository keep gate
accepted the unit. The equivalent PGlite mixed-scalar control was neutral:
allocation +0.0439%, CPU +1.0592%, and wall +1.3147%, all inside 2xMAD.

### 3.4 Relation carriers use named JSON objects

VibORM builds nested selections through `json.objectFromColumns(...)`, so
SQLite relation carriers repeat selected field names in their JSON text
([source](https://github.com/beynar/viborm/blob/52eef9ebfc710407e1e5fe6042e2ed5a11adf19e/src/query-engine/builders/select-builder.ts#L110-L156)).
The relation parser then validates named row objects and their expected keys
([source](https://github.com/beynar/viborm/blob/52eef9ebfc710407e1e5fe6042e2ed5a11adf19e/src/query-engine/result/relation-result-parser.ts#L15-L96)).

Drizzle's positional JSON is therefore not a local syntax substitution. It is
a different internal wire contract with ordinal metadata and weaker naming at
the carrier boundary.

## 4. Benchmark correctness issue before any new comparison

The current comparison does not return the same public type for `published`:

- VibORM declares `published: s.boolean()`;
- the Drizzle arm declares `published: integer("published")`, the default
  numeric integer column, rather than `integer("published", { mode: "boolean"
  })`.

Drizzle's default `SQLiteInteger` has no value decoder override, while its
boolean mode explicitly returns `Number(value) === 1`
([integer](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sqlite-core/columns/integer.ts#L75-L96),
[boolean](https://github.com/drizzle-team/drizzle-orm/blob/ad28dcd494d043fc39fa15a1622bb7a51deb6090/drizzle-orm/src/sqlite-core/columns/integer.ts#L168-L201)).
The 1,000-row benchmark consumes only `rows.length` and `views`, so the numeric
versus boolean mismatch is not detected.

Before using a Drizzle ratio as comparative evidence:

1. declare the Drizzle column in boolean mode;
2. update the Drizzle predicate to use the typed boolean;
3. assert representative complete results, including the `published` value and
   type, before timing;
4. keep unprepared public calls and explicit prepared calls as separate arms;
5. use fresh alternating processes for keep decisions, not the legacy
   same-process exploratory script.

This correction may not erase the gap, but an unfair result shape cannot be the
baseline for an architectural decision.

## 5. Disposable directional probe

A local four-arm probe was run in five fresh processes over 1,000 six-column
rows. It is **disposable directional evidence**, not a keep report: it did not
run through the full VibORM contract, public semantics, provider matrix, or the
repository's alternating comparison coordinator.

| Materialization arm | Median allocation | Median CPU |
|---|---:|---:|
| named object + safe integers + copy | 765.4 KB | 303.0 us |
| named object + safe integers + in-place | 691.5 KB | 281.8 us |
| positional array + safe integers + one result object | 328.9 KB | 227.3 us |
| positional array + number integers + one result object | 289.7 KB | 212.8 us |

Directional interpretation:

- positional input plus one named public result cut allocation by about 57%
  and CPU by about 25% relative to named input plus a copied result;
- mutating/returning a named input recovered 73.9 KB/op, much less than the
  positional change but close to the later faithful workload's 94.8 KB/op;
- after positional transport, exact-integer mode accounted for only about
  39 KB and 14.5 us across the 1,000 rows in this probe.

The observed full-operation gap was about 608 KB/op (1,504 KB VibORM versus
896 KB Drizzle). The isolated positional-safe arm removes 436.5 KB relative to
the named-safe-copy arm, roughly 72% of that amount. Those values are not
strictly subtractable across two different harnesses, but they make positional
transport the first mechanism to falsify.

The probe supports prioritization only. It does not prove that the same gains
survive VibORM's query construction, strict scalar semantics, nested relations,
custom drivers, or error contracts.

## 6. Historical experiment agenda and measured outcome

### Rank 1 — Built-in SQLite positional-row transport (rejected)

**Hypothesis:** for a query compiled by VibORM itself, the driver can return
positional rows and the existing query-owned selection order can feed the
existing compiled result steps. That removes the native named row which the
parser would otherwise replace, and can avoid string-key discovery at the
trusted built-in boundary.

**Boundary cost:** this is not a local driver edit. The normalized `QueryResult`
contract currently requires object rows, while positional decoding also needs
the compiler's exact result-column order. A disposable prototype may join those
facts behind the existing built-in prepared-operation seam, but a production
change must identify one existing internal owner for that pairing or explicitly
revise the normalized internal contract. It must not add a public row mode or a
second result-shape truth. Public `_executeRaw`, custom drivers, and untrusted
result injection remain object-row paths. The result parser must still create
the public named object, run scalar decoders, and preserve field order.

**Proof method:** first capture allocation source lines for the current
`scalar-find-many-1000` execute, parse, raw-parse, and full stages. Then run five
alternating fresh-process samples for 1, 20, 1,000, and 10,000 rows, plus a
100-column row and fixed/variant relation controls. Require semantic digests,
complete key order, all scalar types, nullable values, unsafe integers,
prepared/unprepared execution, batches, transactions, and hostile custom-driver
tests to remain exact. Keep only beyond 2xMAD with no CPU/wall regression over
the established ceiling.

**Expected falsifier:** if native array rows plus final named objects do not
remove the driver-object and key-scan allocation frames in the full path, the
local probe was not representative and the transport should be removed.

### Rank 2 — Reused compiled scalar continuations (retained)

The hypothesis was correct, but replacing the middleware protocol was
unnecessary. `ResultParser.createFieldChain()` now reuses one adapter
continuation and passes the adapter decoder directly as the driver's
continuation. The callback signatures, driver -> adapter -> strict-parser order,
typed failures, and `next()` fallback remain unchanged.

The first prototype added two persistent closures per scalar. It cleared the
allocation and CPU targets but increased retained heap by 17.00%, so it was
rejected. Removing those persistent closures kept the transient-allocation win
and reduced the final retained-heap movement to +1.93%. A focused contract pins
callback identity across rows and recursively reenters the same field parser to
prove that the outer fallback value is restored.

### Rank 3 — Type-aware integer transport feasibility, not a blind switch

**Hypothesis:** statement-wide `safeIntegers(true)` may be avoidable for a
projection containing only boolean-backed integer columns, because zero and one
are exactly representable numbers. It is **not** safely removable from a query
that returns `int`: better-sqlite3 would round an out-of-range 64-bit integer
before the strict parser could reject it. Casting only `bigint` to text would
therefore be insufficient.

**Prototype:** first measure boolean-only selections with safe integers on and
off. For a mixed projection, compare the current exact path against a
semantically exact alternative that casts every range-sensitive `int`/`bigint`
result to text and parses it at the existing scalar boundary. Do not retain a
type-aware statement mode unless the compiler's selected-result descriptor is
already sufficient to prove that no unrepresented integer expression, count,
aggregate, or private carrier can appear.

**Proof method:** test min/max signed SQLite integers, both sides of
`Number.MAX_SAFE_INTEGER`, integer IDs, booleans, counts, aggregates, returning
mutations, raw queries, relation JSON, and all SQLite-family drivers. Compare
the Rank-1 positional arm with safe integers on and off in fresh processes.

**Expected falsifier:** any path that observes a range-sensitive integer
through a JavaScript number before validation kills the prototype regardless
of speed. The disposable probe already prices exact integers at only about
39 KB and 14.5 us per 1,000 six-field rows, so the likely correct outcome is to
keep exact mode for the measured mixed shape and spend effort on representation.

### Rank 4 — Positional JSON relation carriers, only after a nested profile

**Hypothesis:** for wide/deep includes, positional JSON can remove repeated field
names from the SQLite payload and parse intermediate arrays more compactly.

**Why it is last:** it changes an internal cross-dialect wire contract, while
the cited comparison already showed VibORM allocating less than Drizzle on the
small relation workload. Drizzle's source proves feasibility, not superiority
for VibORM's richer relation and integrity semantics.

**Proof method:** attribute JSON string bytes, `JSON.parse` allocation, named
object materialization, and validation separately at width 2/20/100 and depth
1/2/3 for ordinary and variant targets. A prototype must retain strict missing,
extra, malformed, orphan, discriminator, nullable, ordering, and provider
contracts. Run SQLite, PostgreSQL, and MySQL controls because the representation
owner is shared.

**Expected falsifier:** if repeated JSON keys are not a top allocation source,
or if positional remapping merely trades JSON allocation for JavaScript mapping
CPU, keep the named carrier.

## 7. False analogies and unsafe copying risks

1. **“Drizzle is fast because it caches statements.”** False for the compared
   ordinary calls. Direct `.all()` rebuilds and prepares; only explicit
   `.prepare()` retains the statement.

2. **“Drizzle returns driver objects unchanged.”** False for typed ordinary
   selects with fields. It requests positional rows and creates public objects
   with `mapResultRow()`.

3. **“Raw arrays are automatically safe.”** False. Drizzle couples ordinals to
   ordered field descriptors. VibORM may use positional transport only where one
   compiled owner proves that exact correspondence. Public/custom results remain
   untrusted.

4. **“Copy Drizzle's mapper.”** Unsafe and unnecessary. Drizzle repeats field
   kind dispatch per cell; VibORM already compiles field/relation steps once per
   result set. Preserve that stronger owner.

5. **“Use number integers everywhere.”** Unsafe. Drizzle's audited driver does
   not opt into safe integers, but VibORM explicitly promises exact `bigint` and
   rejection of unsafe `int`. Any optimization must preserve those contracts,
   probably by selecting exact bigint text rather than by silently accepting
   the driver default.

6. **“Positional JSON is only a serialization tweak.”** False. VibORM's named
   relation carriers participate in strict shape and integrity validation.
   Replacing them changes the internal protocol and every provider must agree.

7. **“The current ratio compares identical values.”** False until Drizzle's
   `published` column uses boolean mode and the benchmark checks the returned
   type.

8. **“Allocation means retained memory.”** False. These experiments concern
   short-lived allocation and GC pressure. Retained heap remains a separate
   measurement and acceptance control.

## 8. Superseded recommendation

The benchmark boolean mismatch was corrected and Rank 1 was run through the
fresh-process operation-pipeline harness. It failed its allocation/CPU controls
and was removed. Broad provider-row ownership also failed its final SQLite
wall-time control and was removed. Those rejections still stand.

What changed later was the proof boundary, not the verdict by relabeling. The
retained stock SQLite3/PGlite path neither changes the wire shape nor asserts
provider ownership. It proves the exact active producer around one typed
execute, keeps that fact lexical until synchronous parse, and lets the compiled
parser reuse only same-key rows classified `reusable`. The outer result array
remains fresh, custom and indirect execution paths remain borrowed, and
parser-owned relation-JSON decoding keeps its independent retained rule.
