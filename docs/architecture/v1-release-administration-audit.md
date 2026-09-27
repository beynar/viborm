# V1 release administration audit

## Follow-up correction — 2026-09-27

The initial audit below is historical. Main's required-check, force-push and
deletion protections were subsequently applied and verified. Arnaud supplied
the npm settings screenshot showing the correct `beynar/viborm`, `release.yml`,
`npm-production` publisher with direct `npm publish` enabled.

The initial instruction to permit direct publishing **only** was incorrect:
[npm's current contract](https://docs.npmjs.com/trusted-publishers/) always
allows `npm stage publish`; direct publishing is the additional permission.
The displayed staged permission is not a release blocker. Arnaud subsequently
confirmed maintainer 2FA on 2026-09-28. The Release workflow was dispatched as
[run 36386640811](https://github.com/beynar/viborm/actions/runs/36386640811)
against merged `4beec52a5`, for `1.0.0-rc.1` only. No release has been published
by this correction; workflow qualification and human approval remain required.

## Initial read-only audit

Observed **2026-09-27, 21:17–21:22 UTC**, for `beynar/viborm`.
Read-only authenticated GitHub REST requests succeeded with repository admin
visibility. Local workflow review used commit
`788d4b523031945c442329a6689e33c364fa3e6d` and the working RC metadata.
No settings, refs, releases, registry state, or workflow runs were changed.

**Decision: release blocked.** Main has no required CI checks and no explicit
force-push or deletion protection. npm trusted publishing remains unverified.
The other queried release administration requirements pass.

## Observed administration

All endpoint paths below are relative to `https://api.github.com` and were read
with `gh api` using its existing authentication. No credentials were inspected.

| Requirement | Result | Evidence |
| --- | --- | --- |
| Main requires a PR | Pass | `GET /repos/beynar/viborm/rules/branches/main` returns the active PR rule from ruleset `21923106`. It requires zero approvals, has no bypass actors, and the current user cannot bypass. This is a PR requirement, not independent review. |
| Main requires CI | **Blocker** | The effective rules response contains only the PR rule: no `required_status_checks`. `GET /repos/beynar/viborm/branches/main/protection` returns `404 Branch not protected`; no classic protection supplements the ruleset. |
| Main prohibits force pushes and deletion | **Blocker** | Both the effective rules endpoint and `GET /repos/beynar/viborm/rulesets/21923106` omit `non_fast_forward` and `deletion`. |
| Release tags cannot change or be deleted | Pass | `GET /repos/beynar/viborm/rulesets/21923488`: active tag ruleset, includes `refs/tags/v*`, no exclusions or bypass actors, rules `deletion`, `non_fast_forward`, `update`. No creation restriction prevents the workflow's initial tag creation. |
| Publication requires approval | Pass | `GET /repos/beynar/viborm/environments/npm-production`: required reviewer `beynar`, `can_admins_bypass: false`, `prevent_self_review: false`. Self-review is consistent with the single-maintainer allowance in `RELEASING.md`. |
| Publication is restricted to main | Pass for branch selection | The environment has custom branch policies. `GET /repos/beynar/viborm/environments/npm-production/deployment-branch-policies` returns exactly one policy: `name: main`, `type: branch`. This does not supply the missing main rules. |
| Workflow defaults are read-only | Pass | `GET /repos/beynar/viborm/actions/permissions/workflow`: `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`. |
| Immutable releases | Pass | `GET /repos/beynar/viborm/immutable-releases`: `enabled: true`, `enforced_by_owner: false`. Enabled at this repository; not imposed by an owner policy. |
| Private vulnerability reporting | Pass | `GET /repos/beynar/viborm/private-vulnerability-reporting`: `enabled: true`. |
| npm trusted publisher and publishing access | **Unverified precondition** | Public registry metadata cannot prove the trusted-publisher tuple, maintainer 2FA, token prohibition, or token revocation. No authenticated npm administration session was used. See the exact verification action below. |

## Exact remediation and verification

Update the existing [Protect main ruleset](https://github.com/beynar/viborm/rules/21923106),
preserving its PR rule, active enforcement, default-branch target, and empty
bypass list. Add `deletion`, `non_fast_forward`, and `required_status_checks`.
Require these eight contexts, with GitHub Actions integration ID `15368`:

- `Types, format, and docs`
- `Core tests`
- `Coverage gates`
- `Package contract (Node 22.12.0)`
- `Package contract (Node 24)`
- `Local providers`
- `PostgreSQL and MySQL providers`
- `Bun and D1 providers`

Use `strict_required_status_checks_policy: true` so a PR must satisfy checks
against the current base. These are actual observed check names, not inferred
workflow job IDs: `GET /repos/beynar/viborm/commits/53eed0012ecebad2122ebae0b36f491ab4c78d55/check-runs?per_page=100`
reported all eight from `github-actions` / app `15368`. The corresponding
[CI run](https://github.com/beynar/viborm/actions/runs/36339417295) passed.
That older run proves names only; it does not validate the pending RC revision.
After the settings change, read the effective-main endpoint again and require
all four rule types and all eight contexts before merging the release PR.

For npm, inspect the `viborm` package's authenticated **Settings → Trusted
Publisher** view and confirm GitHub Actions, owner `beynar`, repository
`viborm`, workflow `release.yml`, environment `npm-production`, and permission
for direct `npm publish` (see the correction above). Confirm maintainer 2FA. Follow `RELEASING.md`:
after the first RC proves trusted publishing and provenance, require 2FA and
disallow tokens, and revoke old automation tokens. Record evidence without
copying credentials. The repository's OIDC workflow configuration alone does
not prove npm accepted this setup.

## Bounded workflow review

Reviewed `.github/workflows/release.yml`, `scripts/release.mjs`, and
`scripts/github-release.mjs` against `RELEASING.md`. The workflow gates
publication on its local, coverage, documentation, Docker, platform, artifact,
and exact Node 22.0.0 consumer jobs. It uses pinned action revisions, an exact
npm version, one tested tarball and integrity manifest, and a protected
publication environment. Only publication has `id-token: write`; only final
GitHub publication has `contents: write`. The publication job fetches main
again after approval and refuses a different commit. Registry verification
checks bytes and provenance; GitHub finalization verifies immutable state.
These are source observations, not an executed release rehearsal.

The main recheck proves revision equality, **not protection or passing branch
checks**. No administrative API check in this workflow closes the missing-main
rules above. Correct the repository rules before dispatch.

One bounded recovery gap remains: the existing release tag's commit is checked
only in `github-release`, after npm publication. A conflicting protected tag can
therefore leave npm published while GitHub finalization refuses. Read-only
`GET /repos/beynar/viborm/git/ref/tags/v1.0.0-rc.1` returned 404 during this
audit, so this is **not an observed RC tag collision**. Before publication,
check that the intended remote tag is absent or resolves to the release commit;
retain the final check because an early observation cannot exclude a later
race. No workflow change was made as part of this audit.

Public `GET https://registry.npmjs.org/viborm` reported `latest: 0.1.0`, no
`next` tag, and no `1.0.0-rc.1` version. The old `0.1.0` metadata has no
attestations. This proves the RC version was unused at observation time; it
proves nothing about the current npm trusted-publisher configuration. Recheck
version and tag state immediately before the authorized release run.

## Scope limits

This audit did not dispatch or approve a workflow, publish a package, change
GitHub/npm settings, or execute the RC provider matrix. Passing administration
checks cannot replace green checks on the final release commit, the approved
environment deployment, registry provenance, or the consumer soak.
