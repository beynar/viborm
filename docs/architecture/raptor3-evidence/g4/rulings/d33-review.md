# D-33 review — a `json().schema(…)` field's user schema runs on the read path

Reviewer: independent of the author (Fable). Worktree
`/private/tmp/viborm-rulings-d33`, branch `rulings-d33`, HEAD `e821cd21`,
`TMPDIR=/private/tmp/viborm-rulings-tmp-d33r` exported for every run. Nothing
was committed, staged, reset, stashed or pushed; nothing outside this worktree
was written; `/Users/arnaud/code/viborm` and `/private/tmp/viborm-rulings` were
not touched. Reviewer runs and the falsification record:
`receipts/d33-review/reviewer-runs.md` (+ two raw logs beside it).

## Verdict

**ACCEPT.**

The ruling is restored at one owner, in one file, with the sentence the deleted
parser actually threw; every claim in the note that discriminates was
re-measured here and held, including the two falsifications and the exact
invocation counts. Two low-severity items are recorded below for Arnaud; neither
asks for a code change and neither blocks.

## What was verified, and how

**The fact has one producer.** `Leaf.jsonSchema` (`shared/query.ts:102-108`) is
filled only at `Queries.leaf:943` (`state.type === "json" ? state.schema :
undefined`), which is reached only through `scalarShape:909-921` and is memoized
in `views.leaves` per (model, field) on a `Queries` bound to one adapter — so
`state.schema` is read once per (adapter, model, field), not per row, which is
where `result/ResultParser.ts:721` read it (once per compiled field chain).
Checked that no other `Leaf` is built for a model column: the file's other
`kind: "scalar"` literals are `BOOLEAN_LEAF`, `COUNT_LEAF`, `distanceLeaf`
(`type: "number"`) and the `{ kind: "scalar", name }` prepared-projection
fields, none of which can be a `json` column, and no `Leaf` is constructed
outside `shared/query.ts`. The placement follows the `Leaf` type's own stated
convention — `decimal`, `dateTime`, `enumValues`, `dimension` are already
projections of the declaring scalar's state carried beside `scalar` for lowering
and decoding, with `leaf.scalar` reserved for codec compilation
(`route/client-route.ts:343`) — so this is the established seam, not a new one.
Nothing serializes a `Leaf` or keys a cache from one, so the added member
carries no key-stability risk.

**The fact has one reader.** `decodeScalar`'s `case "json"` (`:4520-4525`) is
the only consumer, and `schemaValue` (`:4683`) is called from nowhere else.
`decodeScalar` is private and reached only through `decodeValue` ←
`decodeProjection` / `decodeQuery` / `decodeRecursive` / `decodeList`, so the
live read, the prepared read, the batch terminal and the three RETURNING
publications share it (`operation-context.ts:919, 1906, 1984, 2061, 2201, 2244,
2398`). `jsonValue` remains the only JSON-value-domain walker in `raptor3`
(`isPlainJsonRecord` has exactly one caller). No second projection walker, no
policy boolean — `leaf.jsonSchema === undefined` is the absence of a declared
fact, not a decision — no new class, no per-feature interpreter, no adapter
capability, no public-contract change.

**The order is the deleted codec's.** `git show
e8114ed9^:src/query-engine/result/scalar-structured-parser.ts:78`
(`parseJsonValueWithSchema`) ran `parseJsonValue(value)` → the schema →
`parseJsonValue(validation.value)`, and the deleted `parseJsonValue` did not
transport-parse a string either, so `jsonValue(raw)` → schema →
`jsonValue(output)` is the same three steps in the same order on the same
inputs.

**The refusal is the restored one.** The deleted `malformedScalarValue`
(`result-parser-contract.ts:83-93`) threw `QueryEngineError` with
`Driver "<provider>" returned a malformed <scalarType> scalar for operation
"<op>": <reason>.` and `meta { driver, operation, scalarType }`; the issues
branch's reason was exactly `custom output schema rejected the value`.
`OperationContext.failure:519-527` builds a character-identical sentence and the
same `meta` from `InvalidScalarResult("json", "custom output schema rejected the
value")`, and the new pin asserts the whole sentence verbatim plus the three
`meta` members. Redaction is preserved: `schemaValue` never reads
`validated.issues[…]`, which is what the deleted
`scalar-result-contracts.core.test.ts` › "redacts custom JSON validation
details" demanded. `parse` (`src/validation/index.ts:86`) is the estate's owner
of the invocation protocol and is already the engine's dependency at
`write-engine/parse-boundary.ts:2`, `cache-flow.ts` and `types.ts`; `parse` is
declared in `index.ts` itself, so the barrel is its only home, and
`src/validation` has no runtime import of `src/query-engine`, so no cycle is
created (`runtimeImportCycleComponents` 1, `runtimeFilesInCycles` 2, both
unchanged).

**The counts, measured here rather than read from the note.** The pin's
assertions are exact equalities on a schema that increments a counter on every
invocation, and it is green: 2 rows = 2 runs, 1 row = 1, an unselected `json`
field = 0, `create … select { id }` = 1 (admission only — which also proves the
produced projection is select-driven and does not decode unselected columns),
`create … select { payload }` = 2, a three-member prepared `$transaction` = 5,
cache miss = 1, cache hit = 1 (no further run), SWR revalidation = 2. The
doubled-invocation falsification reddens 4 of the 6 cells, so those equalities
have teeth.

**Both falsifications reproduce.** Reverting the reader hunk reddens the pin
6/6; asking the schema twice reddens it 4/6 while the cache-SWR cell stays
green, which is exactly why the pin exists beside the cell (the cell counts how
often the core reads the published document, not how often `validate` runs).
The author's file was `cp`-backed-up first and restored byte for byte after each
round, md5 `a82d56b83f5bc44625d74341a057aba5` — the same hash the note records.

**Green, and nothing weakened.** `git diff --stat e821cd21` is two files
(`AGENTS.md` +17/-0, `shared/query.ts` +45/-2) and one untracked new test file
(382 lines); no test was deleted, weakened, `.skip`ped or `.only`d, and no other
file in the tree changed. `run-typecheck.mjs`: 0 diagnostics. `layer-client`
whole: 536/536. `layer-query-engine` whole: 642/643, the one red being the
pre-existing contract-matrix cell, which fails on
`tests/raptor3/candidate-handoff.test.ts` — not on the new file, and it cannot,
since `tests/inventory.ts` classifies nothing under `tests/raptor3/`.
`g2-contracts`: 216/216, gate verified. `parity-decoding.core.test.ts` 9/9,
`driver-result-parser.test.ts` 4/4.

**The blast radius was swept, not sampled.** Seven `extended-local` files touch
a `json().schema(…)` fixture or a `json()` field; the author ran two of them.
The reviewer ran the four the author had not: `select-include-result` 20/20,
`official-cache-reads` 11/11, `brand-token-keys` 4/4, and
`batch-transaction` 67/70 — whose three failures are PRE-EXISTING (verified by
restoring `e821cd21`'s `query.ts` and reproducing them identically; they are
about a batch-only PGlite transaction, with no user schema anywhere near them).
This matters because the shared fixtures declare zod object schemas
(`tests/contracts/public-client/client.ts:19` `pets`,
`tests/fixtures/schema.ts:37-42`, `tests/fixtures/test-models.ts:86-93`) and
zod strips unknown keys, so restoring the read-path run is observable for every
consumer of those fixtures. None regressed.

**Registration is real.** Evaluating `EXTENDED_LOCAL_TESTS` shows the new pin in
the manifest beside its five `tests/raptor3/g4/parity/` siblings, and it imports
`RecordingSQLiteDriver` from `../unit02/world` exactly as four of them do.

**Formatting.** The `biome check` diagnostic set for `shared/query.ts` is
identical to `e821cd21`'s — same seven rules, same counts, 16 entries — measured
by putting the committed copy under a temporary name in the same directory and
deleting it afterwards; and `biome format` emits no hunk touching any line the
ruling added, so the file-level `format` and `organizeImports` entries are
wholly pre-existing. Not applying `organizeImports` is correct here: it is the
recorded hazard for the validation barrel cycle, and the rules forbid
`--write`ing a whole file.

**Structure.** `query-engine-structure.mjs` reproduces the note's "after"
exactly: lines 18654, tokenLines 15463, functions 1047, parameters 1591,
branchNodes 2448, cycles 1/2 — +17 charged token lines in one already-charged
file, no new module.

## Rulings on the alternatives and the rejected shapes

The six rejected alternatives are each rejected for the right reason. Two are
worth confirming explicitly:

- **`validateSchema` instead of `parse`** would indeed have left a throwing
  schema as a raw error, which the ruling forbids. Correct.
- **The deleted null-through-schema branch.** `parseTypedValueDefault` did run
  `parseJsonValueWithSchema(null, …)` for a SQL NULL on a NOT NULL `json`
  column, and with no schema it published `null` on that column. Declining to
  restore that is right: this engine answers the SQL NULL on the RAW value
  before any representation rule, and that ordering is already a registered
  raptor3 ruling with its own guide sentence (`AGENTS.md:857-860`). A NULLABLE
  `json` column holding NULL skips the schema on both sides, so there is no
  divergence there.

A `json` LIST carrying a schema is confirmed unreachable: `JsonScalar`
(`src/schema/scalars/json/scalar.ts`) exposes only `nullable`, `default`,
`schema` and `map`. The member `Leaf` that `decodeList` derives does carry
`jsonSchema`, which is the consistent answer for a shape that cannot be built.

## Findings (neither blocks)

1. **LOW — the note says `Blockers: None` while recording three observable
   compatibility choices.** The common brief routes "a new observable
   compatibility choice" to the note's blocker list, because that is where
   Arnaud reads for decisions; the note instead puts all three in a section of
   their own ("Observable differences from the engine replaced (for Arnaud, not
   repaired)"). The substance is complete and better organised there — the
   reviewer is not asking for it to be moved. Minimal resolution, if Arnaud
   wants the convention held: one line under `## Blockers` reading "None that
   stop the unit; three observable compatibility choices await a decision —
   see §Observable differences." Documentation only.

2. **LOW / for decision — an async user schema's dropped promise is now
   reachable from the read path.** `parse` returns its async refusal without
   attaching a handler to the promise it discarded, where the deleted codec
   attached `.catch(() => undefined)` for exactly that reason; an async schema
   whose promise rejects is therefore an unhandled rejection, which Node's
   default mode treats as fatal. The reviewer agrees with the author on both
   counts: the behaviour is `parse`'s and already lives on the admission side,
   and the owner of a fix is `parse` (which would also be the right owner for
   restoring the two lost reason clauses, by reporting WHICH failure it saw),
   not the engine — spelling the protocol a fourth time inside `decodeScalar`
   would be the patchwork the rules forbid. Recorded so the decision is
   Arnaud's, not the unit's. The exposure is narrow: an async schema is refused
   at admission, so reaching a read needs data written before the schema was
   declared, or raw SQL.

Two further notes, not findings:

- The reason clause for an async or throwing schema collapsing into "custom
  output schema rejected the value" is within the brief as written — it names
  one class and one sentence, the refusal of a refused DOCUMENT, and that one is
  exact to the character. The two lost clauses had one test
  (`/asynchronous.*not supported/i`), deleted with its parser at the cutover, so
  no registered refusal was weakened here.
- The array-`$transaction` normalisation (`QueryError: Query execution failed`)
  is proven to belong to that route, not to this ruling, by the pin's `int`
  control and by the same document publishing the restored sentence as one
  operation on the same transport. That is the right evidence and the right
  place to stop.

## Unverified by the reviewer

- MySQL and the Docker provider projects (an environment blocker for this unit),
  and the rest of `extended-local` outside the seven files that touch a
  `json()` field. The decode boundary is provider-blind and PGlite/PostgreSQL is
  covered, so the residual risk is the note's stated one.
- The `g2-baseline` and `cs01-extension-a` modes were not re-run by the reviewer
  (the author's receipts stand, and `g2-contracts` was re-run green): no
  `tests/raptor3` corpus declares a `json().schema(…)` field, so those modes
  cannot discriminate this change beyond the generic regression that
  `layer-query-engine` and `layer-client` already cover.
- Cost. "One schema run per JSON field per row read" is established by the pin's
  counters, not by a benchmark; no perf receipt was taken or asked for.
- Non-idempotent transforming schemas drift between the admission run and the
  read run. This is parity with the engine replaced (which also validated at
  admission and again on every read), the pin's schema is deliberately
  idempotent and says so, and no cell in the estate exercises a non-idempotent
  one.
