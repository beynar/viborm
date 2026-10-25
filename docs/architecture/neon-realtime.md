# Neon Realtime: maintainer notes

`viborm/neon-realtime` (server) and `viborm/neon-realtime/client` (browser)
make the nine model reads live. User documentation:
`docs/content/docs/extensions/neon-realtime.mdx`. This note records why the
pieces exist and what must stay true.

## Flow

1. `db.post.findManyRealtime(args)` calls the ordinary delegate method, so the
   read is admitted exactly like `findMany` (controls, request transforms,
   default omit, validation, `rows` domains, `query` handlers).
2. `exportPendingRead` (`query-engine/pending-operation.ts`) puts the
   extension's exporter in place of the operation's execution, inside its own
   lifecycle — query handlers, observers and error context included, renewals
   too. The exporter refuses what the sealed SQL cannot reproduce, then
   `PreparedCommand.exportRead` compiles the admitted read a second time over
   the transport adapter. With initial data, the exporter then runs the
   ordinary statement once and answers its result; a renewal reads nothing and
   answers `undefined` through the handlers (a memoizing handler must skip it);
   the transport statement never runs on the server.
3. `realtime.seal` encrypts the transport SQL and its parameters
   (`rawSql`/`pgParam`). The answer is `{ kind, sealed, plan, encoded }`; `plan`
   is the row shape (schema objects stripped) and the read's publication rule,
   `encoded` the first result through the cache's value codecs. The logical
   `data` is a non-enumerable server property (typed optional), so every
   transport carries the plain-JSON envelope; `realtimeData(query)` reads the
   first result on either side.
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

`neon-realtime/transport-sql.ts` is the PostgreSQL adapter's other spelling,
an adapter over the client's own: JSON concatenated from text —
`json_object(ARRAY['v', x::text])->'v'` escapes a string, every other member
is its own text — collections through `string_agg(… ORDER BY …)`, and lists
as PostgreSQL array text the browser parses. `Queries` reaches it through
four adapter seams that stock adapters ignore: `json.carry` (a carried
scalar's token), `json.identity` (a recursive row's ordinal), the
`rankedPage` argument of `json.agg`, and `QueryParts.ranked` on the four page
selects. The ordinary statement is unchanged. Measured with `pnpm size`
against main 1.4.2, the seams and the decoder extraction cost the bundles
that never import Neon Realtime +45 B gzip (D1 Worker), +63 B (pg
application), +58 B (pg + permissions), +53 B (pg + migrations Worker) and
+122 B ("every public entry"); `json.identity` alone is 13–33 B of that. The
browser's array-text lists stay in the browser (`TransportDecoder` overrides
`compileList`). The browser entry is 23.6 kB gzip, the server entry file
2.3 kB.

## Why an ordinal

Neon materializes a result as a set of keyed rows: it has no order. A root
page (`findMany`, `groupBy`, `findFirst`) publishes `ROW_NUMBER() OVER (ORDER
BY <its effective ORDER BY>)` as `0viborm_ordinal`; the browser sorts by it,
then applies the read's rule (a negative `take` reverses, as ordinary). Nested
pages use the same rank inside their `string_agg … ORDER BY`. The emulated
`DISTINCT` keeps its ordinary `_rn`/`_ordN` aliases and only carries the rank
through. Ranking makes Neon deliver fresh baselines rather than incremental
changes: correct, documented.

A recursive carrier names its root and nodes by ordinal too, not by key, so a
projection that leaves its key out ships no key: the root is 0, every other
reached row 1 + the number of reached keys below its own (`json.identity`; a
row equal to the root is 0, so a cycle back to it is still one). The plan's
`identity` becomes one integer leaf. Each ordinal is a correlated count over
the reached keys, so a carrier costs Neon work quadratic in its reached rows
(bounded by `maxOccurrences`) on each change; a join would need the core's
edge page to change shape.

## Refusals (one place each)

- Install time (`neonRealtime`): a non-PostgreSQL client; `neon-http` with
  `authToken` (`NeonHTTPDriver.userAuthorized`).
- `exportRead`, before any execution: a transaction (`TransactionBoundDriver`),
  statement transforms, computed `result` fields; while compiling, a
  `{ now: true }` predicate (the export's instant refuses: sealed, the instant
  would never move, and each renewal would bind another, which Neon's
  fingerprint refuses).
- After the lifecycle: `query` handlers that did not answer with the
  exporter's own answer (it never ran, or a handler replaced its result).
  That one identity check is the invariant: handlers see the genuine ordinary
  result (`undefined` on a renewal), and pass it through. `permissions()` only refuses or proceeds. The official `cache()`
  installs no chain handler; its cached reads live on `$withCache()` views,
  which carry no model methods, so no cached read can wrap the exporter.
- `describe` (shape walk, by node `kind`: keys also name model fields): a
  projected read-gated field (its gate is a boolean of the sealed row, but the
  value travels beside it unmasked and only the decoder drops it; masking it
  needs a gate per projected field in the core lowering — where, orderBy,
  aggregates and groupBy already mask it in the SQL and are live),
  `_distance`, point and vector projections.
- `permissions()` must come first: `rows` cannot follow an extension with
  model methods, and `$extends` refuses that order with
  `ClientInitializationError`.

## Trust model

The sealed SQL is the security boundary: Neon runs exactly what the server
sealed, as one database role, without row-level security. Authorize on the
server before issuing a query, or seal through `permissions()`, whose rows
compile into that SQL. The plan is not a boundary — it only tells the
browser how to read rows its own sealed query returns — so the browser checks
one thing, the plan's version. A renewal must carry the same plan (one string
comparison) and passes Neon's own fingerprint check; neither is wrapped.

## Packaging

The browser half is built as one self-contained file with its own `Decimal`
copy, which it exports (no shared chunk, no driver, no SQL compiler):
importing the server's chunks would re-split them and grow every application
bundle. A decimal it decodes is therefore not an instance of the server
entries' `Decimal`; `decimal-identity-smoke.mjs` holds every other entry to
one class and names this exception. The server half imports the envelope
codec (`plan.ts`) from its own build, which splits one shared chunk
(`cache-value-codecs`). The browser file ships no source map: embedding every
source it copies, the map alone is 125 kB of the tarball and puts it over
`maximumCompressedBytes`. The tarball has 264 files (budget 265).
Externals in `tsdown.config.ts` stay data, never functions: with a function
there, rolldown 1.0.0-beta.58 now and then stalls the declaration build for
good.

## Hosted evidence

`tests/providers/hosted/neon-realtime-smoke.mjs` (manual, reads `.env`) runs
the nine reads, one live update, one renewal, a recursive read without its
keys, and permission-filtered reads (relation predicate, `$exists` with
`$row`, actor parameters, an aggregated read-gated field) with a forbidden
and a permitted update and a renewal, against a Neon database with Realtime
enabled. `tests/providers/local/pglite-neon-realtime.test.ts` runs
the exact sealed SQL on embedded PostgreSQL in CI.
