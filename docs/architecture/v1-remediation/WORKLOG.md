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

- The next original provider groups complete with failures on frozen artifact30:
  shared6 has116 passes/44 failures across14 files (14.79s/1750.6MiB), and
  shared7 has223 passes/5 failures across14 files (13.98s/1767.3MiB). Both
  verify teardown. The retained logs are `/tmp/viborm-v1-ci8-tail/stage-5.log`
  and `stage-6.log`. Migration operation-count/prefix assertions, cache scope,
  path-bearing errors and combined-write ordering are assigned separately;
  the same-ID upsert/deleteMany case needs a schedule witness before changing
  its expected result. These groups are not qualified by the earlier passes.

- Final checkpoint11 candidate is artifact30, after fixing the confirmed
  upsert admission gap: supplied non-record targetWhere/setWhere had silently
  erased guards before arm selection. The existing core.where parser now owns
  every supplied clause; empty/undefined and valid conditional semantics stay
  intact. Original shared5 passes241/14 in13.26s/2192.1MiB, including both clauses,
  five invalid input kinds, found/absent zero-effect cases, and legal positives.
- Artifact30 builds2.09s/951.4MiB; archive SHA256
  `24b77855cb4405d4b80f5ad113eff6c6adbfd15f0571ff779fb5716f97fec222`,
  2,051,795bytes from538 frozen inputs. Compared with29, all34 declarations are
  exactly equal after two generated chunk references and three specific JSDoc
  corrections; no type expression changes. Native48 passes the complete final
  source/test estate: zero diagnostics,34.35s/5950.1MiB, teardown verified.
  Receipts `/tmp/viborm-v1-diagnostic-artifact-30/receipt.json`,
  `/tmp/viborm-v1-artifact30-declaration-equivalence.json`,
  `/tmp/viborm-v1-native-48.log`. Remaining original provider groups run on30.

- Checkpoint11 preparation: package29 passes all33 installed-consumer cases in
  83.18s/1244.6MiB, teardown verified. An independent Sol6.1 review finds no
  blocker in sequential preparation, cancellation or official logging. Exact
  origin/main remainsa4a5b8dc6. No merge, tag, publish, or production deploy.
- The next original provider stages exposed stale cache/default-invalidations
  and path-bearing error expectations, plus one more same-lease race hook.
  Four fixtures are corrected without production changes; a bounded census of
  281 selected/imported files finds no further equivalent public same-transport
  hook among17 protected-batch files. Hook test-body AST parity is recorded;
  malformed targetWhere now proves rejection before effects and a legal positive.
  Original shared4 passes205/14 in12.36s/1644.8MiB. Original shared5's deadlocked
  run was terminated through its active bounded owner at89.07s/2233.4MiB and is
  explicitly incomplete; the subsequent full rerun passes as recorded above.
  The stale cache
  guide sentence is reconciled with default namespace-wide invalidation; that
  Markdown-only change does not affect artifact29's executable source.

- Artifact29 contains the final qualified sequential-batch fix. Build passes in
  2.27s/991.6MiB under the unchanged package limits; archive SHA256
  `3a0ac467f614f5f7063c9469faa6d54386159c55bbfbf6cf0245ea6bd2203d2f`,
  2,051,919bytes. Its34declarations are byte-identical to28; the118-row matrix
  remains applicable by recorded equivalence, not a claimed rerun. All53 package
  scenario/source pairs remain unchanged. Focused60/60 and boundary122/122 pass
  in4.22s/527.8MiB and4.18s/753.1MiB with verified teardown. The required
  preparation-order oracle now expects no SQL if a later transform fails; exact
  observer counts, BEGIN/ROLLBACK, per-statement logs and error context remain.
- Native46 reports one test-only logging callback returning Array.push's number
  instead of void. Both callbacks are corrected without changing runtime effects;
  native47 passes the final frozen source/tests with zero diagnostics in
  33.73s/6003.6MiB, under the existing8192MiB allowance, teardown verified.
  Final Neon qualification on the same source passes12/12 in7.69s/527.1MiB;
  owned fixtures remain empty, no DROP/TRUNCATE or secret disclosure. Logs
  `/tmp/viborm-v1-native-47.log`, `/tmp/viborm-v1-neon-artifact29-final.log`.
  Source count147336
  (+5961/+4.2164%); tests460348 (+14892/+3.3431%); scripts31874
  (+180/+0.5679%) after removing the58-line temporary sampler and CI preload.
- Both forced-GC approaches fail genuine cold builds and are rejected. Original
  docs config with384heap passes cold in10.20s/1394.0MiB; the otherwise-identical
  immediate-native-purge candidate passes10.14s/1389.1MiB. All145HTML semantics,
  137JS/2CSS/27fonts/121PNG agree with the inspected output. The4.9MiB difference
  is inconclusive on macOS. The saved draft build uses384heap (within the original
  768 allowance) and MIMALLOC_PURGE_DELAY=0 for Linux qualification, retaining
  1536MiB RSS/300s. MiMalloc's actual arena multiplier is4, not the stale comment's
  10. No allocator benefit is claimed before the Linux gate; no production deploy.
  Receipt `/tmp/viborm-v1-docs-purge384-comparison-receipt.json`.

- CI10 atf861f224b passes Core, Node24package, PostgreSQL/MySQL and Bun/D1.
  It exposes a real SQLite guard-ordering defect after the dispatch correction:
  a later user transform can change storage after an earlier protected guard.
  The reviewed sequential owner now prepares every transform inside its own
  observation before any provider effect, then dispatches and completes forward.
  The +43-line owner change and observed/unobserved race/failure regressions are
  frozen pending focused qualification; artifact28 is not a release candidate.
- CI10 Node22 hits the unchanged30s case deadline in lossy-models after its
  strict producer and positive consumer pass. Positive and expected-lossy
  consumers now share one emitted-only compiler program; every diagnostic must
  belong to the negative control. TS5.8/native checks pass locally onNode22 in
  7.17s/823.8MiB and2.51s/749.5MiB. Deliberately poisoning the positive consumer
  with an allowed diagnostic code correctly fails both, preserving the oracle.
  Logs `/tmp/viborm-v1-lossy-combined-ts58-node22.log`,
  `/tmp/viborm-v1-lossy-combined-native-node22.log`, and receipt
  `/tmp/viborm-v1-lossy-combined-negative-oracle-proof.json`.
- Corrected original shared-PGlite shard2 passes190tests+5conditional skips
  across14files in12.91s/1812.4MiB; shard3 passes154/14 in12.20s/1671.2MiB.
  Both retain the isolated2560MiB ceiling and verified teardown. The physical
  dispatch oracles now observe the actual provider call; pure preparation and
  exact-once transform checks remain. Original red/incomplete receipts remain
  recorded. Remaining provider stages await the new frozen runtime.
- Linux docs CI10 reaches1536.6MiB in26.62s. Its diagnostic shows the mainNode
  owns nearly all memory, with substantial native allocation before OG rendering;
  there is no child-process fleet. A scratch SSR-hook collection preserves exact
  output and saves30.5MiB RSS in a warm run, but the cold run OOMs before that
  hook. An earlier supported client-build collection is being tested. No shared
  docs change, memory-ceiling increase, or production deployment has occurred.

- Native45 checks the complete integrated source and fixture/harness estate:
  zero diagnostics,34.84s/5958.1MiB under8192MiB/300s, teardown verified.
  `/tmp/viborm-v1-native-45.log`. Shared provider reruns now own the runner.

- Artifact28 is built from538 frozen inputs, SHA256
  `20580d2976056dc737d9baccefb10b428db7da5cd202ffbc7e71718f5b1468a1`,
  2,051,109bytes. Build2.16s/1026.3MiB, teardown verified. All34declaration
  files match27 exactly after two generated chunk references and one unused
  optional parameter label are normalized; no type expression changes. The
 118-row backend/type matrix remains applicable by that recorded equivalence.
  Package gate28 passes33/33 in87.15s/1218.1MiB onNode24.14. All53 expanded
  compiler/scenario pairs are unchanged from the prior43case harness: original
 51 plus recursiveJSON on both compilers. Strict producer emission and separate
  emitted-only consumers remain intact; the30s/300s/1536MiB limits are unchanged.
  Receipts `/tmp/viborm-v1-artifact28-declaration-equivalence.json`,
  `/tmp/viborm-v1-package28-scenario-parity.json`,
  `/tmp/viborm-v1-package28-node24.log`.
- CI9 Coverage completes successfully at997e84a1b: CLI87allfourmetrics100%,
  all coverage floors satisfied. This predates the dispatch runtime fix.
  Source atcheckpoint10 is147293lines (+5918/+4.186%); tests460058
  (+14602/+3.278%); scripts31932 (+238, including58temporarydiagnosticlines);
  livecontent23200 (+71). The dispatch owner correction removes12source lines.
  Temporary build diagnostics are verified locally (10samples from only the
  actual buildNode,10.57s/1358.8MiB); Linux evidence and removal follow.

- Checkpoint10 is in preparation. CI9 Quality still exceeds1536MiB:
  the352heap build completes all three Vite builds and121OG routes, then
  crosses1548.4MiB during authored HTML at22.42s. A temporary Linux
  memory diagnostic will identify retained process/heap/native allocations;
  the RSS/wall ceilings are unchanged. Node22 package qualification hits its
  unchanged300s aggregate with no assertion failure, so graph fixtures are
  grouped into independent modules in shared compiler programs. Every original
  scenario remains and no compiler/consumer boundary is removed.
- The next shared PGlite family exposes a real lifecycle defect: unobserved
  array planning runs statement transforms, then fallback dispatch runs them
  again. The two driver owners now retain private prepared Sql provenance
  without user effects and materialize it at actual native/sequential dispatch,
  with or without observers. The original once-only oracle stays intact.
  Focused39 and boundary122 checks pass; final source/build checks remain.
  Artifact27 remains historical evidence and must not be published after this
  runtime change; a newly frozen artifact will replace it.
- Controlled-race fixtures in supplier-continuation/progressive-parent-rowkey
  deadlock by awaiting public writes from inside the physical connection lease.
  Their hooks move to public batch boundaries; original race and final-state
  assertions remain. Shard2 is red and shard3 explicitly interrupted/incomplete
  after440.23s with verified teardown, not counted as a passing stage.

- Checkpoint9 responds to exact CI8 evidence. The unchanged1536MiB ceiling
  still caught Linux docs at1536.8MiB with448heap, so the now-smaller retained
  build graph is constrained to352heap. Node24.21 fully cold build, with owned
  runtime/content/OG caches and121 freshly rendered images, passes11.50s/
  1373.8MiB. Actual-root warm passes10.30s/1376.9MiB. All145HTML semantics,
 137JS/2CSS/27fonts/121PNG are identical to the inspected output. The352
  correction changes one numeric option and zero LOC; no RSS/wall exception.
  Logs `/tmp/viborm-v1-docs-ci8-heap352-node2421-cold-og.log` and
  `/tmp/viborm-v1-docs-root352-node2421-warm.log`; compact parity summary is
  in `/tmp/viborm-v1-docs-ci8-352-parity.json`. Linux qualification remains.
- CI8 coverage diagnostics identify loadConfig's loadEnvFile branch exactly.
  The ignored local.env had supplied accidental coverage; a fresh Linux
  checkout has none. A disposable fixture now proves .env loads before config
  evaluation and the resulting SQLite client executes a real query. Probe
  environment/cwd/client lifetimes are restored. The incidental Jiti-null
  TypeError probe is removed; final87 passes100% on all metrics at4.43s/
  739.7MiB on exactNode24.21. No production loader change. Receipt:
  `/tmp/viborm-v1-cli-coverage-ci8-final87.log`.
- CI8 passes Raptor102files/1331tests remotely in100.69s under120s, and all15
  ordinary local shards. The next PGlite family exposes five old expectations:
  clearing verbs precede adding verbs; scalar createMany groups two rows into
  one INSERT; an absent reflective delegate is undefined. Corrections retain
  all data/effect oracles and strengthen exact inserted rows, generated-ID
  order, no-provider-dispatch on missing delegates and a succeeding real read.
  The original14file/251test family passes15.14s/1672.1MiB under its existing
  isolated2560MiB allowance. Remaining shared/imported families are running
  sequentially, with every stage failure retained, before further qualification.
  `/tmp/viborm-v1-ci8-family-1.log` records the affected success.
- Checkpoint9 count: source147305 (+5930/+4.1945%), tests459897
  (+14441/+3.2418%), scripts31874 (+180/+0.5679%), livecontent23200
  (+71/+0.3070%). `/tmp/viborm-v1-checkpoint9-loc.json`. Source/package
  artifact27 remains unchanged; finalCI must include the latest test changes.

- Checkpoint8 closes local docs qualification without a resource exception.
  Vite's installed sharedConfigBuild retains one config graph; Tailwind stops
  scanning only architecture evidence and generated dependency aliases. The
  census retains every live content/page/theme source. Final configuration
  passes cold9.77s/1460.8MiB and warm10.29s/1420.1MiB, under unchanged448MiB
  heap/1536MiB RSS/300s. The earlier2048MiB proposal was never applied and is
  no longer needed locally. Link validation passes2.39s/369.0MiB. The source
  Wrangler config now owns only deployment identity; CI and deployment use
  Blume's generated entry, asset binding and routing. Dry run passes
  0.84s/492.3MiB. Actual local Workers passes nine HTTP/MCP checks, and browser
  tabs/search/navigation and rendered pages pass without console errors.
  All120 content routes plus the homepage retain navigation and CSS vocabulary;
  the intentional JSON snippet adds eight highlighted lines. JS137/fonts27/
  PNG121 hashes match the previous qualified output. Preview was stopped with
  verified teardown. Receipt:
  `/tmp/viborm-v1-docs-final-local-qualification.json`.
- CI7 at e8e5b5d5c passes both package jobs, core, PostgreSQL/MySQL and Bun/D1.
  Quality fails only at docs RSS1547.2MiB; coverage passes85CLI tests but
  branches measure99.65% against100%; local providers expose the stale physical
  SQLite metadata oracle and the120s Raptor aggregate. Current repairs still
  require Linux CI. The exact CI Node24.21/V8 runtime passes87CLI tests locally
  with all metrics100%; the failed loader experiment was fully reverted.
  Failure-only branch diagnostics preserve the floor/throw, print at most20
  locations, and pass real-map green/one-miss/25-miss controls. Receipts:
  `/tmp/viborm-v1-cli-coverage-ci7-final87.log` and
  `/tmp/viborm-v1-coverage-diagnostics-proof.json`.
- Raptor's original fixed stage passes102files/1331tests in34.16s/1007.3MiB
  under unchanged120s/768heap/1536RSS. Scalar seed loops use public createMany;
  each test keeps its own fresh database and every test body/assertion is
  unchanged. The affected232tests pass21.75s/865.4MiB. Native44 then checks the
  complete estate, including these helpers and final CLI tests: zero
  diagnostics35.89s/5925.1MiB, unchanged8192MiB limit and verified teardown.
  Logs: `/tmp/viborm-v1-raptor-ci7/full-fixed.log` and
  `/tmp/viborm-v1-native-44.log`. Current source is unchanged from artifact27;
  no package rebuild is inferred from test/docs/reporter edits.
- Current whole-perimeter count: source147305 (+5930/+4.1945%), tests459850
  (+14394/+3.2313%), scripts31874 (+180/+0.5679%), live content23200
  (+71/+0.3070%). Build/deploy config and workflows are counted separately;
  no policy ceiling changed. Receipt `/tmp/viborm-v1-checkpoint8-loc.json`.

### Earlier checkpoint history (superseded by the entries above)

- Final immutable artifact27 passes the complete package suites on both
  runtimes: 43/43 on Node24.14 in107.33s/1224.9MiB and Node22.12 in
  118.67s/1110.2MiB. Every previous scenario remains, recursive JSON output is
  added, strict emitted-only consumers pass, live stage markers are visible,
  and teardown is verified under unchanged30s child/300s aggregate/1536MiB RSS
  limits. Logs: `/tmp/viborm-v1-package27-node24.log` and
  `/tmp/viborm-v1-package27-node22.log`. The changed package test passes its
  focused native check; its temporary root-local config was removed. An
  initial external config could not resolve inherited type libraries and is
  recorded as a failed setup, not a product diagnostic.
- Final artifact27 perimeter: source147305 (+5930/+4.1945%), tests459775
  (+14319/+3.2145%), scripts31844 (+150/+0.4733%), live docs23200
  (+71/+0.3070%). Counts include new files, both sides of moves, comments and
  blanks. `/tmp/viborm-v1-checkpoint7-loc-final27.json` and its companion
  manifest reproduce these totals. All555 finding identities/dispositions
  remain unchanged after refreshing22 evidence entries.
- Immutable artifact27 completes all 118 compiler/backend/scaling checks with
  zero unexpected failures. Every successful inferred-client emission retains
  its exact literal links and contains no elisions or getter functions. Dense
  graphs pass through 96 models; maximum child 3.878s/846.4MiB. The current JS
  declaration backend remains in place. The isolated build passed in
  2.13s/1046.4MiB; archive SHA256
  `12431126fee0a12d5858c3c90c4125e04ac888228eff2f678ada5a8360ef59e0`,
  source manifest `c1c0799002320e8f7b386038e53cb535be2832c09b5c202f4c98ab7ecdd4cf39`.
  All 89 runtime modules are byte-identical to artifact26. The final receipts
  are in `/tmp/viborm-v1-linked-client-20261008/final27/verified-summary.json`.
- Remaining ordinary local-provider shards 11–15 pass: 75 tests, six intentional
  Docker skips, peak 581.1MiB, every teardown verified. This covers the five
  ordinary stages CI6 never reached. The later provider families still require
  the final protected CI run; no blanket claim is inferred from these shards.
- Independent review confirms the grouped package harness preserves every
  previous scenario, strict source checks, fresh emitted-declaration-only
  consumers, six runtime construction checks and literal-link integrity
  assertions. Three bounded fixture families share compiler startup; 43 test
  cases retain the previous 51 scenarios and add recursive JSON results. Full
  Node22/24 package qualification against artifact27 subsequently passed. No test, resource
  ceiling, compiler version or runtime bundle setting was weakened.
- Native43 passes the complete estate with zero diagnostics in34.94s at
  6043.6MiB, unchanged8192MiB/300s limits and verified teardown. The exact
  JSON result TS2589 also fails on immutable25 under both5.8 and7: it is a
  latent recursive `Prettify<JsonValue>` expansion, not an async-lifecycle
  regression. The existing canonical JSON domain now bypasses cosmetic
  remapping. Public single/many/selected/finite-output/negative controls and
  independent union/Date/Decimal/function review pass; no client annotation,
  carrier change or alternate value vocabulary is introduced. Source grows
  only5 lines for this owner correction. Package and backend requalification
  subsequently used the new immutable27 artifact because declarations changed.
- CI6 runtime repairs now pass171/171 across the seven affected files in
  4.15s/608.8MiB. Direct and prepared-array scalar refusals both retain V2006
  metadata, both SQLite collision tests retain exactly two attempts, and
  rejected async validators/callbacks remain contained across all six sites.
  Independent review confirms prepared result provenance and commit certainty
  are preserved. Full validation coverage passes3719 tests across four chunks,
  all metrics100%, largest chunk1090.2MiB. Native42 finds one newly exercised
  JSON-result TS2589 and two test-only schema annotations; the annotations are
  corrected; the JSON case was subsequently fixed and qualified in native43
  and immutable27. Native42 remains recorded as red.
- Immutable artifact26 builds in2.21s/1011.3MiB. All34 declaration files are
  byte-for-byte identical to qualified25, so its118-row type matrix still
  applies; the new runtime/CLI package must be qualified. Archive2,051,167 bytes,
  SHA256 `9746d0d529f27dbe5b0bd984f0bdf9f5b73b2a82bcbf86081f25b1a6e495adbd`;
  source manifest `ef6b40eff5313695b049c2cdfffdcf378ef7f434776fef7918c3130a7852a738`.
  Working dist was replaced only after confirming its complete contents were
  the owned artifact25. Type comparison receipt:
  `/tmp/viborm-v1-artifact26-declaration-parity.json`.
- Checkpoint6 `31466ea131ade9a2221def34eb73cbc7d7b407b3` is pushed to
  PR84. Remote CI6 `37874673209` passes core, PostgreSQL/MySQL and Bun/D1.
  It exposes four remaining lanes: docs exceeds1536MiB at1537.7MiB; CLI
  coverage finds six source-through-jiti interop failures; local providers
  find retired fixture contracts plus a genuine SQLite constraint identity
  mismatch; Linux package work exceeds one30s child and the300s aggregate.
  Local artifact25 package/type results below remain local evidence, not
  successful protected CI. The then-pending docs-only2048MiB proposal was
  superseded by the same-cap checkpoint8 correction above.
- CLI repair restores dependency CJS interop while both config and custom
  migration readers select only authored own defaults. Exact CLI coverage
  passes85/85 with all four metrics100%,4.07s/783.6MiB, unchanged budgets.
  SQLite identity now uses the driver's physical table plus ordered columns;
  both collision recovery tests still require exactly two transaction regions.
  The first focused gate passes151/153; two JSON tests correctly expose
  unhandled rejected async validators and missing prepared-parser error
  mapping. Those owner fixes are saved and await integrated qualification.
- The package owner proved that emission itself retains declaration failures
  on TypeScript5.8/5.9, but removing a duplicate transform did not materially
  improve timing. The `db` source check and emission can share one program,
  preserving the separate emitted-only consumer. Linux aggregate repair is
  still being measured; no fixture, negative assertion or budget is weakened.
- Final artifact25 compiler/backend matrix is complete:118 distinct rows,
  one immutable archive hash, zero unexpected failures. The ten expected
  refusals are eight already-lossy raw-model controls, the installed native
  plugin's absent peer and OXC's required annotations. Every successful
  client emission has zero elisions/getter functions and its complete exact
  literal link table. Maximum child5.248s/1049.0MiB; all teardown verified.
  Direct and bundled consumers are strict TS5.8/native7. Dense12/24/48/96
  source, emission and consumers all pass. Current declaration backend retained.
  Aggregate proof: `/tmp/viborm-v1-linked-client-20261008/final25/verified-summary.json`.
- Finishing ledger review found and repaired stale authored JSON update prose:
  explicit one-key `{set:value}` is supported, invalid envelopes cannot fall
  back to literal storage, and a literal one-key set document is double wrapped.
  Runtime/tests were already correct and remain unchanged. All555 rows now
  have dispositions:289 verified-fixed,163 product-gap,92 documented-contract,
  4 release-pending,2 implemented-unverified,4 not-a-defect,1 refuted. The two
  remaining documentation rows and four publication rows still need their gates.
- Final current physical counts: source147279(+5904/+4.1761%), tests459403
  (+13947/+3.1309%), scripts31844(+150/+0.4733%), authored docs23200
  (+71/+0.3070%). Formatter checks576 tracked and5 new code/config files;
  secret-safe scan of673 changed files reports zero high-confidence findings.
- Immutable artifact25 passes all51 package cases on both supported CI Node
  lines:22.12.0 in203.02s/1384.9MiB and24.14.0 in187.93s/1433.6MiB. Both
  preserve the1536MiB RSS,300s aggregate and30s per-consumer ceilings, with
  verified teardown. These include the unchanged200-model cases and emitted
  client/factory/modifier consumers. The final118-row declaration/backend matrix
  completed against this same archive.
- Frozen artifact25 integrates the two `NoInfer` equality operands. A bounded
  TypeScript5.8 trace located602 recursive inference frames comparing the same
  model types; the failed accessor-only trial was discarded. All676 concrete
  original/candidate equality answers, actual model/union controls, strict
  backreference/factory/modifier consumers and three fresh Node22 chain200
  processes pass. Independent review confirms the full identity comparison
  remains authoritative; no compiler flags, limits or caller annotations changed.
- Artifact25 builds in2.11s/1035.8MiB. The2,050,717-byte archive SHA256 is
  `5370aa3d244db77aebff9fb347d73df7ae102e5a39ad670a6d4839979013a5b9`;
  source-manifest SHA256 is
  `cc208fb939bad29b6fbdf86e05e41477c83474aa467aee5512353af948c2eae4`.
  All89 runtime `.mjs` files are byte-identical to artifact22. Whole-estate
  native gate41 passes zero diagnostics in35.51s/6143.9MiB with verified teardown
  under the existing8192MiB allowance. Exact-revision protected CI remains
  required after the recorded118-row compiler/backend matrix.
- Artifact24's full Node22 suite passes35 cases, then TS5.8 chain200
  crashes with `RangeError: Maximum call stack size exceeded` in recursive
  type inference (166.40s total/1196.9MiB). The same immutable archive passes
  focused direct and Vitest runs, then fails the first fresh-process repeat.
  Its client declaration chunk is byte-identical to the patched23 candidate;
  this is intermittent stack exhaustion, not an archive mismatch. The narrow
  field-tree accessor trial did not fix it and was discarded. No
  compiler, stack limit, model count or resource ceiling is being changed.
- The final Node22 cost correction preserves the original full-model identity
  comparator and uses tuple-wrapped bidirectional assignability only as the
  necessary field-tree rejection filter. The exact Node22 chain200 probe now
  passes in7.76s on5.9 and7.63s on5.8; original-comparator alias, cycle,
  variant, actual union-target and metadata controls all pass. Strict
  backreference/modifier round trips pass on5.8/7. The change is integrated
  with permanent controls and independent review.
- Frozen artifact24 builds in1.99s/998.0MiB, and native whole-estate gate40
  passes with zero diagnostics in35.91s/6112.9MiB. All89 runtime `.mjs`
  outputs are byte-identical to23. Source-manifest SHA256:
  `ae139857c133035115bfd6a468bfaa858d38303832b58311040b4b057ca96720`.
  The2,050,712-byte archive SHA256 is
  `ebf7487db6d351048fb46b4bc3e4e497476065b8034e54e8d8bbb2c029c5faa9`.
  Both local package environments now match that archive exactly; the full
  Node22 rerun is active. Final24 package/compiler matrix evidence remains
  pending, so earlier candidate checks are not release qualification.
- Artifact23's complete Node24 package suite passes51/51 in238.76s,
  1388.1MiB under unchanged limits. The exact Node22.12 suite passes21 then
  hits its30s child deadline on the original TS5.9 chain200 source-only
  probe; remaining cases were not run after fail-fast. No diagnostic or
  widening was reported, but that is not a passing Node22 gate. The type
  owner has the sole runner for a narrow isolated cost correction while root
  continues reporting/release preparation. Logs:
  `/tmp/viborm-v1-package23-node24.log` and
  `/tmp/viborm-v1-package23-node22.log`.
- Native whole-estate gate39 passes with zero diagnostics in36.82s,
  6175.0MiB under the existing8192MiB allowance, with verified teardown.
  It includes the integrated model-state correction and its permanent
  compatibility probes. The20 strengthened package artifact/declaration
  integrity regressions pass in1.93s at346.3MiB. Final23's24 source checks
  across5.8/7 pass for the original chain, factories, self/junction, variants
  and complete modifier case. Full Node24 package qualification is running;
  the separate Node22 fixture is refreshed and aligned to the exact archive,
  with its ABI127 SQLite binary unchanged.
- The final indexed-model correction is integrated: six fluent return
  signatures materialize their completed state inline, and the public
  `UpdateState` alias uses the same representation so existing explicit model
  annotations retain exact link identity. Parameters and runtime bodies are
  unchanged; the correction adds48 net source lines. Isolated full modifier
  source/emission/strict-consumer checks pass on TS5.8 and native7, including
  cyclic `.extends()` before and after mapping, optional/readonly metadata,
  generic assignments and legacy annotation controls. Permanent probes are
  saved. Final whole-estate and package qualification remains pending.
- Isolated build23 passes in2.24s at1008.4MiB under the unchanged1536MiB cap.
  Its source manifest is
  `61b37d90b6c093459873caaa330f69f6a36ee15ae4575dc3ba5f26949d9250bd`;
  the2,050,710-byte archive SHA256 is
  `b07c20362dd73d5ce25a1fcdf4b21685d6e07ad4ee68b02f646e1c51a20bd70c`.
  Final source, emitter and strict-consumer measurements use this immutable
  archive. The structural declaration-inspection helper is also being hardened
  against local alias/type-query indirection; its independent consumer compiler
  checks remain intact.
- Historical proposal, now superseded: a docs-only2048MiB RSS exception was
  submitted for Arnaud's explicit approval.
  The current1536MiB contract is unchanged. Official Node22.19.0 with512MiB
  heap completed all120 authored routes once at1535.8MiB, then its controlled
  cold repeat failed at1559.3MiB. The512 trial was restored to448; no exception
  has been applied or executed. A narrow unapplied proposal is preserved at
  `/tmp/viborm-v1-docs-rss-exception.patch` for review. All test/package caps,
  the docs300s wall and current448 heap would remain unchanged.
- The remaining before-case dense12 declaration measurement is complete on
  artifact20: JS5.9 refuses emission with TS7056; native7 emits2,894,234bytes
  containing23 client elisions, then both strict5.8/7 consumers fail semantic
  probes. Timings, instantiations and exact receipt are now recorded in
  `declaration-backends.md`. This is baseline evidence, not final-carrier
  qualification. The root measurement runner finished with verified teardown.
- The TS5.8 first-limit frequency profile now identifies the repeated owner:
  at the existing five-million limit, `InitialModelState` and the original
  shape each instantiate about1.43 million times, while the `Omit`/`UpdateState`
  chain contributes about367,000 each. Schema snapshots/re-linking are small
  triggers. Payload checking alone reproduces the defect; result traversal,
  static recurrence, guard reordering, target-model admission, distinct keys
  and schema tuple reads are not causal. Their isolated substitutions were
  rejected. The profile retains only278 declaration counters and522 pairs,
  preserves the checker limits and verifies teardown. Evidence:
  `/tmp/viborm-v1-ts58-frequency-profile/compiler.log`.
- The final environment hook demonstrably applies prerender `treeshake:false`,
  with Worker/client settings preserved, but this does not qualify docs:
  current448,384, client-esbuild and client-unminified trials still exceed
  the1536MiB RSS ceiling. All diagnostic/minifier/heap changes were restored.
  Content sync already closes its temporary Vite server; no unsupported reset
  or forced GC is introduced. CI5 used Node24.21.0, so another24.x comparison
  would not establish a new supported-engine result. A separately installed
  minimum-supported Node22.19.0 comparison is being prepared without changing
  project dependencies or resource limits.
- Formatting currently passes across581 checked files in the673-file changed
  perimeter; no fixes were applied. `origin/main` remains the reviewed
  `a4a5b8dc607a9a8db506bd60ddb5125519d8ab0b` after a fresh fetch.
- The indexed-query investigation rejected the result-surface accessor,
  homomorphic `UpdateState` materializer and once-derived link-table default:
  none repairs the exact TS5.8 fixture. All remain scratch-only. The next
  candidate delays model inspection until a caller actually supplies the
  corresponding guarded clause; the existing admission rules stay intact.
- The isolated Astro output-array lifetime trial also failed before rendering
  (22.03s,1539.2MiB), and the original installed file and inode were restored
  exactly. No dependency patch is retained. Installed Astro code reveals a
  concrete configuration error: it replaces the prerender `build` object,
  dropping our intended `treeshake:false`. The next trial moves that same
  disposable-bundle policy into the supported final environment hook and will
  verify the effective options. Worker and client optimization remain required.
- The plain indexed producer with the exact nested query also fails on
  original artifact20 (4.99s,912.5MiB), before the schema-key carrier. This
  corrects the earlier regression classification: the supported indexed-query
  failure is pre-existing and remains in V1 repair scope. Extensions, default
  omit and cache are unnecessary to reproduce it. The original trace's producer,
  probe and library inputs are now preserved with hashes under
  `/tmp/viborm-v1-index-depth-trace/original-inputs`; baseline evidence is
  `/tmp/viborm-v1-modifier-plain-baseline20/plain-original20.log`.
- The original permanent200-model TS5.9 query now passes under the unchanged
  30-second child limit:26.68s,970.4MiB, verified teardown. The host load fell
  materially between runs; source, assertions and the single compiler call are
  unchanged. The receipt names immutable artifact22 explicitly and hashes the
  current harness (whose unused AST-library load is now lazy):
  `/tmp/viborm-v1-original22-chain200-quiet-receipt.json`.
- The indexed modifier trace reaches TypeScript's5,000,000-instantiation count
  limit at depth25, not its depth limit. No attempted tuple-owner, flat-index,
  static-comparison prefilter or carrier-state-accessor change fixed it; all
  remain rejected scratch experiments. The next bounded candidate targets the
  existing result-surface helper, which currently compares a full fluent model
  only to read its scalar/relation key sets. Source remains frozen pending proof.
- The docs plugin's root optimizer hook was superseded by Astro's later
  environment defaults. The supported post `configEnvironment` hook fixes that
  configuration error, but warm and controlled cold-runtime builds still exceed
  RSS before prerendering (1563.0MiB/15.21s and1564.3MiB/13.97s). Runtime-cache
  cleanup is therefore not adopted as a fix. Earlier cold448 success also lacked
  an OG cache and lacks full launch metadata; it remains an observed success,
  not a controlled explanation. All failed build outputs are unqualified.
- Repeating the final docs build after the D1 prose edits exposes unreliable
  qualification: the saved448MiB build exceeds the unchanged1536MiB RSS ceiling
  at1563.6MiB after17.98s, before page rendering. All150 prepared source/config
  hashes remain unchanged during the run. The earlier clean-cache success is
  retained as evidence, but the current partial dist is unqualified and cannot
  be rendered as final output or deployed. Validate/dry-run were not rerun after
  this failure. Migrations owns the bounded cache/allocation investigation.
  Receipts:`/tmp/viborm-v1-docs-final-build.log` and
  `/tmp/viborm-v1-docs-final-qualification.json`.
- Artifact22 acceptance exposes a concrete TS5.8 indexed-modifier source
  failure. The original pre-index fixture passes source/emission/consumer
  (20.63s,964.5MiB); adding its three indexes while keeping the original probes
  produces TS2589 at the valid nested include (15.04s,940.3MiB). Removing the new
  metadata/identity witnesses does not remove that failure. Native7 passes the
  complete indexed case (5.44s,1136.0MiB). Query owns a bounded correction at the
  index tuple type owner; no assertion is removed. Artifact22 backreference
  integrity/source/emission/strict-consumer checks pass on5.8 (17.44s,1052.2MiB)
  and7 (6.38s,779.8MiB). The unchanged200-model TS5.9 source probe reaches the
  30s wall without a diagnostic or heap failure (30.16s,1046.9MiB); qualification
  is still required. Host contention remains measurable, so this wall result
  alone is not attributed to an algorithmic regression. Full51 is held until
  the concrete source defect is repaired.
- Artifact22 freezes the integrated exact-identity cost correction and D1 catalog
  repair. The full native source gate passes with zero diagnostics in79.22s at
  6212.8MiB under the unchanged8192MiB/300s limits. The isolated package build
  passes in4.11s at1029.8MiB; its2,050,296-byte tarball has SHA256
  `cd07567d7e9392a25f0d785b059125ad0c6f8ca5ef710f8884735e23804c9cf2`.
  The13 dedicated packed-dist/declaration-integrity controls pass in4.79s at
  399.8MiB, including wrong/union/any/missing link keys and client elisions.
  Those new runtime controls were added after native38 and are independently
  qualified. Full package and final backend/scaling qualification remain pending.
  Receipts:`/tmp/viborm-v1-native-38.log`,
  `/tmp/viborm-v1-package-build-22.log`,
  `/tmp/viborm-v1-packed22-integrity-consistency.log`.
- The link lookup now rejects unequal field-name/singular-target trees before
  invoking the unchanged exact full-model identity comparator. It never uses
  the projection to establish equality. The original100-model query plus exact
  first/middle/back link literals passes in11.18s at958.6MiB. Small controls
  preserve aliases, identical separate models, external targets, both variant
  cardinalities and a genuine singular cycle. No depth cap, target-key widening
  or runtime state is introduced. This correction adds43 production lines and
  131 lines of persistent small-graph type controls; full-package200 still
  requires its own receipt.
- The clean-cache docs build now completes all120 pages and renders121 fresh
  OG cards in45.66s with1210.7MiB sampled peak RSS under the unchanged1536MiB/300s
  ceiling. The temporary prerender
  bundle skips tree-shaking; published Worker/client optimizations stay enabled.
  Build-only browser dependency prebundling is disabled, rendering stays serial,
  and the Node heap is448MiB (within the ordinary768MiB contract). The512MiB warm
  trial passed, but its clean-cache counterpart exceeded RSS, so448 is the
  qualified setting. Diagnostic hooks are removed. Link validation passes with
  no broken links; Wrangler dry-run packages19 modules/1055 assets at771.65KiB
  gzip. Browser inspection verifies the quick-start cards, driver admonition,
  feature table and D1 limitation text without browser errors. A subsequent
  bounded D1 introspection repair changes that last paragraph and needs fresh
  build/render verification; exact-revision Linux CI is still required.
  Receipts:`/tmp/viborm-v1-docs-cold448.log`,
  `/tmp/viborm-v1-docs-final-validate.log`,
  `/tmp/viborm-v1-docs-worker-cold448.log`.
- The JS declaration harness now checks producer and source-probe roots once
  through the selected compiler API, then emits only producer roots. All14
  TS5.8/5.9 cases pass (151.70s aggregate,1064.9MiB peak); both removed-error
  controls fail before emitting declarations. Separate emitted consumers remain
  independent programs. This removes17 redundant compiler invocations from the
  full package suite without changing assertions or limits; full-suite timing
  still needs qualification after the chain100 identity-cost repair.
- Checkpoint5 is committed/pushed as `400a9ce041c94ec6bc6d8a5be45951b919c9b8b6`.
  CI run37850821772 passes core, PostgreSQL/MySQL and Bun/D1. Coverage policy
  exposed four real SQLite witnesses in a provider-free migration file; they
  now live in the extended estate with migration and adapter coverage selection
  preserved. Policy11/11 and the four moved witnesses pass. Local CI exposed
  two stale equality-SQL counters after captured-key compaction to `IN`; the
  exact placeholder matcher now preserves all five race/readback assertions.
  The combined SQLite/staleness replay passes9/9 in3.39s at553.1MiB; the final
  staleness-only replay passes5/5 in3.97s at488.9MiB. Exact-revision coverage and
  local-provider CI still need to repeat these repaired fixtures.
  Both package jobs time out on the repeated TS5.9 ten-extension compiler work;
  harness reuse is being qualified without removing source or emitted-consumer
  assertions. Linux docs also exceed1536MiB, so platform substitution alone is
  not a solution. No publication or deployment has occurred.
- The first cached identity-predicate optimization was rejected and reverted.
  Although its100-model query used less memory, exact literal schema-key probes
  caught widened target unions. Further candidates must first preserve exact
  link keys; field-domain/no-any checks alone do not prove model identity.
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
