# Releasing VibORM

This is the maintainer runbook for the public `viborm` npm package. The
release unit is one tarball built from protected `main`. The `Release` GitHub
Actions workflow builds that tarball once, tests those exact bytes, publishes
them through npm trusted publishing, verifies the registry copy, and then
creates the matching immutable GitHub release.

Do not publish from a workstation, create a release tag by hand, or publish a
different build after the release artifact has passed its gates.

## One-time repository setup

### npm

The package already exists on npm, so it can use trusted publishing.

1. Enable two-factor authentication on the maintainer account.
2. Open the `viborm` package on npm, then open **Settings → Trusted
   Publisher**.
3. Select **GitHub Actions** and enter:
   - organization or user: `beynar`;
   - repository: `viborm`;
   - workflow filename: `release.yml`;
   - environment: `npm-production`;
   - allowed action: `npm publish` only.
4. Do not create an `NPM_TOKEN` repository secret. The publish job obtains one
   short-lived credential through GitHub OIDC.
5. Run the first release-candidate rehearsal and verify its provenance on npm.
6. Return to **Settings → Publishing access** and select **Require two-factor
   authentication and disallow tokens**. Revoke any old automation tokens.

The workflow filename and environment must match the npm settings exactly.
npm supports one trusted-publisher configuration per package. See npm's
[trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).

The current release contract performs the human approval in the protected
GitHub environment and then publishes directly. npm
[staged publishing](https://docs.npmjs.com/staged-publishing/) is a valid
stronger alternative, but it is not a second supported path. Adopting it means
changing the workflow to `npm stage publish`, changing the trusted publisher to
allow stage publishing only, and requiring a maintainer to approve every stage
with 2FA. Change those three facts together.

### GitHub

1. Create an environment named `npm-production`.
2. Restrict it to protected `main` and require a production reviewer. Enable
   **Prevent self-review** only when another maintainer can approve releases;
   otherwise that rule deadlocks a single-maintainer project.
3. Protect `main`: require pull requests and all release-readiness checks, and
   prohibit force pushes and deletion.
4. Add a `v*` tag ruleset that forbids updates and deletion after creation, but
   allows the `Release` workflow to create the initial tag.
5. Enable immutable releases. Once published, an immutable release locks its
   exact tag and assets; see GitHub's
   [immutable releases documentation](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
6. Enable private vulnerability reporting so `SECURITY.md` reaches the private
   advisory form rather than a public issue.
7. Keep workflow permissions read-only by default. Only the publication job
   receives `id-token: write`, and only the final release job receives the
   permission needed to create the tag and GitHub release.

These settings are release preconditions, not workflow outputs. In particular,
the workflow token cannot read the repository administration setting that
controls immutable releases. Verify that setting before the first run. The
final verifier refuses a published release that GitHub does not report as
immutable, but that refusal is intentionally not presented as a substitute for
repository setup.

## Prepare a release

Use one release pull request. It must:

- set the package version without creating a local tag;
- update the changelog and release notes;
- make the package metadata, README, website, and `LICENSE` agree;
- contain no uncommitted or generated developer-worktree artifact; and
- pass every required branch check.

The workflow accepts stable `X.Y.Z` versions and `X.Y.Z-rc.N` release
candidates. The V1 sequence uses these two exact forms:

| Version | npm distribution tag | GitHub tag |
| --- | --- | --- |
| `1.0.0-rc.N` | `next` | `v1.0.0-rc.N` |
| `1.0.0` | `latest` | `v1.0.0` |

The workflow rejects other prerelease spellings. A version already present on
npm is immutable and cannot be reused.

## Required release evidence

A provider is a required gate when the public support matrix calls its relevant
surface production-ready. A missing runtime, container, credential, extension,
or executed test count is a failure for a required provider, not a skip.

The release report must distinguish:

- PGlite, SQLite3, and LibSQL local contracts;
- PostgreSQL, postgres.js, and MySQL2 container contracts;
- Bun SQL and Bun SQLite contracts on Bun;
- D1 contracts in the Workers substrate; and
- Neon HTTP and PlanetScale contracts against the hosted service when their
  advertised tier requires that evidence.

A documented preview or conditional provider capability may remain
non-blocking. Its job must still report that it did not execute and the public
support table must state the same limitation. Database-family equivalence is
not proof that a concrete provider ran.

The publication gate also proves public types, core behavior, coverage,
package exports, documentation examples, CLI execution, the exact Node 22.0.0
and TypeScript 5.8 floors, the tarball allowlist, and the package-size budget.
The publish job may consume only the tarball and digest produced by that gate.

## Release candidate sequence

1. Merge the `1.0.0-rc.1` release pull request to protected `main`.
2. Open **Actions → Release**, select `main`, and run the workflow.
3. Review the completed evidence and approve the `npm-production` deployment.
4. Wait for registry verification and the immutable `v1.0.0-rc.1` GitHub
   release. Do not create either one manually.
5. Install `viborm@next` in fresh consumers and rehearse fresh installation,
   upgrade from `0.1.0`, CLI use, push, generate, apply, down, reset, tampered
   estate refusal, and interrupted-generation recovery on the declared
   provider matrix.
6. If a blocker is found, publish `1.0.0-rc.2` or a later RC. Never replace an
   existing RC.
7. After the final RC has completed the soak and all blockers are closed, merge
   a release pull request for `1.0.0` and run the same workflow. Only this
   stable release moves `latest`.

The workflow is complete only after npm reports the expected version, channel,
integrity, and provenance; a clean registry consumer passes; and the matching
GitHub release exists.

## Failure and recovery

### Failure before npm accepts the version

No public release exists. Fix the release branch or workflow, merge a new
commit, and rerun the same version from protected `main`. Do not create a tag or
GitHub release to compensate for a failed workflow.

### npm accepts the version, then verification or GitHub release creation fails

Do not publish again. Rerun the workflow only for the same commit. It must
compare the registry integrity with the tested tarball, refuse any mismatch,
and resume registry verification and GitHub release creation.

### The published package is defective

An npm package name and version cannot be reused, even after unpublishing. The
normal recovery is:

1. move `latest` or `next` back to the last known-good version;
2. deprecate the defective version with a precise replacement message;
3. fix the defect and publish a new patch or release candidate; and
4. record the incident in the replacement release notes.

Use unpublish only for an exceptional security or legal incident and follow
npm's current [unpublish policy](https://docs.npmjs.com/policies/unpublish/).
If a secret was exposed, rotate it first; removing a package cannot recall
downloaded bytes.

### Registry integrity does not match the release artifact

Stop. Do not create the GitHub release, move a distribution tag, or attempt to
overwrite the version. Preserve the workflow evidence and investigate the
artifact boundary as a supply-chain incident.
