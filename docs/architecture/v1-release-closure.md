# V1 Release Closure

## RC1 publication complete — 2026-09-28

Install the candidate with `npm install viborm@next`. Stable `latest` remains
`0.1.0`; stable V1 promotion and the application upgrade/migration soak remain
separate work. The [immutable RC1 release](https://github.com/beynar/viborm/releases/tag/v1.0.0-rc.1)
and the successful workflow below bind the published package to `8a42fcb56`.

[Repair PR #57](https://github.com/beynar/viborm/pull/57) merged as `8a42fcb56`
at 08:27:44 UTC after all eight required jobs in
[CI run 36393905288](https://github.com/beynar/viborm/actions/runs/36393905288)
passed. Devin reported no issues; there were no inline review findings. The
exact-head guarded squash has the same tree as reviewed `bb590d7c1`.

The replacement [Release run 36397517876](https://github.com/beynar/viborm/actions/runs/36397517876)
was dispatched at 08:27:59 UTC against `8a42fcb56` for `1.0.0-rc.1` only.
The npm version and remote tag were still absent; `latest` remained `0.1.0`.
The old failed run is preserved below, not retried. The new run qualified
its own artifact and received human publication approval as recorded below.

At 09:12 UTC, all eight pre-publication jobs in the replacement run passed,
including the tarball build/tests and exact Node 22.0.0 consumer. After human
approval, npm accepted the upload at 10:09:14 UTC and signed provenance
(transparency-log index `2981790224`). Post-publish verification failed at
10:10:18 UTC because the version was not yet visible. npm explicitly reported
that processing could take a few minutes. Its
[publish-time scanning notice](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata)
describes a typical five-minute availability delay, sometimes 15 minutes or
more, not a guaranteed upper bound. The verifier's 60-second retry ladder is
insufficient for that documented behavior; this is not evidence of OIDC failure.

Do not upload again or dispatch a new release revision. The accepted version
must first become visible and match the existing artifact's integrity,
channel and provenance. Only then rerun failed jobs on this same run/commit,
whose pre-publish registry check must skip upload. Preserve the successful
test/build jobs and their original artifact. The actual artifact downloaded
from run `36397517876` passed `verify-artifact` locally.

At the 10:18 UTC recovery check, RC1 was publicly visible under `next`, with
`latest` unchanged at `0.1.0`. The existing `verify-registry --require-present`
command passed against this run's manifest: integrity, channel and provenance
verified, with `publish: false`. Protected main still named the exact release
commit `8a42fcb568646da817d7ee9e6ccaf252ae280b40`. Only failed jobs were
rerun on run `36397517876`. After renewed human approval, attempt 2 passed
publication verification and the fresh registry consumer. No second upload or
artifact rebuild was needed. The workflow created the correct annotated tag,
then created draft release `398179047`, but failed at 11:18:40 UTC because its
immediate release-list read did not return the newly created draft.

Recovery confirmed the draft directly and in the authenticated release list:
correct title, prerelease state, tag and source commit, with no assets uploaded.
The tag and current main both resolved to the exact release commit. Registry
verification passed again, and the existing GitHub state resolver identified
`complete-draft` with only the two expected assets missing. Attempt 3 reruns
only the failed GitHub-release job on the same source and artifact. npm and
the successful test/consumer jobs were not rerun. The attempt succeeded:
GitHub publication verification completed at 11:23:46 UTC. Release `398179047`
is published (`draft: false`) and immutable, with these exact assets:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `viborm-1.0.0-rc.1.tgz` | 1,850,101 | `84640407021de8af69fe5e1fa5502bd6a17d169f44c28a25c424c0d49fe714ce` |
| `viborm-release.json` | 582 | `ed10f62109891ad6413a4bfd11c178e27e0c7833300a12bf3f955478e4c25f11` |

Attempt 2's registry precheck explicitly reported `already-published` and
`publish: false`; upload was skipped. Its finalizer verified the artifact and
registry at 11:17:12 UTC and the fresh registry consumer, signature audit,
exports and CLI at 11:17:16 UTC. Thus publication is complete, not merely an
accepted upload. The release monitor is paused. The immediate GitHub-list
lookup defect has a separate repair: retain the validated creation/publication
response and read the known release ID after uploading assets, rather than
rediscovering it in the collection. Its actual CLI-boundary regression fails
before the fix and passes after it, alongside partial-draft resume and
mismatched-response refusal. Independent review accepted the bounded diff;
the root reran both release smoke scripts and Biome successfully. This repair
does not alter RC1's source, tag or package bytes.

## Initial RC preparation and failed attempt

Updated 2026-09-28 (UTC) against `main` at `4beec52a5`, the squash merge of
[PR #56](https://github.com/beynar/viborm/pull/56).
The #54 fix is merged, and issue #54 is closed. RC preparation now sets the
candidate version to `1.0.0-rc.1`; no release has been published.
PR #56 merged at 22:09:03 UTC after all eight jobs in
[CI run 36352208516](https://github.com/beynar/viborm/actions/runs/36352208516)
passed on `a1db10853`. The merge used an exact head-SHA guard; its tree equals
the reviewed head. No new inline review finding was posted; Arnaud reported
nothing from Devin after its inaccessible flag badge was raised. This is not
a claim that the bot produced an independently verified clean review.

Main's required checks and force-push/deletion protections are now enforced.
Arnaud's screenshot confirms the correct npm publisher and direct-publish
permission. npm's always-allowed staged permission is not a blocker. Arnaud
confirmed account 2FA. The [RC1 Release run](https://github.com/beynar/viborm/actions/runs/36386640811)
was dispatched at 06:28:25 UTC on 2026-09-28 against `4beec52a5` with version
`1.0.0-rc.1`. Before dispatch, the registry had only `latest: 0.1.0`, no RC1
version, and the remote RC1 tag was absent. At 07:09 UTC all eight pre-publication
jobs had passed: authorization, complete estate, both provider jobs, coverage,
docs, tarball build/tests, and exact Node 22.0.0 consumer. The tested artifact
`viborm-release` is GitHub artifact `10955532206` (1,850,969 bytes; archive digest
`sha256:5b6b946469d68dfa7a1aee801951a08465bd47ba0c33c19e1d41073883b8d153`).
After human approval, publication failed at 07:44 UTC before reaching npm:
`npm publish "release/<archive>"` parsed the path as GitHub repository shorthand
and attempted SSH access. The registry still had no RC1 version at the failure
check. The bounded repair prefixes the path with `./`; npm 11.15.0's parser
then identifies a local file, and an offline `--dry-run --ignore-scripts` on
the workflow's exact downloaded archive passes with matching integrity and
size. The existing package release-contract test now pins the workflow spelling
(red before repair, green after). No engine, dependency or gate changes.

The failed run must not be blindly retried: its workflow revision still contains
the bug. Merge the repair through required CI, then dispatch a new release run
from protected main for the still-unused `1.0.0-rc.1`. Requalify that revision's
artifact and retain human approval. No package or GitHub release is yet claimed.
This is the existing remaining-work checklist, not a new implementation
program or a replacement for historical engine evidence.

**V1 needs release closure, not another engine rewrite.** Recursive reads,
Raptor 3, compiled decoding, relation topology, exact decimals, namespaces,
GeoPoint and authenticated migrations are already implemented. Further
performance experiments and broad abstraction work are not release gates.

[RELEASING.md](../../RELEASING.md) owns publication and recovery procedures.
This checklist distinguishes implemented mechanisms from an executed release.
A checked implementation item does not claim that the current RC has passed it.

## 1. Correctness closure

- [x] PR #52 merged (`778912983`): retired cache decoder removed, prepared
  update projection reused, captured mutation count owned once.
- [x] PR #53 merged (`e94b8ea3c`): issues #47, #42, #45 and #46 closed through
  insert-only `.now()`, dependency-ordered drops, dialect-native type maps and
  directed junction actions. Its documentation distinguishes conservative
  schema-only SQLite drop refusals from what an empty database could execute.
- [x] Issue [#54](https://github.com/beynar/viborm/issues/54) is corrected in
  merged PR #55: non-array `.updatedAt()` refresh is owned by update admission.
  Explicit values, create defaults and `.now()` admission are preserved.
  SQLite3, PGlite, native PostgreSQL and native MySQL execute the same focused
  contract; public types, admission lifetimes and the existing replay rule
  have checks. Temporal arrays retain their prior behavior. The DateTime guide
  and changelog describe the contract instead of the former known defect.
  The issue closed on 2026-09-27 at 18:06:30 UTC.
- [x] PR #55 squash-merged as `53eed0012` on 2026-09-27 at 18:06:29 UTC.
  All eight jobs in [CI run 36337145755](https://github.com/beynar/viborm/actions/runs/36337145755)
  succeeded: types/format/docs, core, coverage, both Node package jobs,
  local providers, PostgreSQL/MySQL and Bun/D1. The reviewed head `fc7810dfe`
  and base were unchanged, no blocking review finding remained, and the merge
  used an exact head-SHA guard. The merged source tree equals the reviewed tree.
  Independent local review, typecheck and 100% validation coverage also passed.
  Devin reported no issues; CodeRabbit skipped review and Greptile's trial had
  expired. A successful bot status alone is not proof that a review ran.
- [ ] On the release commit, classify every failing or skipped required gate.
  Missing seed corpora, absent PostGIS and unavailable providers are missing
  evidence, not correctness passes. Use the existing runners and manifests;
  do not reopen old campaigns simply to produce another report.

No open GitHub issue was returned by the post-merge query on 2026-09-27.
That is an inventory observation, not proof that the code has no defects.

## 2. Public contract — implementation present, release freeze remains

- [x] The built-package export inventory and declaration checks exist:
  [public-surface-golden.mjs](../../tests/package/public-surface-golden.mjs)
  and [its smoke test](../../tests/package/public-surface-golden-smoke.mjs).
  They pin runtime exports, type exports, client capabilities, schema factories
  and intentionally absent names/subpaths.
- [x] The earlier checklist's removal work is no longer a new implementation
  program: safe raw methods take tagged templates/`Sql`, unsafe strings have
  explicitly unsafe methods, `QueryMetadata` is absent, migration exports are
  intentional, and internal cache-key helpers are absent from the package
  entry point. Internal module exports are not the public package surface.
- [x] ESM packaging, MIT metadata, tarball allowlist and size limits have
  executable contracts in [release-package-contract.json](../../scripts/release-package-contract.json)
  and the package tests. Runtime and declaration floor probes exist for Node
  22.0.0 and TypeScript 5.8. The documentation site's Node floor is separate.
- [ ] Run the existing export/declaration, public-type and packed-consumer
  probes on the final RC commit. Review any changed public contract against
  its release notes; do not add another export registry or compatibility language.
- [x] Add the [V1 upgrade guide](../content/docs/getting-started/upgrading-to-v1.mdx),
  covering the relation language, scalar storage, migration estate, extensions,
  raw APIs and timestamp behavior. It distinguishes published `0.1.0` from
  intermediate development APIs rather than inventing a release history.
- [ ] Complete the upgrade rehearsal on the final RC artifact. A written guide
  and passing package tests do not prove a production application's data upgrade.

## 3. Provider claims must match executed evidence

- [x] Provider runners and release jobs exist for the local, Docker, Bun and
  Workers boundaries. Recursive queries are shipped and belong in that
  qualification inventory; they are **not** a deferred V1 feature.
- [x] The LibSQL migration hazard has an explicit safety boundary. The
  [SQLite-family migration guide](../content/docs/migration/drivers/sqlite.mdx#libsql--turso)
  documents refusal of effectful `apply`, `down`, `reset`, `verify` and `push`.
  Offline/read-only operations and dry-run push remain available. Implementing
  production LibSQL migrations is not required if this limit stays explicit.
- [x] Correct the public overview's LibSQL "Full" and Neon/D1 "Push only"
  migration claims and the linked per-driver instructions. They now distinguish
  runtime transactions, refused effectful V1 migrations, admitted offline/read-only
  work and hosted qualification limits. No provider tier is promoted by this edit.
- [ ] Run the release-blocking PostgreSQL (including required PostGIS), MySQL,
  SQLite/PGlite/LibSQL and declared Bun/Workers lanes on the exact RC source.
  Record executed counts, skips, substrate versions and restrictions. A
  missing prerequisite blocks only the capability claimed as qualified.
- [ ] Keep hosted Neon, hosted D1 and PlanetScale evidence limits explicit.
  Hosted qualification is deferred for now; fixtures/local emulators must not
  be described as hosted runs. Either retain honest preview/conditional claims
  or supply provider evidence before promoting those claims.

Do not make hosted-driver access a prerequisite for shipping a narrower,
truthfully documented V1. Database-family equivalence alone cannot establish
the concrete provider's transaction, migration or failure contract.

## 4. Publication — workflow implemented, administration partly verified

- [x] [.github/workflows/release.yml](../../.github/workflows/release.yml) and
  [scripts/release.mjs](../../scripts/release.mjs) implement the workflow path:
  build one tarball, test its bytes, publish through OIDC and verify the registry
  artifact. [scripts/github-release.mjs](../../scripts/github-release.mjs)
  creates/verifies the GitHub release. Administration below still needs closure.
- [x] On 2026-09-27, the GitHub API reported an `npm-production` environment
  with a required reviewer and a branch policy selecting `main`.
- [x] The effective `main` rules require pull requests.
- [x] Require the eight intended CI checks on `main` with strict current-base
  enforcement and verify force-push/deletion protection. Ruleset `21923106`
  now enforces these without a bypass. The initial read-only audit's missing
  rule observation remains historical evidence, not the current state.
- [x] Verify tag protection, immutable releases and private vulnerability
  reporting. The [read-only administration audit](v1-release-administration-audit.md)
  records the endpoints, results and exact missing-main-rule remediation.
- [x] Verify npm trusted publishing and maintainer 2FA. Arnaud supplied the
  publisher settings and confirmed account 2FA; successful OIDC publication
  and signed provenance now provide execution evidence as well.
- [ ] Complete the runbook's post-first-RC token restriction/revocation step.
  Publication success does not establish that this administrative step ran.
- [x] Exercise the publication workflow with RC1. Run `36397517876` completed
  on the same source and artifact through failed-job-only recovery, with a
  fresh registry consumer and immutable GitHub release as recorded above.

## 5. Documentation and RC rehearsal

- [x] The obsolete quick-start `push(orm, schema)` example is gone. The current
  [quick start](../content/docs/getting-started/quick-start.mdx) uses a config
  file and CLI push. Error examples and Schema JSON documentation already have
  focused executable checks.
- [x] The release workflow validates and builds the documentation site.
- [ ] During the runbook's packed-consumer and migration rehearsal, execute
  the current quick start and upgrade-guide instructions as written. Keep the
  existing error-example and Schema JSON checks. Site rendering alone does not
  establish executable examples; repair demonstrated gaps, not every snippet
  through a new documentation-testing framework.
- [ ] Finish the capability/support tables and upgrade guide before the RC
  freeze; make known refusals, partial-progress semantics and extension trust
  boundaries visible. No complete RBAC claim.
- [x] Prepare `1.0.0-rc.1` metadata, candidate release notes and README/site
  guidance; the MIT license is unchanged. Local package evidence is recorded
  in [the RC preflight](v1-rc1-preflight.md). No release tag is created.
- [x] Pass all eight CI jobs on the final release PR head and merge only after
  release blockers are resolved. Local preflight is not the protected-main
  release workflow's exact-artifact qualification or publication authority.
- [x] Release `1.0.0-rc.1` to `next` through the runbook and verify its fresh
  registry consumer and CLI. Exact evidence is recorded above.
- [ ] Rehearse the application upgrade, schema push and migration/recovery workflows on
  PostgreSQL, MySQL and SQLite in disposable
  databases with explicit authority for destructive steps. Platform claims
  additionally need their declared substrate, not a Node simulation.
- [ ] Retain a compact RC result record: commit, tarball digest, executed
  provider/runtime matrix, failures, skips, upgrade outcomes and remaining
  limits. Fix blockers and publish a later RC rather than replacing a version.
- [ ] Promote to `1.0.0` through the same exact-artifact gate only after the
  final RC is accepted. Neither this checklist nor a PR merge authorizes an
  npm publication.

## Next work and exit conditions

The fix is landed. Documentation and release-setting verification can proceed
independently. No new engine work is scheduled.

1. **Land #54 — complete.** PR #55 merged as `53eed0012` after all eight CI
   jobs passed; issue #54 is closed. The merge evidence is recorded in section 1.
2. **Close the public documentation gaps — edits prepared.** The support
   corrections and upgrade guide are in the RC change. Finish the documented
   upgrade rehearsal before calling the release qualified. Do not build a new
   documentation test framework.
3. **Close release administration.** Verify the still-unchecked runbook
   settings and configure the intended required CI checks through an
   authorized repository-settings change. Done when effective branch/tag rules,
   npm trusted publishing, release immutability and the approval environment
   are verified rather than inferred from workflow source. This document
   refresh changes none of those settings.
4. **Qualify the prepared RC.** Metadata and local package preflight are ready;
   the final PR checks and administration blockers still gate adoption. Run the
   protected-main workflow on its exact source and tarball only with publication
   authority. Re-run affected checks after repairs,
   not the full estate per edit. Done when the artifact, provider claims and
   executed gate results agree, with every required skip resolved.
5. **Rehearse, then release.** Publish the RC through `RELEASING.md`, complete
   its fresh-install/upgrade/migration/recovery rehearsal, and record the
   result. A defect requires a new RC, not replacement of published bytes.
   Stable publication remains a separate authorized release decision.

V1 is ready when the declared support matrix, public contract, actual tarball
and executed evidence agree; release authority is enforced; the rehearsal
succeeds; and no known correctness, data-loss, security or publication blocker
remains. Completed architecture programs are not to be reopened to satisfy
this checklist.

## Explicitly not V1 blockers

Full-text search, graph-wide RBAC, arbitrary extension-driven input/result
type mutation, `db pull`, Studio/seeding commands, views, reusable prepared
query handles, cross-namespace relations, CJS packaging and further positional
transport experiments remain separate work. So does removing a documented,
necessary write refusal merely to lower the census. A refusal hiding an
admitted operation's correctness bug is different and must be fixed or the
public contract explicitly narrowed before release.

Recursive queries and the Raptor 3 rewrite are already implemented. They must
be qualified and documented, not scheduled for implementation again.
