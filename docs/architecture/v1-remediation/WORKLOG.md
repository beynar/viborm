# V1 adversarial remediation

Goal: answer all 547 indexed findings and PB-1 through PB-8 from the October 8
adversarial review, repair actionable defects, verify the integrated release,
publish 1.0.0 as npm latest, and write a complete response and fresh roast.

The source report and its evidence remain in the original checkout at
`/Users/arnaud/code/viborm/docs/architecture/adversarial-review-2026-10-08.md`.
`findings.json` is the complete 555-item accounting ledger. Pending means work
remains; a documented limitation is not an implemented feature or a fixed bug.

## Checkout and baseline

Release branch: `bey-v1-adversarial-remediation` in the attached managed worktree
`/Users/arnaud/.codex/worktrees/v1-review-remediation/viborm`.
Base: `a4a5b8dc607a9a8db506bd60ddb5125519d8ab0b`, the exact reviewed origin/main.
The original checkout was 19 commits behind; its pre-existing tracked changes
were restored byte-for-byte after transferring only this task's initial edits.
Original untracked review/benchmark/evidence files are preserved.

`baseline.json` records source/test/docs counts. Detailed manifests and the
initial task patches are outside Git in `/tmp/viborm-v1-baseline-20261008`.
Production LOC is reported separately from tests, scripts and prose. Changes
must remove redundant rules or justify necessary new behavior; no code golf.

## Ownership and execution

All three child agents are GPT-6.1 Sol with high reasoning effort.

- `drivers`: driver transports, lifecycle/queues, errors at provider boundary,
  current peer APIs, Neon/HTTP contracts. Owns `src/drivers` and driver tests.
- `migrations`: migration safety, DDL/introspection, enum/rename/adoption
  semantics and managed scope. Owns `src/migrations` and migration tests.
- `query_engine`: query/write correctness, recursion bounds, nested verbs,
  polymorphism, ordering and measured SQL improvements. Owns `src/query-engine`
  and engine tests.
- Root: review/integration, package and lockfile, CLI, scalar/validation/adapter
  corrections, later extension/cache/type/docs waves and release orchestration.

No concurrent writes to another owner's files. All production and harness
writers acknowledge a freeze before broad qualification. Focused bounded tests
can run during implementation; their evidence is rechecked after integration
where affected. Use the existing safe runners and their memory/time limits.

## Accepted scope

Arnaud explicitly selected: fix every confirmed defect; report product gaps
explicitly. SQL Server, Studio, cross-schema relations, replicas and other new
product surfaces are not release implementation requirements. Every finding
still receives an honest disposition; documentation does not count as a bug fix
when faulty supported behavior remains.

## Work remaining

1. Complete and review current driver/migration/engine fixes; test exact repros.
2. Complete schema, validation, adapter, type, extension/cache, CLI and package
   findings, plus missing executable documentation and test registration.
3. Reconcile all 555 ledger rows with specific changes, tests, withdrawn claims,
   or explicit remaining product/governance decisions. Do not silently shrink
   the goal to critical findings or convert gaps to completed work.
4. Freeze and run full required source, package, provider, Neon and docs checks;
   repair verified failures and record final LOC and limitations.
5. Follow RELEASING.md: release PR, protected-main CI on exact revision,
   GitHub Release workflow, tested tarball, npm latest/provenance verification.
   Never publish workstation dist or bypass an approval/protection gate.
6. Deliver full response report and new roast. Update goal complete only after
   the actual requested outcome and release have succeeded.

## Latest integration checkpoint

- Draft PR #84 is at `f64f5030d03312b86684581f72c3a319c640ddf0`.
  CI3 run `37793992180` passed real PostgreSQL/MySQL and Bun/D1 jobs. Coverage,
  package, core, local and quality jobs failed; the exact failures are being
  repaired. No merge, publication or deployment has occurred.
- The actual changed-file Biome check now checks 504 files instead of zero in
  a shallow checkout. The next checkpoint must check its added files too.
- Schema coverage passed all four 100% thresholds across 2,319 test executions
  in 78 files. New cases exercise invalid generation descriptors, JSON null
  default boundaries and hostile serialized schema input. No floor or source
  denominator changed (`/tmp/viborm-v1-coverage-schema-2.log`).
- Collection verb order is now refused once during relation admission, before
  any DML. Captured time binding uses the existing canonical codec. The final
  focused repair batch passed 135/135; subsequent L3/OwnWrite/conditional
  fixtures passed 283/283. D1 passed 40/40. The composed assertion failure
  regression preserves exact primary identity and refuses unindexed guesses.
- Actual SQLite public operator and query-plan checks passed 14/14, including
  exact bigint-list membership above 2^53 and junction-first indexed lookup.
  PGlite named-zone and further numeric edge witnesses are next.
- Node 22.12's type stripper turned a multiline generic `return` into an early
  return in the soft-delete helper. Returning a named local factory fixes the
  source contract; an actual Node 22 before/after probe passed. Full package
  qualification still repeats this on the integrated artifact.
- Immutable artifact10 passed the 27-subpath public-surface golden. The narrow
  declaration-export correction now matches emitted entry filenames and
  preserves explicit type-only exports. Artifact12 emits a 30-model chain on
  strict TS5.8 and native TS7, but emitted cyclic backreference soundness is
  still under investigation. Ten dependent extensions also remain a type
  blocker; failed representation experiments are removed before replacement.
- Native17 stayed within the unchanged 8192 MiB ceiling: 15.73 s, 6560.3 MiB.
  A Go 6 GiB soft GC limit prevents the native compiler racing its hard RSS
  ceiling. That run failed 31 extension/soft-delete type diagnostics from an
  experimental conditional representation; its replacement awaits native18.
- Real isolated MySQL 8.4.11 passed all 10 final enum/namespace/spatial-index
  cases. Actual better-sqlite3 13.0.3 / SQLite 3.53.4 packed-consumer behavior
  passed alongside the installed 12.11.1 / SQLite 3.53.2 branch. Peer minimums
  are ^12.11.1 or ^13.0.3; frozen dependency resolution passed.
- The report ledger now explicitly answers 75 previously blank product-gap
  and contract rows. A stale cross-package Decimal claim was withdrawn:
  ordinary cloning preserves canonical text, but private Decimal/error brands
  remain local to an installed package copy. The docs explain conversion and
  deduplication instead of claiming structural authentication.

The entries below describe earlier checkpoints and are superseded where noted.

- Final local integration: native15 passed27.40s5290.0MiB; core7 all four
  sequential shards passed all9624 tests, unchanged budgets. Build6 passed2.79s
  960.9MiB; immutable artifact SHA256
  `23b9f10d5bca0828a0b23f58dde1021cc7199e48d5b9e71a725d7b32bdd01c9b`.
  Fresh installed consumer checks are running; no publication yet.
- Draft PR #84 remains at `2e00fa0a9`; V1 is not published. First CI run
  `37772874926` failed its eight jobs. A second integrated checkpoint is next.
  A fresh fetch confirms `origin/main` still equals the reviewed `a4a5b8dc6`.
- Native14 passed the whole estate in8.45s,5820.7MiB/8192MiB, including the
  minimal deferred recursive-arm fix and V2006 taxonomy. Later prefix/HAVING
  followthrough requires the final native check.
- All four core6 shards were collected:9556 passed,67 failed. Remaining failures
  were assigned by ownership. Root's three client/schema fixtures then48/48;
  drivers' ten files132/132; query and migration SQL fixture checks are queued.
  The sequential runner now collects later shard failures after ordinary test
  failures, retaining failure exit status, the same aggregate deadline and
  immediate stop on resource/teardown/interruption failures.
- Actual SQLite root gate20/20 passed3.17s537.7MiB, including canonical storage,
  post-inspection mutation refusal and JSON transforms producing document null.
  Root diagnostics/docs144/144 passed with actual OTel callbacks executed.
  Dependency adversarial smoke passed as a registered Node test,0.49s91.2MiB.
- Migration core13 passed1973/1973, Time6 focused66/66, latest real PGlite3/3.
  Core6 also executed both transformed-null default fixtures67/67 successfully.
- Query actual PGlite8/8 passed7.35s1949.2MiB under the existing2560 allowance:
  native string domains/equality/XML refusal, temporal, vector, wide projection,
  and bounded geospatial distance witnesses. Literal prefix/HAVING followthrough
  remains in the current bounded query batch.
- H13's minimal source fix passed native14 and an isolated extracted-package
  TS5.8 ring experiment. Fresh immutable build6 consumer verification remains;
  prior successful chain checks do not establish the final cyclic package proof.
- Provisional whole-perimeter counts:src146400 versus141375 (+5025,+3.55%);
  tests454626 versus445456 (+9170,+2.06%); scripts+36; live docs+10; benchmarks
  unchanged. Recount after the final batch; do not repeat the older2.9% figure.
- Secret-safe scan covered525 task files, found0 project credential-value
  matches, and confirmed no environment files tracked. Repeat at final commit.
- Cloudflare authentication succeeded for the configured docs account. The
  release workflow builds docs but does not deploy them; publish the validated
  matching site and verify viborm.dev as release followthrough.

Earlier chronological notes below retain superseded checkpoints. Local logs
are `/tmp/viborm-v1-*`; final claims require the actual CI/artifact revision.

## Current integration notes

- Initial three-way patch conflicts in SQLite parameter conversion and the
  main query owner were resolved by their owning agents preserving upstream.
- Root is upgrading Neon to 1.2.0 and libSQL to 0.18.0, adding the existing
  transitive jiti 2.7 loader as a direct CLI runtime dependency, and enabling
  Node's `require(esm)` export fallback. PlanetScale 2.0 formatting choice is
  still under review; no unverified support claim.
- `.env` in this ignored worktree links to the original project environment.
  Never print credentials. Hosted test writes must use isolated task fixtures;
  destructive database operations require the user's explicit authorization.

## October 8 integration checkpoint (updated)

- The managed branch, local origin/main and live remote main were all verified
  at a4a5b8dc607a9a8db506bd60ddb5125519d8ab0b. Original user work remains
  untouched. Task edits are partly staged from the initial transfer: inspect
  `git diff HEAD`, not only unstaged changes.
- Neon 1.2.0, libSQL 0.18.0 and runtime jiti 2.7 are installed. The unrelated
  docs dependency upgrade was reverted; root lockfile delta is +127/-5 and
  `pnpm install --frozen-lockfile` passed. PlanetScale stays at its admitted 1.x
  API pending a tested current-major implementation.
- Full native typecheck 1 failed with integration diagnostics. Full native
  typecheck 2 also failed (9.63s, 7367.3 MiB process-group RSS / 8192 ceiling);
  log `/tmp/viborm-v1-typecheck-integration-2.log`. Owners are repairing scalar
  generation inference, concrete policy-name guards, root storage-check typing,
  legitimate optional projection options and affected public probes. No full
  passing integrated typecheck exists yet.
- Driver evidence: hosted Neon 6/6 on the SDK 1.2 public API with query-local
  parsers and array-based HTTP transaction API; owned/supplied pg/postgres TCP
  and HTTP under America/New_York. Latest isolated retained empty hosted table:
  `public.viborm_v1_eac80f2633d442299a48737dae3b5681`. Year-zero extension is
  prepared but unrun. No hosted table was dropped or truncated.
- libSQL PB2 is mitigated by exact-handle quarantine after SQLITE_BUSY, shared
  by every wrapper. Owned handles require disconnect/recreation; supplied handles
  require replacement. Controlled PB2/cache/preparation 17/17 passed. A supplied
  integer-admission probe crossing was found in finishing review and corrected;
  its new regression still needs to run. This is not transparent recovery.
- Driver/scalar focused evidence: transport/lifecycle39; model rules37;
  modifiers6; refined updates8; string schemas120; schema JSON35+20;
  error registry18 all passed. New malformed custom-schema output regressions
  and refined arithmetic type corrections await their focused/native gates.
- Query/client focused gate127/127 passed after correcting invalidation ownership,
  interceptors, nullable/variant cache codecs and fixtures. Full cache gate then
  passed92/95; three obsolete expectations were corrected, and a rerun with
  dangling-control refusal is running. Do not report the failed run as green.
- Root focused gate45/45 passed: temporal/JSON admission, SQL-fragment boundary,
  real SQLite numeric/GeoPoint precision and physical storage checks. The true
  native-batch witness was corrected afterwards, and exact calendar/clock
  predicates now reuse the migration physical owner; these changes need rerun.
- Root PGlite provider gate3/3 passed (1904 MiB under isolated2560 allowance):
  year-zero temporal scalar/lists, native JSON predicates, 121-field projection,
  PostGIS bounds/negation/delete. A distance-rim oracle is added but unrun.
- Migration focused gates include370 core,52 managed SQLite,69 CLI,165 DDL,
  37 decimal-carrier,30 adversarial and final118 core (including15 push) passed.
  Current BC-default, authenticated old Geo manifest/replay/upgrade and public
  temporal repair helper regressions remain queued. Geo precision downgrade
  explicitly refuses an automatic lossy rollback.
- Pure SQLite physical codecs were moved from migrations to adapter storage
  owners; runtime does not import migration assembly. Shared timestamp decoding
  moved to the existing validation physical codec. Moved code is counted on both
  sides in LOC measurements.
- Root storage guard currently observes all sensitive SQLite tables per model
  operation. Query owner is reviewing actual operation dependency capture to
  avoid unrelated-table failures and unnecessary reads. Separate observation and
  dispatch does not yet establish protection against concurrent external DDL.
- Latest root changes awaiting checks: immutable enumerable Decimal canonical
  value plus inspection/clone behavior, build keepNames, named non-model schema
  refusal and corrected onboarding example, optional select/include guard,
  JSON input undefined normalization and output JSON Schema required/default
  metadata, recursive depth export and true native-array storage guard.

## Immediate handoff order

Query focused cache/H9 gate → migrations focused core and isolated PGlite →
root focused validation/SQLite/PGlite → drivers focused quarantine/scalar/hosted.
Only one safe runner at once. All writers freeze before the next full native
program. Driver owner next investigates public declaration emission; query owner
reviews SQLite storage dependency placement. Root owns package/types/adapters,
validation primitives except the delegated scalar-output composition helper,
and full ledger/report/release integration.

## Current gate-3 preparation

- Hosted Neon SDK1.2 year-zero extension passed6/6 (7.38s,448.3MiB).
  Latest retained empty table: public.viborm_v1_d9d91d847e8e4288b2bf8e1cd044f875.
- Driver quarantine/scalar output86/86 and divide-zero10/10 passed; final
  temporal-output plus divide-zero11/11 passed. Vector dimension admission was
  then repaired at its scalar/base owner and awaits the next runtime/native gate.
- Migrations final temporal/legacy-Geo/DDL core257/257 and isolated PGlite
  defaults/enum/lock proof passed (4.99s,1721.8MiB). New bounded MySQL/SQLite
  physical-key, pgvector preflight and native-index safety followthrough pending.
- Root focused82 had81 passes and one obsolete Decimal clone pin; after removing
  that contradictory pin Decimal25/25 passed. SQLite storage8/8 (including true
  native batch, malformed calendar and temporal JSON arrays) and named schema
  registration11/11 passed. PostGIS/temporal/wide-result PGlite4/4 passed
  (7.47s,1705.8MiB), including15 distance caps and480 independently computed points.
- Query cache95/95 passed. Combined186 had5 failures:3 obsolete/invalid fixture
  oracles and2 real generated OR-depth failures exposed by corrected native
  bind caps. Balanced generated predicates and single-key IN fixes landed;
  rerun pending. Actual per-operation model dependency capture also landed.
- Latest root unverified: unsafe int admission, finite/float32 vector admission,
  nullable/zero-cosine distance types and provider tests, and refusal of raw
  template interpolations with all internal trusted-text callers made explicit.
- All source writers will freeze before native gate3. No full green native
  integration or package build exists yet; do not infer release readiness.

## Repository release/security settings checked

GitHub active rulesets21923106/21923488 protect default main and release tags;
classic branch-protection endpoint404 does not mean main is unprotected. Main
requires the eight exact runbook CI checks and a PR. Immutable releases enabled;
npm-production retains its required reviewer and main deployment policy.

Under the requested security remediation, enabled secret scanning, push
protection, Dependabot alerts and security updates, and CodeQL default setup.
Readback confirmed enabled settings and vulnerability-alerts HTTP204. CodeQL
setup run37758619409 is pending qualification; configured is not a successful
scan. No security finding contents or secrets were printed.

Interim measured all-file source perimeter144059lines versus141375baseline
(+2684,1.90%). Tests449719versus445456(+4263). Both sides of moved modules are
included. Measurements precede final source/format changes and are not final.

## Integration gate 3 and remediation

Native gate3 failed9 diagnostics (8.77s/6821.4MiB); assigned corrections saved, next native qualification pending. Broad core1 hit1536MiB after49.27s, so core now runs two sequential Vitest shards under the unchanged aggregate300s/768heap/1536RSS policy. No coverage is excluded.

Migration full runtime1952/1952 passed8.94s/865.9MiB. Drivers433/436 plus focused correction53/53 green; protected storage transform and existing transport error snapshot/context owner repaired. Query84/84 passed12.12s/488.6MiB, PG boolean aggregate1/1 passed5.53s/1335.1MiB, repair2 22/22 passed4.92s/463MiB.

Root validation/operation/adapters2569/2570 plus one suite import failure: obsolete Geo polygon shape corrected, scalar owner correcting generated-array fixture. Root SQLite17/17 passed6.16s/547.7MiB, including actual operation footprint, external DDL/temporal race atomic refusal, structural JSON equality/membership. PGlite adapter6/6 passed11.37s/1868.7MiB, including nullable/zero cosine, finite float32, vector dimensions. Later citext change not yet tested.

Storage admission now checks actual statement model dependencies and guards the observation inside the existing atomic execution unit; protected contexts retain trusted observer chain and bypass user transforms. No successful observation persists across operations.

CodeQL initial setup run37758619409 completed successfully for javascript-typescript and actions. Production dependency audit added to CI; registry audit qualification pending.

## Integration checkpoint 2026-10-08, native8

Native whole-estate typecheck passed in8.99s,7158.3MiB peak/8192MiB, verified teardown (`/tmp/viborm-v1-typecheck-integration-8.log`). Core2 reached1555.2MiB/1536MiB before finishing shard1/2; four sequential shards now retain all selected tests and the same300s aggregate deadline. Actual failures: two SQLite error-metadata oracles, autogenerated-array-ID fixture, and extension array admission phase ordering; assigned to owners. Build2 passed2.65s1009.9MiB and packed a2,065,572byte artifact; consumer tests still found CloudflareKV optionalpeer reachability and extended-client declaration portability, now patched but awaiting build3. Prior Neon concurrent upsert/connectOrCreate and lock-witness H23 passed5/5. Production audit currently20 advisories,13high/6moderate/1low; no audit suppression, fixes in progress. No release or publication performed.

## Draft release PR and final integration

Checkpoint commit `2e00fa0a9` pushed to `bey-v1-adversarial-remediation`, draft PR https://github.com/beynar/viborm/pull/84; CI run37772874926 started for required external gates while local fixes continue. No main merge or publication. New query admission/control/recursive batch138/138 passed8.91s/631.6MiB; protected consumer build4 copied after5.92s/843.9MiB, actual ring10 declaration proof pending. Production audit0high/0critical,2moderate/1low; frozeninstall/securitypatch fixtures passed. `.gitattributes` limits blank-at-eol exception to unified patch data whose context-empty lines require a space prefix, all other whitespace checks unchanged.
