# D-33 — a `json().schema(…)` field's user schema runs on the read path

Author: Fable. Worktree `/private/tmp/viborm-rulings-d33`, branch `rulings-d33`
from `e821cd21`. `TMPDIR=/private/tmp/viborm-rulings-tmp-d33` exported for every
run. Receipts: `docs/architecture/raptor3-evidence/g4/rulings/receipts/d33/`.

## The gate (written before the first production edit)

**Required behavior.** A JSON field declared with a user schema
(`s.json().schema(standardSchema)`) has that schema run at the one decode
boundary, on every provider and on every route, as the engine replaced did.
Cost accepted by Arnaud: one schema run per JSON field per row read.

**Current owner (before).** Nobody. `Queries.decodeScalar`'s `case "json"`
(`src/query-engine/raptor3/shared/query.ts`) hands the provider value to
`Queries.jsonValue`, which owns the JSON VALUE DOMAIN and never consults the
field. Measured by the parity unit (`g4/parity/integration-note.md` §1c):
`StandardSchemaV1.validate` is invoked **zero** times in the whole cache-SWR
file. The write path already runs it at admission
(`validation/primitives/helpers.ts:207-218`, through the field's
`state.base` = `v.json({ nullable, schema })`), which is why the feature looked
alive.

The engine replaced did it at the same seam: `result/ResultParser.ts:721`
(`const jsonSchema = scalarType === "json" ? state.schema : undefined;`) read
the fact ONCE per compiled field chain and handed it to the JSON codec's parse
(`:817`, `:913`), which was `scalar-structured-parser.ts:78`
`parseJsonValueWithSchema` — JSON value domain, then the schema, then the JSON
value domain again over the schema's OUTPUT.

**Smallest proposed change.** Three hunks in one file, `shared/query.ts`:

1. `Leaf` gains `jsonSchema?: StandardSchemaV1` — the field's own output schema,
   beside `decimal`, `dateTime`, `enumValues` and `dimension`, which are the
   same kind of fact: a projection of the declaring scalar's state that decoding
   reads.
2. `Queries.leaf` fills it (`state.type === "json" ? state.schema : undefined`).
   That is the ONE reader of the field's state, memoized per
   (adapter, model, field) by `scalarShape`/`views.leaves`, exactly where the
   deleted parser read it once per compiled chain — never per row, and no second
   walker of the projection to find JSON fields.
3. `decodeScalar`'s `case "json"` runs it: `jsonValue(raw)` → the schema →
   `jsonValue(output)`, the deleted parser's own order. The schema itself is
   invoked through the estate's existing owner of that protocol, `parse`
   (`src/validation/index.ts:86`), which the engine already consumes at
   `write-engine/parse-boundary.ts:2`; a failure becomes
   `InvalidScalarResult("json", "custom output schema rejected the value")`,
   which `OperationContext.failure` already publishes as the restored public
   `QueryEngineError` sentence.

**Decisions that disappear.**

- *Mechanism*: "does this JSON value have a user schema, and has it run?" stops
  being unanswerable. One fact (`leaf.jsonSchema`), one producer
  (`Queries.leaf`), one reader (`decodeScalar`'s json case).
- *Consumers*: the live route, the prepared route and the batch terminal all
  reach `decodeScalar` through the single `decodeValue`/`decodeProjection`
  decoder (rule 7), so none of them decides anything; the cache route
  materializes from the snapshot (`result/cache-json-codec.ts`
  `materializeJsonValue`) and therefore CANNOT run the schema a second time.
- *Replacing invariant*: the JSON value domain is answered by `jsonValue` and
  the field's admissibility by the field's own schema — the decoder never
  inspects the schema's issues, never re-implements the Standard Schema
  invocation protocol, and never re-parses.
- *Falsifier*: `official-cache-swr.core.test.ts:550` (red at `e821cd21`,
  receipt `baseline-cache-swr.log`) plus the new registered pin
  `tests/raptor3/g4/parity/json-read-schema.test.ts`.

**Alternatives rejected under the rules** (see §Alternatives below): a second
projection walker; a policy boolean on the decoder; re-running the field's
`state.base` write validator on read; spelling the Standard Schema invocation
protocol a fourth time inside the engine.

---

## The truth

A `json` field's user schema is declared once and was consulted on ONE side.
`s.json().schema(standardSchema)` stores the schema on the scalar's state
(`src/schema/scalars/json/scalar.ts:54-66`: `state.schema`, plus a rebuilt
`state.base` = `v.json({ nullable, schema })`). The WRITE path runs it at
admission — `validation/primitives/helpers.ts:207-218` chains
`schema["~standard"].validate` into the field validator, which
`write-engine/parse-boundary.ts` reaches through `parse` — so the feature looked
alive while the READ path never asked: `decodeScalar`'s `case "json"` handed the
provider value to `jsonValue` and published it. Measured by the parity unit
before this ruling (`g4/parity/integration-note.md` §1c): `validate` invoked
**zero** times in the whole cache-SWR file.

The engine replaced consulted it at its one decode boundary:
`result/ResultParser.ts:721` read `scalarType === "json" ? state.schema :
undefined` once per compiled field chain and handed it to the JSON codec's parse
at `:817` and `:913`; the codec was `result/scalar-structured-parser.ts:78`
`parseJsonValueWithSchema`, which ran `parseJsonValue` over the provider value,
then the schema, then `parseJsonValue` again over the schema's OUTPUT. Its
refusal was `malformedScalarValue(provider, operation, "json", …)`
(`result/result-parser-contract.ts:83-93`) — a public `QueryEngineError`:

    Driver "<driver>" returned a malformed json scalar for operation "<op>": custom output schema rejected the value.

with `meta { driver, operation, scalarType: "json" }`, and no issue detail
(deleted `tests/contracts/engine/query/scalar-result-contracts.core.test.ts` ›
"redacts custom JSON validation details" demanded the value and the schema's
messages stay out of the message; › "runs custom JSON output validation exactly
once" demanded one run per value, after driver and adapter decoding).

## The owner

`Queries` in `src/query-engine/raptor3/shared/query.ts`, at the two places that
already own these two facts:

- **the fact**: `Queries.leaf` (`:930-945`), the ONE leaf builder, memoized per
  (adapter, model, field) through `scalarShape`/`views.leaves`. It already
  projects `decimal`, `dateTime`, `enumValues` and `dimension` off the declaring
  scalar's state for the decoder; `jsonSchema` is the same kind of fact and is
  read in the same breath. This is where the engine replaced read it (once per
  compiled chain), so nothing walks a projection looking for JSON columns and
  nothing reads `state.schema` per row.
- **the reader**: `decodeScalar`'s `case "json"` (`:4520-4525`), reached only
  through `decodeValue` from `decodeQuery`/`decodeProjection` — the single leaf
  decoder, which serves the live read, the prepared read, the batch terminal and
  every RETURNING publication (rule 7). The cache route does not reach it: it
  materializes through `result/cache-json-codec.ts` `materializeJsonValue` from
  a snapshot that holds the DECODED value, so it cannot run the schema twice.
- **the invocation**: `parse` (`src/validation/index.ts:86`), the estate's one
  owner of "run a caller's Standard Schema safely" — async refused, a throwing
  schema caught, a malformed result refused. The engine is its caller, exactly
  as `write-engine/parse-boundary.ts` is on the admission side. The decoder
  inspects no issue and re-implements no validation.
- **the refusal**: `InvalidScalarResult("json", "custom output schema rejected
  the value")`, which `OperationContext.failure` (`:519-527`) already publishes
  as the restored `QueryEngineError` sentence and `meta`. No new error class and
  no new sentence were invented.

## The change (hunks by file and line)

`src/query-engine/raptor3/shared/query.ts` (+45 / -2; 19 of the added lines are
code, the rest comment):

| line | hunk |
| --- | --- |
| `:23` | `import type { StandardSchemaV1 } from "@standard-schema/spec";` |
| `:55` | `import { parse } from "@validation";` — the same barrel entry `write-engine/parse-boundary.ts:2` and `cache-flow.ts:22` already import; no new cycle (measured below) |
| `:102-108` | `Leaf.jsonSchema?: StandardSchemaV1`, documented beside `enumValues`/`dimension` as a projection of the declaring scalar's state |
| `:943` | `Queries.leaf`: `jsonSchema: state.type === "json" ? state.schema : undefined` |
| `:4520-4525` | `decodeScalar` `case "json"`: `jsonValue(raw)` → `schemaValue` → `jsonValue(output)`, the deleted parser's own order; unchanged when the field declares no schema |
| `:4660-4685` | `Queries.schemaValue(schema, document)`: `parse`, then `InvalidScalarResult("json", "custom output schema rejected the value")` on any failure, and the schema's own value otherwise |

`src/query-engine/raptor3/AGENTS.md` (+17 / -0): the paragraph that owns
decoding (lane Q, "The transport is asked about a value exactly once …") gains
the D-33 sentence — the fact's home on the leaf, the ask-once-per-value order,
`parse` as the invocation owner, the redacted refusal, and the cache route's
prohibition.

`tests/raptor3/g4/parity/json-read-schema.test.ts` (new, 382 lines): registered
by the `extended-local` file walk (`scripts/credential-free-test-manifest.mjs`
`EXTENDED_LOCAL_TESTS`; `tests/raptor3/g4/parity/` is not in
`extendedLocalExclusions`), which is how its four sibling parity pins run.

Nothing else was touched. No policy boolean, no second walker, no per-feature
interpreter, no new class, no adapter capability, no public-contract change.

## The falsifier and its falsification record

Two falsifiers, and they bite on different claims.

**1. The estate cell the ruling was cut from.**
`tests/contracts/public-client/official-cache-swr.core.test.ts:550-551`
(`hostileJsonReadsAtCoreBoundary === 1` and the total equals it): the field's
schema publishes a hostile document whose `version` getter counts reads, and the
driver's `parseResult` middleware snapshots the count taken INSIDE `next`. Green
means the schema ran on read AND the core read its output exactly once — the
prototype-safe rebuild in `jsonValue` reads each member once, and nothing after
the boundary reads it again (the cache snapshot refuses an accessor from its
descriptor, `result/cache-snapshot-structure.ts:59`, without invoking it).

| state | result | receipt |
| --- | --- | --- |
| `e821cd21`, before the change | RED — `expected +0 to be 1` at `:550` | `receipts/d33/baseline-cache-swr.log` |
| after the change | GREEN 7/7 | `receipts/d33/cache-swr-final.log` |

**2. The new registered pin**, `tests/raptor3/g4/parity/json-read-schema.test.ts`
(6 cells): a transforming, idempotent schema (`{ n }` → `{ n, tag }`) on
`findMany`, `findUnique`, `create … select`, an array `$transaction` on a
batch-only transport, and a cached read; exact invocation counts (2 rows = 2
runs, 1 row = 1, an unselected JSON field = 0, cache hit = no further run,
revalidation = one more); a stored document the schema refuses — written behind
the write path's back with raw SQL — raising the restored class, sentence and
`meta`, with the schema's issue text absent.

**Falsification record** (the recorded safe recipe, `cp` to the scratchpad
first, never `git checkout --` a dirty file; the falsified file was restored
byte-for-byte, md5 `a82d56b83f5bc44625d74341a057aba5`, verified after each
round):

| mutation | pin | cache-SWR cell |
| --- | --- | --- |
| revert the reader hunk (`case "json"` → `return this.jsonValue(value)`) | RED 6/6 — `receipts/d33/falsified-pin-final.log` (and `falsified-pin.log` for the earlier draft) | RED — `receipts/d33/falsified-cache-swr.log` |
| ask the schema TWICE per value (`schemaValue(schemaValue(…))`) | RED 4/6 — `receipts/d33/falsified-twice-pin.log` | GREEN — `receipts/d33/falsified-twice-cache-swr.log` |
| restored | GREEN 6/6 — `receipts/d33/pin-restored-final.log` | GREEN 7/7 |

The second row is why the new pin exists beside the cell: the cell counts how
many times the CORE READS the schema's published document (one), which a double
invocation does not change, because each `validate` builds a fresh hostile
object and the outer call never reads the inner one's getter. Only a run counter
on the schema itself can state "exactly once per value", and that is the pin's.

## Verification

`TMPDIR=/private/tmp/viborm-rulings-tmp-d33` exported for every run; one file or
one registered mode per call; no two runs at once; no lock refusal was met and
no lock was removed. Receipts in
`docs/architecture/raptor3-evidence/g4/rulings/receipts/d33/`.

| run | result | receipt |
| --- | --- | --- |
| `official-cache-swr.core.test.ts` (`layer-client`) | 7/7 | `cache-swr-final.log` |
| the new pin (`extended-local`) | 6/6 | `pin-final.log`, `pin-restored-final.log` |
| `g4/parity/driver-result-parser.test.ts` + the new pin | 10/10 | `parity-pins-final.log` |
| `engine/query/parity-decoding.core.test.ts` (`layer-query-engine`) | 9/9 | `parity-decoding.log` |
| `layer-query-engine` (whole) | 642/643, 1 pre-existing red | `layer-query-engine-final.log` |
| `layer-client` (whole) | 536/536 | `layer-client.log` |
| `run-raptor3.mjs g2-baseline` | 216/216, gate verified | `mode-g2-baseline.log` |
| `run-raptor3.mjs g2-contracts` | 216/216, gate verified | `mode-g2-contracts.log` |
| `run-raptor3.mjs cs01-extension-a` | 6/6, gate verified | `mode-cs01-extension-a.log` |
| whole-estate typecheck | **0 diagnostics**, 6.54 s, 5124 MiB peak | `typecheck-final.log` |
| `npx biome check` on the three touched files | no new diagnostic (the new test file is clean; `query.ts`'s diagnostic SET is identical to `e821cd21`'s, line numbers aside) | — |

Two extra runs, beyond the minimum, because they are the estate's only live
reads of a `json().schema(…)` field on a REAL PostgreSQL (PGlite) and a zod
object schema, i.e. the blast radius of this change outside SQLite:

| run | result | receipt |
| --- | --- | --- |
| `public-client/all-field-types.test.ts` (`extended-local`, PGlite) | 8/8, 1442 MiB peak | `all-field-types.log` |
| `public-client/relation-types.test.ts` (`extended-local`, PGlite) | 13/13, 1446 MiB peak | `relation-types.log` |

## Alternatives rejected under the rules

1. **A second walker of the projection to find JSON fields** (e.g. a
   post-decode pass over the published rows, keyed by the model's json fields).
   Rejected: two readers of the same fact, and the prepared projection already
   knows each column's scalar (rule 1). The leaf is where every other physical
   fact of a column already lives.
2. **A policy boolean** (`runOutputSchemas`, or a `decodeScalar` parameter that
   says whether the schema applies). Rejected outright by the brief and by the
   no-patchwork rule; there is nothing to decide — a field either declares a
   schema or it does not, and the leaf says which.
3. **Re-running the field's `state.base` write validator on read** (`v.json({
   nullable, schema })`). Rejected on three counts: it re-walks the whole
   document with `isJsonValue` (a second reader of the JSON value domain the
   decoder owns, and per row), it carries WRITE-position semantics (nullability,
   default, optional) into a read, and it returns the schema's output without
   re-checking the JSON domain — measurably wrong against the cache-SWR cell,
   which needs the output walked exactly once.
4. **Spelling the Standard Schema invocation protocol a fourth time in the
   engine** (`schema["~standard"].validate` + async/throw/malformed handling
   inline, as the deleted `parseJsonValueWithSchema` did). Rejected: `parse`
   already owns it, and the engine is already its caller on the admission side.
   The cost of that reuse is stated as an observable difference below.
5. **`validateSchema` from `validation/primitives/helpers.ts`** instead of
   `parse`. Rejected: it does not catch a schema that THROWS, so a throwing
   schema would leave the decoder as a raw error — precisely what the ruling
   forbids.
6. **Restoring the deleted parser's null-through-schema branch**
   (`scalar-result-parser.ts:291-292` ran the schema for a `null` on a
   NON-nullable json column). Rejected: this engine already answers the SQL NULL
   and the absent column on the RAW value, before any representation rule, and
   that ordering is a registered raptor3 ruling with its own guide paragraph. A
   `null` on a non-nullable `json` column stays "a required scalar is null".

## Observable differences from the engine replaced (for Arnaud, not repaired)

1. **An asynchronous or throwing schema's reason clause.** The deleted codec
   spelled three reasons — "custom output schema validation failed" (validate
   threw), "asynchronous custom output schemas are not supported" (a promise),
   "custom output schema rejected the value" (issues). Reusing `parse` collapses
   all three into the third, so the class, the `meta` and the redaction are
   identical and the reason clause of the first two now reads "custom output
   schema rejected the value". The brief names one class and one sentence — the
   refusal of a refused document — and that one is exact. Restoring the other
   two would mean spelling the invocation protocol in the engine (alternative 4)
   for a sentence no live test in the estate asserts; the deleted assertion
   (`/asynchronous.*not supported/i`) died with its parser at the cutover. If
   Arnaud wants the three sentences back, the right owner is `parse` reporting
   WHICH failure it saw, not the engine re-deciding.
2. **An async schema's dropped promise.** The deleted codec attached
   `.catch(() => undefined)` to the promise it refused. `parse` does not, so an
   async schema's rejection is an unhandled rejection — the estate's existing
   behavior for an async user schema at the admission boundary, unchanged by
   this ruling and identical on both sides of it.
3. **The array-`$transaction` route's normalization.** Inside
   `$transaction([...])` the decoder's refusal escapes into the driver's error
   mapping and is published as `QueryError: Query execution failed`
   (`drivers/error-mapping.ts:384`) instead of the restored sentence. Pinned in
   the new pin WITH a control: a malformed `int` value — a refusal this decoder
   owned long before D-33 — is normalized identically on that route, and the
   same refused document asked as ONE operation on the same transport publishes
   the restored sentence. So the shape belongs to the array route, not to this
   ruling; not repaired (another owner's file, and a public-contract change).

## Still red

1. `tests/contracts/architecture/contract-matrix.core.test.ts` › "inventories
   every executable test by owner and boundary" — pre-existing and unchanged:
   `tests/inventory.ts` classifies no file under `tests/raptor3/`, and the
   assertion fails on the same FIRST file it failed on before this branch
   (`tests/raptor3/candidate-handoff.test.ts`), already recorded in
   `g4/parity/integration-note.md`. This unit's new file joins the ~100 others
   in that set; it cannot change the outcome.

Nothing else was red in anything run.

## Unverified claims

- **Providers other than SQLite and PostgreSQL.** The ruling says "on every
  provider"; the decode boundary is provider-blind (the schema runs after the
  driver/adapter chain, on the decoded document), and PGlite/PostgreSQL is
  covered by the two extra runs above. MySQL and the Docker provider projects
  were not run (Docker is an environment blocker for this unit and campaign
  re-qualification is not run).
- **The `raptor3` project beyond the three registered modes** and the rest of
  `extended-local` (the PGlite-heavy majority) were not run; the brief's minimum
  plus the two PGlite files above is what this unit executed.
- **Cost.** "One schema run per JSON field per row read" is asserted by the
  pin's counters, not by a benchmark; no perf receipt was taken, and none was
  asked for.
- A `json` LIST (`state.array`) carrying a schema is not reachable from the
  public builder (`JsonScalar` exposes no `.array()`), so the member path
  carries `jsonSchema` for consistency but is not exercised.

## Blockers

None that stop the unit; three observable compatibility choices await a
decision — see §Observable differences (D-37: the discarded async promise is
now handled at `parse`, the one sentence kept). No stop rule was met: no minimized failure survived two repairs, no public
contract had to change, no legacy import or fallback was needed, and no semantic
interpretation was duplicated to pass a witness.

## LOC and structure

`git diff --numstat e821cd21 -- src tests`:

    17      0       src/query-engine/raptor3/AGENTS.md
    45      2       src/query-engine/raptor3/shared/query.ts

plus the untracked new pin, `tests/raptor3/g4/parity/json-read-schema.test.ts`,
382 lines (tests and evidence are counted separately from charged LOC).

`node scripts/query-engine-structure.mjs`, before (`e821cd21`'s `query.ts`
restored in place, receipt `structure-before.json`) and after
(`structure-after.json`), for `src/query-engine`:

| metric | before | after | delta |
| --- | --- | --- | --- |
| lines | 18611 | 18654 | +43 |
| tokenLines (parser-owned) | 15446 | 15463 | **+17** |
| functions | 1046 | 1047 | +1 |
| parameters | 1589 | 1591 | +2 |
| branchNodes | 2445 | 2448 | +3 |
| runtimeImportCycleComponents | 1 | 1 | 0 |
| runtimeFilesInCycles | 2 | 2 | 0 |

Incremental charged core: +17 token lines in one already-charged file
(`shared/query.ts`); no new file, no new module, no new import cycle.

## The four §7 questions, against the actual diff

1. **What decision disappeared?** "Has this JSON value's declared schema run,
   and where?" It had no answer; now the projection's leaf carries the schema and
   the single leaf decoder asks it once per value. The write path's admission run
   and the read path's decode run are the same schema reached through the same
   `parse`.
2. **Who consumes it, and could they disagree?** One producer (`Queries.leaf`),
   one reader (`decodeScalar`'s json arm). Live, prepared and batch reads share
   that decoder; the cache route cannot reach it, because it materializes the
   decoded value from its snapshot. There is no second place that could answer
   differently.
3. **What invariant replaces the removed decision?** The JSON value domain is
   `jsonValue`'s, the document's admissibility is the caller's schema's, the
   invocation protocol is `parse`'s, and the refusal is
   `InvalidScalarResult`/`failure`'s one sentence. Each fact has exactly one
   owner and the decoder inspects none of the others' internals.
4. **What falsifies it?** `official-cache-swr.core.test.ts:550` and the six
   cells of `tests/raptor3/g4/parity/json-read-schema.test.ts`; both reddened
   under a reverted reader hunk, and the pin also reddens under a doubled
   invocation (record above).

## D-37 (integrator, after the review; Arnaud's ruling)

Arnaud ruled: catch the discarded promise at `parse`, keep the one sentence.
Change: `src/validation/index.ts` `parse`, the `isPromiseLike` arm —
`result.then(undefined, () => undefined)` before the async refusal, so the
promise a refused async schema returned can no longer surface as an unhandled
rejection; admission and the read path share it, since `parse` is the one
invocation owner. Pin: one cell added to `json-read-schema.test.ts` ("refuses
an async user schema and handles the promise it discards"): a model whose
schema returns a rejecting promise, a raw-stored row, the restored sentence on
`findUnique`, and a `process` `unhandledRejection` listener that stays empty
across two macrotask turns. Falsified: with the handler line removed the cell
is red (`receipts/d33/d37-falsified.log`), restored from a scratchpad copy;
7/7 green after (`d37-pin.log`); typecheck zero (`typecheck-d37.log`). The
two collapsed reason clauses stay collapsed, as ruled.

