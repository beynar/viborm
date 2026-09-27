# V1 Release Closure

Updated 2026-09-27 against `main` at `53eed0012`, the squash merge of
[PR #55](https://github.com/beynar/viborm/pull/55).
The #54 fix is merged, and issue #54 is closed. RC preparation now sets the
candidate version to `1.0.0-rc.1`; no release has been published.
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
- [ ] Require the intended CI checks on `main` and verify force-push/deletion
  protection. The effective branch-rules API returned a pull-request rule but
  **no required-status-checks rule** on 2026-09-27. Green checks on one PR do
  not establish enforcement.
- [x] Verify tag protection, immutable releases and private vulnerability
  reporting. The [read-only administration audit](v1-release-administration-audit.md)
  records the endpoints, results and exact missing-main-rule remediation.
- [ ] Verify npm trusted publishing and maintainer 2FA in authenticated npm
  settings; public package metadata cannot establish them. After the first RC
  proves provenance, complete the runbook's token restriction/revocation step.
  No repository or npm settings were changed by the audit.
- [ ] Exercise the publication workflow with an RC. No `Release` workflow
  runs or GitHub releases were returned by the read-only queries on
  2026-09-27. Existing workflow source is not end-to-end publication evidence.

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
- [ ] Pass all eight CI jobs on the final release PR head and merge only after
  release blockers are resolved. Local preflight is not the protected-main
  release workflow's exact-artifact qualification or publication authority.
- [ ] Release `1.0.0-rc.1` to `next` through the runbook. Rehearse its fresh
  consumer, upgrade, CLI, schema push and migration/recovery workflows on
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
