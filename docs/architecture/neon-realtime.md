# Neon Realtime: maintainer notes

`viborm/neon-realtime` (server) and `viborm/neon-realtime/client` (browser)
make the nine model reads live. User documentation:
`docs/content/docs/extensions/neon-realtime.mdx`. This note records why the
pieces exist and what must stay true.

## Flow

1. `db.post.findManyRealtime(args)` calls the ordinary delegate method, so the
   read is admitted exactly like `findMany` (controls, request transforms,
   default omit, validation, `rows` domains).
2. `exportPendingRead` (`query-engine/pending-operation.ts`) runs inside the
   operation's own lifecycle — observers included, renewals too — and hands the
   routed operation to the extension's `prepare` before any execution.
   `prepare` refuses what the sealed SQL cannot reproduce, then
   `PreparedCommand.exportRead` compiles the admitted read a second time with
   a `ReadTransport`. With initial data, the ordinary statement then runs once;
   the transport statement never runs on the server.
3. `realtime.seal` encrypts the transport SQL and its parameters
   (`rawSql`/`pgParam`). The answer is `{ kind, sealed, plan, encoded }`; `plan`
   is the row shape (schema objects stripped) and the read's publication rule,
   `encoded` the first result through the cache's value codecs. The logical
   `data` is a non-enumerable server property, so every transport carries the
   plain-JSON envelope.
4. The browser subscribes with Neon's SDK (socket, materialization,
   `QueryRefreshController`), sorts the live rows by their rank, decodes them
   with `ProjectionDecoder` — the decoder ordinary reads use — and publishes
   with `publishReadResult`, the ordinary read's rule.

## Why a transport lowering

Neon Realtime keeps a query live only if every expression is immutable. It
refuses `json_build_object`, `jsonb_build_object`, `row_to_json`,
`array_to_json`, `array_to_string` (mutable), `json_agg`/`json_object_agg`
(unsafe aggregate), set-returning sources such as `unnest … WITH ORDINALITY`,
and every PostGIS/pgvector output function. The ordinary PostgreSQL statement
builds relations and aggregates with those JSON functions.

`neon-realtime/transport-sql.ts` is the PostgreSQL adapter's other spelling
(`ReadTransport`): JSON concatenated from text — `json_object(ARRAY['v',
x::text])->'v'` escapes a string, every other member is its own text —
collections through `string_agg(… ORDER BY …)`, and lists as PostgreSQL array
text the browser parses. `Queries` asks it at three seams only: a carried
leaf's token (`#carriedValue`), an ordered aggregate (`#agg`), and the
`QueryParts.ordinal` a page states, which only this adapter publishes. The
ordinary statement is unchanged; core pays about 140 B gzip.

## Why an ordinal

Neon materializes a result as a set of keyed rows: it has no order. A root
page (`findMany`, `groupBy`, `findFirst`) publishes `ROW_NUMBER() OVER (ORDER
BY <its effective ORDER BY>)` as `0viborm_ordinal`; the browser sorts by it,
then applies the read's rule (a negative `take` reverses, as ordinary). Nested
pages use the same rank inside their `string_agg … ORDER BY`. The emulated
`DISTINCT` keeps its ordinary `_rn`/`_ordN` aliases and only carries the rank
through. Ranking makes Neon deliver fresh baselines rather than incremental
changes: correct, documented.

## Refusals (one place each)

- Install time (`neonRealtime`): a non-PostgreSQL client; `neon-http` with
  `authToken` (`NeonHTTPDriver.userAuthorized`).
- `prepare`, before any execution: a transaction (`TransactionBoundDriver`),
  `query` handlers (this covers `cache()` and `permissions()`; a `$withCache`
  view needs `cache()`), statement transforms, computed `result` fields.
- `describe` (shape walk): field read gates, `_distance`, point and vector
  projections, and a recursive relation whose selection leaves its key out —
  its carrier names nodes by key, so shipping it would leak an omitted field.

## Trust model

The sealed SQL is the security boundary: Neon runs exactly what the server
sealed, as one database role, without row-level security. Authorize on the
server before issuing a query. The plan is not a boundary — it only tells the
browser how to read rows its own sealed query returns — so the browser checks
one thing, the plan's version. A renewal must carry the same plan (one string
comparison) and passes Neon's own fingerprint check; neither is wrapped.

## Packaging

The browser half is built as one self-contained file (no shared chunk, no
driver, no SQL compiler): importing the server's chunks would re-split them
and grow every application bundle. The package's one `Decimal` class is its
own file, `dist/decimal.mjs`, which every build imports, so a browser-decoded
value is an instance of the class every entry exports. The server half
imports the browser file for the envelope codec, so encode and decode cannot
drift; it spells that import `../neon-realtime/client` so the build can point
exactly that specifier at the file. `decimal.mjs` and the browser file ship
without source maps, to keep the 260-file release budget.
Externals and output paths in `tsdown.config.ts` are data, never functions:
with a function there, rolldown 1.0.0-beta.58 now and then stalls the
declaration build for good.

## Hosted evidence

`tests/providers/hosted/neon-realtime-smoke.mjs` (manual, reads `.env`) runs
the nine reads, one live update and one renewal against a Neon database with
Realtime enabled. `tests/providers/local/pglite-neon-realtime.test.ts` runs
the exact sealed SQL on embedded PostgreSQL in CI.
