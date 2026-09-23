# CS-01 structural and extension measurement contract

Date: 2026-09-13. Status: **frozen protocol; executable collectors are CS-02/CS-03 work.**

This contract compares the qualified flat-history reference with the shared-
occurrence candidate. It does not choose either representation and adds no
production capability. Source size, parser tokens, source bytes, semantic
outcomes, and runtime work remain separate measures. There is no LOC ceiling or
formula that can substitute for an observed runtime counter.

## Existing owners and bounded additions

The implementation must reuse these existing owners:

- `tests/raptor3/harness/protocol.ts`: scenario, public input, outcome, and
  replay-record vocabulary;
- `tests/raptor3/harness/recorder.ts`: serial deterministic clock/random control
  and exact same-build event replay;
- `tests/raptor3/harness/sqlite-world.ts`: the real SQLite interactive and
  atomic-batch worlds, statement recording, semantic cuts, and fixture oracle;
- `tests/raptor3/harness/replay.ts`: scenario replay and semantic comparison;
- `scripts/raptor3-manifest.mjs`: frozen file/count/campaign inventory and
  `captureRaptor3Identity()`;
- `scripts/run-raptor3.mjs`: isolated child execution, resource ceilings,
  identity checks, and evidence-directory publication.

The repository has no structural-work collector or A/B/composition generator
today. CS-02/CS-03 may add only the following test/evidence responsibilities:

- a strict typed measurement protocol and Zod output schemas under
  `tests/raptor3/core-structure/measurement/`;
- one architecture-neutral recipe owner there for the structural shapes and
  the three extension campaigns;
- manifest entries and runner modes named below;
- temporary, source-bound instrumentation patches for the two alternatives.

Instrumentation must not widen `EngineConfig`, a public client surface, or a
shipped production type. Each patch may only emit events at existing
construction, analysis, expansion, and execution sites. It is applied after
the base identity is captured, and its SHA-256 and instrumented identity are
recorded. It is removed before source-cost measurement and qualification.
The exact patch bytes are retained beside the receipt. Instrumentation lines
are excluded from both alternatives' source counts (never credited and never
subtracted), while the raw events they emitted remain the runtime-work record.

Reference hooks are limited to the actual owners: placement in
`relation-body.ts` (`requireLookup`/`requireSeriesCapture`); logical visits,
pair/atom checks, scans, and expansion copies in `commands.ts` (`analyzeInto`,
`analyzeSeriesInto`, `readMembership`, `readTarget`, and `resumeSeries`); and
physical visits/capture in `execution.ts` (`run`, `captureSeries`, and
`executeSeries`). Candidate hooks sit at the corresponding work sites in its
accepted shared mechanism. A patch only calls the test-owned event append; it
must not add a production observer, counter service, or feature flag.

## Stable semantic identities

The common recipe freezes the identity derivation before either engine runs.
Declared identities are assigned then; captured-member identities are derived
during execution from the frozen rule below. Object address, array index after
mutation, flat-history position, traversal order, and SQL text are forbidden
identity sources.

| Identity | Equality unit |
| --- | --- |
| `commandId` | One semantic command object. Reusing the same object keeps this ID. |
| `occurrenceId` | One placement in the operation body. Two placements of one command have distinct occurrence IDs. |
| `selectionId` | One reusable observation meaning. Presence reuse and absence reobservation retain this ID. |
| `readId` | One dependency-read occurrence owned by an `occurrenceId`, including dependency kind and relation edge/member. |
| `writeId` | One dependency-write occurrence owned by an `occurrenceId`, including carrier, edge/member, identity, origin, and arm. |
| `activationId` | `(attempt, choice occurrence, observation ordinal, state)` where state is `unobserved`, `found`, or `missing`. A state change is a new activation. |
| `revision` | A monotonically increasing version only when expansion or finalized publication changes the read/write facts. |
| `analysisEpoch` | One initial analysis or one concrete series expansion/resumption. Re-entering unchanged work does not create a new epoch. |

Static paths name declared placements. A captured member appends
`/member/<captureOrdinal>` to its series occurrence; the ordinal comes from the
stable ordered capture query. A choice appends `/found` or `/missing`. The
collector refuses a missing ID, two semantic objects claiming one ID, or an
occurrence that is constructed but absent from the emitted semantic inventory.

## Raw events and exact counters

The test-owned protocol defines this closed event union. Every event carries
`caseId`, `analysisEpoch`, and a monotonically increasing `sequence`:

```ts
type MeasurementEvent = {
  caseId: string;
  analysisEpoch: string;
  sequence: number;
} & (
  | { kind: "occurrenceVisit"; occurrenceId: string; phase: "construct" | "logical" | "physical" | "expand" }
  | { kind: "readVisit"; occurrenceId: string; readId: string; revision: number; activationId: string }
  | { kind: "writeVisit"; occurrenceId: string; writeId: string; revision: number; activationId: string }
  | { kind: "overlapPair"; pairKey: string; readId: string; readRevision: number; writeId: string; writeRevision: number; activationId: string; predicate: "membership" | "target"; disposition: "consumed" | "publishedDeferred" | "discarded" }
  | { kind: "overlapAtom"; pairKey: string; component: string; comparison: "equal" | "disjoint" | "unknown" }
  | { kind: "prefixRead"; consumerOccurrenceId: string; prefixOccurrenceId: string; prefixRevision: number; purpose: "comparison" | "publication" | "navigation" }
  | { kind: "referenceCopy"; occurrenceId: string; destination: string; purpose: "semanticPublication" | "ancestorPrefix" | "siblingPrefix" | "suffixDetach" | "suffixRestore" }
  | { kind: "ownerScanRead"; ownerOccurrenceId: string; candidateOccurrenceId: string }
);
```

An event is emitted where the work happens, not reconstructed from final array
lengths. A bulk splice/copy emits one `referenceCopy` per occurrence reference
actually moved. A loop emits one visit per body entered. An equality helper emits
one `overlapAtom` per field/edge/identity component actually compared. Runtime
container lengths may drive emission; a triangular-number or source-shape
formula may not populate any measured field.

The strict counter object is:

```ts
interface WorkCounters {
  occurrenceVisits: number;
  constructionOccurrenceVisits: number;
  logicalOccurrenceVisits: number;
  physicalOccurrenceVisits: number;
  expansionOccurrenceVisits: number;
  readVisits: number;
  writeVisits: number;
  overlapPairChecks: number;
  overlapAtomChecks: number;
  necessaryDistinctOverlapPairs: number;
  speculativeDistinctOverlapPairs: number;
  redundantRepeatedOverlapPairs: number;
  necessaryDistinctOverlapAtoms: number;
  speculativeDistinctOverlapAtoms: number;
  redundantRepeatedOverlapAtoms: number;
  prefixReads: number;
  distinctSemanticPrefixReads: number;
  redundantRepeatedPrefixReads: number;
  navigationPrefixReads: number;
  referenceCopies: number;
  semanticPublicationCopies: number;
  ancestorPrefixCopies: number;
  siblingPrefixCopies: number;
  suffixDetachCopies: number;
  suffixRestoreCopies: number;
  ownerScanReads: number;
}
```

All fields are nonnegative safe integers. Totals are derived only by reducing
the raw events, and the reducer is shared byte-for-byte by both alternatives.
The receipt rejects a supplied total that does not equal its event reduction.
It also enforces these partitions: occurrence visits equal the four phase
fields; pair and atom checks each equal necessary-distinct +
speculative-distinct + redundant-repeat; prefix reads equal distinct-semantic +
redundant-repeat + navigation; and reference copies equal the five copy purposes.
Owner scans are reads, not copies.

For an overlap pair, the semantic key is
`(analysisEpoch, readId, readRevision, writeId, writeRevision, activationId,
predicate)`; `pairKey` is the canonical encoding of that tuple and the reducer
rejects any mismatch. For an atom, append `component`. A key with at least one
`consumed` or `publishedDeferred` event contributes one necessary-distinct unit;
all other events for that key are redundant repeats. A key whose events are all
`discarded` contributes one speculative-distinct unit and any remaining events
are redundant repeats. Thus a branch activation or fact revision permits a new
necessary check, while rescanning unchanged inputs is measured as repeated work.
“Necessary” here means necessary to the observed decision in this run; it is
not a claim that every possible algorithm must perform that comparison.

The prefix key is `(analysisEpoch, consumerOccurrenceId, prefixOccurrenceId,
prefixRevision, purpose)`. The first comparison/publication read is
distinct semantic work; later identical reads are redundant. A navigation-only key
is reported separately in raw events and never relabeled as semantic necessity.
This classification measures a conservative implementation honestly: it does
not call an untaken-arm check necessary merely because it happened, but it does
count a refusal published for later branch activation as necessary.

## Structural shape matrix

The common recipe owner constructs every size in `1, 2, 8, 32`:

1. `depth-create-N`: the existing `historyNode` public create spine shape from
   `post-prep/history-analysis.test.ts`, with `N` relation edges and `N + 1`
   record occurrences.
2. `width-create-N`: that test's public sibling-create shape, with one root and
   `N` ordered child record occurrences.
3. `width-overlap-N`: one compound parent create, `N` ordered same-edge
   membership writers, and `N` later same-edge admitted selected-series reads.
   Writer `i` and read `j` use stable unique selectors; equality is present only
   when `i === j`. Writer bodies publish their complete finalized tuple and no
   unrelated scalar write, so membership overlap is the only positive reason.
   The later consumers use the same existing private bound-`Selection` seam as
   the accepted structural witness, placed after all writers; this is command
   construction and ordinary lifecycle execution, not a test interpreter.
4. `series-choice-N-found` and `series-choice-N-missing`: the accepted
   structural-reference recipe generalized to `N` selected members. The
   one-arm read conflicts at member `N - 1`; the later two-arm read conflicts at
   member `0`. Both outer selections use the documented guard occurrence. The
   found case must select member `0`; the missing case must ignore the untaken
   arm and select member `N - 1`. All members are admitted before either error.

The create-only cases run construction and logical analysis without database
execution. Overlap cases run the ordinary analysis/lifecycle needed by their
admitted recipe. Series-choice cases run on both `sqlite-interactive` and
`sqlite-atomic-batch`. Expected outcomes, member paths, SQL state, and progress
come from the frozen structural gate; counters are additional evidence, never
an oracle replacement.

## Frozen extension campaigns

Every range is inclusive and contains exactly 100 seed values per profile.
Every alternative runs the identical canonical recipe JSON and semantic
schedule for each `(slice, seed, profile)` cell.

| Slice | Seeds | Profiles | Cells per alternative |
| --- | --- | --- | ---: |
| A: terminal relation `updateMany` selection | `7100..7199` | `sqlite-interactive`, `sqlite-atomic-batch` | 200 |
| B: mutation limits | `7200..7299` | `sqlite-interactive`, `sqlite-atomic-batch` | 200 |
| A+B composition | `7300..7399` | `sqlite-interactive`, `sqlite-atomic-batch` | 200 |

Let `i = seed - firstSeed` for its slice. The recipes vary only the frozen
private capability contract:

- **A:** `rootCount = 1 + (i % 4)`;
  `keyShape = [single-kept, single-omitted, compound-kept,
  compound-omitted][floor(i / 4) % 4]`;
  `nestedShape = [create, updateMany, upsert-found,
  upsert-missing][floor(i / 16) % 4]`; and `i % 10 === 9` selects the approved
  missing-terminal-row case, otherwise every terminal row is present. Selection
  stays scalar-only; omit/include/relation projection are not generated.
- **B:** `mutation = [scalar-updateMany, scalar-deleteMany,
  relation-updateMany][i % 3]`; `rowCount = 1 + (floor(i / 3) % 4)`.
  `i % 10 === 0` uses `-1`, `i % 10 === 1` uses `1.5`, and `i % 10 === 2`
  uses zero; other cells use
  `1 + (floor(i / 10) % (rowCount + 1))`. Invalid values must fail admission
  before SQL; zero must admit the operation but no member/arm and no SQL;
  positive scalar mutations stay set-oriented and relation mutation caps
  capture before dynamic member admission.
- **A+B:** `rootCount = 1 + (i % 4)`; `i % 10 === 0` uses limit zero,
  otherwise `limit = 1 + (floor(i / 10) % rootCount)`;
  `choice = found` when `floor(i / 4) % 2 === 0`, otherwise `missing`;
  `seriesWidth = 1 + (floor(i / 8) % 4)`; and key selection alternates between
  omitted single and omitted compound keys. It exercises the approved nested
  choice/series composition only. Limit and terminal reading must report through
  the A and B owners; the collector refuses a third composition path label.

These campaigns are single-operation worlds. Their schedule is a canonical
list of semantic capture, member, choice, terminal-read, and fault-cut IDs
stored in the recipe, not physical statement indexes. This gives both
alternatives the same schedule even when their SQL grouping differs. The
existing `Recorder` records each build's actual statement tape and replays it
three times only against that same build. Cross-alternative comparison uses the
public recipe, semantic schedule, fixture outcome, final state, defaults, cuts,
and progress—not byte equality of SQL tapes.

## Collection commands and evidence schema

These modes are planned additions to the existing runner; they do not exist at
this freeze:

```sh
node scripts/run-raptor3.mjs cs02-structure-measure
node scripts/run-raptor3.mjs cs03-a-measure
node scripts/run-raptor3.mjs cs03-b-measure
node scripts/run-raptor3.mjs cs03-composition-measure
```

Each command uses the current resource ceilings, prints its temporary evidence
directory, and writes `instrumentation.patch`, `events.json`, and
`verified.json`. The receipt binds the first two by SHA-256. Both JSON files are
parsed with strict Zod schemas satisfying these TypeScript types:

```ts
interface MeasurementCase {
  caseId: string;
  slice: "structure" | "a" | "b" | "composition";
  profile: "construction-only" | "sqlite-interactive" | "sqlite-atomic-batch";
  seed?: number;
  size?: 1 | 2 | 8 | 32;
  recipeSha256: string;
  scheduleSha256: string;
  semanticInventory: {
    commandIds: string[];
    occurrences: Array<{
      occurrenceId: string;
      commandId: string;
      selectionId?: string;
    }>;
    selectionIds: string[];
    reads: Array<{ readId: string; occurrenceId: string }>;
    writes: Array<{ writeId: string; occurrenceId: string }>;
    activationIds: string[];
  };
  outcomeSha256: string;
  counters: WorkCounters;
  eventCount: number;
  eventsSha256: string;
}

interface MeasurementEventsFile {
  formatVersion: 1;
  cases: Array<{ caseId: string; events: MeasurementEvent[] }>;
}

interface MeasurementReceipt {
  formatVersion: 1;
  qualifying: true;
  alternative: "flat-history-reference" | "shared-occurrence-candidate";
  mode: "cs02-structure-measure" | "cs03-a-measure" | "cs03-b-measure" | "cs03-composition-measure";
  baseIdentity: ReturnType<typeof captureRaptor3Identity>;
  instrumentedIdentity: ReturnType<typeof captureRaptor3Identity>;
  instrumentationPatchFile: "instrumentation.patch";
  instrumentationPatchSha256: string;
  counterContractSha256: string;
  profiles: MeasurementCase["profile"][];
  firstSeed?: number;
  seedCount?: 100;
  cases: MeasurementCase[];
  eventsFileSha256: string;
  replays: number;
  skipped: 0;
}
```

The receipt lists each required case exactly once, sorts IDs before hashing,
binds the raw event file, and records three same-build replays per extension
cell. Structural create-only cases have no replay claim; executed structural
cases replay three times. Unknown keys, missing counters, duplicate cases,
wrong profile/seed/size, non-safe integers, a stale identity, a changed recipe
hash, a missing event, or any skipped cell refuses qualification.

## Fairness and acceptance

1. Start both worktrees from the same accepted CS-00 source plus the identical
   frozen CS-01 tests. Implement the same A, B, or A+B behavior on each
   structure; only representation-required code may differ. Do not simplify the
   reference, backport candidate caching, remove a reference scan, or add
   candidate-only fixture knowledge.
2. Freeze the canonical recipe and schedule JSON once. Copy its bytes to both
   worktrees and require equal SHA-256 before execution. A changed SQL statement
   or different work count is allowed; changed identity inventory, public input,
   semantic order, fault cut, or outcome is not.
3. Independently review each temporary instrumentation patch against the event
   sites. It may observe arguments and runtime lengths but may not memoize,
   reorder, short-circuit, precompute, catch, or otherwise change work.
4. Run the fixed structural/capability gates first. A counter receipt cannot
   turn a failed behavior contract green. Run all required cells, exact profiles,
   and same-build replays with zero skips.
5. Reduce raw events again outside the instrumented process. The independent
   reduction must equal every per-case counter and total. Source formulas,
   allocation estimates, wall time, and profiler samples cannot replace these
   exact counts.
6. Report necessary-distinct, speculative-distinct, and redundant-repeat work
   separately. Report administrative prefix/suffix/owner copies separately from
   semantic publication. A lower total is not enough if a semantic ID, branch
   activation, error priority, admission, progress, or physical effect changed.
7. Remove instrumentation, verify the base identities, then measure the already
   frozen core and broader source scopes. No counter result changes the existing
   repair budgets, authorizes new production scope, or selects an alternative by
   itself.

CS-02 implements only the structural recipes, event collector, reference and
candidate hooks, runner mode, schemas, reducer self-tests, and exact receipts.
CS-03 implements only the three frozen extension generators/modes and reuses
that collector. Missing instrumentation coverage, a non-reconciling counter, a
schedule mismatch, or a behavioral difference blocks comparison rather than
being normalized away.
