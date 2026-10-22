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
candidate. Reuse an existing authenticated representation of the desired logical
schema when available; data-only states do not create snapshot objects. Delta
base selection is a storage choice, independent of transition ancestry and SQL.
Concurrent branches with different delta bases can publish distinct authenticated
objects safely; their logical schema identity still agrees.

Selected parents are the validated transitions actually entering the manifest,
including manual transitions, not the separate automatic parent-selection list.
Reuse takes precedence over new encoding for non-root states and considers
authenticated artifacts reachable from committed states, plus artifacts already
sealed within this candidate, in ascending physical-hash order. A root remains
full even when an existing delta represents the same schema.
Preview/publication determinism is relative to the same observed graph; a new
concurrent commit can legitimately change the next call's candidate.

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
