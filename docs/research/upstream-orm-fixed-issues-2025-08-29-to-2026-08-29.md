# Upstream ORM fixed-issue audit: 2025-08-29 to 2026-08-29

Audit window: **2025-08-29 through 2026-08-29 inclusive** (UTC boundary: 2025-08-29T00:00:00Z to 2026-08-29T23:59:59Z).
Audit completed: **2026-08-29**.
VibORM checkout used for current-surface verification: **237c535232b48b1cc86d32ee77a53293684af02a**, including the task-visible dirty worktree at the recorded runs.

This report owns the upstream population, normalization, source evidence, and
the original current-checkout verdicts. Its companion
[implementation closure](../architecture/upstream-defect-closure-2026-08.md)
owns the later re-audit, fixed dispositions, and final validation evidence.

## Executive decision

This is the single authoritative full-year report. It replaces the shorter 2026-04-28 through 2026-08-28 report and embeds the evidence needed to audit the year without relying on temporary subreports.

The year census contains **1,350 normalized upstream corrections**:

| Upstream | Publication inventory | Raw reachable default-branch census | Normalized corrections |
|---|---:|---:|---:|
| Prisma ORM | 35 GitHub releases | 8,193 commits | **791** |
| TypeORM | 7 GitHub Release objects / 10 tags | 490 commits | **137** correction rows: 135 strict identities plus 2 performance corrections |
| Drizzle ORM | 35 release/tag pairs | 63 commits | **422** |
| **Combined** | | | **1,350** |

TypeORM's two reverted strict originals remain visible as identities but are not effective corrections. Its strict arithmetic is 135 identities − 2 reverted originals = **133 effective strict corrections**; the separate two performance corrections make **137 correction rows** in this report.

The original current-checkout comparison yielded **11 confirmed VibORM defects**: the nine carried defects from the shorter audit plus Y1 and Y2. Two prior Drizzle candidates were not affected in the reproduced current path, one hosted Neon transport remained unverified, and the new TypeORM and Drizzle security-advisory mechanisms were negatively disposed because VibORM did not cross their vulnerable representation boundaries. The later closure also corrected PY053 from not affected to affected and fixed; it does not add an open backlog item.

## Methodology and scope

**Evidence cutoff caveat.** The inclusive calendar endpoint defines the query window; it does not claim knowledge of events published after the individual fetches completed on 2026-08-29. Every API and repository population below stops at its recorded fetch snapshot on that date. The latest explicit checkout-comparison timestamp retained by the source audits is **2026-08-29T15:17:21.112Z** (Drizzle/VibORM comparison). An event later on 2026-08-29 needs the next audit refresh.

### Authoritative populations

- **Prisma:** the requested prisma/prisma repository redirects through GitHub to [prisma/orm](https://github.com/prisma/orm). GitHub Release objects, release bodies, linked Prisma-owned issues and pull requests, and commits reachable from current main are the authoritative populations. The current-main graph begins with the imported initial commit on 2025-10-12; earlier in-window releases are therefore release evidence, not fabricated commit evidence.
- **TypeORM:** GitHub Release objects, git tags, CHANGELOG, the publication workflow, security advisories, and commits reachable from current master are authoritative. Scheduled npm dev/nightly publications use no-git-tag-version and do not create release or tag records.
- **Drizzle:** fully paginated GitHub Releases, Tags, Commits, linked issues and pull requests, the first-party release workflows, and the GitHub advisory are authoritative. Feature-branch package snapshots do not create GitHub Release or tag bodies.

Release inclusion uses published_at. Commit censuses use the committed/committer timestamp and require reachability from the audited default-branch head. The inclusive date window is implemented as start >= 2025-08-29T00:00:00Z and end < 2026-08-30T00:00:00Z.

### Included and excluded

Included are corrections to correctness, regressions, security, data integrity, performance regressions, public types, diagnostics, migration behavior, driver execution, and result behavior. Stable, patch, beta, preview, prerelease, and release-candidate artifacts count when they have an auditable GitHub release/tag identity in the window.

Pure features, documentation-only changes, removals, internal refactors, provider additions, release plumbing, and performance-only improvements that did not correct defective behavior are excluded from normalized correction totals but remain visible in raw commit-category censuses. Drafts and undocumented package snapshots with no first-party release/tag/body identity are not invented as releases.

### Normalization rules

1. One release-note symptom is one raw unit.
2. Exact issue or pull-request identity, explicit backports, verbatim repeated claims, and evidenced follow-up chains collapse to one normalized family.
3. Same wording alone never merges events. Duplicate-title families remain separate unless a shared source identity proves equivalence.
4. Merge commits do not create an extra correction when a child commit or linked pull request owns the correction.
5. Reverts remain visible. A reverted original is marked ineffective; its revert is the effective correction.
6. Release and default-branch populations overlap only on exact first-party source identity. Prisma's 183 release corrections plus 608 unrepresented current-main groups equal 791; 18 current-main groups already represented in releases are not counted twice.
7. Drizzle's 450 post-exclusion release-body appearances collapse by 29 exact duplicates/backports to 421 release families; default-branch-only D-C06 adds the 422nd family.
8. TypeORM's 110 carried strict identities plus 25 new strict identities equal 135 strict identities. The two performance corrections are a separate supplement; two non-product changes are exclusions, not corrections.
9. Each correction has exactly one primary owner from schema-relations, validation-types, query-engine, sql, execution, results, migrations, or extensions. Backlog secondary owners identify real VibORM cross-layer fix boundaries and do not change census ownership.

## Exact release and tag inventories

### Prisma ORM — 35 GitHub releases

| Release | Published UTC | GitHub channel | Correction note units |
|---|---:|---|---:|
| [6.16.0](https://github.com/prisma/orm/releases/tag/6.16.0) | 2025-09-10T10:45:39Z | stable | 0 |
| [6.16.1](https://github.com/prisma/orm/releases/tag/6.16.1) | 2025-09-11T12:36:03Z | stable patch | 1 |
| [6.16.2](https://github.com/prisma/orm/releases/tag/6.16.2) | 2025-09-16T12:57:44Z | stable patch | 2 |
| [6.16.3](https://github.com/prisma/orm/releases/tag/6.16.3) | 2025-09-30T14:17:29Z | stable patch | 5 |
| [6.17.0](https://github.com/prisma/orm/releases/tag/6.17.0) | 2025-10-07T17:59:53Z | stable | 4 |
| [6.17.1](https://github.com/prisma/orm/releases/tag/6.17.1) | 2025-10-10T14:38:28Z | stable patch | 1 |
| [6.18.0](https://github.com/prisma/orm/releases/tag/6.18.0) | 2025-10-22T10:30:44Z | stable | 1 |
| [6.19.0](https://github.com/prisma/orm/releases/tag/6.19.0) | 2025-11-05T13:19:16Z | stable | 2 |
| [7.0.0](https://github.com/prisma/orm/releases/tag/7.0.0) | 2025-11-19T14:04:05Z | stable | 1 |
| [7.0.1](https://github.com/prisma/orm/releases/tag/7.0.1) | 2025-11-25T14:48:37Z | stable patch | 6 |
| [7.1.0](https://github.com/prisma/orm/releases/tag/7.1.0) | 2025-12-03T13:43:25Z | stable | 3 |
| [6.19.1](https://github.com/prisma/orm/releases/tag/6.19.1) | 2025-12-11T12:30:10Z | stable patch | 1 |
| [7.2.0](https://github.com/prisma/orm/releases/tag/7.2.0) | 2025-12-17T15:12:49Z | stable | 6 |
| [6.19.2](https://github.com/prisma/orm/releases/tag/6.19.2) | 2026-01-13T12:09:19Z | stable patch | 1 |
| [7.3.0](https://github.com/prisma/orm/releases/tag/7.3.0) | 2026-01-21T16:09:13Z | stable | 3 |
| [7.4.0](https://github.com/prisma/orm/releases/tag/7.4.0) | 2026-02-11T17:09:25Z | stable | 6 |
| [7.4.1](https://github.com/prisma/orm/releases/tag/7.4.1) | 2026-02-19T17:58:06Z | stable patch | 7 |
| [7.4.2](https://github.com/prisma/orm/releases/tag/7.4.2) | 2026-02-27T16:38:01Z | stable patch | 8 |
| [7.5.0](https://github.com/prisma/orm/releases/tag/7.5.0) | 2026-03-11T14:57:08Z | stable | 8 |
| [7.6.0](https://github.com/prisma/orm/releases/tag/7.6.0) | 2026-03-27T14:11:00Z | stable | 7 |
| [6.19.3](https://github.com/prisma/orm/releases/tag/6.19.3) | 2026-04-01T11:23:29Z | stable patch | 1 |
| [7.7.0](https://github.com/prisma/orm/releases/tag/7.7.0) | 2026-04-07T16:00:33Z | stable | 0 |
| [7.8.0](https://github.com/prisma/orm/releases/tag/7.8.0) | 2026-04-22T14:19:23Z | stable | 9 |
| [7.9.0](https://github.com/prisma/orm/releases/tag/7.9.0) | 2026-07-21T07:26:50Z | stable | 22 |
| [7.9.1](https://github.com/prisma/orm/releases/tag/7.9.1) | 2026-07-27T14:17:54Z | stable patch | 1 |
| [v0.17.0](https://github.com/prisma/orm/releases/tag/v0.17.0) | 2026-08-04T13:31:06Z | Prisma 8 preview line | 6 |
| [v8.0.0-rc.1](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.1) | 2026-08-07T10:53:52Z | release candidate | 4 |
| [v8.0.0-rc.2](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.2) | 2026-08-17T13:31:08Z | release candidate | 16 |
| [v8.0.0-rc.3](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.3) | 2026-08-18T10:46:04Z | release candidate | 1 |
| [v8.0.0-rc.4](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.4) | 2026-08-18T16:26:32Z | release candidate | 2 |
| [v8.0.0-rc.5](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.5) | 2026-08-22T10:48:59Z | release candidate | 6 |
| [v8.0.0-rc.6](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.6) | 2026-08-25T07:03:30Z | release candidate | 2 |
| [v8.0.0-rc.7](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.7) | 2026-08-25T10:22:19Z | release candidate | 2 |
| [7.10.0](https://github.com/prisma/orm/releases/tag/7.10.0) | 2026-08-25T12:54:43Z | stable | 35 |
| [v8.0.0-rc.8](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.8) | 2026-08-26T08:15:49Z | release candidate | 4 |
| **Total** |  |  | **184** |

### TypeORM — 7 GitHub Release objects / 10 tags

| Tag | UTC date | GitHub Release | Channel semantics | Primary source |
|---|---:|---|---|---|
| `0.3.27` | 2025-09-19 | stable, not draft/prerelease | v0 maintenance | [release](https://github.com/typeorm/typeorm/releases/tag/0.3.27) |
| `0.3.28` | 2025-12-03 | stable, not draft/prerelease | v0 maintenance; CHANGELOG labels its content 2025-12-02 | [release](https://github.com/typeorm/typeorm/releases/tag/0.3.28) |
| `v1.0.0-beta.1` | 2026-03-23 | **no Release object** | immutable beta snapshot; package version at the tag is `1.0.0-pre` | [tag](https://github.com/typeorm/typeorm/tree/v1.0.0-beta.1) |
| `v1.0.0-beta.2` | 2026-04-15 | **no Release object** | immutable beta snapshot; no independent release-note identity | [tag](https://github.com/typeorm/typeorm/tree/v1.0.0-beta.2) |
| `v1.0.0-beta.3` | 2026-05-05 | **no Release object** | immutable beta snapshot; no independent release-note identity | [tag](https://github.com/typeorm/typeorm/tree/v1.0.0-beta.3) |
| `0.3.29` | 2026-05-08 | stable, not draft/prerelease | v0 maintenance | [release](https://github.com/typeorm/typeorm/releases/tag/0.3.29) |
| `0.3.30` | 2026-05-18 | stable, not draft/prerelease | v0 maintenance | [release](https://github.com/typeorm/typeorm/releases/tag/0.3.30) |
| `1.0.0` | 2026-05-19 | stable, not draft/prerelease | v1 stable | [release](https://github.com/typeorm/typeorm/releases/tag/1.0.0) |
| `1.1.0` | 2026-07-13 | stable, not draft/prerelease | v1 stable; contains the private migration-generator security fix | [release](https://github.com/typeorm/typeorm/releases/tag/1.1.0) |
| `0.3.31` | 2026-07-13 | stable, not draft/prerelease | v0 security backport line | [release](https://github.com/typeorm/typeorm/releases/tag/0.3.31) |

### Drizzle ORM — 35 GitHub release/tag pairs

| Tag / release | Published UTC | API kind | Body bytes | Claims | New families | Notes |
|---|---:|---|---:|---:|---:|---|
| [`drizzle-kit@0.31.5`](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.31.5) | 2025-09-26 12:47:12 | non-prerelease | 66 | 0 | 0 | Studio casing feature only. |
| [`0.44.6`](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.44.6) | 2025-10-02 09:49:38 | non-prerelease | 38 | 0 | 0 | `$replicas` feature only. |
| [`0.44.7`](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.44.7) | 2025-10-23 18:11:14 | non-prerelease | 71 | 1 | 1 | ORM stable patch. |
| [`drizzle-kit@0.31.6`](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.31.6) | 2025-10-28 12:48:32 | non-prerelease | 129 | 1 | 1 | Kit stable patch. |
| [`v0.31.7`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v0.31.7) | 2025-11-17 11:51:53 | non-prerelease | 177 | 1 | 1 | Kit release body with nonstandard tag spelling. |
| [`v1.0.0-beta.2`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.2) | 2025-12-02 21:19:36 | beta | 50,167 | 296 | 296 | Body edited through 2026-01-03; retrospective issue aggregate. |
| [`drizzle-kit@0.31.8`](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.31.8) | 2025-12-04 15:21:04 | non-prerelease | 110 | 1 | 1 | Documentation typo excluded. |
| [`0.45.0`](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.0) | 2025-12-04 15:21:19 | non-prerelease | 592 | 3 | 0 | Three beta.2 backports; feature and typo excluded. |
| [`0.45.1`](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.1) | 2025-12-10 15:02:24 | non-prerelease | 183 | 1 | 0 | Pool-detection backport. |
| [`v1.0.0-beta.3`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.3) | 2025-12-16 15:00:31 | beta | 1,535 | 8 | 0 | All eight issues are present in edited beta.2 body. |
| [`v1.0.0-beta.4`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.4) | 2025-12-23 17:26:41 | beta | 478 | 3 | 3 | — |
| [`v1.0.0-beta.5`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.5) | 2025-12-23 17:46:16 | beta | 3,485 | 7 | 4 | Three linked issues repeat beta.2. |
| [`v1.0.0-beta.6`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.6) | 2025-12-25 10:10:28 | beta | 871 | 6 | 0 | All six issues repeat beta.2. |
| [`v.1.0.0-beta.7`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v.1.0.0-beta.7) | 2025-12-31 14:18:38 | beta | 1,037 | 6 | 2 | Tag contains the upstream `v.` typo; four issues repeat beta.2. |
| [`v1.0.0-beta.8`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.8) | 2025-12-31 16:15:57 | beta | 4,318 | 4 | 4 | — |
| [`v1.0.0-beta.9`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.9) | 2026-01-15 11:50:11 | beta | 1,240 | 2 | 2 | Shares commit with beta.11. |
| [`v1.0.0-beta.11`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11) | 2026-01-15 11:56:27 | beta | 1,690 | 13 | 13 | No GitHub beta.10 release/tag exists. |
| [`v1.0.0-beta.12`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12) | 2026-01-22 15:50:12 | beta | 2,603 | 11 | 11 | Two `node:crypto` reports normalized to one family. |
| [`v1.0.0-beta.13`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.13) | 2026-02-02 19:14:48 | beta | 7,133 | 1 | 1 | Top-level-await work is a feature; CJS load failure is the correction. |
| [`v1.0.0-beta.14`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14) | 2026-02-04 15:11:54 | beta | 1,480 | 11 | 11 | — |
| [`v1.0.0-beta.15`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.15) | 2026-02-05 21:41:14 | beta | 3,036 | 1 | 1 | Validator moves and optional prepare names are not corrections. |
| [`drizzle-kit@0.31.9`](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.31.9) | 2026-02-09 08:29:50 | non-prerelease | 49 | 0 | 0 | D1 API improvement only. |
| [`v1.0.0-beta.16`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.16) | 2026-03-05 20:11:36 | beta | 6,477 | 1 | 1 | One migration-reapplication regression; four implementation stages stay one family. |
| [`v1.0.0-beta.17`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.17) | 2026-03-11 17:26:32 | beta | 860 | 1 | 1 | Node SQLite driver is a feature. |
| [`drizzle-kit@0.31.10`](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.31.10) | 2026-03-17 09:31:42 | non-prerelease | 435 | 1 | 1 | Loader/platform features excluded. |
| [`v1.0.0-beta.18`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.18) | 2026-03-17 11:20:34 | beta | 804 | 2 | 1 | Hanji correction repeats Kit 0.31.10; Node SQLite support excluded. |
| [`v1.0.0-beta.19`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19) | 2026-03-23 19:43:59 | beta | 2,813 | 11 | 11 | Schema-file allowlist consolidated with swap-file issue. |
| [`0.45.2`](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.2) | 2026-03-27 17:06:36 | non-prerelease | 298 | 1 | 1 | Stable security fix. |
| [`v1.0.0-beta.20`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.20) | 2026-03-27 17:17:34 | beta | 302 | 1 | 0 | Verbatim 0.45.2 security backport, published 11 minutes later. |
| [`v1.0.0-beta.21`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.21) | 2026-04-14 09:40:10 | beta | 224 | 2 | 2 | — |
| [`v1.0.0-beta.22`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22) | 2026-04-16 10:24:05 | beta | 1,691 | 10 | 10 | Eight issue links plus two distinct unlinked corrections. |
| [`v1.0.0-rc.1`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.1) | 2026-04-30 21:47:41 | RC | 5,008 | 10 | 8 | Prior audit; two duplicate pairs normalized. |
| [`v1.0.0-rc.2`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.2) | 2026-05-05 18:33:27 | RC | 2,227 | 7 | 7 | Prior audit. |
| [`v1.0.0-rc.3`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.3) | 2026-05-18 20:00:23 | RC | 782 | 2 | 2 | Prior audit. |
| [`v1.0.0-rc.4`](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4) | 2026-06-27 16:10:26 | RC | 7,936 | 24 | 24 | Prior audit. Last GitHub release in the window. |
| **Total** | | | | **450** | **421** | |

No in-window Prisma dev/canary/nightly Release object exists. TypeORM has no in-window release-candidate tag, GitHub prerelease object, or canary tag; its three beta tags have no Release objects. Drizzle has no nightly or canary name in the fully paginated lifetime release/tag sets.

## Raw default-branch commit category censuses

These are raw accounting censuses, not normalized correction totals.

### Prisma main — 8,193 commits

| Category | Commits |
|---|---:|
| other | 1,521 |
| maintenance-refactor | 1,497 |
| docs-skills | 1,401 |
| correction | 1,338 |
| feature | 1,154 |
| test-qa | 758 |
| ci-tooling | 235 |
| merge | 189 |
| release-publish | 62 |
| dependency | 23 |
| revert | 15 |
| **Total** | **8,193** |

The deterministic precedence is merge; revert/backout; release/publish; docs/skills; tests/QA; CI/tooling; dependency; defect/security/performance/correctness; feature; maintenance/refactor; other. The 1,353 correction/revert commits normalize to 626 source groups, including 12 explicit revert/backout groups.

### TypeORM master — 490 commits

| Category | All reachable | First parent |
|---|---:|---:|
| fix | 136 | 135 |
| feature | 61 | 59 |
| ci | 60 | 60 |
| chore | 53 | 53 |
| refactor | 51 | 51 |
| docs | 51 | 51 |
| test | 46 | 45 |
| style | 13 | 13 |
| build | 5 | 5 |
| performance | 4 | 4 |
| revert | 3 | 3 |
| merge | 3 | 3 |
| lint | 2 | 2 |
| other | 2 | 2 |
| **Total** | **490** | **486** |

The four side-branch commits are accounted through merge 75f4463d and their own PR identities. The three merges and three reverts are normalized explicitly in the TypeORM extension ledger.

### Drizzle main — 63 commits

| Category | Commits |
|---|---:|
| documentation-or-manifest | 1 |
| formatting-or-cleanup | 2 |
| merge-only | 19 |
| product-compatibility-maintenance | 1 |
| product-correction | 11 |
| product-feature | 5 |
| product-feature-and-correction | 1 |
| release-infrastructure | 16 |
| release-metadata | 6 |
| test-infrastructure | 1 |
| **Total** | **63** |

Twelve correction commits normalize to 11 identities. Ten identities are release-covered, one identity has a build follow-up, and D-C06 is the sole default-branch correction absent from release prose.

## Combined normalized correction accounting

| Primary owner | Prisma | TypeORM | Drizzle | Combined |
|---|---:|---:|---:|---:|
| schema-relations | 37 | 10 | 7 | **54** |
| validation-types | 117 | 16 | 31 | **164** |
| query-engine | 73 | 30 | 47 | **150** |
| sql | 13 | 10 | 16 | **39** |
| execution | 86 | 27 | 71 | **184** |
| results | 162 | 13 | 26 | **201** |
| migrations | 126 | 17 | 206 | **349** |
| extensions | 177 | 14 | 18 | **209** |
| **Total** | **791** | **137** | **422** | **1,350** |

Arithmetic invariants:

- 791 + 137 + 422 = **1,350**.
- 54 + 164 + 150 + 39 + 184 + 201 + 349 + 209 = **1,350**.
- Prisma: 183 release corrections + 608 unrepresented current-main groups = **791**.
- TypeORM: 135 strict identities + 2 performance corrections = **137 rows**; 135 − 2 reverted originals = **133 effective strict**.
- Drizzle: 421 release families + 1 default-branch-only correction = **422**.

## Current-checkout verdict matrix

| ID / upstream theme | Verdict | Primary owner | Secondary owner(s) | Current evidence |
|---|---|---|---|---|
| 1 — Drizzle #5287 Bun SQL JSON double encoding | **Confirmed backlog** | sql | execution boundary | PostgreSQL physical jsonb type is string; create and fresh read return the serialized string. |
| 2 — TypeORM #11865 enum arrays | **Confirmed backlog** | migrations | sql | PostgreSQL emits scalar enum, while MySQL/SQLite emit scalar enum storage instead of an array representation. |
| 3 — TypeORM #12280 composite-FK ordering | **Confirmed backlog** | schema-relations | migrations, sql | Reversed target order is accepted and MySQL DDL references a tuple that has no matching target key order. |
| 4 — Prisma #30081 idle node-postgres pool error | **Confirmed backlog** | execution | — | VibORM-owned Pool has no error listener; an idle error event escapes the request boundary. |
| 5 — Prisma #29628 nested unique attribution | **Confirmed backlog** | execution | — | Child 23505 maps the child table and constraint but reports meta.model as the root model. |
| 6 — Prisma #29554 PostgreSQL SQLSTATE 23001 | **Confirmed backlog** | execution | — | Restrict violation normalizes to generic QueryError rather than ForeignKeyError. |
| 7 — Prisma #29794 extended SQLite BUSY/LOCKED codes | **Confirmed backlog** | execution | — | Numeric and suffixed symbolic BUSY/LOCKED family values normalize as generic errors. |
| 8 — Prisma #29177 cross-realm Date/Uint8Array | **Confirmed backlog** | validation-types | — | Genuine foreign-realm values fail local instanceof checks; local controls pass. |
| 9 — Prisma #29697/#29718 invalid raw Date | **Confirmed backlog, low severity** | validation-types | — | Invalid Date parameters cross safe and unsafe raw boundaries before provider-specific failure. |
| Y1 — Prisma #29274 SQLite INTEGER/REAL DateTime | **Confirmed backlog** | results | sql, query-engine | Numeric native rows fail typed reads, equality misses, and public writes store ISO TEXT. |
| Y2 — Prisma commit 3f1f10fd | **Confirmed backlog** | query-engine | — | Existing-row upsert with an empty update arm throws No fields to update; missing-row create succeeds. |
| Drizzle concurrent migration branches | **Not affected** | migrations | — | Migration V1 retained both authenticated sibling leaves in two deterministic barrier runs. |
| Drizzle #5090 Bun timestamp | **Not affected in reproduced path** | results | — | Bun 1.4.0/PostgreSQL 16 preserved the instant and milliseconds through write/read/aggregate under a non-UTC timezone. |
| Drizzle rc.1 Neon HTTP bytea | **Unverified** | execution | — | Hosted Neon transport was unavailable; no substitute PostgreSQL provider was treated as equivalent. |
| TypeORM GHSA-2rp8 | **Not applicable; inert negative confirmation** | migrations | — | VibORM emits SQL bytes and JSON manifests, not executable TS/JS template source. |
| TypeORM GHSA-9ggv | **Not applicable** | query-engine | sql, validation-types | VibORM mutations expose no orderBy direction surface. |
| Drizzle GHSA-gpj5 | **Not affected** | sql | migrations | Runtime and migration identifier quoters double embedded dialect delimiters; the malicious-name contract pins it. |

Post-audit closure dispositions: PY053 was affected and is fixed by lowering
`push` and `unshift` as one complete provider-encoded list rather than a
per-member SQL tree. Candidate 3's late repair also closes compound
selector-name collisions at their declaration owner: one selector name may
identify only one ID/unique tuple, while distinct explicit names preserve
otherwise underscore-colliding tuples. These implementation facts belong to
the companion closure and do not change this report's source census.

## Issue-ready backlog — 11 confirmed defects

The following nine items are carried from the shorter audit. They retain their original numbering and reproduction evidence.

### 1. Stop Bun SQL from storing JSON values as JSON strings

- **Upstream:** [Drizzle #5287](https://github.com/drizzle-team/drizzle-orm/issues/5287), plus the rc.1 duplicate JSON/JSONB correction.
- **Reproduction:** Bun 1.4.0 with disposable PostgreSQL 16 stored an input array as physical jsonb type string. Write-return and fresh-read values were serialized strings. Six executions across three clean containers agreed.
- **Why fix:** the persisted domain shape changes. A later correct reader cannot distinguish an intentional JSON string from double encoding.
- **Owner:** primary sql; the concrete boundary spans the PostgreSQL JSON literal and Bun SQL execution binder.
- **Fix direction:** carry an unambiguous internal JSON parameter representation or give Bun SQL a provider-specific JSON path. Do not classify ordinary strings heuristically; JSON string primitives must remain strings, structures must remain structures, and unsafe raw semantics must remain unchanged.
- **Suggested labels:** bug, upstream:drizzle, area:sql, driver:bun-sql, dialect:postgresql, data-integrity.

### 2. Serialize enum arrays as arrays in every dialect

- **Upstream:** [TypeORM #11865](https://github.com/typeorm/typeorm/pull/11865), [issue #6326](https://github.com/typeorm/typeorm/issues/6326).
- **Reproduction:** rendered DDL shows PostgreSQL scalar enum storage, MySQL scalar ENUM, and SQLite scalar TEXT CHECK; adjacent string arrays correctly use text arrays or JSON.
- **Why fix:** public enum-array values are rejected or physically misrepresented across all dialect families.
- **Owner:** primary migrations; secondary sql.
- **Fix direction:** make the array representation win before scalar-enum serialization. Preserve PostgreSQL enum identity with an array suffix and use the established JSON list representation on MySQL and SQLite. Cover all three dialects and remove the known-bug contract skip.
- **Suggested labels:** bug, upstream:typeorm, area:migrations, area:sql, scalar:enum-array, dialect:all.

### 3. Normalize composite stored-reference pairs to target-key order

- **Upstream:** [TypeORM #12280](https://github.com/typeorm/typeorm/pull/12280), [issue #1500](https://github.com/typeorm/typeorm/issues/1500).
- **Reproduction:** validation accepts references in id,tenantId order against a target key in tenantId,id order; MySQL DDL then references id,tenant_id although the only matching target index is tenant_id,id.
- **Why fix:** emitted foreign-key DDL can be invalid, and consumers can disagree about source-to-target pairing.
- **Owner:** primary schema-relations; secondary migrations and sql.
- **Fix direction:** at the one relation-resolution owner, match the requested target tuple to a real key and reorder complete source/target pairs into that key's order, or reject the declaration. Publish the single ordered pairing to query and migration consumers.
- **Suggested labels:** bug, upstream:typeorm, area:schema-relations, area:migrations, dialect:mysql, foreign-key.

### 4. Observe idle node-postgres pool errors without process escape

- **Upstream:** [Prisma #30081](https://github.com/prisma/orm/pull/30081).
- **Reproduction:** a VibORM-owned lazy pg.Pool has zero error listeners; emitting the idle-client error event throws synchronously.
- **Why fix:** an idle connection failure can crash the process outside any request promise.
- **Owner:** execution.
- **Fix direction:** install exactly one driver-owned listener and route failures to the established observable diagnostic boundary. Remove only VibORM's listener on disconnect and define supplied-pool ownership without swallowing the event.
- **Suggested labels:** bug, upstream:prisma, area:execution, driver:pg, lifecycle, reliability.

### 5. Attribute nested statement failures to the nested model

- **Upstream:** [Prisma #29628](https://github.com/prisma/orm/pull/29628).
- **Reproduction:** a nested child create produces the correct P2002 family, child SQL table, constraint, and provider code, but meta.model remains the root model. Rollback is correct.
- **Why fix:** diagnostics, policy, retry logic, and logging can target the wrong model despite statement-specific provider evidence.
- **Owner:** execution.
- **Fix direction:** carry public model attribution on each compiled statement and pass that statement context to driver error normalization. Do not infer a model from physical table text because mappings and namespaces make that heuristic unsound.
- **Suggested labels:** bug, upstream:prisma, area:execution, nested-writes, error-attribution.

### 6. Map PostgreSQL SQLSTATE 23001 to ForeignKeyError

- **Upstream:** [Prisma #29554](https://github.com/prisma/orm/pull/29554).
- **Reproduction:** provider error code 23001 with child_parent_fkey metadata becomes generic QueryError V2001 instead of ForeignKeyError/P2003.
- **Why fix:** PostgreSQL RESTRICT failures lose their stable typed contract.
- **Owner:** execution.
- **Fix direction:** recognize 23001 beside 23503 in the single PostgreSQL error-code owner, retain constraint and SQLSTATE metadata, and pin the typed-error and failure-union contracts.
- **Suggested labels:** bug, upstream:prisma, area:execution, dialect:postgresql, error-mapping.

### 7. Recognize the complete SQLite BUSY/LOCKED families

- **Upstream:** [Prisma #29794](https://github.com/prisma/orm/pull/29794).
- **Reproduction:** SQLITE_BUSY_TIMEOUT/773, SQLITE_BUSY_RECOVERY/261, numeric-only 773/261, and SQLITE_LOCKED_SHAREDCACHE/262 all become generic V2001 errors.
- **Why fix:** retryable lock contention is misclassified, so portable retry policy cannot work consistently across SQLite providers.
- **Owner:** execution.
- **Fix direction:** normalize symbolic family prefixes and extended numeric result codes through SQLite base-code bits while preserving original provider metadata; reuse the existing retryable TransactionError contract.
- **Suggested labels:** bug, upstream:prisma, area:execution, dialect:sqlite, error-mapping, retryability.

### 8. Make native Date and Uint8Array validation realm-independent

- **Upstream:** [Prisma #29177](https://github.com/prisma/orm/pull/29177).
- **Reproduction:** genuine foreign-realm Uint8Array and Date values fail solely because local instanceof is false; equivalent local controls pass.
- **Why fix:** valid values from VM contexts, workers, iframes, or duplicated realms fail public validation.
- **Owner:** validation-types.
- **Fix direction:** use shared realm-independent native-brand guards backed by built-in internal-slot operations so Symbol.toStringTag spoofing is insufficient. Preserve existing scalar invariants and add positive foreign-realm plus hostile-spoof public probes.
- **Suggested labels:** bug, upstream:prisma, area:validation-types, scalar:blob, scalar:date, cross-realm.

### 9. Reject invalid raw Date values before provider dispatch

- **Upstream:** [Prisma #29697](https://github.com/prisma/orm/pull/29697), [#29718](https://github.com/prisma/orm/pull/29718).
- **Reproduction:** safe and unsafe raw methods pass the same invalid Date to a permissive recording driver. PGlite and SQLite fail only after dispatch with provider-specific generic errors.
- **Why fix:** identical public input can resolve or reject differently by provider and loses diagnostic specificity. Unsafe ownership concerns statement text, not impossible bound temporal values.
- **Owner:** validation-types.
- **Fix direction:** after all raw input forms resolve but before any driver call, enforce one shared invariant: a Date parameter must have a finite epoch. Cover all four raw methods, prove validation precedes execution, preserve valid Date identity, and leave unrelated provider-native parameter types untouched.
- **Suggested labels:** bug, upstream:prisma, area:validation-types, raw-sql, scalar:date, low-severity.

### Y1. Honor SQLite INTEGER/REAL native DateTime end to end

- **Upstream:** [Prisma #29274](https://github.com/prisma/orm/pull/29274).
- **Reproduction:** the isolated public-client BunSQLite probe seeded exact INTEGER epoch-millisecond and REAL Julian-day rows. Both typed reads failed with malformed datetime V9001; equality filters returned no rows; public creates succeeded but physical inspection found ISO TEXT in both native columns.
- **Why fix:** the declared native type controls DDL but not writes, predicates, or results. The database can contain valid declared values that VibORM cannot read or match, while VibORM writes the wrong physical representation.
- **Owner:** primary results; secondary sql and query-engine. The complete fix belongs to one SQLite temporal physical codec shared by value lowering and result decoding.
- **Fix direction:** encode TEXT as ISO text, INTEGER as exact epoch milliseconds, and REAL as Julian day for create/update/filter/cursor values. Decode only the field-declared native form, validate range and finiteness, and keep raw SQL physical and unchanged.
- **Regression matrix:** TEXT/INTEGER/REAL × create/read/equality/update; boundary dates; nullability; Bun bigint transport for INTEGER; raw SQL unchanged.
- **Suggested labels:** bug, upstream:prisma, area:results, area:sql, area:query-engine, dialect:sqlite, scalar:datetime, data-integrity.

### Y2. Treat an empty existing-row upsert update as a no-op

- **Upstream:** [Prisma commit 3f1f10fd1a8d4188f78f6193c55a9542dcdffeec](https://github.com/prisma/orm/commit/3f1f10fd1a8d4188f78f6193c55a9542dcdffeec).
- **Reproduction:** the existing-row public upsert arm returned QueryEngineError No fields to update and left the row unchanged. The missing-row arm created successfully. Forcing supportsTargetedUpsert off produced the same failure, so this is not an adapter-specific conflict-fold defect.
- **Why fix:** an upsert's found arm may legitimately be a no-op. Reusing the ordinary SET builder changes valid branch semantics into a failure.
- **Owner:** primary query-engine, specifically UpsertOperation.
- **Fix direction:** after locating the row and validating the found arm, classify an empty update before buildUpdate, perform no write, and return/reload the existing row. Keep ordinary update with empty data and the shared SET builder unchanged.
- **Regression matrix:** existing row/no-op return; missing row/create; mapped table and unique key; select/include; folded and probe paths; non-empty upsert unchanged.
- **Suggested labels:** bug, upstream:prisma, area:query-engine, operation:upsert, dialect:all.

The independent **Sol/high** Y1 and Y2 public-client probes each ran twice with identical evidence. Both called client disconnect, explicitly closed the borrowed bun:sqlite handle, and proved closure by observing RangeError on post-close access. No provider handle remained open. Second-run evidence hashes were 8475764ac278c7c5e8f6a07232718573858150966f01483e5ebacc9f3744595d for Y1 and a20802029f67b6fdbc03072627469b05f739e551d588e16ec28374d96f0ff58d for Y2.

## Security advisory dispositions

- **TypeORM GHSA-2rp8-mm9q-fp49 / CVE-2026-73651:** TypeORM interpolated database-derived SQL into executable migration template source. VibORM's Migration V1 output is sealed SQL bytes plus canonical JSON manifests, with no generated TS/JS template, import, eval, or executable-source boundary. The safe negative confirmation inspects a benign interpolation-shaped marker only as inert SQL bytes and never imports, evaluates, transpiles, or executes it. Disposition: **not applicable by representation**.
- **TypeORM GHSA-9ggv-8w38-r7pm:** the advisory belongs to [#12217 orderBy direction validation](https://github.com/typeorm/typeorm/pull/12217), not to #12436/#12437 mutation limit validation. VibORM mutations expose no orderBy surface. Disposition: **not applicable**. This attribution correction changes no count.
- **Drizzle GHSA-gpj5-g38j-94v9 / CVE-2026-39356:** attacker-controlled identifier text was not escaped. VibORM's shared runtime quoter and migration quoters double embedded double quotes or backticks, and the identifier-escaping contract covers a malicious name. Disposition: **not affected**.
- Prisma dependency, credential-permission, Studio origin, OpenSSL, URL-redaction, and transitive-advisory corrections remain individually visible in the ledgers. Their affected components or vulnerable dependency paths are absent from VibORM; no additional backlog item was established.
- TypeORM's shipped sha.js and glob advisories and Drizzle's esbuild-loader advisories are dependency-specific. The audited VibORM dependency paths do not contain the affected shipped components described by those corrections.

## Repeatable GitHub commands

The following commands use the exact inclusive dates. GitHub APIs are paginated; the end is exclusive at 2026-08-30T00:00:00Z.

~~~sh
for repository in prisma/orm typeorm/typeorm drizzle-team/drizzle-orm; do
  gh api --paginate "repos/$repository/releases?per_page=100" \
    --jq '.[] | select(.published_at >= "2025-08-29T00:00:00Z" and .published_at < "2026-08-30T00:00:00Z") | [.tag_name, .published_at, .prerelease, .draft, .html_url] | @tsv'
done

gh api --paginate 'repos/prisma/orm/commits?sha=main&since=2025-08-29T00:00:00Z&until=2026-08-29T23:59:59Z&per_page=100' \
  --jq '.[] | [.sha, .commit.committer.date, .html_url, (.commit.message | split("\n")[0])] | @tsv'

gh api --paginate 'repos/typeorm/typeorm/commits?sha=master&since=2025-08-29T00:00:00Z&until=2026-08-29T23:59:59Z&per_page=100' \
  --jq '.[] | [.sha, .commit.committer.date, .html_url, (.commit.message | split("\n")[0])] | @tsv'

gh api --paginate 'repos/drizzle-team/drizzle-orm/commits?sha=main&since=2025-08-29T00:00:00Z&until=2026-08-29T23:59:59Z&per_page=100' \
  --jq '.[] | [.sha, .commit.committer.date, .html_url, (.commit.message | split("\n")[0])] | @tsv'

gh api --paginate 'repos/typeorm/typeorm/tags?per_page=100' \
  --jq '.[] | [.name, .commit.sha] | @tsv'

gh api --paginate 'repos/drizzle-team/drizzle-orm/tags?per_page=100' \
  --jq '.[] | [.name, .commit.sha] | @tsv'
~~~

Open the 11 confirmed upstream sources:

~~~sh
gh issue view 5287 --repo drizzle-team/drizzle-orm --web
gh pr view 11865 --repo typeorm/typeorm --web
gh pr view 12280 --repo typeorm/typeorm --web
gh pr view 30081 --repo prisma/orm --web
gh pr view 29628 --repo prisma/orm --web
gh pr view 29554 --repo prisma/orm --web
gh pr view 29794 --repo prisma/orm --web
gh pr view 29177 --repo prisma/orm --web
gh pr view 29697 --repo prisma/orm --web
gh pr view 29718 --repo prisma/orm --web
gh pr view 29274 --repo prisma/orm --web
gh api repos/prisma/orm/commits/3f1f10fd1a8d4188f78f6193c55a9542dcdffeec --jq '.html_url'
~~~

## Source-discovery cache and evidence integrity

Parallel/deep search outputs were discovery aids only. Decisive claims use first-party GitHub releases, tags, commits, pull requests, issues, workflows, advisories, and the current VibORM checkout. The transient discovery caches under /tmp, including the earlier upstream-orm-release-sources.json and the vendor year-audit caches, are not report dependencies. This report embeds the exact inventories, category censuses, normalization arithmetic, current verdicts, and complete compact source-linked correction ledgers needed to reconstruct every family.

The machine-cache manifest at consolidation time was: Prisma `releases-window.json`, `commits-accounted.jsonl`, `commit-category-counts.json`, `release-corrections-pre-four-month.jsonl`, `correction-groups.jsonl`, and `machine-cache-sha256.txt` under `/tmp/viborm-prisma-year-audit/`; TypeORM `/tmp/typeorm-year-release-inventory.json`, `/tmp/typeorm-year-tags.json`, `/tmp/typeorm-year-commits.json`, `/tmp/typeorm-year-new-corrections.json`, and `/tmp/typeorm-year-census-summary.json`; Drizzle `/tmp/drizzle-year-release-canonical-corrections.tsv`, `/tmp/drizzle-year-release-github-correction-inventory.json`, `/tmp/drizzle-year-commits-api.json`, `/tmp/drizzle-year-commits-git.json`, `/tmp/drizzle-year-commit-accounting.json`, and the release/tag JSON inventories. These are reproducibility caches, not durable dependencies; the commands and inline ledgers remain authoritative after cleanup.

No repository test, TypeScript, Vitest, layer, provider, or package command was run as part of the three upstream censuses or this consolidation. The only runtime work claimed here is the explicitly described current-checkout reproductions: the nine carried probes from the shorter audit and the twice-run Sol/high Y1/Y2 probes. No test is claimed merely because a source invariant was inspected.

## Worktree, task-resource, and cleanup policy

This consolidation changes only this report path. It does not modify source, tests, AGENTS.md, memory.md, dependencies, or configuration; it does not create GitHub issues, commit, or push. Pre-existing and concurrent dirty-worktree changes remain untouched.

Each audit task may remove only resources it created: disposable worktrees or clones, temporary files, processes, in-memory databases, provider tables, and containers. It must close database/client handles, stop its own processes, and remove its own containers or tables. It must then inspect the main repository status. It must never reset, clean, stash, revert, overwrite, or discard unrelated work in the main checkout. Temporary evidence can be retained long enough to consolidate the report, but the report must remain auditable after those caches are removed.

Completion record: the task-created TypeORM source clone was clean and moved to the macOS Trash; the Drizzle audit removed its disposable clone and staging scripts; the Y1/Y2 probes closed their borrowed in-memory databases and verified closure. No audit-created worktree, process, or container remains. Pre-existing benchmark worktrees and database test containers were identified as unrelated and left untouched. The source caches listed above remain only as transient reproducibility evidence.

## Appendix A — carried four-month normalized correction ledgers

### A.1 Prisma carried ledger (101)

The IDs match the audit's stable `P001`–`P101` census. Impact text is retained only when sourced upstream.

| ID | Release | Source | Normalized correction | Owner / sourced impact | Audit result |
|---|---|---|---|---|---|
| P001 | 7.9.0 | [release note](https://github.com/prisma/orm/releases/tag/7.9.0) | AI checkpoint now covers `db push --accept-data-loss`. | migrations · **data-loss** | **N/A** |
| P002 | 7.9.0 | [release note](https://github.com/prisma/orm/releases/tag/7.9.0) | Removed the database-dropping `migrate-reset` MCP tool. | migrations · **data-loss** | **N/A** |
| P003 | 7.9.0 | [#29592](https://github.com/prisma/orm/pull/29592) | Restored a generic default that caused multi-minute TypeScript regressions on large schemas. | validation-types · **performance** | **low** |
| P004 | 7.9.0 | [#29735](https://github.com/prisma/orm/pull/29735) | `XOR` no longer accepts primitive mutation `data` at compile time. | validation-types | **N/A** |
| P005 | 7.9.0 | [#29697](https://github.com/prisma/orm/pull/29697) | Invalid raw-query `Date` no longer serializes as `null`. | validation-types | **confirmed backlog 9** |
| P006 | 7.9.0 | [#29736](https://github.com/prisma/orm/pull/29736) | Generator escapes `*/` in emitted documentation comments. | validation-types | **N/A** |
| P007 | 7.9.0 | [#29624](https://github.com/prisma/orm/pull/29624) | Missing-adapter diagnostics now give an actionable example. | execution | **N/A** |
| P008 | 7.9.0 | [#29512](https://github.com/prisma/orm/pull/29512) | Unmapped adapter errors retain original code/message in a typed user error. | execution | **N/A** |
| P009 | 7.9.0 | [#29738](https://github.com/prisma/orm/pull/29738) | Enum/type-only schema no longer emits a stray `undefined` statement. | validation-types | **N/A** |
| P010 | 7.9.0 | [#29727](https://github.com/prisma/orm/pull/29727) | Timed-out transaction startup rolls back before returning the late-acquired connection. | execution | **N/A** |
| P011 | 7.9.0 | [#29740](https://github.com/prisma/orm/pull/29740) | Schema loading no longer hangs/deduplicates incorrectly across symlink cycles. | validation-types | **N/A** |
| P012 | 7.9.0 | [#29730](https://github.com/prisma/orm/pull/29730) | Windows engine cache is stable and no longer bloats bundles with duplicate engine caches. | execution · **performance** | **N/A** |
| P013 | 7.9.0 | [#29538](https://github.com/prisma/orm/pull/29538) | PG-family `Bytes` reads stop using deprecated Node `Buffer()` construction. | results | **N/A** |
| P014 | 7.9.0 | [#29737](https://github.com/prisma/orm/pull/29737) | Column-not-found parsing handles quoted/unquoted PostgreSQL identifiers. | execution | **low** |
| P015 | 7.9.0 | [#29630](https://github.com/prisma/orm/pull/29630) | MSSQL nullable `VarBinary` null parameters retain binary typing. | sql | **N/A** |
| P016 | 7.9.0 | [prisma-engines#5817](https://github.com/prisma/prisma-engines/pull/5817) | A rolled-back on-disk migration is reported as unapplied. | migrations | **N/A** |
| P017 | 7.9.0 | [prisma-engines#4906](https://github.com/prisma/prisma-engines/pull/4906) | PostgreSQL PK constraint rename is emitted as a separate `ALTER TABLE`. | migrations | **N/A** |
| P018 | 7.9.0 | [#29514](https://github.com/prisma/orm/pull/29514) | Removed vulnerable `hono` path and patched `ajv`/`uuid` advisories. | execution · **security** | **N/A** |
| P019 | 7.9.0 | [#29568](https://github.com/prisma/orm/pull/29568) | Platform OAuth credential files/directories are no longer world-readable. | execution · **security** | **N/A** |
| P020 | 7.9.0 | [prisma-engines#5815](https://github.com/prisma/prisma-engines/pull/5815) | Bumped vulnerable/old OpenSSL crate in engine binaries. | execution · **security** | **N/A** |
| P021 | 7.9.0 | [release note](https://github.com/prisma/orm/releases/tag/7.9.0) | Studio can edit PostgreSQL text arrays when values are inlined. | sql | **N/A** |
| P022 | 7.9.0 | [release note](https://github.com/prisma/orm/releases/tag/7.9.0) | Studio startup no longer cancels and repeats introspection requests. | execution · **performance** | **N/A** |
| P023 | 7.9.1 | [#29780](https://github.com/prisma/orm/issues/29780) | Updated a transitive CLI dependency to silence a security advisory false positive; release says Prisma was not affected. | execution · **security** | **N/A** |
| P024 | v0.17.0 | [#29844](https://github.com/prisma/orm/pull/29844), [next#1023](https://github.com/prisma/prisma-next/pull/1023), [next#1051](https://github.com/prisma/prisma-next/pull/1051) | Relation includes and aggregates no longer round `int64`/decimal/temporal values through lossy JSON. | results | **N/A** |
| P025 | v0.17.0 | [#29879](https://github.com/prisma/orm/pull/29879) | MongoDB writes decode result values through codecs instead of returning wire values. | results | **N/A** |
| P026 | v0.17.0 | [#29839](https://github.com/prisma/orm/pull/29839) | Queries sharing one pinned PostgreSQL client are serialized to avoid interleaving. | execution | **low** |
| P027 | v0.17.0 | [next#1034](https://github.com/prisma/prisma-next/pull/1034) | Mixed-case PostgreSQL native-enum cast identifiers are quoted. | sql | **N/A** |
| P028 | v0.17.0 | [next#1017](https://github.com/prisma/prisma-next/pull/1017) | Driver cursor streams run in an explicit transaction so portals survive. | execution | **N/A** |
| P029 | v0.17.0 | [#29862](https://github.com/prisma/orm/pull/29862) | Published declarations no longer name undeclared/uninstalled packages. | validation-types | **N/A** |
| P030 | v8.0.0-rc.1 | [#29889](https://github.com/prisma/orm/pull/29889), [#29898](https://github.com/prisma/orm/pull/29898) | Non-identifier mapped names/control characters no longer generate invalid TypeScript. | validation-types | **N/A** |
| P031 | v8.0.0-rc.1 | [#29900](https://github.com/prisma/orm/pull/29900) | Nested self-relation quantifiers keep distinct correlated SQL aliases. | query-engine | **N/A** |
| P032 | v8.0.0-rc.1 | [#29888](https://github.com/prisma/orm/pull/29888) | Many-to-many relation reducers traverse the junction table. | query-engine | **N/A** |
| P033 | v8.0.0-rc.1 | [#29907](https://github.com/prisma/orm/pull/29907) | Failed stale-prepared retry is surfaced as a structured error with cause. | execution | **N/A** |
| P034 | v8.0.0-rc.2 | [#29930](https://github.com/prisma/orm/pull/29930) | Number aggregates fail outside the safe integer range; wide integer codecs reject the wrong JS primitive. | results | **N/A** |
| P035 | v8.0.0-rc.2 | [#29922](https://github.com/prisma/orm/pull/29922) | `count(field)` now counts non-null field values instead of discarding its argument. | query-engine | **N/A** |
| P036 | v8.0.0-rc.2 | [#29892](https://github.com/prisma/orm/pull/29892) | CHECK introspection/contract shape now preserves raw checks; numeric enums fail during contract build rather than migrate. | migrations | **N/A** |
| P037 | v8.0.0-rc.2 | [#29986](https://github.com/prisma/orm/pull/29986) | Destructive update consent binds to database and plan; `--yes` cannot grant it. | migrations · **data-loss** | **N/A** |
| P038 | v8.0.0-rc.2 | [#29984](https://github.com/prisma/orm/pull/29984) | Diagnostic commands distinguish findings from execution errors via exit codes. | migrations | **N/A** |
| P039 | v8.0.0-rc.2 | [#29982](https://github.com/prisma/orm/pull/29982) | Retired migration flags now name the replacement command. | migrations | **N/A** |
| P040 | v8.0.0-rc.2 | [#29894](https://github.com/prisma/orm/pull/29894) | Unchanged CHECK content is renamed rather than dropped/re-added. | migrations | **N/A** |
| P041 | v8.0.0-rc.2 | [#29919](https://github.com/prisma/orm/pull/29919) | CLI failures expose their real structured error codes and causes. | execution | **N/A** |
| P042 | v8.0.0-rc.2 | [#29936](https://github.com/prisma/orm/pull/29936) | Config diagnostics are section-scoped so irrelevant invalid config does not block a command. | validation-types | **N/A** |
| P043 | v8.0.0-rc.2 | [#30018](https://github.com/prisma/orm/pull/30018) | `init` works against published packages and retains child stderr. | execution | **N/A** |
| P044 | v8.0.0-rc.2 | [#29981](https://github.com/prisma/orm/pull/29981) | Contract emitter resolves imports relative to the output project, not process CWD. | validation-types | **N/A** |
| P045 | v8.0.0-rc.2 | [#30025](https://github.com/prisma/orm/pull/30025) | Generated FK-index prefixes fit PostgreSQL's 63-byte identifier cap. | migrations | **low** |
| P046 | v8.0.0-rc.2 | [#30014](https://github.com/prisma/orm/pull/30014) | Raw row-spec key `__proto__` is refused instead of mutating the record prototype. | results | **N/A** |
| P047 | v8.0.0-rc.2 | [#29920](https://github.com/prisma/orm/pull/29920) | A direct-driver read no longer commits a caller-owned PostgreSQL transaction. | execution | **N/A** |
| P048 | v8.0.0-rc.2 | [#29910](https://github.com/prisma/orm/pull/29910) | Mutation reload encodes `Bytes` identities through the codec. | sql | **N/A** |
| P049 | v8.0.0-rc.2 | [#29977](https://github.com/prisma/orm/pull/29977) | Remediation actions are structured rather than embedded in CLI prose. | execution | **N/A** |
| P050 | v8.0.0-rc.3 | [#30056](https://github.com/prisma/orm/pull/30056) | Correct engine peer fixes `npx prisma@next` import failure. | execution | **N/A** |
| P051 | v8.0.0-rc.4 | [#30064](https://github.com/prisma/orm/pull/30064) | Contract validation accepts a relative project root by resolving it before `createRequire`. | validation-types | **N/A** |
| P052 | v8.0.0-rc.4 | [#30064](https://github.com/prisma/orm/pull/30064) | Init scaffolds the current config marker rather than a deprecated alias. | execution | **N/A** |
| P053 | v8.0.0-rc.5 | [#30067](https://github.com/prisma/orm/pull/30067) | Aggregate reduction respects chained cursor/distinct/take/skip. | query-engine | **N/A** |
| P054 | v8.0.0-rc.5 | [#30092](https://github.com/prisma/orm/pull/30092) | GroupBy preserves pre-group windowing and separately pages grouped output. | query-engine | **N/A** |
| P055 | v8.0.0-rc.5 | [#30081](https://github.com/prisma/orm/pull/30081) | Runtime-owned/received PG pools and clients get `error` listeners; idle disconnects no longer crash the process. | execution | **confirmed backlog 4** |
| P056 | v8.0.0-rc.5 | [#30077](https://github.com/prisma/orm/pull/30077) | LSP recognizes connection errors across duplicated `vscode-jsonrpc` copies. | execution | **N/A** |
| P057 | v8.0.0-rc.5 | [#30041](https://github.com/prisma/orm/pull/30041) | CLI diagnostics use the configured migrations directory. | migrations | **N/A** |
| P058 | v8.0.0-rc.5 | [#30083](https://github.com/prisma/orm/pull/30083) | Init failure messages name current flags/binary. | execution | **N/A** |
| P059 | v8.0.0-rc.6 | [prisma-cli#222](https://github.com/prisma/prisma-cli/pull/222) | Config evaluation works through non-realpathed pnpm symlink layouts. | execution | **N/A** |
| P060 | v8.0.0-rc.6 | [prisma-cli#224](https://github.com/prisma/prisma-cli/pull/224) | Skills notice uses complete CI-vendor detection instead of two environment variables. | execution | **N/A** |
| P061 | v8.0.0-rc.7 | [prisma-cli#225](https://github.com/prisma/prisma-cli/pull/225) | Init installs its exact CLI dependency so the generated config can resolve `prisma/config`. | execution | **N/A** |
| P062 | v8.0.0-rc.7 | [prisma-cli#227](https://github.com/prisma/prisma-cli/pull/227) | Corrected release-family peer pins/transition exceptions so the publish channel can run. | execution | **N/A** |
| P063 | 7.10.0 | [#29890](https://github.com/prisma/orm/pull/29890) | Studio binds loopback and validates origins/CORS. | execution · **security** | **N/A** |
| P064 | 7.10.0 | [#29628](https://github.com/prisma/orm/pull/29628) | Nested unique errors attribute the nested model, including mapped/schema-qualified models. | execution | **confirmed backlog 5** |
| P065 | 7.10.0 | [#29654](https://github.com/prisma/orm/pull/29654) | Every miss in an auto-batched `findUniqueOrThrow` rejects instead of later misses resolving undefined. | query-engine | **N/A** |
| P066 | 7.10.0 | [#29771](https://github.com/prisma/orm/pull/29771) | Parameter chunks execute atomically and roll back on a later failure. | execution | **N/A** |
| P067 | 7.10.0 | [#28768](https://github.com/prisma/orm/pull/28768) | Disconnect cleans up interactive transactions even while driver startup is in flight. | execution | **N/A** |
| P068 | 7.10.0 | [#29611](https://github.com/prisma/orm/pull/29611) | Timeout/backend-termination cleanup rejections are observed rather than becoming unhandled promises. | execution | **N/A** |
| P069 | 7.10.0 | [#29683](https://github.com/prisma/orm/pull/29683) | Fluent relations work when fields are literally named `select` or `include`. | schema-relations | **N/A** |
| P070 | 7.10.0 | [#29177](https://github.com/prisma/orm/pull/29177) | Values from other JS realms are recognized as `Date`/`Uint8Array`. | validation-types | **confirmed backlog 8** |
| P071 | 7.10.0 | [#29718](https://github.com/prisma/orm/pull/29718) | Invalid raw-query Date raises a validation error rather than a generic failure. | validation-types | **confirmed backlog 9** |
| P072 | 7.10.0 | [#29712](https://github.com/prisma/orm/pull/29712) | Generator module format follows Node16/NodeNext and nearest package type. | validation-types | **N/A** |
| P073 | 7.10.0 | [#29701](https://github.com/prisma/orm/pull/29701) | Decoded Bytes own a standalone ArrayBuffer rather than a shared Buffer-pool slab. | results | **N/A** |
| P074 | 7.10.0 | [#28892](https://github.com/prisma/orm/pull/28892) | Remote executor logging uses the active remote query context. | extensions | **N/A** |
| P075 | 7.10.0 | [#29782](https://github.com/prisma/orm/pull/29782) | Result-extension compute callbacks receive the current model name. | extensions | **N/A** |
| P076 | 7.10.0 | [#28892](https://github.com/prisma/orm/pull/28892) | Remote OpenTelemetry query spans have correct parent/active context and attributes. | extensions | **N/A** |
| P077 | 7.10.0 | [#27992](https://github.com/prisma/orm/pull/27992) | MariaDB adapter accepts caller pools and respects caller ownership. | execution | **N/A** |
| P078 | 7.10.0 | [#29612](https://github.com/prisma/orm/pull/29612) | MariaDB commit/rollback/startup failures no longer leak pooled connections/listeners. | execution | **N/A** |
| P079 | 7.10.0 | [#29026](https://github.com/prisma/orm/pull/29026) | MariaDB connection-string parser accepts bracketed IPv6 hosts. | execution | **N/A** |
| P080 | 7.10.0 | [#27992](https://github.com/prisma/orm/pull/27992) | Malformed MariaDB URLs no longer leak embedded passwords into retained debug diagnostics. | execution · **security** | **N/A** |
| P081 | 7.10.0 | [#29717](https://github.com/prisma/orm/pull/29717) | PostgreSQL `40P01` deadlocks map to retryable transaction conflicts. | execution | **N/A** |
| P082 | 7.10.0 | [#29554](https://github.com/prisma/orm/pull/29554) | PostgreSQL `RESTRICT` SQLSTATE `23001` maps to a foreign-key error with constraint detail. | execution | **confirmed backlog 6** |
| P083 | 7.10.0 | [#29587](https://github.com/prisma/orm/pull/29587) | PG adapter preserves named unique constraint in typed error metadata. | execution | **N/A** |
| P084 | 7.10.0 | [#29801](https://github.com/prisma/orm/pull/29801) | Prisma Postgres Serverless prefers named unique constraint, falling back to parsed fields. | execution | **N/A** |
| P085 | 7.10.0 | [#29747](https://github.com/prisma/orm/pull/29747) | Neon HTTP serializes typed `Bytes`/`DateTime` engine-wire values correctly. | sql | **N/A** |
| P086 | 7.10.0 | [#29794](https://github.com/prisma/orm/pull/29794) | Previously raw SQLite result codes are typed; the complete `SQLITE_BUSY` family is mapped and numeric extended codes retained. | execution | **confirmed backlog 7** |
| P087 | 7.10.0 | [#29593](https://github.com/prisma/orm/pull/29593) | Global CLI warns when it differs from local package versions. | execution | **N/A** |
| P088 | 7.10.0 | [#29573](https://github.com/prisma/orm/pull/29573) | Version diagnostics include resolved CLI package path. | execution | **N/A** |
| P089 | 7.10.0 | [#29657](https://github.com/prisma/orm/pull/29657) | Empty/generator-only schema commands fail at the datasource boundary. | validation-types | **N/A** |
| P090 | 7.10.0 | [#29609](https://github.com/prisma/orm/pull/29609) | Corrupt/unwritable CLI command-state files reinitialize or fall back safely. | execution | **N/A** |
| P091 | 7.10.0 | [#29623](https://github.com/prisma/orm/pull/29623) | Studio recognizes semicolon SQL Server URLs before giving its unsupported message. | execution | **N/A** |
| P092 | 7.10.0 | [#29793](https://github.com/prisma/orm/pull/29793) | Interactive data-loss confirmations also receive the AI checkpoint. | migrations · **data-loss** | **N/A** |
| P093 | 7.10.0 | [#29004](https://github.com/prisma/orm/pull/29004) | Single-database-operation query plans use an eager fast path. | query-engine · **performance** | **low** |
| P094 | 7.10.0 | [#29751](https://github.com/prisma/orm/pull/29751) | Huge parameter/result collections no longer overflow the JS call stack. | sql · **performance** | **N/A** |
| P095 | 7.10.0 | [#29752](https://github.com/prisma/orm/pull/29752) | Fluent relation maps are lazy/linear instead of eagerly quadratic. | query-engine · **performance** | **N/A** |
| P096 | 7.10.0 | [#29758](https://github.com/prisma/orm/pull/29758) | Patched `fast-uri` transitive advisory. | execution · **security** | **N/A** |
| P097 | 7.10.0 | [#29794](https://github.com/prisma/orm/pull/29794) | Unknown SQLite database errors are normalized instead of escaping as raw driver errors. | execution | **N/A** |
| P098 | v8.0.0-rc.8 | [#30122](https://github.com/prisma/orm/pull/30122) | Migration planning refuses an empty database when migrations already exist unless baseline is explicit. | migrations | **N/A** |
| P099 | v8.0.0-rc.8 | [#30126](https://github.com/prisma/orm/pull/30126) | Structured error docs URLs target the current v8 docs path. | execution | **N/A** |
| P100 | v8.0.0-rc.8 | [#30121](https://github.com/prisma/orm/pull/30121) | LSP canonicalizes Windows file URIs for configured schema files. | validation-types | **N/A** |
| P101 | v8.0.0-rc.8 | [#30125](https://github.com/prisma/orm/pull/30125) | Release pushes refresh the `dev` dist-tag base so engine pins do not go stale. | execution | **N/A** |

### A.2 TypeORM carried ledger (110)

The raw 130 release-note occurrences are normalized here: six earlier fixes repeated in `1.0.0`, and the same 14 fixes shipped in both `0.3.31` and `1.1.0`. Reverted attempted corrections remain visible.

| ID | Release(s) | Source | Normalized correction | Owner | Audit result |
|---|---|---|---|---|---|
| T001 | 0.3.29 | [#11822](https://github.com/typeorm/typeorm/pull/11822) | Qualify aggregate fields when relation filters add same-named columns | `query-engine` | **low** |
| T002 | 0.3.29 | [#11267](https://github.com/typeorm/typeorm/pull/11267) | Do not let eager-loaded relations overwrite manually assigned relations | `results` | **N/A** |
| T003 | 0.3.29 | [#11232](https://github.com/typeorm/typeorm/pull/11232), [issue #11231](https://github.com/typeorm/typeorm/issues/11231) | Release query runner when rollback has no migration | `execution` | **low** |
| T004 | 0.3.29 | [#10787](https://github.com/typeorm/typeorm/pull/10787) | Await the method that applies `setFindOptions` | `query-engine` | **N/A** |
| T005 | 0.3.29 | [#11867](https://github.com/typeorm/typeorm/pull/11867) | Escape JavaScript `Date` parameters correctly in SAP query builder | `sql` | **N/A** |
| T006 | 0.3.29 | [#11936](https://github.com/typeorm/typeorm/pull/11936) | Detect Redis cache version correctly | `extensions` | **N/A** |
| T007 | 0.3.29 | [#12437](https://github.com/typeorm/typeorm/pull/12437), master [#12436](https://github.com/typeorm/typeorm/pull/12436) | Validate mutation `limit()` before SQL rendering | `sql` | **low** |
| T008 | 0.3.30 | [#11878](https://github.com/typeorm/typeorm/pull/11878) | Apply invalid-null/undefined where policy only to high-level abstractions | `validation-types` | **low** |
| T009 | 0.3.30 | [#12288](https://github.com/typeorm/typeorm/pull/12288) | Scope MSSQL computed-column catalog join to the correct table | `migrations` | **N/A** |
| T010 | 0.3.30 | [#12354](https://github.com/typeorm/typeorm/pull/12354), [issue #12234](https://github.com/typeorm/typeorm/issues/12234) | Preserve explicit scalar columns shared with a relation join column | `query-engine` | **low** |
| T011 | 0.3.30 | [#12420](https://github.com/typeorm/typeorm/pull/12420), [issue #11800](https://github.com/typeorm/typeorm/issues/11800) | Type and execute JSON containment with array operands | `validation-types` | **low** |
| T012 | 0.3.30 | [#12413](https://github.com/typeorm/typeorm/pull/12413) | Load CockroachDB table columns through the correct catalog join | `migrations` | **N/A** |
| T013 | 1.0.0 | [#11669](https://github.com/typeorm/typeorm/pull/11669), [issue #11662](https://github.com/typeorm/typeorm/issues/11662) | Include joined-entity PKs in pagination identity subquery | `query-engine` | **low** |
| T014 | 1.0.0 | [#11861](https://github.com/typeorm/typeorm/pull/11861) | Preserve structured results during CockroachDB transaction retry replay | `results` | **N/A** |
| T015 | 1.0.0 | [#11672](https://github.com/typeorm/typeorm/pull/11672), [issue #10858](https://github.com/typeorm/typeorm/issues/10858) | Do not create the migrations tracking table when only checking pending migrations | `migrations` | **low** |
| T016 | 1.0.0 | [#10873](https://github.com/typeorm/typeorm/pull/10873) | Copy Cordova affected-row count into query result | `results` | **N/A** |
| T017 | 1.0.0 | [#10744](https://github.com/typeorm/typeorm/pull/10744) | Resolve generated name before dropping a nameless FK | `migrations` | **low** |
| T018 | 1.0.0 | [#11000](https://github.com/typeorm/typeorm/pull/11000) | Handle virtual properties in schema builder | `migrations` | **N/A** |
| T019 | 1.0.0 | [#10940](https://github.com/typeorm/typeorm/pull/10940) | Hydrate nested document arrays in MongoDB | `results` | **N/A** |
| T020 | 1.0.0 | [#11248](https://github.com/typeorm/typeorm/pull/11248) | Replace a `process` import that broke some runtimes | `execution` | **low** |
| T021 | 1.0.0 | [#10993](https://github.com/typeorm/typeorm/pull/10993), [issue #10991](https://github.com/typeorm/typeorm/issues/10991) | Introspect PostgreSQL table names containing quotes safely | `migrations` | **low** |
| T022 | 1.0.0 | [#11837](https://github.com/typeorm/typeorm/pull/11837) | Recognize PolarDB-X version response | `execution` | **N/A** |
| T023 | 1.0.0 | [#11902](https://github.com/typeorm/typeorm/pull/11902) | Preserve requested select-column order in raw generated SQL | `sql` | **low** |
| T024 | 1.0.0 | [#10844](https://github.com/typeorm/typeorm/pull/10844) | Update closure-tree child's materialized path | `query-engine` | **N/A** |
| T025 | 1.0.0 | [#11154](https://github.com/typeorm/typeorm/pull/11154) | Preserve explicit `null` while merging an entity | `query-engine` | **N/A** |
| T026 | 1.0.0 | [#11857](https://github.com/typeorm/typeorm/pull/11857) | Re-save PostgreSQL geometric values without false changes | `results` | **N/A** |
| T027 | 1.0.0 | [#11865](https://github.com/typeorm/typeorm/pull/11865), [issue #6326](https://github.com/typeorm/typeorm/issues/6326) | Serialize SQLite enum arrays correctly | `migrations` | **confirmed backlog 2** |
| T028 | 1.0.0 | [#10990](https://github.com/typeorm/typeorm/pull/10990) | Compare map-shaped values correctly during change detection | `query-engine` | **N/A** |
| T029 | 1.0.0 | [#11915](https://github.com/typeorm/typeorm/pull/11915) | Generate upsert SQL correctly with table inheritance/custom schema aliasing | `sql` | **N/A** |
| T030 | 1.0.0 | [#11119](https://github.com/typeorm/typeorm/pull/11119) | Let to-many property paths pass without a false error | `query-engine` | **N/A** |
| T031 | 1.0.0 | [#11343](https://github.com/typeorm/typeorm/pull/11343), [issue #9420](https://github.com/typeorm/typeorm/issues/9420) | Avoid metadata lookup failure for raw order subquery aliases | `query-engine` | **N/A** |
| T032 | 1.0.0 | [#10705](https://github.com/typeorm/typeorm/pull/10705) | Do not soft-delete rows already soft-deleted | `query-engine` | **N/A** |
| T033 | 1.0.0 | [#11228](https://github.com/typeorm/typeorm/pull/11228) | Build relation-ID loader aliases through driver rules | `results` | **N/A** |
| T034 | 1.0.0 | [#11218](https://github.com/typeorm/typeorm/pull/11218) | Preserve join attributes inside bracketed query expressions | `query-engine` | **N/A** |
| T035 | 1.0.0 | [#11283](https://github.com/typeorm/typeorm/pull/11283) | Shorten camelCase aliases correctly | `sql` | **low** |
| T036 | 1.0.0 | [#11904](https://github.com/typeorm/typeorm/pull/11904) | Resolve database column names passed to `addOrderBy` | `query-engine` | **N/A** |
| T037 | 1.0.0 | [#11942](https://github.com/typeorm/typeorm/pull/11942) | Load relation IDs inside nested embedded entities | `results` | **N/A** |
| T038 | 1.0.0 | [#11943](https://github.com/typeorm/typeorm/pull/11943) | Use a subquery for join-map-one methods | `query-engine` | **N/A** |
| T039 | 1.0.0 | [#11944](https://github.com/typeorm/typeorm/pull/11944) | Prevent `select: false` columns from leaking into results | `results` | **low** |
| T040 | 1.0.0 | [#11774](https://github.com/typeorm/typeorm/pull/11774) | Persist/hydrate PostgreSQL `timestamptz` correctly | `results` | **low** |
| T041 | 1.0.0 | [#11947](https://github.com/typeorm/typeorm/pull/11947) | Let CLI init tolerate absent `package.json` | `execution` | **N/A** |
| T042 | 1.0.0 | [#11987](https://github.com/typeorm/typeorm/pull/11987), [issue #3967](https://github.com/typeorm/typeorm/issues/3967) | Repair limit with joins | `query-engine` | **reverted** |
| T043 | 1.0.0 | [#11975](https://github.com/typeorm/typeorm/pull/11975) | Save entities with eagerly loaded relations correctly | `query-engine` | **N/A** |
| T044 | 1.0.0 | [#11993](https://github.com/typeorm/typeorm/pull/11993), [issue #11629](https://github.com/typeorm/typeorm/issues/11629) | Generate `.update()` query correctly for UUID criteria | `query-engine` | **low** |
| T045 | 1.0.0 | [#11925](https://github.com/typeorm/typeorm/pull/11925), [issue #11213](https://github.com/typeorm/typeorm/issues/11213) | Remove entity default order from aggregate queries | `query-engine` | **N/A** |
| T046 | 1.0.0 | [#11991](https://github.com/typeorm/typeorm/pull/11991) | Do not join eager relations twice when explicitly requested | `query-engine` | **N/A** |
| T047 | 1.0.0 | [#11963](https://github.com/typeorm/typeorm/pull/11963) | Detect changes correctly with date transformers | `query-engine` | **N/A** |
| T048 | 1.0.0 | [#12027](https://github.com/typeorm/typeorm/pull/12027), [issue #12024](https://github.com/typeorm/typeorm/issues/12024) | Escape select alias used by `ORDER BY` | `sql` | **low** |
| T049 | 1.0.0 | [#12044](https://github.com/typeorm/typeorm/pull/12044) | Use type-only imports/exports to avoid runtime module problems | `execution` | **N/A** |
| T050 | 1.0.0 | [#12081](https://github.com/typeorm/typeorm/pull/12081) | Fix documentation code style | `validation-types` | **N/A** |
| T051 | 1.0.0 | [#12105](https://github.com/typeorm/typeorm/pull/12105) | Execute PostgreSQL queries sequentially after pg 8.19 deprecation | `execution` | **low** |
| T052 | 1.0.0 | [#12185](https://github.com/typeorm/typeorm/pull/12185) | Parameterize PostgreSQL/Cockroach `clearDatabase` catalog reads | `migrations` | **low** |
| T053 | 1.0.0 | [#12030](https://github.com/typeorm/typeorm/pull/12030), [issue #10889](https://github.com/typeorm/typeorm/issues/10889) | Exclude non-updatable and generated columns from upsert overwrite set | `query-engine` | **N/A** |
| T054 | 1.0.0 | [#11172](https://github.com/typeorm/typeorm/pull/11172), [issue #10397](https://github.com/typeorm/typeorm/issues/10397) | Apply value transformers inside find operators | `validation-types` | **N/A** |
| T055 | 1.0.0 | [#12200](https://github.com/typeorm/typeorm/pull/12200) | Translate MongoDB ObjectId property name to `_id` | `query-engine` | **N/A** |
| T056 | 1.0.0 | [#12197](https://github.com/typeorm/typeorm/pull/12197) | Parameterize catalog queries across all query runners | `migrations` | **low** |
| T057 | 1.0.0 | [#11066](https://github.com/typeorm/typeorm/pull/11066), [issue #9936](https://github.com/typeorm/typeorm/issues/9936) | Avoid aliases colliding in self-relation query loading | `query-engine` | **low** |
| T058 | 1.0.0 | [#12207](https://github.com/typeorm/typeorm/pull/12207) | Parameterize catalog values and escape DDL identifiers across query runners | `sql` | **low** |
| T059 | 1.0.0 | [#12110](https://github.com/typeorm/typeorm/pull/12110) | Propagate schema/database to closure junction tables | `migrations` | **N/A** |
| T060 | 1.0.0 | [#11326](https://github.com/typeorm/typeorm/pull/11326) | Correct eager relation query-load strategy | `query-engine` | **N/A** |
| T061 | 1.0.0 | [#12217](https://github.com/typeorm/typeorm/pull/12217), [GHSA-9ggv-8w38-r7pm](https://github.com/advisories/GHSA-9ggv-8w38-r7pm) | Validate `orderBy` direction/null placement at runtime; this is the advisory's SQL-injection correction | `validation-types` | **low** |
| T062 | 1.0.0 | [#12231](https://github.com/typeorm/typeorm/pull/12231) | Assign MSSQL isolation options correctly while creating pool | `execution` | **N/A** |
| T063 | 1.0.0 | [#12256](https://github.com/typeorm/typeorm/pull/12256) | Follow-up eager relation load strategy corrections | `query-engine` | **N/A** |
| T064 | 1.0.0 | [#12281](https://github.com/typeorm/typeorm/pull/12281) | Keep CLI init dev dependencies in published package | `execution` | **N/A** |
| T065 | 1.0.0 | [#11982](https://github.com/typeorm/typeorm/pull/11982), [issue #3105](https://github.com/typeorm/typeorm/issues/3105) | Handle non-null FK when orphan nullification would violate constraint | `schema-relations` | **N/A** |
| T066 | 1.0.0 | [#12292](https://github.com/typeorm/typeorm/pull/12292) | Exclude declaration files from codemod build | `execution` | **N/A** |
| T067 | 1.0.0 | [#12289](https://github.com/typeorm/typeorm/pull/12289) | Replace hardcoded closure-table test identifiers | `schema-relations` | **N/A** |
| T068 | 1.0.0 | [#12209](https://github.com/typeorm/typeorm/pull/12209) | Reject semicolons in raw SQL expression methods | `sql` | **reverted** |
| T069 | 1.0.0 | [#12287](https://github.com/typeorm/typeorm/pull/12287) | Propagate `withDeleted` to relation-ID loader during recover cascade | `query-engine` | **N/A** |
| T070 | 1.0.0 | [#11924](https://github.com/typeorm/typeorm/pull/11924) | Preserve `deferrable` metadata on many-to-many relations | `schema-relations` | **N/A** |
| T071 | 1.0.0 | [#11296](https://github.com/typeorm/typeorm/pull/11296) | Type `queryBuilder.update` entity input correctly | `validation-types` | **N/A** |
| T072 | 1.0.0 | [#12324](https://github.com/typeorm/typeorm/pull/12324) | Clean schema-builder test entities | `migrations` | **N/A** |
| T073 | 1.0.0 | [#12286](https://github.com/typeorm/typeorm/pull/12286) | Cascade-remove one-to-many children with composite PKs | `schema-relations` | **N/A** |
| T074 | 1.0.0 | [#12280](https://github.com/typeorm/typeorm/pull/12280), [issue #1500](https://github.com/typeorm/typeorm/issues/1500) | Reorder composite FK references to target PK index order | `migrations` | **confirmed backlog 3** |
| T075 | 1.0.0 | [#12047](https://github.com/typeorm/typeorm/pull/12047) | Normalize whitespace in logged query | `extensions` | **N/A** |
| T076 | 1.0.0 | [#12372](https://github.com/typeorm/typeorm/pull/12372) | Scope v1 codemod transforms and skip declarations | `execution` | **N/A** |
| T077 | 1.0.0 | [#12377](https://github.com/typeorm/typeorm/pull/12377) | Handle aliases, quoted keys, and property variants in codemod | `execution` | **N/A** |
| T078 | 1.0.0 | [#12383](https://github.com/typeorm/typeorm/pull/12383) | Rename `.connection` metadata properties in codemod | `execution` | **N/A** |
| T079 | 1.0.0 | [#12385](https://github.com/typeorm/typeorm/pull/12385) | Track DataSource accessor chains in codemod | `execution` | **N/A** |
| T080 | 1.0.0 | [#12379](https://github.com/typeorm/typeorm/pull/12379) | Handle `typeof` type queries consistently in codemod | `validation-types` | **N/A** |
| T081 | 1.0.0 | [#12382](https://github.com/typeorm/typeorm/pull/12382) | Recognize TypeORM deep-path imports in codemod | `execution` | **N/A** |
| T082 | 1.0.0 | [#12386](https://github.com/typeorm/typeorm/pull/12386) | Do not run npm install from migration tooling | `execution` | **N/A** |
| T083 | 1.0.0 | [#12353](https://github.com/typeorm/typeorm/pull/12353) | Rewrite lock option objects correctly in codemod | `validation-types` | **N/A** |
| T084 | 1.0.0 | [#12374](https://github.com/typeorm/typeorm/pull/12374) | Correct relation-count migration guidance in codemod | `schema-relations` | **N/A** |
| T085 | 1.0.0 | [#12373](https://github.com/typeorm/typeorm/pull/12373) | Rewrite TypeORM re-exports in barrel files | `execution` | **N/A** |
| T086 | 1.0.0 | [#12363](https://github.com/typeorm/typeorm/pull/12363) | Auto-load Expo SQLite driver dependencies | `execution` | **N/A** |
| T087 | 1.0.0 | [#12391](https://github.com/typeorm/typeorm/pull/12391) | Make codemod scope/idempotency/import stripping safe | `execution` | **N/A** |
| T088 | 1.0.0 | [#12394](https://github.com/typeorm/typeorm/pull/12394) | Harden codemod type-name detection across AST shapes | `validation-types` | **N/A** |
| T089 | 1.0.0 | [#12398](https://github.com/typeorm/typeorm/pull/12398) | Rewrite destructuring/DI accessors safely in codemod | `execution` | **N/A** |
| T090 | 1.0.0 | [#12399](https://github.com/typeorm/typeorm/pull/12399) | Apply find-options rewrites to `.exists()` in codemod | `validation-types` | **N/A** |
| T091 | 1.0.0 | [#12404](https://github.com/typeorm/typeorm/pull/12404) | Read PostgreSQL enum values in declaration order | `migrations` | **low** |
| T092 | 1.0.0 | [#12056](https://github.com/typeorm/typeorm/pull/12056) | Preserve query stack trace | `execution` | **N/A** |
| T093 | 1.0.0 | [#12400](https://github.com/typeorm/typeorm/pull/12400) | Rewrite `ColumnMetadata.args.options` in codemod | `validation-types` | **N/A** |
| T094 | 1.0.0 | [#12421](https://github.com/typeorm/typeorm/pull/12421) | Execute remaining PostgreSQL relation-load/persistence paths sequentially | `execution` | **low** |
| T095 | 1.0.0 | [#12438](https://github.com/typeorm/typeorm/pull/12438) | Use local package reference in playground to avoid false alerts | `execution` | **N/A** |
| T096 | 1.0.0 | [#12344](https://github.com/typeorm/typeorm/pull/12344) | Treat MySQL index hints as identifiers, not raw SQL | `sql` | **N/A** |
| T097 | 0.3.31 / 1.1.0 | [#12545](https://github.com/typeorm/typeorm/pull/12545) | Release internally-created cache query runner when cache storage fails | `execution` | **low** |
| T098 | 0.3.31 / 1.1.0 | [#12554](https://github.com/typeorm/typeorm/pull/12554) | Correct connection error grammar | `execution` | **N/A** |
| T099 | 0.3.31 / 1.1.0 | [#12690](https://github.com/typeorm/typeorm/pull/12690), [issue #12578](https://github.com/typeorm/typeorm/issues/12578) | Default invalid where values to throw on write paths | `validation-types` | **low** |
| T100 | 0.3.31 / 1.1.0 | [#12692](https://github.com/typeorm/typeorm/pull/12692) | Validate where criteria in increment/decrement to prevent unfiltered mutation | `validation-types` | **low** |
| T101 | 0.3.31 / 1.1.0 | [#11926](https://github.com/typeorm/typeorm/pull/11926) | Transform Mongo cursor results consistently and avoid duplicate load broadcast | `results` | **N/A** |
| T102 | 0.3.31 / 1.1.0 | [#12648](https://github.com/typeorm/typeorm/pull/12648) | Move hashing behind platform abstraction | `execution` | **N/A** |
| T103 | 0.3.31 / 1.1.0 | [#12490](https://github.com/typeorm/typeorm/pull/12490) | Correct several recursive CTE construction problems | `query-engine` | **N/A** |
| T104 | 0.3.31 / 1.1.0 | [#12577](https://github.com/typeorm/typeorm/pull/12577), [issue #12574](https://github.com/typeorm/typeorm/issues/12574) | Do not recursively normalize Buffer/bigint values or break OR-array where input | `validation-types` | **low** |
| T105 | 0.3.31 / 1.1.0 | [#12501](https://github.com/typeorm/typeorm/pull/12501) | Preserve `select: false` fields on in-memory entity after save | `results` | **N/A** |
| T106 | 0.3.31 / 1.1.0 | [#12182](https://github.com/typeorm/typeorm/pull/12182) | Normalize PostgreSQL `tstzrange` datetime function correctly | `sql` | **N/A** |
| T107 | 0.3.31 / 1.1.0 | [#12629](https://github.com/typeorm/typeorm/pull/12629), [issue #12578](https://github.com/typeorm/typeorm/issues/12578) | Reject update/delete criteria that normalize to no predicate | `validation-types` | **low** |
| T108 | 0.3.31 / 1.1.0 | [#11137](https://github.com/typeorm/typeorm/pull/11137), [issue #3080](https://github.com/typeorm/typeorm/issues/3080) | Nest inner joins beneath their nullable left-join parent | `query-engine` | **N/A** |
| T109 | 0.3.31 / 1.1.0 | [#12647](https://github.com/typeorm/typeorm/pull/12647) | Remove CommonJS `require()` calls that break bundlers | `execution` | **low** |
| T110 | 0.3.31 / 1.1.0 | [#12590](https://github.com/typeorm/typeorm/pull/12590) | Propagate tree-entity schema through TreeRepository internals | `schema-relations` | **N/A** |

### A.3 Drizzle ORM carried ledger (43 raw rows; 41 normalized families)

Release bodies do not consistently attribute pull requests. The table preserves the linked issue when supplied and says when no PR was linked. The current Migration V1 C2 result supersedes the obsolete static plan against removed files.

| ID | Release | Normalized correction / source | Owner | Sourced impact | Audit result |
|---|---|---|---|---|---|
| D001 | v1.0.0-rc.1 | PostgreSQL JSONB string primitives were parsed twice and changed type (`"10.5"` became `10.5`); [#3018](https://github.com/drizzle-team/drizzle-orm/issues/3018), historical linked [PR #3032](https://github.com/drizzle-team/drizzle-orm/pull/3032) but no rc.1 PR attribution | results | — | **low** |
| D002 | v1.0.0-rc.1 | Timezone-aware PostgreSQL timestamps returned the wrong offset/wall clock under Bun SQL; [#5090](https://github.com/drizzle-team/drizzle-orm/issues/5090), no PR linked | results | — | **not affected (Bun 1.4.0 path)** |
| D003 | v1.0.0-rc.1 | Bun SQL PostgreSQL JSONB insert/update stored JSON arrays/objects as JSON strings; [#5287](https://github.com/drizzle-team/drizzle-orm/issues/5287), no PR linked | sql | — | **confirmed backlog 1** |
| D004 | v1.0.0-rc.1 | Neon HTTP `bytea` values were corrupted; no issue or PR linked | execution | **data-loss** | **unverified (hosted Neon)** |
| D005 | v1.0.0-rc.1 | Bun SQL PostgreSQL timestamp timezone information was truncated; no issue or PR linked | results | — | **not affected (Bun 1.4.0 path)** |
| D006 | v1.0.0-rc.1 | Bun SQL PostgreSQL JSON/JSONB values were double-stringified; no separate issue or PR linked | sql | — | **confirmed backlog 1** |
| D007 | v1.0.0-rc.1 | View joins generated an `undefined` selected column; [#5112](https://github.com/drizzle-team/drizzle-orm/issues/5112), no PR linked | sql | — | **N/A** |
| D008 | v1.0.0-rc.1 | Configured casing was not applied to raw `excluded.<column>` references; [#5282](https://github.com/drizzle-team/drizzle-orm/issues/5282), no PR linked | sql | — | **N/A** |
| D009 | v1.0.0-rc.1 | PostgreSQL view DDL mixed snake-case tables with camel-case selected columns; [#4181](https://github.com/drizzle-team/drizzle-orm/issues/4181), no PR linked | migrations | — | **N/A** |
| D010 | v1.0.0-rc.1 | Casing cache collided when two dynamic tables shared a physical name, rendering a later column as `undefined`; [#4209](https://github.com/drizzle-team/drizzle-orm/issues/4209), no PR linked | sql | — | **N/A** |
| D011 | v1.0.0-rc.2 | A custom PostGIS `geometry(Polygon, …)` column auto-selected a point-only decoder and threw on every read; [#5711](https://github.com/drizzle-team/drizzle-orm/issues/5711), no PR linked | results | — | **N/A** |
| D012 | v1.0.0-rc.2 | PostgreSQL `.transaction` became an instance property, breaking prototype inspection/extension; [#5709](https://github.com/drizzle-team/drizzle-orm/issues/5709), no PR linked | validation-types | — | **N/A** |
| D013 | v1.0.0-rc.2 | AWS Data API codec/input-parameter mapping was corrected; no issue or PR linked | execution | — | **N/A** |
| D014 | v1.0.0-rc.2 | SQLite migration generation now detects incompatible branches created from one parent | migrations | — | **not affected (current Migration V1)** |
| D015 | v1.0.0-rc.2 | SQLite migration snapshots now retain/merge all open leaves instead of collapsing history to one latest parent | migrations | — | **not affected (current Migration V1)** |
| D016 | v1.0.0-rc.2 | Query and rollback error constructors now set a stable `name` for `instanceof`/diagnostics | execution | — | **low** |
| D017 | v1.0.0-rc.2 | AWS Data API errors now surface the database message instead of hiding it | execution | — | **N/A** |
| D018 | v1.0.0-rc.3 | Iteration falls back to ordinary queries when a driver cannot stream, instead of throwing | execution | — | **N/A** |
| D019 | v1.0.0-rc.3 | MySQL proxy writes now use dedicated `lastInsertId` and `affectedRows` response fields | execution | — | **N/A** |
| D020 | v1.0.0-rc.4 | A view selected from a subquery produced broken public types; no issue or PR linked | validation-types | — | **N/A** |
| D021 | v1.0.0-rc.4 | A custom type's JSON decoder was ignored when used to decode an SQL field; no issue or PR linked | results | — | **N/A** |
| D022 | v1.0.0-rc.4 | Aggregate/SQL `.mapWith(column)` skipped the column codec, so `max(timestamp)` was typed `Date` but returned `string`; [#5724](https://github.com/drizzle-team/drizzle-orm/issues/5724), no PR linked | results | — | **low** |
| D023 | v1.0.0-rc.4 | Subquery-selected fields lost their column codecs; no issue or PR linked | results | — | **low** |
| D024 | v1.0.0-rc.4 | rc.3 Bun SQL PostgreSQL core `db.select()` executed an empty projection even though `toSQL()` was correct; [#5779](https://github.com/drizzle-team/drizzle-orm/issues/5779), no PR linked | execution | — | **low** |
| D025 | v1.0.0-rc.4 | SQLite `$count` lacked a synchronous executor for sync drivers; no issue or PR linked | execution | — | **N/A** |
| D026 | v1.0.0-rc.4 | Some SQLite query errors escaped without `DrizzleQueryError`; batch excluded | execution | — | **low** |
| D027 | v1.0.0-rc.4 | `CockroachArrayBuilder` exposed an internal field type and caused a TypeScript error | validation-types | — | **N/A** |
| D028 | v1.0.0-rc.4 | Bun SQLite `.run()` had the wrong public result type | validation-types | — | **low** |
| D029 | v1.0.0-rc.4 | Query-builder `.comment(sqlCommenterComment)` lacked a string overload | validation-types | — | **N/A** |
| D030 | v1.0.0-rc.4 | Turso database/database-wasm drivers gained working nested transactions | execution | — | **low** |
| D031 | v1.0.0-rc.4 | SQLite cache reused one entry for different execute methods | extensions | — | **low** |
| D032 | v1.0.0-rc.4 | MySQL `float` decoding rounded incorrectly to six digits or double | results | — | **low** |
| D033 | v1.0.0-rc.4 | MySQL cropped the `.000` suffix from `timestamp(3)` | results | — | **low** |
| D034 | v1.0.0-rc.4 | PG/MySQL set operators lost or misapplied codecs after database type coercion | results | — | **N/A** |
| D035 | v1.0.0-rc.4 | `sql.param` passed a `Placeholder` object to an encoder instead of the supplied placeholder value | sql | — | **N/A** |
| D036 | v1.0.0-rc.4 | An unguarded `Buffer` reference crashed Effect Schema in runtimes without `Buffer` | execution | — | **N/A** |
| D037 | v1.0.0-rc.4 | SQLite blob's default runtime mode disagreed with its inferred TypeScript mode; [#1064](https://github.com/drizzle-team/drizzle-orm/issues/1064), no PR linked | validation-types | — | **low** |
| D038 | v1.0.0-rc.4 | Typed SQL `.mapWith()` dropped source nullability; [#571](https://github.com/drizzle-team/drizzle-orm/issues/571), no PR linked | validation-types | — | **N/A** |
| D039 | v1.0.0-rc.4 | PostgreSQL `generatedByDefaultAsIdentity` columns were emitted in inserts when they should be database-produced | query-engine | — | **low** |
| D040 | v1.0.0-rc.4 | `insert … select` wrongly required every table column and exact table order; [#3608](https://github.com/drizzle-team/drizzle-orm/issues/3608), no PR linked | query-engine | — | **N/A** |
| D041 | v1.0.0-rc.4 | Effect SQL PostgreSQL `db.execute` returned a wrapper object instead of the promised raw response | results | — | **N/A** |
| D042 | v1.0.0-rc.4 | PostgreSQL pull failed for non-admin users because introspection processed identity metadata from unrelated schemas; [#5568](https://github.com/drizzle-team/drizzle-orm/issues/5568), no PR linked | migrations | — | **low** |
| D043 | v1.0.0-rc.4 | MSSQL inserts included computed `generatedAlwaysAs` columns and SQL Server rejected them; [#5881](https://github.com/drizzle-team/drizzle-orm/issues/5881), no PR linked | query-engine | — | **N/A** |

### A.4 Carried accounting invariant

The carried appendix preserves **254 source rows**: 101 Prisma, 110 TypeORM, and 43 Drizzle. The two duplicate pairs in Drizzle rc.1 make those 43 rows **41 normalized families**, so the carried canonical count is 101 + 110 + 41 = **252**. Appendix row IDs are contiguous within each upstream and preserve the shorter report's exact row-level provenance.

## Appendix B — Prisma full-year extension ledgers

### B.1 Release corrections before the carried four-month ledger

These 83 raw units normalize to 82 because PY021 and PY027 are the same #28240 correction/backport.

| ID | Release/source | Normalized corrected symptom | Owner / impact | VibORM disposition |
|---|---|---|---|---|
| PY001 | [6.16.1](https://github.com/prisma/orm/releases/tag/6.16.1); [release](https://github.com/prisma/orm/releases/tag/6.16.1) | Rust-free clients in edge runtimes still required stabilized preview flags. | validation-types | **not-applicable**: VibORM has no generated engine/preview-feature gate. |
| PY002 | [6.16.2](https://github.com/prisma/orm/releases/tag/6.16.2); [release](https://github.com/prisma/orm/releases/tag/6.16.2) | Invalid Prisma Postgres URL plus driver-adapter combinations passed config validation. | validation-types | **not-applicable**: Prisma Postgres URL/adapter configuration is not a VibORM surface. |
| PY003 | [6.16.2](https://github.com/prisma/orm/releases/tag/6.16.2); [release](https://github.com/prisma/orm/releases/tag/6.16.2) | Calling Node-only timer.unref() crashed non-Node edge runtimes. | execution | **not-applicable**: No timer/unref query-engine lifecycle exists in current VibORM source. |
| PY004 | [6.16.3](https://github.com/prisma/orm/releases/tag/6.16.3); [orm#28186](https://github.com/prisma/orm/pull/28186) | Generated browser entrypoint omitted JsonNull, DbNull, and AnyNull types. | validation-types | **not-affected**: VibORM exports its runtime sentinels through the single package surface, not generated browser entrypoints. |
| PY005 | [6.16.3](https://github.com/prisma/orm/releases/tag/6.16.3); [prisma-engines#5614](https://github.com/prisma/prisma-engines/pull/5614) | Migrations added the default schema even when it was not declared, breaking reusable multi-tenant migrations. | migrations | **not-affected**: VibORM has one adapter-owned immutable namespace and qualifies every generated persistent object deliberately. |
| PY006 | [6.16.3](https://github.com/prisma/orm/releases/tag/6.16.3); [prisma-engines#5616](https://github.com/prisma/prisma-engines/pull/5616) | findFirst rejected negative take after a regression. | query-engine | **not-affected**: Current pagination normalizes signed take and derives reverse ordering in one owner. |
| PY007 | [6.16.3](https://github.com/prisma/orm/releases/tag/6.16.3); [orm#28134](https://github.com/prisma/orm/pull/28134) | Rust-free Accelerate handled self-signed certificates differently from the query engine. | execution | **not-applicable**: VibORM has no Accelerate transport. |
| PY008 | [6.16.3](https://github.com/prisma/orm/releases/tag/6.16.3); [orm#28177](https://github.com/prisma/orm/pull/28177) | The MariaDB adapter leaked error event listeners. | execution | **not-applicable**: VibORM's MySQL surface uses mysql2, not Prisma's MariaDB adapter. |
| PY009 | [6.17.0](https://github.com/prisma/orm/releases/tag/6.17.0); [orm#28199](https://github.com/prisma/orm/pull/28199) | OpenTelemetry instrumentation rejected otherwise compatible 0.x versions. | extensions | **not-affected**: VibORM dynamically imports the peer and has no equivalent narrow package-range gate. |
| PY010 | [6.17.0](https://github.com/prisma/orm/releases/tag/6.17.0); [orm#28159](https://github.com/prisma/orm/pull/28159) | Agent-driven destructive Prisma commands gained an explicit user-consent checkpoint. | migrations · **data-loss** | **not-applicable**: VibORM has no Prisma/Codex CLI command layer; destructive migration actions already require an explicit caller operation. |
| PY011 | [6.17.0](https://github.com/prisma/orm/releases/tag/6.17.0); [orm#28211](https://github.com/prisma/orm/pull/28211) | MariaDB JSON columns were decoded/handled incorrectly. | results | **low-plausibility**: The exact adapter is absent; current MySQL JSON decoding is schema-owned and does not share the MariaDB adapter path. |
| PY012 | [6.17.0](https://github.com/prisma/orm/releases/tag/6.17.0); [prisma-engines#5629](https://github.com/prisma/prisma-engines/pull/5629) | groupBy aggregates emitted unqualified columns and could fail as ambiguous. | sql | **not-affected**: Current VibORM groupBy resolves every grouped column through identifiers.column(rootAlias, columnName). |
| PY013 | [6.17.1](https://github.com/prisma/orm/releases/tag/6.17.1); [orm#28237](https://github.com/prisma/orm/issues/28237), [prisma-engines#5633](https://github.com/prisma/prisma-engines/pull/5633) | Unsupported fields produced unnecessary or incorrect migration/introspection diffs. | migrations | **not-applicable**: VibORM exposes no Unsupported scalar/schema placeholder. |
| PY014 | [6.18.0](https://github.com/prisma/orm/releases/tag/6.18.0); [orm#28139](https://github.com/prisma/orm/pull/28139) | Generated Bytes types selected the wrong runtime representation for some TypeScript versions. | validation-types | **not-affected**: VibORM has no generated-client compatibility branch and exposes Uint8Array directly. |
| PY015 | [6.19.0](https://github.com/prisma/orm/releases/tag/6.19.0); [prisma-engines#5675](https://github.com/prisma/prisma-engines/pull/5675) | Dropping a model appended the default schema to its migration. | migrations | **not-affected**: Namespace qualification is a single explicit adapter-owned rule in current VibORM. |
| PY016 | [6.19.0](https://github.com/prisma/orm/releases/tag/6.19.0); [prisma-engines#5656](https://github.com/prisma/prisma-engines/pull/5656) | Schema naming conventions for scalar and relation fields diverged. | schema-relations | **low-plausibility**: No concrete shared failure was found; VibORM derives scalar/field/relation names from one model metadata graph. |
| PY017 | [7.0.0](https://github.com/prisma/orm/releases/tag/7.0.0); [orm#28493](https://github.com/prisma/orm/pull/28493) | A WeakRef shim in Cloudflare Workers could leak memory. | execution | **not-applicable**: No WeakRef shim exists in current VibORM source. |
| PY018 | [7.0.1](https://github.com/prisma/orm/releases/tag/7.0.1); [orm#28677](https://github.com/prisma/orm/pull/28677) | Studio internal column names collided with user columns. | results | **not-applicable**: VibORM has no Studio result-grid protocol. |
| PY019 | [7.0.1](https://github.com/prisma/orm/releases/tag/7.0.1); [studio#1363](https://github.com/prisma/studio/issues/1363), [orm#28711](https://github.com/prisma/orm/pull/28711) | Studio issue 1363 was fixed in the bundled Studio update. | results | **not-applicable**: Studio-only correction; outside VibORM's public surface. |
| PY020 | [7.0.1](https://github.com/prisma/orm/releases/tag/7.0.1); [orm#28592](https://github.com/prisma/orm/pull/28592) | CLI production dependencies carried known vulnerabilities. | extensions · **security** | **not-applicable**: Dependency remediation is Prisma CLI-specific; no shared vulnerable component is identified. |
| PY021 | [7.0.1](https://github.com/prisma/orm/releases/tag/7.0.1); [orm#28240](https://github.com/prisma/orm/issues/28240), [prisma-engines#5699](https://github.com/prisma/prisma-engines/pull/5699) | migrate diff regressed to an incorrect exit/result for an empty diff. | migrations | **not-applicable**: VibORM has no migrate-diff CLI exit-code contract. Normalized as `issue:prisma/orm#28240`. |
| PY022 | [7.0.1](https://github.com/prisma/orm/releases/tag/7.0.1); [orm#28690](https://github.com/prisma/orm/pull/28690) | The prisma-client-js generator accidentally omitted CockroachDB support. | validation-types | **not-applicable**: No generated-client provider list exists in VibORM. |
| PY023 | [7.0.1](https://github.com/prisma/orm/releases/tag/7.0.1); [orm#28624](https://github.com/prisma/orm/issues/28624), [orm#28625](https://github.com/prisma/orm/pull/28625) | The bundled better-sqlite3 version inherited an upstream SQLite defect. | execution | **low-plausibility**: VibORM does not bundle better-sqlite3; provider versions remain consumer-owned. |
| PY024 | [7.1.0](https://github.com/prisma/orm/releases/tag/7.1.0); [orm#28735](https://github.com/prisma/orm/pull/28735) | Generated client runtime utility types failed in pnpm monorepos. | validation-types | **not-applicable**: No generated client runtime utility package/layout exists. |
| PY025 | [7.1.0](https://github.com/prisma/orm/releases/tag/7.1.0); [orm#28820](https://github.com/prisma/orm/pull/28820) | Bundling instrumentation could install a duplicate OpenTelemetry API instance. | extensions | **not-affected**: Current VibORM uses a dynamic optional peer import and does not bundle the API. |
| PY026 | [7.1.0](https://github.com/prisma/orm/releases/tag/7.1.0); [orm#28694](https://github.com/prisma/orm/pull/28694) | The env helper rejected interface-based generic configurations. | validation-types | **not-applicable**: No equivalent env helper is public. |
| PY027 | [6.19.1](https://github.com/prisma/orm/releases/tag/6.19.1); [orm#28240](https://github.com/prisma/orm/issues/28240), [prisma-engines#5706](https://github.com/prisma/prisma-engines/pull/5706) | A 6.13.1 migration-diff regression incorrectly reported empty diffs. | migrations | **not-applicable**: Backport of the migrate-diff correction; VibORM has no matching CLI contract. Normalized as `issue:prisma/orm#28240`. |
| PY028 | [7.2.0](https://github.com/prisma/orm/releases/tag/7.2.0); [orm#28846](https://github.com/prisma/orm/pull/28846) | DataMapperError escaped without a user-facing error envelope. | execution | **not-affected**: VibORM driver/provider errors are normalized into public VibORM error classes. |
| PY029 | [7.2.0](https://github.com/prisma/orm/releases/tag/7.2.0); [orm#28849](https://github.com/prisma/orm/pull/28849) | PostgreSQL SQLSTATE 22P02 was not mapped by pg/neon/ppg adapters. | execution | **low-plausibility**: VibORM intentionally leaves invalid-text-representation as QueryError; no public dedicated class promises Prisma's mapping. |
| PY030 | [7.2.0](https://github.com/prisma/orm/releases/tag/7.2.0); [orm#28913](https://github.com/prisma/orm/pull/28913) | Bytes upserts used an obsolete byte-array representation. | execution | **not-affected**: VibORM admits Uint8Array and has no legacy generated byte-array representation. |
| PY031 | [7.2.0](https://github.com/prisma/orm/releases/tag/7.2.0); [orm#28535](https://github.com/prisma/orm/pull/28535) | Line streaming corrupted multibyte UTF-8 characters split across chunks. | execution | **not-applicable**: VibORM does not stream schemas through a byline subprocess decoder. |
| PY032 | [7.2.0](https://github.com/prisma/orm/releases/tag/7.2.0); [orm#28911](https://github.com/prisma/orm/pull/28911) | prisma version --json mixed non-JSON text into stdout. | extensions | **not-applicable**: No VibORM CLI version command exists. |
| PY033 | [7.2.0](https://github.com/prisma/orm/releases/tag/7.2.0); [language-tools#1950](https://github.com/prisma/language-tools/pull/1950) | Language-tools Studio connections failed. | extensions | **not-applicable**: Language-server/Studio correction outside VibORM's shipped surface. |
| PY034 | [6.19.2](https://github.com/prisma/orm/releases/tag/6.19.2); [orm#28934](https://github.com/prisma/orm/pull/28934) | Accelerate failed in edge configurations that did not import @prisma/client/edge. | execution | **not-applicable**: No Accelerate or generated edge entrypoint exists. |
| PY035 | [7.3.0](https://github.com/prisma/orm/releases/tag/7.3.0); [orm#29001](https://github.com/prisma/orm/pull/29001) | A better-sqlite3 upgrade had to be pinned to avoid an upstream SQLite defect. | execution | **not-applicable**: VibORM does not bundle that provider dependency. |
| PY036 | [7.3.0](https://github.com/prisma/orm/releases/tag/7.3.0); [orm#29002](https://github.com/prisma/orm/pull/29002) | Mapped enum behavior regressed from Prisma 6.19 and was reverted. | results | **not-affected**: VibORM resolves enum API values and database column names through its own scalar metadata; no generated @map representation exists. explicit revert. |
| PY037 | [7.3.0](https://github.com/prisma/orm/releases/tag/7.3.0); [prisma-engines#5745](https://github.com/prisma/prisma-engines/pull/5745) | BigInt values lost precision inside JSON relation aggregation. | results · **data-loss** | **not-affected**: Current PostgreSQL selection casts bigint carriers to text before JSON aggregation and the result parser restores bigint. |
| PY038 | [7.4.0](https://github.com/prisma/orm/releases/tag/7.4.0); [prisma-engines#5767](https://github.com/prisma/prisma-engines/pull/5767) | PostgreSQL migration replay wrapped CREATE INDEX CONCURRENTLY in a transaction. | migrations | **not-affected**: Current migration compiler detects CREATE INDEX CONCURRENTLY and classifies stored SQL stepwise. |
| PY039 | [7.4.0](https://github.com/prisma/orm/releases/tag/7.4.0); [prisma-engines#5752](https://github.com/prisma/prisma-engines/pull/5752) | MySQL and CockroachDB BigInt values lost precision in JSON aggregation. | results · **data-loss** | **not-affected**: Current relation carriers select bigint using lossless text/decode policies. |
| PY040 | [7.4.0](https://github.com/prisma/orm/releases/tag/7.4.0); [prisma-engines#5750](https://github.com/prisma/prisma-engines/pull/5750) | Non-ASCII database names failed because connection URLs were not decoded correctly. | execution | **low-plausibility**: VibORM delegates URL parsing to provider clients; no duplicate database-name URL parser was found. |
| PY041 | [7.4.0](https://github.com/prisma/orm/releases/tag/7.4.0); [orm#29155](https://github.com/prisma/orm/pull/29155) | PlanetScale COMMIT failures were silently ignored. | execution · **data-loss** | **not-affected**: Current transaction lifecycle awaits commit and rethrows commit failure after cleanup. |
| PY042 | [7.4.0](https://github.com/prisma/orm/releases/tag/7.4.0); [orm#29141](https://github.com/prisma/orm/pull/29141) | SQL Server commit/rollback operations raced with EREQINPROG. | execution | **not-applicable**: VibORM has no SQL Server driver. |
| PY043 | [7.4.0](https://github.com/prisma/orm/releases/tag/7.4.0); [orm#29158](https://github.com/prisma/orm/pull/29158) | MSSQL connection strings mishandled escaped braces in passwords. | execution | **not-applicable**: No MSSQL driver/connection-string parser exists. |
| PY044 | [7.4.1](https://github.com/prisma/orm/releases/tag/7.4.1); [orm#29184](https://github.com/prisma/orm/pull/29184) | Cursor pagination regressed for parameterized cursor values. | query-engine | **not-affected**: Current cursor values are lowered once through scalarValueLiteral inside a correlated cursor query, with no cached mutable plan. |
| PY045 | [7.4.1](https://github.com/prisma/orm/releases/tag/7.4.1); [orm#29198](https://github.com/prisma/orm/pull/29198) | Request-extension argument cloning lost the Prisma.skip sentinel. | extensions | **not-applicable**: No Prisma.skip sentinel exists; request transforms operate on VibORM's own validated envelope. |
| PY046 | [7.4.1](https://github.com/prisma/orm/releases/tag/7.4.1); [orm#25571](https://github.com/prisma/orm/pull/25571) | Multiple queries inside an interactive transaction were not batched correctly. | execution | **not-affected**: VibORM's callback transaction binds one TransactionBoundDriver and executes its statements through that provider state. |
| PY047 | [7.4.1](https://github.com/prisma/orm/releases/tag/7.4.1); [orm#29182](https://github.com/prisma/orm/pull/29182) | JSONB parameter fields omitted JSON deserialization. | results | **not-affected**: JSON result materialization is schema-owned and parses provider JSON strings before returning values. |
| PY048 | [7.4.1](https://github.com/prisma/orm/releases/tag/7.4.1); [orm#29218](https://github.com/prisma/orm/pull/29218) | Result extensions failed for nested and fluent relation results. | extensions | **not-applicable**: VibORM's six-capability chain has no Prisma computed-result extension surface. |
| PY049 | [7.4.1](https://github.com/prisma/orm/releases/tag/7.4.1); [prisma-engines#5777](https://github.com/prisma/prisma-engines/pull/5777) | Datasource URL validation ran even when the command did not need a connection. | validation-types | **not-applicable**: No schema datasource URL/config command pipeline exists. |
| PY050 | [7.4.1](https://github.com/prisma/orm/releases/tag/7.4.1); [orm#29192](https://github.com/prisma/orm/pull/29192) | Nullable columns crashed ppg type parsers on null. | results | **not-applicable**: No Prisma Postgres ppg adapter; VibORM result parsing handles null before scalar decoding. |
| PY051 | [7.4.2](https://github.com/prisma/orm/releases/tag/7.4.2); [orm#29243](https://github.com/prisma/orm/pull/29243) | Case-insensitive IN and NOT IN filtering regressed. | query-engine | **not-affected**: Current VibORM expands insensitive in/notIn into folded equality/inequality expressions for every member. |
| PY052 | [7.4.2](https://github.com/prisma/orm/releases/tag/7.4.2); [orm#29262](https://github.com/prisma/orm/pull/29262) | Mutating a cached query plan broke cursor queries. | query-engine | **not-affected**: VibORM builds a fresh immutable SQL plan per pending operation and has no equivalent query-plan cache. |
| PY053 | [7.4.2](https://github.com/prisma/orm/releases/tag/7.4.2); [prisma-engines#5784](https://github.com/prisma/prisma-engines/pull/5784) | Push operations wrapped array parameters incorrectly. | sql | **affected, fixed in closure**: PostgreSQL `push`/`unshift` built a per-member SQL tree instead of crossing one provider list. They now lower the complete value once through the field's adapter-owned whole-list container representation. |
| PY054 | [7.4.2](https://github.com/prisma/orm/releases/tag/7.4.2); [orm#29268](https://github.com/prisma/orm/pull/29268) | Nested JSON fields failed to serialize Uint8Array values. | results | **not-applicable**: VibORM's JSON domain excludes typed-array instances rather than promising their JSON serialization. |
| PY055 | [7.4.2](https://github.com/prisma/orm/releases/tag/7.4.2); [orm#29251](https://github.com/prisma/orm/pull/29251) | MySQL relation joins relied on non-strict equality. | sql | **not-affected**: VibORM relation joins use SQL equality over typed/scalar-lowered operands; no JavaScript loose-equality branch exists. |
| PY056 | [7.4.2](https://github.com/prisma/orm/releases/tag/7.4.2); [orm#29238](https://github.com/prisma/orm/pull/29238) | MariaDB text-column detection ignored binary collation. | results | **not-applicable**: No MariaDB adapter metadata detector exists. |
| PY057 | [7.4.2](https://github.com/prisma/orm/releases/tag/7.4.2); [orm#29246](https://github.com/prisma/orm/pull/29246) | MariaDB 8.x relationJoins compatibility detection was incorrect. | validation-types | **not-applicable**: No relationJoins preview/version detector exists. |
| PY058 | [7.4.2](https://github.com/prisma/orm/releases/tag/7.4.2); [prisma-engines#5780](https://github.com/prisma/prisma-engines/pull/5780) | PostgreSQL/MSSQL partial-index predicates compared unequal after harmless reformatting. | migrations | **not-affected**: Current PostgreSQL migration differ canonicalizes changed predicates through the live database; SQLite preserves stored SQL; MySQL refuses partial indexes. |
| PY059 | [7.5.0](https://github.com/prisma/orm/releases/tag/7.5.0); [orm#29285](https://github.com/prisma/orm/pull/29285) | MariaDB binary protocol converted numbers lossily. | results · **data-loss** | **not-applicable**: No Prisma MariaDB adapter; VibORM's mysql2 decimal/bigint paths have explicit lossless policies. |
| PY060 | [7.5.0](https://github.com/prisma/orm/releases/tag/7.5.0); [orm#29277](https://github.com/prisma/orm/pull/29277) | adapter-pg omitted its public @types/pg dependency. | validation-types | **not-applicable**: Package-layout correction specific to Prisma's adapter package. |
| PY061 | [7.5.0](https://github.com/prisma/orm/releases/tag/7.5.0); [orm#29286](https://github.com/prisma/orm/pull/29286) | DbNull serialized as an empty object in some bundled environments. | results | **not-affected**: VibORM sentinels are runtime branded objects interpreted before JSON serialization; there is no generated cross-bundle class copy. |
| PY062 | [7.5.0](https://github.com/prisma/orm/releases/tag/7.5.0); [orm#29274](https://github.com/prisma/orm/pull/29274) | SQLite unixepoch-ms DateTime values materialized as Invalid Date. | results · **correctness** | **candidate**: Current VibORM declares SQLite DATETIME.INTEGER/REAL public native types but its datetime result parser rejects every numeric provider value. |
| PY063 | [7.5.0](https://github.com/prisma/orm/releases/tag/7.5.0); [orm#29327](https://github.com/prisma/orm/pull/29327) | Cursor pagination was incorrect on @db.Date columns. | query-engine | **not-affected**: VibORM cursor scalar lowering uses the declared date codec and normalized total order; no generated native-type branch exists. |
| PY064 | [7.5.0](https://github.com/prisma/orm/releases/tag/7.5.0); [prisma-engines#5790](https://github.com/prisma/prisma-engines/pull/5790), [prisma-engines#5795](https://github.com/prisma/prisma-engines/pull/5795) | Manual partial indexes were dropped/recreated when the partialIndexes preview was disabled. | migrations | **not-affected**: Partial indexes are a first-class declared/index-introspected shape in current VibORM and no preview gate hides them. |
| PY065 | [7.5.0](https://github.com/prisma/orm/releases/tag/7.5.0); [prisma-engines#5788](https://github.com/prisma/prisma-engines/pull/5788) | Quoted and unquoted partial-index predicates caused needless recreate cycles. | migrations | **not-affected**: PostgreSQL predicates are canonicalized by the live database before diff equality. |
| PY066 | [7.5.0](https://github.com/prisma/orm/releases/tag/7.5.0); [prisma-engines#5792](https://github.com/prisma/prisma-engines/pull/5792) | Partial unique indexes incorrectly became findUnique input fields. | validation-types | **not-affected**: VibORM explicitly excludes partial indexes from unique-selector membership. |
| PY067 | [7.6.0](https://github.com/prisma/orm/releases/tag/7.6.0); [orm#29382](https://github.com/prisma/orm/pull/29382) | createMany query-plan caching caused unbounded cache growth and Node crashes. | query-engine · **performance** | **not-affected**: VibORM does not cache createMany query plans. |
| PY068 | [7.6.0](https://github.com/prisma/orm/releases/tag/7.6.0); [orm#28724](https://github.com/prisma/orm/pull/28724) | NowGenerator eagerly called new Date and triggered Next.js dynamic-usage errors. | query-engine | **not-affected**: VibORM stores now/updatedAt as generatorDefault thunks and evaluates them during the write. |
| PY069 | [7.6.0](https://github.com/prisma/orm/releases/tag/7.6.0); [orm#29346](https://github.com/prisma/orm/pull/29346) | The generated client omitted Get<Model>GroupByPayload. | validation-types | **not-applicable**: No generated client types; VibORM derives groupBy results directly from the public client call. |
| PY070 | [7.6.0](https://github.com/prisma/orm/releases/tag/7.6.0); [orm#29377](https://github.com/prisma/orm/pull/29377) | Schema parsing built intermediate strings beyond V8's 500 MB limit. | validation-types · **performance** | **not-applicable**: No generated textual schema parser/engine subprocess exists. |
| PY071 | [7.6.0](https://github.com/prisma/orm/releases/tag/7.6.0); [orm#29390](https://github.com/prisma/orm/pull/29390) | adapter-pg rejected compatible newer @types/pg releases. | validation-types | **not-applicable**: Prisma package-range correction. |
| PY072 | [7.6.0](https://github.com/prisma/orm/releases/tag/7.6.0); [orm#29307](https://github.com/prisma/orm/pull/29307) | ColumnNotFound parsing failed on quoted or unquoted PostgreSQL identifiers. | execution | **low-plausibility**: VibORM preserves raw provider code/message in QueryError rather than parsing a column into a dedicated public P2022 contract. |
| PY073 | [7.6.0](https://github.com/prisma/orm/releases/tag/7.6.0); [orm#29392](https://github.com/prisma/orm/pull/29392) | MariaDB statement caching leaked resources. | execution · **performance** | **not-applicable**: No MariaDB provider adapter or adapter-owned statement cache exists. |
| PY074 | [6.19.3](https://github.com/prisma/orm/releases/tag/6.19.3); [orm#29416](https://github.com/prisma/orm/pull/29416) | The Effect dependency carried a published security vulnerability. | extensions · **security** | **not-applicable**: VibORM does not depend on Effect; this is a dependency-specific security backport. |
| PY075 | [7.8.0](https://github.com/prisma/orm/releases/tag/7.8.0); [prisma-engines#5804](https://github.com/prisma/prisma-engines/pull/5804) | PostgreSQL JSON-list equals filters could panic and emit an incorrect ::jsonb cast. | sql | **low-plausibility**: VibORM has an analogous JSON-list surface, but emits a provider-native array parameter without Prisma's explicit incorrect ::jsonb cast; no concrete static defect was established. |
| PY076 | [7.8.0](https://github.com/prisma/orm/releases/tag/7.8.0); [prisma-engines#5806](https://github.com/prisma/prisma-engines/pull/5806) | Case-insensitive JSON field filters failed. | query-engine | **not-affected**: VibORM's JSON filter scope explicitly folds both extracted text and operand for string operations. |
| PY077 | [7.8.0](https://github.com/prisma/orm/releases/tag/7.8.0); [orm#29422](https://github.com/prisma/orm/pull/29422) | Enum values with custom database names were parameterized incorrectly. | sql | **not-affected**: VibORM resolves enum values through scalar metadata and lowers parameters against the destination field. |
| PY078 | [7.8.0](https://github.com/prisma/orm/releases/tag/7.8.0); [orm#29422](https://github.com/prisma/orm/pull/29422) | The database bind-parameter limit check could reject legal queries or miss illegal ones. | query-engine | **not-affected**: Current drivers own exact bind limits and write planners split/verify statement fragments against the active driver's budget. |
| PY079 | [7.8.0](https://github.com/prisma/orm/releases/tag/7.8.0); [prisma-engines#5801](https://github.com/prisma/prisma-engines/pull/5801) | SQL Server parameterized values omitted required VARCHAR casts. | sql | **not-applicable**: No SQL Server dialect exists. |
| PY080 | [7.8.0](https://github.com/prisma/orm/releases/tag/7.8.0); [orm#29455](https://github.com/prisma/orm/pull/29455) | migrate diff error text referenced a removed shadow-database flag. | migrations | **not-applicable**: No Prisma CLI flags/error text surface. |
| PY081 | [7.8.0](https://github.com/prisma/orm/releases/tag/7.8.0); [prisma-engines#5799](https://github.com/prisma/prisma-engines/pull/5799) | Shadow migration replay ran CREATE INDEX CONCURRENTLY inside a transaction. | migrations | **not-affected**: Current compiler marks stored CREATE INDEX CONCURRENTLY statements stepwise. |
| PY082 | [7.8.0](https://github.com/prisma/orm/releases/tag/7.8.0); [prisma-engines#5802](https://github.com/prisma/prisma-engines/pull/5802) | PostgreSQL introspection dropped schema-qualified pg_catalog.nextval sequence defaults. | migrations | **not-affected**: Current isAutoIncrement accepts every default containing nextval(, including pg_catalog.nextval. |
| PY083 | [7.8.0](https://github.com/prisma/orm/releases/tag/7.8.0); [orm#29499](https://github.com/prisma/orm/pull/29499) | D1 savepoint methods attempted unsupported SQL rather than no-op behavior. | execution | **not-affected**: VibORM exposes D1 as batch-only, supportsTransactions=false, and refuses callback/nested savepoint transactions before SQL. |

### B.2 Exhaustive current-main correction/revert groups

The 1,353 raw correction/revert commits normalize to 626 source groups below. Every row links to a reachable current `prisma/orm` commit; complete member commits and imported provenance keys are in `/tmp/viborm-prisma-year-audit/correction-groups.json`.

| ID | Date | Reachable primary source | Owner / surface | Release overlap | Disposition | Representative correction |
|---|---:|---|---|---|---|---|
| D001 | 2025-10-12 | [4af8feea](https://github.com/prisma/orm/commit/4af8feea3055fe45749b6295c6c76b0775c9912e) | query-engine / development-fixup | no | inspected; no new concrete candidate | Add missing test infrastructure and flesh out the query builder types and interface |
| D002 | 2025-10-13 | [0d29c1d1](https://github.com/prisma/orm/commit/0d29c1d172b1dc6aa4bb5df369f42d69d6b06201) | extensions / development-fixup | no | inspected; no new concrete candidate | Correct broken tests |
| D003 | 2025-10-13 | [d8aaa037](https://github.com/prisma/orm/commit/d8aaa03732991460b97d2728585b16c69f810512) | validation-types / development-fixup | no | inspected; no new concrete candidate | Correct a bug in the tsup build config |
| D004 | 2025-10-13 | [ad7e3b28](https://github.com/prisma/orm/commit/ad7e3b28c1ea632e970131f46eff89e96b05f527) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix build config |
| D005 | 2025-10-13 | [8afbd4dd](https://github.com/prisma/orm/commit/8afbd4ddde34bdb36cc1cdd377405a7d1f951980) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D006 | 2025-10-13 | [66f61e05](https://github.com/prisma/orm/commit/66f61e051dd842e58af9b660bb4bd777be3c0dca) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct broken references to schema.json -> contract.json |
| D007 | 2025-10-13 | [627772e7](https://github.com/prisma/orm/commit/627772e719829d20c1a805015f35b6b608533c9a) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix errors in example app |
| D008 | 2025-10-13 | [969e15fb](https://github.com/prisma/orm/commit/969e15fb6657d4c24edbbcf9cde746930ab4fa0e) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type inference in select() |
| D009 | 2025-10-13 | [a0fd02c8](https://github.com/prisma/orm/commit/a0fd02c8af42e9a570f73d15b3be9fa6b8d6c59b) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix typo in emitter |
| D010 | 2025-10-13 | [14b395b1](https://github.com/prisma/orm/commit/14b395b16dcf1c914deb0fa43f6ad90220fa0139) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Restore types |
| D011 | 2025-10-13 | [89bc1ee2](https://github.com/prisma/orm/commit/89bc1ee2f7371e80405e3bd2a39db0cdad4aa5ef) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | Restore initial migration |
| D012 | 2025-10-13 | [791e381e](https://github.com/prisma/orm/commit/791e381e114a549a91b099bc284469fcbd07f6ad) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix errors in migration planner |
| D013 | 2025-10-13 | [a92fce16](https://github.com/prisma/orm/commit/a92fce16d63792dba90c7077f9069ef886af8a82) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | FIx type issues |
| D014 | 2025-10-13 | [be589813](https://github.com/prisma/orm/commit/be589813413a48a42a4aa47a7892a8b486069c2b) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix some bugs in the migration system |
| D015 | 2025-10-19 | [3211181b](https://github.com/prisma/orm/commit/3211181b2d9298a401950d07a6c0cada7a4388e5) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | Add missing type relations from models to storage |
| D016 | 2025-10-19 | [8222035f](https://github.com/prisma/orm/commit/8222035f86ea2f705b7d1bc181a47cde1160edf7) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix formatting in subsystem docs 11 and 12 |
| D017 | 2025-10-19 | [4903d52e](https://github.com/prisma/orm/commit/4903d52e233d0c048e95059b9203bc6a98ef6a33) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | Delete stale briefs |
| D018 | 2025-10-19 | [1eeb9428](https://github.com/prisma/orm/commit/1eeb942858954d4b7d9b7d8d4198911485a9b999) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct and refine ADR 007 |
| D019 | 2025-10-28 | [7024c510](https://github.com/prisma/orm/commit/7024c510f60b22255500f4a58ffa89af7f082ddc) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix errors |
| D020 | 2025-10-28 | [b45b09c7](https://github.com/prisma/orm/commit/b45b09c7a941a82d2100d680e730159b2debcfd7) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct errors from Slice A |
| D021 | 2025-10-28 | [39eb135d](https://github.com/prisma/orm/commit/39eb135df279b910ed04dc7e287cfabbda889f5f) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | add missing export |
| D022 | 2025-10-28 | [d57b8bf8](https://github.com/prisma/orm/commit/d57b8bf86f78c5255c1450d957f70d563ef946fa) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix errors in stamp-marker.ts |
| D023 | 2025-10-29 | [22025e34](https://github.com/prisma/orm/commit/22025e3446dbb224b359c7def57f257856eb763b) | extensions / development-fixup | no | inspected; no new concrete candidate | Correct issues with example app |
| D024 | 2025-10-29 | [c39e069e](https://github.com/prisma/orm/commit/c39e069e498610a71489c3d268bd7e81aac56092) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix tsconfig |
| D025 | 2025-10-29 | [ae4f27bb](https://github.com/prisma/orm/commit/ae4f27bbc20034884569085bee4e54801b3deaf8) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix build config |
| D026 | 2025-10-30 | [34af6ef9](https://github.com/prisma/orm/commit/34af6ef98d632f97fed95d3cbeebf02bf487e987) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests in compat-prisma |
| D027 | 2025-10-30 | [fff61a20](https://github.com/prisma/orm/commit/fff61a20d093966e5e47bfde49d60b8004920785) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | Lazy connect client so it doesn't leak into consuming app |
| D028 | 2025-11-03 | [3a04507c](https://github.com/prisma/orm/commit/3a04507c94947382ea534d69cf3598adfc386e7b) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix TypeScript typecheck errors |
| D029 | 2025-11-03 | [e825f19c](https://github.com/prisma/orm/commit/e825f19c7770ff99c570f044e6b7d7686dcfff78) | results / development-fixup | no | inspected; no new concrete candidate | Fix ResultType tests and then fix implementation |
| D030 | 2025-11-04 | [2f4017e5](https://github.com/prisma/orm/commit/2f4017e5e4bd3d31e049cd9510edcb22311ae029) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D031 | 2025-11-04 | [be39e462](https://github.com/prisma/orm/commit/be39e4629c4624490e338d4dcf13a455ce545b55) | results / development-fixup | no | inspected; no new concrete candidate | Fix broken tests and typechecks, update AGENT_ONBOARDING |
| D032 | 2025-11-04 | [e47a2a67](https://github.com/prisma/orm/commit/e47a2a6770c31eb0396c4d5fa3025f9f7289f9c9) | results / development-fixup | no | inspected; no new concrete candidate | Fix broken tests, revert changes to validateContract() and make its purpose clear |
| D033 | 2025-11-05 | [3d69bb6f](https://github.com/prisma/orm/commit/3d69bb6fde83f27c680addd2ec254cdaa0605d67) | results / development-fixup | no | inspected; no new concrete candidate | Fix broken codec type tests |
| D034 | 2025-11-05 | [86714099](https://github.com/prisma/orm/commit/8671409911b6317a0454cc644cb2013e3aaca3aa) | validation-types / development-fixup | no | inspected; no new concrete candidate | Avoid manual type tests |
| D035 | 2025-11-05 | [6dd82e27](https://github.com/prisma/orm/commit/6dd82e27da54767218337d6700875bfc47078522) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix some broken tests |
| D036 | 2025-11-05 | [aeec029c](https://github.com/prisma/orm/commit/aeec029c179530095ba2342d47ef7fe9db70975f) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors, assign different DB ports to avoid collision |
| D037 | 2025-11-05 | [b3567898](https://github.com/prisma/orm/commit/b35678989969963960569a9fb38de82e0b738333) | validation-types / toolchain-outside-viborm | no | inspected; no new concrete candidate | Fix errors in CLI commands |
| D038 | 2025-11-06 | [d8cbf1e6](https://github.com/prisma/orm/commit/d8cbf1e69d1fd86a4e56aa33800b69044966b595) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D039 | 2025-11-06 | [0e736375](https://github.com/prisma/orm/commit/0e7363753387a46762a29f81bb76e59c51a1b3ec) | results / development-fixup | no | inspected; no new concrete candidate | Fix a mistake using validateContract() and update docs |
| D040 | 2025-11-06 | [1db59677](https://github.com/prisma/orm/commit/1db59677d71884b98b9734a0061df4121523caa2) | results / development-fixup | no | inspected; no new concrete candidate | Fix tests using validateContract() incorrectly |
| D041 | 2025-11-06 | [41c2b8c0](https://github.com/prisma/orm/commit/41c2b8c0846e65d6e9ed9010632ae41f2d991576) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix lint errors - mostly in tests |
| D042 | 2025-11-06 | [f49dbfa0](https://github.com/prisma/orm/commit/f49dbfa00245d748512c99e2d3672f5e0a728820) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D043 | 2025-11-06 | [3680f8b1](https://github.com/prisma/orm/commit/3680f8b1451e8c9eeb08d42aaa258adbdd50e939) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix lint errors and tests |
| D044 | 2025-11-06 | [0629906c](https://github.com/prisma/orm/commit/0629906c520b1d593cbdd23002f86581f0b026d5) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix lots more type and lint errors |
| D045 | 2025-11-06 | [2de31fc1](https://github.com/prisma/orm/commit/2de31fc17027db5516e63ab5e7cfbeb8e74c0e6a) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D046 | 2025-11-06 | [7079b501](https://github.com/prisma/orm/commit/7079b501cbd08e0f7af4e151f80ea975d73ac25a) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix lots of tests |
| D047 | 2025-11-06 | [aa4e9a5a](https://github.com/prisma/orm/commit/aa4e9a5a8ef0d42cd3fa4c4869a233e1c08e251b) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D048 | 2025-11-06 | [fa4b2d70](https://github.com/prisma/orm/commit/fa4b2d70a81cd6e2158d30b5fe616bf6d9010b65) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix GH actions config |
| D049 | 2025-11-06 | [04e56dd6](https://github.com/prisma/orm/commit/04e56dd61253104ed947454de995ef1bd1cdf1a4) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix issues in lateral/json agg SQL lowering |
| D050 | 2025-11-07 | [7d4f73f1](https://github.com/prisma/orm/commit/7d4f73f170b48a47aabd24a802ea681d90aec5f1) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix more issues in json agg postgres lowering |
| D051 | 2025-11-07 | [1a3eb5b4](https://github.com/prisma/orm/commit/1a3eb5b4f814e2de116034c79c9c10e15c151aa0) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix Biome config problems |
| D052 | 2025-11-07 | [f196a699](https://github.com/prisma/orm/commit/f196a69918ef7f43275a91d0d8e2acb4661d31cf) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix a lot of type errors |
| D053 | 2025-11-07 | [d1346f56](https://github.com/prisma/orm/commit/d1346f5657acbc0f635a8955578f672507a81b79) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix a lot of type errors |
| D054 | 2025-11-07 | [29fa4861](https://github.com/prisma/orm/commit/29fa4861c7a13ed3b2899d53b34b78dbf6a54584) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix accidentally-committed merge conflicts |
| D055 | 2025-11-07 | [241eb65c](https://github.com/prisma/orm/commit/241eb65c5b6965b02774c5867562edd72f4d77e2) | schema-relations / development-fixup | no | inspected; no new concrete candidate | Fix many lint errors, disable linting contract artifacts |
| D056 | 2025-11-07 | [5db359df](https://github.com/prisma/orm/commit/5db359df939905c1b56807bcf5940c6bdad80e24) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors |
| D057 | 2025-11-07 | [81e325c0](https://github.com/prisma/orm/commit/81e325c010d27baaaf1bdddba10dabb3ef9ef625) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix CI test setup |
| D058 | 2025-11-07 | [4925f879](https://github.com/prisma/orm/commit/4925f8799973539f7ee89a6225fdd98ae1afb9f4) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors |
| D059 | 2025-11-07 | [0d3c13da](https://github.com/prisma/orm/commit/0d3c13da3a72920cb8c3868ae6859a8e959dc133) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D060 | 2025-11-07 | [bc4d220b](https://github.com/prisma/orm/commit/bc4d220b4dfb83cc19da98092406d1a1e52aa75a) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix linter errors and type checks |
| D061 | 2025-11-07 | [d6277687](https://github.com/prisma/orm/commit/d6277687312ef08a71fe7ef9ee11e32065b1d51f) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix errors |
| D062 | 2025-11-07 | [2e147fca](https://github.com/prisma/orm/commit/2e147fca048dd14e2181ecfcd7308d02ad656fbe) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix lint and formatting issues |
| D063 | 2025-11-07 | [bf0a436e](https://github.com/prisma/orm/commit/bf0a436e1cceda1eed77f8c799c378fbf61733e8) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Prevent the agent giving up on type safety |
| D064 | 2025-11-08 | [056e6212](https://github.com/prisma/orm/commit/056e6212c9a3be7dbdc02d78e8136857394d8358) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D065 | 2025-11-08 | [b93509d5](https://github.com/prisma/orm/commit/b93509d538b2f53180e4ed0d0837149176dc696f) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D066 | 2025-11-08 | [5e025538](https://github.com/prisma/orm/commit/5e0255384f740f316bad8cd68f82153af887741d) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix many tests |
| D067 | 2025-11-08 | [87ce4b8f](https://github.com/prisma/orm/commit/87ce4b8f21c590b59bf62eacbafcab4de9e9a537) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors resulting from changes to operations AST |
| D068 | 2025-11-08 | [59bcf6e8](https://github.com/prisma/orm/commit/59bcf6e87440870b8b0b37a1848894647962a865) | results / development-fixup | no | inspected; no new concrete candidate | Fix runtime tests |
| D069 | 2025-11-08 | [0eeca47c](https://github.com/prisma/orm/commit/0eeca47cf0119959ffa4685d97979a840df904c6) | query-engine / development-fixup | no | inspected; no new concrete candidate | Fix all sql-query tests |
| D070 | 2025-11-08 | [8bc5e355](https://github.com/prisma/orm/commit/8bc5e3556229841a0defe69dced862942a8dd4fd) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix lots more tests |
| D071 | 2025-11-08 | [51538a4b](https://github.com/prisma/orm/commit/51538a4bc320165c1b69da15ba33a40944593653) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix loads of broken imports |
| D072 | 2025-11-08 | [233f474b](https://github.com/prisma/orm/commit/233f474b17ac0b967bc9349b5c2cc9c0d519445b) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix problems in runtime context types |
| D073 | 2025-11-08 | [9b648395](https://github.com/prisma/orm/commit/9b6483950270db5169dc73fb0c43641220270259) | schema-relations / development-fixup | no | inspected; no new concrete candidate | Add more missing fields in fixture contracts |
| D074 | 2025-11-08 | [57a2a305](https://github.com/prisma/orm/commit/57a2a3052a51c698c1437269a5dc58be1b4e7ce7) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken adapter tests |
| D075 | 2025-11-08 | [3da6e0bd](https://github.com/prisma/orm/commit/3da6e0bd723defc3c8797528b30e61da614b0354) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | Fix CLI tests |
| D076 | 2025-11-08 | [b443cb34](https://github.com/prisma/orm/commit/b443cb3458d2cf4b1d30f8e87555ca5e9a874c94) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type inference from contract through query lanes |
| D077 | 2025-11-08 | [e15d4668](https://github.com/prisma/orm/commit/e15d466845f371765bfbc301514ad418c92f9bf6) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D078 | 2025-11-08 | [4fd9f02f](https://github.com/prisma/orm/commit/4fd9f02ff17c25f62524bcf3ba30baffae0c81aa) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors |
| D079 | 2025-11-08 | [4d0aa976](https://github.com/prisma/orm/commit/4d0aa9769f778edba5262de488d1d544ce346f0e) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix lots more tests |
| D080 | 2025-11-08 | [caec9b28](https://github.com/prisma/orm/commit/caec9b28df05be2333e20402ca7b96c449ef3993) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix more tests |
| D081 | 2025-11-09 | [0d179c50](https://github.com/prisma/orm/commit/0d179c500ce71966e33777a617dc458ef5139554) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix many more tests and type checks |
| D082 | 2025-11-09 | [1b23057f](https://github.com/prisma/orm/commit/1b23057f9cacfb34414243bae2d4fa09a6c94ea9) | query-engine / development-fixup | no | inspected; no new concrete candidate | Fix broken query lane tests |
| D083 | 2025-11-09 | [c02e9d6f](https://github.com/prisma/orm/commit/c02e9d6f0e5d23d656ce934ac27584eb8a8a3ffe) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix simple typecheck errors |
| D084 | 2025-11-09 | [f525f94d](https://github.com/prisma/orm/commit/f525f94dbb688824a20daa742f2966142068651b) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix test fixtures |
| D085 | 2025-11-09 | [41bcb621](https://github.com/prisma/orm/commit/41bcb621eb4e6c94e76a003c22a331e327a7f2bf) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix errors in demo app |
| D086 | 2025-11-09 | [25128f74](https://github.com/prisma/orm/commit/25128f74f6ce04afbaf36d77cda66f1d522fe014) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix more tests |
| D087 | 2025-11-09 | [616637aa](https://github.com/prisma/orm/commit/616637aad9243e8b10c05bb39a8390188673deb0) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D088 | 2025-11-09 | [7edf9ba0](https://github.com/prisma/orm/commit/7edf9ba08858a8e32640bff2941f978cdbfe1c07) | results / development-fixup | no | inspected; no new concrete candidate | Ensure runtime is destroyed - so tests don't hang |
| D089 | 2025-11-09 | [3b0ffc0f](https://github.com/prisma/orm/commit/3b0ffc0f41ac6b2e7c2a3f44abde302c9046c3ac) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | Prevent closing already-closed connection |
| D090 | 2025-11-09 | [eff11e78](https://github.com/prisma/orm/commit/eff11e785587d176a035933783b4cc06dfc9edd9) | results / development-fixup | no | inspected; no new concrete candidate | Fix timeouts config |
| D091 | 2025-11-09 | [caa53cf2](https://github.com/prisma/orm/commit/caa53cf24162b6764e71856632cad9f94f9688a3) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D092 | 2025-11-09 | [2ddb6476](https://github.com/prisma/orm/commit/2ddb64761f668c9d7ee98c55dae41e9f7f646501) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix type checks and lints |
| D093 | 2025-11-09 | [78f9e8ce](https://github.com/prisma/orm/commit/78f9e8cea82053c1e507f3b4290401feac4c7976) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D094 | 2025-11-09 | [c92d5651](https://github.com/prisma/orm/commit/c92d5651dd7cdedae45aae7285eb16c8efa20091) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Add missing dep |
| D095 | 2025-11-09 | [1eaf30e3](https://github.com/prisma/orm/commit/1eaf30e3e26a8af3033c78cc1c52414f7eada959) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Add missing dependencies |
| D096 | 2025-11-10 | [af48bc98](https://github.com/prisma/orm/commit/af48bc9885a362bead768ef2a12790cb6ddd2f62) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix typechecks |
| D097 | 2025-11-10 | [8d755c70](https://github.com/prisma/orm/commit/8d755c703cee054054dd33a9045e8c875ec2cee0) | extensions / development-fixup | no | inspected; no new concrete candidate | pnpm install and fix broken tests and references |
| D098 | 2025-11-10 | [4a621ed7](https://github.com/prisma/orm/commit/4a621ed783549cdfe07b3bbd90311c71fc6bdbca) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D099 | 2025-11-10 | [3fbd9c80](https://github.com/prisma/orm/commit/3fbd9c80e645d9e02b7ec9861261963d4d875a64) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix lint errors |
| D100 | 2025-11-10 | [04cdc541](https://github.com/prisma/orm/commit/04cdc541dc22a137b163f3bf00f83a7ea7af6d89) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D101 | 2025-11-10 | [74215f28](https://github.com/prisma/orm/commit/74215f2819244a60588a6d9d0ab96522c8358701) | migrations / development-fixup | no | inspected; no new concrete candidate | Fix tests and migrate test/utils |
| D102 | 2025-11-10 | [a5e664ef](https://github.com/prisma/orm/commit/a5e664ef7251fcd6a0e4be71c6f4b67ee31280e6) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix more broken imports in tests |
| D103 | 2025-11-10 | [1917572a](https://github.com/prisma/orm/commit/1917572a27345ef3cd2c3cbdd328395b49ad603e) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix relative paths in tests |
| D104 | 2025-11-10 | [ea33c854](https://github.com/prisma/orm/commit/ea33c854d3baab6ef1b2fa694bb443ccc177f783) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D105 | 2025-11-10 | [3effc21c](https://github.com/prisma/orm/commit/3effc21c92e39148f8e72fb391038f6e2e7f24b5) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix lots of tests and forbid inline imports |
| D106 | 2025-11-10 | [1e4dfb06](https://github.com/prisma/orm/commit/1e4dfb064afd59e770e85952a1486e3a6a2220ee) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix lots more tests and typecheck errors |
| D107 | 2025-11-10 | [e1ff234c](https://github.com/prisma/orm/commit/e1ff234cb6d251ec2115c0b43e96b3f8bb4f3214) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix remaining type errors |
| D108 | 2025-11-10 | [53924183](https://github.com/prisma/orm/commit/53924183cb402786a4df36fd8aafe8e54146de9d) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D109 | 2025-11-10 | [bab86360](https://github.com/prisma/orm/commit/bab8636054cd11a57f1c8d1fdcdf057bd694a442) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix rule files |
| D110 | 2025-11-10 | [e03409b0](https://github.com/prisma/orm/commit/e03409b02b7728be61be97808398a9f459434278) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D111 | 2025-11-10 | [0c37a00c](https://github.com/prisma/orm/commit/0c37a00cfef0156d8980353429fe666bf5ac43cc) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D112 | 2025-11-10 | [64661665](https://github.com/prisma/orm/commit/646616651c0bbc871c2467a9649c2ac6414e9604) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct relative paths |
| D113 | 2025-11-11 | [a26fac6e](https://github.com/prisma/orm/commit/a26fac6ec3c6e2970a7b9e683e6ed7f3ad3610dc) | query-engine / development-fixup | no | inspected; no new concrete candidate | Correct imports, delete obsolete package, remove reexports |
| D114 | 2025-11-11 | [30746cb5](https://github.com/prisma/orm/commit/30746cb5cd7e2e6becd5fcb2377410a4b28d2692) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct cursor rules structure |
| D115 | 2025-11-11 | [8811b4a8](https://github.com/prisma/orm/commit/8811b4a8f98d884c6ba5cb780c4781ac2194cc36) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix incorrect dependency |
| D116 | 2025-11-11 | [09016bc8](https://github.com/prisma/orm/commit/09016bc87bbd0c37a9fab5127b35f8fb8b3b40b4) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix TS config and test |
| D117 | 2025-11-11 | [2f456726](https://github.com/prisma/orm/commit/2f45672618413a187966186f34baf32618a15973) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D118 | 2025-11-11 | [7da0ac8e](https://github.com/prisma/orm/commit/7da0ac8eb19722907742f2154fb64bf9f24e37c9) | validation-types / development-fixup | no | inspected; no new concrete candidate | Rewrote config loading using c12, fixed broken tests |
| D119 | 2025-11-11 | [b5d341ae](https://github.com/prisma/orm/commit/b5d341aed9790be2b423df1c51db4a52d3163539) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix emit command test |
| D120 | 2025-11-11 | [3643328a](https://github.com/prisma/orm/commit/3643328ac6fb780ef109b95f180751778be98d51) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken example apps |
| D121 | 2025-11-11 | [f1453da3](https://github.com/prisma/orm/commit/f1453da34eddce8a0cb4157feadd4de37fa4fa2f) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Add missing deps |
| D122 | 2025-11-12 | [2976787f](https://github.com/prisma/orm/commit/2976787f5f819b7a0142608e5bf6b0471250571f) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix tests, declare adapter default caps, improve error output, clean up demo app |
| D123 | 2025-11-12 | [1f6b454e](https://github.com/prisma/orm/commit/1f6b454eb0c3de2edbd53215553083a7dcdf6854) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix front matter |
| D124 | 2025-11-12 | [73090e74](https://github.com/prisma/orm/commit/73090e7496f911398918aa5c643695749bff88bf) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D125 | 2025-11-12 | [2c0cc05a](https://github.com/prisma/orm/commit/2c0cc05a42d1b63f782e629eea4a720681d2768a) (+2 grouped) | results / development-fixup | no | inspected; no new concrete candidate | Fix inferred result type of vector expressions |
| D126 | 2025-11-12 | [75610245](https://github.com/prisma/orm/commit/756102458aafa41f6ab56ab8dcbdbad846c5d14d) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct budget evaluation |
| D127 | 2025-11-13 | [934b2f48](https://github.com/prisma/orm/commit/934b2f484b314de57f265fd022d6efb1b3172bfa) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors |
| D128 | 2025-11-13 | [6c5b3afd](https://github.com/prisma/orm/commit/6c5b3afd010f95f8c76249fa51c7314e756da061) | results / development-fixup | no | inspected; no new concrete candidate | Fix emit command tests - module resolution in the test app requires a package.json with real dependencies |
| D129 | 2025-11-13 | [feccd915](https://github.com/prisma/orm/commit/feccd915eedbe3300421c644d1084fbe4e457d67) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | Fix remaining CLI tests |
| D130 | 2025-11-13 | [792a825b](https://github.com/prisma/orm/commit/792a825b5f45f7eb6167b879ace9b10dab6513fe) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D131 | 2025-11-13 | [0a19b4a9](https://github.com/prisma/orm/commit/0a19b4a90b07bcfe2a65280dc4ad6a837671d606) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D132 | 2025-11-13 | [6f180174](https://github.com/prisma/orm/commit/6f1801749c367219c3325f57c26f66c830c6de20) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D133 | 2025-11-13 | [50b8e857](https://github.com/prisma/orm/commit/50b8e857ad032acc65bcdded63f844e90672e516) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix bug |
| D134 | 2025-11-13 | [f1057022](https://github.com/prisma/orm/commit/f10570229c01f1efa1c51f6cb96dab1cf57c03b8) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors |
| D135 | 2025-11-13 | [9961343e](https://github.com/prisma/orm/commit/9961343ef9514495a155d7f651f848ed19d434f1) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D136 | 2025-11-13 | [dbe66587](https://github.com/prisma/orm/commit/dbe66587eb40f8dfdeb895236298a6eb2a3e5033) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type error, wrap text |
| D137 | 2025-11-13 | [58d48fe2](https://github.com/prisma/orm/commit/58d48fe21e3d75460a6071c07390f1ae73b7d627) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken test |
| D138 | 2025-11-13 | [d62837bc](https://github.com/prisma/orm/commit/d62837bc7891dd6535a743fa1466d712e2ba9edf) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D139 | 2025-11-13 | [3c94a18d](https://github.com/prisma/orm/commit/3c94a18d6ca329279f823cf8a0291c5c7a8a41d6) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D140 | 2025-11-14 | [cf4e4506](https://github.com/prisma/orm/commit/cf4e4506f12414d3de01b435025968a21fbd6ecf) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests and clean up test dirs individually |
| D141 | 2025-11-14 | [c222df52](https://github.com/prisma/orm/commit/c222df52dcb83446146b6f151f7cf1b83ea34830) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D142 | 2025-11-14 | [300d393a](https://github.com/prisma/orm/commit/300d393a4aa3967bd9c9b583516b95aabf23368e) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D143 | 2025-11-14 | [b0c4bfef](https://github.com/prisma/orm/commit/b0c4bfef44fd20bdc4b12ec6032372e959fa9550) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix type errors and tests |
| D144 | 2025-11-14 | [49e54e38](https://github.com/prisma/orm/commit/49e54e38a76afc049012c622315e15e29d1a762d) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix cyclic dependency |
| D145 | 2025-11-14 | [9a270af5](https://github.com/prisma/orm/commit/9a270af5ab6509221c32461f35416e752d1318cb) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D146 | 2025-11-14 | [c986aacc](https://github.com/prisma/orm/commit/c986aacc247d250a18e2c56c0ff69462b4e7d269) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D147 | 2025-11-14 | [4a99ff9e](https://github.com/prisma/orm/commit/4a99ff9e0d088398d40779a40e62f1378dc12225) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix test |
| D148 | 2025-11-14 | [c621bb78](https://github.com/prisma/orm/commit/c621bb787f32fa09ac61b0ba04e762c937699267) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix test |
| D149 | 2025-11-14 | [ced0ae61](https://github.com/prisma/orm/commit/ced0ae61807bbf6a618f69f1694b2a00b163d1dc) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D150 | 2025-11-14 | [3a88c7ad](https://github.com/prisma/orm/commit/3a88c7ad1c6610740fc4ab8e5cdf0f31aee5d167) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Add missing dep |
| D151 | 2025-11-14 | [c5346b44](https://github.com/prisma/orm/commit/c5346b44e75635b20ced6995f1f4a06aac784c5c) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type failure with ResultType and SqlQueryPlan |
| D152 | 2025-11-16 | [754d75a9](https://github.com/prisma/orm/commit/754d75a96a91880356a80867e48e7896c443d95b) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors |
| D153 | 2025-11-16 | [88e4664d](https://github.com/prisma/orm/commit/88e4664dd1518f7857a9ce8ba682b9403222d88e) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D154 | 2025-11-17 | [99431288](https://github.com/prisma/orm/commit/99431288b4b71aa0e9ebb232c0f319133f4ab1e2) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors |
| D155 | 2025-11-17 | [0b671732](https://github.com/prisma/orm/commit/0b671732bd6daab108ffc7b07cb75ee7142bbac9) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix type checks and tests |
| D156 | 2025-11-17 | [38bb1da5](https://github.com/prisma/orm/commit/38bb1da56bac163d8f65c054f7109802b9fa7c5b) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D157 | 2025-11-17 | [7797f407](https://github.com/prisma/orm/commit/7797f40793fa8377780f01cd56579d21b7949ae6) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct dep rule exception logic |
| D158 | 2025-11-17 | [3ebf743d](https://github.com/prisma/orm/commit/3ebf743d75423ac30e1d42696dc67b57d7208a68) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix tests and type checks |
| D159 | 2025-11-18 | [7abd2612](https://github.com/prisma/orm/commit/7abd261267e58b13658c801a8f98cc0f965bf5ce) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D160 | 2025-11-18 | [75c9a1a5](https://github.com/prisma/orm/commit/75c9a1a57bf0da4fa6b91dcea6b0e91aa2b7a829) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors |
| D161 | 2025-11-18 | [d61b11c5](https://github.com/prisma/orm/commit/d61b11c5163a6e28cdb1084e5dac84308efbbaa5) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D162 | 2025-11-18 | [edbeee1a](https://github.com/prisma/orm/commit/edbeee1a840b98c176c81104f7cb9321f221ad0f) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D163 | 2025-11-18 | [76130c52](https://github.com/prisma/orm/commit/76130c528e9704051cf0cb8238f71662d516a754) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | Add missing snapshot |
| D164 | 2025-11-18 | [695a798d](https://github.com/prisma/orm/commit/695a798dc543fea81cba9f9ea4df0c51a1ee2367) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct front matter |
| D165 | 2025-11-18 | [17190b8b](https://github.com/prisma/orm/commit/17190b8b33abc5edafbef7a9064aa26cd8f146ea) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Add missing path alias |
| D166 | 2025-11-18 | [214d6bca](https://github.com/prisma/orm/commit/214d6bcad62c887a773b5a02e58d2eb7fdde72d5) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type errors |
| D167 | 2025-11-18 | [a061d7c6](https://github.com/prisma/orm/commit/a061d7c63a0d88af09933e92360e36f14200a7bf) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D168 | 2025-11-18 | [a8ee303d](https://github.com/prisma/orm/commit/a8ee303d3a07ee7de90decf7421b0e8f2df399c3) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix type errors and tests |
| D169 | 2025-11-18 | [7be22b98](https://github.com/prisma/orm/commit/7be22b981f385606c613aadf42658b9566eb2dfb) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D170 | 2025-11-18 | [3d78ee3c](https://github.com/prisma/orm/commit/3d78ee3cec340cc5c3075fc9431ec5f910c4f88b) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D171 | 2025-11-19 | [fe71961b](https://github.com/prisma/orm/commit/fe71961b9c04ccc86ebc00f6471cb57c3ec075fb) | migrations / development-fixup | no | inspected; no new concrete candidate | Fix test snapshots |
| D172 | 2025-11-19 | [40253358](https://github.com/prisma/orm/commit/40253358e38ab9db3752e10f56754baaed874e9b) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix test |
| D173 | 2025-11-19 | [dc03e19c](https://github.com/prisma/orm/commit/dc03e19c4b87eb7129ef0382efb9cb8c9fd4e031) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests |
| D174 | 2025-11-24 | [48badb28](https://github.com/prisma/orm/commit/48badb288bfd0c78ee486fe5d429c7f881d3753a) | extensions / development-fixup | no | inspected; no new concrete candidate | fix(prisma-next-demo): fix broken `pnpm emit` command (#23) |
| D175 | 2025-12-04 | [5eb471fe](https://github.com/prisma/orm/commit/5eb471fe36a26d6048c0005fcf0fe253b89a97bb) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix broken tests |
| D176 | 2025-12-05 | [4c3357be](https://github.com/prisma/orm/commit/4c3357be9fe55c897b4ac4d33d6426240decaabe) (+5 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | Fix broken tests - arg passing to cli commands was incorrect and timeouts missing |
| D177 | 2025-12-05 | [c2f09f3a](https://github.com/prisma/orm/commit/c2f09f3ae0a56daa68484a7e4e84d939c1f31527) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix some small nitpicks |
| D178 | 2025-12-05 | [6c2dab9e](https://github.com/prisma/orm/commit/6c2dab9e07b27a42b800cbdf191fc0744d31db72) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix tests and DRY them up |
| D179 | 2025-12-10 | [ebcd4f43](https://github.com/prisma/orm/commit/ebcd4f43a5bf21d9e5002a70d207cae44cfc698c) | extensions / development-fixup | no | inspected; no new concrete candidate | chore: fix incorrect clean path script in compat-prisma (#33) |
| D180 | 2025-12-10 | [c5d1dde8](https://github.com/prisma/orm/commit/c5d1dde839c55efaca2d94f0dc06b71cf223a3b6) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | correct dependencies, remove tsconfig paths, and break cycles (#31) |
| D181 | 2025-12-18 | [6bb9a6a0](https://github.com/prisma/orm/commit/6bb9a6a0db9eba1573ead45308b16f0e0798ed76) | schema-relations / development-fixup | no | inspected; no new concrete candidate | fix(relational-core): typecheck |
| D182 | 2025-12-18 | [5ff1b6b4](https://github.com/prisma/orm/commit/5ff1b6b4415940b0a8690a6f10e5143df5393f27) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: tests |
| D183 | 2025-12-18 | [ae3036f1](https://github.com/prisma/orm/commit/ae3036f1768621f9377088195a764922ad2c51a7) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(sql-orm-lane): lint |
| D184 | 2025-12-18 | [97913707](https://github.com/prisma/orm/commit/979137077ee05770e826db0147f49e020f888069) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(sql-orm-lane): tests |
| D185 | 2025-12-18 | [49493c77](https://github.com/prisma/orm/commit/49493c779c996982c996ed806165e9b3f428a868) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(sql-orm-lane): tests |
| D186 | 2025-12-24 | [76bd02fa](https://github.com/prisma/orm/commit/76bd02fab99b9102de4e24450c5020314ef19de9) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | Revert "Delete obsolete port allocation code" |
| D187 | 2025-12-24 | [c7c0ae42](https://github.com/prisma/orm/commit/c7c0ae42c2b1e530c39ffb889506a5bc183dff26) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | Remove broken second connection |
| D188 | 2025-12-24 | [d6334728](https://github.com/prisma/orm/commit/d633472852d23b0cf71e2bc4a8b8897d67224971) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | Prevent multiple concurrent connections to @prisma/dev |
| D189 | 2025-12-26 | [56f42779](https://github.com/prisma/orm/commit/56f42779b3ec90a74ce604f4fc7519dca94ede69) | extensions / development-fixup | no | inspected; no new concrete candidate | Correct docs |
| D190 | 2025-12-26 | [27f55c32](https://github.com/prisma/orm/commit/27f55c32bf22c35bfe9bb30d8ddc984db29ddc05) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix typecheck error |
| D191 | 2025-12-26 | [21d43128](https://github.com/prisma/orm/commit/21d4312815a0022e3b36fd09c4cf499af856eba5) | execution / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): configure vitest to use forks pool for process.chdir() support |
| D192 | 2025-12-26 | [96def3d0](https://github.com/prisma/orm/commit/96def3d0189aa43f0395f1e1a7a7a88385f6bc4f) | extensions / development-fixup | no | inspected; no new concrete candidate | Add missing test cases |
| D193 | 2025-12-26 | [5c9cc608](https://github.com/prisma/orm/commit/5c9cc60889e2a911184c322e377a871b31878cfd) (+1 grouped) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix type error |
| D194 | 2025-12-26 | [f4a5d5e0](https://github.com/prisma/orm/commit/f4a5d5e0721f038edddeb59679e86b9d5294ba96) | results / development-fixup | no | inspected; no new concrete candidate | Update broken path references across all docs |
| D195 | 2025-12-26 | [7fd8314d](https://github.com/prisma/orm/commit/7fd8314dde22a31ddce86c09e701ffd839fef8a0) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct biome paths |
| D196 | 2025-12-27 | [01a0124a](https://github.com/prisma/orm/commit/01a0124a4c578ed419b9912a3e014be803e74e5a) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: improve Postgres migration planner error handling |
| D197 | 2025-12-27 | [0657e5a5](https://github.com/prisma/orm/commit/0657e5a572abf3f8b71800ccb0a78d11196aab7a) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: add schema qualification to constraint checks |
| D198 | 2025-12-27 | [60147c26](https://github.com/prisma/orm/commit/60147c2684f957f0989fbb083148a1b5dd1b2244) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: add family parameter to createPlanner to match interface |
| D199 | 2025-12-27 | [bf31ca31](https://github.com/prisma/orm/commit/bf31ca3165f4157632bd78a6a1df4507b2274f29) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: replace non-null assertion with defensive check |
| D200 | 2025-12-27 | [be668b71](https://github.com/prisma/orm/commit/be668b7129b2264dcb34e710075c2055fa452ee6) | results / development-fixup | no | inspected; no new concrete candidate | fix: add timeout parameters to database integration tests |
| D201 | 2025-12-29 | [d35c9cee](https://github.com/prisma/orm/commit/d35c9cee1ee72a25e3de11b057e3f2c07c298229) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | refactor(result): remove default for failure type parameter |
| D202 | 2025-12-29 | [06d6bf4b](https://github.com/prisma/orm/commit/06d6bf4b4f1801c408a6a841849b3c2263df714b) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(runner): handle PostgreSQL boolean string representations correctly |
| D203 | 2025-12-29 | [c103e4df](https://github.com/prisma/orm/commit/c103e4dfc417245db39823a24d64eec716050613) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(migrations): freeze and clone target.details to prevent mutation |
| D204 | 2025-12-29 | [51c14424](https://github.com/prisma/orm/commit/51c144247dde2da7bb492498d1b7eacda2cef226) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(migrations): freeze and deep-clone skip record to prevent mutation |
| D205 | 2025-12-29 | [661c0612](https://github.com/prisma/orm/commit/661c0612b887a9877c868ebbc1baee0d9dc57332) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: correct AST kind assertions in tests |
| D206 | 2025-12-29 | [676ff385](https://github.com/prisma/orm/commit/676ff38578cbe5f1b20887a0d36d95a405a02ae7) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: close direct client in postgres driver |
| D207 | 2025-12-29 | [68a23de8](https://github.com/prisma/orm/commit/68a23de8fe21b189740bc3859d65e0b4a9fcbfa7) | extensions / development-fixup | no | inspected; no new concrete candidate | Revert change to coverage thresholds |
| D208 | 2025-12-29 | [df7bb71d](https://github.com/prisma/orm/commit/df7bb71d4a785d665f70abe08ae61ad557a67739) | results / development-fixup | no | inspected; no new concrete candidate | fix(utils): align tsconfig.json with other packages |

| D209 | 2025-12-29 | [4c3c8b45](https://github.com/prisma/orm/commit/4c3c8b453b0ae88b05467708b8a23de7fedfee96) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: resolve typecheck errors after Result import migration |
| D210 | 2025-12-29 | [c230d330](https://github.com/prisma/orm/commit/c230d3302c2dfedd4a9b2cd9353d65acf987e230) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(schema-verify): use correct 'extra_*' kinds for extraneous entities |
| D211 | 2025-12-29 | [4be84bb9](https://github.com/prisma/orm/commit/4be84bb9f37fd2a8a0a6e43f9f09198d980bea6b) | results / development-fixup | no | inspected; no new concrete candidate | fix: update integration test to use extra_column instead of missing_column |
| D212 | 2025-12-29 | [8a981c62](https://github.com/prisma/orm/commit/8a981c62238a0fecd000f334b62b902252823f23) | validation-types / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): fix TypeScript errors in db-init command |
| D213 | 2025-12-29 | [db849886](https://github.com/prisma/orm/commit/db849886d866d6b5ce6ace054cd78a87cfa3771b) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(target-postgres): skip adapter-level extensions in migration planner |
| D214 | 2025-12-29 | [2383311f](https://github.com/prisma/orm/commit/2383311f102381c9d796608c51d047b46c6cf626) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): add error handling for JSON.parse in db-init |
| D215 | 2025-12-30 | [ce858b49](https://github.com/prisma/orm/commit/ce858b49b7864e5152ae3d37ee87ac6a952ab4d0) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct front matter |
| D216 | 2025-12-30 | [0ad03ac2](https://github.com/prisma/orm/commit/0ad03ac2f39046d062e01f87e1f07a54da653435) | validation-types / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): improve db init error output with conflict details |
| D217 | 2025-12-30 | [5b3bcf43](https://github.com/prisma/orm/commit/5b3bcf434ef4bf75050f550ba2fee28c35335bbe) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: build test utils into dist for published packages |
| D218 | 2025-12-30 | [7446ac1d](https://github.com/prisma/orm/commit/7446ac1d10a9e627bbc09380987ba3d2f0fd4e52) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Add missing dependency |
| D219 | 2025-12-30 | [d9dc0b18](https://github.com/prisma/orm/commit/d9dc0b1859e22fdd15f3f48b7f7cc85f31225606) | query-engine / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): add explicit include to coverage config |
| D220 | 2025-12-30 | [e9feb80b](https://github.com/prisma/orm/commit/e9feb80b7b1862bcbef4e15143682547f623b684) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres): correct double Sql prefix in runner type names |
| D221 | 2025-12-30 | [9ff322d3](https://github.com/prisma/orm/commit/9ff322d35816371628841cd5184d18eab1276158) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(core-control-plane): make TargetMigrationsCapability generic over family instance |
| D222 | 2025-12-31 | [09dab4a9](https://github.com/prisma/orm/commit/09dab4a951a4a935f78ef25292a40caeef613d68) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: tests, coverage |
| D223 | 2025-12-31 | [b4d12ffb](https://github.com/prisma/orm/commit/b4d12ffb74fea2a0c462b91e872cdabb5f706bf0) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(driver-postgres): update for new DriverInstance signature |
| D224 | 2025-12-31 | [5081a87c](https://github.com/prisma/orm/commit/5081a87c01067dc1fa97f56063832db2c09b847d) | results / development-fixup | no | inspected; no new concrete candidate | fix: add TypeScript compilation timeout to config-loader tests |
| D225 | 2025-12-31 | [d8eb8adb](https://github.com/prisma/orm/commit/d8eb8adb284c41cbeb63d994b983f61e5064369a) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: verify extensions declared in contract during schema verification |
| D226 | 2025-12-31 | [93f35201](https://github.com/prisma/orm/commit/93f35201aedffd1ed0c0c4af893583774c0358d7) (+3 grouped) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: align pgvector dependency naming with vector extension |
| D227 | 2025-12-31 | [676143ad](https://github.com/prisma/orm/commit/676143ad3c2f2c9b6c30816dda364802204517b5) | results / development-fixup | no | inspected; no new concrete candidate | fix: add timeouts to failing integration tests |
| D228 | 2025-12-31 | [0210f1a9](https://github.com/prisma/orm/commit/0210f1a9730c1a3038b7ae99c2bd95ad2db76b18) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: correct PlannerDatabaseDependency property name to singular form |
| D229 | 2025-12-31 | [2aa6c0ed](https://github.com/prisma/orm/commit/2aa6c0edc9a4257828c5861e0442be9e4a970541) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: remove invalid 'pg' extension from contract |
| D230 | 2025-12-31 | [d7f98f1b](https://github.com/prisma/orm/commit/d7f98f1bad9b7f47600d8ab121dc40f54754fc15) | migrations / development-fixup | no | inspected; no new concrete candidate | Fix test failures in planner and integration tests |
| D231 | 2026-01-01 | [24254814](https://github.com/prisma/orm/commit/242548140a74118cfa06cfda76f6f902f14594c5) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | refactor: use object matchers for failure.meta assertions |
| D232 | 2026-01-01 | [09100c85](https://github.com/prisma/orm/commit/09100c85ab787d9da4ad4a9bf9e77f20b8cb6d14) (+1 grouped) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix: tighten isPostgresError to exclude Node.js system errors |
| D233 | 2026-01-01 | [a994b3a8](https://github.com/prisma/orm/commit/a994b3a8548bba1560f9ba3d0f0b8c64e6555e12) | results / development-fixup | no | inspected; no new concrete candidate | fix: update tests to handle optional column property and add missing timeouts |
| D234 | 2026-01-01 | [dbffe30b](https://github.com/prisma/orm/commit/dbffe30b9243b5a0e2b0c84bdac3a28329995e47) | results / development-fixup | no | inspected; no new concrete candidate | Add timeout and remove incorrect property from matcher |
| D235 | 2026-01-01 | [81213a48](https://github.com/prisma/orm/commit/81213a4864d8873dc0801f3a901364579d246cdf) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | refactor(utils): use fail-fast getters for Result value/failure access |
| D236 | 2026-01-01 | [1fcc1f0e](https://github.com/prisma/orm/commit/1fcc1f0e09c0a4e9664de767be42d138884d352e) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix type error |
| D237 | 2026-01-01 | [3b88ee3a](https://github.com/prisma/orm/commit/3b88ee3a5c9a7759427e4e8428a0d4448b540d22) | results / development-fixup | no | inspected; no new concrete candidate | fix(integration): add timeout to codecs test to prevent timeout error |
| D238 | 2026-01-01 | [0ed45bde](https://github.com/prisma/orm/commit/0ed45bdef6ca2473e3e7bcf4b5527a5a24bdfc1b) | results / development-fixup | no | inspected; no new concrete candidate | fix(utils): import Ok type in result.test.ts |
| D239 | 2026-01-01 | [adcbd052](https://github.com/prisma/orm/commit/adcbd0528249f91067e30661c3bf8dab83d6048b) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix extension verification to accept target/adapter IDs in contract.extensions |
| D240 | 2026-01-02 | [099b5913](https://github.com/prisma/orm/commit/099b5913e71775f44fd4bb8f9577a75ed83ef293) (+2 grouped) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix postgres target coverage config - remove all:true flag |
| D241 | 2026-01-02 | [695fe6aa](https://github.com/prisma/orm/commit/695fe6aa939dc639254ef0e236c7f576fe258632) (+1 grouped) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix: add missing @prisma-next/test-utils dependency to sql-schema-ir |
| D242 | 2026-01-02 | [022799c1](https://github.com/prisma/orm/commit/022799c1c050e0d35e6b888d6a005ebcec7d945d) (+3 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(db-init): improve runner failure guidance |
| D243 | 2026-01-02 | [bfb780ba](https://github.com/prisma/orm/commit/bfb780ba8f74db74e33b71d2edddd023c9a207f0) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(utils): avoid readonly writes in redact helper |
| D244 | 2026-01-02 | [c94a128e](https://github.com/prisma/orm/commit/c94a128e58dbccf2e5c042fb4a3a8aed98f85a32) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(db-init): reuse error code handling |
| D245 | 2026-01-02 | [2fc351c1](https://github.com/prisma/orm/commit/2fc351c133987ac095f907572c718365f93435a5) | results / development-fixup | no | inspected; no new concrete candidate | fix: resolve build errors and update test fixtures for pack-ref-only target() |
| D246 | 2026-01-02 | [7a4ba376](https://github.com/prisma/orm/commit/7a4ba376252145932d5c0f21286b0c7431a9b6db) (+3 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | Fix terminology: update references from 'extensions' to 'extensionPacks' in tests and docs |
| D247 | 2026-01-02 | [30e1de6c](https://github.com/prisma/orm/commit/30e1de6ce186a103597a02350ffaeeae984c671a) (+10 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix: provide default empty array for extensionPacks in createSqlFamilyInstance |
| D248 | 2026-01-02 | [43812275](https://github.com/prisma/orm/commit/4381227574d2b5612d051e738f08ec356597f620) (+2 grouped) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: complete 'extensions' to 'extensionPacks' rename across entire codebase |
| D249 | 2026-01-02 | [74704e3f](https://github.com/prisma/orm/commit/74704e3fee9d4277b237ac343d6dedc477c93948) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: Use real postgres adapter in demo tests instead of stub adapter |
| D250 | 2026-01-02 | [c236d7a8](https://github.com/prisma/orm/commit/c236d7a8a30b717b4e10ebf58fec3531855dd84c) | results / development-fixup | no | inspected; no new concrete candidate | fix: Add missing timeouts to integration tests |
| D251 | 2026-01-02 | [bd266af8](https://github.com/prisma/orm/commit/bd266af821b90b1f0cf1186a0e9dd61cd5a1f038) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | feat(cli): report all missing extension packs |
| D252 | 2026-01-02 | [58253683](https://github.com/prisma/orm/commit/58253683085b0f041a3b12af81aaa560ae9c1f52) | results / development-fixup | no | inspected; no new concrete candidate | fix(sql-runtime): fix typecheck errors in test files |
| D253 | 2026-01-03 | [9908e2d2](https://github.com/prisma/orm/commit/9908e2d2bfb53a2f388a7fff2f3985564b1981c9) | results / development-fixup | no | inspected; no new concrete candidate | fix: include test/utils.ts in tsconfig.build.json for packages that export it |
| D254 | 2026-01-03 | [bfe4449b](https://github.com/prisma/orm/commit/bfe4449b67cbb32b6ef87f7b06fb9c5d5a9e482a) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-lane): export missing types for portable type inference |
| D255 | 2026-01-03 | [4322ada6](https://github.com/prisma/orm/commit/4322ada614bfaa6f6f896a75a77a0d8ad7de6293) | results / development-fixup | no | inspected; no new concrete candidate | fix: update package.json exports to match tsc output paths |
| D256 | 2026-01-03 | [12caffe4](https://github.com/prisma/orm/commit/12caffe463d6e97e8516456bcd3e2c7c12f3ba19) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix: include test directory in files array for packages exporting test utilities |
| D257 | 2026-01-03 | [725affe1](https://github.com/prisma/orm/commit/725affe1228209fcce8d83a0ab41d8e80318d1ec) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | Avoid amending pushed commits |
| D258 | 2026-01-03 | [11cd3731](https://github.com/prisma/orm/commit/11cd3731805d93d968c1b4669d7ff9ee099468a1) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): correct declaration file paths in package exports |
| D259 | 2026-01-04 | [eed93dda](https://github.com/prisma/orm/commit/eed93dda1557cd09571f683972830915ee43e34d) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): colocate JS and declaration files in dist/exports/ |
| D260 | 2026-01-04 | [6bf720f5](https://github.com/prisma/orm/commit/6bf720f58750f750a6b3c862c21f3cf2135206b1) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Revert .gitignore wip ignore |
| D261 | 2026-01-04 | [62c833b6](https://github.com/prisma/orm/commit/62c833b691d0577075b45a801508cddc1a4b28c1) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix rulecard duplication and invalid globs |
| D262 | 2026-01-04 | [59db4401](https://github.com/prisma/orm/commit/59db44014b7c870bb559b0d897a05b1ef5adb5ed) (+1 grouped) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix: use extensionPacks instead of extensions in config-types.test-d.ts |
| D263 | 2026-01-04 | [05037639](https://github.com/prisma/orm/commit/0503763952e5c99fd2cecd9087e85154b6630707) | extensions / development-fixup | no | inspected; no new concrete candidate | Add CI guardrail for rules footprint regression |
| D264 | 2026-01-04 | [c433f442](https://github.com/prisma/orm/commit/c433f44206ac161a06f55256669646aee30a9035) (+5 grouped) | results / development-fixup | no | inspected; no new concrete candidate | Fix __dirname usage for ESM compatibility in seed script |
| D265 | 2026-01-04 | [87153c35](https://github.com/prisma/orm/commit/87153c35ca503a09859f97af633de365ba693bf0) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix target property access in control client dbInit error message |
| D266 | 2026-01-04 | [4650282c](https://github.com/prisma/orm/commit/4650282c86d530d0727fa3fdc966c10475e35fac) | schema-relations / toolchain-outside-viborm | no | inspected; no new concrete candidate | Fix CLI command in generated file comments: prisma-next emit -> prisma-next contract emit |
| D267 | 2026-01-05 | [39f973e8](https://github.com/prisma/orm/commit/39f973e88e6a000c5257061267e8da9102551244) (+3 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): propagate error details and fix cross-module error detection |
| D268 | 2026-01-05 | [efacfa62](https://github.com/prisma/orm/commit/efacfa620b26db073ebf8b1eb16c5be517e04b67) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(sql-contract-ts): adjust branch coverage threshold |
| D269 | 2026-01-05 | [1e33cec3](https://github.com/prisma/orm/commit/1e33cec3e14ef7ec93411946381f683f1e280542) (+1 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): restore toSchemaView for db-introspect and configPath for db-sign |
| D270 | 2026-01-05 | [7a5459fe](https://github.com/prisma/orm/commit/7a5459fe77117d0d6b211f5c287235f2567c59f7) | schema-relations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): catch loadConfig errors in contract-emit command |
| D271 | 2026-01-06 | [bf752d4d](https://github.com/prisma/orm/commit/bf752d4d611c7d597603483fe3443810b763c660) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: ci |
| D272 | 2026-01-06 | [3822a0f3](https://github.com/prisma/orm/commit/3822a0f3b787bdc168af7a501aa28bb52894783d) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: lint |
| D273 | 2026-01-06 | [2d54bd29](https://github.com/prisma/orm/commit/2d54bd29ec230e11b077ce4d0b7cd6196040f194) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: coverage |
| D274 | 2026-01-06 | [2badd4a8](https://github.com/prisma/orm/commit/2badd4a82bb40821997024ed9d67d7bf48921f9b) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: coverage |
| D275 | 2026-01-07 | [27c39220](https://github.com/prisma/orm/commit/27c39220e20fe1ff7ad730a94a9994671d509222) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Surface missing template params in interpolateTypeTemplate |
| D276 | 2026-01-07 | [fb5c48a2](https://github.com/prisma/orm/commit/fb5c48a217de59045b944ffeb803179d1f86836f) | migrations / development-fixup | no | inspected; no new concrete candidate | Fix index signature access in test files |
| D277 | 2026-01-07 | [51115cf8](https://github.com/prisma/orm/commit/51115cf84abdf23f28c306337912c6934f99a14b) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Avoid non-null assertion |
| D278 | 2026-01-07 | [681253c6](https://github.com/prisma/orm/commit/681253c6532626dca6985fdd733dc7f1ff68440f) | results / development-fixup | no | inspected; no new concrete candidate | Add timeout to query errors test to prevent flaky timeout |
| D279 | 2026-01-07 | [9ec5c7d5](https://github.com/prisma/orm/commit/9ec5c7d5734b75f9c93f76d93aa0f14d97a51c01) | results / development-fixup | no | inspected; no new concrete candidate | Add missing timeouts to loadContractFromTs tests |
| D280 | 2026-01-08 | [5873c12d](https://github.com/prisma/orm/commit/5873c12d83803558da535f035b2e0d0c5373a2b7) | results / development-fixup | no | inspected; no new concrete candidate | fix(sql-emitter): use parameterizedTypeImports instead of parameterizedCodecs |
| D281 | 2026-01-08 | [914fa1c6](https://github.com/prisma/orm/commit/914fa1c6a558f77f1d2af58f5fc37349d98d704f) (+1 grouped) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(runtime): align schema().types runtime value with contract typing |
| D282 | 2026-01-08 | [177a57cf](https://github.com/prisma/orm/commit/177a57cf41dcf8318226090027f057129ac1b147) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: coverage:report |
| D283 | 2026-01-20 | [c296993e](https://github.com/prisma/orm/commit/c296993e0afa7377a1cafd59881c959ceb01cfb8) (+4 grouped) | validation-types / toolchain-outside-viborm | no | inspected; no new concrete candidate | Avoid synchronous file I/O |
| D284 | 2026-01-20 | [4b008398](https://github.com/prisma/orm/commit/4b00839861a15e91e024c2ec2e84e1d064e33be2) (+2 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): normalize throwIfAborted to ContractEmitCancelledError |
| D285 | 2026-01-20 | [f35549c1](https://github.com/prisma/orm/commit/f35549c1b9539c95e20cc08e38b2f3f5ee276ecc) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): validate contract output path and source properly |
| D286 | 2026-01-20 | [ad45e8ba](https://github.com/prisma/orm/commit/ad45e8bae5538649822624d6aafbf94401a23298) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(integration): remove contractConfig.types references |
| D287 | 2026-01-20 | [7d33ba7f](https://github.com/prisma/orm/commit/7d33ba7fdac7acbb4974f95a9521d2ad25bb980d) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct rule file front matter |
| D288 | 2026-01-20 | [bae3e15e](https://github.com/prisma/orm/commit/bae3e15e238661b3e3da75ab823d800bfc434b99) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Remove broken types option |
| D289 | 2026-01-20 | [570a8b64](https://github.com/prisma/orm/commit/570a8b64b38edd3233d5bcaef01da04c05b5605f) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix: typecheck |
| D290 | 2026-01-20 | [cd223dda](https://github.com/prisma/orm/commit/cd223dda02785149c8ec3d8593bd57fbae23e555) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix: typecheck |
| D291 | 2026-01-21 | [00a08070](https://github.com/prisma/orm/commit/00a08070534e501e8900dcc64c852391c29fad0a) (+3 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix: remove redundant createRuntime overload |
| D292 | 2026-01-21 | [a18b360c](https://github.com/prisma/orm/commit/a18b360c0c89dfea1fc4bf7fff4a25c58d631cf2) (+3 grouped) | results / development-fixup | no | inspected; no new concrete candidate | chore: remove stale comment from framework-components |
| D293 | 2026-01-23 | [5f6c8cbc](https://github.com/prisma/orm/commit/5f6c8cbc58451e6837bb21a4ea16f5262e5882aa) | results / development-fixup | no | inspected; no new concrete candidate | Correct runtime imports |
| D294 | 2026-01-27 | [5edf85d1](https://github.com/prisma/orm/commit/5edf85d1b8cdccc23a83114038d8f402714f89e3) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: add back e2e/framework generated test fixtures |
| D295 | 2026-01-27 | [0b839dfc](https://github.com/prisma/orm/commit/0b839dfc65be7322a3666dc6eaf9e3c7cf7f054d) | extensions / development-fixup | no | inspected; no new concrete candidate | chore: add security scanning workflow (#120) |
| D296 | 2026-01-28 | [bad7c79a](https://github.com/prisma/orm/commit/bad7c79ab7582f87d69c99e93568089beb53dc26) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: type.declare usage in arktype |
| D297 | 2026-01-29 | [f35fc371](https://github.com/prisma/orm/commit/f35fc37186063ee6779829a794aaab3b62a97de3) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | Revert "feat: rename "function" column defaults to "db-generated"; add comments on cross-target default functions" |
| D298 | 2026-01-29 | [5281112e](https://github.com/prisma/orm/commit/5281112ed8e6c512878d98f0cb4cdbfa9950e550) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: fix missing acquireConnection (#126) |
| D299 | 2026-01-29 | [a4c78156](https://github.com/prisma/orm/commit/a4c781565f82e9dceac06749c244977597435979) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(family-sql): wire up normalizeDefault in schemaVerify |
| D300 | 2026-02-02 | [834a0a93](https://github.com/prisma/orm/commit/834a0a9349ef31d42c4ebf3a2f82783cf25833db) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: coverage:report script |
| D301 | 2026-02-05 | [14722fd5](https://github.com/prisma/orm/commit/14722fd5f49291a53dd143b0264d79b24b723f17) (+2 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: Handle quoted types in literals properly during normalization |
| D302 | 2026-02-06 | [e15aba40](https://github.com/prisma/orm/commit/e15aba400c3382da82f0c1d5336ba1448ce1a265) | schema-relations / development-fixup | no | inspected; no new concrete candidate | Fix pre-existing type issues from rebase |
| D303 | 2026-02-06 | [3c801f68](https://github.com/prisma/orm/commit/3c801f68c27013046f35266d2419cdb69a91f51c) (+2 grouped) | results / development-fixup | no | inspected; no new concrete candidate | Add missing description to mermaid-compat cursor rule |
| D304 | 2026-02-09 | [fcc09c29](https://github.com/prisma/orm/commit/fcc09c29e0f5f5230b4b2368a5bf4b9d0cb17b64) | extensions / development-fixup | no | inspected; no new concrete candidate | Restore mocks after static context tests to avoid spy leakage |
| D305 | 2026-02-09 | [011e6510](https://github.com/prisma/orm/commit/011e6510794c668adeeb7d509a048764eaac78da) | validation-types / development-fixup | no | inspected; no new concrete candidate | Fix createExecutionStack typing to satisfy execution-plane typecheck |
| D306 | 2026-02-10 | [1fe553dc](https://github.com/prisma/orm/commit/1fe553dc8fc30475799887a3fc470ae5b05e001d) (+3 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: coverage:report |
| D307 | 2026-02-10 | [aed8a055](https://github.com/prisma/orm/commit/aed8a05594681f87ea8f8884c7604159f6757c14) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix: typecheck + lint |
| D308 | 2026-02-11 | [0f70bb6c](https://github.com/prisma/orm/commit/0f70bb6c4027df1dd59bf032f8607e721c34ccbe) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: strip type casts from string literal defaults in normalizer (#137) |
| D309 | 2026-02-12 | [14dba7b0](https://github.com/prisma/orm/commit/14dba7b07e9c1b1eb83e4f488907edd7524a8f37) (+2 grouped) | schema-relations / development-fixup | no | inspected; no new concrete candidate | fix(pr): make fetch-review-state deterministic and portable |
| D310 | 2026-02-13 | [c9e228df](https://github.com/prisma/orm/commit/c9e228df2360f7ea576f03c340a0bb141081ffb3) | results / development-fixup | no | inspected; no new concrete candidate | fix(postgres): use storageHash instead of coreHash in json test fixture |
| D311 | 2026-02-13 | [8d76f3e9](https://github.com/prisma/orm/commit/8d76f3e9de9892c1a5937caf86a1f1f792fd8081) | results / development-fixup | no | inspected; no new concrete candidate | fix(postgres): address code review findings for json/jsonb codecs |
| D312 | 2026-02-13 | [f354f22b](https://github.com/prisma/orm/commit/f354f22b3eb8e5bf9f2455f2b61a8bb366ca08d6) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix: typecheck |
| D313 | 2026-02-13 | [1bd6f2dc](https://github.com/prisma/orm/commit/1bd6f2dc2ae90baa14d32784126c1ec8d0678d5c) | extensions / development-fixup | no | inspected; no new concrete candidate | fix(demo): restore string-based id typing after rebase |
| D314 | 2026-02-15 | [6168b16e](https://github.com/prisma/orm/commit/6168b16eb98476a8820245dc90808832d2f82cec) | results / development-fixup | no | inspected; no new concrete candidate | fix(postgres): configure url pool timeouts and clarify demo diagram |
| D315 | 2026-02-16 | [16aab109](https://github.com/prisma/orm/commit/16aab1093dd31d29e0dc045dfcedef0ae5301cf4) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix(postgres): strip quoted enum type names from format_type() (#147) |
| D316 | 2026-02-16 | [cdec2283](https://github.com/prisma/orm/commit/cdec2283c0455f2fb1f33063e19c4654cf5cf976) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres): rename typeParams.schema to schemaJson |
| D317 | 2026-02-17 | [654b51e4](https://github.com/prisma/orm/commit/654b51e4e66eee57f13677346e30a2685f70fc1f) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: resolve TypeScript strict-mode errors in JSON Schema validation |
| D318 | 2026-02-17 | [e47de504](https://github.com/prisma/orm/commit/e47de50498824c2d3101ff3ff922e41c978458c2) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: resolve test failures in prisma-next-demo and integration-tests |
| D319 | 2026-02-17 | [4a072514](https://github.com/prisma/orm/commit/4a07251457f4a44046b1149ac19d44ae1e6c26ff) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres): update json paramsSchema to use schemaJson key |
| D320 | 2026-02-17 | [12ca4c2d](https://github.com/prisma/orm/commit/12ca4c2d2489d4e0cd3aa2ad984ef6a6a022b49d) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: address review findings for FK config feature |
| D321 | 2026-02-18 | [5cf38259](https://github.com/prisma/orm/commit/5cf382595a8d6001ade6871a685288fc44236fc0) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: restore stable export mappings for integration tests |
| D322 | 2026-02-18 | [10f64f4a](https://github.com/prisma/orm/commit/10f64f4ad77aaceefe544980246dd1a4068a0070) | results / development-fixup | no | inspected; no new concrete candidate | fix(adapter-postgres): increase timeout for Ajv initialization test |
| D323 | 2026-02-18 | [28690e3c](https://github.com/prisma/orm/commit/28690e3cfc6b87f18d0e4bf4345225375c8680fd) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: use renamed schemaJson property and fix merge indentation |
| D324 | 2026-02-18 | [686fa43d](https://github.com/prisma/orm/commit/686fa43dd0f2e31a1264bf267d5e772cfdb436cb) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): increase timeout for ora spinner initialization test |
| D325 | 2026-02-19 | [b255aeaa](https://github.com/prisma/orm/commit/b255aeaa3649bfa1a0303a2e30b1640c63d34db1) (+1 grouped) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(driver-postgres): remove legacy runtime options type from public path |
| D326 | 2026-02-19 | [6f4b922a](https://github.com/prisma/orm/commit/6f4b922adaabfdfa139cd983804db60838bec5b2) (+2 grouped) | execution / development-fixup | no | inspected; no new concrete candidate | fix(prisma-next-demo): reuse stack driver and clean pools on connect failures |
| D327 | 2026-02-19 | [569386f1](https://github.com/prisma/orm/commit/569386f13ae838e9b33aecb8d603e1cae786b1a8) (+6 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(driver-postgres): add structured lifecycle errors and safe delegate access |
| D328 | 2026-02-19 | [7dc93bbe](https://github.com/prisma/orm/commit/7dc93bbed98c9165f78c5bdeb7ad68e9b12eb71c) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(driver-postgres): serialize direct client connections and track closed state |
| D329 | 2026-02-19 | [70e8067e](https://github.com/prisma/orm/commit/70e8067e6bfbb3ce559d50f61cf509a08b96be41) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(contract-authoring, sql-contract-ts): resolve cross-domain import and missing FK schema fields |
| D330 | 2026-02-20 | [d09c0243](https://github.com/prisma/orm/commit/d09c0243735fb49eef5218a1cb929aec26c6a370) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: address code review findings for referential actions |
| D331 | 2026-02-21 | [3cf8ec51](https://github.com/prisma/orm/commit/3cf8ec5152095ab2914ef0582a9aece9e981d405) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-runtime): resolve decode schema refs by projection alias |
| D332 | 2026-02-21 | [dc6221fc](https://github.com/prisma/orm/commit/dc6221fc10a6e9dd02d4506ed18c20fb56454190) | results / development-fixup | no | inspected; no new concrete candidate | fix: adress comments, fix typecheck, restore string encoding for dates / intervals |
| D333 | 2026-02-23 | [8c921b14](https://github.com/prisma/orm/commit/8c921b1421755f0ff89ba866c75061b3f7434113) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix: lint, typecheck |
| D334 | 2026-02-23 | [fc7bd04d](https://github.com/prisma/orm/commit/fc7bd04d90ee17d3ce4eea7dcd4a0d699f8a4e95) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: escape JSON defaults with $type key via raw-tag wrapper |
| D335 | 2026-02-24 | [5a586386](https://github.com/prisma/orm/commit/5a586386f9495f615fd07180d96fbbc1ac44d12a) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): use centralized timeouts in progress-adapter test |
| D336 | 2026-02-24 | [5b7e9d82](https://github.com/prisma/orm/commit/5b7e9d82a4b91a2a20d53683669f7554ac365624) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix: typecheck |
| D337 | 2026-02-24 | [a74e1a6f](https://github.com/prisma/orm/commit/a74e1a6f46081223b0611987b96e6a0533a8c408) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: update the prototype to match the spec |
| D338 | 2026-02-24 | [e4714eba](https://github.com/prisma/orm/commit/e4714eba174ca0178b7c1c2a6bfe839db3ae7f9b) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(sql-orm-client): resolve pre-existing lint issues |
| D339 | 2026-02-25 | [a82ba068](https://github.com/prisma/orm/commit/a82ba0681c0ea4a8629fba68ec9f43d2f1adad28) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: address code review findings from multi-agent analysis |
| D340 | 2026-02-25 | [296d5f21](https://github.com/prisma/orm/commit/296d5f219c3b0e7dd2342561a11dc398ee471f0d) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: replace unsafe readonly casts with factory param in FK config tests |
| D341 | 2026-02-25 | [8dd035d8](https://github.com/prisma/orm/commit/8dd035d8effa15293c6d051c12f5bfeb86a4ebd5) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: account for FK-backing indexes in schema verifier and re-emit demo contract |
| D342 | 2026-02-25 | [b86ce8ac](https://github.com/prisma/orm/commit/b86ce8ac08886d9ae892e6d087086aa44a7efee7) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: fix 3 failing verifier tests and remove accidental file |
| D343 | 2026-02-25 | [a8deb931](https://github.com/prisma/orm/commit/a8deb93168e283f0bc4ee9d050f9bffe87328031) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(canonicalization): preserve nullable:true for columns with defaults |
| D344 | 2026-02-25 | [06bd2b83](https://github.com/prisma/orm/commit/06bd2b83d3f38d29144be23d6ea0379f1f23813b) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix(authoring): align test with nullable+default invariant |
| D345 | 2026-02-25 | [142d9454](https://github.com/prisma/orm/commit/142d945467f324101734fd6b7cc3da186e68e673) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(schema-verify): use stable key sorting for JSON literal comparison |
| D346 | 2026-02-25 | [60f69d5a](https://github.com/prisma/orm/commit/60f69d5a81405a542a1542bc7cf5446e763c1aa7) | results / development-fixup | no | inspected; no new concrete candidate | fix: use valid referential action in onUpdate mismatch test |
| D347 | 2026-02-27 | [c635c0ea](https://github.com/prisma/orm/commit/c635c0eab938a811d4f6fa4e7ca98f6886e80248) (+1 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(integration-kysely): extract limit from ValueNode.value for literal constants |
| D348 | 2026-02-27 | [b8be6149](https://github.com/prisma/orm/commit/b8be61492534b23d1a1e9f9ee992117353b18448) (+2 grouped) | query-engine / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(demo): explicit not-found semantics for getUserById, parity test improvements |
| D349 | 2026-02-27 | [be706730](https://github.com/prisma/orm/commit/be7067302105617cdd1e4eeeac39d89b3caccf95) (+1 grouped) | sql / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(kysely): replace unknown with object type in transformKyselyToPnAst |
| D350 | 2026-02-27 | [6a806460](https://github.com/prisma/orm/commit/6a8064606da87aca5593869207082bf3aaefeaeb) (+1 grouped) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix: typecheck errors from review implementation |
| D351 | 2026-02-27 | [062d019c](https://github.com/prisma/orm/commit/062d019ca87850415f7b3f0e8e76598238631eca) (+10 grouped) | results / development-fixup | no | inspected; no new concrete candidate | Fix ADR and lane documentation consistency. |
| D352 | 2026-02-27 | [53a8c343](https://github.com/prisma/orm/commit/53a8c343b89a83f4f537120d049f48aeec9ffa2b) (+2 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(integration-kysely): harden DML and expression node handling |
| D353 | 2026-02-27 | [c298f041](https://github.com/prisma/orm/commit/c298f041913743b4a3666fef808b95a6c336f241) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(integration-kysely): preserve typed traversal with compiled-shape compatibility |
| D354 | 2026-02-27 | [9974e120](https://github.com/prisma/orm/commit/9974e1208509f795c5c507cc093ce0b5b06a9e2c) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres): connect hidden runtime driver before first query |
| D355 | 2026-02-27 | [68e5997c](https://github.com/prisma/orm/commit/68e5997c5ee190e3346f5dcaae7d89c2358c7186) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres): support deferred binding via db.connect |
| D356 | 2026-02-27 | [91e5da62](https://github.com/prisma/orm/commit/91e5da6277facc9ecbd05c4d152e2ecd7699b6ba) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres): enforce single-connect semantics |
| D357 | 2026-02-27 | [f947a7b9](https://github.com/prisma/orm/commit/f947a7b957efad1d0cbeec9dda7c771c1fcf0492) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix(demo): remove unnecessary cast after arktype validation |
| D358 | 2026-02-27 | [53d230ac](https://github.com/prisma/orm/commit/53d230acc549bbfeee46b445e6988d67870fb5df) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres): fail fast on missing binding before runtime instantiation |
| D359 | 2026-02-27 | [ec0e3d26](https://github.com/prisma/orm/commit/ec0e3d26ac31234ba8d8d79f14afabe02d019507) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres): make connect() async, await driver before setting connected |
| D360 | 2026-02-27 | [b2d158c7](https://github.com/prisma/orm/commit/b2d158c7e6bf29051ae5840683a4d031c5e74802) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres): close URL pool on connect failure to avoid leaks |
| D361 | 2026-02-27 | [77d601fb](https://github.com/prisma/orm/commit/77d601fbe0a2b5d5518dbb760f401f7e237d5b57) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres): surface deferred runtime connect failures safely |
| D362 | 2026-02-28 | [5ea07a76](https://github.com/prisma/orm/commit/5ea07a7687128e73759200549f1db2e2fa2dd6ed) (+7 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: address PR 182 review feedback |
| D363 | 2026-02-28 | [b1a93e73](https://github.com/prisma/orm/commit/b1a93e73d80a819a9e7a846ec473808ec9c3b494) (+1 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(postgres): relax build-only compile input typing for cross-env typecheck |
| D364 | 2026-02-28 | [965e0cc0](https://github.com/prisma/orm/commit/965e0cc0be690a74fe10b35f14854ad5123dd3fb) | extensions / development-fixup | no | inspected; no new concrete candidate | fix(review): apply PR feedback on where interop and demo usage |
| D365 | 2026-02-28 | [e137a2a9](https://github.com/prisma/orm/commit/e137a2a98059b73dc74a18a9320d8463f5edc0f1) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): accept lane-built SqlQueryPlan in where() |
| D366 | 2026-02-28 | [400a95fa](https://github.com/prisma/orm/commit/400a95fa7f8abf948818fb4b9ee1d0d9e55cf3d5) | results / development-fixup | no | inspected; no new concrete candidate | fix(demo): narrow unknown row handling in Kysely examples |
| D367 | 2026-02-28 | [529e4792](https://github.com/prisma/orm/commit/529e4792f6e99e275e41a0ef6d790d9433fc6e8e) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(kysely-lane): restore contract-typed lane API and remove row-erasing casts |
| D368 | 2026-02-28 | [24d9eed9](https://github.com/prisma/orm/commit/24d9eed971037a0712075978e9c21a5d2f84cf5f) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): traverse OperationExpr.self in ParamRef detection/replace/index |
| D369 | 2026-02-28 | [c01cbecc](https://github.com/prisma/orm/commit/c01cbecc923db75592f19a14c15a6087734d1e75) | results / development-fixup | no | inspected; no new concrete candidate | fix: restore green lint and typecheck after review updates |
| D370 | 2026-03-01 | [1c6adf70](https://github.com/prisma/orm/commit/1c6adf7021f2d05faa1c48529b7aef8360988f14) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(architecture): include postgres extension runtime sources in dep graph mapping |
| D371 | 2026-03-01 | [56a6b579](https://github.com/prisma/orm/commit/56a6b579167b30fd8b647c806dce3eb8445f37fc) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix remaining CodeRabbit follow-ups for PR 182 |
| D372 | 2026-03-01 | [c752f267](https://github.com/prisma/orm/commit/c752f2673eaf7602e667332216b520bc32f03090) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(kysely-lane): align public entrypoint with exports convention |
| D373 | 2026-03-01 | [d2a7a356](https://github.com/prisma/orm/commit/d2a7a356fe30c77fd8e3db617cb35952bf954528) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): reject null where args at normalization boundary |
| D374 | 2026-03-01 | [3a5391c5](https://github.com/prisma/orm/commit/3a5391c566b04234e14cf74046d2b2195a6743f1) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): satisfy exact optional property semantics in emit failures |
| D375 | 2026-03-01 | [4d9772a3](https://github.com/prisma/orm/commit/4d9772a33770aca34e05d866d449c31f4c0a87c8) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(emission): enforce provenance-free IR and align output resolution |
| D376 | 2026-03-01 | [6dee90f1](https://github.com/prisma/orm/commit/6dee90f17bff3891df37de747b88e2c561d51ed3) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(contract-emit): enforce structural schema checks and show provider diagnostics |
| D377 | 2026-03-01 | [92c3ec1f](https://github.com/prisma/orm/commit/92c3ec1f3e0e2b15819fb26f12f35fb7173cbd96) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(rules): mark verify-paths-before-citing as always applied |
| D378 | 2026-03-01 | [1fef26e7](https://github.com/prisma/orm/commit/1fef26e7a3e6114b095ac35a40d0e71940d4dd51) (+1 grouped) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct spec ADR-006 reference to current filename. |
| D379 | 2026-03-01 | [b1ca4b2a](https://github.com/prisma/orm/commit/b1ca4b2aaf2c12aba8ce560378ef3b863b914822) | schema-relations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): align provider diagnostics and emit copy with review feedback |
| D380 | 2026-03-01 | [996e5717](https://github.com/prisma/orm/commit/996e571730403e2f2a0fb18fce0177e930a9c99f) | validation-types / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(scripts): make typecheck:all compatible with current turbo CLI. |
| D381 | 2026-03-01 | [f4f25ebb](https://github.com/prisma/orm/commit/f4f25ebba0b6ce74653b7197f4ce2111c4648b40) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(psl-parser): export referential action type |
| D382 | 2026-03-01 | [5f8e9434](https://github.com/prisma/orm/commit/5f8e94342536625ef4917657d30eb1fc217e71c7) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): surface contract provider failures as runtime errors |
| D383 | 2026-03-01 | [6c378895](https://github.com/prisma/orm/commit/6c378895684ef898050f31c3add0ece60c21603c) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): preserve source aborts and validate provider payloads |
| D384 | 2026-03-01 | [9a4bb1b2](https://github.com/prisma/orm/commit/9a4bb1b261c9b9e8f2cd1a951941184ddef3b883) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(sql-kysely-lane): tighten compile-free invariants and coverage |
| D385 | 2026-03-01 | [fdd8805c](https://github.com/prisma/orm/commit/fdd8805c3344c777e92f928086443de3a0495d9f) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(psl): guard enum collisions and forward provider options explicitly |
| D386 | 2026-03-01 | [641b031f](https://github.com/prisma/orm/commit/641b031fe9ff8b9821ea09d3d8a7b9e91f22d248) | schema-relations / development-fixup | no | inspected; no new concrete candidate | fix(rules): align ADR example rule frontmatter with schema |
| D387 | 2026-03-01 | [4d621798](https://github.com/prisma/orm/commit/4d6217980104b8f6720166ec49eb034e71279393) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(psl): accept hyphenated namespaces and enforce quoted @map literals |
| D388 | 2026-03-01 | [f03a62b3](https://github.com/prisma/orm/commit/f03a62b35ebe53e409926cf96558eba103fc78f1) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(rules): add required rule frontmatter metadata |
| D389 | 2026-03-03 | [a2fe10a0](https://github.com/prisma/orm/commit/a2fe10a00e9b10eb9d6f685f7fed089916999065) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): include relational input types in CreateInput (#202) |
| D390 | 2026-03-03 | [ecd9328e](https://github.com/prisma/orm/commit/ecd9328ea9607eac81ca500456127af56b62d295) (+16 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(postgres): restore foreign key SQL planner helper |
| D391 | 2026-03-03 | [0c2ad402](https://github.com/prisma/orm/commit/0c2ad402d6bcd9a34e40fbb6520fb7723674123a) (+6 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(config): exclude fixtures from shared config typecheck inputs |
| D392 | 2026-03-03 | [2140353d](https://github.com/prisma/orm/commit/2140353def116d673a7089aff3a545e1e1343dfe) (+6 grouped) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(ids): align nanoid descriptor length with configured size |
| D393 | 2026-03-04 | [3f1f10fd](https://github.com/prisma/orm/commit/3f1f10fd1a8d4188f78f6193c55a9542dcdffeec) | query-engine / runtime-or-schema-surface | no | **Y2 · confirmed affected** | fix(sql-orm-client): generate correct sql for upsert without update (#187) |
| D394 | 2026-03-04 | [0d59332d](https://github.com/prisma/orm/commit/0d59332d9ef19d959bfae92aebea9146b3ffe412) (+1 grouped) | extensions / development-fixup | no | inspected; no new concrete candidate | fix(security): patch vulnerable dependency graph |
| D395 | 2026-03-04 | [32e24cc5](https://github.com/prisma/orm/commit/32e24cc5e28b76a16603efecc88eb6677ac9506e) (+1 grouped) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | Correct blog link |
| D396 | 2026-03-04 | [596bd3e8](https://github.com/prisma/orm/commit/596bd3e8852ca5f16290a37f32d2f78455fce938) (+1 grouped) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(sql-contract-psl): apply PR feedback for relation lowering and tests |
| D397 | 2026-03-05 | [ab542579](https://github.com/prisma/orm/commit/ab542579ac0d7dcfd02a9306e4016070e04d189d) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): fix nested selection refinements (#220) |
| D398 | 2026-03-06 | [65488b04](https://github.com/prisma/orm/commit/65488b0426058e4a84a4aaf1e1e4b499499cad16) | schema-relations / development-fixup | no | inspected; no new concrete candidate | fix(contract-authoring): use `Record<never, never>` for initial model builder `Fields` type (#205) |
| D399 | 2026-03-06 | [9a09cefd](https://github.com/prisma/orm/commit/9a09cefd806cf0d41f309c7bfe0b83cc4847f844) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(sql-contract-ts): derive literal mapping types in `ContractBuilderMappings` (#206) |
| D400 | 2026-03-08 | [4a214d20](https://github.com/prisma/orm/commit/4a214d2066567ca02380eb3b1caf42f048c0c7e7) (+10 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(demo): replace non-null assertion and inline model type |
| D401 | 2026-03-11 | [97be17c8](https://github.com/prisma/orm/commit/97be17c8af72078070e38d08e710d4d067747124) (+16 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: avoid assigning undefined to exactOptionalProperty expandNativeType |
| D402 | 2026-03-17 | [dccf3fe9](https://github.com/prisma/orm/commit/dccf3fe9f8107aaf30f1f7b0fa8031f0469a9a5e) | schema-relations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): verify live schema in db verify by default (#237) |
| D403 | 2026-03-17 | [0043b0a3](https://github.com/prisma/orm/commit/0043b0a368ddfd3e2d250ef32e813812d63fb0b8) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): auto-enable JSON output when stdout is piped (#240) |
| D404 | 2026-03-20 | [9994169d](https://github.com/prisma/orm/commit/9994169d1eca0fe9c30bc8e2558c35d8f5fc22bb) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(normalizer): handle cast-wrapped timestamps, NULL defaults, and numeric overflow (#238) |
| D405 | 2026-03-23 | [f43560c5](https://github.com/prisma/orm/commit/f43560c55589e7570322f1e2f8e296278cd797fe) (+10 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(integration): update default-pack-slugid fixture for capabilities and extensionPacks |
| D406 | 2026-03-23 | [bc5b3255](https://github.com/prisma/orm/commit/bc5b325545eb42ad6878a12d6d5e3a0e87680306) (+6 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): increase timeout for root help formatting test |
| D407 | 2026-03-25 | [4429f8a7](https://github.com/prisma/orm/commit/4429f8a791784c3cc9980e92b2ebfd1f5bd3cb83) | extensions / development-fixup | no | inspected; no new concrete candidate | chore: remove obsolete ORM demo, stale docs, and dead project artifacts (#249) |
| D408 | 2026-03-25 | [2255ef1f](https://github.com/prisma/orm/commit/2255ef1fa6940aa59b29fcf3a90031fe283b7fd0) (+1 grouped) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(demo): remove unnecessary type assertions in backward cursor test |
| D409 | 2026-03-25 | [c420f791](https://github.com/prisma/orm/commit/c420f791e6b27de4a8ba8242c76b08366f7a7621) | results / development-fixup | no | inspected; no new concrete candidate | chore: update stale lockfile (#255) |
| D410 | 2026-03-25 | [4ac4377b](https://github.com/prisma/orm/commit/4ac4377b1eb1f03ca986378d780c300a8e2da468) (+1 grouped) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(demo): restore corrupted describe keyword in integration test |
| D411 | 2026-03-26 | [9fd4f0c4](https://github.com/prisma/orm/commit/9fd4f0c4d37cb805b231371a9437f767f4aeea10) (+2 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix: revert latency shouldBlock to AND semantics (matches integration test) |
| D412 | 2026-03-30 | [d773f532](https://github.com/prisma/orm/commit/d773f532bee224d0a730c78538979c6e08bb8f2c) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(planner): emit executable DDL for NOT NULL columns on non-empty tables (#241) |
| D413 | 2026-03-30 | [fcfaaa1a](https://github.com/prisma/orm/commit/fcfaaa1a89824d32c95c6f27f01273433be3e28f) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix: Build warnings in ORM client and SQL builder (#267) |
| D414 | 2026-03-31 | [2db50f57](https://github.com/prisma/orm/commit/2db50f572836205c556d99872e03f573186fc434) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(planner): resolve four planner/verifier bugs blocking reconciliation (#248) |
| D415 | 2026-03-31 | [2d06c5e3](https://github.com/prisma/orm/commit/2d06c5e3a0f7c44c224e0a36994b9d8fb1df8310) (+10 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix code block language tags and replace inline planning-doc links |
| D416 | 2026-03-31 | [d3cff3cc](https://github.com/prisma/orm/commit/d3cff3ccbd1d8c6d8d3c03dcfaf65423fbc804f6) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(pgvector): use the correct lowering for `cosineDistance` (#270) |
| D417 | 2026-04-01 | [298238d3](https://github.com/prisma/orm/commit/298238d3d030af49c134b860c680bcf2f806baad) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): don't type required to-one relations as nullable (#269) |
| D418 | 2026-04-01 | [e73d362a](https://github.com/prisma/orm/commit/e73d362ad706891f003410eb400d2ad2b59715d6) (+5 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(sql-contract): harden normalizeContract dual-format bridge |

| D419 | 2026-04-01 | [e2033a62](https://github.com/prisma/orm/commit/e2033a62c6eb2c4ebf4b9f4515c304f84b5808a4) (+2 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: restore demo contract.d.ts from main after rebase |
| D420 | 2026-04-01 | [fb53f959](https://github.com/prisma/orm/commit/fb53f959048f520393a026908bc5cea4b34be1c9) (+1 grouped) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(emitter,sql-orm-client): apply mutation defaults (#272) |
| D421 | 2026-04-02 | [d5c06a83](https://github.com/prisma/orm/commit/d5c06a833efbeac2479f5b7d5ba702577c1a81c8) (+8 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix(sql-orm-client): improve error messages in resolveIncludeRelation and resolveModelTableName |
| D422 | 2026-04-02 | [1d4f3d37](https://github.com/prisma/orm/commit/1d4f3d37d5fa53ea1ee3e2a73b47bb9c13f06878) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): add missing codec annotations to the plan (#284) |
| D423 | 2026-04-02 | [3016a2e6](https://github.com/prisma/orm/commit/3016a2e68c142324eb3c1822c0cc9420c0401b48) (+11 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix: remove non-null assertions in validate-domain.ts |
| D424 | 2026-04-02 | [82599064](https://github.com/prisma/orm/commit/82599064ed8b40986c15870b64fc8aba1447369c) (+9 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(postgres): make test mock match ExpandNativeTypeInput signature |
| D425 | 2026-04-03 | [3f065261](https://github.com/prisma/orm/commit/3f065261fed78734b8a9fa748288f60943ba9377) (+3 grouped) | validation-types / provider-outside-viborm | no | inspected; no new concrete candidate | fix cyclic dependency and typecheck errors |
| D426 | 2026-04-03 | [3756df7a](https://github.com/prisma/orm/commit/3756df7a51eb984a985a0c7894ebff9150ad165d) (+1 grouped) | schema-relations / provider-outside-viborm | no | inspected; no new concrete candidate | Fix typecheck and lint errors in mongo-contract-psl |
| D427 | 2026-04-03 | [029a8cb9](https://github.com/prisma/orm/commit/029a8cb9c669ab7e46b251e4057ea8c42a933201) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | revert ExecutionSection.executionHash to optional |
| D428 | 2026-04-04 | [4a0b73aa](https://github.com/prisma/orm/commit/4a0b73aa1b75c1e00d5e639f57a41dc9ec378335) (+9 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo-demo): guard main() to prevent auto-start on import |
| D429 | 2026-04-04 | [9a7d670f](https://github.com/prisma/orm/commit/9a7d670fe99a8e426d9e335c2d567f3ab2a326e5) (+13 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix: align ContractSourceProvider signatures in docs with actual type |
| D430 | 2026-04-04 | [132ba5f1](https://github.com/prisma/orm/commit/132ba5f19a8cc0b40b84c92a1cdf124e6aa8bbad) (+2 grouped) | query-engine / provider-outside-viborm | no | inspected; no new concrete candidate | fix SQL schema package path in contract README |
| D431 | 2026-04-05 | [a0b951aa](https://github.com/prisma/orm/commit/a0b951aa4fc62a046493b68d4fe7b01811ff8216) (+4 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix updateAll re-read to use _id, reject includes on write terminals |
| D432 | 2026-04-05 | [d4a36943](https://github.com/prisma/orm/commit/d4a36943a78281da6decb1b792ffc3ea4e44b256) (+13 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(demo): validate parsed limit before query execution |
| D433 | 2026-04-06 | [83599995](https://github.com/prisma/orm/commit/83599995e21c55023e2c050b0072fa75afe56782) (+18 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix: use serializeValue for all storage literals in emitter |
| D434 | 2026-04-06 | [46d07e55](https://github.com/prisma/orm/commit/46d07e55dcaafad8ea0027417427b90471623e4d) (+1 grouped) | validation-types / development-fixup | no | inspected; no new concrete candidate | Regenerate lockfile to fix stale workspace symlinks |
| D435 | 2026-04-06 | [45b89488](https://github.com/prisma/orm/commit/45b89488c8f2c077cf325907ba9db449bcd5d8c8) (+2 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | Fix MongoRuntime.execute signature in subsystem doc to include Row generic |
| D436 | 2026-04-06 | [a3eaaac2](https://github.com/prisma/orm/commit/a3eaaac2f4a1b17108e399dd015ba64947724110) (+4 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix self-referencing package import in control-migration-types |
| D437 | 2026-04-06 | [2df982d2](https://github.com/prisma/orm/commit/2df982d28400193d0a766df8a975683b7905553e) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix post-rebase issues: unused import, type cast, missing dep, regenerate fixtures |
| D438 | 2026-04-06 | [b6ae0176](https://github.com/prisma/orm/commit/b6ae017678023b5cd7517f8acd553fd0d1fa5d77) (+1 grouped) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: resolve typeRef to inline typeParams on model fields at emit time |
| D439 | 2026-04-07 | [d345bd82](https://github.com/prisma/orm/commit/d345bd82e6be255afd6f7911cdfbb54ec5d8552b) (+2 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix scoped variable references to use $$ syntax in tests |
| D440 | 2026-04-07 | [4bbe7ab4](https://github.com/prisma/orm/commit/4bbe7ab4c64928406db5cd98af9360bd2dd3eaf7) | extensions / development-fixup | no | inspected; no new concrete candidate | fix: address code review findings (F01, F03, F04, F07) |
| D441 | 2026-04-07 | [8d2cc5e4](https://github.com/prisma/orm/commit/8d2cc5e42ebc692cfc06b000c42e18cec4b64bc4) (+8 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo-emitter): cast field to expected shape in validateTypes |
| D442 | 2026-04-07 | [43f81c31](https://github.com/prisma/orm/commit/43f81c31f7f5bac4f5cd20ff5a249a94496f25ca) (+2 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix: remove stale tier-prefix examples from review skill, validate lookup() root |
| D443 | 2026-04-07 | [dfa27aa0](https://github.com/prisma/orm/commit/dfa27aa029df2a0d05fa20f0725354d1c99ff77c) (+7 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix: address review feedback for value-object authoring and types |
| D444 | 2026-04-08 | [4f9d4134](https://github.com/prisma/orm/commit/4f9d41344bf13acc297c90f2fe15b7d0cf7490e1) (+7 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix: use top-level ServerResponse import in mongo-demo server |
| D445 | 2026-04-08 | [5295f1c8](https://github.com/prisma/orm/commit/5295f1c84f9f296f55e2527707dee048297a33f9) (+2 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | Fix post-rebase: remove TypeRenderer, update FieldOutputTypes type tests |
| D446 | 2026-04-08 | [acb428f1](https://github.com/prisma/orm/commit/acb428f1a47e36b5c14a0696f89474a4ea61a6d2) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | Fix ExtractCodecId to handle direct codecId on contract fields |
| D447 | 2026-04-09 | [5ced9f2e](https://github.com/prisma/orm/commit/5ced9f2e09be8fc4c54ccfb3f193400223bd387b) (+6 grouped) | query-engine / provider-outside-viborm | no | inspected; no new concrete candidate | fix(sql-orm-client): remove unused OrderByDirective and OrderExpr imports |
| D448 | 2026-04-10 | [88c204eb](https://github.com/prisma/orm/commit/88c204ebf182b6c5f923a701a8a1bea674807242) (+8 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(sql-orm-client): include variantTable in merged column map cache key |
| D449 | 2026-04-10 | [387cf675](https://github.com/prisma/orm/commit/387cf6759dd972e6279215a5bdef381aaea0b5bc) (+8 grouped) | query-engine / provider-outside-viborm | no | inspected; no new concrete candidate | Fix broken import: use subpath for mongo-query-ast |
| D450 | 2026-04-12 | [34ea0757](https://github.com/prisma/orm/commit/34ea0757e5ad2d1cb8f7a766150e3fa7f4186a8e) (+11 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | Fix typecheck: add null to parseCollation return type, fix getIndexes parameter type |
| D451 | 2026-04-13 | [bb4a82ec](https://github.com/prisma/orm/commit/bb4a82ec718955ef859239687875dd647575f9e4) (+14 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix cart validation, string casts, unmount guard, and test accuracy |
| D452 | 2026-04-14 | [ecd9cc06](https://github.com/prisma/orm/commit/ecd9cc065f29d2e83c8bcfa1be7a57f9255b33cb) (+8 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: remaining CI failures — unused imports, snapshot label, TS2379 exactOptionalPropertyTypes |
| D453 | 2026-04-14 | [17fd2dc7](https://github.com/prisma/orm/commit/17fd2dc7addee0001422cdadf1826af7b4c48b4f) (+6 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | revert: remove MONGOMS_VERSION pin from ci.yml |
| D454 | 2026-04-15 | [353ca664](https://github.com/prisma/orm/commit/353ca6643dceb142afd82ef7e81bc3e8014049d0) (+6 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo-query-ast): export isMongoFilterExpr from execution barrel |
| D455 | 2026-04-15 | [ede63129](https://github.com/prisma/orm/commit/ede63129412e8dfc09170ec2e69cc50752e1500c) (+5 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | Add missing mongo-lowering dep for cross-family integration test |
| D456 | 2026-04-15 | [9a329552](https://github.com/prisma/orm/commit/9a329552eaca75750ced89157e56331d74dba861) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix lockfile |
| D457 | 2026-04-15 | [69226a50](https://github.com/prisma/orm/commit/69226a5050cc4db3aa7d4dcbdb58871c68c0be73) | validation-types / development-fixup | no | inspected; no new concrete candidate | fix(retail-store): configure Turbo build outputs for Next.js (#343) |
| D458 | 2026-04-16 | [315d4a36](https://github.com/prisma/orm/commit/315d4a361c6d0beac466f0a4056196273618716a) (+22 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix(cli): validate and normalize schema path input in init command |
| D459 | 2026-04-16 | [31ce5a75](https://github.com/prisma/orm/commit/31ce5a75e5e379a3f166b4c4cb44f241c5472697) (+7 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(integration): use Promise.allSettled in afterAll teardown |
| D460 | 2026-04-16 | [8a68f14b](https://github.com/prisma/orm/commit/8a68f14bdb2b1b455f08121ec738dbf41c65bf19) (+2 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(target-mongo): emit { enabled: false } when CSPPI is removed from dest |
| D461 | 2026-04-17 | [9ae33cf4](https://github.com/prisma/orm/commit/9ae33cf4e9d537c1437c5e6621934a6c7f9e4cd3) (+9 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | Fix typecheck: guard against empty codec targetTypes in SQL provider |
| D462 | 2026-04-19 | [7cc4b160](https://github.com/prisma/orm/commit/7cc4b160ec3c5ba406ee4b4e0b0addaa5bb1b576) | extensions / development-fixup | no | inspected; no new concrete candidate | Fix shim README: prisma-next has no library exports |
| D463 | 2026-04-19 | [21a24dd1](https://github.com/prisma/orm/commit/21a24dd117fba5d18030bfd67ff3890cb4aa7b3b) (+2 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix: address CodeRabbit review findings |
| D464 | 2026-04-20 | [226a683a](https://github.com/prisma/orm/commit/226a683a7a13d25c3651b81d61eb200bccaab37d) (+1 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): catch assertFrameworkComponentsCompatible throws in migration new |
| D465 | 2026-04-21 | [e76cbab2](https://github.com/prisma/orm/commit/e76cbab28faa7854879884cd0c568f6846f23415) (+7 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo-runner): guard evaluateDataTransformChecks against non-aggregate commands (A06) |
| D466 | 2026-04-21 | [f93b57b5](https://github.com/prisma/orm/commit/f93b57b51fb86895e0d58835a722b17580ae1ac0) (+4 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(family-mongo): allow data-transform ops in user-authored migrations |
| D467 | 2026-04-21 | [a5381c2c](https://github.com/prisma/orm/commit/a5381c2c97ea81b78b475b33d117d810a1d4a6f6) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(retail-store): typecheck migrations and use f.raw() for backfill (TML-2281 review F12/F13) |
| D468 | 2026-04-21 | [1cf36a1f](https://github.com/prisma/orm/commit/1cf36a1f8007bbc56afc39c7b2364c151c4fc2dd) (+3 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(target-mongo): iterate import map in insertion order to avoid unreachable fallback |
| D469 | 2026-04-22 | [58810188](https://github.com/prisma/orm/commit/5881018814511c89aea4c48b5398ebff17e8480b) (+5 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix: address CI failures after contract artifact rename |
| D470 | 2026-04-22 | [73125a32](https://github.com/prisma/orm/commit/73125a32937e440fee52a84b295a01fa37801972) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(vite): watch resolved inputs and avoid self-trigger loops (#362) |
| D471 | 2026-04-24 | [fa974264](https://github.com/prisma/orm/commit/fa97426458ce0cca650bcc25d5426d36b5697c9e) (+4 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(migration): normalize existing.hints on self-emit |
| D472 | 2026-04-26 | [cd17e079](https://github.com/prisma/orm/commit/cd17e079cb46717fd686231f4dc554205b3150af) (+7 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): harden MigrationCLI argv parsing and target probe |
| D473 | 2026-04-27 | [c30c6b4a](https://github.com/prisma/orm/commit/c30c6b4ada791345a47a989339b3ebd0fa4985e0) (+14 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo): fail loudly on whitespace-only explicit dbName + invariant on unreachable branch |
| D474 | 2026-04-27 | [a64b23ce](https://github.com/prisma/orm/commit/a64b23ceba33379064e9a7b538f9293bebf153e6) (+5 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(target-mongo): keep semantic option families visible when contract omits them |
| D475 | 2026-04-28 | [77f65f6f](https://github.com/prisma/orm/commit/77f65f6f9d643097454b982e4443b10f0ad060e1) (+2 grouped) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-runtime): propagate rewritten meta through beforeCompile |
| D476 | 2026-04-28 | [91e6c87b](https://github.com/prisma/orm/commit/91e6c87b349c61bc213565344c6f52a54ea6f985) (+1 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): correct migration plan next-step message |
| D477 | 2026-04-28 | [5607521b](https://github.com/prisma/orm/commit/5607521bc6e4d4132a32b18510b7062ce31896ad) (+1 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): return structured envelope on unexpected migration-load failure (A12a) |
| D478 | 2026-04-28 | [f2fb717e](https://github.com/prisma/orm/commit/f2fb717e33d7d863931bed90db3bd12070aaf048) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): make contract emission atomic and serialized under rapid saves (#365) |
| D479 | 2026-04-29 | [75879e5e](https://github.com/prisma/orm/commit/75879e5e9192964933104c093ea102a8caa3b598) (+1 grouped) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(adapter-postgres): annotate composed control-adapter helper return type |
| D480 | 2026-04-29 | [cc1d63e5](https://github.com/prisma/orm/commit/cc1d63e533fcb46f508a8a7c213d6062c2798625) (+2 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo-contract-ts): dedup indexes after polymorphic scoping |
| D481 | 2026-04-30 | [0e4d56d4](https://github.com/prisma/orm/commit/0e4d56d4988afd9653bf6807c86a156828f10c98) (+8 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(review-triage): only scaffold actions for implement-supported target kinds |
| D482 | 2026-04-30 | [f5f130df](https://github.com/prisma/orm/commit/f5f130dffe771e654dae5f7c2e4330855771d984) | migrations / development-fixup | no | inspected; no new concrete candidate | feat(migration-tools): fail-fast on stale contract bookends in buildMigrationArtifacts |
| D483 | 2026-05-01 | [a16ddf22](https://github.com/prisma/orm/commit/a16ddf22e282107e70a3e2d23da1f61e836a481f) | validation-types / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): preserve prior process.exitCode + detect empty --config values (TML-2318) |
| D484 | 2026-05-01 | [a6b397eb](https://github.com/prisma/orm/commit/a6b397eb1a8179774b2dda6d0020be6a7cf9be2c) (+1 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(migration): reject describe() returning from: "" (TML-2270) |
| D485 | 2026-05-01 | [3c32929e](https://github.com/prisma/orm/commit/3c32929efd307b2f886c2b0bc1c723b75c37eaf2) (+6 grouped) | query-engine / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(psl): preserve original storage label on normalised enum members |
| D486 | 2026-05-01 | [719ba2c0](https://github.com/prisma/orm/commit/719ba2c0a348ac3999648b7219b42b8936a68de0) (+11 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix(framework-components): sort imports in runtime-core-options.test.ts (biome) |
| D487 | 2026-05-01 | [6ef341b0](https://github.com/prisma/orm/commit/6ef341b0dff86a721726fe2728ff53f94dfabbe1) (+2 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(sql-runtime): organize encoding.ts imports for biome (CI lint) |
| D488 | 2026-05-01 | [f8dc7fd2](https://github.com/prisma/orm/commit/f8dc7fd2a34721c8ba4cb74d7b267d7659779875) (+3 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo-runtime): pass through subdocument keys at nested document slots (TML-2324) |
| D489 | 2026-05-01 | [3dc7b615](https://github.com/prisma/orm/commit/3dc7b615e4c25f65f73f3031960ed25a47de1be1) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(target-postgres): type plan() fromContract as framework Contract for variance |
| D490 | 2026-05-06 | [57c00078](https://github.com/prisma/orm/commit/57c0007840797b987f95c17dc1d3e4412eb6b08a) | extensions / development-fixup | no | inspected; no new concrete candidate | fix(agents): correct test infra docs — suites are self-contained |
| D491 | 2026-05-07 | [91a18538](https://github.com/prisma/orm/commit/91a185386dbe0c371e4c648b501a64c11a4aaa97) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): selectIncludeStrategy reads namespaced capability flags (#425) |
| D492 | 2026-05-09 | [fc50851e](https://github.com/prisma/orm/commit/fc50851e9a627cdb5ecde909acce5ade0a49537f) (+1 grouped) | extensions / development-fixup | no | inspected; no new concrete candidate | fix(audit-notice): match workspace package paths on Windows separators |
| D493 | 2026-05-09 | [433abee2](https://github.com/prisma/orm/commit/433abee22957511c193def68866609d0c005fc44) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): disable ANSI colors in vitest env for stable snapshots |
| D494 | 2026-05-09 | [a5fb5116](https://github.com/prisma/orm/commit/a5fb51160d7cfb80d2a879de184f9cbf148e5c16) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(migration): normalize OnDiskMigrationPackage.dirPath to absolute |
| D495 | 2026-05-10 | [1a745eaa](https://github.com/prisma/orm/commit/1a745eaae30b547c4bcbc35fd3a9deb01424a938) (+2 grouped) | results / development-fixup | no | inspected; no new concrete candidate | revert: restore arktypeJson fixtures (revert "test: refresh fixtures for arktype 2.2 and tsdown dts limits") |
| D496 | 2026-05-10 | [90873680](https://github.com/prisma/orm/commit/9087368045c2972b9f9b93705ecade573e71561e) (+9 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(migration): preserve verifyAggregate Result contract on introspection throws |
| D497 | 2026-05-10 | [bbe52ea4](https://github.com/prisma/orm/commit/bbe52ea4aeb90f94175da19f9e00935d5d0a7eed) (+5 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(migration): guard readInvariantId against prototype-inherited invariantId |
| D498 | 2026-05-10 | [16e2ba12](https://github.com/prisma/orm/commit/16e2ba12532f2e16bbb65681bf055d65160cc752) (+2 grouped) | query-engine / development-fixup | no | inspected; no new concrete candidate | review(coderabbit): drop transient spec/milestone refs and fix runDbInit cleanup leak |
| D499 | 2026-05-11 | [6caef7a7](https://github.com/prisma/orm/commit/6caef7a75d242c7174d6b535309a23d63ae67f09) (+11 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(cli): name the user-supplied --ref in migration apply diagnostics |
| D500 | 2026-05-11 | [10805b02](https://github.com/prisma/orm/commit/10805b021b32373a34a43c1a3689e8d536b33777) (+2 grouped) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-relational-core): narrow ParamRefEntry codecId before replaceValue |
| D501 | 2026-05-11 | [f39a42cb](https://github.com/prisma/orm/commit/f39a42cb6c370719734540c7920fd1ae2aa288d1) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): scope update()/delete() to a single row (#435) |
| D502 | 2026-05-11 | [84e9d887](https://github.com/prisma/orm/commit/84e9d887058130ff2f7bc99c091cf135ab0f534d) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-runtime): tolerate missing marker table (#483) |
| D503 | 2026-05-12 | [a8a576b3](https://github.com/prisma/orm/commit/a8a576b3f16457c2d5eee5f802b19257bf99dffd) | schema-relations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli-init): import only from facade in scaffolded TS contract (TML-2485) |
| D504 | 2026-05-12 | [1fc2c1fd](https://github.com/prisma/orm/commit/1fc2c1fdecb109b70e04617de085068d08089ec2) (+5 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(target-postgres): align installExtension SQL with prior emitted bytes |
| D505 | 2026-05-12 | [4c8c9bc5](https://github.com/prisma/orm/commit/4c8c9bc536d6060ea2234721479cfd7a1445b3fe) (+6 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): align raw extension-pack filtering with canonical contractSpace semantics |
| D506 | 2026-05-12 | [81df2d2f](https://github.com/prisma/orm/commit/81df2d2f7971f93f7e0e6d6107272f5d0b3a4014) (+4 grouped) | query-engine / provider-outside-viborm | no | inspected; no new concrete candidate | fix(target-mongo): preserve prototype-bound payload values in stripUndefinedDeep |
| D507 | 2026-05-12 | [05f9406c](https://github.com/prisma/orm/commit/05f9406c964bc4b8dc9ab286fdb194beecdd6072) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(extension-arktype-json, sql-runtime): correctness gaps from ADR 208 landing (#418) |
| D508 | 2026-05-12 | [5dddd51b](https://github.com/prisma/orm/commit/5dddd51b4308cd7dadabbfa7a98b3393db12b9f7) (+1 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli/init): normalise non-string package.json "type" to "module" |
| D509 | 2026-05-12 | [eb2b1050](https://github.com/prisma/orm/commit/eb2b105061a07171d65762af1ce54e937d34e75a) (+6 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(postgis): port descriptor-meta to CodecRef-based codecOf/toExpr API |
| D510 | 2026-05-13 | [767e8790](https://github.com/prisma/orm/commit/767e879045b8310dc45a4220fe7ec8fabd0307f4) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(target-sqlite): add missing standard-schema dependency (#498) |
| D511 | 2026-05-13 | [2da92fe0](https://github.com/prisma/orm/commit/2da92fe04cbfd03e6142147510acfbf2729f04e6) (+2 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(target-mongo): enforce _id === space invariant on every marker read and CAS |
| D512 | 2026-05-13 | [7a2c2cdc](https://github.com/prisma/orm/commit/7a2c2cdce7119770c7d28f7bba67e0b7d3ae22cc) | extensions / development-fixup | no | inspected; no new concrete candidate | Clean stale references across Supabase project docs |
| D513 | 2026-05-14 | [938e84fb](https://github.com/prisma/orm/commit/938e84fb1b5d3a5fa7f475292e452995419e5454) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(adapter-postgres): set testTimeout on reconciliation afterEach hook |
| D514 | 2026-05-14 | [bfcb8e9e](https://github.com/prisma/orm/commit/bfcb8e9e3a43fd0393c7a8c594e19fea3c4504e0) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(adapter-postgres): introspect composite index columns in index order (TML-2516) |
| D515 | 2026-05-15 | [dc6dd1ac](https://github.com/prisma/orm/commit/dc6dd1ac70a8f15f5e44373ea84324a090393c72) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): pass database url to postgres init helper (#510) |
| D516 | 2026-05-16 | [312be599](https://github.com/prisma/orm/commit/312be599718aec8b5cb1cedb09d0d953c5906ea2) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): redact credentials, drop unsupported --reinit, surface pm-aware skill install command |
| D517 | 2026-05-16 | [055ae67b](https://github.com/prisma/orm/commit/055ae67bfeb5b58a826a205d6b328eb87386520a) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): omit "skills registered" next-step when install was skipped |
| D518 | 2026-05-16 | [f79849d6](https://github.com/prisma/orm/commit/f79849d6b6cd37036f556686514aedbdbc738e53) (+3 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(migration-tools): drop stale `signature` strip in computeMigrationHash |
| D519 | 2026-05-17 | [009b29d7](https://github.com/prisma/orm/commit/009b29d782c32fd1661b21f7a74df137ed279aaa) (+2 grouped) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(scripts): point check-upgrade-coverage at the new skill cluster paths |
| D520 | 2026-05-18 | [f32ffff6](https://github.com/prisma/orm/commit/f32ffff6653bb08efba71890761f5f3213f2b336) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): install prisma next skills for claude (#528) |
| D521 | 2026-05-18 | [285bd22e](https://github.com/prisma/orm/commit/285bd22e707a3b3a72a1ffa32e8bdd9899ad54f5) (+11 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): address code-correctness issues found in review |
| D522 | 2026-05-19 | [1afd4aa8](https://github.com/prisma/orm/commit/1afd4aa8a411c2d7e32fb52d389cf44ba19b4557) (+3 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): keep on-disk contract reads at the `as unknown` seam |
| D523 | 2026-05-19 | [baa58473](https://github.com/prisma/orm/commit/baa584730b574d971eebf0d909a2521f9ea7889c) (+1 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix: correct broken relative link in drive/retro/README.md |
| D524 | 2026-05-19 | [54d7ab14](https://github.com/prisma/orm/commit/54d7ab1408ebfaf93bdbe6d420d51331472535f1) (+1 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(scripts): throw on reversed same-major range in coverageTransitionChain |
| D525 | 2026-05-20 | [32aa5812](https://github.com/prisma/orm/commit/32aa581272e944dc0606e086feb9ab84ea9f503f) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): source `--version` from `package.json` (TML-2517) |
| D526 | 2026-05-20 | [61fb57da](https://github.com/prisma/orm/commit/61fb57da6c1b27d5c0e2a6db86e1aa793cbd9cef) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: add username to prisma next starter user |
| D527 | 2026-05-20 | [60d31d60](https://github.com/prisma/orm/commit/60d31d605cb0e0cb3c7f2245d7e246f5263de4a3) (+10 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): allow async afterFirstTelemetryConsent and await its result |
| D528 | 2026-05-21 | [ebbfedc2](https://github.com/prisma/orm/commit/ebbfedc24a6f177fffe428b1fc758216ee5f82bc) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(drive-discussion): repair SKILL.md YAML frontmatter |
| D529 | 2026-05-21 | [f27a3657](https://github.com/prisma/orm/commit/f27a3657413078e673330cb1207786cf230966da) | query-engine / provider-outside-viborm | no | inspected; no new concrete candidate | fix(close): address teardown edge cases in sqlite, mongo, postgres facades |
| D530 | 2026-05-21 | [670fca44](https://github.com/prisma/orm/commit/670fca44e90cdf51939ebb952b3222a4d0787343) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): install skills with no-install init (#563) |
| D531 | 2026-05-21 | [bb7a0d7a](https://github.com/prisma/orm/commit/bb7a0d7a79e53e123d61a5ca929cfa0253b9db92) (+7 grouped) | results / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo): construct MongoStorage class instances in both authoring builders |
| D532 | 2026-05-21 | [34ed2cd2](https://github.com/prisma/orm/commit/34ed2cd28b3ad1599968e67bcf7b0ca2b96559a6) (+4 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(sql-orm-client): force descendant localColumns into nested child selectedForQuery |
| D533 | 2026-05-21 | [a7316380](https://github.com/prisma/orm/commit/a731638056c111c2bd6cea515ecfa89e76ee1fb5) (+3 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli-telemetry): collapse databaseTarget IPC override to string (drop unneeded null variant) |
| D534 | 2026-05-22 | [d8dd8d08](https://github.com/prisma/orm/commit/d8dd8d08a6b3f3a7028808e1c891e0a31f1fe599) | extensions / provider-outside-viborm | no | inspected; no new concrete candidate | fix(cli/init): ship a standalone Mongo DATABASE_URL placeholder |
| D535 | 2026-05-22 | [311ce662](https://github.com/prisma/orm/commit/311ce6620f2046891ec5ca4579d147a4577b4c9a) | schema-relations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): reject mismatched --authoring/--schema-path in init (TML-2652) |
| D536 | 2026-05-22 | [152779fe](https://github.com/prisma/orm/commit/152779feab19e9217b60e5cb623cf44d83bed8fd) (+9 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(errors): recommend db sign after deleting corrupt marker row |
| D537 | 2026-05-22 | [89562657](https://github.com/prisma/orm/commit/8956265787d56c8872cf40674047a998a4ca9345) (+2 grouped) | schema-relations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli/init): correct generator attribution in scaffold README templates |
| D538 | 2026-05-22 | [47d8555c](https://github.com/prisma/orm/commit/47d8555cf99eadd480e5837de61a23b9e21029f5) (+2 grouped) | schema-relations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): address CodeRabbit findings on c2-format-flag |
| D539 | 2026-05-22 | [e10cdc47](https://github.com/prisma/orm/commit/e10cdc47f8146f94d0747752460f27a75f6c4434) (+2 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli/init): seed agent skill dirs before consolidated skills add |
| D540 | 2026-05-22 | [1f72e867](https://github.com/prisma/orm/commit/1f72e867803f5e8c00ecca28be7255ff554607a9) (+17 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(integration): drop stale init scaffold family/target import assertions |
| D541 | 2026-05-22 | [95429f69](https://github.com/prisma/orm/commit/95429f692c7c258aab4b89eb809aa9df38d88098) (+2 grouped) | schema-relations / toolchain-outside-viborm | no | inspected; no new concrete candidate | Revert "feat(cli/init): warn on legacy prisma/ layout when re-initialising" |
| D542 | 2026-05-27 | [0a10c304](https://github.com/prisma/orm/commit/0a10c3042a63a20e42da31d09809a3b4fd8c7b72) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres,sqlite): drop Capabilities from facade defineContract types |
| D543 | 2026-05-27 | [9738b427](https://github.com/prisma/orm/commit/9738b427824b38222e0546b08f3b8ebd00e93798) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(types): adapt to @types/node 25's stricter Uint8Array/BufferSource shapes |
| D544 | 2026-05-27 | [59cc4959](https://github.com/prisma/orm/commit/59cc4959d3dc5fe3e95074cb6475a2c51bcd83ef) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo): omit undefined optional fields when deserializing createIndex |
| D545 | 2026-05-28 | [96318b74](https://github.com/prisma/orm/commit/96318b74fc02716d20d8dc639b7065f153025dd8) (+2 grouped) | results / development-fixup | no | inspected; no new concrete candidate | fix(integration): extract driver descriptor to keep types narrow (TML-2693) |
| D546 | 2026-05-28 | [42339777](https://github.com/prisma/orm/commit/423397771733eb6f1ff30e33cfd2f76132b9e071) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: preserve FK referential actions in schema IR (#608) |
| D547 | 2026-05-28 | [7b95be1d](https://github.com/prisma/orm/commit/7b95be1d9aed06dad59aa539c15a987457defc52) (+3 grouped) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): reapply orderBy after the ROW_NUMBER dedup wrap in scalar path |
| D548 | 2026-05-29 | [59dcce51](https://github.com/prisma/orm/commit/59dcce51f59ed7266b446a6e0ecda3612a29b181) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(drive-discussion): emit falsified-assumption on T3 only, not T3+T4 |
| D549 | 2026-05-29 | [034ac56f](https://github.com/prisma/orm/commit/034ac56fc1f54f302846f9e9e19980830e707f65) (+1 grouped) | schema-relations / development-fixup | no | inspected; no new concrete candidate | fix(ts-render): preserve distinct aliases and split invalid type-only default+named imports |
| D550 | 2026-05-29 | [26784548](https://github.com/prisma/orm/commit/26784548982ebfba551c0afe12ea6aab9068e199) (+1 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(migration): make upgrade codemod migrationHash replacement whitespace-tolerant |
| D551 | 2026-05-29 | [ed8aba1c](https://github.com/prisma/orm/commit/ed8aba1cb2864ee7c5a0f4aeb7b98abc150f21b1) | extensions / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo): fix validator-widen dev loop (TML-2688 + TML-2689) |
| D552 | 2026-05-29 | [fe8cd6e7](https://github.com/prisma/orm/commit/fe8cd6e7252f8fcf8a26dbb1538077196780d3d7) (+6 grouped) | results / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(relational-core): give RawExpr a distinct 'raw-expr' kind to stop isQueryAst misclassification |
| D553 | 2026-05-30 | [5a32a1bb](https://github.com/prisma/orm/commit/5a32a1bbb0f596aa93309fe8f6248f70b9e141e8) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(drive-record-traces): eliminate bare as-cast in parsePayload |
| D554 | 2026-05-30 | [17b7c56c](https://github.com/prisma/orm/commit/17b7c56cf104badea9d543195d7d0a0cd216e560) (+7 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(cli): use contract shell when status loads aggregate offline |
| D555 | 2026-05-30 | [aae0ef2d](https://github.com/prisma/orm/commit/aae0ef2d49c0d603535f0a1732f1d9bb02c97ad6) (+7 grouped) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(verify): verify enums per namespace so same-name enums do not collapse |
| D556 | 2026-05-31 | [0c359d0f](https://github.com/prisma/orm/commit/0c359d0f480ac4ab3096230b665354c609e43f2b) (+2 grouped) | migrations / provider-outside-viborm | no | inspected; no new concrete candidate | fix(mongo-runtime): fail-loud content hash + honest pre-resolve middleware contract (TML-2376) |
| D557 | 2026-06-01 | [67633a7f](https://github.com/prisma/orm/commit/67633a7ffaf27cc84e7bb74b9849056a9f08460d) (+16 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): honor hashLength in tree graph hash abbreviation |
| D558 | 2026-06-01 | [881031bd](https://github.com/prisma/orm/commit/881031bd800960d4ca8aeaccd6ff2443390e4aa0) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(telemetry-backend): add telemetry contract hash advance migration |
| D559 | 2026-06-01 | [f78139ae](https://github.com/prisma/orm/commit/f78139aebd7f3ffe7f31fa40e8227eaab84295c6) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(telemetry-backend): correct telemetry migration target hash |
| D560 | 2026-06-02 | [df327682](https://github.com/prisma/orm/commit/df32768206c995718a84bdd07c1996571d5062c3) (+1 grouped) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | perf(family-sql): mark temporalAuthoringPresets as side-effect-free for tree-shaking (TML-2766) |
| D561 | 2026-06-02 | [9cb5a111](https://github.com/prisma/orm/commit/9cb5a111bda8f1df3b50a1d7acf023e2d11eebda) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): keep branched migration names bold under their lane hue |
| D562 | 2026-06-02 | [aa81158c](https://github.com/prisma/orm/commit/aa81158c6b9a76071caf164c87bec4c5f1288721) (+2 grouped) | execution / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): colour connector junction glyphs by their own lane, not the served lane (TML-2773) |
| D563 | 2026-06-02 | [6856bf74](https://github.com/prisma/orm/commit/6856bf74f88d47a9bf67ae3f040934922f87b13c) | execution / development-fixup | no | inspected; no new concrete candidate | chore: block commits missing DCO sign-off |
| D564 | 2026-06-02 | [04bdb770](https://github.com/prisma/orm/commit/04bdb77014a416a9a14ef64aee5e41d1d1db9a1c) (+3 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(migration-ledger): avoid new bare casts in adapter duck-type guards |
| D565 | 2026-06-02 | [1b0dde5e](https://github.com/prisma/orm/commit/1b0dde5e2807dfc9531a58583da59679ca615297) (+1 grouped) | extensions / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli-telemetry): canonical docs URL in notice + treat blank installationId as missing |
| D566 | 2026-06-02 | [14064323](https://github.com/prisma/orm/commit/140643237f0cab97e5e5dee016cea3913bbf548c) (+1 grouped) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(sql-contract-ts): adopt TargetPackRef defaultNamespaceId after rebase on main |
| D567 | 2026-06-03 | [269347c2](https://github.com/prisma/orm/commit/269347c2f8c5cb8048e3eaaf06052839e36d28f4) (+2 grouped) | execution / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): colour arc-crossing dashes by the next branch on their right (TML-2773) |
| D568 | 2026-06-04 | [d8b3fea5](https://github.com/prisma/orm/commit/d8b3fea55403717b17bf196b1cc299567e742807) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(contract): emit defaultControlPolicy in canonical contract.json |
| D569 | 2026-06-05 | [a9b0b885](https://github.com/prisma/orm/commit/a9b0b885d32a9e83e32971e0e76bee33040f9fd7) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(contract): replace localeCompare with code-unit comparator in canonicalization-storage-sort |
| D570 | 2026-06-05 | [5b4fc833](https://github.com/prisma/orm/commit/5b4fc833a5c3aac7e141cd06da05e91c0b067601) | results / development-fixup | no | inspected; no new concrete candidate | fix(regen): produce canonical biome-formatted output on UPDATE path |
| D571 | 2026-06-05 | [23897af4](https://github.com/prisma/orm/commit/23897af4c110337319c6995414ee93226e4edcf4) (+3 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(sql-contract-psl): keep STI variant columns off the base domain model |
| D572 | 2026-06-07 | [43957c6e](https://github.com/prisma/orm/commit/43957c6efac25a9501d861c88a2dce311b478cba) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(emitter): restore per-namespace valueObjects in multi-namespace d.ts emission |
| D573 | 2026-06-07 | [9e5e3157](https://github.com/prisma/orm/commit/9e5e3157dc3530ffafc92358ef1d2e9b2052f083) (+2 grouped) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(supabase): make bootstrap shim take a Client; rewrite jargon comment (PR#746) |
| D574 | 2026-06-07 | [676ee849](https://github.com/prisma/orm/commit/676ee849060c13ba1b094b5a3e21788dc4f1255a) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | TML-2500(M1.2 fix): fail-fast on missing declared dependency; remove bare cast |
| D575 | 2026-06-07 | [ed48317f](https://github.com/prisma/orm/commit/ed48317fcebc2a6b3da350d58670d850d4fde523) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql): skip constraintless FKs in offline schema projection (#744) |
| D576 | 2026-06-07 | [f8387bb4](https://github.com/prisma/orm/commit/f8387bb407420af68485c024dd87b6a4213afc77) | migrations / development-fixup | no | inspected; no new concrete candidate | TML-2500(M3a.2): planner DDL audit + regression tests for cross-space FK |
| D577 | 2026-06-08 | [04d39e55](https://github.com/prisma/orm/commit/04d39e55fb10e962c6f9d88d9b98acdf95b9e56f) | migrations / development-fixup | no | inspected; no new concrete candidate | TML-2754: point stale migration tests at the post-#751 adapter API (#760) |
| D578 | 2026-06-08 | [73ec1e11](https://github.com/prisma/orm/commit/73ec1e1163a586dfb07d52aabddf3db65c6f1f57) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | TML-2849(Slice 3): fix stale @link to removed PslNamespace.extensionBlocks |
| D579 | 2026-06-08 | [ecedd5cf](https://github.com/prisma/orm/commit/ecedd5cf4519bf40628d350f22102b30205e87e0) (+1 grouped) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-runtime): move guardedStream invalidation check to post-yield resumption point |
| D580 | 2026-06-08 | [c67ce618](https://github.com/prisma/orm/commit/c67ce6183c1fb52446252ab4d850ad4f95cb7fd8) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | TML-2500(M3b.2): treat empty and missing typeParams as equivalent at the runtime boundary |
| D581 | 2026-06-08 | [3f6c418c](https://github.com/prisma/orm/commit/3f6c418c34fe5001f7519d2c741f2e90061f6d31) (+4 grouped) | query-engine / development-fixup | no | inspected; no new concrete candidate | fix(slice-0): repair typecheck against the cardinality-discriminated relation union |
| D582 | 2026-06-09 | [7060e84f](https://github.com/prisma/orm/commit/7060e84f286405133c3c673f00732e19cf524d05) (+3 grouped) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(sql-orm-client): reconcile N:M through-descriptor with required-namespace resolvers (post-rebase) |
| D583 | 2026-06-09 | [ec5f7df5](https://github.com/prisma/orm/commit/ec5f7df505dd0edc5f930b39b6bbdc98f7fcf7c7) | migrations / development-fixup | no | inspected; no new concrete candidate | fix(demo): remove collapsed no-op bookend migrations + integrity guard (#773) |
| D584 | 2026-06-09 | [90ca6086](https://github.com/prisma/orm/commit/90ca6086710980c3aa5f534dda44a66ee96e7849) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(psl-parser): correct string-escape decode order and stream type-annotation segments |
| D585 | 2026-06-09 | [7349db88](https://github.com/prisma/orm/commit/7349db88e286eaaa45dcd598ccb91448208dddfb) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): thread variant name through orderBy for MTI variant fields |
| D586 | 2026-06-09 | [8f7778e6](https://github.com/prisma/orm/commit/8f7778e67058cd4a5fa763f64cc6f79927cc1dde) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(adapter-postgres): introspect on one connection without overlapping queries |
| D587 | 2026-06-09 | [930cf7cf](https://github.com/prisma/orm/commit/930cf7cf7cc2ab2e389ae9dfee54c769228cce9b) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): type model accessors by selected variant |
| D588 | 2026-06-10 | [50f628b7](https://github.com/prisma/orm/commit/50f628b7205f62ad9fbb815ec9d84216906a85a0) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres-enums): emit enums by native type and address live enum storage by schema coordinate (#791) |
| D589 | 2026-06-11 | [c5def2fe](https://github.com/prisma/orm/commit/c5def2fe3b952ff3fec328630b2e4d577352a583) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(e2e): restore --no-memory-protection-keys to stop residual JIT crash (#814) |
| D590 | 2026-06-15 | [8abe8fcf](https://github.com/prisma/orm/commit/8abe8fcf28786a1a84ab42b696c8452265c3c1be) | schema-relations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(emitter): emit enum input literals (#788); verify #784/#785 — #783 cut for a proper fix (#797) |
| D591 | 2026-06-15 | [573197f2](https://github.com/prisma/orm/commit/573197f258de8ecdb6c0129957893ce46534b863) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(namespaces): per-namespace typed resolution for sql.<ns>.<table> and orm.<ns>.<Model> (#803) |
| D592 | 2026-06-18 | [7d37eb5b](https://github.com/prisma/orm/commit/7d37eb5b16d83605a3bd8bc9abe6e3d5804b763b) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(psl-parser): report missing field type in model/composite blocks (#854) |
| D593 | 2026-06-23 | [5b4e6657](https://github.com/prisma/orm/commit/5b4e6657eed1510304c79382d3d2dcac9c855b80) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(scripts): rename status var in :agent scripts so they work under zsh (#842) |
| D594 | 2026-06-24 | [2b112482](https://github.com/prisma/orm/commit/2b112482d76714418d44c5731a22417fb34abb1a) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | TML-2868: SELECT RLS policies, dependable end-to-end — authored in PSL, enforced, drift fails verify (#771) |
| D595 | 2026-06-24 | [708dce18](https://github.com/prisma/orm/commit/708dce189765c4f3854c3c69c37878c132753d98) | results / development-fixup | no | inspected; no new concrete candidate | fix(scripts): bound :agent runs with a portable timeout so a hung suite fails loudly (#853) |
| D596 | 2026-07-07 | [c298b987](https://github.com/prisma/orm/commit/c298b987e3ca2fca1971205e26cbeab84e7722ee) | results / development-fixup | no | inspected; no new concrete candidate | Give adapter-postgres afterEach driver.close() the shared testTimeout (fix flaky hook) (#920) |
| D597 | 2026-07-12 | [12132ecf](https://github.com/prisma/orm/commit/12132ecf2f6207805e86ea11839f902e54318843) | migrations / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(targets): name the failing operation in the stack-missing migration errors (#953) |
| D598 | 2026-07-15 | [d9c918d3](https://github.com/prisma/orm/commit/d9c918d308c5cbab062a3be1058ac4868475b03a) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-contract): preserve false literal column defaults through canonicalization (#904) |
| D599 | 2026-07-15 | [dd8756a0](https://github.com/prisma/orm/commit/dd8756a03ad337f9a2d92c10fa7b5baa324325ca) | migrations / development-fixup | no | inspected; no new concrete candidate | Fix stale cache-hit lifecycle claims in middleware doc comments (#915) |
| D600 | 2026-07-20 | [45081de3](https://github.com/prisma/orm/commit/45081de3479fb1c864b4e4a69e89bad88b2f64c7) | validation-types / runtime-or-schema-surface | no | inspected; no new concrete candidate | TML-2984: surface config-load failures on the config URI; retain the last-good project on reload failure (#974) |
| D601 | 2026-07-22 | [e1b778d1](https://github.com/prisma/orm/commit/e1b778d19636f8e9c59ee6d8c16bb379592457f6) | extensions / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix: resolve open CodeQL alerts (shell command construction, table-cell escaping, workflow permissions) (#1026) |
| D602 | 2026-07-31 | [202819d1](https://github.com/prisma/orm/commit/202819d12433a73b8d52b15783cbb9fa5718486e) | results / runtime-or-schema-surface | yes | deduped to release ledger | fix: lossless JSON projection (#29844) |
| D603 | 2026-08-03 | [91afc01a](https://github.com/prisma/orm/commit/91afc01a8a575d558122080ac9982665b6dadfd7) | results / provider-outside-viborm | yes | deduped to release ledger | fix(mongo-orm): decode write results through codecs (#29879) |
| D604 | 2026-08-03 | [b73877ae](https://github.com/prisma/orm/commit/b73877ae570a62d39da6196a865aa75dec928421) | extensions / development-fixup | yes | deduped to release ledger | fix: only packages/9-public is publishable, enforced (#29880) |
| D605 | 2026-08-03 | [2dcca954](https://github.com/prisma/orm/commit/2dcca954a732bc6883a1a1a49e9ad4120bcec1e1) | execution / runtime-or-schema-surface | no | inspected; no new concrete candidate | Port prisma functional waves 3–4: transactions, composites, and the full issues/ regression bucket (591 accounted) (#29832) |
| D606 | 2026-08-03 | [994b6e1a](https://github.com/prisma/orm/commit/994b6e1a300c8cef0b6a1e617cf5463d818d9dd6) | extensions / runtime-or-schema-surface | yes | deduped to release ledger | fix: prisma-next shim delegates to @prisma/orm-toolchain (ADR 211 amended) (#29883) |
| D607 | 2026-08-03 | [0b50d700](https://github.com/prisma/orm/commit/0b50d7001be0e1c76c6b96cce765824384cb67f6) | extensions / development-fixup | yes | deduped to release ledger | fix: publishable manifests declare the canonical repository, enforced (#29884) |
| D608 | 2026-08-04 | [7b505c28](https://github.com/prisma/orm/commit/7b505c286467d5615ad052ffa439b4fb8c66f1e3) | query-engine / runtime-or-schema-surface | yes | deduped to release ledger | fix(sql-orm-client): route M:N scalar includes through junctions (#29888) |
| D609 | 2026-08-05 | [6cc73aa5](https://github.com/prisma/orm/commit/6cc73aa58a3fed2dd1688555978ff02b7d736a27) | migrations / runtime-or-schema-surface | yes | deduped to release ledger | Fix main: reconcile #29889 with target-declared aggregates (#29898) |
| D610 | 2026-08-07 | [152feaf9](https://github.com/prisma/orm/commit/152feaf9f291fafff87aa1f52fb412a2da00077c) | results / runtime-or-schema-surface | yes | deduped to release ledger | fix(sql-orm-client): reload rows by Bytes identities (#29910) |
| D611 | 2026-08-07 | [82b5aaf9](https://github.com/prisma/orm/commit/82b5aaf9d085e64ee1124314ee5d6bd11c88019b) | execution / development-fixup | yes | deduped to release ledger | fix(driver-postgres): direct-driver transaction integrity + supabase prepared-statement coverage (TML-3167 follow-up) (#29920) |
| D612 | 2026-08-12 | [fc43787e](https://github.com/prisma/orm/commit/fc43787e397b212d49211883a87ce89f56d39f6e) | validation-types / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): repair Type Check and Test on main (#29977 × #29978 crossfire) (#29992) |
| D613 | 2026-08-14 | [5ae9a2e1](https://github.com/prisma/orm/commit/5ae9a2e1619f03694bc599cf0f2a42bc1dc18b51) | migrations / runtime-or-schema-surface | yes | deduped to release ledger | fix(sql): truncate synthesized index wire-name prefixes (#30025) |
| D614 | 2026-08-17 | [a804c950](https://github.com/prisma/orm/commit/a804c950effdf1531ccd04ca5d32ecc5a594acd6) | extensions / development-fixup | yes | deduped to release ledger | chore: remove stale marker.ts coverage exclude entry (#29903) |
| D615 | 2026-08-17 | [b639a5af](https://github.com/prisma/orm/commit/b639a5afef88f172c9b10abaa8977d3941755c7c) | extensions / development-fixup | no | inspected; no new concrete candidate | chore: remove the stale legacy-test comment (#30039) |
| D616 | 2026-08-18 | [7934152c](https://github.com/prisma/orm/commit/7934152cbc40292c4818d78209243a4520cbb6ed) | migrations / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): migration graph --dot draws the DOT as a human block, un-redding main (#30057) |
| D617 | 2026-08-18 | [2f7444a8](https://github.com/prisma/orm/commit/2f7444a8d27841fa554e3324199455b7b0674d35) | execution / toolchain-outside-viborm | no | inspected; no new concrete candidate | fix(cli): answer outputStreamsShareDevice from the fds so split terminals keep the stdout mirror (#30060) |
| D618 | 2026-08-18 | [12bee1ba](https://github.com/prisma/orm/commit/12bee1ba31e353b52596d4f7a40412a564afd32f) | results / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(postgres-adapter): validate SERIAL-family type for autoincrement() defaults (#30040) |
| D619 | 2026-08-19 | [397cbdab](https://github.com/prisma/orm/commit/397cbdab4142099ca7470367a8c43c01597d3768) | migrations / toolchain-outside-viborm | yes | deduped to release ledger | fix(cli): interpolate configured migrations dir into error text (#30041) |
| D620 | 2026-08-19 | [0f37454e](https://github.com/prisma/orm/commit/0f37454eec96b193e8b20e8f569e453acd2af644) | results / toolchain-outside-viborm | yes | deduped to release ledger | fix(language-server): recognize connection errors from any copy of vscode-jsonrpc (TML-3222) (#30077) |
| D621 | 2026-08-20 | [ba89b2a2](https://github.com/prisma/orm/commit/ba89b2a2a2084d6ad88343983d01ea585de0098b) | execution / runtime-or-schema-surface | yes | deduped to release ledger | TML-2842: attach pool-level error handlers so dropped idle connections don't crash the process (#30081) |
| D622 | 2026-08-20 | [f63e1528](https://github.com/prisma/orm/commit/f63e152868e373a5b6f364606875b035e8678653) | query-engine / runtime-or-schema-surface | yes | deduped to release ledger | Fix: aggregate() ignored take/skip/cursor/distinct (#30067) |
| D623 | 2026-08-21 | [ba9d46c0](https://github.com/prisma/orm/commit/ba9d46c0200754695fc11b720884c273e3947c5f) | extensions / toolchain-outside-viborm | yes | deduped to release ledger | TML-2637: correct stale init flag text and fence retired-vs-installed skill names (#30083) |
| D624 | 2026-08-21 | [08bf2290](https://github.com/prisma/orm/commit/08bf2290a3e52a8d239f8393bc5996d33e308e5c) | query-engine / runtime-or-schema-surface | yes | deduped to release ledger | Fix: groupBy() ignored the chain before it, and couldn't page the groups after it (#30092) |
| D625 | 2026-08-25 | [69b02a72](https://github.com/prisma/orm/commit/69b02a724e6fa85fd9f4f5ed264a497663cd96ec) | extensions / toolchain-outside-viborm | yes | deduped to release ledger | fix(language-server): canonicalize Windows file URIs (#30121) |
| D626 | 2026-08-27 | [4d4b76db](https://github.com/prisma/orm/commit/4d4b76db056ef583c996567527436d1984e4ef4f) | query-engine / runtime-or-schema-surface | no | inspected; no new concrete candidate | fix(sql-orm-client): reject unsupported nested create inputs (#30144) |

## Appendix C — TypeORM full-year extension ledger

This appendix adds 27 correction rows: 25 strict correction identities plus two performance-only corrections (#11580 and #12802). Together with the 110 carried strict rows, that is 135 strict identities plus two performance corrections = 137 correction rows. Carried strict rows T042 and T068 were reverted, leaving 133 effective strict corrections. Two explicit exclusions below (#11653 and #11807) are not correction rows. Every new item outside the prior four-month ledger is below. “N/A” means the analogous public mechanism/provider does not exist in current VibORM. “Not affected” means a superficially similar mechanism exists, but current source already owns the relevant invariant.

### C.1 Released before the carried ledger's start

| Identity / release | Normalized symptom | Owner / impact | Current VibORM disposition |
|---|---|---|---|
| [#11580](https://github.com/typeorm/typeorm/pull/11580), 0.3.27 | Repeated nearest-`package.json` discovery made migration startup scale with migration-file count. | migrations, extensions; **performance** | N/A: the migration estate does not discover a package for every migration file. |
| [#11623](https://github.com/typeorm/typeorm/pull/11623), 0.3.27 | Metro lacked a React Native package-export condition. | extensions | N/A: VibORM has no React Native package target/contract. |
| [#11634](https://github.com/typeorm/typeorm/pull/11634), 0.3.27 | `getManyAndCount` inferred the wrong total when offset exceeded the full row set. | query-engine, results | N/A: VibORM has no combined `findAndCount`/lazy-count API. |
| [#11639](https://github.com/typeorm/typeorm/pull/11639), 0.3.27 | Shipped `sha.js` was affected by CVE-2025-9288. | extensions; **security** | N/A: no direct `sha.js` dependency exists in current `package.json`/lock census. |
| [#11653](https://github.com/typeorm/typeorm/pull/11653), 0.3.27 | Tests were updated for a migration-template change. | migrations | **Excluded:** test-only, no shipped behavior correction. |
| [#11659](https://github.com/typeorm/typeorm/pull/11659), 0.3.27 | mysql2 already-parsed JSON string primitives were parsed a second time and could throw. | results, execution | N/A: VibORM's schema-aware structured parser distinguishes provider values and does not blindly `JSON.parse` an already parsed string primitive. |
| [#11660](https://github.com/typeorm/typeorm/pull/11660), 0.3.27 | Reverted a 0.3.26 junction-metadata deduplication regression. | schema-relations, migrations | N/A: VibORM's resolved relation index and canonical junction serializer have no TypeORM metadata-dedup path. |
| [#10804](https://github.com/typeorm/typeorm/pull/10804), 0.3.28 | MSSQL `multiSubnetFailover` was missing from public connection-option types. | validation-types, extensions | N/A: no MSSQL driver. |
| [#11750](https://github.com/typeorm/typeorm/pull/11750), 0.3.28 | A SAP driver import cycle made a deep import initialize `Connection` from `undefined`. | extensions, execution | N/A: no SAP driver or TypeORM deep-import surface. |
| [#11784](https://github.com/typeorm/typeorm/pull/11784), 0.3.28 | Shipped `glob` exposed CVE-2025-64756. | extensions; **security** | N/A: current lock contains `glob` 10.5.0/13.0.0, not the corrected TypeORM 10.4.x range; no equivalent shipped vulnerable direct dependency was found. |
| [#11789](https://github.com/typeorm/typeorm/pull/11789), 0.3.28 | CLI init read `package.json` two directories above its project. | extensions | N/A: no TypeORM-style init scaffolder. |
| [#11807](https://github.com/typeorm/typeorm/pull/11807), 0.3.28 | TypeSense docs sync was repaired. | extensions | **Excluded:** docs infrastructure only. |
| [#11814](https://github.com/typeorm/typeorm/pull/11814), 0.3.28 | `MongoEntityManager` omitted `findBy`. | extensions, results | N/A: no Mongo driver/entity manager. |
| [#11815](https://github.com/typeorm/typeorm/pull/11815), 0.3.28 | Redis version detection selected the wrong cache-client behavior. | extensions, execution | N/A: VibORM cache backends do not own a Redis client/version switch. |
| [GHSA-2rp8-mm9q-fp49](https://github.com/typeorm/typeorm/security/advisories/GHSA-2rp8-mm9q-fp49), 0.3.31/1.1.0 | Generated executable migration template literals admitted interpolation from introspected SQL. | migrations; **security** | N/A by representation; run only the inert negative confirmation above. |

Released corrections from 0.3.29 through 0.3.31/1.1.0 are deduplicated into the 110-entry prior ledger. No release-note fix in those releases was silently dropped; GHSA-2rp8 is the only additional private fix identity discovered by the commit/advisory census.

### C.2 Default-branch corrections after 1.1.0, unreleased at the cutoff

| Identity | Normalized symptom | Owner / impact | Current VibORM disposition and evidence |
|---|---|---|---|
| [#12668](https://github.com/typeorm/typeorm/pull/12668) | Dotted version comparison misordered versions with unequal segment counts. | execution, validation-types | N/A: no generic TypeORM-style version utility; the narrow MySQL capability gate parses the exact components it owns and fails closed. |
| [#12663](https://github.com/typeorm/typeorm/pull/12663) | Bidirectional many-to-many junction FKs defaulted asymmetrically to CASCADE/NO ACTION. | schema-relations, migrations | **Not affected:** current `serializer.ts` derives `onDelete`/`onUpdate` once (CASCADE default) and applies the same values to both junction FKs. |
| [#12726](https://github.com/typeorm/typeorm/pull/12726) | A relation assigned through a join column inside an embedded entity resolved to `undefined` and was not persisted. | schema-relations, execution | N/A: no embedded-entity/dotted join-column metadata mechanism. |
| [#12702](https://github.com/typeorm/typeorm/pull/12702) | Raw-table upsert generation accessed entity metadata absent from a raw table alias. | query-engine, execution | N/A: VibORM model upsert and raw SQL are separate public paths; there is no raw-table builder upsert. |
| [#12711](https://github.com/typeorm/typeorm/pull/12711) | Batch save treated an unloaded many-to-many relation as empty and deleted its junction rows. | schema-relations, execution; **data loss** is stated by the PR's behavior | **Not affected:** VibORM does not persist partially loaded entity graphs. Relation mutation parsing iterates only supplied input keys and skips `undefined`; an omitted relation cannot become an empty-set mutation. |
| [#12776](https://github.com/typeorm/typeorm/pull/12776) | Dotted path lookup threw when an intermediate segment was missing. | query-engine, results | N/A: no embedded/dotted entity-value lookup owner. |
| [#12797](https://github.com/typeorm/typeorm/pull/12797) | Cache get/clear leaked self-created query runners until pool exhaustion. | extensions, execution | N/A: VibORM cache operations do not allocate or own a query runner/connection. |
| [#12789](https://github.com/typeorm/typeorm/pull/12789) | `RelationMetadata` was absent from the package entry point after deep imports became unreliable. | extensions, validation-types | N/A: exact TypeORM internal-export request; no promised VibORM `RelationMetadata` export. |
| [#12508](https://github.com/typeorm/typeorm/pull/12508) | Function defaults were normalized as enum/string literals before the function-default branch. | migrations, sql | N/A: VibORM intentionally treats function defaults as runtime generators and omits them from literal migration default serialization; it has no TypeORM SQL-expression function-default contract. |
| [#12566](https://github.com/typeorm/typeorm/pull/12566) | `DateUtils` was absent from the package entry point after deep imports became unreliable. | extensions, validation-types | N/A: exact TypeORM internal-helper export request. |
| [#12759](https://github.com/typeorm/typeorm/pull/12759) | sql.js stopped timing before result-row iteration, underreporting slow queries/subscriber time. | extensions, execution | **Not affected:** VibORM records `startedAt` immediately before normalized provider execution and derives duration only after that promise settles. |
| [#12752](https://github.com/typeorm/typeorm/pull/12752) | better-sqlite3 did not await query subscribers, report failed queries, or wrap prepare failures consistently. | extensions, execution | N/A as a contract: VibORM's ordinary observers are deliberately non-blocking/non-authoritative, while the central driver instrumentation boundary reports statement failures. |
| [#12749](https://github.com/typeorm/typeorm/pull/12749) | PostGIS Z/ZM coordinate dimensions were lost during introspection, causing endless ALTER migrations. | migrations, extensions | N/A: current VibORM `point` is a fixed 2D EPSG:4326 scalar mapped to `geometry(Point)`; there is no Z/M/ZM public surface to preserve. |
| [#12802](https://github.com/typeorm/typeorm/pull/12802) | Raw-result grouping without primary keys called `indexOf` per row and regressed to O(n²). | results, query-engine; **performance** | N/A: VibORM has no TypeORM raw-row grouping transformer; the compiled row parser processes rows directly. |

## Appendix D — Drizzle full-year normalized ledgers

The 421 release-body families are N001–N380 plus E001–E041. Ten of the 11 default-branch correction identities map to those release families; D-C06 is the sole default-branch-only family. Therefore 421 + 1 = **422 normalized corrections**.

### D.1 Normalized default-branch correction identities

| ID | Commit | Owner | Normalized correction | Release coverage | Primary links |
|---|---|---|---|---|---|
| D-C02 | [`11ff664f7fd9`](https://github.com/drizzle-team/drizzle-orm/commit/11ff664f7fd988e4663dfa2c2622f9b7f8fda8dc) | `execution` | Durable SQLite transactions return the callback value, including nested transactions | `0.44.7` | [source 1](https://github.com/drizzle-team/drizzle-orm/pull/3746) |
| D-C01 | [`ad4ddd444d06`](https://github.com/drizzle-team/drizzle-orm/commit/ad4ddd444d066b339ffd5765cb6ec3bf49380189) | `extensions` | drizzle-kit/api ESM import no longer fails on a dynamic require | `drizzle-kit@0.31.6` | [source 1](https://github.com/drizzle-team/drizzle-orm/issues/2853), [source 2](https://github.com/drizzle-team/drizzle-orm/pull/4999) |
| D-C03 | [`2bf1a0adf61a`](https://github.com/drizzle-team/drizzle-orm/commit/2bf1a0adf61a49dedcd17aa6f9db3198696099f9) | `execution` | pg-native Pool transactions acquire and release a Pool client | `0.45.0`, `v1.0.0-beta.2` | [source 1](https://github.com/drizzle-team/drizzle-orm/pull/1708) |
| D-C04 | [`22e1986c4f86`](https://github.com/drizzle-team/drizzle-orm/commit/22e1986c4f86b2ab3cc184551f9417dba6be0d39) | `migrations` | MySQL and SingleStore index builder and serializer spell algorithm correctly | `0.45.0`, `drizzle-kit@0.31.8`, `v1.0.0-beta.2` | [source 1](https://github.com/drizzle-team/drizzle-orm/issues/1601), [source 2](https://github.com/drizzle-team/drizzle-orm/pull/1676) |
| D-C05 | [`d99bf7cf5924`](https://github.com/drizzle-team/drizzle-orm/commit/d99bf7cf5924d222710bb28f231d35157192b1f9) | `migrations` | PostgreSQL 18 generated NOT NULL constraints are not mistaken for user CHECK constraints during introspection/push | `v0.31.7` | [source 1](https://github.com/drizzle-team/drizzle-orm/issues/4944) |
| D-C06 | [`645a6f3e79d8`](https://github.com/drizzle-team/drizzle-orm/commit/645a6f3e79d84f4f9b9e5498349aaaddfc5e8805) | `sql` | Remove an accidental SQLite bigint CAST branch that returned Array.push's numeric result while rewriting SQL selections | none (default-branch-only) | [source 1](https://github.com/drizzle-team/drizzle-orm/commit/645a6f3e79d84f4f9b9e5498349aaaddfc5e8805) |
| D-C07 | [`ef4f2f46084e`](https://github.com/drizzle-team/drizzle-orm/commit/ef4f2f46084ee7b9aed6b9c862f7abd0e3af9540) | `extensions` | drizzle-kit library/API builds keep runtime packages external instead of bundling incompatible dependencies | `drizzle-kit@0.31.8` | [source 1](https://github.com/drizzle-team/drizzle-orm/commit/ef4f2f46084ee7b9aed6b9c862f7abd0e3af9540) |
| D-C08 | [`adf9bf1fb407`](https://github.com/drizzle-team/drizzle-orm/commit/adf9bf1fb4074ae563024f1acd8a20a1c72136ac) | `sql` | $onUpdate accepts an SQL expression without wrapping it as a bound scalar parameter | `0.45.0`, `v1.0.0-beta.2` | [source 1](https://github.com/drizzle-team/drizzle-orm/issues/2388), [source 2](https://github.com/drizzle-team/drizzle-orm/pull/2911) |
| D-C09 | [`74b85ae25903`](https://github.com/drizzle-team/drizzle-orm/commit/74b85ae259036cd4f1becc040387df538c2a8e32) | `results` | Bun SQL PostgreSQL date/timestamp mappers accept provider Date instances instead of reparsing them as strings | `0.45.0`, `v1.0.0-beta.2` | [source 1](https://github.com/drizzle-team/drizzle-orm/issues/4493) |
| D-C10 | [`a086f59fba7f`](https://github.com/drizzle-team/drizzle-orm/commit/a086f59fba7f46f3a077893ba912c99e91eaa760) | `execution` | pg-native Pool detection works where importing or requiring pg-native is forbidden | `0.45.1` | [source 1](https://github.com/drizzle-team/drizzle-orm/issues/5107), [source 2](https://github.com/drizzle-team/drizzle-orm/pull/5118) |
| D-C11 | [`273c78071d48`](https://github.com/drizzle-team/drizzle-orm/commit/273c78071d4841b497f5144734b38294df7ec64b) | `sql` | sql.identifier() and sql.as() double embedded delimiter characters instead of allowing identifier SQL injection | `0.45.2`, `v1.0.0-beta.20` | [source 1](https://github.com/drizzle-team/drizzle-orm/pull/5534) |

D-C03's second commit, [`ce85ad2b0cc2`](https://github.com/drizzle-team/drizzle-orm/commit/ce85ad2b0cc22b829ec35bacd32163746c110453), is a build/type follow-up and not a second family. D-C06, [`645a6f3e79d8`](https://github.com/drizzle-team/drizzle-orm/commit/645a6f3e79d84f4f9b9e5498349aaaddfc5e8805), is the only default-branch correction without a release-body attribution; it removes an accidental SQLite bigint CAST branch that returned the numeric result of `Array.push()` into selection rewriting.

### D.2 New normalized corrections outside beta.2 (N297–N380)

These 84 families are new relative to the prior April–August audit. beta.2's 296 families follow in the next section.

#### D.2.1 2025 corrections

- **N297** — `execution` — Durable SQLite transactions returned the wrong value ([0.44.7](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.44.7), #3746).
- **N298** — `extensions` — `drizzle-kit/api` imports failed from ESM modules ([Kit 0.31.6](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.31.6), [#2853](https://github.com/drizzle-team/drizzle-orm/issues/2853)).
- **N299** — `migrations` — Kit generated unnecessary PostgreSQL 18 `DROP` SQL for an unchanged schema ([v0.31.7](https://github.com/drizzle-team/drizzle-orm/releases/tag/v0.31.7), [#4944](https://github.com/drizzle-team/drizzle-orm/issues/4944)).
- **N300** — `extensions` — Kit's package build had incorrect external-dependency configuration ([Kit 0.31.8](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.31.8)).
- **N301** — `migrations` — Migrator sorting did nothing on Linux, so migrations ran in the wrong order ([beta.4](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.4), [#5123](https://github.com/drizzle-team/drizzle-orm/issues/5123)).
- **N302** — `migrations` — `drizzle-kit generate` failed without surfacing an error ([beta.4](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.4), [#5124](https://github.com/drizzle-team/drizzle-orm/issues/5124)).
- **N303** — `migrations` — `drizzle-kit check` incorrectly attempted to use AWS Data API ([beta.4](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.4), [#4775](https://github.com/drizzle-team/drizzle-orm/issues/4775)).
- **N304** — `results` — MySQL blob columns failed in the relational-query mapper ([beta.5](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.5)).
- **N305** — `migrations` — SQLite `up` converted unique constraints into a representation that caused false subsequent diffs; it now uses deterministically named unique indexes ([beta.5](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.5)).
- **N306** — `migrations` — SQLite `up` retained legacy foreign-key naming mismatches that caused false table recreation; the upgrade now removes the unusable legacy names ([beta.5](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.5)).
- **N307** — `migrations` — Adding a SQLite foreign-key column lost `onDelete` and `onUpdate`, leaving database state different from snapshots; the upgrade now recreates the table with correct SQL ([beta.5](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.5)).
- **N308** — `migrations` — Push failed to recognize a configured migration schema/table and could remove the migration table ([beta.7](https://github.com/drizzle-team/drizzle-orm/releases/tag/v.1.0.0-beta.7), [#5083](https://github.com/drizzle-team/drizzle-orm/issues/5083)).
- **N309** — `migrations` — MSSQL foreign-key constraints generated into the wrong schema ([beta.7](https://github.com/drizzle-team/drizzle-orm/releases/tag/v.1.0.0-beta.7), [#5182](https://github.com/drizzle-team/drizzle-orm/issues/5182)).
- **N310** — `execution` — `drizzle-seed` did not work with libSQL ([beta.8](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.8), [#3914](https://github.com/drizzle-team/drizzle-orm/issues/3914)).
- **N311** — `validation-types` — Seeded UUIDs failed Zod v4 UUID validation ([beta.8](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.8), [#4551](https://github.com/drizzle-team/drizzle-orm/issues/4551)).
- **N312** — `execution` — PostgreSQL enum-string seed values were emitted as numbers ([beta.8](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.8), [#4194](https://github.com/drizzle-team/drizzle-orm/issues/4194)).
- **N313** — `migrations` — Seeding explicit PostgreSQL serial values left the backing sequence stale ([beta.8](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.8), [#3915](https://github.com/drizzle-team/drizzle-orm/issues/3915)).

#### D.2.2 2026 corrections

- **N314** — `validation-types` — PostgreSQL dynamic updates with joins did not recalculate their query result ([beta.9](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.9)).
- **N315** — `extensions` — The Kit schema loader's `esbuild-register` path did not work across ESM and CJS; it moved to `tsx` ([beta.9](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.9)).
- **N316** — `results` — `PgTimestampString` omitted a timezone offset when a provider returned a `Date`; the result now defaults to `+00` ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11)).
- **N317** — `extensions` — PostgreSQL caching remained active when no cache was configured ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11)).
- **N318** — `migrations` — Pull generated an incorrect schema for functional/computed indexes ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11), [#5224](https://github.com/drizzle-team/drizzle-orm/issues/5224)).
- **N319** — `migrations` — MySQL pull generated invalid `datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE` code ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11), [#5212](https://github.com/drizzle-team/drizzle-orm/issues/5212)).
- **N320** — `migrations` — Kit push tried to delete non-public/excluded schemas ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11), [#5190](https://github.com/drizzle-team/drizzle-orm/issues/5190)).
- **N321** — `execution` — A Kit JSON serialization path failed on `BigInt` ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11), [#5227](https://github.com/drizzle-team/drizzle-orm/issues/5227)).
- **N322** — `migrations` — MySQL commutativity comparison treated `now(N)` and `CURRENT_TIMESTAMP(N)` inconsistently ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11)).
- **N323** — `migrations` — MySQL pull created a primary key for a column that was only `UNIQUE NOT NULL` ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11)).
- **N324** — `migrations` — MySQL pull ignored `varbinary()` configuration ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11)).
- **N325** — `migrations` — MySQL pull duplicated foreign-key columns when constraint names matched across databases ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11)).
- **N326** — `migrations` — MySQL pull used inconsistent casing between `schema.ts` and `relations.ts` ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11)).
- **N327** — `schema-relations` — MySQL cyclic references generated type errors instead of typed inline references ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11)).
- **N328** — `schema-relations` — Introspection could generate a relation name that collided with a column name ([beta.11](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.11)).
- **N329** — `migrations` — `drizzle-kit generate` could silently exit with status 1 ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12), [#5263](https://github.com/drizzle-team/drizzle-orm/issues/5263)).
- **N330** — `migrations` — The migrator imported `node:crypto` in runtimes without Node built-ins; [#5183](https://github.com/drizzle-team/drizzle-orm/issues/5183) and [#5126](https://github.com/drizzle-team/drizzle-orm/issues/5126) normalize to one family ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12)).
- **N331** — `migrations` — Check-constraint parsing mishandled backslashes ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12), [#4655](https://github.com/drizzle-team/drizzle-orm/issues/4655)).
- **N332** — `migrations` — `drizzle-kit up` threw while converting a null or undefined value to an object ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12), [#5099](https://github.com/drizzle-team/drizzle-orm/issues/5099)).
- **N333** — `results` — Bun SQLite `db.get()` returned array-mode data instead of an object ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12)).
- **N334** — `extensions` — The Effect PostgreSQL driver ignored its cache configuration ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12)).
- **N335** — `validation-types` — Public types rejected placeholders in `onConflictDoUpdate.set` ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12), [#5084](https://github.com/drizzle-team/drizzle-orm/issues/5084)).
- **N336** — `query-engine` — PostgreSQL aliases did not work with views ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12), [#4875](https://github.com/drizzle-team/drizzle-orm/issues/4875)).
- **N337** — `sql` — PostgreSQL `SELECT ... FOR ... OF` used a qualified table name where syntax requires a local reference ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12), [#4950](https://github.com/drizzle-team/drizzle-orm/issues/4950)).
- **N338** — `sql` — PostgreSQL `arrayContains()` encoded parameters as a record and produced an operator-mismatch error ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12), [#4578](https://github.com/drizzle-team/drizzle-orm/issues/4578)).
- **N339** — `sql` — Parameters were not inlined for single-table selects ([beta.12](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.12), [#4612](https://github.com/drizzle-team/drizzle-orm/issues/4612)).
- **N340** — `extensions` — Kit failed to load an import statement outside an ESM module after its loader rewrite ([beta.13](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.13), [#819](https://github.com/drizzle-team/drizzle-orm/issues/819)).
- **N341** — `migrations` — The migrator skipped older missing migrations because it considered only timestamps after the last applied migration ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14)).
- **N342** — `migrations` — `generate` and `pull` reported the migration folder instead of the SQL file path ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14)).
- **N343** — `extensions` — Cache entries were not invalidated after table updates ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14), [#4677](https://github.com/drizzle-team/drizzle-orm/issues/4677)).
- **N344** — `migrations` — Composite indexes with sort order produced malformed SQL ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14), [#4704](https://github.com/drizzle-team/drizzle-orm/issues/4704)).
- **N345** — `migrations` — Database introspection generated syntactically broken `schema.ts` ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14), [#4582](https://github.com/drizzle-team/drizzle-orm/issues/4582)).
- **N346** — `execution` — Drizzle Seed added an enumerable `random` property to `Array.prototype` ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14), [#4484](https://github.com/drizzle-team/drizzle-orm/issues/4484)).
- **N347** — `validation-types` — `defineRelations` triggered TS7056 when declaration output was enabled ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14), [#5272](https://github.com/drizzle-team/drizzle-orm/issues/5272)).
- **N348** — `execution` — MSSQL transactions were exposed as a non-callable value ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14), [#5328](https://github.com/drizzle-team/drizzle-orm/issues/5328)).
- **N349** — `execution` — Seeding a composite unique constraint containing a foreign key failed ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14), [#4354](https://github.com/drizzle-team/drizzle-orm/issues/4354)).
- **N350** — `migrations` — PostgreSQL `DROP INDEX` ignored the index schema ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14)).
- **N351** — `execution` — Sync drivers accepted async transaction callbacks that their execution model could not support ([beta.14](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.14)).
- **N352** — `validation-types` — SQLite selects rejected `SQL.Aliased` expressions in `orderBy()` and `groupBy()` ([beta.15](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.15)).
- **N353** — `migrations` — beta.13–beta.15 upgrades truncated millisecond journal timestamps to seconds and reapplied old migrations; beta.16 changed tracking to full folder names and a versioned table ([beta.16](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.16)).
- **N354** — `migrations` — The beta.16 migration-table upgrade could backfill only part of the estate without detecting missing rows; beta.17 verifies every entity ([beta.17](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.17)).
- **N355** — `execution` — Kit's terminal dependency lacked Bun-native width/ANSI handling and non-TTY error behavior ([Kit 0.31.10](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.31.10)).
- **N356** — `extensions` — The beta.13 Jiti regression failed to resolve TypeScript path aliases ([beta.18](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.18), [#5365](https://github.com/drizzle-team/drizzle-orm/issues/5365)).
- **N357** — `schema-relations` — `defineRelations` errors omitted the affected table name ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19), [#5350](https://github.com/drizzle-team/drizzle-orm/issues/5350)).
- **N358** — `migrations` — PostgreSQL push attempted to drop policies in schemas excluded by `schemaFilter` ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19), [#5329](https://github.com/drizzle-team/drizzle-orm/issues/5329)).
- **N359** — `migrations` — A generated migration for a `char[]` column failed ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19), [#5370](https://github.com/drizzle-team/drizzle-orm/issues/5370)).
- **N360** — `migrations` — Kit processed editor swap files and other non-schema inputs; schema loading now accepts only JS/TS module extensions ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19), [#4906](https://github.com/drizzle-team/drizzle-orm/issues/4906)).
- **N361** — `migrations` — PostgreSQL pull emitted an ivfflat access-method name instead of its operator class ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19), [#5495](https://github.com/drizzle-team/drizzle-orm/issues/5495)).
- **N362** — `migrations` — Kit pull generated a relation with insufficient data to construct it ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19), [#5493](https://github.com/drizzle-team/drizzle-orm/issues/5493)).
- **N363** — `migrations` — Turso/libSQL push failed during table recreation because no transaction was active at commit ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19), [#5489](https://github.com/drizzle-team/drizzle-orm/issues/5489)).
- **N364** — `migrations` — MySQL introspection dereferenced an undefined `requestLayout` ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19), [#5488](https://github.com/drizzle-team/drizzle-orm/issues/5488)).
- **N365** — `migrations` — AWS RDS Data API schema pull failed ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19), [#5308](https://github.com/drizzle-team/drizzle-orm/issues/5308)).
- **N366** — `migrations` — Commutative migration analysis considered only the last leaf ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19), [#5504](https://github.com/drizzle-team/drizzle-orm/issues/5504)).
- **N367** — `migrations` — MySQL `migrate()` did not manage multiple databases correctly ([beta.19](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19)).
- **N368** — `sql` — `sql.identifier()` and `sql.as()` failed to escape supplied values, enabling SQL injection ([0.45.2](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.2); beta.20 is the backport).
- **N369** — `migrations` — Adding a PostgreSQL enum value was incorrectly treated as commutative ([beta.21](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.21)).
- **N370** — `migrations` — Enum values added in different migration leaves were not merged ([beta.21](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.21)).
- **N371** — `migrations` — Windows migration generation emitted an incorrect `migrations.js` ([beta.22](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22), [#5514](https://github.com/drizzle-team/drizzle-orm/issues/5514)).
- **N372** — `results` — MSSQL `real` decoded as imprecise float64 because driver-value mapping was missing ([beta.22](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22), [#5527](https://github.com/drizzle-team/drizzle-orm/issues/5527)).
- **N373** — `results` — A result/object mapping path lost values through an object-key collision ([beta.22](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22), [#5525](https://github.com/drizzle-team/drizzle-orm/issues/5525)); the issue title is blank, so this stays bounded to the release label.
- **N374** — `migrations` — beta.20 migrations failed against Cloudflare D1 ([beta.22](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22), [#5602](https://github.com/drizzle-team/drizzle-orm/issues/5602)).
- **N375** — `migrations` — Migration SQL failures exited 1 but `MigrateProgress` hid the rejection and printed no error ([beta.22](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22), [#5601](https://github.com/drizzle-team/drizzle-orm/issues/5601)).
- **N376** — `migrations` — MSSQL filtered-index SQL fully qualified columns in `WHERE` ([beta.22](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22), [#5593](https://github.com/drizzle-team/drizzle-orm/issues/5593)).
- **N377** — `migrations` — PostgreSQL unique-constraint alteration ignored the new definition ([beta.22](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22), [#5585](https://github.com/drizzle-team/drizzle-orm/issues/5585)).
- **N378** — `migrations` — `create_index` commutativity omitted table identity and reported unrelated tables as conflicting ([beta.22](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22), [#5639](https://github.com/drizzle-team/drizzle-orm/issues/5639)).
- **N379** — `migrations` — `--ignore-conflicts` collapsed multiple open leaves to one parent instead of retaining the full parent set ([beta.22](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22)).
- **N380** — `extensions` — `mssql` and `@types/mssql` were required peers when MSSQL was unused; they became optional ([beta.22](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.22)).

### D.3 beta.2 normalized corrections (N001–N296)

The beta.2 body is exceptional: it contains a 322-item retrospective “Bugs fixed” list and was edited on 2026-01-03, one month after publication. The census accepts 294 issue-linked behavior, safety, type, migration, query, driver, packaging, and tooling corrections; adds the unlinked pg-native Pool correction and linked Bun Date mapper correction from “More Updates and Fixes”; and removes the duplicate #2388 occurrence. It excludes 28 non-corrections: #4990, #4988, #4725, #4341, #3855, #3646, #3386, #3264, #3261, #2933, #2903, #2840, #2653, #2268, #1913, #1438, #1069, #1066, #1051, #845, #821, #756, #674, #607, #585, #2297, #696, and #200. Deprecated-loader issue #3067 remains because it is a packaging/security correction despite its `FEATURE` prefix.

Titles retain the release body's linked issue wording. Stable IDs and owner tags are editorial; the machine TSV also preserves the issue number.

- **N001** — `execution` — Fixed pg-native Pool detection in node-postgres transactions.
- **N002** — `execution` — Fixed $onUpdate handling of SQL values.
- **N003** — `results` — Fixed bun-sql PostgreSQL date/timestamp mappers when provider rows contain Date instances.
- **N004** — `migrations` — [[BUG]:Drizzle pull generate invalid autosummarize](https://github.com/drizzle-team/drizzle-orm/issues/5196)
- **N005** — `extensions` — [Security: @esbuild-kit uses vulnerable esbuild@0.18.20](https://github.com/drizzle-team/drizzle-orm/issues/5194)
- **N006** — `migrations` — [[BUG]: drizzle-kit pull generated wrong syntax](https://github.com/drizzle-team/drizzle-orm/issues/5193)
- **N007** — `validation-types` — [[BUG]: findFirst fails with `TypeError: null is not an object (evaluating 'row[selectionItem.key]')` if no results are found](https://github.com/drizzle-team/drizzle-orm/issues/5189)
- **N008** — `migrations` — [[BUG]: [drizzle-kit] [MSSQL] Fix invalid migration generation: ALTER COLUMN on PK and FK Drop on Rename](https://github.com/drizzle-team/drizzle-orm/issues/5177)
- **N009** — `results` — [[BUG]: `jsonb` default with boolean literals gets generated `truen` instead of `true`](https://github.com/drizzle-team/drizzle-orm/issues/5149)
- **N010** — `extensions` — [`drizzle-kit` has a dependency on a deprecated insecure package (`@esbuild-kit/esm-loader`)](https://github.com/drizzle-team/drizzle-orm/issues/5145)
- **N011** — `migrations` — [[BUG]: Drizzle-kit does not consider prefix when generating migrations](https://github.com/drizzle-team/drizzle-orm/issues/5143)
- **N012** — `migrations` — [[BUG]: [drizzle-kit beta.2] "push" fails on fresh DB: "type does not exist" (Enum creation ordering issue)](https://github.com/drizzle-team/drizzle-orm/issues/5121)
- **N013** — `migrations` — [[BUG]: 1.0.0-beta.2 -  `drizzle-kit push` does consider json (jsonb) key order relevant](https://github.com/drizzle-team/drizzle-orm/issues/5119)
- **N014** — `execution` — [[BUG]: Renaming a column that has a view does not work](https://github.com/drizzle-team/drizzle-orm/issues/5116)
- **N015** — `execution` — [[BUG]: MSSQL view incorrect syntax](https://github.com/drizzle-team/drizzle-orm/issues/5113)
- **N016** — `migrations` — [[BUG]: drizzle-kit pull generates string instead of sql statement for default value](https://github.com/drizzle-team/drizzle-orm/issues/5093)
- **N017** — `migrations` — [[BUG]: drizzle-kit pull with PGlite driver produces empty foreign key column names](https://github.com/drizzle-team/drizzle-orm/issues/5082)
- **N018** — `migrations` — [[BUG]: Drizzle-Kit push doesn't play well with enums (pgEnum)](https://github.com/drizzle-team/drizzle-orm/issues/5072)
- **N019** — `migrations` — [[BUG]:   Drizzle-kit pull forgets to close single quote for empty string when postgresSQL field is empty string default.](https://github.com/drizzle-team/drizzle-orm/issues/5053)
- **N020** — `migrations` — [[BUG]: pg-core - cannot create a `gin` index without the `only` option](https://github.com/drizzle-team/drizzle-orm/issues/5033)
- **N021** — `query-engine` — [[BUG]: Drizzle fails to execute query with string parameter even when column is varchar (PostgreSQL)](https://github.com/drizzle-team/drizzle-orm/issues/5024)
- **N022** — `migrations` — [[BUG]: Drizzle-kit pull missing closing parenthesis](https://github.com/drizzle-team/drizzle-orm/issues/5009)
- **N023** — `migrations` — [[BUG]: drizzle-kit ignores standalone index definitions](https://github.com/drizzle-team/drizzle-orm/issues/4996)
- **N024** — `migrations` — [[BUG]: drizzle-kit pull missing closing quote (MySQL)](https://github.com/drizzle-team/drizzle-orm/issues/4993)
- **N025** — `validation-types` — [[BUG]: drizzle-typebox: excessively deep and possibly infinite.](https://github.com/drizzle-team/drizzle-orm/issues/4980)
- **N026** — `migrations` — [[BUG]: column default value corrupted when extracted with drizzle-kit pull](https://github.com/drizzle-team/drizzle-orm/issues/4979)
- **N027** — `sql` — [[BUG]: `.generatedAlwaysAsIdentity({ name: ""notice the double quotes here"" })`](https://github.com/drizzle-team/drizzle-orm/issues/4978)
- **N028** — `results` — [[BUG]:  Bun SQL: object is encoded as string for JSONB column](https://github.com/drizzle-team/drizzle-orm/issues/4942)
- **N029** — `execution` — [[BUG]: `bun-sql` with MySQL](https://github.com/drizzle-team/drizzle-orm/issues/4937)
- **N030** — `validation-types` — [[BUG]: Drizzle-Zod: When `coerce` is true, floats are coerced to `int`.](https://github.com/drizzle-team/drizzle-orm/issues/4933)
- **N031** — `migrations` — [[BUG]:  Generates invalid migration when renaming FK column](https://github.com/drizzle-team/drizzle-orm/issues/4932)
- **N032** — `validation-types` — [[BUG]: Drizzle-Valibot & Drizzle-Zod Wrong Type Inference (any instead of actual type)](https://github.com/drizzle-team/drizzle-orm/issues/4931)
- **N033** — `migrations` — [[BUG]: Updating a generated column will not recreate its indexes](https://github.com/drizzle-team/drizzle-orm/issues/4929)
- **N034** — `validation-types` — [[BUG]:drizzle-zod not working with sqlite d1](https://github.com/drizzle-team/drizzle-orm/issues/4926)
- **N035** — `validation-types` — [[BUG]: Drizzle-kit pulls postgres functions as Typescript methods](https://github.com/drizzle-team/drizzle-orm/issues/4916)
- **N036** — `migrations` — [[BUG]: Always asking to add constraints of long past migrations](https://github.com/drizzle-team/drizzle-orm/issues/4914)
- **N037** — `execution` — [[BUG]: enhancing schema with createInsertSchema removes `undefined` input option](https://github.com/drizzle-team/drizzle-orm/issues/4901)
- **N038** — `execution` — [[BUG]: Operator precedence of `=` and `IS NULL` is disrespected when using `eq` and `isNull`](https://github.com/drizzle-team/drizzle-orm/issues/4878)
- **N039** — `extensions` — [[BUG]: Transitive dependency 'esbuild' has a known vulnerability (GHSA-67mh-4wv8-2f99)](https://github.com/drizzle-team/drizzle-orm/issues/4861)
- **N040** — `migrations` — [[BUG]: drizzle-kit@latest (v0.31.4) does not recognize drizzle-orm@latest (v0.44.4) as valid version](https://github.com/drizzle-team/drizzle-orm/issues/4855)
- **N041** — `extensions` — [[BUG]: drizzle-kit uses deprecated `@esbuild-kit/esm-loader` with vulnerable `esbuild` instead of `tsx`](https://github.com/drizzle-team/drizzle-orm/issues/4852)
- **N042** — `query-engine` — [[BUG]: OrderBy not even being included in the query](https://github.com/drizzle-team/drizzle-orm/issues/4840)
- **N043** — `results` — [[BUG]: Changing from VARCHAR -> CITEXT (custom type) column generates "undefined"."citext" rather than "citext"](https://github.com/drizzle-team/drizzle-orm/issues/4806)
- **N044** — `migrations` — [[BUG]: When setting the casing to snake_case, the constraint name for unique fields isn't converted](https://github.com/drizzle-team/drizzle-orm/issues/4800)
- **N045** — `migrations` — [[BUG]: `drizzle-kit push` append `DROP SCHEMA` at the end for other schema name](https://github.com/drizzle-team/drizzle-orm/issues/4796)
- **N046** — `migrations` — [[BUG]: `drizzle-kit push` incorrectly tries to drop composite unique constraint despite no changes made](https://github.com/drizzle-team/drizzle-orm/issues/4789)
- **N047** — `migrations` — [[BUG]: MySQL enum defaults with value '0' are ignored during introspection](https://github.com/drizzle-team/drizzle-orm/issues/4786)
- **N048** — `migrations` — [[BUG]: drizzle-kit / Amazon Aurora DSQL : `drizzle-kit push` tries to drop the primary key index on reapply without changes](https://github.com/drizzle-team/drizzle-orm/issues/4779)
- **N049** — `migrations` — [[BUG]: bunx drizzle-kit push Freezes at “Reading config file” in Version ^0.31.4](https://github.com/drizzle-team/drizzle-orm/issues/4771)
- **N050** — `query-engine` — [[BUG]: Missing closing parentheses in subquery for counting records.](https://github.com/drizzle-team/drizzle-orm/issues/4770)
- **N051** — `migrations` — [[BUG]: using COALESCE when making an index, escapes the comma in the function](https://github.com/drizzle-team/drizzle-orm/issues/4766)
- **N052** — `migrations` — [[BUG]: Introspect generated files don't show columns in Views as arrays](https://github.com/drizzle-team/drizzle-orm/issues/4764)
- **N053** — `execution` — [[BUG]: drizzle kit wrong  schema with default string](https://github.com/drizzle-team/drizzle-orm/issues/4760)
- **N054** — `migrations` — [[BUG]: drizzle-kit pull fails to wrap gen_random_uuid() with sql function call resulting in syntax errors](https://github.com/drizzle-team/drizzle-orm/issues/4730)
- **N055** — `migrations` — [[BUG]: `drizzle-kit introspect` empty `''` mysqlEnum nad default introspect error](https://github.com/drizzle-team/drizzle-orm/issues/4713)
- **N056** — `migrations` — [[BUG]: CHECK constraints with operator functions generate invalid SQL with parameterized values](https://github.com/drizzle-team/drizzle-orm/issues/4661)
- **N057** — `migrations` — [[BUG]: tinyint, bigint doesn't include when run drizzle-kit pull](https://github.com/drizzle-team/drizzle-orm/issues/4653)
- **N058** — `migrations` — [[BUG]:drizzle-kit pull missing one ' letter column with default empty text](https://github.com/drizzle-team/drizzle-orm/issues/4644)
- **N059** — `migrations` — [[BUG]: Unable to create composite foreign key: order of SQL statements [Postgres]](https://github.com/drizzle-team/drizzle-orm/issues/4638)
- **N060** — `migrations` — [[BUG]: drizzle-kit MySQL Serializer doesn't see PKs and CHECK constraints](https://github.com/drizzle-team/drizzle-orm/issues/4602)
- **N061** — `query-engine` — [[BUG]: Documentation mentions using where in relation, but that does not actually work](https://github.com/drizzle-team/drizzle-orm/issues/4597)
- **N062** — `migrations` — [[BUG]: unique key names for multiple columns doesn't respect casing configuration](https://github.com/drizzle-team/drizzle-orm/issues/4541)
- **N063** — `execution` — [[BUG]: "serverTypeEnum" already exists](https://github.com/drizzle-team/drizzle-orm/issues/4536)
- **N064** — `migrations` — [[BUG]: `drizzle-kit push` fails if the target postgres database has a `jsonb` column with a default value](https://github.com/drizzle-team/drizzle-orm/issues/4529)
- **N065** — `query-engine` — [[BUG]:findFirst not working on views](https://github.com/drizzle-team/drizzle-orm/issues/4505)
- **N066** — `query-engine` — [[BUG]: Selecting the desired columns of a findMany with an object](https://github.com/drizzle-team/drizzle-orm/issues/4500)
- **N067** — `sql` — [[BUG]: Passing dimensions in drizzle-orm/pg-core to bit() adds double quotes in type](https://github.com/drizzle-team/drizzle-orm/issues/4473)
- **N068** — `migrations` — [[BUG]: missing nonNull property from column referenced in composite primary key causes database error during drizzle-kit push command](https://github.com/drizzle-team/drizzle-orm/issues/4471)
- **N069** — `migrations` — [[BUG]: `drizzle-kit generate` generates out of order/ incorrect migrations](https://github.com/drizzle-team/drizzle-orm/issues/4456)
- **N070** — `validation-types` — [[BUG]: TypeError: Cannot read properties of undefined (reading 'type')](https://github.com/drizzle-team/drizzle-orm/issues/4438)
- **N071** — `query-engine` — [[BUG]: `with:` columns resulting in `any` values](https://github.com/drizzle-team/drizzle-orm/issues/4432)
- **N072** — `migrations` — [[BUG]: Drizzle not pulling foreign key names using introspect command in ts + mysql](https://github.com/drizzle-team/drizzle-orm/issues/4415)
- **N073** — `query-engine` — [[BUG]: Invalid SQL query generated for MySQL when using "with" feature](https://github.com/drizzle-team/drizzle-orm/issues/4412)
- **N074** — `query-engine` — [[BUG]: with Relation in findMany Returns Flattened Array Instead of Key-Value Object](https://github.com/drizzle-team/drizzle-orm/issues/4409)
- **N075** — `migrations` — [[BUG]:`drizzle-kit pull` from Supabase db pgPolicy not importing rules correctly](https://github.com/drizzle-team/drizzle-orm/issues/4407)
- **N076** — `query-engine` — [[BUG]: drizzle-orm@beta query object is empty in NuxtHub project](https://github.com/drizzle-team/drizzle-orm/issues/4390)
- **N077** — `results` — [[BUG]: Big int precision loss when data fetched with json_agg](https://github.com/drizzle-team/drizzle-orm/issues/4380)
- **N078** — `execution` — [[BUG]: SQLITE_ERROR: no such function: sortconcat](https://github.com/drizzle-team/drizzle-orm/issues/4377)
- **N079** — `execution` — [[BUG]: Enum scoped to a database schema, doesn't always contain the schema name in table definition](https://github.com/drizzle-team/drizzle-orm/issues/4375)
- **N080** — `migrations` — [[BUG]: Postgres | applying migrations...error: relation "public.users" does not exist](https://github.com/drizzle-team/drizzle-orm/issues/4369)
- **N081** — `execution` — [[BUG]: Incorrect column types when using `with` for table created with helper function](https://github.com/drizzle-team/drizzle-orm/issues/4358)
- **N082** — `execution` — [[BUG]: drizzle-orm@beta SQLite error in queries w/ `with`](https://github.com/drizzle-team/drizzle-orm/issues/4357)
- **N083** — `migrations` — [[BUG]:`drizzle-kit pull` with default varchar or text `.default('')` does not get generated correctly](https://github.com/drizzle-team/drizzle-orm/issues/4349)
- **N084** — `execution` — [[BUG]:Drizzle does not track enum name change](https://github.com/drizzle-team/drizzle-orm/issues/4338)
- **N085** — `migrations` — [`drizzle-kit pull` produces a malformed `relations.ts` when there are no relations at all.](https://github.com/drizzle-team/drizzle-orm/issues/4333)
- **N086** — `execution` — [[BUG]:Entities missing or docs out of date for 0.40.1](https://github.com/drizzle-team/drizzle-orm/issues/4305)
- **N087** — `migrations` — [[BUG]: Changing ENUM column with default value migration broken](https://github.com/drizzle-team/drizzle-orm/issues/4295)
- **N088** — `results` — [[BUG]: please fill with the declared default value](https://github.com/drizzle-team/drizzle-orm/issues/4289)
- **N089** — `migrations` — [[BUG]: `drizzle-kit push` doesn't generate valid neon crud-policies, while `generate` does.](https://github.com/drizzle-team/drizzle-orm/issues/4279)
- **N090** — `migrations` — [[BUG]: AnySQLiteColumn in generated schema is not prefixed by "type" keyword](https://github.com/drizzle-team/drizzle-orm/issues/4247)
- **N091** — `migrations` — [[BUG]: truncated tables on ALTER COLUMN statements](https://github.com/drizzle-team/drizzle-orm/issues/4245)
- **N092** — `migrations` — [[BUG]:ESLint Rule Disabled in introspect-mysql.ts](https://github.com/drizzle-team/drizzle-orm/issues/4244)
- **N093** — `execution` — [[BUG]: Identifier is too long (should not exceed 63 characters)](https://github.com/drizzle-team/drizzle-orm/issues/4238)
- **N094** — `execution` — [[BUG]: Unable to create MySQL foreign string keys](https://github.com/drizzle-team/drizzle-orm/issues/4221)
- **N095** — `migrations` — [[BUG]: Drizzle claims there is no default on column with default when pushing](https://github.com/drizzle-team/drizzle-orm/issues/4217)
- **N096** — `migrations` — [[BUG]: Introspect PG _text type not recognized as an array](https://github.com/drizzle-team/drizzle-orm/issues/4215)
- **N097** — `execution` — [[BUG]: Drizzle type inferrence doesn't work properly with many tables](https://github.com/drizzle-team/drizzle-orm/issues/4199)
- **N098** — `migrations` — [[BUG]: Drizzle generates incorrect SQL migration for policy permission string changes](https://github.com/drizzle-team/drizzle-orm/issues/4198)
- **N099** — `query-engine` — [findFirst Date returned as string](https://github.com/drizzle-team/drizzle-orm/issues/4186)
- **N100** — `extensions` — [[BUG]: drizzle-seed - this package itself specifies a `main` module field that could not be resolved](https://github.com/drizzle-team/drizzle-orm/issues/4180)
- **N101** — `migrations` — [[BUG]: drizzle-kit pull fails if db includes views which are not in "tablesFilter"](https://github.com/drizzle-team/drizzle-orm/issues/4170)
- **N102** — `migrations` — [[BUG]: Can't drop a foreign key in Turso dialect](https://github.com/drizzle-team/drizzle-orm/issues/4167)
- **N103** — `query-engine` — [[BUG]: wrong table name generated in `$count` sub-expression](https://github.com/drizzle-team/drizzle-orm/issues/4164)
- **N104** — `execution` — [[BUG]:Unknown column in where](https://github.com/drizzle-team/drizzle-orm/issues/4159)
- **N105** — `migrations` — [[BUG]: drizzle-kit generate when dropping table attempts to delete already deleted constraint](https://github.com/drizzle-team/drizzle-orm/issues/4155)
- **N106** — `validation-types` — [[BUG]: Incomplete inferred result type in query API when using optional columns](https://github.com/drizzle-team/drizzle-orm/issues/4153)
- **N107** — `migrations` — [SQLite columns are not marked as unique, instead a unique index has been created](https://github.com/drizzle-team/drizzle-orm/issues/4152)

- **N108** — `migrations` — [[BUG]: Incorrect migration generated if both foreign key and column are added](https://github.com/drizzle-team/drizzle-orm/issues/4147)
- **N109** — `migrations` — [[BUG]:Introspect does not pull foreign key names when `on delete` and  `on update` are set to other than `no action`](https://github.com/drizzle-team/drizzle-orm/issues/4115)
- **N110** — `validation-types` — [[BUG]: `drizzle-kit pull` made a broken schema as TypeScript. (looks forget to import `tinyint` from drizzle-orm/mysql-core)](https://github.com/drizzle-team/drizzle-orm/issues/4110)
- **N111** — `query-engine` — [[BUG]: error: relation "users" does not exist](https://github.com/drizzle-team/drizzle-orm/issues/4098)
- **N112** — `migrations` — [[BUG]: Postgres column generates invalid default value of single quote '](https://github.com/drizzle-team/drizzle-orm/issues/4085)
- **N113** — `query-engine` — [[BUG]: Drizzle Relational Query not filtering well](https://github.com/drizzle-team/drizzle-orm/issues/4080)
- **N114** — `migrations` — [[BUG]: RLS "using" rule not applied to supabase](https://github.com/drizzle-team/drizzle-orm/issues/4078)
- **N115** — `migrations` — [[BUG]: drizzle-kit introspect fails on supabase `auth` schema](https://github.com/drizzle-team/drizzle-orm/issues/4042)
- **N116** — `migrations` — [[BUG]: PG `drizzle-kit introspect` doesn't work for `NOT DISTINCT('nulls')`](https://github.com/drizzle-team/drizzle-orm/issues/4007)
- **N117** — `migrations` — [[BUG]: `drizzle-kit push` erroring does not return a error exit code](https://github.com/drizzle-team/drizzle-orm/issues/4006)
- **N118** — `migrations` — [[BUG]: Multi column foreign key columns are sorted individually on introspection (critical bug)](https://github.com/drizzle-team/drizzle-orm/issues/3993)
- **N119** — `migrations` — [[BUG]: drizzle-kit wants to delete sqlite internal stats tables](https://github.com/drizzle-team/drizzle-orm/issues/3979)
- **N120** — `query-engine` — [[BUG]:Inconsistent behavior in many-to-many relations with junction table: identical patterns yield different results](https://github.com/drizzle-team/drizzle-orm/issues/3937)
- **N121** — `migrations` — [[BUG]: pushSchema does not respect the casing property.](https://github.com/drizzle-team/drizzle-orm/issues/3913)
- **N122** — `validation-types` — [[BUG]:Error Typescript for query where in relation (version  "drizzle-orm": "^0.38.3")](https://github.com/drizzle-team/drizzle-orm/issues/3911)
- **N123** — `migrations` — [[BUG]:drizzle-kit pull generated schema.ts missing quote](https://github.com/drizzle-team/drizzle-orm/issues/3887)
- **N124** — `validation-types` — [[BUG]: TypeError: Cannot read properties of undefined (reading 'checkConstraint') when trying to pull specifics tables from a schema](https://github.com/drizzle-team/drizzle-orm/issues/3884)
- **N125** — `query-engine` — [[BUG]: findFirst not return undefined or null when not data is found.](https://github.com/drizzle-team/drizzle-orm/issues/3872)
- **N126** — `execution` — [[BUG]: drizzle meta trying to read the .DS_Store / journal gets corrupted](https://github.com/drizzle-team/drizzle-orm/issues/3867)
- **N127** — `migrations` — [[BUG]: drizzle-kit: `push` runs already applied migration ](https://github.com/drizzle-team/drizzle-orm/issues/3844)
- **N128** — `validation-types` — [[BUG]: Type error when performing filter select according to docs](https://github.com/drizzle-team/drizzle-orm/issues/3804)
- **N129** — `migrations` — [[BUG]: SQLite migration fails when adding field with autoincrement](https://github.com/drizzle-team/drizzle-orm/issues/3801)
- **N130** — `validation-types` — [[BUG]: Incorrect Non-Nullable Type Inference for One-to-One Related Entities](https://github.com/drizzle-team/drizzle-orm/issues/3799)
- **N131** — `migrations` — [[BUG]: drizzle kit generate invalid schema for efault](https://github.com/drizzle-team/drizzle-orm/issues/3795)
- **N132** — `migrations` — [[BUG]: Drizzle keep removing and re-adding a unique index with multiple fields](https://github.com/drizzle-team/drizzle-orm/issues/3764)
- **N133** — `schema-relations` — [[BUG]: Allow specifying relationName for one-to-one relationships on the side without field definitions](https://github.com/drizzle-team/drizzle-orm/issues/3763)
- **N134** — `migrations` — [[BUG]: `drizzle-kit pull` doesn't work with `md5` index](https://github.com/drizzle-team/drizzle-orm/issues/3745)
- **N135** — `results` — [[BUG]: Custom types not working when insert with onConflictDoUpdate in Sqlite](https://github.com/drizzle-team/drizzle-orm/issues/3730)
- **N136** — `migrations` — [[BUG]: drizzle-kit drop is not working (anymore)](https://github.com/drizzle-team/drizzle-orm/issues/3691)
- **N137** — `execution` — [[BUG]: Cannot filter by related row](https://github.com/drizzle-team/drizzle-orm/issues/3688)
- **N138** — `results` — [[BUG]: Geometry column on pg shows [object Object] on default value](https://github.com/drizzle-team/drizzle-orm/issues/3685)
- **N139** — `extensions` — [[BUG]: `drizzle-kit push` keeps wanting to update `id` `SET CACHE 1`](https://github.com/drizzle-team/drizzle-orm/issues/3679)
- **N140** — `migrations` — [[BUG]: Could not process view error when pulling database schema for drizzle-kit push](https://github.com/drizzle-team/drizzle-orm/issues/3674)
- **N141** — `migrations` — [[BUG]: Invalid schema generation on drizzle-kit pull when spaces in the column name](https://github.com/drizzle-team/drizzle-orm/issues/3657)
- **N142** — `migrations` — [[BUG]: Wrong column names in migration while renaming a column in SQLite](https://github.com/drizzle-team/drizzle-orm/issues/3653)
- **N143** — `sql` — [[BUG]: Column name conversion not working when using `sql.js`](https://github.com/drizzle-team/drizzle-orm/issues/3642)
- **N144** — `schema-relations` — [[BUG]: There is not enough information to infer relation](https://github.com/drizzle-team/drizzle-orm/issues/3637)
- **N145** — `migrations` — [[BUG]: Drizzle encounters an error when executing the migration due to multiple statements in a single SQL script.](https://github.com/drizzle-team/drizzle-orm/issues/3636)
- **N146** — `migrations` — [[BUG]: drizzle-kit pull fails because of incorrect check constraint query](https://github.com/drizzle-team/drizzle-orm/issues/3627)
- **N147** — `migrations` — [[BUG]: Drizzle-kit no longer supporting the special characters in enum values (MySQL)](https://github.com/drizzle-team/drizzle-orm/issues/3613)
- **N148** — `migrations` — [[BUG]: `introspect` generates invalid schema depending on the default value](https://github.com/drizzle-team/drizzle-orm/issues/3593)
- **N149** — `execution` — [[BUG]: Failed schema with d1 table](https://github.com/drizzle-team/drizzle-orm/issues/3590)
- **N150** — `migrations` — [[BUG]:drizzle-kit pull returns .with({"securityInvoker":"on"})](https://github.com/drizzle-team/drizzle-orm/issues/3585)
- **N151** — `migrations` — [[BUG]: Pushing a table with a fixed array will fail on certain conditions (drizzle-orm/pg-core)](https://github.com/drizzle-team/drizzle-orm/issues/3582)
- **N152** — `query-engine` — [[BUG]: db.query creates slow (?) queries in related queries](https://github.com/drizzle-team/drizzle-orm/issues/3581)
- **N153** — `migrations` — [[BUG]:push creates duplicate statements for unique column index](https://github.com/drizzle-team/drizzle-orm/issues/3574)
- **N154** — `query-engine` — [[BUG]: findMany (and likely others) building an invalid query when other tables are referenced in the where clause](https://github.com/drizzle-team/drizzle-orm/issues/3573)
- **N155** — `query-engine` — [[BUG]: $count() generates the wrong Postgres subquery](https://github.com/drizzle-team/drizzle-orm/issues/3564)
- **N156** — `migrations` — [[BUG]:drizzle-kit pull generate wrong schema.ts](https://github.com/drizzle-team/drizzle-orm/issues/3559)
- **N157** — `execution` — [[BUG]: Instrospect doesn't put `.primaryKey()` in my tables](https://github.com/drizzle-team/drizzle-orm/issues/3552)
- **N158** — `migrations` — [[BUG]: Pull incorrectly pulls in default empty strings](https://github.com/drizzle-team/drizzle-orm/issues/3549)
- **N159** — `query-engine` — [[BUG]: extras in findMany count relations is not working](https://github.com/drizzle-team/drizzle-orm/issues/3546)
- **N160** — `migrations` — [[BUG]: Default statement of incorrectly inferred for drizzle-kit introspect](https://github.com/drizzle-team/drizzle-orm/issues/3545)
- **N161** — `validation-types` — [[BUG]: TypeError: Cannot read properties of undefined (reading 'columns')](https://github.com/drizzle-team/drizzle-orm/issues/3539)
- **N162** — `migrations` — [[BUG]: `pgEnum` generates faulty migrations](https://github.com/drizzle-team/drizzle-orm/issues/3514)
- **N163** — `migrations` — [[BUG]: wierd error on parsing migrate folder](https://github.com/drizzle-team/drizzle-orm/issues/3507)
- **N164** — `migrations` — [[BUG]: RLS Policies not applied with `push` but applied with `migrate`](https://github.com/drizzle-team/drizzle-orm/issues/3504)
- **N165** — `query-engine` — [[BUG]: Query include relations => relation table has jsonb field =>  SqliteError: JSON cannot hold BLOB values ](https://github.com/drizzle-team/drizzle-orm/issues/3497)
- **N166** — `migrations` — [[BUG]: Primary key migration fails when changing from one column to another](https://github.com/drizzle-team/drizzle-orm/issues/3496)
- **N167** — `migrations` — [[BUG] introspect generates broken schema when db uses custom function](https://github.com/drizzle-team/drizzle-orm/issues/3490)
- **N168** — `migrations` — [Multiple postgres primary keys causes opaque introspection error](https://github.com/drizzle-team/drizzle-orm/issues/3483)
- **N169** — `migrations` — [MYSQL Introspect: Warning: Can't parse bit(1) from database](https://github.com/drizzle-team/drizzle-orm/issues/3480)
- **N170** — `migrations` — [Certain Postgres types are not handled by `introspect:pg`](https://github.com/drizzle-team/drizzle-orm/issues/3479)
- **N171** — `migrations` — [[BUG] Push: push:sqlite Codegen Problem When Pushing Adds New Fields](https://github.com/drizzle-team/drizzle-orm/issues/3477)
- **N172** — `migrations` — [BUG `drizzle-kit push:mysql` with Two Primary Keys](https://github.com/drizzle-team/drizzle-orm/issues/3473)
- **N173** — `execution` — [push:mysql fails to drop a serial column and replace with another column type](https://github.com/drizzle-team/drizzle-orm/issues/3471)
- **N174** — `migrations` — [db push just hangs, verbose doesn't show any details](https://github.com/drizzle-team/drizzle-orm/issues/3470)
- **N175** — `migrations` — [Postgres enum migration issue (migrations not being committed individually)](https://github.com/drizzle-team/drizzle-orm/issues/3466)
- **N176** — `migrations` — [Drizzle Studio Logs escaping ANSI color codes VSCode](https://github.com/drizzle-team/drizzle-orm/issues/3460)
- **N177** — `migrations` — [Drizzle Studio giving error due to `CURRENT_TIMESTAMP` in schema](https://github.com/drizzle-team/drizzle-orm/issues/3453)
- **N178** — `migrations` — [introspect schemaFilter doesn't work for data types](https://github.com/drizzle-team/drizzle-orm/issues/3418)
- **N179** — `migrations` — [BUG: References in primary key](https://github.com/drizzle-team/drizzle-orm/issues/3383)
- **N180** — `migrations` — [re-push does not work with the  a composite primary key ( PostgreSQL code:  42704  )](https://github.com/drizzle-team/drizzle-orm/issues/3380)
- **N181** — `migrations` — [[Mysql] Drizzle kit generates invalid SQL syntax for `onUpdateNow` when an `fsp` is provided to timestamp](https://github.com/drizzle-team/drizzle-orm/issues/3373)
- **N182** — `migrations` — [drizzle-kit push with PostGIS geometry column type](https://github.com/drizzle-team/drizzle-orm/issues/3347)
- **N183** — `migrations` — [[BUG]: Mysql new .unique().notNull(), `add constraint` is put before `add column`, throwing error.](https://github.com/drizzle-team/drizzle-orm/issues/3329)
- **N184** — `sql` — [Double quotes on defaults](https://github.com/drizzle-team/drizzle-orm/issues/3318)
- **N185** — `migrations` — [There are three cases where drizzle-kit's introspect:mysql does not work. ](https://github.com/drizzle-team/drizzle-orm/issues/3297)
- **N186** — `execution` — [MySQL & PostgreSQL: not detecting all new cascades](https://github.com/drizzle-team/drizzle-orm/issues/3293)
- **N187** — `migrations` — [[BUG]: Push should detect truncations on constraints](https://github.com/drizzle-team/drizzle-orm/issues/3280)
- **N188** — `migrations` — [[BUG]:array of enum occurs error when drizzle-kit pushing](https://github.com/drizzle-team/drizzle-orm/issues/3278)
- **N189** — `query-engine` — [[BUG]:Deep nested queries](https://github.com/drizzle-team/drizzle-orm/issues/3277)
- **N190** — `migrations` — [[BUG]: drizzle-kit fails to order postgresql index and constraint columns when fetching the database's current state](https://github.com/drizzle-team/drizzle-orm/issues/3274)
- **N191** — `query-engine` — [[BUG]: `findMany`/`findFirst` incorrectly substituting table names in sql operator](https://github.com/drizzle-team/drizzle-orm/issues/3268)
- **N192** — `query-engine` — [[BUG]: Incorrect bigint value retrieval using findMany with relations (postgresql)](https://github.com/drizzle-team/drizzle-orm/issues/3267)
- **N193** — `migrations` — [[BUG]: PG Schema Missing from Constraint / Index Updates; Index + Constraint Order backwards](https://github.com/drizzle-team/drizzle-orm/issues/3260)
- **N194** — `migrations` — [[BUG]: `drizzle-kit generate` fails with `"undefined" is not valid JSON`](https://github.com/drizzle-team/drizzle-orm/issues/3255)
- **N195** — `execution` — [[BUG]: bit type goes to postgresql as a string](https://github.com/drizzle-team/drizzle-orm/issues/3254)
- **N196** — `migrations` — [[BUG]: Foreign key name length](https://github.com/drizzle-team/drizzle-orm/issues/3244)
- **N197** — `migrations` — [[BUG]: Issue Introspecting Postgres Tables with Indexes on JSONB columns](https://github.com/drizzle-team/drizzle-orm/issues/3240)
- **N198** — `execution` — [[BUG]: "unix_timestamp is not defined"](https://github.com/drizzle-team/drizzle-orm/issues/3237)
- **N199** — `migrations` — [[BUG]: Pressing `escape` while in the `push` confirmation dialog runs the push](https://github.com/drizzle-team/drizzle-orm/issues/3230)
- **N200** — `execution` — [[BUG]: Raw sql`` function calls get incorrectly changed](https://github.com/drizzle-team/drizzle-orm/issues/3220)
- **N201** — `migrations` — [[BUG]: pgEnum -> type "xxx" already exists during migration](https://github.com/drizzle-team/drizzle-orm/issues/3206)
- **N202** — `migrations` — [[BUG]: drizzle-kit push generate excess command that crash migration](https://github.com/drizzle-team/drizzle-orm/issues/3189)
- **N203** — `execution` — [[BUG]: arrayContains, arrayContained, arrayOverlaps aren't there in queries find callbacks](https://github.com/drizzle-team/drizzle-orm/issues/3169)
- **N204** — `migrations` — [[BUG]: when adding a new column and using it as primary key the generated migration is not working](https://github.com/drizzle-team/drizzle-orm/issues/3117)
- **N205** — `query-engine` — [[BUG]: Query extras resolve table names incorrectly](https://github.com/drizzle-team/drizzle-orm/issues/3110)
- **N206** — `migrations` — [[BUG]: Drizzle-Kit detects change when Composite Primary Key Columns are in different order than in schema definition](https://github.com/drizzle-team/drizzle-orm/issues/3103)
- **N207** — `migrations` — [[BUG]: uniqueIndex.on doesn't transform sql statement correctly for IFNULL](https://github.com/drizzle-team/drizzle-orm/issues/3101)
- **N208** — `migrations` — [[BUG]: UUID Error on push, but no issue via generate / migrate](https://github.com/drizzle-team/drizzle-orm/issues/3090)
- **N209** — `migrations` — [[BUG]: default value in migration generates invalid sql.ts file](https://github.com/drizzle-team/drizzle-orm/issues/3087)
- **N210** — `migrations` — [[BUG] `drizzle-kit generate` error introduced with bun 1.1.30 and sqlite](https://github.com/drizzle-team/drizzle-orm/issues/3083)
- **N211** — `migrations` — [[BUG]: Kit not handling default constraint name with casing option](https://github.com/drizzle-team/drizzle-orm/issues/3069)
- **N212** — `extensions` — [[FEATURE]: Dependency to deprecated package `@esbuild-kit/esm-loader`](https://github.com/drizzle-team/drizzle-orm/issues/3067)
- **N213** — `validation-types` — [[BUG]: drizzle-kit triggers a _ZodError when uniqueIndex is used together with sql lower](https://github.com/drizzle-team/drizzle-orm/issues/3062)
- **N214** — `migrations` — [[BUG]: Using Postgres "decimal" type with "customType" generates incorrect DDL](https://github.com/drizzle-team/drizzle-orm/issues/3051)
- **N215** — `migrations` — [[BUG]: `drizzle-kit push` always shows columns with custom types as changed even tho the type didn't change ](https://github.com/drizzle-team/drizzle-orm/issues/3047)
- **N216** — `validation-types` — [[BUG]: drizzle-kit introspect TypeError: Cannot read properties of null (reading 'camelCase')](https://github.com/drizzle-team/drizzle-orm/issues/3046)
- **N217** — `validation-types` — [[BUG]: Types aren't correctly inferred for nested `with: { where }` clauses](https://github.com/drizzle-team/drizzle-orm/issues/3045)
- **N218** — `extensions` — [[BUG]: depends on unmaintained library](https://github.com/drizzle-team/drizzle-orm/issues/3015)
- **N219** — `migrations` — [[BUG]:  `PostgresError: value "9223372036854776000" is out of range for type bigint` when running drizzle-kit push](https://github.com/drizzle-team/drizzle-orm/issues/3004)
- **N220** — `migrations` — [[BUG]: drizzle-kit introspection does not import "bigint" type when introspecting a MySql database.](https://github.com/drizzle-team/drizzle-orm/issues/2988)
- **N221** — `migrations` — [[BUG]:sqlite migration table using pg SQL syntax](https://github.com/drizzle-team/drizzle-orm/issues/2969)
- **N222** — `query-engine` — [[BUG]: findFirst and findMany queries using the 'with' statement can't parse the models if the related table has a geomtery column](https://github.com/drizzle-team/drizzle-orm/issues/2961)
- **N223** — `migrations` — [[BUG]: Invalid schema for default array value in Introspect / Pull / Drizzle Studio](https://github.com/drizzle-team/drizzle-orm/issues/2904)
- **N224** — `migrations` — [[BUG]: snapshot.json data is malformed](https://github.com/drizzle-team/drizzle-orm/issues/2897)
- **N225** — `migrations` — [[BUG]: the order of columns is causing redeclaration of UNIQUE constraint when using "drizzle-kit push"](https://github.com/drizzle-team/drizzle-orm/issues/2888)
- **N226** — `migrations` — [[BUG]: User defined types mismatch in drizzle-kit](https://github.com/drizzle-team/drizzle-orm/issues/2886)
- **N227** — `migrations` — [[BUG]: wrong migration code for alter column to timestamp ](https://github.com/drizzle-team/drizzle-orm/issues/2856)
- **N228** — `execution` — [[BUG]:Drizzle ORM not working with view](https://github.com/drizzle-team/drizzle-orm/issues/2850)
- **N229** — `migrations` — [[BUG]: drizzle-kit introspect generates wrong schema on sqlite. it surrounds sql function with quotes](https://github.com/drizzle-team/drizzle-orm/issues/2827)
- **N230** — `migrations` — [[BUG]: migrations do not work - table already exists - ER_TABLE_EXISTS_ERROR - mysql](https://github.com/drizzle-team/drizzle-orm/issues/2815)
- **N231** — `migrations` — [[BUG]: pg geometry is preventing migration](https://github.com/drizzle-team/drizzle-orm/issues/2806)
- **N232** — `migrations` — [[BUG]: When changing column type migration lacks USING statement on Postgres](https://github.com/drizzle-team/drizzle-orm/issues/2751)
- **N233** — `migrations` — [[BUG]: SQLite adding a `primaryKey()` constraint](https://github.com/drizzle-team/drizzle-orm/issues/2741)
- **N234** — `execution` — [[BUG]: Do statement double dollar sign not escaping cases where you want a "$" as a value](https://github.com/drizzle-team/drizzle-orm/issues/2710)
- **N235** — `query-engine` — [[BUG]: Drizzle Query Returns Different Result Than Select](https://github.com/drizzle-team/drizzle-orm/issues/2703)
- **N236** — `execution` — [[BUG]: drizzle-orm imported operators `eq`, `lt`, etc. unable to recognize left hand "table.column" param while callback syntax works](https://github.com/drizzle-team/drizzle-orm/issues/2698)
- **N237** — `execution` — [[BUG]: PG Numeric inferred as string, but is numeric at runtime](https://github.com/drizzle-team/drizzle-orm/issues/2681)
- **N238** — `execution` — [[BUG]: Geometry type ignores SRID option](https://github.com/drizzle-team/drizzle-orm/issues/2675)
- **N239** — `migrations` — [[BUG]: `drizzle-kit push` fails after first run with composite PKs](https://github.com/drizzle-team/drizzle-orm/issues/2626)
- **N240** — `execution` — [[BUG]: MySQL generatedAlwaysAs with notNull](https://github.com/drizzle-team/drizzle-orm/issues/2616)
- **N241** — `execution` — [[BUG]: Unique key reconciliation with upstream schema is inconsistent](https://github.com/drizzle-team/drizzle-orm/issues/2599)
- **N242** — `query-engine` — [[BUG]: Aggregated results from many-to-one relations doesn't return timestamp using postgres DB](https://github.com/drizzle-team/drizzle-orm/issues/2555)
- **N243** — `query-engine` — [[BUG]: Issues with nested conditions & placeholders in SQLite query](https://github.com/drizzle-team/drizzle-orm/issues/2529)
- **N244** — `query-engine` — [[BUG]:  Postgis `geometry` query select fails when using `with`](https://github.com/drizzle-team/drizzle-orm/issues/2526)
- **N245** — `migrations` — [[BUG]: drizzle-kit generate for unique index produces incorrect migration](https://github.com/drizzle-team/drizzle-orm/issues/2506)
- **N246** — `migrations` — [[BUG]:  pushing to db fails as it automatically adds drop primary key](https://github.com/drizzle-team/drizzle-orm/issues/2458)
- **N247** — `execution` — [[BUG]: Geometry config type doesn't appear to affect the output sql](https://github.com/drizzle-team/drizzle-orm/issues/2454)
- **N248** — `query-engine` — [[BUG]: relation query API default alias is different than regular alias](https://github.com/drizzle-team/drizzle-orm/issues/2431)
- **N249** — `execution` — [[BUG]: Typing issue when using tables with the same name across different schemas](https://github.com/drizzle-team/drizzle-orm/issues/2387)
- **N250** — `query-engine` — [[BUG]: Timestamp formatted differently if fetched as relation rather than directly](https://github.com/drizzle-team/drizzle-orm/issues/2282)
- **N251** — `execution` — [[BUG]: Warning: async_hooks.createHook is not implemented in Bun. Hooks can still be created but will never be called.](https://github.com/drizzle-team/drizzle-orm/issues/2239)
- **N252** — `migrations` — [[BUG]: Adding new column and unique key on the new column generates invalid migration file](https://github.com/drizzle-team/drizzle-orm/issues/2236)
- **N253** — `execution` — [[BUG]: encoding issue with non-ASCII characters](https://github.com/drizzle-team/drizzle-orm/issues/2235)
- **N254** — `query-engine` — [[BUG]: Query API does not include schema name when including child relations ](https://github.com/drizzle-team/drizzle-orm/issues/2194)
- **N255** — `execution` — [[BUG]: error: type "serial" does not exist](https://github.com/drizzle-team/drizzle-orm/issues/2183)
- **N256** — `migrations` — [[BUG]: Planetscale got packets out of order for 'serial' type on push](https://github.com/drizzle-team/drizzle-orm/issues/2180)
- **N257** — `execution` — [[BUG]: Drizzle Kit repeatedly modifies timestamp column with defaultNow() despite no schema changes](https://github.com/drizzle-team/drizzle-orm/issues/2136)
- **N258** — `migrations` — [[BUG]: drizzle-kit push:sqlite fails to apply migrations on a Turso (libsql) database when a table is modified on the Drizzle schema](https://github.com/drizzle-team/drizzle-orm/issues/2095)
- **N259** — `migrations` — [[BUG]: Postgres customType generate invalid SQL.](https://github.com/drizzle-team/drizzle-orm/issues/2087)
- **N260** — `migrations` — [[BUG]: SQLite migrations with default for timestamp_ms produces invalid sql](https://github.com/drizzle-team/drizzle-orm/issues/2085)
- **N261** — `query-engine` — [[BUG]: Deeply nested queries fail due to table name length](https://github.com/drizzle-team/drizzle-orm/issues/2066)
- **N262** — `migrations` — [[BUG]: on cascade delete issue with multiple foreign keys and migrations](https://github.com/drizzle-team/drizzle-orm/issues/2018)
- **N263** — `sql` — [[BUG]: Schema name is not prepended to the table name when aliased const.](https://github.com/drizzle-team/drizzle-orm/issues/1903)
- **N264** — `execution` — [[BUG]: Broken special characters in the git bash terminal](https://github.com/drizzle-team/drizzle-orm/issues/1886)
- **N265** — `execution` — [[BUG]: `Do not know how to serialize a BigInt` errors when using BigInt in `default(0n)` directive](https://github.com/drizzle-team/drizzle-orm/issues/1879)
- **N266** — `validation-types` — [[BUG]: Typescript doesn't recognize One-To-One Relation](https://github.com/drizzle-team/drizzle-orm/issues/1869)
- **N267** — `query-engine` — [[BUG]: sql`` interpolates the wrong table name when used in extras](https://github.com/drizzle-team/drizzle-orm/issues/1815)
- **N268** — `execution` — [[BUG]: Tables with hyphens seem to sometimes cause issues on `push`](https://github.com/drizzle-team/drizzle-orm/issues/1742)
- **N269** — `execution` — [[BUG]: pg-native Pools don't work with Transactions](https://github.com/drizzle-team/drizzle-orm/issues/1707)
- **N270** — `migrations` — [[BUG]: Drizzkle kit generate wrong SQL for Postgres enum arrays and double precision array.](https://github.com/drizzle-team/drizzle-orm/issues/1680)
- **N271** — `results` — [[BUG]: Custom types not working in `with` queries](https://github.com/drizzle-team/drizzle-orm/issues/1572)
- **N272** — `sql` — [[BUG]: ERROR: operator does not exist](https://github.com/drizzle-team/drizzle-orm/issues/1570)
- **N273** — `execution` — [[BUG]:Property 'notNull` in the timstamp type](https://github.com/drizzle-team/drizzle-orm/issues/1535)
- **N274** — `execution` — [[BUG]: eq function is nor working in 0.29.0](https://github.com/drizzle-team/drizzle-orm/issues/1488)
- **N275** — `execution` — [[BUG]: does nesting with blocks has threshold with pg](https://github.com/drizzle-team/drizzle-orm/issues/1477)
- **N276** — `migrations` — [[BUG]: ER_WRONG_AUTO_KEY - Drizzle Kit not detecting primary keys](https://github.com/drizzle-team/drizzle-orm/issues/1428)
- **N277** — `migrations` — [[BUG]: Error: Multiple primary key defined](https://github.com/drizzle-team/drizzle-orm/issues/1413)
- **N278** — `migrations` — [[BUG]: better-sqlite3 migration generates invalid default boolean](https://github.com/drizzle-team/drizzle-orm/issues/1406)
- **N279** — `query-engine` — [[BUG]: Unable to use orderBy clause on multiple relations when placed adjacently in a query (MySQL)](https://github.com/drizzle-team/drizzle-orm/issues/1396)
- **N280** — `query-engine` — [[BUG]: wrong typeHint when using relations (one and automatic limit: 1)](https://github.com/drizzle-team/drizzle-orm/issues/1368)
- **N281** — `query-engine` — [[BUG]: orderBy causes relational query to fail](https://github.com/drizzle-team/drizzle-orm/issues/1249)
- **N282** — `validation-types` — [[BUG]: `columns` partial select gives bad type with dynamic conditions](https://github.com/drizzle-team/drizzle-orm/issues/1163)
- **N283** — `query-engine` — [[BUG]: `mapWith` isn't working on `extras` when doing relational queries with `findFirst` or `findMany`](https://github.com/drizzle-team/drizzle-orm/issues/1157)
- **N284** — `query-engine` — [[BUG]: `findFirst` and `findMany` isn't correctly setting the table name when using sql directive `sql`${table}``](https://github.com/drizzle-team/drizzle-orm/issues/1149)
- **N285** — `migrations` — [[BUG]: Drizzle Kit should drop FK constraints and recreate them, when a new PK is defined for a table](https://github.com/drizzle-team/drizzle-orm/issues/1144)
- **N286** — `results` — [[BUG]: timestamp mode 'date' returns value.toISOString is not a function for parameterized inserts](https://github.com/drizzle-team/drizzle-orm/issues/1113)
- **N287** — `query-engine` — [[BUG]: where clause on relational query overwrites the table name](https://github.com/drizzle-team/drizzle-orm/issues/975)
- **N288** — `execution` — [[BUG]: error: column "role" cannot be cast automatically to type user_role](https://github.com/drizzle-team/drizzle-orm/issues/930)
- **N289** — `schema-relations` — [[BUG]: Relations inferring incorrect table with non-default Postgres schema](https://github.com/drizzle-team/drizzle-orm/issues/830)
- **N290** — `query-engine` — [[BUG]: Relational queries break customTypes with underlying DECIMAL dataTypes](https://github.com/drizzle-team/drizzle-orm/issues/820)
- **N291** — `results` — [[BUG]: Column with custom type not working with `default()`](https://github.com/drizzle-team/drizzle-orm/issues/818)
- **N292** — `schema-relations` — [[BUG]: Can't use views with relations API](https://github.com/drizzle-team/drizzle-orm/issues/769)
- **N293** — `migrations` — [[BUG]: Drizzle is bloating indexes on MySQL](https://github.com/drizzle-team/drizzle-orm/issues/706)
- **N294** — `query-engine` — [[BUG]: Relational query on sqlite/d1 with order-by has issues](https://github.com/drizzle-team/drizzle-orm/issues/705)
- **N295** — `execution` — [[BUG]: planetscale - now() and current_timestamp() doesn't work when FSP is specified for timestamp](https://github.com/drizzle-team/drizzle-orm/issues/472)
- **N296** — `migrations` — [[BUG]: MySQL alter table fails where tablename is reserved word](https://github.com/drizzle-team/drizzle-orm/issues/364)

### D.4 Corrections already in the prior audit (E001–E041)

All 41 canonical families below are represented by Appendix A.3's carried ledger. Exact prior-row mappings make the 43→41 normalization explicit.

#### D.4.1 rc.1 — 8 families from 10 prior rows

- **E001** — `results` — PostgreSQL JSONB string primitives were parsed twice and changed type ([#3018](https://github.com/drizzle-team/drizzle-orm/issues/3018)); prior row 1.
- **E002** — `results` — Bun SQL PostgreSQL timezone-aware timestamps had wrong/truncated timezone handling ([#5090](https://github.com/drizzle-team/drizzle-orm/issues/5090)); prior rows 2 and 5.
- **E003** — `sql` — Bun SQL PostgreSQL JSON/JSONB values were double-stringified ([#5287](https://github.com/drizzle-team/drizzle-orm/issues/5287)); prior rows 3 and 6.
- **E004** — `execution` — Neon HTTP `bytea` values were corrupted; prior row 4.
- **E005** — `sql` — View joins generated an `undefined` selected column ([#5112](https://github.com/drizzle-team/drizzle-orm/issues/5112)); prior row 7.
- **E006** — `sql` — Configured casing was not applied to raw `excluded.<column>` references ([#5282](https://github.com/drizzle-team/drizzle-orm/issues/5282)); prior row 8.
- **E007** — `migrations` — PostgreSQL view DDL mixed table and selected-column casing ([#4181](https://github.com/drizzle-team/drizzle-orm/issues/4181)); prior row 9.
- **E008** — `sql` — Casing-cache collisions for dynamic tables sharing a physical name rendered a later column as `undefined` ([#4209](https://github.com/drizzle-team/drizzle-orm/issues/4209)); prior row 10.

#### D.4.2 rc.2 — 7 families

- **E009** — `results` — A custom PostGIS polygon column selected a point decoder and failed every read ([#5711](https://github.com/drizzle-team/drizzle-orm/issues/5711)); prior row 11.
- **E010** — `validation-types` — PostgreSQL `.transaction` became an instance property and broke prototype inspection/extension ([#5709](https://github.com/drizzle-team/drizzle-orm/issues/5709)); prior row 12.
- **E011** — `execution` — AWS Data API codec/input-parameter mapping was incorrect; prior row 13.
- **E012** — `migrations` — SQLite generation failed to detect incompatible sibling branches; prior row 14.
- **E013** — `migrations` — SQLite snapshots collapsed multiple open leaves instead of retaining/merging them; prior row 15.
- **E014** — `execution` — Query and rollback error constructors lacked stable names; prior row 16.
- **E015** — `execution` — AWS Data API errors hid the database message; prior row 17.

#### D.4.3 rc.3 — 2 families

- **E016** — `execution` — Iteration threw when a driver could not stream instead of falling back to ordinary queries; prior row 18.
- **E017** — `execution` — MySQL proxy writes ignored dedicated `lastInsertId` and `affectedRows`; prior row 19.

#### D.4.4 rc.4 — 24 families

- **E018** — `validation-types` — Views selected from subqueries had broken public types; prior row 20.
- **E019** — `results` — Custom-type JSON decoders were ignored on SQL fields; prior row 21.
- **E020** — `results` — `.mapWith(column)` skipped column codecs ([#5724](https://github.com/drizzle-team/drizzle-orm/issues/5724)); prior row 22.
- **E021** — `results` — Subquery-selected fields lost their column codecs; prior row 23.
- **E022** — `execution` — Bun SQL PostgreSQL `db.select()` executed an empty projection ([#5779](https://github.com/drizzle-team/drizzle-orm/issues/5779)); prior row 24.
- **E023** — `execution` — SQLite `$count` lacked a sync executor for sync drivers; prior row 25.
- **E024** — `execution` — Some SQLite query errors escaped without `DrizzleQueryError`; prior row 26.
- **E025** — `validation-types` — `CockroachArrayBuilder` exposed an internal field type and caused TypeScript errors; prior row 27.
- **E026** — `validation-types` — Bun SQLite `.run()` had the wrong public result type; prior row 28.
- **E027** — `validation-types` — Query-builder `.comment()` lacked a string overload; prior row 29.
- **E028** — `execution` — Turso database/database-wasm drivers lacked working nested transactions; prior row 30.
- **E029** — `extensions` — SQLite cache reused one entry across different execute methods; prior row 31.
- **E030** — `results` — MySQL float decoding rounded to six digits or double; prior row 32.
- **E031** — `results` — MySQL cropped `.000` from `timestamp(3)`; prior row 33.
- **E032** — `results` — PostgreSQL/MySQL set operators lost or misapplied codecs after database coercion; prior row 34.
- **E033** — `sql` — `sql.param` passed a `Placeholder` object to an encoder instead of its value; prior row 35.
- **E034** — `execution` — An unguarded `Buffer` reference crashed Effect Schema without global `Buffer`; prior row 36.
- **E035** — `validation-types` — SQLite blob runtime default mode disagreed with its TypeScript mode ([#1064](https://github.com/drizzle-team/drizzle-orm/issues/1064)); prior row 37.
- **E036** — `validation-types` — Typed SQL `.mapWith()` dropped source nullability ([#571](https://github.com/drizzle-team/drizzle-orm/issues/571)); prior row 38.
- **E037** — `query-engine` — PostgreSQL identity columns were emitted in inserts when database-produced; prior row 39.
- **E038** — `query-engine` — `insert ... select` required every column and exact table order ([#3608](https://github.com/drizzle-team/drizzle-orm/issues/3608)); prior row 40.
- **E039** — `results` — Effect SQL PostgreSQL `db.execute` returned a wrapper instead of the promised raw response; prior row 41.
- **E040** — `migrations` — PostgreSQL pull failed for non-admin users by processing unrelated-schema identity metadata ([#5568](https://github.com/drizzle-team/drizzle-orm/issues/5568)); prior row 42.
- **E041** — `query-engine` — MSSQL inserts included computed `generatedAlwaysAs` columns ([#5881](https://github.com/drizzle-team/drizzle-orm/issues/5881)); prior row 43.
