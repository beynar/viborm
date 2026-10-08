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

- Full package qualification of artifact21 reaches20 passing cases, then the
  existing TS5.9 chain100 probe exhausts its unchanged768MiB heap. The runner
  completes teardown at57.13s and1226.5MiB sampled RSS. This is a blocking
  regression under investigation, not a passing package gate. Query owns the
  focused cost repair. Log:`/tmp/viborm-v1-package21-full.log`.
- Artifact21 now passes the permanent backreference and accepted lossy-model
  control cases on both TS5.8 and native7. The exported client retains exact
  input/result types; constructing a new client from already-emitted raw cyclic
  models still fails the expected semantic probes. Native7 uses exit status1
  for diagnostics, unlike JS TypeScript's status2; the control now recognizes
  that installed compiler convention without changing its diagnostic whitelist.
  SHA256:`4cf484c449016e49dbc8ab75f1f2af301e139374531967308b151dda6d79c226`.
  The full51-case package gate and independent backend/scaling matrix are next.
  Changed-perimeter Biome passes572 supported files. Two final edits only remove
  an unused type import and sort type exports; runtime behavior is unchanged.
- CI now retains its exact Linux documentation build and checks the generated
  Worker with a bounded Wrangler dry-run. This adds verification and a renderable
  artifact; it does not deploy. Linux qualification is still pending.
- The integrated ordinary nested-WHERE field guard passes the complete ordinary
  source gate:40.63s/6102.9MiB, zero diagnostics and verified teardown. It walks
  caller-spelled filters with exact value/model cycle detection; model fields
  named AND/OR/NOT retain their existing precedence. TS5.8/7 packed source and
  emitted probes pass fresh/held/optional/logical/shorthand/isNot cases,
  including empty/undefined values and named-combinator fields. Only the newly
  refused deliberate AND typo pin was strengthened. Scalar operators, variants,
  nested projections and nested mutation key exactness remain separately scoped.
  Evidence:`/tmp/viborm-v1-where-guard-estate-2.log` and
  `/tmp/viborm-v1-where-guard-packed11-combinators.log`. Final archive and
  permanent backreference/raw-model controls are being qualified before CI.
- Native37 passes the ordinary `pnpm test:types` command with zero diagnostics:
  44.32s and6012.3MiB, unchanged8192MiB/300s limits and complete root program.
  Public factories anonymously materialize the homomorphic config, preserving
  source compatibility while preventing emitted original-schema aliases.
  The optional empty link marker may infer `undefined`; the shared model view
  treats it as the same empty graph as `never`, without parallel normalizations.
  All11 driver wrappers and internal construction seams use the same view.
  Evidence:`/tmp/viborm-v1-native-37.log`. Exact integrated carrier archive,
  nested-WHERE key admission, broader declaration/scaling and package gates
  are the next qualification steps; this is not release completion.
- The compatibility experiment now passes unchanged generic client factories,
  legacy `VibORMClient<originalConfig>` annotations, driver covariance and cyclic
  domain/result negatives on both TS5.8 and7 (4.36s/886.6MiB and
  1.88s/1043.3MiB). Schema/config maps must expose their original key sets;
  conditional projection belongs in each mapped value. Emission and the full
  source program still need qualification on that exact integrated candidate.
  Evidence:`/tmp/viborm-v1-compound-links-repair/generic-all-keymaps/`.
  The full single-threaded native compiler previously completed under the
  unchanged ceiling (47.60s/6776.4MiB), exposing source compatibility errors
  instead of exhausting memory. That diagnostic run is not a passing gate.
- Candidate6 repairs the TS5.8 compound-selector regression by naming the
  already-flat linked model state. Named, private-symbol-keyed extension
  capability interfaces also repair modifier declaration nameability. Chain5
  and compound/omit/cache/transaction declarations pass JS5.9 and native7
  emission and all eight separate strict TS5.8/7 consumers. Artifact SHA256:
  `cc60a6cbace10727eb2c2b1f9d3254b17786a96557adc3a0f15af892e3448903`.
  Evidence:`/tmp/viborm-v1-linked-client-20261008/candidate-6/receipts-modifiers-5-direct.json`.
  Root's whole-estate native29 fails the unchanged8192MiB ceiling at8519.3MiB
  after16.03s; baseline28 passed at6672.4MiB. Query owns the bounded overhead
  correction; no resource limit or source scope changes are permitted.
- Root's actual construction checks pass all four new factory/self/variant/
  modifier fixtures in0.50s at51.4MiB with database initialization prohibited.
  The first variant fixture violated the existing shared-primary-key domain
  rule; it now uses compatible string IDs while retaining distinct variant
  fields and negative numeric-ID probes. The corrected variant needs its
  compiler matrix rerun. New cases are registered in the permanent package
  gate; passing a scratch probe alone is not package qualification.
- Broader carrier qualification found a new TS5.8 regression: the combined
  compound-key/model-omit/default-omit/extension/cache fixture passes on immutable
  baseline20 (TS5.8:6.37s; native7:1.55s), but candidate2 and candidate3 report
  TS2589 at the valid compound `findUnique` selector. Native7 remains green.
  The same failure occurs with the bare core client, excluding extensions as
  its cause. Candidate3's inline compound-state materialization did not repair
  it. Candidate6's named linked state subsequently fixes the exact probe and
  its direct emitted-consumer matrix; whole-estate resource qualification is
  the current blocker.
- macOS docs builds still exceed the unchanged1536MiB RSS ceiling intermittently.
  A scoped collection experiment proves native-output release in isolation,
  but does not qualify the full build. It was removed from the production
  configuration. A credential-free Linux snapshot is ready; the local Docker
  engine is unavailable after a bounded startup/status attempt. The next exact
  checkpoint's Linux CI must qualify the real docs build, validation and dry-run
  under the same ceiling. No cap increase or engine reset is authorized.
- Schema-key carrier candidate2 now passes the original five-model cyclic
  backreference after direct JS5.9 and native7 emission, each consumed separately
  by strict TS5.8 and7: all four combinations pass positive/negative/no-any
  probes. Both emitters produce the same29,347-byte client type argument with
  zero elisions, zero getter functions and literal model-key links. Exported
  models still have40/24 elisions; all four complete rebuilt-client controls
  fail with semantic TS2322/2344/2578, confirming the accepted limitation.
  Artifact SHA256:`f5a27fc2f2515c91ee9e3fa50bbef9582ee4a0a5472889fd8761a5d8d615dc53`.
  Evidence:`/tmp/viborm-v1-linked-client-20261008/candidate-2/receipts-5-direct.json`.
  This is focused proof; extended cases, all tsdown paths, scaling, whole-source
  typechecking and final package/release qualification remain outstanding.
- Arnaud supplied the external type investigation and explicitly requested the
  schema-key link carrier implementation. Type work resumes here: query_engine
  owns the core flat/relinked client representation; drivers owns all driver
  factory signatures and declaration-consumer probes; root owns independent
  review, backend/performance comparisons and integration. Migrations continues
  the isolated docs qualification. Compiler/build runners remain serialized.
  The refined acceptance gate requires unannotated exported clients and client
  factories to retain exact types. Rebuilding a client from already-emitted
  models remains an explicitly accepted, tested and documented limitation.
  The immutable artifact20 baseline passes chain5 and dense12 source/domain
  probes on TS5.8 and7. The independent typo-beside-real nested-filter probe
  produces only unused-expect-error diagnostics on both: a pre-existing gap,
  tracked separately from declaration fidelity. Comparison fixtures and receipts
  are in `/tmp/viborm-v1-linked-client-20261008/`. The11 driver wrappers now
  share `LinkedClientConfig`; core/extension integration and permanent factory,
  self/junction, variant and modifier probes are awaiting compilation.
- Draft PR #84's preceding checkpoint was `8a7f4474c17ae523f565b657a13b2fe0f2905a8f`.
  CI4 run `37801092076` passed core, PostgreSQL/MySQL and types/format/docs.
  Coverage, local, Bun/D1 and both package jobs failed. No merge, publication
  or deployment has occurred. Local followthrough is not final CI proof.
- Schema, validation, errors, extensions, CLI, instrumentation and adapters pass
  all four 100% floors. SQL, client and cache also pass their unchanged floors.
  Adapter final11 executed399 tests across25 files in11.04s, peak763MiB;
  instrumentation final8 passed its complete registered projects.
- Migration final12 passes2075/2075 tests across129 files, including all
  unchanged coverage floors:98.48 statements/lines,97.31 branches and99.57
  functions. Targeted admitted catalog/default/DDL cases closed the missing
  outcomes; no threshold, source denominator or refusal was weakened.
- Query's current SDK descriptor/transaction-array fixture passes13/13. Actual
  SQLite1000-ID update/delete qualification passes6/6 with exact row counts,
  readback and unrelated-row preservation. The final focused coverage-fixture
  corrections pass154/154 focused tests in6.47s at770MiB. The subsequent full
  query run stays within the1536MiB ceiling but finds20 stale fixture failures.
  The seven affected files now pass76/76 focused tests in6.37s at738.1MiB,
  verifying public error codes, null ordering, clear-before-supply writes and
  physical decimal storage. Full query coverage final6 subsequently passes all
  3176 tests across242 files:94.23 statements/lines,94.33 branches and95.37
  functions, above every unchanged floor. Four sequential project receipts total
  107.49s, peak1356.9MiB; every teardown is verified.
  All62 current driver chunks pass2017 tests, with680 explicit conditional skips.
  Every unchanged driver coverage floor passes:96.65 statements/lines,92.76
  branches and96.16 functions. Successful chunk receipts total346.66s, peak
  692.8MiB, within the established600s per-child coverage policy.
- Actual D1 full suite41/41 passes. Borrowed PGlite timezone, Bun SQLite FK and
  surrogate ownership, and capacity/integer/WAL/local-libSQL63/63 pass. Actual
  Bun SQL TEMP-only unique/not-null/FK failures preserve a healthy session.
- Final safe Neon qualification passes12/12. The failed-BEGIN recovery repairs
  the existing pool without replaying callback or caller SQL. Controlled recovery
  and error-mapping80/80 pass, including deadlines, late-lease release and
  original/secondary error preservation. Final driver coverage is green.
- Actual libSQL HTTP qualification passes3/3 against isolated official sqld0.23.0
  and installed @libsql/client0.18.0: callback rollback, array-prefix rollback,
  committed suffix and borrowed-client lifetime. Hosted Turso and newer server
  versions remain unqualified; this is explicitly local network evidence.
- Native28 passes the whole estate in11.62s at6672.4MiB, with no diagnostics.
  The changed-file Biome gate checks657 paths (567 supported files) with no
  errors or edits. These checks include the final declaration export-kind fix.
  Current build20 passes2.62s at1042.3MiB. Its immutable tarball SHA256 is
  `fa5d434d4bb5688891dc4aee607605a2ccea37ff6a6c6f11715afc0f5f6eae40`.
- Immutable artifact17 passes ten dependent extensions through runtime, TS5.8
  source, declaration emission and downstream positive/negative checks, plus
  native and all27 export-kind goldens. Cyclic emitted backreference soundness
  remains open. At Arnaud's request, one Sol6.1 agent compared installed
  JS/native7/OXC declaration backends in isolated scratch directories. Every
  successful emitter loses the same downstream backreference contract under
  both TS5.8 and7; OXC requires explicit model annotations. The current backend
  is retained. `declaration-backends.md` records exact versions, timings and
  failures. Shared dist and runtime bundling were untouched. Getter-only return
  annotations passed all3 emitters and6 downstream checks, with
  no elisions and preserved inference. Arnaud explicitly chose to HOLD V1
  until fully unannotated cyclic emission is fixed. Keep the original gate and
  public guarantee; the annotation mitigation is evidence only. The goal stays
  active: continue the type correction and independent release checks. A
  two-model public reduction passes source checks but fails both emitted
  consumers; removing the client and driver preserves the failure in the
  Model/Relation state itself. Five-model size and client assembly are therefore
  unnecessary to reproduce it. Simpler dependency-free examples fail source
  inference and do not establish a compiler-only emission defect.
- Arnaud has assigned the remaining recursive traversal/declaration correction
  to a separate agent. This fleet stopped its type experiments and shared type
  edits immediately. The last isolated named-ModelTarget factory experiment
  retained source correctness but failed all emitted consumers and was rejected.
  Root continues runtime/docs/release qualification and will integrate the
  separate agent's verified correction. The unannotated release hold remains.
  Arnaud confirmed that the external agent uses a separate checkout.
- Package runner repair packs once and awaits asynchronous children, allowing
  the existing owner to tear down the original process group after per-case
  timeout. Controlled18/18 runner tests pass. Full package qualification under
  unchanged768MiB heap,1536MiB RSS and300s aggregate limits remains required.
- Real MySQL8.4.11 enum/namespace/index10/10 and wide-geographic84-point proofs
  pass; CI4 PostgreSQL/MySQL passes. Both supported better-sqlite3 branches
  12.11.1/13.0.3 have actual proof. Installed Blume Card components ignored73
  description props; those descriptions now use the supported content slot,
  with text and links preserved. Heap-only trials did not complete under the
  unchanged RSS ceiling. The installed docs Rolldown native pool has separate
  worker controls; serializing its real worker and blocking pools completes all
  120 pages in22.27s at1519.0MiB. Validation, Wrangler dry-run and an actual local
  Worker render pass. The exact command is now the normal docs build and a CI
  step. Final authored-callout/D1 documentation followthrough then exposed an
  RSS failure at1550.9MiB; the352MiB heap trial failed with a real V8 OOM at
  1409.4MiB RSS. The current docs build is therefore unqualified despite the
  earlier success. Later GC/turn and exact-version immediate-purge trials
  still failed at1564.4/1564.1MiB, with verified teardown. The small native
  lifetime proof passes, but the unqualified GC decorator/flag and all
  diagnostics/allocator settings were removed. Linux CI must qualify the exact
  saved build after frozen-lockfile install under the same1536MiB bound.
  Docker Desktop's engine remained unavailable after ordinary startup; no
  container/DB fixture or restart was attempted. No deployment has occurred.
- Immutable artifact19's Node22 public golden, absent-OTel and optional-peer
  checks pass. The CommonJS runtime then encountered a local better-sqlite3
  ABI137 versus Node22's127 mismatch. An isolated fixture now uses the same
  declared native peer built for22; shared node_modules and package helpers
  remain unchanged. The corrected Node22 fixture passes seven of eight checks;
  the extension recipe exposes a separate real declaration-bundler defect:
  defineExtension's shared-chunk alias V is incorrectly marked type-only because
  another module exports a type V. The old golden followed symbol identity but
  missed this intermediate type-only restriction. The driver agent is correcting
  that existing plugin and adding actual value-use probes. Build20 corrects
  the export using its actual local function declaration, while preserving
  explicit public type-only exports and external reexports. The strengthened
  golden fails19 and passes20 across all27 public subpaths. All16 targeted
  installed-package checks pass on Node22.12 and24.14 in47.37s, peak952.5MiB.
  Every88 packed runtime .mjs file is byte-identical between19 and20. Recursive
  model representation remains exclusively with Arnaud's separate agent; the
  original unannotated gate remains unchanged and red.
- Whole-perimeter counts use the same LF newline method as the archived base:
  src146602 versus141375 (+5227,+3.697%); tests458078 (+12622,+2.834%);
  scripts31835 (+141,+0.445%); docs content23184 (+55,+0.238%); benchmarks
  unchanged. Root build configuration and workflows are separate from src.
  Registry metadata still reports latest0.1.0 and next1.0.0-rc.5.
- `FINDINGS.md` renders all555 ledger entries. Publication fields and final LOC
  remain pending. The full response and fresh roast are in `RESPONSE.md`.

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
