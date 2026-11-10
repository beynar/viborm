# Incremental migration snapshots

## Decision and evidence

Implement incremental persisted snapshots. Large schemas with small changes repeat
almost all schema JSON today. This changes artifact storage, not generated DDL,
database migration count, application time, or migration-state semantics.

Drizzle [RC5](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.5),
published 2026-10-21, explicitly introduces an initial snapshot followed by
structured differences and branch-commutativity metadata. Its release notes do
not give the reported 93% reduction or its measurement conditions. Treat that
number as an unverified comparison, not an acceptance criterion. Source tag:
`5d71fc408add08bd207f4753f4554578ec9e0640`.

The tagged [PostgreSQL generator](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.5/drizzle-kit/src/cli/commands/generate-postgres.ts#L51-L59)
emits a `base` with DDL for a root and a `diff` with deltas for descendants.
The [snapshot parser](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.5/drizzle-kit/src/dialects/postgres/snapshot.ts#L574-L617)
admits those two shapes. The SQLite snapshot in this tag still stores full DDL;
do not infer identical dialect rollout from the release-note wording.

VibORM already owns branch convergence through complete parent-specific
transitions. Do not copy Drizzle's commutativity engine or infer execution from
snapshot patches. Keep the existing serializer, DDL differ, resolver, compiler,
SQL authentication, execution, marker and ledger unchanged.

## Representation and owners

1. Preserve `encodeSnapshot` and its canonical full-schema SHA-256 identity.
   Full snapshot documents remain a supported representation, not a legacy
   compatibility reader. Push, no-op detection and database markers keep exactly
   their existing meaning.
2. A delta is canonical JSON with a closed versioned shape: `format`,
   `baseArtifactHash`, `snapshotHash`, and ordered `changes`. A change sets or
   removes one literal array/object path. This is a storage codec over JSON,
   never a second semantic/DDL differ. Arrays preserve order; append and tail
   removal have exact bounds. Object traversal uses own properties only and
   defines data properties, including names such as `__proto__`, without
   invoking prototype setters.
3. Authenticate exact delta bytes with a new frozen domain
   `viborm.migration.snapshot-delta.v1`. Use the existing `snapshots/` inventory
   and storage methods. A manifest optionally carries `snapshotArtifactHash`,
   included in its state identity. Without it, the full document is addressed
   by `snapshotHash`. With it, the physical delta identity and reconstructed
   logical identity must both match. Full documents and deltas therefore retain
   unambiguous, immutable content addresses; no filename is a logical-hash alias
   for unauthenticated patch bytes.
4. One `snapshot-artifacts.ts` owner admits delta shapes, encodes structural
   changes, resolves dependencies, verifies reconstructed full documents through
   the existing snapshot parser, and selects stored representation. Graph loading
   calls it once per command; consumers still receive full `SchemaSnapshot`s.
5. Dependency reconstruction is iterative, memoized within the command and
   bounded to 32 delta links. The generator writes a full checkpoint when that
   bound would be exceeded. Refuse malformed, missing, changed, over-deep or
   misbound artifacts before provider work. Authenticate a delta before reading
   its base. All reconstructed schemas pass the same strict parser as full ones.

## Generation and inventory

Start each root, including an authored history checkpoint, with a full snapshot.
For later states, consider only selected
parent artifacts, sorted by physical hash, and choose the smallest delta only
when it is smaller than the full canonical document. Ties retain the first
candidate. When a parent's artifact already stores the desired schema (a
data-only state), reuse it; no snapshot object is created. Delta base selection
is a storage choice, independent of SQL, and reads nothing but the parents.
Concurrent branches with different delta bases can publish distinct authenticated
objects safely; their logical schema identity still agrees.

Selected parents are the validated transitions actually entering the manifest,
including manual transitions, not the separate automatic parent-selection list.
A root has no parents and is therefore always full. A state's id hashes its
artifact, so the artifact is a function of the parents' artifacts and the
schema alone: regenerating a state from the same documents, names, parents and
decisions reproduces its id whatever else the history holds (see the revision
below).

Publish estate, snapshot artifact, SQL, then state manifest. Bases already exist
in the loaded graph. Dry runs write nothing and predict the same manifest as
publication. Partial publication can leave orphans but never a committed state
whose dependency has not been published.

Offline `check` uses the same dependency resolver for state-referenced and orphan
objects. Its referenced set includes the full transitive closure of snapshot
dependencies. Validate orphan deltas too; a listed-but-unreadable object is a
failure. Storage readers/writers and their conditional-create contract stay
unchanged. No garbage collector, history rewrite, upgrade command, compression
setting, dependency, public operation noun, or SQL parser is added.

## Adversarial review before implementation

Review these falsifiers against the actual code and revise this plan before
implementation: logical versus physical identity; hostile path/prototype edits;
noncanonical/unknown JSON; missing and corrupt bases; inconsistent declared
result; chain depth including cached ancestors; full/delta mixtures; branch
convergence from every parent; data-only and repeated schemas; deterministic
dry-run IDs; publication crash boundaries; orphan dependency accounting; and
history-free push. Record objections and their disposition here.

An independent architecture assessment proposed deterministic table fragments
instead. Its decisive objection to deltas keyed by logical snapshot hash is
accepted: those violate conditional-create when different parents yield the
same schema. This plan avoids that with a separate physical artifact hash
authenticated by the manifest. Table fragments would add three public storage
methods, change every custom storage implementation, and repeat an entire large
table for a one-column change. Retain deltas with bounded dependency depth and
explicit tests for those additional obligations. This adds complexity rather
than claiming an architectural simplification.

The independent adversarial plan review requested five changes, all accepted:

- Resolve/cache by physical identity and verify the result against **each**
  referencing manifest, including an explicit representation of the empty
  schema. Cache absolute depth and reject a child of a cached depth-32 base.
- Patch a freshly parsed, independently owned full document. Cache only after
  strict admission and logical-hash verification; siblings and failed children
  must leave the base unchanged.
- Refuse empty paths. Object segments must be strings; array segments must be
  nonnegative safe integer indices. Set may replace or append at length;
  removal may remove only the existing final array element. Reject `length`,
  named array properties, gaps and missing intermediate containers. Reconstruct
  without dropping invalid or unknown content before strict schema parsing.
- Specify the reuse universe/ordering and observed-graph scope above.
- Use actual validated manifest parents for manual as well as generated work.

Historical manifest bytes/IDs remain identical when the optional physical
reference is absent: never canonicalize an added `undefined` field. Orphan
validation must not expand the committed-state reference set.

## Implementation and verification

- Extend manifest admission/hash and introduce the one artifact codec/resolver.
- Integrate graph loading, deterministic generation and offline checking.
- Add focused core contracts for reconstruction, refusal, structural edits,
  immutability, chains/checkpoints, branch merges, reuse and missing/corrupt
  dependency refusal before effects. Use existing recording drivers; any actual
  database workflow proof belongs in an extended test, outside core exceptions.
- Exercise the public migration client on filesystem and strongly consistent
  object storage, including generating, checking and applying/rolling back a
  delta-backed state where appropriate. Keep all databases and directories local
  disposable fixtures.
- Measure canonical full-snapshot bytes versus actual snapshot-artifact bytes
  for one large initial schema followed by small changes. Report the entire
  snapshot history, checkpoint cost, SQL/manifests separately, and a control
  where full snapshots are smaller. Make no runtime speed claim without a
  runtime measurement.
- Update migration guide, storage docs and L12 project guidance for physical
  artifact addresses, reconstruction, and checkpoint behavior.
- Run focused tests, migration core, typecheck, migration coverage policy/gate,
  and applicable formatting/package checks. Review integrated source and final
  staged scope. Commit only task files, push feature branch and create/link PR.

## Implementation review and evidence

The independent implementation review found a missed typed `MigrationGraph`
fixture; added its required artifact map. It also requested a barrier-controlled
concurrent publication witness for equal destination schemas from different
bases. Added it: both generators reach manifest publication before either
manifest is visible, and publish distinct physical deltas with one logical hash.
No other runtime admission or consumer defect was identified by that review.

The reproducible snapshot-size test is
`tests/unit/migrations/incremental-snapshots-size.test.ts`. Initial result:

- 100 tables × 20 columns, initial schema plus 99 single-default changes;
- complete full-snapshot history: 14,741,390 canonical UTF-8 bytes;
- actual incremental snapshot objects: 616,430 bytes;
- 4 full checkpoints plus 96 deltas, maximum depth 32;
- 14,124,960 bytes saved, or **95.82%**;
- every reconstructed schema/hash checked, including cold reverse-order reads;
- tiny destination control uses the 13-byte full snapshot instead of a delta.

These are synthetic snapshot-only totals, not a Drizzle comparison, SQL savings,
migration-count reduction, runtime speedup or memory claim. Full-history loading
still materializes complete schemas. Deltas add a storage format and bounded
dependency reconstruction; they do not simplify the migration architecture.

The first 44 focused contracts and both live SQLite/filesystem workflow tests
passed. Final integrated qualification is recorded below when complete.

Pre-port qualification on local `543ef46f5`: the complete migration coverage
gate passed all 134 files / 2,147 tests. Statements/lines 98.52%, branches
97.40%, functions 99.47%; the new artifact codec measured 100% in every metric.
The separate 30-second core-lane invocation timed out after nine passing files.
The standalone size harness initially encountered an uninstalled `jiti`; it
was replaced with the existing Vitest runner, without adding a dependency.

Before PR publication, integration inspection found that local `main` was 17
commits behind `origin/main` (`29e43e6de`, v1.4.0), including migration artifact
caching and low-lock split generation. The feature must be integrated on that
base and those additional consumers verified; pre-port qualification alone is
not final evidence. The dirty original checkout is preserved.

## Integration on current main

Current-main integration retains its bounded `ArtifactCache`: full documents,
delta documents and manifests share that one exact-byte cache. Every command
still reads every physical dependency from its own estate before trusting a
cached parse or reconstructed schema. The canonical full size of a retained
reconstruction is charged alongside its delta bytes to the same cache budget;
compression must not admit unbounded decoded state. Cached deltas are frozen,
so reconstruction clones their change
values before editing a document. Reconstructed schemas are frozen before the
graph hands them to consumers. No second cache registry was added.

Low-lock PostgreSQL generation encodes each intermediate state's snapshot
before sealing its manifest. Later steps can use those candidate-owned
artifacts; their recorded depths obey the same bound. All states still seal
before publication and publish in parent order, with each manifest last.
Existing dry-run, failed-final-compilation and interrupted-publication retry
contracts continue to apply to the new physical references.

Authored history checkpoints always use full snapshots. `prune` copies the
physical dependency closure of retained states, base first, and checks copied
bytes against those authenticated by the loaded graph. It can retain an old
artifact required by a newer state without retaining the old migration state.
Logical marker, baseline and re-anchor identities remain unchanged.

The 69 focused current-main integration tests pass, including the existing
200-state cache/checkpoint estates. Those estates exposed two obsolete size
assumptions: a physical-only cache charge hid decoded memory, and a 50x pruning
comparison used an already compressed source denominator. The cache now charges
retained full-schema size; the pruning witness retains its 50x full-history
reference and additionally checks actual byte reduction and exactly two retained
snapshot objects. A trial without decoded-result memoization took 87.28 s for
these four suites; the integrated existing cache reduced that to 9.83 s. These
are local verification observations, not a published runtime benchmark.

The independent current-main review found one representation-selection gap:
a real state using the virtual empty snapshot had no physical base and was
mistaken for an authored root. Root status now comes from actual transition
parents, independently of eligible stored bases. A public generation regression
uses a valid empty-schema state after a delta-backed state and proves returning
to that schema reuses the original delta without publishing another snapshot.
The existing authored-checkpoint witness continues to require a full document.

The first current-main coverage run passed its tests but missed the unchanged
branch floor (97.18% versus 97.3%). Added meaningful boundary witnesses for an
evicted parse still producing a frozen reconstructed graph, a dependency
vanishing during prune, a stored virtual-empty snapshot, and malformed
PostgreSQL control-catalog answers. The rerun passed all 168 files / 2,531 tests:
97.24% statements/lines, 97.30% branches and 98.41% functions. The new artifact
codec has 100% in every metric. No coverage source, threshold or resource
limit changed. A further GeoPoint-annotation refusal joins the strict metadata
regressions and is included in the final core qualification.

Final current-main typecheck passed in 36.85 s at 6713.4 MiB sampled process-group
RSS (8192 MiB ceiling). Migration core passed all 149 files / 2,387 tests plus
type probes in 25.18 s, within the unchanged 30 s / 1536 MiB limits. All 44
coverage-policy and runner-policy tests passed. Live SQLite/filesystem coverage
also verifies the current-main rollback consent refusal before approving only
the disposable fixture's `entity.note` removal.

The production package build, all 54 packed-consumer tests, strict package lint,
documentation link validation and production documentation build passed.
The initial CI bundle-size check passed eight rows and exceeded two existing
limits: PostgreSQL migrations Worker 297.77 kB versus 295.9 kB, and all public
exports 429.44 kB versus 427.5 kB (gzip, as reported by `size-limit`). These
limits were left unchanged. The owner requested the reduction review below
instead of approving the proposed 298.1 kB and 429.8 kB limits. This is a shipped-code cost of the feature,
separate from the measured snapshot-history storage savings.

## Adversarial bundle-size review

The owner requested an adversarial review and an attempt to fit the existing
limits rather than approving increases. Two independent read-only review rounds
found no accidental dependency or dialect import. The second round found no
actionable regression in the retained reductions and no further evidenced safe
change that closes the remaining gap.

Built `29e43e6de` and `344bd1be8` in a disposable archive with the same installed
lockfile dependencies, build configuration, fixtures and gzip level 9. The
archive reproduced the feature build's measured sizes exactly. Final values
below come from the normal worktree package build and unchanged CI fixtures.

| Build | PostgreSQL migrations Worker | All public exports |
| --- | ---: | ---: |
| Current-main base | 295,582 B | 427,259 B |
| Feature before reductions | 297,771 B | 429,445 B |
| Feature after safe reductions | 297,412 B | 428,920 B |
| Existing limit | 295,900 B | 427,500 B |

Retained changes remove repeated algorithms and rules: standard `atob`/`btoa`
replace manual Base64 arithmetic while canonical shape/re-encode checks and
indexed byte reads remain; the existing type-default tables replace repeated
ordinary scalar switches while decimal, timezone, vector, list and fallback
semantics remain explicit; 18 persisted-array mappings share indexed diagnostic
paths without moving their admission checks; canonical-byte admission uses the
existing byte-equality owner. Regression tests cover large sliced byte views,
hostile iteration, RFC 4648 vectors, noncanonical padding, prototype keys,
timezone aliases, one scalar-kind read, and exact parser refusal order/paths.

Rejected genuine-private-field experiments saved only small amounts and would
change borrowed/proxy receiver behavior. Sharing the two undefined-key
projections would change accessor-observation timing. Neither tradeoff is needed
for incremental snapshots. Codec-format changes, shorter diagnostics, removed
guards, lazy-chunk accounting, different compression settings and altered
fixtures or thresholds were not used.

The retained reductions save 359 B and 525 B respectively. The limits still
fail by 1,512 B and 1,420 B. They remain unchanged; this review establishes a
measured reduction, not proof that no other implementation could fit.

Post-reduction qualification passed: complete types (53.49 s, 6801.9 MiB sampled
RSS), migration core (149 files / 2,399 tests plus type probes in 27.29 s),
migration coverage (168 files / 2,544 tests; 97.28% statements/lines, 97.31%
branches, 98.41% functions; artifact codec 100% throughout), all 54 packed-package
checks, strict package lint, all 44 coverage/runner-policy tests, Biome and
`git diff --check`. The size test again measured 95.82% fewer snapshot bytes.
Two core-lane attempts hit the aggregate 30 s limit while unrelated Node build
processes consumed several cores; one completed all runtime tests but left too
little time for probes. After observed contention dropped, the unchanged lane
passed in 27.29 s. Neither its time nor memory limit changed.

## Refresh after main advanced

During finalization, main advanced to `3e4f31ffd` with nested-write changes and
their own measured bundle-budget updates. Merged that exact commit cleanly as
`633504ba5`; its migration sources are unchanged. Rebuilt both that base and
the feature before/after reductions with the same dependencies and fixtures:

| Build on `3e4f31ffd` | PostgreSQL migrations Worker | All public exports |
| --- | ---: | ---: |
| Main alone | 297,203 B | 428,894 B |
| Feature before reductions | 299,371 B | 431,037 B |
| Feature after reductions | 298,985 B | 430,540 B |
| Main's existing limit | 297,500 B | 429,200 B |

On this base the retained changes save 386 B and 497 B, leaving overages of
1,485 B and 1,340 B. `package.json` and the lockfile have no feature diff against
this base: upstream headroom is not counted as a reduction or approval of this
feature's size. The earlier measurements remain above as the original review
record; this table supersedes them for the refreshed PR.

Qualification on this refreshed base passed complete types (43.62 s,
6797.0 MiB sampled RSS), all 168 migration-coverage files / 2,544 tests
(97.28% statements/lines, 97.31% branches, 98.41% functions; new codec 100%),
the production package build, all 54 packed-consumer checks, strict package
lint, all 44 coverage/runner-policy tests, and documentation validation/build.
The final unchanged size-limit check passes eight rows and fails the two rows
above with exactly these measurements.

The strict aggregate migration-core check did not pass on this refreshed base.
The first attempt exhausted 30 s during runtime tests; after observed external
CPU load dropped, a retry passed all 149 runtime files / 2,399 tests but used
30.03 s, leaving no time for its type probes. Unrelated Node builds continued
to consume several cores. This observation does not establish contention as
the sole cause: the aggregate gate remains failed, despite passing independent
typechecking and coverage and the earlier-base 27.29 s aggregate pass. No
budget, runner, test selection or threshold was changed to obtain a pass.
The PR remains draft with these timing and bundle gates disclosed.

## Final CI diagnosis and review

CI run `39814473980` on `3116e6a0d` completed the core job successfully
(529 files, 10,737 passing tests and one skipped test across the existing four
shards), as well as types/format/docs and every provider job. This is the
repository's existing CI core selection, not a rerun or replacement of the
local 30-second aggregate migration lane described above.

The only failing jobs are Package contract on Node 22.12.0 (`119949241143`)
and Node 24 (`119949241294`). Both pass all 25 runtime and 29 type package
consumer checks and package lint, then fail solely at the same two size-limit
rows: 298.99 kB against 297.5 kB, and 430.54 kB against 429.2 kB. The exact
local measurements above explain those rounded CI values. No test failure
or provider defect is being hidden behind the bundle failure.

Devin's final read-only review examined the feature worktree at `3116e6a0d`.
The reviewer had no shell access and ran no tests. The parent verified its
findings against the actual files and reproduced three failures before fixing
them:

- Pruning a valid implicit empty-schema state incorrectly required a stored
  snapshot. Prune now materializes canonical empty bytes only for the virtual
  case; an explicitly referenced empty artifact disappearing still refuses.
- The second state-manifest read was copied without authentication. Prune now
  compares it against the graph's canonical manifest before publishing it.
  The same gap existed for `estate.json`; its second read now receives the
  same check. Regression tests show neither swapped input publishes a state,
  and a swapped estate descriptor never enters the destination.
- The suggested empty-root-path guard is unnecessary: the encoder compares
  two complete snapshot records, so differing top-level container kinds are
  unreachable. The producing call now documents that invariant; hostile
  empty paths remain refused by admission.

The original three new regressions failed, then all 60 focused artifact and
checkpoint tests passed after the correction. An additional explicit-empty
dependency witness distinguishes a required stored object from the virtual
origin. The user explicitly approved only the two size limits, 299.3 kB for
the PostgreSQL migrations Worker and 430.9 kB for all public exports, including
the usual headroom. All other size, time, memory and coverage limits remain
unchanged.

Final review qualification: complete types passed in 47.13 s at 6776.0 MiB
sampled RSS. Migration coverage passed all 168 files / 2,548 tests at 97.28%
statements/lines, 97.32% branches and 98.41% functions. The strict migration
lane passed all 149 files / 2,403 runtime tests plus type probes in 25.76 s,
within its unchanged 30 s / 1536 MiB limits. This supersedes the earlier
local timing failure for the final tree. The production package build and
all ten bundle checks pass. After the prune fixes, exact gzip sizes are
299,039 B against the approved 299,300 B Worker cap and 430,609 B against the
approved 430,900 B all-exports cap. The fixes fit within the approved limits;
no additional headroom was added.
All 54 packed-package consumer checks passed again on the final build
(25 runtime and 29 declaration tests). Strict package lint, changed-file Biome
and `git diff --check` also passed.

## Revision (2026-10-24): representation from the parents only

The first implementation reused any authenticated artifact of the desired
schema in the observed graph, before encoding against the parents. A state's id
hashes `snapshotArtifactHash`, so the same state regenerated against a history
that had gained another form of its schema (another route to it, or a full
checkpoint of it) got a different id. That broke the documented restore repair
("generating the lost states again reproduces their ids exactly") and the
advice `reanchor` gives when the marker passed through a lost state.

Drizzle RC5 stores each `diff` snapshot against `ddlPrev`, the state of its
own parents (`generate-postgres.ts`, `snapshotOf`), and never borrows a
representation from elsewhere in the history. The encoder now follows the
same rule: it reuses a parent's artifact that already stores the schema,
otherwise chooses the smallest delta from the parents' artifacts or the full
document. A root has no parents, so the separate root flag is gone. Data-only
states still create no snapshot object; a schema that returns to an earlier
state's now stores a small delta against its parent instead of reusing the
earlier object. Content-addressed ids are kept, unlike Drizzle's random ids:
they are what makes the restore repair possible.

The synthetic 100-table history still measures 616,430 bytes: its states only
ever reuse or encode against their parents. A public regression regenerates a
lost state on a restored history that reached the same schema through another
parent and requires the original id; it fails against the first encoder.
