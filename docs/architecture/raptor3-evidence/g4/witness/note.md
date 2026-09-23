# G4 independent witnesses (C01/C12/C13) — unit note

Author: independent witness stream. Opened 2026-09-14. Working tree
`/Users/arnaud/code/viborm`, branch `pattern-engine`, opening identity
`0cc61e61` (G4 opening record).

This note is the decision-elimination gate for this unit and the running
record of coverage, oracle design, disputed rows, blockers and unverified
claims. §§0–7 were written **before** the first file edit; §§8–12 were filled
in as each command ran.

## 0. Role boundary

This stream writes no candidate production code. It writes witnesses,
oracles, a generated read campaign, native lanes, and the harness
registration that binds them. Expected behavior comes only from:

- the shipped public contracts (`tests/contracts/**` cited per inventory row),
- values computed by hand or by an independent JavaScript oracle over rows the
  witness itself seeded,
- the **shipped** client executing the same request against the **same**
  SQLite database (differential oracle).

Candidate source was read only to classify a witness red/green and to describe
the handoff. No expectation in any witness is copied from
`src/query-engine/raptor3/**`.

## 1. Decision-elimination gate

### Required behavior

1. **Witness coverage.** Every inventory row this unit owns (OP-R01–R09,
   Q-W01–W10, Q-O01–O04, Q-P01–P03, Q-S01–S03, Q-A01–A02, Q-R01, the read
   crossings of SC-01–SC-14 and SL-01–SL-10, the C13 lifecycle falsifiers)
   has an executable witness whose expected value is independent of the
   candidate, and whose status is recorded with a receipt.
2. **Registration.** Each witness file is reachable through exactly one
   registered mode with an exact expected test count, is excluded from
   ordinary credential-free discovery, and cannot silently lose cells.

### Current owner (before this unit)

- Witness/oracle facts: none; `tests/raptor3/g4/` did not exist.
- Registration facts: `scripts/raptor3-manifest.mjs` owns
  mode → files → counts → campaign constants → receipt assertions;
  `scripts/run-raptor3.mjs` owns the mode list, file map, count map, provider
  environment and campaign child loop; `scripts/credential-free-test-manifest.mjs`
  and `vitest.workspace.ts` consume the manifest's exported file lists;
  `scripts/raptor3-campaign-receipts.test.mjs` and `scripts/raptor3-cli.test.mjs`
  falsify the registration.

### Smallest change made

- Witness files under `tests/raptor3/g4/` (fixed read families, lifecycle
  falsifiers, `generation/`, `native/`) plus four non-test helper modules.
- `raptor3-manifest.mjs`: only *data* — one `…_COUNTS` constant per suite with
  its `…_TESTS` key projection, two campaign constants, two receipt
  assertions sharing one shape check.
- `run-raptor3.mjs`: only *entries* — mode names, files map, expectedCounts
  map, provider regex, campaign selector, corpus-archive branch, and one
  optional `replayCommand` parameter on the existing archive helper.
- `credential-free-test-manifest.mjs` and `vitest.workspace.ts`: additive
  spreads of the same exported constants (see §7).

### Decisions that disappear

| Decision eliminated | Mechanism | Consumers | Replacing invariant | Falsifier |
| --- | --- | --- | --- | --- |
| "What does this read return?" answered separately in every witness | `expectRead` in `witness-world.ts`: one hand value, checked against the **shipped** engine before the candidate is consulted | all 62 fixed read cells | One expected value per row, produced twice by independent producers; a shipped/hand disagreement is a *disputed row*, never a re-baseline | Change a hand value: the shipped assertion fails first, before the candidate is reached (observed six times, §6) |
| "Which files does mode X run and how many tests must it hold?" restated in the runner, the workspace, the credential-free manifest and the receipts test | One exported `…_COUNTS` object per suite; every other consumer derives files from `Object.keys` | runner, workspace, credential-free manifest, receipts self-test, CLI test | One authority per (mode, file, count) fact | Add a test to a registered file without bumping its count: the mode fails with "Missing candidate/profile/scenario cell" (and the receipts self-test pins the 62-cell total) |
| "Is this seed in range and did the child really do the work?" re-derived per call site | `assertG4BatchShape` + the two subject-specific wrappers | campaign child tests, runner, receipts self-test | The child receipt is the only admissible proof of a batch, and only a `candidate`-subject receipt can qualify | `raptor3-campaign-receipts.test.mjs` hands it a stale identity, a shifted seed, a missing cell, a non-zero skip, an injected fault and a `shipped` subject; each must throw (all six observed) |
| "What is the expected value of a generated read?" answered by executing SQL | `generation/oracle.ts` evaluates filter → order → distinct → cursor → window → projection/aggregate over the in-memory seeded rows | generated campaign | The oracle is a second, textually independent implementation reading the same recipe | Mutate the oracle's copy of the world: the campaign self-test requires the answer to change (and a 100-seed shipped-subject child proves the oracle agrees with the shipped engine on 200 cells) |

### The four §7 questions, answered against the actual diff

1. **Necessary decision or representation repair?** Every rule added here
   expresses a shipped public contract or a real boundary (the workspace lock,
   the provider capability tiers, the credential-free lane). Two duplicated
   authorities were *removed* rather than synchronized: the per-witness
   expectation (replaced by one hand value checked twice) and the per-call-site
   receipt validation (replaced by one shape check).
2. **Exact deletion and replacement obligation?** This unit adds new evidence;
   it deletes no production decision. Inside the harness it removes one
   duplication it would otherwise have created: `archiveG3GeneratedCorpus`
   gained an optional `replayCommand` instead of a second G4 archive function,
   so both lanes keep one compress/verify/rename/receipt mechanism. Falsifier:
   the existing receipts self-test still pins the G3 default spelling, and the
   G4 archive receipt carries its own working command (§8, and since the
   repair a receipts self-test pins both spellings — see §13, finding 5).
3. **One rule across uses?** The same `expectRead` runs the same operator in
   three positions (root `where`, nested relation `where`, `having`); the same
   receipt shape check serves both campaign lanes and both subjects; the same
   lifecycle oracle runs against the shipped route and the candidate route in
   one test. The generated campaign runs the same recipe on four transport
   profiles — four distinct read-transport models since the repair, see §4 —
   and requires one answer.
4. **What actually grew?** Incremental **core charged LOC: 0. Complete charged
   LOC: 0.** No file inside the charged perimeter was edited: the G3
   `qualified-final/support/source-cost.json` file list contains only `src/**`
   entries, and this unit edited none of them (verified by intersecting the
   charged file list with this unit's diff). Tests and harness are counted
   separately: **6,354** physical lines under `tests/raptor3/g4/` owned by this
   unit (excluding the G4-03 `route-*` files and the review stream's
   `review/` subtree), plus **955 added / 19 removed** lines across the six
   registration files (both re-measured after the repair; the pre-repair note
   said 5,643 and 684/12, which was already stale when the review measured
   5,711 and 688/12). The whole-`src` census taken at
   the end of this unit (`receipts/query-engine-structure.json`) reports
   `queryEngine` 181 files / 82,830 lines / 65,901 token-lines; that total is
   **not attributable to this unit** — two other streams were editing `src/`
   concurrently.

## 2. Coverage matrix

Status is from `repair/g4-fixed-witnesses.repair3.json` (75 cells, 34 green,
41 red — 62 read cells at 24 green / 38 red, 3 lifecycle-events at 1/2,
4 lifecycle-admission at 3/1, and the 6 generation self-tests all green). "Red" here
is the intended handoff evidence: the contract is stated correctly, the shipped
engine agrees with it, and the candidate does not yet. The pre-repair figure
was 68 cells / 28 green / 40 red; §13 lists the six cells the repair added and
the one of them that is red.

### Family A — root read envelopes (`read-operations.test.ts`, 11 cells)

| Row | Witness | Status | Why |
| --- | --- | --- | --- |
| NS-01 crossing | pins the physical layout | green | mapped names, junction columns `author_1/author_2/tagId`, variant junctions `board/item` |
| OP-R01 | findUnique on a mapped compound key + competing row + absence | green | |
| OP-R01 / Q-W02 | extended unique `where` keeps its discriminator; a discriminator-free selector is refused | green | refusal is shared admission |
| OP-R02 | findUniqueOrThrow → `NotFoundError` "No author record found for findUniqueOrThrow" | **red** | `Raptor 3 G1 operation is not implemented: findUniqueOrThrow` |
| OP-R03 | findFirst ordered / skipped / absent | **red** | verb not implemented |
| OP-R04 | findFirstOrThrow refusal identity | **red** | verb not implemented |
| OP-R05 | filter + order + skip/take before projection; fresh array and fresh rows | green | |
| OP-R06 | count number and selected scalar-count object | **red** | verb not implemented |
| OP-R07 | exist boolean | **red** | verb not implemented |
| OP-R08 | aggregate `_count/_sum/_min/_max/_avg` | **red** | verb not implemented |
| OP-R09 | groupBy values + having + group order | **red** | candidate publishes `_count: 3` where the contract is `_count: { _all: 3 }` |

### Family B predicates (`read-filters.test.ts`, 13 cells)

| Row | Status | Why |
| --- | --- | --- |
| Q-W01 recursive AND/OR/NOT | green | |
| Q-W01 field-reference scope inside a nested relation predicate | green | |
| Q-W02 strict-unique cursor + refusal | **red** | the candidate ignores `cursor` (returned ids 1,2 where the contract is 2,3) |
| Q-W03 equals/in/notIn/ranges/nested not/field ref/NULL-vs-notIn | **red** | `Raptor 3 G1 filter is not implemented: notIn` |
| Q-W04 contains/startsWith/endsWith, `%`/`_`/`\` literals, `mode` | **red** | `filter is not implemented: contains` |
| Q-W08 to-one shorthand, `is`, `isNot`, real nullability | green | |
| Q-W09 some/every/none on an FK collection and on a junction | green | |
| Q-W10 tagged variant collection quantifiers | **red** | `TypeError: Cannot read properties of undefined (reading 'variant')` in `buildMembershipView` — a raw TypeError, not a refusal |
| Q-W05 scalar membership vs list containment | **red** | `filter is not implemented: has` |
| Q-W06 JSON path/comparison/nested not | **red** | `filter is not implemented: path` |
| Q-W04 non-ASCII under `mode: "insensitive"` (added by the repair) | **red** | `filter is not implemented: contains`; the shipped engine agrees that SQLite folds ASCII only, so `"école"` finds nothing while `"École"` and `"ADA"` do |
| Q-W03 nullable column partitioned at the NULL (added by the repair) | green | `bio: null` and `bio: { not: null }` cover the world and admit no row from the other side |
| Q-W05 list container on a scalar column refused (added by the repair) | green | both engines raise `ValidationError`; it moved out of the red Q-W05 cell so it is actually reached |

### Family B ordering (`read-ordering.test.ts`, 5 cells)

| Row | Status | Why |
| --- | --- | --- |
| Q-O01 asc/desc | green | |
| Q-O01 `{ sort, nulls }` first/last | **red** | `scalar codec is not implemented: number` — `s.number()` is outside the candidate's four decodable domains |
| Q-O03 to-one relation ordering, 8-hop cap, to-many refusal (RF-07) | **red** | `physical field is not implemented: author` |
| Q-O04 collection `{ _count }` ordering, ordinary and variant | **red** | `physical field is not implemented: posts` |
| Q-O02 distance ordering refusal parity | **red** | shipped raises `FeatureNotSupportedError`; the candidate does not reach the same refusal |

### Family B paging (`read-pagination.test.ts`, 6 cells)

| Row | Status | Why |
| --- | --- | --- |
| Q-P01 cursor + take + skip | **red** | cursor ignored |
| Q-P01 negative take restores the logical order | **red** | window ignored |
| Q-P02 distinct before take/skip | **red** | distinct ignored |
| Q-P03 nested window per parent | green | |
| Q-P03 nested where/skip/cursor/omit per parent | **red** | nested cursor ignored |
| Q-P03 junction collection shared by two parents (added by the repair) | green | tag 2 belongs to both `acme/ada` and `acme/bob`; both `take: 1` and `skip: 1, take: 1` are per parent |

### Family B shapes (`read-projection.test.ts`, 7 cells)

| Row | Status | Why |
| --- | --- | --- |
| Q-S01 select/include shapes and mutual-exclusion refusal | green | |
| Q-S01 both to-one orientations + junction + self-relation both directions | green | |
| Q-S02 `_count: true` and per-collection filtered `_count` | **red** | `physical field is not implemented: _count` |
| Q-S03 `{ only, variants }` arms, arm-local order, cardinality | green | |
| Q-S03 unknown arm refused | green | |
| Q-S01 schema default omit | green | a schema `.omit()` field is hidden *and* unselectable (`Unknown key: secret`) |
| Q-S01 collection stitched with the mapped compound key unselected (added by the repair) | green | the stitch identity is prepared without leaking back into the published row |

### Family B aggregates and results (`read-aggregates.test.ts`, 5 cells)

| Row | Status | Why |
| --- | --- | --- |
| Q-A01 `_avg`/`_sum` numeric restriction + refusals | **red** | the candidate decodes `_avg` of an `int` column through the **int** codec and refuses a fractional mean |
| Q-A02 valid `by` + scalar and aggregate `having` with AND/OR/NOT | **red** | `physical field is not implemented: AND` — `having` has no boolean composition |
| Q-A02 group order by a grouped field and by an aggregate | **red** | `_count` shape again |
| Q-R01 fresh relation and aggregate carriers | **red** | `_count` unsupported |
| Q-R01 malformed provider row keeps a public error identity | green | both engines raise `QueryEngineError` |

### Family D codecs (`read-codecs.test.ts`, 12 cells)

| Row | Status | Why |
| --- | --- | --- |
| physical spelling pin (decimal coefficient `123456001`, `13:45:30`, `["alpha","beta"]`, real blob bytes) | green | |
| SC-01…SC-12 + SL-01…SL-10 round trip | **red** | `scalar codec is not implemented: boolean` (then bigint, DateTime, date, time, enum, json, blob and every list form) |
| SC-06/SL-06 exact decimal domain and fresh values | **red** | `scalar codec is not implemented: decimal[]` |
| SC-11 DbNull / JsonNull / AnyNull partition + path | **red** | `filter is not implemented: kind` |
| SC-12 fresh `Uint8Array` per read | **red** | `scalar codec is not implemented: blob` |
| SL-* list container predicates | **red** | `filter is not implemented: has` |
| SL-06 / RF-05 decimal-list ordering and aggregation refused | green | shared admission refusal |
| Q-R01 malformed provider row at the decode boundary | green | both raise `QueryEngineError` |
| point column physical pin | green | SQLite stores `{"longitude":…,"latitude":…}` |
| SC-14 point round trip + `within` | **red** | `scalar codec is not implemented: point` |
| Q-W07 metre-distance tier refusal parity | **red** | shipped raises `FeatureNotSupportedError`; candidate does not |
| SC-13 vector capability refusal parity | **red** | shipped raises `QueryError`; the candidate raises a bare `Error` |

### RF-16 recursive fit (`read-recursive-fit.test.ts`, 3 cells)

All three **red** at `Queries.recursive` → `columnName`: the private
recursive fit accepts only the four decodable scalar domains, so the fuller
codec set (DateTime, decimal, bigint, enum, JSON, list) over a mapped compound
identity path does not lower. `tests/raptor3/prep/recursive-read-fit.test.ts`
is untouched.

### C13 lifecycle falsifiers (7 cells)

| Falsifier | Status | Finding |
| --- | --- | --- |
| missing-event (`lifecycle-events`) | **red** | the candidate route loses a required lifecycle unit; the same oracle sees a complete set on the shipped route, and the crippled recorder proves the oracle can fail |
| observer-failure-isolation | green | a throwing observer changes neither route's result |
| statement observation | **red** | "the candidate route published no statement unit" |
| double-admission (`lifecycle-admission`) | green | one awaited `PendingOperation` admits once on both routes; two operations admit twice |
| double-transform | green | the request transform runs exactly once on both routes |
| cache-bypass | **red** | the candidate section now runs the same three statement-count assertions as the shipped section; it reaches none of them yet because `$withCache` raises `UnsupportedOperationError: The Raptor 3 route cannot encode a cached result for 'findMany' … publishes no prepared read shape (g4/unit03/note.md B-1)` |
| cache-bypass self-falsification (added by the repair) | green | the same oracle rejects a stand-in route that always serves a stale cached row, inside a transaction included |

### Native lanes — blocked

`tests/raptor3/g4/native/read-envelope-native.test.ts` (4 cells) claims the
native codec round trip (bigInt, decimal, dateTime, date, time, enum, JSON and
blob, all seeded as real native values and all projected), string-mode
collation, `nulls` ordering, cursor pagination, the `_count`/aggregate shapes
and the private `Queries.recursive` fit lowered to one native statement.
**Blocked and unexecuted**: see §12.1, which also names what this file does
*not* claim and why.

## 3. Oracle design

Three producers, in this precedence:

1. **Hand value** — the witness states the exact expected public result,
   derived from the cited shipped contract and the rows it seeded.
2. **Shipped differential** — the same request through
   `createClient({ schema, driver })` on the *same* `better-sqlite3` database
   and the *same* driver instance. The witness asserts the shipped result
   equals the hand value **first**. A disagreement is a disputed row and fails
   before the candidate is consulted.
3. **Candidate** — `createCommandEngine({ schema, driver }).execute(...)`.

Seeding. The relation world (`read-schema.ts`) is seeded with **raw SQL**, so
no write path can manufacture a read expectation; it carries competing rows
(`beta/ada` shares a handle with `acme/ada`), an orphan post, an empty
collection and junction memberships that must stay untouched. The codec world
(`codec-schema.ts`) is written through the **shipped client**, because the
physical spelling of a DateTime, a decimal or a JSON list is exactly what
SC-01…SL-10 are about and hand-writing it would assert this stream's guess;
the physical row is pinned separately with raw SQL so the storage shape stays
visible and the hand value stays the *public* value.

Scalar identity is asserted on the public value: `Decimal` by
`canonicalizeDecimal` plus `instanceof`, `Date` by `toISOString` plus
`instanceof`, `bigint` by `typeof` and value, blob by `Uint8Array` identity and
byte equality (the public blob type is `Uint8Array`, **not** `Buffer`),
`time` as a string, JSON nulls through the three exported sentinels, and
freshness by `!==` between two calls.

## 4. Campaign design and measured cost

`tests/raptor3/g4/generation/` — five modules:

- `world.ts` — three seeded schema families (scalar-rich codec model; a
  relation family with to-one, to-many, junction, variant and self-relation
  edges; a mapped compound-key family) and the four transport profiles.
- `recipe.ts` — the deterministic recipe (zod `strictObject`), its public
  schema, and `buildRequest`.
- `oracle.ts` — the independent JavaScript evaluation of the same recipe.
- `campaign.ts` — cell verification, exact replay, progress/receipt/corpus.
- `harness.selftest.test.ts` — generation, coverage, replay, oracle
  falsification, **transport-model distinguishability** and receipt refusal
  (6 cells, **all green**).

Frozen ranges (from `g4.md`): SQLite lane seeds **20000–44999**
(`sqlite-interactive`, `sqlite-atomic-batch`); transport lane seeds
**50000–74999** (`scripted-returning-weak`, `scripted-returning-ack`). Batch
size 100, replay count 3, 250 children per lane.

**The four profiles are four read-transport models.** `supportsBatch`,
`supportsTransactions` and `supportsOrderedCommittedSegments` — the
declarations that separate these four names in `tests/raptor3/profiles.ts` —
are consumed by the write engine and by migration planning; no read path reads
one. Each profile therefore differs in what its transport actually DOES to a
read, and every cell records the model the transport exhibited:

| Profile | Model | What the transport does to a read | Observation |
| --- | --- | --- | --- |
| `sqlite-interactive` | `interactive-session` | one statement on the live connection, rows borrowed | statements `[SELECT]`, envelope borrowed, `rowCount = rows` |
| `sqlite-atomic-batch` | `atomic-submission` | no interactive session: each read is its own atomic unit, real `BEGIN`/`COMMIT` on the connection | statements `[BEGIN, SELECT, COMMIT]` — measured: every atomic cell reports `statements % 3 === 0` |
| `scripted-returning-weak` | `detached-returning` | weak returning envelope: frozen detached row copies the caller owns, no row-count acknowledgement | envelope `detached`, `rowCount = 0` |
| `scripted-returning-ack` | `acknowledged-returning` | declares `supportsOrderedCommittedSegments` (the G3 `ScriptedTransport` spelling) and performs it: the statement is acknowledged in its own awaited turn before the rows are handed over for decoding | envelope `acknowledged`, borrowed rows, exact `rowCount` |

The transport model applies once the world is **sealed**, i.e. after seeding:
seeding is the shipped client's write path and is not this campaign's subject.
The expectation `profile → model` lives once, in `raptor3-manifest.mjs`
(`G4_TRANSPORT_MODELS`); `world.ts` reports only what its transport did, and
`assertG4BatchShape` compares the two. Two falsifiers: the generation
self-test requires four pairwise-distinct physical observations for one
published value, and the receipt self-test rejects a cell whose transport is
another profile's model, or an atomic cell that did not wrap its statement.

Honest limit, so the cost is not overstated: for a READ the SQLite lane's two
profiles differ in the SQL stream, while the transport lane's two differ only
in the returned envelope — the SQL a read submits cannot differ between them,
because both lanes execute the same adapter against real SQLite. The transport
lane's power is over the decode boundary (detached and frozen rows, a
`rowCount` a reader must not trust), not over statement shape.

Contract rotation is `["Q-W","Q-O","Q-P","Q-S","Q-A"][(seed - firstSeed) % 5]`
and is re-derived by the receipt assertion, so a changed generator fails the
receipt. `Q-S` is always the relation family and `Q-A` always the codec family.

**Subjects.** `candidate` is the claim. `shipped` runs the identical worlds,
requests, oracle and replays against the shipped engine; that is how the
oracle itself is validated and how a complete child's cost is measured while
the candidate is red. `assertG4GeneratedBatchReceipt` requires
`subject: "candidate"`, `qualifying: true`, `status: "complete"`;
`assertG4OracleValidationReceipt` requires `subject: "shipped"`,
`qualifying: false`, `status: "oracle-validation"`. A shipped-subject receipt
can never qualify.

**No injected faults or peer actors.** A read publishes no effect for a peer
to observe, so this campaign's per-cell quota is an exact `actors: 1`,
`faults: 0`, asserted by the receipt: a recipe that silently began injecting
would break it. `_avg` is deliberately outside the generated aggregate
vocabulary, because a provider-rounded mean would pin a driver artifact rather
than a contract (see the Q-A01 fixed witness, which chooses an exact window).

### Measured child cost

Re-measured after the repair (the atomic profile now executes three statements
per read, so the pre-repair figures below it are superseded):

| Child | Cells | Replays | Wall (bounded runner) | Peak RSS | Raw corpus | gzip corpus | Campaign receipt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `g4-seed-batch 20000 --subject=shipped` | 200 | 600 | **5.12 s** (test body 1.12 s) | 721.0 MiB | 337,999 B | **11,915 B** | 49,276 B |
| `g4-transport-seed-batch 50000 --subject=shipped` | 200 | 600 | **5.03 s** (test body 1.17 s) | 726.3 MiB | 324,199 B | **10,907 B** | 50,466 B |
| `g4-seed-batch 20000` (subject `candidate`, the default) | 0 completed | — | ~3 s to first divergence | — | — | — | failure evidence only |

Pre-repair, for comparison: 5.36 s / 719.1 MiB and 5.68 s / 720.8 MiB with
41,076 B and 41,866 B receipts. The receipts grew because every cell now carries
its observed transport model.

The 120-second child limit holds with a factor of ~23 in hand. Both children
ran under the runner's own `--wall-limit-ms=120000`, `--heap-limit-mb=768`,
`--rss-limit-mb=1536` bounds with teardown verified.

### Disk projection, 250 children per lane

Per child, retained: gzip corpus + archive receipt + campaign receipt + attempt,
verified and vitest receipts + the runner log = **64,590 B** (SQLite lane) and
**64,821 B** (transport lane), both measured on the retained directories under
`receipts/`. For 250 children per lane:

- SQLite lane ≈ **15.4 MB**; transport lane ≈ **15.5 MB**; **≈ 30.9 MB total**.
- If raw corpora were retained instead: ≈ 166 MB. The parent archives each
  child before the next one starts, so the transient raw peak is one child's
  corpus (≈ 330 KB).
- Against the 21 GiB free recorded at G4 opening this is ~0.15%.

## 5. Registration table

| Mode | Files | Expected cells | Current |
| --- | --- | --- | --- |
| `g4-read-contracts` | all eight fixed read files | 62 | red (24 green / 38 red across the read families) |
| `g4-read-operations` | `read-operations.test.ts` | 11 | red |
| `g4-read-filters` | `read-filters.test.ts` | 13 | red |
| `g4-read-ordering` | `read-ordering.test.ts` | 5 | red |
| `g4-read-pagination` | `read-pagination.test.ts` | 6 | red |
| `g4-read-projection` | `read-projection.test.ts` | 7 | red |
| `g4-read-aggregates` | `read-aggregates.test.ts` | 5 | red |
| `g4-read-codecs` | `read-codecs.test.ts` | 12 | red |
| `g4-read-recursive-fit` | `read-recursive-fit.test.ts` | 3 | red |
| `g4-lifecycle-events` | `lifecycle-events.test.ts` | 3 | red |
| `g4-lifecycle-admission` | `lifecycle-admission.test.ts` | 4 | red |
| `g4-route-lifecycle` | `route-lifecycle.test.ts` (G4-03) | 7 | owned by G4-03 |
| `g4-route-transactions` | `route-transactions.test.ts` (G4-03) | 8 | owned by G4-03 |
| `g4-route-cache` | `route-cache.test.ts` (G4-03) | 6 | owned by G4-03 |
| `g4-route-admission` | `route-admission.test.ts` (G4-03) | 5 | owned by G4-03 |
| `g4-generation-selftests` | `generation/harness.selftest.test.ts` | 6 | **green** |
| `g4-seeds [--subject=…]` / `g4-seed-batch <first> [--subject=…]` | `generation/sqlite-campaign.test.ts` | 1 | green at `--subject=shipped`, red at the default `candidate` |
| `g4-transport-seeds [--subject=…]` / `g4-transport-seed-batch <first> [--subject=…]` | `generation/transport-campaign.test.ts` | 1 | green at `--subject=shipped` |
| `g4-read-envelope-pg-contracts` | `native/read-envelope-native.test.ts` | 4 | **blocked** |
| `g4-read-envelope-mysql-contracts` | `native/read-envelope-native.test.ts` | 4 | **blocked** |

The four route counts match the table G4-03 published in
`g4/unit03/note.md` §"Registration requests" (7 / 8 / 6 / 5).

## 6. Disputed rows

**None.** Every shipped/hand disagreement observed during construction was a
hand-value error of this stream's, corrected after re-reading the cited
contract — which is exactly what the differential oracle is for. The six
corrections, recorded so the review can see the oracle working:

1. `_count: true` counts **collections only**; the to-one `profile` slot is not
   a countable member.
2. A schema-level `.omit()` field is not merely hidden: it is **unselectable**
   (`select: { secret: true }` → `Unknown key: secret`), so `omit: { x: false }`
   cannot un-hide it either.
3. SQLite's `AVG` over three integers returns a 15-significant-digit double
   (`11.6666666666667`); the witness now chooses a window whose mean is exact
   rather than pinning a driver artifact.
4. A decimal list member canonicalizes to `1.2`, not `1.200`.
5. SQLite stores a decimal as its **unscaled coefficient**, and
   `better-sqlite3` returns it as a JavaScript **number** (`123456001`), not a
   string.
6. GeoPoint's metre-distance tier is refused on SQLite with
   `FeatureNotSupportedError`, not `ValidationError`; the `within` bounds tier
   is supported. The positive distance rows therefore moved to the native lane
   and SQLite keeps a refusal-parity witness.

Two candidate behaviors are recorded as **findings for G4-01/G4-02**, not
disputes, because the shipped contract is unambiguous:

- A variant collection quantifier raises a bare `TypeError` inside
  `buildMembershipView` rather than any public error identity.
- A vector column on a provider without the tier raises a bare `Error` from
  the candidate where the shipped engine raises `QueryError`.

## 7. Harness edits outside the four named files

Two files outside this unit's named list were edited, additively, because
registration is not complete without them and no other G4 stream owns them:

- `scripts/credential-free-test-manifest.mjs` — every G4 suite is added to
  `extendedLocalExclusions`. Its `EXTENDED_LOCAL_TESTS` is built by walking
  `tests/**`, so a deliberately red `tests/raptor3/g4/*.test.ts` would
  otherwise enter the credential-free lane and break `test:all` for every other
  stream. No G4 suite is added to `RAPTOR3_FIXED_LOCAL_TESTS`: they are red,
  and the private guide's rule is that the Raptor fixed stage lists *supported*
  local suites. Promotion is therefore an explicit decision, pinned by the new
  receipts self-test.
- `vitest.workspace.ts` — the `raptor3` project gains the fixed and generation
  suites and `raptor3-live-provider` gains the native suite, otherwise a
  registered mode selects a file no project includes and runs zero tests.

Both edits are spreads of the manifest's new exported constants and change no
existing entry. Exact revert: remove the `G4_*` spreads from those two files
and the `G4_*` entries from `raptor3-campaign-receipts.test.mjs`.

A third, one-line edit to `credential-free-test-manifest.mjs` was made on
behalf of the review stream: the four untracked
`tests/raptor3/g4/review/unit03/*.review.test.ts` files created during this
milestone were being adopted into `EXTENDED_LOCAL_TESTS` by the same file
walk, which breaks `test:all`. `tests/raptor3/g4/review/` now joins
`tests/package/` and `tests/providers/` as a directory the walk skips. This is
not a substitute for a stage selector — that subtree holds no lane suite and no
registered Raptor mode at all. If the review stream wants those suites in a
lane, they should be registered in the manifest like every other suite.

One further harness change, inside a file this unit owns:
`archiveG3GeneratedCorpus(directory, replayCommand?)` gained an optional
second parameter. Without it the G4 archive receipt would carry the G0/G3
`replay <corpus.json>` command, which does not reproduce a G4 read child. The
default is unchanged, so G3's receipt and its self-test are byte-identical.

## 8. Run receipts

All under `docs/architecture/raptor3-evidence/g4/witness/receipts/`.

| Receipt | What it records |
| --- | --- |
| `g4-fixed-witnesses.attempt3.json` / `.log` | the pre-repair 68-cell fixed run: 28 passed, 40 failed, 7.41 s wall, 761.5 MiB peak RSS. Superseded by `repair/g4-fixed-witnesses.repair3.json` (75 cells, 34/41); kept, not relabelled |
| `g4-fixed-witnesses.attempt2.json` / `.log` | the same 28/40 split before three unused helpers were removed |
| `g4-fixed-witnesses.attempt1.json` / `.log` | the earlier attempt, kept: it is the run that exposed the recursive-fit seeding error |
| `campaign-receipts-selftest-attempt1.log` … `-attempt3.log` | `raptor3-campaign-receipts.test.mjs`: 37/37 pass on every attempt; final 0.44 s wall, 63.2 MiB peak RSS |
| `raptor3-cli-selftest-attempt2.log` | `raptor3-cli.test.mjs`: 8/8 pass, 286.10 s, 203.5 MiB |
| `raptor3-cli-selftest-attempt1-identity-drift.log` | the failed first attempt, kept: concurrent `src/` edits changed the production fingerprint mid-run (§12) |
| `g4-seed-batch-20000-shipped/` | the 100-seed SQLite oracle-validation child: receipt, archive receipt, runner log |
| `g4-transport-seed-batch-50000-shipped/` | the 100-seed transport oracle-validation child |
| `g4-seed-batch-20000-candidate-red/` | the candidate-subject child: `generated-failure-0.json` with the exact first divergence |
| `native/*.log` | four native attempts (two modes × no-port and port), see §12 |
| `query-engine-structure.json` | the end-of-unit census |
| `typecheck-final.log` | the closing whole-estate typecheck |

Post-review repair receipts live under
`docs/architecture/raptor3-evidence/g4/witness/repair/` and are listed in §13.
The two retained campaign children under `receipts/` were **regenerated** by
the repair (the transport models changed what a child executes); each now
carries `runner.log`, `attempt.json`, `verified.json`,
`generated-campaign.json`, `generated-corpus.json.gz` and
`generated-corpus.archive.json` whose `replayCommand` is the command that
produced it. The SQLite child keeps `runner-attempt1-identity-drift.log`, a
failed first attempt killed by blocker 2, unrelabelled.

Whole-estate typecheck: `node scripts/run-typecheck.mjs`, **clean** — only the
two permitted historical Pattern TS2345 diagnostics at
`src/query-engine/pattern/pack.ts:1443` and `:2633` (closing run 11.28 s wall,
5,578.0 MiB peak RSS, teardown verified). This unit adds no diagnostic.

## 9. Requests to other streams

**To G4-01 (query/projection).** The frozen handoff is
`g4/witness/handoff.md`. The single request that affects the witnesses'
readability: keep
`Raptor 3 G1 operation is not implemented: <operation>` and
`Raptor 3 G1 scalar codec is not implemented: <type>` as the exact messages
while a verb or codec is unimplemented, or tell this stream the replacement —
the red witnesses pin those strings as the *reason* they are red.

**To G4-02 (physical/provider).** Two refusal identities are wrong in the
candidate and are provider-facing: a variant collection quantifier raises a
bare `TypeError`, and a vector column on an incapable provider raises a bare
`Error` where the shipped engine raises `QueryError`. Both have witnesses.

**To the review stream.** `tests/raptor3/g4/review/unit03/` is excluded from
credential-free discovery (§7). Nothing else in this unit touches it, and its
four suites are registered in no mode.

**To G4-03 (route).** `tests/raptor3/g4/route-contract.ts` binds
`createCandidateClient` from `src/query-engine/raptor3/route/client-route.ts`;
if that export moves or is renamed, only that one line changes. The two red
C13 rows are the statement-unit omission and the cache result codec.

## 10. Blockers

1. **Native PostgreSQL and MySQL are unavailable.** Reproducer: every one of
   `51436, 51439, 3307, 5434, 5432, 3306` answers `ECONNREFUSED` on
   `127.0.0.1`. Both native modes were attempted twice each before the repair
   and twice each again after it (`repair/native/`): without
   `VIBORM_RAPTOR3_PROVIDER_PORT` the suite refuses at
   `AssertionError: Required live provider loopback port is missing or invalid`
   (`tests/raptor3/transitions/live-world.ts:38`) and collects zero cells; with
   a port supplied, all four cells fail with
   `Error: connect ECONNREFUSED 127.0.0.1:<port>`. The native suites are
   written, registered and reported **blocked** — never passed. Command to
   re-attempt:
   `VIBORM_RAPTOR3_PROVIDER_PORT=<port> node scripts/run-raptor3.mjs g4-read-envelope-pg-contracts`.
2. **Identity drift under concurrent streams.** Any identity-pinned command
   (`run-raptor3.mjs`, `raptor3-cli.test.mjs`) fails if another stream writes
   to `src/` during the run: `assertRaptor3Identity` compares the fingerprint
   captured at module load with the one the child captures. Observed once on
   `raptor3-cli.test.mjs` (receipt kept); it passed on retry. This is an
   orchestration fact, not a defect: identity-pinned evidence must be produced
   while `src/` is quiet, which the integrator can only guarantee after the
   implementation streams stop.

## 11. Stop-rule record

No stop rule fired. No minimized failure survived two repairs; no public
contract change was needed; no legacy fallback was needed; no semantic
interpretation was duplicated to pass a witness. Every red cell is the
candidate's, and every hand-value correction is listed in §6.

## 12. Unverified claims

1. **Native provider behavior is entirely unverified.** The native suite's
   expected values have **never executed**; treat the file as a registered
   claim, not as evidence. Exactly what it claims, after the repair:
   - `g4-native-scalar-codec-round-trip` seeds and **projects** bigInt
     (`BIGINT`), decimal (`DECIMAL(12,3)`), dateTime
     (`TIMESTAMPTZ`/`DATETIME(3)`), date (`DATE`), time (`TIME`), enum, JSON
     (`JSONB`/`JSON`) and blob (`BYTEA`/`VARBINARY`) — real bytes and a real
     JSON document, because `payload_value` is `NOT NULL` and the live harness
     sends every key on the row.
   - `g4-native-string-mode-and-nulls-ordering` claims Q-W04 collation and
     Q-O01 `{ sort, nulls }`.
   - `g4-native-cursor-pagination-and-aggregate-shapes` claims Q-P01 forwards
     and backwards and the `groupBy` `_count`/`_min`/`_max` shapes.
   - `g4-native-recursive-read-fit` is the private `Queries.recursive` fit
     (RF-16) entered through `OperationContext`, asserting one statement for
     the whole traversal over a mapped compound identity path.
   **Not claimed there, and why:** scalar lists SL-01…SL-10 have no
   cross-provider column type (PostgreSQL has arrays, MySQL has none);
   GeoPoint's metre tier (SC-14, Q-O02) needs PostGIS and vector (SC-13) needs
   pgvector, neither of which the recorded environment's containers provide.
   Those rows keep their SQLite refusal-parity witnesses and their positive
   tiers stay **unwitnessed**. Before the repair this file declared
   `payload_value NOT NULL` and seeded it `null` in every row, so it could not
   have passed even against a live provider, and its header claimed the
   spatial tiers it never exercised.
2. **The generated campaign has executed 100 seeds per lane, not 25,000.** The
   frozen ranges are reserved and the child cost is measured; the full
   250-children-per-lane run belongs to qualification, when a candidate-subject
   child can complete.
3. **The candidate-subject campaign has never completed a child.** Its cost is
   therefore unmeasured; only the shipped-subject child cost is measured, and a
   candidate that answers more cells will do strictly more work per cell.
4. **The route counts (7/8/6/5) were read from the current G4-03 files** and
   confirmed against that unit's published table; if G4-03 adds a cell before
   qualification, the count constants must move with it.
5. **The four profiles are transport *models*, not provider claims.** All
   four execute real SQLite. Since the repair each one is a distinct, asserted
   read-transport behaviour (§4): an interactive session, a per-statement
   atomic submission with real `BEGIN`/`COMMIT`, a weak returning envelope
   handing back frozen detached copies with `rowCount: 0`, and an
   acknowledging envelope that completes its acknowledgement before the rows
   are decoded. They witness that one admitted read publishes one public value
   across transport shapes — they are **not** evidence about D1 or any hosted
   provider, and the transport lane's two profiles differ in the returned
   envelope only, never in the SQL a read submits.
6. **Two witnesses assert only that both engines agree on an error identity**
   (`Q-R01` malformed row, `SC-13` vector refusal). They pin the class, not the
   message, because message wording is not a frozen contract.

7. **The generated campaign publishes no codec-bearing value.** Carried
   forward from the review (finding 6) and **not repaired**: `SELECTED_FIELDS`
   in `generation/recipe.ts` projects `{id,label,count,status,note}` (codec
   family), `{id,name,weight}` (relation) and `{region,code,label,score}`
   (compound). `bigInt`, `decimal`, `dateTime`, `json` and the two list columns
   are seeded and used in **predicates** only, so the campaign witnesses no
   codec but `enum`, and `canonical()` in `campaign.ts` would erase a
   `Buffer`-versus-`Uint8Array` distinction in any case. The observable
   published surface is 17 field names. The fixed C12 witnesses
   (`read-codecs.test.ts`, 12 cells) are where codec identity is pinned.

8. **Four adversarial read cells named by the review (finding 8) were added
   and three are green**; the fourth is red on the candidate's missing
   `contains`. They are witnesses, not proof of coverage completeness: the
   inventory rows they belong to already had cells.

## 13. Repair (after independent review)

`witness-review.md` returned **REVISE** with five must-fix findings and five
notes. Every must-fix is repaired; the notes are dispositioned below. Receipts
are under `docs/architecture/raptor3-evidence/g4/witness/repair/` unless another
path is named. Nothing in `src/` was touched: incremental core charged LOC and
complete charged LOC remain **0**.

### Must-fix 1 — the C13 cache-bypass falsifier asserted nothing about the candidate

*Change.* The three statement-count assertions were lifted out of the cell into
one module-level oracle, `assertCacheBypass(base, route)`
(`tests/raptor3/g4/lifecycle-admission.test.ts`), and the cell now runs that
same function against the shipped route and then against the candidate route.
Each call builds its own `MemoryCache`, so the candidate never inherits the
shipped route's entries and "the first read reaches the provider" is a real
claim on both. A **fifth cell** was added as the self-falsification: the same
oracle is run against a stand-in route that always serves a stale cached row,
inside a transaction included, and must reject it.

*Verification.* `repair/g4-fixed-witnesses.repair3.log` — the self-falsification
cell is **green** (`C13 cache-bypass: the same oracle rejects a route that
always serves the cache`), and the candidate cell is still red for the candidate
reason (`UnsupportedOperationError … publishes no prepared read shape`). Count
`g4-lifecycle-admission` 3 → 4.

*Reviewer probe.* `cache-bypass-blindness.review.test.ts` still passes: it
embeds a verbatim **copy** of the old candidate block rather than reading the
current file, so it can no longer speak about this file. The in-tree
self-falsification cell replaces it permanently.

### Must-fix 2 — four "transport profiles" were one profile with four names

*Change.* `tests/raptor3/g4/generation/world.ts` — the four profiles are now
four executed read-transport models (table in §4): an interactive session, a
per-statement atomic submission that really issues `BEGIN`/`COMMIT` on the
connection, a weak returning envelope (frozen detached copies, `rowCount: 0`)
and an acknowledging envelope that declares `supportsOrderedCommittedSegments`
— the G3 `ScriptedTransport` spelling — and performs the acknowledgement in its
own awaited turn before the rows are decoded. The model applies once the world
is sealed (after seeding). Every cell records `transport`, the model the driver
actually exhibited; `raptor3-manifest.mjs` owns the frozen `profile → model`
expectation (`G4_TRANSPORT_MODELS`) and `assertG4BatchShape` compares the two,
also requiring the models within one lane to be distinct and an
atomic-submission cell to report `statements % 3 === 0`.

*Verification.*
- `repair/generation-selftests.attempt1.log` and
  `repair/g4-generation-selftests-mode.log` — the new self-test
  (`runs four distinguishable transport models that publish one answer`) is
  green: one published value, four pairwise-distinct observations.
- `repair/campaign-receipts-selftest.attempt2.log` — 38/38, including the two
  new receipt falsifiers (a collapsed model, an unwrapped atomic cell).
- `receipts/g4-seed-batch-20000-shipped/generated-campaign.json` — 100 cells at
  `interactive-session`/1 statement and 100 at `atomic-submission`/3.
- `repair/review-probe-profile-power.log` — the reviewer's probe now **fails**,
  as it must: it asserted every profile is identical.

*Cost.* Re-measured; §4's tables and the disk projection (≈ 30.9 MB for 500
children) are replaced. The honest limit is stated in §4 and §12.5: for a read
the transport lane's two profiles differ in the returned envelope only.

### Must-fix 3 — a campaign's subject was an unsanitised ambient variable

*Change.* `scripts/run-raptor3.mjs`:
- `parseRaptor3Request` accepts `--subject=candidate|shipped`, **defaulting to
  `candidate`**, and only for the four G4 campaign modes (`G4_SUBJECT_MODES`);
  any other mode refuses the flag, and an unknown or repeated value refuses.
- `delete environment.VIBORM_RAPTOR3_G4_SUBJECT` now sits beside the other four
  sanitised variables, and the runner writes the subject it was asked for.
- The receipt assertion is selected from **the runner's request**
  (`requestedSubject.qualifying`), never from the receipt's own `subject`.
- `subject` and `qualifying` are recorded in `attempt.json`, in both
  `verified.json` shapes and in the printed line
  (`… (subject shipped, NOT qualifying — oracle validation) …`).
- The generated G4 archive replay command carries `--subject=<subject>`.
- The two campaign child tests no longer default the subject or read
  `VIBORM_RAPTOR3_GENERATED_SEED_COUNT`: a child holds the frozen batch and
  fails outright unless the runner named a subject.

*Verification.* `repair/raptor3-cli-selftest.attempt2.log` (227.00 s wall,
218.2 MiB peak; `attempt1` is the same 9/9 run taken before the last two read
cells landed) — 9/9, including the
new `a G4 campaign subject comes from the command, never from the shell`:
with `VIBORM_RAPTOR3_G4_SUBJECT=shipped` in the environment the child's
`attempt.json` still records `subject: "candidate"`, `qualifying: true`; asked
by name, stdout, `verified.json` and the child receipt all say `shipped` /
`qualifying: false` / `status: "oracle-validation"`; `--subject=oracle` and
`g0 --subject=shipped` are refused. `repair/campaign-receipts-selftest.attempt2.log`
adds the parse-level falsifiers. The reviewer's
`campaign-subject-authority.review.test.ts` now fails on three of its four
cells; the fourth reads the review's own retained receipt of the old behaviour
and is left alone.

### Must-fix 4 — the native suite could not pass, and covered less than its header claimed

*Change.* `tests/raptor3/g4/native/read-envelope-native.test.ts`:
- `payload_value` is seeded with real bytes on every row (`Buffer`), and row 1
  carries a real JSON document; the `NOT NULL` declaration is now satisfiable.
- `DATE` and `TIME` columns were added and the codec cell **projects**
  `big, amount, moment, day, clock, status, document, payload`, asserting
  `bigint`, `Decimal`, `Date`, the date/time public types, the parsed document,
  a JSON `null` on a second row, and exact `Uint8Array` bytes on all three.
- The header now states exactly what the four cells assert and, explicitly,
  what they do not: lists (no cross-provider column type), GeoPoint's metre
  tier (PostGIS) and vector (pgvector). The spatial claim is gone.
- `g4-native-recursive-read-fit` is the real `Queries.recursive` fit: it builds
  an `OperationContext` on the live driver, asserts the private capability
  exists, traverses a two-level mapped compound self-relation with a fourth
  tenant the seed must not reach, and requires the harness to have observed
  **one** statement. `expectedExecutions` is 0 because no public verb is used.

*Verification.* Typecheck clean (`repair/typecheck-final.log`). The reviewer's
`native-fixture-consistency.review.test.ts` now fails both cells that read this
file. **Still blocked and still unverified**: both modes were re-attempted after
the repair and both are still refused —
`repair/native/pg-no-port.log` and `repair/native/mysql-no-port.log`
(`AssertionError: Required live provider loopback port is missing or invalid`,
`tests/raptor3/transitions/live-world.ts:38`, zero cells collected), and with a
port supplied `repair/native/pg-port-5434.log` and
`repair/native/mysql-port-3307.log` (all 4 cells `connect ECONNREFUSED
127.0.0.1:5434` / `:3307`). The file has never executed against a provider;
§12.1 now says exactly which rows it claims and which it does not.

### Must-fix 5 — a retained archive receipt stated a replay command that fails

*Change.* Both retained children were **re-run and re-archived** after the
transport-model change, so the SQLite lane's receipt no longer carries the
G0/G3 default; each `generated-corpus.archive.json` now names the command that
produced it, subject included. `scripts/raptor3-campaign-receipts.test.mjs`
gains `a child corpus archive carries the replay command of its own lane`: a
two-argument call must put the command in the receipt and must not spell the
`replay` default, and the one-argument call must still spell the G3 default
exactly.

*Verification.* `repair/campaign-receipts-selftest.attempt2.log` (38/38);
`receipts/g4-seed-batch-20000-shipped/generated-corpus.archive.json` whose
`replayCommand` is `node scripts/run-raptor3.mjs g4-seed-batch 20000
--subject=shipped`, and `receipts/g4-seed-batch-20000-shipped/runner.log` is
that command's own successful execution. The reviewer's
`evidence-integrity.review.test.ts` archive cell now fails; its differential-
oracle cell still passes.

### Notes

| Note | Disposition |
| --- | --- |
| 6 — the campaign publishes no codec-bearing value | **Not repaired; stated plainly** in §12.7 and here. Widening `SELECTED_FIELDS` would change every oracle expectation and require re-validating both lanes; it is the single highest-value follow-up for this campaign and is recorded as such. |
| 7 — one refusal witnessed on the shipped engine only | **Fixed.** The one-sided `observeFailure` became `expectRefusal`, and it moved into its own cell (`Q-W05 refuses a list container on a scalar column`) because the containment rows above it are red and a refusal parked behind them would never run. Green. |
| 8 — four adversarial cases absent | **Fixed.** Four cells added: a junction collection **shared** by two parents windowed per parent (Q-P03, green), a mapped compound key unselected while a collection is stitched (Q-S01, green), `mode: "insensitive"` with a non-ASCII value pinning that SQLite folds ASCII only (Q-W04, red on the candidate's missing `contains`), and a nullable column partitioned at the NULL itself (Q-W03, green). |
| 9 — reported test cost stale | **Fixed.** §1 question 4 re-measured: 6,354 owned test lines, 955 added / 19 removed across the six registration files. |
| 10 — small internal inaccuracies | **Fixed.** `read-schema.ts` now names `author.score` as the deliberate exception; the Q-P03 cell title says `cursor`, not `distinct`; the unused `RAPTOR3_ROUTE_AVAILABLE` export is deleted; the duplicated ternary arms in `raptor3-campaign-receipts.test.mjs` are one arm; §1's archive cross-reference points at §8. The retained campaign identity is re-recorded by the regenerated receipts; blocker 2 stands. |

### Registration changes made by the repair

| Constant | Before | After |
| --- | --- | --- |
| `read-filters.test.ts` | 10 | 13 |
| `read-pagination.test.ts` | 5 | 6 |
| `read-projection.test.ts` | 6 | 7 |
| `lifecycle-admission.test.ts` | 3 | 4 |
| `generation/harness.selftest.test.ts` | 5 | 6 |
| read-family total pinned by the receipts self-test | 57 | 62 |

New exported manifest data: `G4_TRANSPORT_MODELS`. New runner flag:
`--subject=candidate|shipped` on `g4-seeds`, `g4-transport-seeds`,
`g4-seed-batch`, `g4-transport-seed-batch`. No existing mode, count or campaign
definition outside G4 changed.

### Stop rules

None fired during the repair. No minimized failure survived two attempts; the
one failure that needed a second attempt was blocker 2 (identity drift from a
concurrent `src/` edit), which passed on retry and whose failed receipt is kept
as `receipts/g4-seed-batch-20000-shipped/runner-attempt1-identity-drift.log`.

---

## 14. Follow-up (native fixtures, write campaign, G4-01 evidence landing)

Second run of this stream, after acceptance. Receipts for everything below are
under `g4/witness/receipts/followup/`. No production file was touched, so this
follow-up's incremental core and complete charged cost is **0 LOC / 0 tokens /
0 bytes**; the absolute census belongs to the G4-02 phase-2 author, whose `src/`
edits were landing throughout (see §14.8).

Identity when this follow-up started
([identity-before-followup.json](receipts/followup/identity-before-followup.json)):
production `a50fe487…`, harness `59a3f6e5…`. Identity when the census below was
taken ([identity-at-census.json](receipts/followup/identity-at-census.json)):
production `d844ae0f…`, harness `72fbd01e…`.

**Corrected in §15 (repair).** The sentence that stood here — "every red
recorded here is red against `d844ae0f…` and is not claimed against any other
identity" — was **wrong**, and the receipts under `receipts/followup/` say so:
they span three production and two harness identities, and the PostgreSQL
`42883` red of §14.2 was recorded at production `eb93c64d…`. The per-receipt
table is §15.4; each number below belongs to the identity that table gives it.

### 14.1 Native fixture repairs — both defects were the FIXTURE's

Two defects, one owner each, and neither was an engine.

**A. The live harness built its own pool.** `runLiveWorld` constructed
`new PgPool(options)` / `createPool(options)` and handed the result to the
driver as a *supplied* pool. A supplied pool is returned unchanged by
`initClient()`, so the fixture silently discarded everything the driver
configures about its transport: on PostgreSQL the DATE/TIMESTAMP text parsers
(`utcSafeTypes`, `src/drivers/pg/index.ts:46-60`), and on MySQL
`timezone: "Z"`, `supportBigNumbers: true` and `dateStrings: ["DATE"]`
(`src/drivers/mysql2/index.ts:315-350`). A temporal or wide-numeric column
therefore decoded under this fixture the way it decodes nowhere in production —
for the shipped engine and the candidate alike, which is exactly why the
failure looked like a codec bug with no engine to blame, and why
`g4/unit02/native-date-codec.test.ts` found both engines agreeing on a
driver-owned pool.

Repair, in `tests/raptor3/transitions/live-world.ts` (this stream's file, and
the only place the defect lives): two three-line subclasses, `PgPoolFactory`
and `MySQLPoolFactory`, return the pool their own driver builds
(`getClient()`), and the fixture borrows that transport for its raw seeding
SQL, its `SELECT *` inspection and both observed drivers. No production file
changed and no driver option is re-spelled in the test, so there is still one
authority for what a pool is configured with. No namespace is passed to the
factory: the per-run namespace does not exist when the pool is built, and on
MySQL the namespace *is* the connection database.

**B. The MySQL seed wrote an ISO-`Z` literal into `DATETIME(3)`.** MySQL
rejects the `Z` ("Incorrect datetime value"), which is precisely why
`src/adapters/databases/mysql/mysql-adapter.ts` (`toMySqlDateTime`) stores naive
UTC wall-clock `YYYY-MM-DD HH:MM:SS.mmm`. The fixture owns its raw seed SQL, so
it must spell a datetime the way the adapter does or it is testing its own
literal. `nativeDateTime(iso)` in
`tests/raptor3/g4/native/read-envelope-native.test.ts` spells that one rule —
identity on PostgreSQL (`TIMESTAMPTZ` takes the ISO string), the adapter's own
transform on MySQL — and every expectation in the file is still written against
the contract, not against either engine.

**Corrected in §15 (repair).** This paragraph said the fixture "applies the
adapter's own rule (`toMySqlDateTime`)". It does not: `toMySqlDateTime` is not
exported, so the fixture **duplicates** it. The repair names the two arms
(`pgDateTime`, `mysqlDateTime`) and pins each against
`adapter.literals.dateTime` in a fifth cell of the same suite, so the duplicate
cannot outgrow its original unnoticed (§15.2, finding 5).

### 14.2 Native results (measured, with port and container)

Containers recorded in
[receipts/followup/native/containers.txt](receipts/followup/native/containers.txt):
`viborm-raptor3-g3-pg-20260914` (image `95206741…`, started 2026-09-14T21:24:43Z,
0 restarts) and `viborm-raptor3-g3-mysql-20260914` (image `b3b90af2…`, same
start, 0 restarts).

| Mode | Loopback | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- | --- |
| `g4-read-envelope-pg-contracts` | 127.0.0.1:**65504** | **3 of 4 green.** `g4-native-scalar-codec-round-trip`, `g4-native-string-mode-and-nulls-ordering` and `g4-native-cursor-pagination-and-aggregate-shapes` pass. `g4-native-recursive-read-fit` fails with PostgreSQL `42883` | 3.87 s / 535.9 MiB | [pg-attempt1.log](receipts/followup/native/pg-attempt1.log), [pg-attempt1/](receipts/followup/native/pg-attempt1) |
| `g4-read-envelope-mysql-contracts` | 127.0.0.1:**65515** | **4 of 4 green**, including the recursive fit | 3.79 s / 526.8 MiB | [mysql-attempt1.log](receipts/followup/native/mysql-attempt1.log), [mysql-attempt1/](receipts/followup/native/mysql-attempt1) |

The remaining PostgreSQL `42883` is **not** this stream's and is not repaired
here: it is the `Queries.recursive` gap queued for G4-02 phase 2, and the cell
stays red. It is now also *localised* by this run: the same fit lowers and
passes on MySQL 8.4, so the missing spelling is PostgreSQL-specific rather than
a hole in the fit itself.

### 14.3 The inherited native suites that share the repaired harness

Every other suite that goes through `runLiveWorld` was re-run on the same
containers.

| Mode | Result | Receipt |
| --- | --- | --- |
| `g2-pg-baseline` | 17/17 green | [inherited-g2-pg-baseline.log](receipts/followup/native/inherited-g2-pg-baseline.log) |
| `g2-pg-contracts` | 18/18 green | [inherited-g2-pg-contracts.log](receipts/followup/native/inherited-g2-pg-contracts.log) |
| `g2-mysql-baseline` | 13/13 green | [inherited-g2-mysql-baseline.log](receipts/followup/native/inherited-g2-mysql-baseline.log) |
| `g2-mysql-contracts` | **10/13**; three cells of `unique-races-live-commands.test.ts` red (`g2-race-selected-unique-recovery`, `g2-race-unrelated-unique-refused`, `g2-race-wrong-insert-same-constraint`) | [inherited-g2-mysql-contracts.log](receipts/followup/native/inherited-g2-mysql-contracts.log) |

**Falsified, not assumed.** The pre-change `live-world.ts` was restored from
`HEAD` into a backup-protected swap and `g2-mysql-contracts` re-run: the same
three cells fail identically
([falsify-g2-mysql-contracts-on-HEAD-live-world.log](receipts/followup/native/falsify-g2-mysql-contracts-on-HEAD-live-world.log)),
so the pool repair does not cause them. Their shipped twin
(`g2-mysql-baseline`, `unique-races-live-legacy`) is green, so the divergence is
on the candidate side, at a production identity that phase 2 was moving while
the run happened. Recorded red, handed to G4-02, not relabelled.

### 14.4 Write-envelope campaign on new seeds

Two data-only constants in `scripts/raptor3-manifest.mjs`, both spreading G3's:

| Constant | Range | Profiles | Inherited from G3 |
| --- | --- | --- | --- |
| `G4_WRITE_CAMPAIGN` | **75000-99999** | `sqlite-interactive`, `sqlite-atomic-batch` | batch 100, 3 replays, completion limit 10,000, actor/fault quotas, contract rotation |
| `G4_WRITE_TRANSPORT_CAMPAIGN` | **100000-124999** | `scripted-returning-weak`, `scripted-returning-ack` | the same |

Both ranges are disjoint from every G1/G2/G3 range and from the G4 **read**
campaign's 20000-74999; the receipts self-test asserts the disjointness rather
than stating it. Both first seeds are multiples of four, which is what keeps
the receipt's `(seed - campaign.firstSeed) % 4` rotation equal to the
generator's `(seed - 8000) % 4` — also asserted.

New modes: `g4-write-seeds`, `g4-write-seed-batch <first-seed>`,
`g4-write-transport-seeds`, `g4-write-transport-seed-batch <first-seed>`.
They take **no** `--subject`: there is one subject here, the candidate, and the
read campaign's flag is refused rather than ignored (CLI cell). `campaignFor`
resolves `g4-write-` before `g4-`, the archive branch gives these children a
replay command with no `--subject` (their parser would refuse one), and the
receipt branch selects `assertG3GeneratedBatchReceipt` — the same assertion G3
uses, which re-derives contract, actors, overlap and faults from the seed, so a
campaign constant cannot widen what qualifies.

**Measured child cost.** One 1-batch child of each lane, both green:

| Child | Cells | Replays | Wall (bounded runner) | Peak RSS | Raw corpus | gzip corpus | Retained directory |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `g4-write-seed-batch 75000` | 200 | 600 | **6.58 s** (test body 2.70 s) | 763.6 MiB | 62,116,444 B | **1,192,709 B** | 1,281,627 B |
| `g4-write-transport-seed-batch 100000` | 200 | 600 | **6.21 s** (test body 2.21 s) | 896.9 MiB | 65,805,021 B | **1,342,358 B** | 1,433,241 B |

Each child reports 50 cells per contract family (C08/C09/C10/C11), 40 two-actor
cells and 40 cells with an actually injected fault — the 20% quotas, per
profile, that the receipt re-derives. Receipts:
[write-campaign/sqlite-75000/](receipts/followup/write-campaign/sqlite-75000),
[write-campaign/transport-100000/](receipts/followup/write-campaign/transport-100000);
each corpus is compressed and its archive receipt proves the gzip restores the
exact source bytes and names the command that reproduces it. A one-seed probe
that proved the path before the full child is kept as
[probe-sqlite-1seed.log](receipts/followup/write-campaign/probe-sqlite-1seed.log).

**Disk projection, 250 children per lane.** 250 x 1,281,627 B = **320.4 MB**
(SQLite) and 250 x 1,433,241 B = **358.3 MB** (transport) = **≈ 679 MB** for
both new families, with a transient raw peak of one child's corpus (≈ 66 MB)
because the parent archives each child before the next starts.

**The disk fact at G4 opening no longer holds.** The working volume had 21 GiB
free then; it measured **6.4 GiB** when the write children ran, **5.5 GiB** a
little later and **4.1 GiB** by the end of this follow-up, as the parallel
streams wrote their own evidence. That is a trend, not a reading: the two write
families now need ≈ 17% of what remains, against the 0.15% the read campaign
was projected at, and at this rate the volume is a G4 blocker before the
campaign is. A full pair of 250-child campaigns must not run beside any
retained raw corpus, the raw peak must be archived per child as the parent
already does, and the free-space figure must be re-measured immediately before
the campaign rather than read out of `g4.md`.

### 14.5 G4-01 evidence landed in the main tree

Copied from `/private/tmp/viborm-g4-unit01` into the same paths:
`tests/raptor3/g4/unit01/` (10 files) and `tests/raptor3/g4/review/unit01/`,
`unit01-followup/`, `unit01-followup2/`, `unit01-followup3/` (29 test files plus
their worlds).

One byte change was made to the landed files: the single TS2638 at
`review/unit01-followup2/cursor-refusal.test.ts:29`. **The prescribed
`(orderBy as { team?: unknown }).team` does not on its own clear it** —
`unknown ?? {}` is `{}`, and TypeScript refuses `{}` as the right operand of
`in` ("may represent a primitive value"), which the first attempt reproduced
([typecheck-attempt1.log](receipts/followup/typecheck-attempt1.log)). The landed
repair binds the annotated local instead:

```ts
const team: Record<string, unknown> =
  (orderBy as { team?: Record<string, unknown> }).team ?? {};
const model = "label" in team ? "member" : "team";
```

File size 1,574 -> **1,670 bytes (+96)**. Nothing else in the landed files
changed.

| Mode | Files | Cells | Result |
| --- | --- | --- | --- |
| `g4-unit01-author` | 10 | **83** | 83/83 green |
| `g4-unit01-review` | 29 | **200** | 197 green / **3 red** |

The three red cells are the finding-K probes the integrator delegated to G4-02
phase 2 (refusal *precedence* when one call violates both the `where` contract
and the cursor contract):

- `review/unit01-followup3/competing-refusals.test.ts` — "decimal domain vs the
  cursor refusal" (1 of 4).
- `review/unit01-followup3/refusal-order-history.test.ts` — "cross-model scope
  refusal (r2 code) beside the cursor violation" and "decimal domain refusal
  (r5 code) beside the cursor violation" (2 of 3).

They are **registered anyway and recorded red**, which is the point: the mode
turns green when phase 2 lands, and nothing has to remember to add them.

Both modes are excluded from the credential-free lane like every other G4
suite. `tests/raptor3/g4/unit01/` is named in `extendedLocalExclusions`
(it has a registered mode); the reviewer probes are covered by the existing
`tests/raptor3/g4/review/` walk skip.

### 14.6 Registration hygiene — every G4 count re-derived from the files

All 54 registered G4 fixed files were run in one report
([g4-fixed-census.json](receipts/followup/g4-fixed-census.json),
[log](receipts/followup/g4-fixed-census.log)) and every registered count
compared against the cells the file actually contains:

**387 cells across 54 files, 0 count mismatches.** `route-transactions.test.ts`
is confirmed at **11**. The read family totals 62, still pinned by the receipts
self-test.

**Superseded total** (round-3 review, note 10): §15.5 added a fifth cell to the
native file, so the registered estate is **55 fixed files / 392 cells** from
§15 onward — 387 non-native plus the native file's 5, which run in each of the
two native modes. Nothing after §14 restates 387; a reader carrying it forward
would be one cell short per native mode.

Census at production `d844ae0f…` / harness `72fbd01e…`: **375 green / 12 red.**

| Red cell | File |
| --- | --- |
| Q-W10 tagged variant collection quantifiers | `read-filters.test.ts` |
| Q-O04 collections ordered only by `_count` | `read-ordering.test.ts` |
| SC-13 vector refusal parity | `read-codecs.test.ts` |
| RF-16 fuller codec set at every depth | `read-recursive-fit.test.ts` |
| C13 missing-event: every required lifecycle unit | `lifecycle-events.test.ts` |
| C13 statement observation covers the physical statements | `lifecycle-events.test.ts` |
| C13 cache-bypass inside a transaction | `lifecycle-admission.test.ts` |
| unsupported verb keeps the candidate's refusal | `route-admission.test.ts` |
| LX-04 divergence pin (blocker B-1) | `route-transactions.test.ts` |
| decimal domain vs the cursor refusal | `review/unit01-followup3/competing-refusals.test.ts` |
| cross-model scope refusal beside the cursor violation | `review/unit01-followup3/refusal-order-history.test.ts` |
| decimal domain refusal beside the cursor violation | `review/unit01-followup3/refusal-order-history.test.ts` |

`g4-route-transactions` was 11/11 in the 02:25 integration log and is 10/11 now;
`lifecycle-*` and `route-admission` have moved likewise. The census is taken
against a production identity phase 2 is still changing, so these are reported
as **red now**, at `d844ae0f…`, and not attributed to any stream.

### 14.7 Harness edits outside this unit's named file list

Three files under `tests/raptor3/g3/generation/` were edited — `recipe.ts`,
`sqlite-campaign.ts`, `transport-campaign.ts`. They are not in this brief's
list, so they are recorded here in full with an exact revert.

**Corrected in §15 (repair).** This paragraph said "they belong to no G4 stream
and nobody else is writing them". That is false of the *directory*: a
concurrent stream has `tests/raptor3/g3/generation/transport-plans.ts` modified
in the same working tree (adapting `Candidate` to the phase-2 engine type). The
true and narrower statement is that **no other stream edited the three files
this stream changed**; `transport-plans.ts` is a fourth dirty file in that
directory and is not this stream's.

The reason is concrete: the brief asks for the write campaign to reuse "the G3
generator, `runG3SQLiteBatch`/transport runner and
`assertG3GeneratedBatchReceipt` (it takes the campaign as a parameter)". Only
the third of those three is actually campaign-parameterized. The other two
hard-bind `G3_GENERATED_CAMPAIGN`, and `generateG3Recipe` additionally asserts
`seed >= 8000 && seed < 18_000` with the same bound written into the recipe
schema — so a seed of 75000 is refused by the generator before any runner sees
it. Duplicating a 150-line batch runner into `tests/raptor3/g4/generation/`
would have avoided the edit at the cost of a second authority for the same
fact, which the hard rules forbid more strongly.

| File | Change | Default behaviour |
| --- | --- | --- |
| `g3/generation/recipe.ts` | the admitted seed domain becomes two named constants, `GENERATED_SEED_FLOOR = 8000` and `GENERATED_SEED_CEILING = 124_999`, used by both the zod bound and the generator assert | unchanged for 8000-17999 |
| `g3/generation/sqlite-campaign.ts` | `runG3SQLiteBatch(firstSeed, seedCount, campaign = G3_GENERATED_CAMPAIGN)` and `verifyG3SQLiteCell(…, campaign = G3_GENERATED_CAMPAIGN)`; every `G3_GENERATED_CAMPAIGN.` inside them becomes `campaign.` | identical when the parameter is omitted |
| `g3/generation/transport-campaign.ts` | the same, for `runG3TransportBatch` / `verifyG3TransportCell` | identical when the parameter is omitted |

**Falsifier for "G3 is unaffected", run rather than asserted.** A SHA-256 over
`JSON.stringify(generateG3Recipe(seed))` for every seed 8000-17999 is
`ffc60ca2f65edde3223959e442fb0b392a11855d85305981113f029d622b2017` **before and
after** the widening
([before](receipts/followup/g3-recipe-fingerprint-before.txt),
[after](receipts/followup/g3-recipe-fingerprint-after.txt),
[the script](receipts/followup/g3-recipe-fingerprint.mts)) — the
picker is `seed ^ 0xa4093822`, the rotation is `(seed - 8000) % 4` and the
actor/fault rules are `seed % 5`, all absolute functions of the seed. Every G3
recipe, receipt and self-test is therefore byte-identical.

Exact revert: restore those three files from `HEAD`, delete
`G4_WRITE_CAMPAIGN` / `G4_WRITE_TRANSPORT_CAMPAIGN` and their `_TESTS` from the
manifest, delete `tests/raptor3/g4/generation/write-*.test.ts`, and remove the
`g4-write-` arms from `campaignFor`, the two mode lists, the `files` map, the
archive branch and the receipt branch of `run-raptor3.mjs`.

A fourth edit is in a file this stream already owns, made on behalf of another:
`scripts/credential-free-test-manifest.mjs` now skips
`tests/raptor3/g4/unit02/` in its file walk, beside the existing
`tests/raptor3/g4/review/` skip. Six of the G4-02 author's suites were being
adopted into `EXTENDED_LOCAL_TESTS` by that walk, which puts unregistered
suites into `test:all` for every other stream. They belong to that author and
have no registered mode; promoting them is that stream's request to make.

### 14.8 Self-tests, typecheck and the two blockers

- `scripts/raptor3-campaign-receipts.test.mjs`: **39/39** (was 38 — one new
  cell, "G4 write lanes reuse the G3 campaign on fresh disjoint ranges"),
  0.39 s wall, 67.6 MiB peak RSS
  ([log](receipts/followup/campaign-receipts-selftest-attempt1.log)).
- Whole-estate typecheck: **clean** apart from the two permitted historical
  Pattern TS2345 diagnostics at `src/query-engine/pattern/pack.ts:1443` and
  `:2633`; 7.14 s wall, 5,878.1 MiB peak RSS, teardown verified
  ([log](receipts/followup/typecheck-attempt2.log)). The first attempt is kept
  unrelabelled: it carried the TS2638 described in §14.5
  ([log](receipts/followup/typecheck-attempt1.log)).
- The two landed modes were also run through the runner itself, not only in the
  census: `g4-unit01-author` **83/83, gate verified**
  ([log](receipts/followup/mode-g4-unit01-author.log)) with its count assertion
  passing, and `g4-unit01-review` 197/200
  ([log](receipts/followup/mode-g4-unit01-review.log)), red on the three
  finding-K cells.
- `scripts/raptor3-cli.test.mjs`: two cells are new — the G4 refusal cell gains
  the two `g4-unit01-*` modes, and "the G4 write lanes own their own range and
  take no subject" pins the off-boundary and `--subject` refusals of all four
  write modes. **The best run obtained is 6/10**
  ([attempt 5](receipts/followup/raptor3-cli-selftest-attempt5.log), 217.02 s
  wall, 213.5 MiB peak RSS): **both new cells pass**, and all four failures are
  `Stale Raptor 3 evidence` — blocker 2, not a defect in anything registered
  here. A clean 10/10 was not obtainable: four attempts were made and every one
  was killed by the same tree moving under it (attempt 3 0/10 and attempt 4
  0/10, both drifting inside the `before()` g0 gate so every cell cascaded;
  attempt 6 refused at the workspace lock another stream held). All four logs
  are kept, unrelabelled. This test needs a quiet `src/`, which only the
  integrator can arrange once the implementation streams stop.
- Because the CLI self-test is identity-pinned and this tree would not hold
  still (below), the same refusals were additionally verified at parse level,
  where nothing is pinned:
  [mode-parse-verification.log](receipts/followup/mode-parse-verification.log)
  — eight accepted spellings (both parents, both `g4-unit01-*`, and the first
  and last legal child of each write lane) and eleven refusals, including a
  write child that tries to start inside the G3 range (8000) and inside the G4
  read range (20000).

**Two evidence-handling mistakes of this stream's own, recorded rather than
tidied away.** (1) A comment in `tests/raptor3/transitions/live-world.ts` was
corrected while a CLI self-test run was in flight; that file is inside the
harness fingerprint the test pins, so the run could no longer mean anything and
was abandoned
([raptor3-cli-selftest-attempt2-abandoned.log](receipts/followup/raptor3-cli-selftest-attempt2-abandoned.log)).
(2) Worse: a retry wrapper reused the filename `raptor3-cli-selftest-attempt1.log`
when it was restarted and truncated the 30,718-byte log of the first, failed
attempt before it was noticed. That receipt is gone. What it said is
transcribed — labelled as a reconstruction, not a receipt — in
[raptor3-cli-selftest-attempt1-DESTROYED.md](receipts/followup/raptor3-cli-selftest-attempt1-DESTROYED.md),
and no claim above rests on it. The lesson is mechanical and worth keeping: an
evidence filename must never be reusable by a rerun.

**Which identity each receipt belongs to. RETRACTED — see §15.4.** What stood
here claimed that every receipt except the four CLI attempts and the parse-level
check was produced at harness `72fbd01e…`, and that the only harness change
after 04:53 was a corrected comment in
`tests/raptor3/transitions/live-world.ts`. Both claims are contradicted by the
receipts this follow-up itself wrote: **no receipt carries `72fbd01e…`**, the
run receipts carry harness `854ad639…` and `c7a5344f…`, and the harness moved at
least four times across the window — which the landing of 39 test files plus the
runner registration necessarily caused. §15.4 gives the measured per-receipt
table; nothing in the receipts themselves was altered.

Blocker 1 of §10 (native providers unavailable) is **lifted**: both containers
answer and both G4 native modes ran. Blocker 2 (identity drift under concurrent
streams) is **active and shaped this follow-up**: the production fingerprint
moved from `a50fe487…` to `d844ae0f…` between the start of this run and the
census, so every identity-pinned command had to be retried against the
workspace lock, and the route/lifecycle red counts in §14.6 are a snapshot of a
tree another author is still writing.

### 14.9 Unverified claims of this follow-up

Stated as unverified, not softened:

1. **The two write parent modes were never executed.** `g4-write-seeds` and
   `g4-write-transport-seeds` each drive 250 children; only **one child of each**
   was run (seeds 75000-75099 and 100000-100099). The parents' range arithmetic,
   batch boundaries and archive branch are pinned by the receipts self-test and
   by the CLI cell, and the per-child path is proven by the two green children —
   but no claim is made here about 25,000 seeds per lane.
2. **The disk projection is an extrapolation** from those two children
   (1,281,627 B and 1,433,241 B retained). A later child on a different recipe
   mix could be larger; the projection is linear and unmeasured beyond one
   child per lane.
3. **The red census in §14.6 is a snapshot of a moving tree.** Production went
   `a50fe487… → d844ae0f… → c945b8a2… → 99c8d6a8…` during this follow-up as the
   G4-02 phase-2 author worked. Which of the route/lifecycle reds are phase-2
   work-in-progress and which are real is not determined here, and no cause is
   attributed.
4. **The three `g2-mysql-contracts` reds are localised, not diagnosed.** They
   reproduce on the unmodified `live-world.ts`, so the pool repair is excluded;
   their actual cause is not investigated by this stream.
5. **The PostgreSQL `42883` in the recursive fit is not diagnosed either**, only
   localised: the same fit passes on MySQL 8.4, so the missing spelling is
   PostgreSQL-specific. Naming the function is G4-02's.
6. **The CLI self-test never reached 10/10 here.** Its best run is 6/10 with
   the four failures all identity drift. The two cells this follow-up added are
   green in that run and in the parse-level check, but the test as a whole is
   **not** a passing receipt for this tree and is not claimed as one.
7. **Biome reports pre-existing diagnostics** in `scripts/raptor3-manifest.mjs`
   (70) and `tests/raptor3/transitions/live-world.ts` (16), almost all import
   ordering. They are not introduced here — an untouched file in the same tree
   (`tests/raptor3/g3/generation/bulk-scenario.ts`) reports 22 — and applying
   `biome check --write` would reorder imports across these files, which this
   estate has been bitten by before. The two files added by this follow-up
   report **0**.

## 15. Repair (after the independent follow-up review)

Second repair round of this stream, after
[`witness-followup-review.md`](../witness-followup-review.md) returned REVISE.
Receipts for everything below are under
[`g4/witness/receipts/repair/`](receipts/repair). No production file was
touched, so this round's incremental core and complete charged cost is again
**0 LOC / 0 tokens / 0 bytes**: `grep -c "^+++ b/src/"` over the regenerated
patch is **0**.

**One identity for the whole round.** Every run receipt below was produced at
production `7475621b…` / harness `ebe1f7e6…`
([identity-after-repair.json](receipts/repair/identity-after-repair.json)),
which is also the identity of the tree at the last source edit. The round
opened at production `b100ea77…` / harness `b0bcc6cf…`
([identity-before-repair.json](receipts/repair/identity-before-repair.json));
the production half moved once (phase 2), the harness half moved once (these
repairs), and nothing moved after that. §15.4 is the audit that says so.

### 15.1 Must-fix 1 — the write children no longer read an ambient seed count

Two edits, because the reviewer named two and each closes a different door:

- `tests/raptor3/g4/generation/write-campaign.test.ts` and
  `write-transport-campaign.test.ts` pass `G4_WRITE_CAMPAIGN.batchSize` /
  `G4_WRITE_TRANSPORT_CAMPAIGN.batchSize` to the runner. The child holds the
  frozen batch, exactly as the G4 read child was hardened to in §13.
- `scripts/run-raptor3.mjs` deletes `VIBORM_RAPTOR3_GENERATED_SEED_COUNT` from
  the child environment beside the subject, so **no** child of any mode — G3's
  included, which still reads the variable — can inherit one from the shell.
  The runner never sets it, so this is a hardening with no behaviour change.

**Falsified with the reviewer's own command**, not argued:

```
VIBORM_RAPTOR3_GENERATED_SEED_COUNT=1 node scripts/run-raptor3.mjs g4-write-seed-batch 75000
→ generated-campaign.json: { firstSeed: 75000, seedCount: 100, cells: 200,
                             replays: 600, qualifying: true, status: "complete" }
```

([write-child-ambient-count-attempt1.log](receipts/repair/write-child-ambient-count-attempt1.log),
[write-child-ambient-count/](receipts/repair/write-child-ambient-count)) — the
run that produced a 1-seed receipt for the reviewer now produces the full
batch. Its corpus is 62,116,444 B, the same length as the follow-up's
`sqlite-75000` corpus, so the child runs what it always ran.

The follow-up's own retained
[probe-sqlite-1seed.log](receipts/followup/write-campaign/probe-sqlite-1seed.log)
**was** such a run and its text does not say so. The log is left unaltered; a
sibling
[probe-sqlite-1seed.ANNOTATION.md](receipts/followup/write-campaign/probe-sqlite-1seed.ANNOTATION.md)
now records what it covered, because a receipt that reads like a full child and
is not one is the failure this must-fix is about.

**What is NOT repaired, and why.** The reviewer's probe cell "refuses a child
that holds fewer seeds than the frozen batch" stays red, deliberately.
`assertG3GeneratedBatchReceipt` admits a truthful short batch **by design**:
`scripts/raptor3-campaign-receipts.test.mjs` carries a registered cell that
asserts `assert.doesNotThrow` for a 7-seed receipt of a 100-seed batch. Making
the assertion reject one would change G3's contract, which the review put
explicitly out of scope ("this finding is not a request to change G3"). The
leak is closed at the child and at the runner instead; the probe now documents
a deliberate property of the shared assertion rather than a hole.

### 15.2 Must-fix 2 — both write child modes are pinned, and the class is closed

`scripts/run-raptor3.mjs` gains

```js
"g4-write-seed-batch": { "tests/raptor3/g4/generation/write-campaign.test.ts": 1 },
"g4-write-transport-seed-batch": { "tests/raptor3/g4/generation/write-transport-campaign.test.ts": 1 },
```

and, one line above the `if (expectedCounts)` guard, the invariant the omission
broke:

```js
assert(
  expectedCounts !== undefined || !request.mode.endsWith("seed-batch"),
  `No registered cell count for ${request.mode}`
);
```

**Falsified by removing an entry** (the runner was copied to the scratchpad
first and restored from that copy; `shasum -a 256` before and after is
`3c4fbcf9…`, identical): with the `g4-write-seed-batch` entry deleted the mode
refuses with `No registered cell count for g4-write-seed-batch` instead of
running unpinned
([falsify-missing-cell-count-attempt1.log](receipts/repair/falsify-missing-cell-count-attempt1.log)).
Every one of the estate's twelve `*-seed-batch` modes is registered in both
maps, so the guard is inert today and fires on the next one that is not.

### 15.3 Must-fix 4 — the write lane's archive receipt now names the command that consumes it

`scripts/run-raptor3.mjs` archives a `g4-write-` child's corpus with
`archiveG3GeneratedCorpus(receiptDirectory)` — the inherited default, which
names the ordinary `replay` gate — because the write lanes emit a G3-format
`G0ReplayRecord` corpus that gate reads, and, having one subject, need no
`--subject` in the command. The special arm that regenerated the corpus from
seeds is gone.

**The receipt's own two commands were executed verbatim**, not inspected:
`archiveG3GeneratedCorpus` on a real write child produced
`restoreCommand` + `replayCommand`
([write-corpus-archive-attempt1.log](receipts/repair/write-corpus-archive-attempt1.log),
[generated-corpus.archive.json](receipts/repair/write-child-ambient-count/generated-corpus.archive.json)),
and running them as written gave **"Raptor 3 replay contract gate verified"**
([write-corpus-gate-replay-attempt1.log](receipts/repair/write-corpus-gate-replay-attempt1.log)).
The restored bytes now have a consumer.

The follow-up's retained receipt
`receipts/followup/write-campaign/sqlite-75000/generated-corpus.archive.json`
still carries the superseded command. It is a receipt of a past run and is left
exactly as it was written.

### 15.4 Must-fix 3 — the identity narrative, measured

The §14 preamble and the §14.8 paragraph are corrected in place above. This is
what the receipts actually say, derived by walking every JSON under
`receipts/followup/` (local times, +0200):

| Receipt | production | harness | written |
| --- | --- | --- | --- |
| `identity-before-followup.json` | `a50fe487…` | `59a3f6e5…` | 04:44 |
| `native/pg-attempt1/attempt.json`, `native/mysql-attempt1/{attempt,verified}.json` | `eb93c64d…` | `854ad639…` | 04:53–04:54 |
| `write-campaign/sqlite-75000/*.json`, `write-campaign/transport-100000/*.json` | `d844ae0f…` | `854ad639…` | 04:56 |
| `identity-at-census.json` | `d844ae0f…` | `72fbd01e…` | 04:57 |
| `mode-g4-unit01-author/{attempt,verified}.json` | `08861ba0…` | `c7a5344f…` | 05:03 |
| `identity-final.json` | `6c26242c…` | `6e204375…` | 05:11 |

Three consequences, stated rather than softened:

1. **No receipt carries `72fbd01e…`.** That fingerprint exists only in the
   census identity snapshot; the census report itself (`g4-fixed-census.json`)
   is a vitest report and carries no identity of its own.
2. **The kept-red PostgreSQL `42883` cell handed to G4-02 was recorded at
   production `eb93c64d…`**, an identity §14 never named. It is *not* red at
   `d844ae0f…` as §14 claimed, and it is not red now at all (§15.6).
3. **The harness moved at least four times** across the follow-up window
   (`59a3f6e5… → 854ad639… → 72fbd01e… → c7a5344f… → 6e204375…`). Attributing
   that to one corrected comment was wrong: the follow-up landed 39 test files
   and registered two modes in the runner, and every one of those edits is
   inside the harness fingerprint.

The same audit over this repair round's own receipts is
[identity-after-repair.json](receipts/repair/identity-after-repair.json) plus
the per-receipt walk in §15 — **every** run receipt of this round reads
production `7475621b…` / harness `ebe1f7e6…`.

### 15.5 Note 5 — the duplicated MySQL datetime rule is now pinned

`nativeDateTime` is split into the two named arms it always had — `pgDateTime`
(identity) and `mysqlDateTime` (naive UTC wall-clock) — and a fifth cell,
`g4-native-datetime-literal-matches-the-adapter`, compares **both** arms with
`adapter.literals.dateTime(iso).values` for four instants, using
`PostgresAdapter` and `MySQLAdapter` themselves. `toMySqlDateTime` is private,
so the fixture's copy cannot be deleted without a production edit this brief
forbids; it can be, and now is, held to the original. The cell needs no
provider and runs in both native modes; `G4_NATIVE_PROVIDER_COUNTS` is **5**.

The reviewer's probe cell that checked the same fact is now red for a
mechanical reason and is left untouched: it lifts the MySQL arm out of
`nativeDateTime`'s body **by text** and evaluates it with `new Function`, so
naming the arm puts `mysqlDateTime` out of that function's scope
(`ReferenceError: mysqlDateTime is not defined`). The fact it protected is
green inside the product's own suite, twice (§15.6).

### 15.6 Note 6 — a background pool failure fails the run again

`PgDriver.initClient()` retains a built pool's background failures in a WeakMap
keyed on the driver that built it, and `runLiveWorld` discards that
`PgPoolFactory` the moment it takes the pool — so the retained failure was
unreadable and a run could pass over a dead transport, where the pre-repair
bare `new PgPool(options)` would have failed loudly. The fixture now subscribes
its own listener (`watchPgPool`) and files the failure where a body failure is
filed, so all 39 existing `assertHealthy()` call sites surface it; `runLiveWorld`
additionally rethrows it at teardown when nothing else failed.

**PostgreSQL only.** `MySQL2Driver.initClient()` subscribes to nothing at all,
so a borrowed mysql2 pool behaves exactly as the fixture-built one did and
there is nothing to restore. The first attempt at a provider-agnostic helper
failed the estate typecheck (mysql2's `Pool.on` has no `"error"` overload) and
that log is kept
([typecheck-attempt1.log](receipts/repair/typecheck-attempt1.log)).

The reviewer's probe cell `leaves no unread background-failure listener on the
fixture's pool` stays red and is left untouched: it asserts
`pool.listenerCount("error") === 0` on a pool a bare `PgDriver` subclass built,
and that listener is the **driver's**. Removing it is a production change this
brief forbids; making the retained failure readable is what was available, and
is what was done.

### 15.7 Measured results, all at `7475621b…` / `ebe1f7e6…`

| Command | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g4-read-envelope-pg-contracts` (port **65504**) | **5 / 5 green**, including the recursive fit and the new adapter pin | 3.41 s / 527.3 MiB | [native/pg-attempt1.log](receipts/repair/native/pg-attempt1.log), [native/pg-attempt1/](receipts/repair/native/pg-attempt1) |
| `g4-read-envelope-mysql-contracts` (port **65515**) | **5 / 5 green** | 3.48 s / 529.2 MiB | [native/mysql-attempt1.log](receipts/repair/native/mysql-attempt1.log), [native/mysql-attempt1/](receipts/repair/native/mysql-attempt1) |
| `g4-write-seed-batch 75000` | green, 100 seeds / 200 cells / 600 replays | 6.22 s / 964.5 MiB | [write-seed-batch-75000-attempt1.log](receipts/repair/write-seed-batch-75000-attempt1.log), [write-campaign/sqlite-75000/](receipts/repair/write-campaign/sqlite-75000) |
| `g4-write-transport-seed-batch 100000` | **red at cell 54** — see below | 4.22 s / 691.8 MiB | [write-transport-seed-batch-100000-attempt1.log](receipts/repair/write-transport-seed-batch-100000-attempt1.log), [write-transport-100000-red/](receipts/repair/write-transport-100000-red) |
| `g3-generated-transport-smoke` (G3's own registered mode) | **red, same signature at the same recipe offset** | — | [g3-transport-smoke-twin-attempt1.log](receipts/repair/g3-transport-smoke-twin-attempt1.log) |
| `g4-unit01-author` | **83 / 83 green** | — | [mode-g4-unit01-author-attempt1.log](receipts/repair/mode-g4-unit01-author-attempt1.log) |
| `g4-unit01-review` | **200 / 200 green** — the three finding-K probes of §14.5 are green now | — | [mode-g4-unit01-review-attempt1.log](receipts/repair/mode-g4-unit01-review-attempt1.log) |
| `g4-route-transactions` | 9 / 11; reds are `LX-04` and `LX-14`, both DIVERGENCE PINs for blocker B-1 | — | [mode-g4-route-transactions-attempt1.log](receipts/repair/mode-g4-route-transactions-attempt1.log) |
| `scripts/raptor3-campaign-receipts.test.mjs` | **39 / 39** | 0.35 s / 69.9 MiB | [campaign-receipts-selftest-attempt2.log](receipts/repair/campaign-receipts-selftest-attempt2.log) |
| `scripts/raptor3-cli.test.mjs` | **9 pass / 1 fail, no identity drift** | 222.48 s / 220.5 MiB | [raptor3-cli-selftest-attempt1.log](receipts/repair/raptor3-cli-selftest-attempt1.log) |
| `node scripts/run-typecheck.mjs` | clean apart from the two permitted Pattern TS2345 | 6.47 s / 5,934.8 MiB | [typecheck-attempt2.log](receipts/repair/typecheck-attempt2.log) |
| reviewer probes (13 cells) | 5 pass / 5 fail / 3 skipped | — | [review-probes-attempt1.log](receipts/repair/review-probes-attempt1.log) |

**Every native suite that shares the repaired `live-world.ts` was re-run**, on
the containers recorded in
[native/containers.txt](receipts/repair/native/containers.txt)
(`viborm-raptor3-g3-pg-20260914`, image `95206741…`, 0 restarts;
`viborm-raptor3-g3-mysql-20260914`, image `b3b90af2…`, 0 restarts):

| Mode | Result |
| --- | --- |
| `g2-pg-baseline` | 17 / 17 |
| `g2-pg-contracts` | 18 / 18 |
| `g25-pg-contracts` | 2 / 2 |
| `g27-pg-contracts` | 1 / 1 |
| `g3p02-pg-contracts` | 5 / 5 |
| `g3p03-pg-contracts` | 5 / 5 |
| `g3p04-pg-contracts` | 4 / 4 |
| `g3-scope-composition-pg` | 2 / 2 |
| `g29-member-dependency-pg` | 2 / 2 |
| `post-g3-clearability-pg-contracts` | 2 / 2 |
| `g2-mysql-baseline` | 13 / 13 |
| `g2-mysql-contracts` | **10 / 13** — the same three `unique-races-live-commands.test.ts` cells as §14.3, unchanged by this round |

Every log is `native/inherited-<mode>.log` under the repair receipts.

**The write-transport red is the candidate's, and this round proves it rather
than asserting it.** The child fails at
`g3-transport:script-shape; Unscripted statement: g3-c11-100027-0:recurrence-0;
actual=INSERT; expected=INSERT,SELECT`. G3's own registered
`g3-generated-transport-smoke` mode, which this stream did not touch, fails at
the **same** point with `g3-c11-8027-0:recurrence-0` — and
`100027 − 100000 = 27 = 8027 − 8000`. The two lanes reproduce the same recipe at
the same offset against the same production identity, so the defect is phase 2's
physical change (one statement where the scripted plan owes two), not
`G4_WRITE_TRANSPORT_CAMPAIGN`. It belongs to G4-02 and the lane needs a green
child at a settled `src/` before it counts as proven.

**The CLI self-test's single failure is the same `src/`.** "test:all cannot
replace the required lane through inherited specimen variables" fails on an
inner `test:all` of **11 failed / 747 passed** across
`tests/raptor3/g3/generation/generated-transport-smoke.test.ts` and
`tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts`.
Nothing registration-shaped; all three G4 cells are green, and this run — unlike
every attempt in §14.8 — held one identity end to end.

### 15.8 The reviewer's probes, each red explained

`node scripts/run-vitest-safe.mjs run --workspace=tests/raptor3/g4/review/witness-followup/review.workspace.ts tests/raptor3/g4/review/witness-followup/`
→ **5 passed / 5 failed / 3 skipped**
([review-probes-attempt1.log](receipts/repair/review-probes-attempt1.log)).
The probe files are the reviewer's and were not edited.

| Cell | Now | Why |
| --- | --- | --- |
| does not let an inherited seed count shrink a write child | **green** | §15.1 |
| sanitises the seed-count variable in the runner | **green** | §15.1 |
| pins the child cell count of every registered seed-batch mode | **green** | §15.2 |
| keeps the write ranges disjoint (control) | green | unchanged |
| records an identity on every run receipt (control) | green | unchanged |
| refuses a child that holds fewer seeds than the frozen batch | red | the shared assertion admits a short batch **by design** (§15.1); changing it would change G3 |
| was produced at the single harness identity the note names | red | the cell asserts the claim §14.8 made; that claim is **retracted** (§15.4), so the cell cannot pass |
| records every red against the production identity the note names | red | same — the claim is retracted, and the correct identity is in §15.4 |
| spells a datetime exactly as the MySQL adapter's literal does | red | the probe lifts the rule out of the fixture **by source text**; naming the arm broke the lift. The fact is pinned in-suite and green twice (§15.5) |
| leaves no unread background-failure listener | red | the listener is `PgDriver`'s; removing it needs a production edit this brief forbids (§15.6) |
| `native-pool-configuration.review.test.ts` (3 cells) | skipped | needs a live provider in the probe's own environment |

### 15.9 Note 11 — the disjointness cell no longer compares against a hand-kept three

`scripts/raptor3-campaign-receipts.test.mjs` derives `occupied` from the
manifest's own exports (descending one level so the three CS-03 extension
slices, which live in a map keyed by mode, are compared like any other lane)
and asserts at least 16 frozen ranges were found. A campaign constant added
later is compared without anyone remembering to add it. 39 / 39 still pass.

### 15.10 Patch, cost and what this round did not do

[`witness-harness-vs-0cc61e61.patch`](receipts/repair/witness-harness-vs-0cc61e61.patch)
is regenerated and **byte-current**: re-running the same `git diff` produces an
identical file, and the blob ids it records match `git hash-object` on the
working tree (`live-world.ts` `4b702c67`, `run-raptor3.mjs` `c9ccaf11`). It is
the cumulative diff of this stream's ten tracked files against `0cc61e61`;
`grep -c "^+++ b/src/"` is **0**. The untracked G4 files this round changed are
`tests/raptor3/g4/generation/write-campaign.test.ts`,
`write-transport-campaign.test.ts` and
`tests/raptor3/g4/native/read-envelope-native.test.ts`.

Not done, and named rather than left to be discovered:

1. **`g4.md` still does not carry the new lanes** (review finding 10). It is
   the integrator's file, not this stream's. The integrator needs:
   `G4_WRITE_CAMPAIGN` 75000–99999 and `G4_WRITE_TRANSPORT_CAMPAIGN`
   100000–124999 (batch 100, 3 replays, G3's quotas); modes `g4-write-seeds`,
   `g4-write-seed-batch`, `g4-write-transport-seeds`,
   `g4-write-transport-seed-batch`, `g4-unit01-author` (83 cells),
   `g4-unit01-review` (200 cells); and `G4_NATIVE_PROVIDER_COUNTS` = 5.
2. **Neither write parent mode has ever been executed** — 250 children each,
   unchanged from §14.9 claim 1.
3. **The `g2-mysql-contracts` reds and the two `route-transactions` `LX`
   DIVERGENCE PINs are not diagnosed** here, only re-measured.
4. **Free space is now 4.0 GiB** (`df`), against the ≈ 679 MB the two new
   families project for 250 children each. §14.4's recommendation stands and
   hardens: re-measure immediately before the campaign, and do not run a pair
   of 250-child campaigns beside any retained raw corpus.

**One Biome diagnostic was added, and it is named.**
`tests/raptor3/transitions/live-world.ts` goes from 16 to **17**: the teardown's
new `throw` trips `lint/correctness/noUnsafeFinally`, the same rule this file's
teardown already trips three times at the three `throw`s beside it — throwing
from that `finally` *is* the block's contract. The other changed files are
unmoved (`scripts/raptor3-manifest.mjs` 70, `scripts/run-raptor3.mjs` 37,
`scripts/raptor3-campaign-receipts.test.mjs` 54), the two write children still
report **0**, and the fifth native cell adds none (no diagnostic in
`read-envelope-native.test.ts` at or after its line 604). `biome check --write`
is still not run, for the import-reordering reason of §14.9 claim 7.

### 15.11 Unverified claims of this repair round

1. **That no `src/` file was edited by this stream.** The patch and the census
   agree, but another author was writing `src/` throughout; the production
   fingerprint moved once during this round (`b100ea77… → 7475621b…`) and is
   not this stream's.
2. **That `mysqlDateTime` and `toMySqlDateTime` will stay in agreement.** They
   agree today for four instants, measured against the adapter itself. The
   fixture still holds a copy; only a production export would remove it.
3. **That the `watchPgPool` listener would actually surface a real background
   pool failure.** No background failure was provoked; what is measured is that
   all **eleven** registered PostgreSQL modes stay green with the listener and
   the teardown rethrow in place.
4. **The disk projection** remains the extrapolation of §14.9 claim 2,
   unchanged and unmeasured beyond one child per lane.

## 16. Verification pass (round 3, after the follow-up was accepted)

Third run of this stream. The follow-up (§14) and its repair (§15) were
accepted by the independent reviewer at 06:22
([witness-followup-review-followup.md](../witness-followup-review-followup.md),
verdict **ACCEPT**). **This round edited nothing.** No production file, no
harness file, no test file: the only writes are
[receipts/followup-verify/](receipts/followup-verify) and this section. The
harness fingerprint reads
`7da70665d3c9ea9cb5e7b68620010584868ccd20951db8093d27407ada8e1a3c` at the first
and at the last capture of the round, which is the arithmetic proof of that
claim rather than an assertion of it.

**Why the round exists — corrected in §17.1 after the round-3 review, and
restated here so the two never disagree.** What this paragraph originally said
("§15.7 measured every accepted claim at production `7475621b…`; the phase-2
author has kept landing `src/` since, so the integrator would otherwise carry
numbers taken against a tree that no longer exists") is **contradicted by this
round's own receipts** and is withdrawn. What the receipts say: production was
**still `7475621b…`** at this round's opening bracket and in every run receipt
below, so §16 re-measured the accepted claims at the **same** production
identity §15.7 already covered. The only identity that had moved since §15.7 was
the harness half, and it moved because the *round-2 reviewer* added a probe file
(their own `identity-after.json` records it). Production then moved once,
**mid-round**, at 07:52, and no table row was re-taken after it — so §16 closes
at an identity none of its numbers belong to, which is the condition it was
written to remove and the same class of error §15.4 was a must-fix for.
Everything below is therefore an accurate re-measurement at `7475621b…`, not at
the closing identity. The claim set at the closing identity `a830d713…` is
measured in **§17**, and was measured independently by the round-3 reviewer
([witness-followup-review3-receipts/](../witness-followup-review3-receipts)).

### 16.1 Identity

| Bracket | Production | Harness | Receipt |
| --- | --- | --- | --- |
| Opening, 07:49 | `7475621b…` | `7da70665…` | [identity-before.json](receipts/followup-verify/identity-before.json) |
| Before CLI attempt 2, 08:00 | `a830d713…` | `7da70665…` | [identity-before-cli-attempt2.json](receipts/followup-verify/identity-before-cli-attempt2.json) |
| Closing, 08:05 | `a830d713…` | `7da70665…` | [identity-after.json](receipts/followup-verify/identity-after.json) |

Production moved exactly once, **inside CLI attempt 1**: the phase-2 author
wrote `src/query-engine/raptor3/shared/operation-context.ts` at 07:52. Every run
in §16.2 except the two CLI attempts carries production `7475621b…` / harness
`7da70665…`, read out of each run's own `attempt.json` / `verified.json` rather
than assumed. Blocker 2 of §14.8 (identity drift under concurrent streams) is
therefore still active, and it cost this round one CLI attempt.

**The consequence this table originally left implicit** (round-3 review,
must-fix 1): the opening bracket `7475621b…` is the identity §15.7 already
measured at, so §16.2 re-measured nothing new; and because no row was re-taken
after 07:52, the closing bracket `a830d713…` names an identity that **no row in
§16.2 was measured at**. A reader must not read §16.2 as "the numbers at
`a830d713…`". Those numbers are in §17.3 and in the round-3 reviewer's own
receipts.

### 16.2 Measured results

| Command | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g4-read-envelope-pg-contracts` (port **65504**) | **5 / 5** — four provider cells and the provider-free adapter pin | 3.92 s / 529.8 MiB | [native/pg-attempt1.log](receipts/followup-verify/native/pg-attempt1.log) |
| `g4-read-envelope-mysql-contracts` (port **65515**) | **5 / 5** — the same four-plus-one split | 3.74 s / 529.5 MiB | [native/mysql-attempt1.log](receipts/followup-verify/native/mysql-attempt1.log) |
| `g4-unit01-author` | **83 / 83**, gate verified | 4.38 s / 686.1 MiB | [mode-g4-unit01-author-attempt1.log](receipts/followup-verify/mode-g4-unit01-author-attempt1.log) |
| `g4-unit01-review` | **200 / 200**, gate verified | 5.63 s / 726.5 MiB | [mode-g4-unit01-review-attempt1.log](receipts/followup-verify/mode-g4-unit01-review-attempt1.log) |
| `g4-write-seed-batch 75000` | green — 100 seeds / 200 cells / 600 replays | 6.69 s / 927.4 MiB | [write-seed-batch-75000-attempt1.log](receipts/followup-verify/write-seed-batch-75000-attempt1.log), [write-campaign/sqlite-75000/](receipts/followup-verify/write-campaign/sqlite-75000) |
| `g4-write-transport-seed-batch 100000` | **red, kept red** | — | [write-transport-seed-batch-100000-attempt1.log](receipts/followup-verify/write-transport-seed-batch-100000-attempt1.log), [write-transport-100000-red/](receipts/followup-verify/write-transport-100000-red) |
| `g3-generated-transport-smoke` (G3's own, untouched) | **red at the same recipe offset** | — | [g3-transport-smoke-twin-attempt1.log](receipts/followup-verify/g3-transport-smoke-twin-attempt1.log) |
| `scripts/raptor3-campaign-receipts.test.mjs` | **39 / 39** | 0.39 s / 67.5 MiB | [campaign-receipts-selftest-attempt2.log](receipts/followup-verify/campaign-receipts-selftest-attempt2.log) |
| `scripts/raptor3-cli.test.mjs` | **9 pass / 1 fail, zero drift** | 227.04 s / 220.2 MiB | [raptor3-cli-selftest-attempt2.log](receipts/followup-verify/raptor3-cli-selftest-attempt2.log) |
| `node scripts/run-typecheck.mjs` | clean apart from the two permitted Pattern TS2345 | 6.91 s / 5,841.8 MiB | [typecheck-attempt1.log](receipts/followup-verify/typecheck-attempt1.log) |

**Two receipts are kept failed and unrelabelled.** The first receipts self-test
invocation was refused at the workspace lock another stream held
([attempt 1](receipts/followup-verify/campaign-receipts-selftest-attempt1.log)).
CLI attempt 1 is **6 pass / 4 fail**
([log](receipts/followup-verify/raptor3-cli-selftest-attempt1.log)): three of
the four failures are `Stale Raptor 3 evidence` raised by the mid-run `src/`
write above, the fourth is the `test:all` cell below, and **all three G4 cells
are green in it**. Attempt 2, run after production settled, holds one identity
end to end — `grep -c "Stale Raptor 3 evidence"` over it is **0**.

**The single CLI failure is not this stream's and has not changed shape.**
`test:all cannot replace the required lane through inherited specimen variables`
fails on an inner `test:all` of **11 failed / 747 passed** across
`core-structure/measurement/extension-campaign.selftest.test.ts` (CS-03 seeds
7133–7313) and `g3/generation/generated-transport-smoke.test.ts` — the same two
files, the same counts as §15.7.

### 16.3 What the phase-2 landing changed, and what it did not

- **The PostgreSQL `42883` of §14.2 is gone — and it was already gone in §15,
  which is where the phase-2 landing that closed it belongs.** The recursive fit
  lowers on PostgreSQL 16.14 and `g4-read-envelope-pg-contracts` is 5/5
  including `g4-native-recursive-read-fit`. **Unchanged since §15.7**, which
  recorded the same 5/5 "including the recursive fit", and §15.4 consequence 2,
  which says of the `42883` in as many words that "it is not red now at all".
  Relative to §14.2 it is a change; relative to the accepted record it is not,
  and the integrator must associate it with the phase-2 landing that preceded
  §15.7, not with this round (round-3 review, must-fix 2).
- **The three finding-K probes of §14.5 are green — also unchanged since
  §15.7.** `g4-unit01-review` is **200 / 200**, so the three
  `competing-refusals` / `refusal-order-history` cells that §14.5 registered
  red-on-purpose pass. §15.7 already records "200 / 200 — the three finding-K
  probes of §14.5 are green now". This is exactly the behaviour that
  registration was for: the mode turned green on its own when phase 2 landed,
  and nobody had to remember to add the cells — but the turn happened before
  §15.7, not here.
- **The write-transport red did not move.** The child still fails at
  `g3-transport:script-shape; Unscripted statement: g3-c11-100027-0:recurrence-0;
  actual=INSERT; expected=INSERT,SELECT`, and G3's own untouched
  `g3-generated-transport-smoke` still fails at `g3-c11-8027-0:recurrence-0` —
  offset 27 in both lanes. The attribution of §15.7 reproduces at the new
  production identity: the red belongs to the generated-transport path in
  `src/`, not to `G4_WRITE_TRANSPORT_CAMPAIGN`. **Integrator request 5 stands.**

### 16.4 Registration re-confirmed against the files

- `tests/raptor3/g4/route-transactions.test.ts`: registered **11**, file holds
  **11**. Confirmed against the source, not against §14.6.
- `G4_UNIT01_AUTHOR_COUNTS` sums to **83**, and the mode ran 83/83;
  `g4-unit01-review` ran 200/200 across 29 files.
- **No G4 suite leaks into the credential-free estate**: filtering the computed
  `EXTENDED_LOCAL_TESTS` for `tests/raptor3/g4/` returns **0** files.
- The archive branch is still correct for the write lanes:
  `archiveG3GeneratedCorpus` on the green SQLite child writes a `replayCommand`
  that carries **no** `--subject`
  ([log](receipts/followup-verify/write-campaign/sqlite-75000-archive.log)),
  which is the repaired behaviour of §15.3.

### 16.5 Cost and disk

Incremental core and complete charged cost: **0 LOC / 0 parser tokens / 0
bytes** — no file outside `docs/` was written, and `captureRaptor3Identity()`
excludes `docs/`, which is why the harness half is identical at both brackets.

Disk: **6.4 GiB** free at the start, **6.3 GiB** at the end. Both retained
corpora are compressed (1,192,711 B and 373,048 B); no raw corpus is retained.
The §14.4 warning holds and hardens: the volume has not recovered, and the two
write families still project at ≈ 679 MB against ~6 GiB.

**Half that projection is unverified at the current tree** (round-3 review,
note 4). Its SQLite half rests on a child that reproduces byte-for-byte at every
identity since §14 (62,116,444 B raw, 1,192,711 B gzip — §17.3). Its transport
half rests on §14.4's 200-cell transport child, which was measured **green at
production `d844ae0f…`** and which the lane has not reproduced since: the lane
is red at `7475621b…` (§15.7, §16.2), at `a830d713…` in the round-3 review, and
at `a830d713…` in §17.3. Until integrator request 5 closes and a transport child
is green again, read ≈ 679 MB as one measured lane plus one lane whose per-child
cost cannot currently be re-measured.

### 16.6 Unverified claims of this round

1. **That the phase-2 tree is settled.** Production was stable for the 12
   minutes spanning CLI attempt 2, but another stream is still writing `src/`;
   the numbers above are a snapshot at `a830d713…`, not a frozen identity.
2. **The two write parent modes are still unexecuted** (250 children each).
   §14.9 claim 1 is unchanged — one child per lane, and the transport lane's is
   red.
3. **The disk projection is still the linear extrapolation** of §14.9 claim 2,
   and its transport half rests on a child that no longer reproduces — see the
   qualification added to §16.5. The two halves are not alike and this claim
   originally implied they were.
4. **The `test:all` inner failures were not diagnosed here**, only matched by
   signature to the ones §15.7 recorded.
5. **The `g2-mysql-contracts` reds of §14.3 were not re-run this round**; only
   the two G4 native modes were. Their §15.7 status is carried forward, not
   re-measured.

## 17. Repair (after the round-3 review)

Fourth run of this stream. The round-3 review
([witness-followup-review-followup-2.md](../witness-followup-review-followup-2.md),
verdict **REVISE**, 08:30) accepted the substance — "everything the brief asked
for is present, and every deliverable reproduces at the current production
identity" — and rejected the **record**: three must-fix, seven notes, none
blocking. Every one is answered below, and the receipts of this round are
[receipts/repair2/](receipts/repair2).

**What this round edited.** No production file. No harness file, with one
deliberate exception that was reverted and byte-verified inside the same
command: the note-6 falsification of §17.6, which deleted one line of
`scripts/credential-free-test-manifest.mjs`, ran the self-test, restored the
file from a scratchpad backup and re-ran it. `shasum -a 256` before and after is
`8f4a447c…` in both cases
([note6-restore-verify.log](receipts/repair2/note6-restore-verify.log)), and the
regenerated cumulative patch is byte-identical to the stored one (§17.9).

The prose changed in exactly five places, all under `docs/`: the §16 preamble,
§16.1, §16.2's two native rows and §16.3's first two bullets (corrected in
place, each saying what it used to say); the §14.6 and §16.5 / §16.6
qualifications; this section; `receipts/followup-verify/README.md`; and
`handoff.md` §6.2 and its integrator requests, so the integrator's own sheet
does not keep a superseded identity.

**Every finding, and where it is answered.**

| Finding | Status | Where |
| --- | --- | --- |
| must-fix 1 — §16's purpose contradicted by §16's receipts | **repaired** | §16 preamble and §16.1 corrected in place; `followup-verify/README.md` corrected; the missing measurement supplied in §17.4 and audited in §17.1 |
| must-fix 2 — the two "changes" are already in the accepted record | **repaired** | §16.3 bullets 1 and 2 rewritten in place; §17.2 |
| must-fix 3 — the untracked corpus has no recorded bytes | **repaired** | per-round byte snapshot under `receipts/repair2/corpus/`; §17.3 |
| note 4 — half the disk projection rests on an unreproducible child | **repaired** | §16.5 and §16.6 claim 3 qualified in place; §17.6 item 1 |
| note 5 — "5 / 5" is four provider cells plus one provider-free pin | **repaired** | §16.2 rows, `followup-verify/README.md`, `handoff.md` §6.2; §17.6 item 2 |
| note 6 — the review suites are excluded by only one of two mechanisms | **answered, change declined** | §17.6 item 3 — falsified instead: the guard the reviewer wants already exists as a self-test cell, and a duplicated exclusion would be a guard with no unique coverage. One line, this stream's to add if Arnaud prefers it |
| note 7 — the far end of both write ranges was never exercised | **acknowledged, nothing to repair** | §17.6 item 4 |
| note 8 — the write lanes break the twin-range convention | **recorded for the integrator** | §17.6 item 5 — changing a frozen range is Arnaud's decision |
| note 9 — blocker 2 is still live | **sharpened and escalated** | §17.8, and `handoff.md` request 7 |
| note 10 — the §14.6 census total is stale | **repaired** | §14.6 corrected in place, re-derived in `registration-totals.json`; §17.6 item 7 |

### 17.1 Must-fix 1 — the §16 narrative, against §16's own receipts

The review is right and the correction is landed in place: the §16 preamble now
withdraws its stated reason, and §16.1 now states the consequence it left
implicit. What the receipts say, walked rather than recalled:

| Receipt | production | harness |
| --- | --- | --- |
| `repair/identity-after-repair.json` and every §15.7 run receipt | `7475621b…` | `ebe1f7e6…` |
| `../witness-followup-review2-receipts/identity-before.json` (round-2 review open) | `7475621b…` | `ebe1f7e6…` |
| `../witness-followup-review2-receipts/identity-after.json` (round-2 review close) | `7475621b…` | `7da70665…` |
| `followup-verify/identity-before.json` (§16 open) | `7475621b…` | `7da70665…` |
| every `followup-verify/**/{attempt,verified}.json` | `7475621b…` | `7da70665…` |
| `followup-verify/identity-after.json` (§16 close) | **`a830d713…`** | `7da70665…` |

So production had **not** moved between §15.7 and §16; the only difference at
§16's opening bracket was the harness half, and that moved because the round-2
*reviewer* added a probe file. §16 therefore re-measured the accepted claims at
the identity §15.7 already covered, production moved once mid-round at 07:52,
and no row was re-taken after it. That is the same class of error §15.4 was a
must-fix for, and stating it is the repair.

**The missing measurement is supplied twice.** The round-3 reviewer measured
every accepted claim at `a830d713…`
([witness-followup-review3-receipts/](../witness-followup-review3-receipts)),
and §17.4 below measures them again at `a830d713…` from this stream's side.
Every run receipt of this round carries production `a830d713…` — the identity
this round also closes at — and that is arithmetic, not narrative:
[identity-audit.json](receipts/repair2/identity-audit.json) applies the two
properties the reviewer's probe asserts to this round's own receipt set and
reports `everyReceiptAtTheClosingProduction: true`,
`measuredAtADifferentProductionThanThePriorRound: true`, one production
fingerprint seen across all 13 run receipts.

### 17.2 Must-fix 2 — both "changes" were already in the accepted record

Corrected in place in §16.3. The PostgreSQL `42883` closure and the three green
finding-K probes are **unchanged since §15.7**, which records both, and §15.4
consequence 2 already says the `42883` "is not red now at all". Relative to
§14.2 / §14.5 they are changes; relative to the accepted record they are not.
The integrator must associate the recursive-fit closure with the phase-2 landing
that preceded §15.7, not with §16 — that is what tells them which landing to
credit. §16.3's unverifiable clause "nothing in the fixture changed" is deleted
rather than softened: §15.5 did edit that fixture, and until this round nothing
recorded its bytes (§17.3).

### 17.3 Must-fix 3 — the untracked corpus now has recorded bytes

`tests/raptor3/g4/**` is untracked, so no patch covers it and no round had ever
recorded what it contained. This round writes a byte snapshot, per round, into
its own receipts — nothing staged, nothing committed:

| Receipt | What it holds |
| --- | --- |
| [corpus/g4-corpus-open.sha256](receipts/repair2/corpus/g4-corpus-open.sha256), [.json](receipts/repair2/corpus/g4-corpus-open.json) | all **132** files / **809,721 B** at the opening bracket, `sha256 + bytes + owner` per file |
| [corpus/g4-corpus-close.sha256](receipts/repair2/corpus/g4-corpus-close.sha256), [.json](receipts/repair2/corpus/g4-corpus-close.json) | the same tree at the closing bracket, **139** files / 845,179 B |
| [corpus/g4-corpus-delta.json](receipts/repair2/corpus/g4-corpus-delta.json) | the difference: **7 files added, 0 removed, 0 changed**, every one of them another stream's under `review/unit02-phase2/`; `witnessOwnedUnchanged: true`, and this stream's 66 files still total exactly 438,320 B |
| [corpus/unit01-source-worktree.sha256](receipts/repair2/corpus/unit01-source-worktree.sha256) | the **43** files of `/private/tmp/viborm-g4-unit01`, hashed, so the landing claim survives that worktree |
| [corpus/landed-vs-unit01-worktree.json](receipts/repair2/corpus/landed-vs-unit01-worktree.json) | 42 identical, **1** differing — `review/unit01-followup2/cursor-refusal.test.ts`, 1,574 → **1,670 B**, the TS2638 repair and nothing else |

Ownership at the opening bracket, from the same snapshot: this stream 66 files /
438,320 B; the witness reviewers 23 / 81,572; the unit02/unit03 reviewers 21 /
124,173; the G4-02 author 17 / 107,059; the route author 5 / 58,597.

What this makes checkable that was not: the landed-vs-worktree comparison no
longer depends on `/private/tmp/viborm-g4-unit01` existing; any later round can
diff its own snapshot against this one; and a claim of the form "nothing in the
fixture changed" is either provable from two snapshots or must not be made. The
§14 bytes of `read-envelope-native.test.ts` are still gone — no snapshot can be
taken retroactively — which is why §16.3's clause was deleted rather than
restated.

### 17.4 Measured results — every row at production `a830d713…`

Containers unchanged and recorded in
[native/containers.txt](receipts/repair2/native/containers.txt)
(`viborm-raptor3-g3-pg-20260914`, image `95206741…`, 0 restarts;
`viborm-raptor3-g3-mysql-20260914`, image `b3b90af2…`, 0 restarts).

| Command | Result | Wall / peak RSS | Harness at the run | Receipt |
| --- | --- | --- | --- | --- |
| `g4-read-envelope-pg-contracts` (port **65504**) | **5 / 5** — four provider cells and the provider-free adapter pin | 3.87 s / 531.4 MiB | `32af4729…` | [native/pg-attempt1.log](receipts/repair2/native/pg-attempt1.log), [native/pg-attempt1/](receipts/repair2/native/pg-attempt1) |
| `g4-read-envelope-mysql-contracts` (port **65515**) | **5 / 5**, same split | 3.76 s / 525.7 MiB | `32af4729…` | [native/mysql-attempt1.log](receipts/repair2/native/mysql-attempt1.log), [native/mysql-attempt1/](receipts/repair2/native/mysql-attempt1) |
| `g4-unit01-author` | **83 / 83**, gate verified | 4.36 s / 686.8 MiB | `32af4729…` | [mode-g4-unit01-author-attempt1.log](receipts/repair2/mode-g4-unit01-author-attempt1.log) |
| `g4-unit01-review` | **200 / 200** over 29 files, gate verified | 5.61 s / 713.2 MiB | `32af4729…` | [mode-g4-unit01-review-attempt1.log](receipts/repair2/mode-g4-unit01-review-attempt1.log) |
| `g4-write-seed-batch 75000` | green — 100 seeds / 200 cells / 600 replays, **C08–C11 50 / 50 / 50 / 50**, 40 two-actor, 40 overlap, 40 faults; corpus **62,116,444 B** raw, gzip **1,192,711 B** | 6.70 s / 947.4 MiB | `32af4729…` | [write-seed-batch-75000-attempt1.log](receipts/repair2/write-seed-batch-75000-attempt1.log), [write-campaign/sqlite-75000/](receipts/repair2/write-campaign/sqlite-75000) |
| `archiveG3GeneratedCorpus` on that child | receipt carries **no `--subject`** — the repaired branch of §15.3 | — | `32af4729…` | [write-campaign/sqlite-75000-archive.log](receipts/repair2/write-campaign/sqlite-75000-archive.log) |
| `g4-write-seed-batch 75100` | green; raw 56,431,197 B, gzip 1,078,542 B; restored sha256 `1e1d4736…` matches the archive receipt | 6.76 s / 729.7 MiB | `eabbb531…` | [write-seed-batch-75100-attempt1.log](receipts/repair2/write-seed-batch-75100-attempt1.log), [write-campaign/sqlite-75100/](receipts/repair2/write-campaign/sqlite-75100) |
| `g4-write-seed-batch 75200` | green (generated for the replay attempt of §17.8) | 6.97 s / 927.6 MiB | `d8ac2a49…` | [write-seed-batch-75200-attempt1.log](receipts/repair2/write-seed-batch-75200-attempt1.log) |
| `g4-write-transport-seed-batch 100000` | **red, kept red** — `g3-transport:script-shape; Unscripted statement: g3-c11-100027-0:recurrence-0; actual=INSERT; expected=INSERT,SELECT` | 4.58 s / 690.8 MiB | `00ddf938…` | [write-transport-seed-batch-100000-attempt1.log](receipts/repair2/write-transport-seed-batch-100000-attempt1.log), [write-transport-100000-red/](receipts/repair2/write-transport-100000-red) |
| `g3-generated-transport-smoke` (G3's own, untouched) | **red at `g3-c11-8027-0:recurrence-0`** — offset 27 in both lanes | 4.16 s / 573.0 MiB | — | [g3-transport-smoke-twin-attempt1.log](receipts/repair2/g3-transport-smoke-twin-attempt1.log) |
| `scripts/raptor3-campaign-receipts.test.mjs` | **39 / 39** | 0.39 s / 67.6 MiB | — | [campaign-receipts-selftest-attempt1.log](receipts/repair2/campaign-receipts-selftest-attempt1.log) |
| `node scripts/run-typecheck.mjs` | clean apart from the two permitted Pattern TS2345 at `pack.ts:1443` and `:2633` | 6.89 s / 5,881.2 MiB | — | [typecheck-attempt1.log](receipts/repair2/typecheck-attempt1.log) |
| `scripts/raptor3-cli.test.mjs` | **7 pass / 3 fail** — two are `Stale Raptor 3 evidence` from another stream's mid-run harness writes, one is the `test:all` cell; **all three G4 cells green** | 223.54 s / 208.6 MiB | drifting, §17.5 | [raptor3-cli-selftest-attempt1.log](receipts/repair2/raptor3-cli-selftest-attempt1.log) |

The corpus of the 75000 child is **the same length as §14, §16 and the round-3
reviewer's** (62,116,444 B) and its gzip is the same 1,192,711 B, but its
sha256 is `6aecc8f4…` where §16's archive receipt says `1b926e74…`: the corpus
embeds the executed-source identity in its own header, and the two identities
are the same length, so a corpus is length-stable and hash-unstable across
identities by construction. The quotas, not the hash, are what the receipt
asserts, and they are identical.

**The CLI self-test's three failures, each attributed.** Two are drift:
`saved evidence with a stale identity…` failed on harness `3732429f… →
eabbb531…` and `completed G2 progress survives watchdog termination…` on
`eabbb531… → 3732429f…`, both raised by the `review/unit02-phase2/` writes of
§17.5. The third is the known `test:all` cell, whose inner run is **11 failed /
747 passed** across `core-structure/measurement/extension-campaign.selftest.test.ts`
(CS-03 seeds 7133–7313) and `g3/generation/generated-transport-smoke.test.ts` —
the same two files and the same counts as §15.7 and §16.2. Across §15, §16, the
round-3 review and this round the three G4 cells are green in **every** attempt.

### 17.5 Identity — the brackets, and the arithmetic of the harness half

| Bracket | Production | Harness | Receipt |
| --- | --- | --- | --- |
| Opening, 08:33 | `a830d713…` | `32af4729…` | [identity-before.json](receipts/repair2/identity-before.json) |
| Before the CLI self-test, 08:39 | `a830d713…` | `c1dcb19d…` | [identity-before-cli.json](receipts/repair2/identity-before-cli.json) |
| After the CLI self-test, 08:43 | `a830d713…` | `eabbb531…` | [identity-after-cli.json](receipts/repair2/identity-after-cli.json) |
| Closing, 08:50 | `a830d713…` | `0892edc1…` | [identity-after.json](receipts/repair2/identity-after.json) |
| After the last edit, 08:57 | `a830d713…` | `5ef4ad2b…` | [identity-final.json](receipts/repair2/identity-final.json) |

**Production held `a830d713…` end to end**, and so does every run receipt — the
condition §16 could not state. Between the closing bracket and the final capture
this round wrote only `docs/`, which `captureRaptor3Identity()` does not read.

**The harness half is not a stable number this round and no claim is made that
it is.** It moved at least eleven times — twelve distinct fingerprints were
observed (`32af4729…`, `e75aa05f…`, `00ddf938…`, `c1dcb19d…`, `3732429f…`,
`eabbb531…`, `d8ac2a49…`, `85895c70…`, `0892edc1…`, `2587835d…`, `1c82ca9d…`,
`5ef4ad2b…`), twice inside a single 12-second command, **and none of it is this
stream's.** The final bracket therefore records the *invariant* rather than the
value: [identity-final.json](receipts/repair2/identity-final.json) captures the
identity and the delta proof in one process, so the two cannot disagree, and
reports `reproducesOpeningHarness: true` over `keptFiles: 420`. Another stream
created, rewrote and deleted files under
`tests/raptor3/g4/review/unit02-phase2/` throughout the round
(`review.workspace.ts` 08:36, `arithmetic-parity.review.test.ts` 08:37,
`counted-slot.review.test.ts` 08:38, `tmp-diagnostic.test.ts` created 08:38 and
deleted 08:45 — a deletion moves the fingerprint and leaves no mtime,
`root-create-fold.review.test.ts` 08:49, and six more by 08:57 — **ten files**
in that directory at the final capture). This is stated as arithmetic rather
than as attribution: [harness-delta-proof.json](receipts/repair2/harness-delta-proof.json)
at the closing bracket,
[harness-delta-proof-final.json](receipts/repair2/harness-delta-proof-final.json)
after it and the `harnessDelta` block inside
[identity-final.json](receipts/repair2/identity-final.json) — produced by
[harness-delta.mjs](receipts/repair2/harness-delta.mjs) and
[final-bracket.mjs](receipts/repair2/final-bracket.mjs) — recompute the harness
fingerprint over everything `captureRaptor3Identity()` reads (424 files, then
427, then 430) with that stream's directory excluded, and **every one of them
gets `32af4729…`, this round's opening harness, exactly**. The **420** harness
files that are not theirs are byte-identical from the opening bracket to the
final capture, which is the claim "this round edited no harness file" reduced to
a hash comparison.
The corpus delta of §17.3 says the same thing from the file side, and the
regenerated patch (§17.9) from the tracked side.

### 17.6 The seven notes, each answered

1. **Note 4 — half the disk projection rests on a child that no longer
   reproduces.** Qualified in place at the end of §16.5 and in §16.6 claim 3:
   the SQLite half reproduces byte-for-byte at three identities, the transport
   half was measured green only at `d844ae0f…` and the lane is red at every
   identity since. Re-measure when integrator request 5 closes.
2. **Note 5 — "5 / 5" is four provider cells plus one provider-free pin.** The
   clause is added to the §16.2 rows and used in §17.4. The pin itself the
   reviewer widened to 406 instants and found no divergence.
3. **Note 6 — the second exclusion is not added, and the reason is measured.**
   The reviewer asks for `...G4_UNIT01_REVIEW_TESTS` in `extendedLocalExclusions`
   beside its sibling, calling it "idempotent with the walk skip". A guard whose
   unique coverage cannot be named is exactly what this estate forbids, so
   instead of adding one the question was **falsified**: the walk skip line
   `file.startsWith("tests/raptor3/g4/review/")` was deleted from
   `scripts/credential-free-test-manifest.mjs`, and
   `EXTENDED_LOCAL_TESTS` jumped from 251 files with 0 under `tests/raptor3/g4/`
   to **321 files with 70**, while the receipts self-test cell *G4 suites stay
   outside credential-free discovery while they are red* — which spreads
   `G4_UNIT01_REVIEW_TESTS` through `G4_FIXED_SUITES`
   (`scripts/raptor3-campaign-receipts.test.mjs:957`, the spread at `:967`, asserted by the cell at `:970`) —
   turned red: **38 pass / 1 fail**
   ([note6-falsify-walk-skip-attempt1.log](receipts/repair2/note6-falsify-walk-skip-attempt1.log)).
   The file was then restored from a scratchpad backup, verified byte-identical
   by `shasum -a 256` (`8f4a447c…`), and the self-test re-run: 251 files, 0 G4,
   **39 / 39**
   ([note6-restore-verify.log](receipts/repair2/note6-restore-verify.log)). So
   the fact has one authority (the walk skip) and one falsifier (the self-test
   cell), the falsifier fires the moment a later stream narrows the walk, and a
   duplicated exclusion would add nothing but a second place to be wrong. If
   Arnaud prefers the duplication anyway it is one line and this stream will add
   it — recorded as a decision, not a refusal.
4. **Note 7 — the far end of both write ranges.** Nothing to repair; the
   reviewer's 99900 child and domain probe close a risk this stream had left
   open, and §14.9 claim 1 / §16.6 claim 2 should be read with them cited:
   `generateG3Recipe(124999)` is admitted, `125000` refused, and the last legal
   SQLite child is green with identical quotas.
5. **Note 8 — the write lanes break the twin-range convention.** Recorded for
   the integrator rather than changed: `G1`, `G2`, `G3` and `G3P06` give their
   SQLite and transport campaigns the **same** range, so their transport lanes
   re-run the SQLite lanes' recipes under scripted profiles. The G4 **read**
   lanes broke that first (20000 vs 50000) and the brief prescribed the same
   shape for the write lanes (75000–99999 vs 100000–124999). Consequence: the
   two write lanes are not comparable cell-for-cell the way G3's are, and the
   pair consumes 50,000 seed IDs rather than 25,000. Changing it is a frozen
   range change and therefore Arnaud's, not this stream's.
6. **Note 9 — blocker 2.** Sharpened and escalated in §17.8: over four rounds
   and three reviews it has never been quiet, and this round it denied the
   replay gate as well as the CLI self-test.
7. **Note 10 — the §14.6 census total.** Corrected in place and re-derived from
   the manifest rather than from the review:
   [registration-totals.json](receipts/repair2/registration-totals.json) reports
   **55 registered fixed files / 392 cells**, 54 / 387 excluding the native file,
   whose 5 cells run in each native mode; `route-transactions` registered 11 and
   declaring 11; `G4_UNIT01_AUTHOR_COUNTS` 83 and `G4_UNIT01_REVIEW_COUNTS` 200;
   **0** registered-but-absent files; `EXTENDED_LOCAL_TESTS` 251 with **0** under
   `tests/raptor3/g4/`.

### 17.7 The reviewer's probes, re-run, each outcome explained

| Probe set | Now | Why |
| --- | --- | --- |
| round 3, `review/witness-followup3/` (18 cells) | **16 pass / 2 fail**, before the repairs ([attempt 1](receipts/repair2/review-probes-round3-attempt1.log)) and identically after them ([attempt 3](receipts/repair2/review-probes-round3-attempt3.log); [attempt 2](receipts/repair2/review-probes-round3-attempt2.log) is kept failed — refused at the workspace lock) | the two reds are finding 1 and **cannot go green**: they assert properties of the `followup-verify/` receipt set, which is historical. Making them pass would mean rewriting a receipt. The properties they demand hold for this round's receipt set instead — [identity-audit.json](receipts/repair2/identity-audit.json) |
| round 1, `review/witness-followup/` (13 cells) | **5 pass / 5 fail / 3 skipped** ([log](receipts/repair2/review-probes-round1-attempt1.log)) | unchanged from §15.8, cell for cell |
| round 1, `native-pool-configuration.review.test.ts` with a provider | **all 3 green** — 1 pg cell ([log](receipts/repair2/review-probes-round1-pool-pg-attempt1.log)), 2 mysql cells ([log](receipts/repair2/review-probes-round1-pool-mysql-attempt1.log)) | §15.8 could only record them skipped; supplying `VIBORM_RAPTOR3_PROVIDER` closes that row |
| round 2, `review/witness-followup2/` | **1 / 1 green** with a live provider ([log](receipts/repair2/review-probes-round2-attempt2.log)); skipped without one ([log](receipts/repair2/review-probes-round2-attempt1.log)) | this re-verifies the round-3 review's unverified claim 4 — a **provoked** background pool failure does fail the run |

### 17.8 Blocker — the replay gate cannot close while another stream writes the harness

**Minimized failure.** `archiveG3GeneratedCorpus` → `restoreCommand` →
`replayCommand`, run verbatim from the receipt, fails at
`tests/raptor3/gate.test.ts` with `Stale Raptor 3 evidence: executed source or
runtime changed`, production equal on both sides, harness different.

**Attempts, all kept failed and unrelabelled.**

| Attempt | Outcome | Receipt |
| --- | --- | --- |
| 1, on the 75000 child | restore OK; replay red, harness `32af4729… → e75aa05f…` | [write-corpus-gate-replay-attempt1.log](receipts/repair2/write-corpus-gate-replay-attempt1.log) |
| 2, on a fresh 75100 child | **refused at the workspace lock** another stream's Vitest held; restored sha256 `1e1d4736…` matches the receipt | [write-corpus-gate-replay-attempt2.log](receipts/repair2/write-corpus-gate-replay-attempt2.log) |
| 3, the same corpus after the lock cleared | replay red, harness `eabbb531… → d8ac2a49…` | [write-corpus-gate-replay-attempt3.log](receipts/repair2/write-corpus-gate-replay-attempt3.log) |
| 4, child → archive → restore → replay in one ~12 s window | replay red, harness `d8ac2a49… → 85895c70…` | [write-corpus-gate-replay-attempt4.log](receipts/repair2/write-corpus-gate-replay-attempt4.log) |

**This is the gate working, not a defect in the lane**: a corpus records the
identity it was produced at, and the other stream's writes move that identity
between production and replay. Three attempted repairs (wait for the lock,
re-restore, collapse the window to 12 s) did not clear it, so by the stop rules
it is recorded as a blocker rather than attempted a fourth way. What **is**
proven here: the archive receipt carries no `--subject` (§17.4), the restore
half round-trips byte-for-byte twice (`1e1d4736…` both times), the archive
branch's refusals are covered hermetically by the 39/39 self-test, and the full
archive → restore → replay path was green end to end at this same production
identity in the round-3 review
([write-corpus-gate-replay-attempt1.log](../witness-followup-review3-receipts/write-corpus-gate-replay-attempt1.log)).
The blocker is environmental and belongs to the integrator: **the replay gate
and the CLI self-test cannot both be clean until the implementation streams stop
writing `tests/raptor3/**` and `scripts/**`.**

### 17.9 Patch, cost and disk

[`witness-harness-vs-0cc61e61.patch`](receipts/repair2/witness-harness-vs-0cc61e61.patch)
is regenerated over the same ten tracked files and is **byte-identical** to the
one stored under `receipts/repair/` — 88,236 B, `cmp` exit 0,
`grep -c '^+++ b/src/'` = **0**, and the working-tree blob ids are unchanged
(`live-world.ts` `4b702c67`, `run-raptor3.mjs` `c9ccaf11`, and the other eight in
[patch-verification.txt](receipts/repair2/patch-verification.txt)). The
falsification of §17.6 is invisible in it, which is the point of doing it
against a backup copy.

Incremental core and complete charged cost: **0 LOC / 0 parser tokens / 0
bytes**. The charged file list is `src/`-only, the patch contains no `src/` file,
and `scripts/query-engine-structure.mjs` was not re-run because an empty `src/`
delta can only re-measure another stream's absolute figures.

Disk: **6.0 GiB** free at both brackets, and **5.1 GiB** at the final capture
six minutes later, none of that this stream's — four write children were
generated here and their raw corpora (62.1, 56.4, 56.4 MB and the transport
lane's 17.8 MB diagnostic) deleted after their receipts were read, leaving 2.1
MB retained, of which one 1,192,711 B gzip and one 442,810 B gzip. The volume
is being consumed by other streams **while** the §14.4 warning is open: it read
6.4 GiB in §16, 6.2 in the round-3 review, 6.0 at this round's brackets and 5.1
minutes later, against ≈ 679 MB projected for the two write families. Re-measure
immediately before any campaign run; do not treat any of these figures as the
number that will be there.

### 17.10 Unverified claims of this round

1. **That the phase-2 tree is settled.** Production held `a830d713…` for the 17
   minutes of this round; another stream is still writing `src/`. These numbers
   are a snapshot, not a frozen identity.
2. **That the two write parent modes work over 250 children each.** Four SQLite
   children have now run green across this round and the round-3 review (75000,
   75100, 75200, 99900) and **zero** transport children are green. The parents
   themselves have never been executed.
3. **The transport half of the disk projection** — §16.5 as qualified.
4. **The `g2-mysql-contracts` reds of §14.3 and the two `route-transactions`
   `LX` DIVERGENCE PINs** were not re-run in this round; their §15.7 status is
   carried forward.
5. **The `test:all` inner failures** were matched by signature, not diagnosed.
6. **The 75200 child's JSON receipt was not retained** — its evidence directory
   was deleted with its corpus before it was copied, so that row rests on its
   log alone. The 75000 and 75100 children carry full receipts.

# 18. Reconciliation — cuts, transport plans and the two witness one-liners

Bounded post-phase-2 harness unit, brief
[`g4/briefs/harness-reconciliation.md`](../briefs/harness-reconciliation.md)
plus the integrator's three scope additions (the CS-02 red, the two witness
one-liners, and a stale-pin audit of the `g4-route-*` modes). **No production
file was touched**: `grep -c "^+++ b/src/"` over
[`reconciliation.patch`](receipts/reconciliation/repair/reconciliation.patch) is
**0**, so the incremental core and complete charged cost is **0 LOC / 0 parser
tokens / 0 bytes**. After the repair round the patch is 6 harness/witness files,
**+111 / −29** lines (§18.9 has the per-round split).

Identity at the last source edit of the FIRST round and for every §18.1–§18.8
run unless a row says otherwise: production `9bca8f01…`, harness `e69ecc30…`
([identity-final.json](receipts/reconciliation/identity-final.json); the
pre-run harness was `e7dda465…`,
[identity-after-edits.json](receipts/reconciliation/identity-after-edits.json)).
The repair round's own identity is in §18.9. Another stream was writing `src/`
throughout both rounds; §18.8 records where that shows.

**Read §18.9 first if you are reading this after the independent review**
([`harness-reconciliation-review.md`](../harness-reconciliation-review.md),
verdict REVISE): it records what the two must-fix findings changed, and the
sentences below that it corrects.

## 18.1 The CS-03 cut: measured, not inferred

`g4.md` (06:50) classified the CS-03 self-test red as a G4 regression because
the suite is 42/42 on the clean `0cc61e61` worktree, and read the ten reds as
"the candidate no longer reaches the found/missing observation cut of a root
conditional member". The first half is right; the mechanism is not.

I ran the five failing recipes through the recorder twice with the **same
harness** and only `src/` swapped — once against the working tree and once
against `0cc61e61`'s `src/` aliased in (a scratch Vitest workspace; the probe
that proves the alias took effect is in §18.8). The two tapes have the same
statements in the same order at the same boundaries. Only their spelling moved:

| Statement | `0cc61e61` | current |
| --- | --- | --- |
| upsert locate (slice A, seeds 7133/7144/7160) | `… WHERE "q1"."lookup" = ? LIMIT ?` | `… WHERE "q1"."lookup" COLLATE BINARY = ? ORDER BY "q1"."id" ASC LIMIT ?` |
| holder locate (composition, seeds 7305/7313) | `… WHERE "q4"."lookup" = ? LIMIT ?` | `… WHERE "q4"."lookup" COLLATE BINARY = ? ORDER BY "q4"."id" ASC LIMIT ?` |

Both changes are the candidate's **registered** physical strategy, not drift:

- text equality goes through `operators.exactTextEq`
  ([`g4/unit01/handoff.md`](../unit01/handoff.md), read-vocabulary table:
  "`equals` on text → `operators.exactTextEq(column, operand)`"), and SQLite
  spells that operator `${column} COLLATE BINARY = ${value}`
  (`src/adapters/databases/sqlite/sqlite-adapter.ts:358`), so the comparison is
  collation-independent by construction. `shared/query.ts` reaches it through
  `a.expressions.caseSensitiveText` (`:1433`); `0cc61e61`'s `query.ts` contains
  no such call at all.
- a bounded read now carries a deterministic total order —
  `shared/query.ts:2072` "A windowed read needs a deterministic total order,
  not just the caller's", appending the model's identity order.

Neither is an atomic strategy and neither moves a boundary: the locate is still
one statement, still immediately before the statement that acts on what it
found, and it still decides found from missing by the number of rows it
returns. What broke is the harness's **recognizer**: `lookupWhere` was
`/WHERE[\s\S]*"lookup"\s*=/`, which cannot see `"lookup" COLLATE BINARY = ?`.

Receipts: [cut-tapes-baseline-0cc61e61-src.json](receipts/reconciliation/cut-tapes-baseline-0cc61e61-src.json),
[cut-tapes-current-src.json](receipts/reconciliation/cut-tapes-current-src.json)
(recipe, required cuts, reached cuts, every statement with its row count, for
the five failing seeds and four passing controls).

### The §5.4 classification table

| Recipe family (seeds) | Cut | Classification | Strategy / cause | Where the property is checked | Receipt |
| --- | --- | --- | --- | --- | --- |
| CS-03 A, `nestedShape: upsert-found` (7133, 7144 × both profiles) | `choice:found/root-member/N` | **PRESERVED at the same boundary** — neither eliminated nor moved | none; the statement is unchanged in position and meaning, only in spelling (`exactTextEq` + windowed total order) | the locate itself, re-recognized; and now the locate's own row count (`1` for found) is asserted where it is recognized, as the composition slice already did | [cs03-selftest-after.log](receipts/reconciliation/cs03-selftest-after.log), [cs03-extension-a-seeds.log](receipts/reconciliation/cs03-extension-a-seeds.log) |
| CS-03 A, `nestedShape: upsert-missing` (7160 × both) | `choice:missing/root-member/N` | **PRESERVED** | same | same, with row count `0` | same |
| CS-03 composition, `choice: missing`, `limit > 0` (7305, 7313 × both) | `choice:missing/root-member/N` | **PRESERVED** | same | the locate, re-recognized; the row-count assertion was already there and is untouched | [cs03-extension-composition-seeds.log](receipts/reconciliation/cs03-extension-composition-seeds.log) |
| every other CS-03 cell (A `create` / `updateMany` / `deleteMany`, all of B, composition `limit === 0` and `choice: found`) | — | unaffected | — | — | the three campaign receipts |

**No CS-03 cut was eliminated and none moved**, so §5.4's "absent-because-atomic"
record does not apply to any of them and no injected interleaving was
reclassified. The registered counts are unchanged: 42 self-test cells, three
100-seed × 2-profile campaigns with 3 replays each.

### The repair, and why it is not "make it pass"

One recognizer in each of the two scenario files now reads the key binding with
or without a byte-exact collation (narrowed in the repair round, §18.9 R-4;
the first round wrote `(?:"[^"]+"|\w+)` there, which also admitted an
insensitive collation):

```
const lookupWhere = /WHERE[\s\S]*"lookup"(?: COLLATE (?:BINARY|"C"))?\s*=/;
```

`parentIdWhere` / `parentTenantWhere` are deliberately left alone: those are the
relation scope's own key equality, not a public text filter, and carry no
collation in either tape. `extension-a-scenario.ts` additionally asserts the
locate's row count where it recognizes it (found ⇒ 1 row, missing ⇒ 0), which
`extension-composition-scenario.ts` already did — the recognizer is now
semantic, not only textual.

**Falsifier.** A recognizer tuned to the new engine would stop seeing the old
one. The repaired suite is 42/42 against `0cc61e61`'s `src/` as well
([falsify-cs03-selftest-on-baseline-src.log](receipts/reconciliation/falsify-cs03-selftest-on-baseline-src.log)),
so it reads the cut, not this month's punctuation. The reviewer strengthened
this by running the two repaired files in the REAL clean `0cc61e61` worktree
(42/42, review receipt `falsify-repaired-recognizer-on-0cc61e61.log`), and by
mutating the added row-count assertion, which reddens exactly the six A-slice
upsert cells.

The first round also cited a "300-cell sweep" receipt
([cs03-all-seed-sweep-after.json](receipts/reconciliation/cs03-all-seed-sweep-after.json)).
**That claim is withdrawn** (review finding 5): the receipt is 38 bytes and
carries no identity, and it is redundant — the three registered
`cs03-*-seeds` campaigns run the same 300 recipes on **both** profiles with 3
replays each, and are green in both rounds. The file is kept where it is,
labeled in the receipts README as superseded; nothing above rests on it.

## 18.2 Transport plans — the root-`create` fold

`tests/raptor3/g3/generation/transport-plans.ts`, `ordinaryRecurrenceReplies`.
The §5.4 recipe record in [`g4/unit02/note.md`](../unit02/note.md) §R2.5 names
the condition exactly and this is the change it asks for:

| Statement | Old scripted shape | New scripted shape | Faults kept |
| --- | --- | --- | --- |
| `g3-c11-<seed>-<op>:recurrence-0`, C11 ordinary/repeated, `depth === 0` (`insertCount === 1`) | `INSERT × 1` then `SELECT × 1`, `expected` on the SELECT | `INSERT × 1`, `expected` on the INSERT's own response | unchanged — the fault attaches to the **reply**, not to a statement, so the `fault` flag, the `57014` failure fixture and the injected-failure count are byte-identical |
| the same reply, `depth >= 1` | `INSERT × insertCount` then `SELECT × 1` | unchanged | unchanged |
| `repeatedRecurrenceReplies` at `depth === 0` | delegates to `ordinaryRecurrenceReplies` | unchanged delegation, so it folds with it | unchanged |
| `variantRecurrenceReplies` (`insertCount = (depth+1)(1+2(fanout+1)) >= 3`) | `INSERT × insertCount` then `SELECT × 1` | unchanged — a variant root names relations and does not fold | unchanged |
| `compoundRecurrenceReplies` (`lookup` + `SELECT×2, UPDATE, INSERT×n, SELECT`) | unchanged | unchanged | unchanged |

No fault family and no response fixture was thinned: the returning-weak /
returning-ack profiles, the late completion and the multi-fault healthy suffix
all live in `ScriptedTransport` and in the reply's `committed` /
`allowsChildContexts` / `injected` fields, none of which this change touches.
The transport form is also unchanged: the candidate still submits the folded
write through `executeBatch`, which is why the failure was `script-shape` and
never `transport-form`.

The fold × fault intersection is now a **fixed** witness, not only an argument
plus seeded campaign cells: the repair round added one `depth: 0` C11 recipe
carrying `fault: "legal-provider-failure"` to the representative matrix (§18.9
R-3), and the census that the first round admitted it never extracted is
[folded-fault-census.json](receipts/reconciliation/repair/folded-fault-census.json).

**Falsifier.** With the fold branch removed and the trailing `SELECT` scripted
unconditionally, `g3-generated-transport-smoke` returns to exactly the recorded
red — `g3-transport:script-shape; Unscripted statement: g3-c11-8027-0:recurrence-0;
actual=INSERT; expected=INSERT,SELECT`
([falsify-transport-fold-removed.log](receipts/reconciliation/falsify-transport-fold-removed.log)).
The file was copied to the scratchpad first and restored from that copy;
`shasum -a 256` is `e331824c…` before and after.

## 18.3 CS-02 is NOT this cut family, and not a G4 regression

Scope addition (a) assumed `cs02-structure-measure.test.ts`'s
"collects the frozen CS-02 structural work matrix" belongs to the same family.
It does not, and the premise it rests on is false. Measured three ways:

| Tree | Result |
| --- | --- |
| working tree | red at `structure/depth-create/1` ([cs02-before.log](receipts/reconciliation/cs02-before.log)) |
| `0cc61e61`'s `src/`, same harness | **byte-identical failure** ([cs02-on-0cc61e61-src.log](receipts/reconciliation/cs02-on-0cc61e61-src.log)) |
| the clean `0cc61e61` worktree `/private/tmp/viborm-g4-perf-baseline` | **same failure** ([cs02-clean-0cc61e61.log](receipts/reconciliation/cs02-clean-0cc61e61.log)) |
| `b0ec55fa`'s `src/` — the commit that landed this harness — same harness | **same failure** ([falsify-cs02-on-b0ec55fa-src.log](receipts/reconciliation/falsify-cs02-on-b0ec55fa-src.log)) |

`tests/raptor3/core-structure/` is identical to `0cc61e61` apart from this
unit's two recognizer hunks, so the cell has been red since it landed, in the
lane that runs it (it is in `EXTENDED_LOCAL_TESTS` and registered at
`scripts/raptor3-manifest.mjs:315`).

**Diagnosis.** The frozen inventory names, for every path including `root`, an
occurrence, a write and an `attempt/0/unconditional` activation, and for
`width-overlap` it also names a **read**. The unpatched harness binds none of
them for the root (`bindCreateTree` binds only `bindings.bindCommand(root, …)`;
only `commands.analyze(root)` yields the root occurrence, and it is discarded)
and binds no read anywhere: `bindRead` / `claimRead` are called **only** from
`reference-instrumentation.patch`. So the matrix as frozen is reachable only
with the reference instrumentation applied to `src/`
(`VIBORM_RAPTOR3_MEASUREMENT_PATCH`), and the ordinary registered run cannot
reproduce it by construction.

I proved the create half of that by binding the root occurrence and its
unconditional activation from `analyze(root)` — the two create arms then pass
and the failure moves to `structure/width-overlap/1`, which additionally wants
the read that only the patch can bind
([cs02-after.log](receipts/reconciliation/cs02-after.log)). **That edit was
reverted**; `cs02-structure-measure.test.ts` is byte-identical to `0cc61e61`.
Finishing it means either binding identities the unpatched build does not
expose or gating the cell on the instrumentation patch — a registration
decision for the CS-02 measurement owner, not a §5.4 cut classification. It is
recorded as blocker **B-R1** in §18.7.

## 18.4 The two witness one-liners (§P.11.1)

| Cell | Change | Why it is the measured contract |
| --- | --- | --- |
| **SC-13**, `tests/raptor3/g4/read-codecs.test.ts` | the read half no longer goes through `observeFailure`. **Superseded by §18.9 R-1**: the first round compared the two engines over the EMPTY table the refused write left behind, which is true of any empty table and of no capability; the repair seeds one row with raw SQL and asserts the decoded parity instead. | SQLite declares no vector tier, so the WRITE is refused identically by both engines; the READ is answered by both, because the vector field carries as JSON. Demanding a refusal there demanded one that neither engine raises — but asserting `[]` demanded nothing at all. |
| **RF-16**, `tests/raptor3/g4/read-recursive-fit.test.ts:243` | `walk(row.children)` replaces `for (const nested of Object.values(row)) walk(nested)` in the first cell only | the traversal relation is the thing being flattened; descending every nested value also pushes the row's own `document: { code: "root" }` payload, and `new Map(flat…)` then keeps that payload instead of the row. The author's pin `g4/unit02/recursive-codec-fit.test.ts:243` has exactly this spelling. |

`g4-read-contracts` is **62 passed / 62**
([g4-read-contracts.log](receipts/reconciliation/g4-read-contracts.log)).
**Falsifier:** with both one-liners reverted the same mode is 60 passed / 2
failed, the two being SC-13 ("The required refusal did not fire") and RF-16
([falsify-witness-oneliners-reverted.log](receipts/reconciliation/falsify-witness-oneliners-reverted.log));
both files were restored from scratchpad copies and re-hashed
(`4b85b403…`, `6defc573…`).

The second `walk` in `read-recursive-fit.test.ts` (line 304, the
"applies descendant where, select and orderBy" cell) still descends every
value. It is green — that cell selects only `code`, so there is no JSON payload
to confuse it — and the phase-2 author's request named only the first. Left as
it is, and recorded here for the witness owner.

## 18.5 Scope addition (c) — the `g4-route-*` stale-pin audit

Measured at 12:34–12:35 local, while the route files were being written by
another stream (mtimes 10:37–11:40 the same day), so this is a snapshot.
**Re-measured in the repair round at 14:10–14:11** (§18.9 R-6): the cell counts
below still hold and the registration drift is **gone** — all four modes now
exit 0 with their contract gate verified, so blocker **B-R2 is resolved**.

| Mode | Cells | Result |
| --- | --- | --- |
| `g4-route-lifecycle` | 8 | **8 passed**, including the **D-6 PIN** at `tests/raptor3/g4/route-lifecycle.test.ts:399` and `LX-14` at `:516` |
| `g4-route-admission` | 7 | **7 passed** |
| `g4-route-cache` | 7 | **7 passed**, including "LX-07 PENDING blocker B-1c" at `:241` |
| `g4-route-transactions` | 13 | **13 passed**, including the **D-5 PIN** at `tests/raptor3/g4/route-transactions.test.ts:442` and both `LX-14` cells |

**There is no remaining red test cell in any `g4-route-*` mode, and no stale
pin.** D-5 and D-6 both hold as recorded divergences. §P.11.2's request against
`g4-route-transactions` (LX-04 and LX-14 as stale pins) is satisfied on this
tree — both are green — and can be closed by the route owner.

At 12:34–12:35 all four modes nevertheless **exited non-zero**, on the
registration gate rather than on a cell: the frozen counts were behind the
files (`scripts/raptor3-manifest.mjs:510 / 516 / 522 / 528` read 7 / 5 / 6 / 11
against files of 8 / 7 / 7 / 13). **That drift is closed.** The registration
writer moved those four counts to 8 / 7 / 7 / 13 later the same day; at
14:10–14:11 every mode passes its contract gate and exits 0
([g4-route-*.log](receipts/reconciliation/repair)). Blocker **B-R2 is
resolved** — nothing for the integrator to chase.

Beside them: `g4-lifecycle-events` **3/3**; `g4-lifecycle-admission` **3 passed
/ 1 failed**, the one being the recorded route blocker B-1c ("the prepared
read's leaves publish no scalar to compile a value codec from",
`g4/unit03/note.md` FU.6 B-1c) — a pinned owned blocker, not a stale pin.

## 18.6 Suites

Serial, through the bounded runner, in the brief's order. Every receipt is
under [`receipts/reconciliation/`](receipts/reconciliation).

| Suite / mode | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| CS-03 extension-campaign self-test | **42 passed** (was 10 failed) | 7.80 s / 632.3 MiB | `cs03-selftest-after.log` |
| `cs03-extension-a-seeds` | **1 passed** (100 seeds × 2 profiles × 3 replays) | 23.10 s / 645.8 MiB | `cs03-extension-a-seeds.log` |
| `cs03-extension-b-seeds` | **1 passed** | 8.30 s / 733.4 MiB | `cs03-extension-b-seeds.log` |
| `cs03-extension-composition-seeds` | **1 passed** | 11.16 s / 776.4 MiB | `cs03-extension-composition-seeds.log` |
| `g3-generated-transport-smoke` | **1 passed** (was red at cell 54) | 5.82 s / 537.4 MiB | `g3-generated-transport-smoke.log` |
| `g3-generated-smoke` | **6 passed** | 6.40 s / 569.5 MiB | `g3-generated-smoke.log` |
| `g3-generated-minimization` | **1 passed** | 5.09 s / 524.2 MiB | `g3-generated-minimization.log` |
| `g3-transport-seed-batch 8000` (one child) | **1 passed** | 8.18 s / 931.1 MiB | `g3-transport-seed-batch-8000.log` |
| `g4-write-transport-seed-batch 100000` | **1 passed** (was red at cell 54) | 8.42 s / 729.1 MiB | `g4-write-transport-seed-batch-100000.log` |
| `g4-transport-seed-batch 50000` | **1 passed** | 18.25 s / 711.0 MiB | `g4-transport-seed-batch-50000.log` |
| `g4-read-contracts` | **62 passed** (was 60/2) | 5.40 s / 739.0 MiB | `g4-read-contracts.log` |
| `g4-route-lifecycle` / `-admission` / `-cache` / `-transactions` | 8 / 7 / 7 / 13 passed; mode gate red on counts (§18.5) | ≈ 4–6 s each | `g4-route-*.log` |
| `g4-lifecycle-events` / `g4-lifecycle-admission` | 3 passed / 3 passed + 1 recorded blocker | — | `g4-lifecycle-*.log` |
| `cs02-structure-measure` | **1 failed** — pre-existing, §18.3 | — | `cs02-*.log` |
| receipts self-test (`scripts/raptor3-campaign-receipts.test.mjs`) | **39 passed / 0 failed** | 0.38 s / 0.5 MiB | `raptor3-campaign-receipts.log` |
| CLI self-test (`scripts/raptor3-cli.test.mjs`), attempt 3 at the final identity | **10 passed / 0 failed**, no identity guard trip | 318.23 s / 199.3 MiB | `raptor3-cli-selftest-attempt3.log` |
| whole-estate typecheck | only the two permitted Pattern `TS2345` at `pack.ts:1443` and `:2633` | 13.36 s / 5065.5 MiB | `typecheck.log` |

The CLI self-test was 9/10 before this unit, its one red being the CS-03
measurement red; it is 10/10 now.

## 18.7 Blockers

- **B-R1 — `cs02-structure-measure` cannot pass unpatched.** §18.3. Owner: the
  CS-02 measurement author. Reproducer: `node scripts/run-vitest-safe.mjs run
  --project raptor3 tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts`
  on any of `0cc61e61`, `b0ec55fa` or the current tree. The decision (bind the
  root occurrence / gate the cell on `VIBORM_RAPTOR3_MEASUREMENT_PATCH` /
  re-freeze the matrix from an unpatched run) is a registration decision for
  Arnaud, not a §5.4 classification.
- **B-R2 — four `g4-route-*` registration counts are behind their files.**
  **RESOLVED** (repair round, §18.9 R-6). The registration writer moved
  `scripts/raptor3-manifest.mjs:510 / 516 / 522 / 528` to 8 / 7 / 7 / 13; all
  four modes now pass their contract gate and exit 0. Kept here so the earlier
  §18.5 text is not read as open.
- **B-R3 — the §5.4 surrounding-cut evidence the transport fold rests on runs
  in no registered lane.** Plan §5.4 admits an absent cut only with the
  concrete strategy **and** the same property checked at its legal surrounding
  cuts. For the root-`create` fold that property is checked by
  `tests/raptor3/g4/unit02/root-member-cut-trace.test.ts` and
  `tests/raptor3/g4/unit02/malformed-result-cuts.test.ts`
  ([`g4/unit02/note.md`](../unit02/note.md) §P.11.3), and neither file is in
  `scripts/raptor3-manifest.mjs` nor in `EXTENDED_LOCAL_TESTS`, so no gate
  would notice if the property broke. Found by the review (finding 3); this
  unit accepted the §5.4 record without checking that its evidence executes.
  Owner: the registration writer, with the G4-02 author for the counts. The
  two files are **8 cells, green** — re-run in this round through the review's
  own scaffold ([review-probes.log](receipts/reconciliation/repair/review-probes.log),
  project `hr-review-unregistered-cut-evidence`) — so this is a registration,
  not a repair. No code change is owed by this unit.
- **Registration request (not a blocker) — promote the two now-green G4 read
  files.** `scripts/raptor3-campaign-receipts.test.mjs:970–986` keeps every
  `G4_FIXED_SUITES` member out of `EXTENDED_LOCAL_TESTS` and out of
  `RAPTOR3_FIXED_LOCAL_TESTS` "while they are red", and says in its own comment
  that joining the fixed stage "when they pass" is an explicit decision.
  `read-codecs.test.ts` and `read-recursive-fit.test.ts` held the last two red
  cells of `g4-read-contracts`; this unit made them green and the mode is
  62/62 in both rounds. The guard is list-shaped and other `G4_FIXED_SUITES`
  members are still red, so the promotion is a decision for the registration
  writer, not an edit this unit may make. Raised by the review (finding 7).

## 18.8 Unverified, and what would settle it

1. **The `0cc61e61` and `b0ec55fa` comparisons used this tree's harness with
   only `src/` aliased**, not a full checkout. The alias was verified to bite by
   a probe (`SQLiteAdapter.expressions.integerDivide`, which exists only in the
   working tree, is absent under the alias); the first attempt at that
   comparison silently resolved the working-tree `src/` because a root
   `vitest.workspace.ts` overrides `--config`, and every number above comes from
   the corrected `--workspace=` form. `tests/raptor3/core-structure/` is
   identical to `0cc61e61` apart from this unit's two hunks, and the CS-02 row
   was independently confirmed in the real clean worktree, so the two
   conclusions do not rest on the alias alone.
2. ~~**The route audit is a snapshot.**~~ **Settled** by the repair round: the
   four modes were re-run at 14:10–14:11 and are 8 / 7 / 7 / 13 green with the
   gate verified and exit 0 (§18.9 R-6). Still a snapshot in the sense that the
   route files remain another stream's; the reds it would catch are cell-level,
   and none exist today.
3. **The CLI self-test took three attempts, and all three are retained.**
   Attempt 1 (`raptor3-cli-selftest.log`) is 10/10 at harness `e7dda465…`, one
   comment-free formatting reflow of `read-codecs.test.ts` before the final
   `e69ecc30…`. Attempt 2 (`raptor3-cli-selftest-attempt2.log`) is 10 cells
   passed / 0 failed but its file-level `after` hook tripped the "Stale Raptor 3
   evidence" guard, because the **production** fingerprint moved under it
   (`6a7844b2…` → `9bca8f01…`) while the concurrent `src/` stream worked.
   Attempt 3 is 10/10 with the guard satisfied end to end. The harness
   fingerprint has since moved again (`e69ecc30…` → `c1cf5df1…`) without any
   file of this unit changing — the five files' SHA-256s are pinned in
   [SHA256.files](receipts/reconciliation/SHA256.files) — so the drift is the
   other stream's.
4. ~~**Fault coverage of the folded transport reply is argued from the driver's
   own structure.**~~ **Measured** in the repair round and no longer an
   argument. The census
   ([folded-fault-census.json](receipts/reconciliation/repair/folded-fault-census.json),
   computed by importing the real `generateG3Recipe`, not a re-implementation)
   counts the folded (`depth === 0`, ordinary/repeated) C11 recipes and how
   many carry a fault:

   | Range | C11 | folded | folded × fault | folded × overlap |
   | --- | --- | --- | --- | --- |
   | `g3-transport` 8000–17999 | 2500 | 233 | **44** | 52 |
   | its 8000 child (the one run) | 25 | 4 | **1** (seed 8091) | 1 |
   | `g4-write-transport` 100000–124999 | 6250 | 624 | **108** | 130 |
   | its 100000 child (the one run) | 25 | 7 | **1** (seed 100031) | 2 |
   | `g4-transport` 50000–74999 | 6250 | 606 | **131** | 119 |
   | its 50000 child (the one run) | 25 | 1 | **0** | 0 |

   Both numbers the review measured (44/233 and 108/624) reproduce exactly. The
   fixed matrix now carries the intersection too — seed **8611**, whose
   generated recipe is itself `depth: 0`, `fault: legal-provider-failure` — and
   the falsifier at §18.9 R-3 names it.
5. **The parent campaign modes were not run** — one child of each lane only, as
   the brief directs.
6. **The repair round's whole-estate typecheck needed two attempts, both
   retained.** The first (`repair/typecheck.log`) carries ten `TS2741`
   diagnostics in `tests/raptor3/g4/unit02/zz-probe.test.ts`, an untracked
   scratch file the concurrent G4-02 stream created at 14:05 and deleted before
   14:16; the second (`repair/typecheck-2.log`) is the two permitted Pattern
   `TS2345` and nothing else. No file of this unit ever produced a diagnostic.

## 18.9 Repair — after the independent review (round 2)

[`harness-reconciliation-review.md`](../harness-reconciliation-review.md)
returned **REVISE** with two must-fix findings and five notes. Every must-fix is
repaired below; four of the five notes are repaired too (the fifth, the
reviewer's own probe file, is not mine to edit). Receipts for this round are in
[`receipts/reconciliation/repair/`](receipts/reconciliation/repair), kept
separate from the first round's so no earlier receipt is relabeled.

Identity at the last source edit of this round: production `bc26281d…`, harness
`49cbc09603…`
([repair/identity-final.json](receipts/reconciliation/repair/identity-final.json)).
The production fingerprint moved from the review's `3bbaa936…` during the round:
the concurrent `src/` stream, not this unit — no file under `src/` is in the
patch. The six owned files' SHA-256s are pinned in
[repair/SHA256.files](receipts/reconciliation/repair/SHA256.files). Both
fingerprints moved again after this round's last edit (`831425c0…` /
`f4dbc4f740…` at hand-off) while `shasum -a 256 -c` on those six files still
passes, so the drift is the other streams', as in §18.8 #3.

### R-1 — SC-13 now measures a decode, not an empty table (must-fix, review finding 1)

`tests/raptor3/g4/read-codecs.test.ts`, the C12 vector cell. The review is
right: removing the wrong `observeFailure` was correct, but
`deepEqual(candidateRead, [])` over the table the refused WRITE left empty
cannot fail for the reason the cell exists — with zero rows no result parser
ever reaches a vector value, and this is the only place the C12 read boundary is
exercised on the local provider (`native/read-envelope-native.test.ts:37` needs
pgvector).

What the cell measures now, in one cell (the registered count stays 12, so no
manifest edit):

1. the world is seeded with **one row of raw SQL** through
   `WitnessWorldOptions.seed` — the mechanism the witness world already exposes,
   and the only one available here, because both engines refuse to write a
   vector on this provider;
2. the WRITE half is unchanged in meaning and now uses `EMBEDDINGS[1]`, a row
   the seed did **not** write, so a duplicate key can never stand in for the
   capability refusal;
3. the stored physical spelling is pinned (`"[1,0,0]"`), because the seed is
   hand-written and that is the weak point of this witness;
4. the read goes through the file's own oracle, `expectRead`: the hand value is
   the authority, the shipped engine is the differential oracle, the candidate
   is the subject. It asserts `[{ embedding: [1, 0, 0] }]`.

One read, two facts: a refused write that leaked a row would show up as a second
member, and either engine losing the decode fails the same assertion. The doc
comment and the title were rewritten — the cell is "refuses a vector write
identically **and decodes a stored vector**", and the comment now says which
half is the refusal, which half is the answer, and what is still witnessed only
on a capable provider (the round trip through the engine's own vector writer).

**Falsifiers**, both run, both restored from scratchpad copies:

| Mutation | Result | Receipt |
| --- | --- | --- |
| the `seed` removed (the first round's world) | SC-13 red at the physical-spelling pin | `repair/falsify-sc13-seed-removed.log` |
| the `seed` **and** the pin removed | SC-13 red inside `expectRead` — "Disputed row: the shipped engine disagrees with the hand-computed value for embedded.findMany" — which is exactly the vacuity the review found | `repair/falsify-sc13-read-arm-on-empty-table.log` |

`tests/raptor3/g4/read-codecs.test.ts` is `ee6a5ba1…` after the round (the
one-line reflow in R-8 is included).

### R-2 — B-R3 recorded: the §5.4 evidence runs in no lane (must-fix, review finding 3)

Recorded in §18.7 as blocker **B-R3**, exactly as B-R2 was recorded, with the
two file paths, the owner and the reproduction. The review's own measurement is
reproduced here: the two files are 8 cells and green through the review
scaffold. No code change is owed by this unit, and none was made — the fix is a
registration in another stream's file.

### R-3 — the folded transport shape gets a FIXED fault witness (review finding 2)

`tests/raptor3/g3/generation/generated-transport-smoke.test.ts`,
`representativeRecipes()`: one recipe added, seed **8611**, `C11`,
`depth: 0`, `fanout: 0`, `shape: "ordinary"`,
`fault: "legal-provider-failure"`. It is a legal member of the fixed matrix in
the house style — the generator's own rules for that seed give C11, one actor
and `legal-provider-failure`, and `generateG3Recipe(8611)` is `depth: 0` too, so
this is the intersection the campaign would draw anyway. Its `fanout` and
`operations` are hand-chosen, as every entry of the fixed matrix is (the
generator would say 1 and 26); both shapes are recorded in the census. The
matrix is one vitest cell iterating recipes, so **no registered count changes** (still 1) and
`coverageAxis` / `recurrenceShapes` still assert the same sets.

**Falsifier.** With the fold condition narrowed to `insertCount === 1 && !fault`
— that is, with the fold withheld from faulted replies only —
`g3-generated-transport-smoke` fails and names the new recipe:
`g3-transport:script-shape; Unscripted statement: g3-c11-8611-0:recurrence-0;
actual=INSERT; expected=INSERT,SELECT`
([repair/falsify-folded-fault-recipe.log](receipts/reconciliation/repair/falsify-folded-fault-recipe.log)).
That is the proof the new cell exercises fold **and** fault together: the engine
sends one INSERT for it, and the mutation that changed only faulted replies is
what reddened it. `transport-plans.ts` was restored from the scratchpad copy and
re-hashed `e331824c…`, unchanged by this round.

The census that §18.8 #4 admitted it never extracted is now
[repair/folded-fault-census.json](receipts/reconciliation/repair/folded-fault-census.json)
and the table is in §18.8 #4.

### R-4 — the recognizer admits the exact-text collations only (review finding 4)

`extension-a-scenario.ts:22` / `extension-composition-scenario.ts:15`:
`(?: COLLATE (?:"[^"]+"|\w+))?` → `(?: COLLATE (?:BINARY|"C"))?`.

The first round's alternation admitted **any** collation, including an
insensitive one, while the comment justified the widening by "the adapter's
exact-text operator". Those are different comparisons, and a locate that stopped
being exact text should fail the recognizer rather than be read as the same cut.
The comment was also wrong about Postgres and is corrected: SQLite's
`exactTextEq` spells `COLLATE BINARY` (`sqlite-adapter.ts:357–358`), Postgres's
spells the plain `=` (`postgres-adapter.ts:234` — its default collation is
already the index-usable one) and names `COLLATE "C"` where it pins byte
ordering, MySQL prefixes `BINARY` (`mysql-adapter.ts:537–538`). Both spellings
the alternation keeps are byte-exact; nothing else is admitted.

Unreachable today either way (the upsert locate is generated from the
operation's own unique key), so this is robustness. CS-03 is 42/42 and the three
campaigns are green with the narrowed pattern.

### R-5 — the 300-cell sweep claim is withdrawn (review finding 5)

§18.1's falsifier paragraph no longer leans on
`cs03-all-seed-sweep-after.json`. The receipt carries no identity, and
re-emitting it would manufacture redundant evidence: the three registered
`cs03-*-seeds` campaigns cover the same 300 recipes on both profiles with three
replays, and are green in both rounds. The file stays where it is and the
receipts README now labels it superseded — no receipt was deleted or relabeled
as passing.

### R-6 — B-R2 marked resolved, on a fresh measurement (review finding 6)

All four `g4-route-*` modes re-run at 14:10–14:11: **8 / 7 / 7 / 13 passed**,
every contract gate verified, **all four exit 0**. The manifest now reads
8 / 7 / 7 / 13. §18.5 and §18.7 are corrected; §18.8 #2 is settled.

### R-7 — the promotion request is recorded (review finding 7)

Added to §18.7 as a registration request (not a blocker) with the guard's file,
lines and the reason it is a decision rather than an edit.

### R-8 — formatting

One line added in R-1 exceeded the formatter's width; it is wrapped the way
`biome format` prints it. The pre-existing format deviations in these files
(`read-codecs.test.ts` lines 277–288 / 324–328 / 365–367,
`extension-a-scenario.ts` lines 139+ / 302+ / 328+ / 338+) are older than this
unit and are deliberately left alone: reformatting them would inflate the diff
with another stream's lines. `biome format` reports no deviation anywhere inside
this unit's hunks.

### What this round deliberately did NOT do

- **The reviewer's probe keeps its own copy of the widened pattern.**
  `tests/raptor3/g4/review/harness-reconciliation/lookup-recognizer.test.ts:21`
  declares `REPAIRED` as a local constant, so its third cell still passes while
  describing a pattern no scenario file contains any more. All 22 review cells
  are green here; the probe is the reviewer's file and is not mine to edit. If
  it is kept as a gate, its `REPAIRED` constant should import the pattern or be
  moved to `(?:BINARY|"C")`.
- **No production file, no manifest file.** The two registrations this round
  identified (B-R3, and the read-file promotion) are recorded for the
  registration writer, whose file is dirty with its own work.

### Suites re-run in this round

Serial, through the bounded runner. Receipts in
[`receipts/reconciliation/repair/`](receipts/reconciliation/repair).

| Suite / mode | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| CS-03 extension-campaign self-test | **42 passed** | 4.04 s / 559.5 MiB | `cs03-selftest.log` |
| `cs03-extension-a-seeds` | **1 passed**, gate verified | 5.90 s / 760.2 MiB | `cs03-extension-a-seeds.log` |
| `cs03-extension-b-seeds` | **1 passed**, gate verified | 4.35 s / 738.0 MiB | `cs03-extension-b-seeds.log` |
| `cs03-extension-composition-seeds` | **1 passed**, gate verified | 6.11 s / 795.9 MiB | `cs03-extension-composition-seeds.log` |
| `g3-generated-transport-smoke` (with the new recipe) | **1 passed**, gate verified | 3.99 s / 555.7 MiB | `g3-generated-transport-smoke.log` |
| `g3-generated-smoke` | **6 passed**, gate verified | 4.07 s / 636.6 MiB | `g3-generated-smoke.log` |
| `g3-generated-minimization` | **1 passed**, gate verified | 4.10 s / 551.3 MiB | `g3-generated-minimization.log` |
| `g3-transport-seed-batch 8000` | **1 passed**, gate verified | 6.55 s / 821.0 MiB | `g3-transport-seed-batch-8000.log` |
| `g4-write-transport-seed-batch 100000` | **1 passed**, gate verified | 5.86 s / 823.1 MiB | `g4-write-transport-seed-batch-100000.log` |
| `g4-transport-seed-batch 50000` | **1 passed**, gate verified | 5.31 s / 742.2 MiB | `g4-transport-seed-batch-50000.log` |
| `g4-read-contracts` (final, after R-8) | **62 passed**, gate verified | 4.79 s / 722.2 MiB | `g4-read-contracts.log` |
| `g4-route-lifecycle` / `-admission` / `-cache` / `-transactions` | **8 / 7 / 7 / 13 passed**, gates verified, **exit 0** | ≈ 4–5 s each | `g4-route-*.log` |
| review probes + the unregistered §5.4 cut evidence (6 files) | **22 passed** | 4.87 s / 644.7 MiB | `review-probes.log` |
| receipts self-test | **39 passed / 0 failed** | 0.34 s / 0.6 MiB | `raptor3-campaign-receipts.log` |
| CLI self-test, at the final identity | **10 passed / 0 failed**, no identity-guard trip | 228.00 s / 212.0 MiB | `raptor3-cli-selftest-final.log` |
| CLI self-test, before the R-8 reflow | **10 passed / 0 failed** | 237.98 s / 210.2 MiB | `raptor3-cli-selftest.log` |
| whole-estate typecheck, attempt 2 | only the two permitted Pattern `TS2345` | 7.23 s / 6260.3 MiB | `typecheck-2.log` |
| whole-estate typecheck, attempt 1 | + 10 `TS2741` in another stream's scratch file, §18.8 #6 | 7.42 s / 6156.9 MiB | `typecheck.log` |
| falsifiers (R-1 × 2, R-3) | red as designed; all three files restored and re-hashed | — | `falsify-*.log` |

### Cost, after the repair

Still **0 incremental core LOC / 0 parser tokens / 0 bytes**:
`grep -c "^+++ b/src/"` over
[repair/reconciliation.patch](receipts/reconciliation/repair/reconciliation.patch)
is **0**, and the patch names six files, all under `tests/`. Complete unit diff
**+111 / −29**; this round's own delta is **+81 / −35**
([repair/repair-delta.patch](receipts/reconciliation/repair/repair-delta.patch)).
Test-infrastructure lines are counted separately and are not charged.
