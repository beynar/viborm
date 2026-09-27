# V1 RC1 preparation and local preflight

Date: 2026-09-27. Candidate: `1.0.0-rc.1`. Base: merged main `53eed0012`.
Status: **prepared for PR qualification, not published or release-authorized**.

The change adds the upgrade guide and corrects support/migration instructions,
sets RC metadata and release notes, and carries forward the existing V1
checklist. No engine behavior or dependency version changes. The only runtime
source edit changes the CLI loader hint from `bun viborm push` to
`bun --bun viborm push`, matching the verified quick-start command.

## Executed local checks

- Node 24.21.0 package build passed under the existing bounded runner.
- All 11 package tests passed. The tarball-aware public-surface and optional-peer
  probes consumed the archive below; other package tests inspect its matching
  built output. The TypeScript 5.8 declaration-floor probe passed.
- Strict publint and the ESM-only Are The Types Wrong profile passed.
- Package metadata, allowlist, file-count and size checks passed through the
  existing release-contract owners. npm 11.15.0 normalization of the installed
  package left its metadata unchanged.
- A fresh consumer installed that archive. On exact Node 22.0.0, all 26 export
  specifiers resolved, the five core entry points imported, and the CLI reported
  `1.0.0-rc.1`.
- The four PGlite Quick Start TypeScript blocks were extracted without rewriting
  their code into a fresh consumer. `bun --bun viborm push --yes --json` created
  only the new disposable schema. The documented create, relation read, update
  and deleteMany calls ran; final assertions confirmed one user with one published
  post. No existing database was dropped or altered.
- Seven upgrade-guide TypeScript blocks compiled against the installed package
  with TypeScript 5.8, strict mode and skipLibCheck, supplying only their omitted
  context imports. This checks examples, not an existing application's upgrade.
- Whole-estate typecheck passed: 8.76 s, 7091.4 MiB sampled process-group RSS
  under the existing 8192 MiB ceiling.
- The CLI hint witness failed before the one-line repair. All 26 CLI utility
  tests then passed. The earlier plain-Node and unforced-Bun quick-start commands
  failed to load the config; the forced-Bun command passed on the final package.
- Docs validation and build passed. Validation reports 11 existing navigation
  title/order warnings; these are not build failures. Changed TS/JSON formatting
  and whitespace checks passed.
- Independent review accepted the docs after correcting two important preview
  distinctions: dry apply/down read live state without a lock; dry reset returns
  an estate path after admission. Neither promises a concurrency-stable decision.

## Local archive identity

| Fact | Value |
| --- | --- |
| Archive | `viborm-1.0.0-rc.1.tgz` |
| Files | 185 (limit 220) |
| Compressed bytes | 1,850,139 (limit 2,500,000) |
| Unpacked bytes | 7,243,409 (limit 9,000,000) |
| SHA-256 | `bcfdb9c442199c1fcec086bacf2f374b1b1d5e1c8fb8ae0dc6516b353c6c92ec` |
| Lockfile SHA-256 | `703a982935c98760e2798fb8397d83a3d937079c94038b085f619b925cc9a598` |
| CLI source SHA-256 | `4a95e6bef6ce15445d11cb23e5be46d6620a33fd692852fba2d6a86c180dad7d` |
| package.json SHA-256 | `1b0b628c483a09b61674a85e79b90af3fe2611902a13e77c5f4c1d9e990f1fa5` |
| README SHA-256 | `39dd52e20971c177473c5b81ab5fca90eae7254ea252313d65f30dfd387d9dc5` |

The archive and local logs remain at
`/tmp/viborm-rc1-preflight.rGdD74/final/`. Temporary local evidence is not a
durable publication artifact. The final archive supersedes the initial archive
outside `final/`, built before the CLI message repair.

Reproduce local package checks with `pnpm package:build`, `npm pack
--ignore-scripts --json --pack-destination <directory>`, and the existing package
project with `VIBORM_PACKAGE_TARBALL` pointing to that exact archive. Do not
invent a protected-main release manifest for this branch. After an authorized
merge, the Release workflow must build and qualify its own exact artifact from
protected main; this local archive is not authorized for publication.

## Remaining gates and authority

The final PR's eight CI jobs must pass. No previous main/PR CI run is relabeled
as RC evidence. Native-provider and whole-estate CI qualification are delegated
to that run instead of repeated locally for this documentation/metadata change.

The [administration audit](v1-release-administration-audit.md) records missing
required CI and force-push/deletion protection on main, plus unverified npm
trusted publishing. No settings were changed. Those preconditions must be
closed before publication. Recheck that the version and tag are unused.

The [existing checklist](v1-release-closure.md) still owns the full upgrade,
recovery and provider rehearsal. Hosted qualification stays explicitly limited.
No RC workflow dispatch, approval, tag, npm publication, or stable-release
decision is included in this work.
