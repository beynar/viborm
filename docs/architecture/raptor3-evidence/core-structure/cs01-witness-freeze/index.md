# CS-01 witness freeze

Date: 2026-09-13. Status: **frozen for independent review**.

CS-01 changes tests, registration, and documentation only. The accepted CS-00
TypeScript source is unchanged. The conservative executable fingerprint changes
because `vitest.workspace.ts` belongs to both identity inputs:

- production fingerprint:
  `255738d50148ee042f9590d311781892d770becd456c5f334780ec2fff282487`;
- harness fingerprint:
  `269f28cceb3edd2b25f1f654055fb3db6cd51ec571640985607d92ad86a9b771`;
- Node: `v24.21.0`; SQLite driver: `12.6.0`; Vitest: `3.1.4`.

`diff -qr --exclude=AGENTS.md /tmp/viborm-cs00-reference.FtGrx0/src src`
is empty. The only full-`src` difference is the post-CS-00 private `AGENTS.md`
status documentation; it is not executable and is excluded by the identity's
source-file extension filter.

## Frozen artifacts

| Artifact | SHA-256 | Cells |
| --- | --- | ---: |
| `tests/raptor3/core-structure/structural-reference.test.ts` | `d207472a30d4f0b1c8e36bf97dffad7a103504535735c72e8ec56677b06aa60e` | 10 supported |
| `tests/raptor3/core-structure/extension-a.contract.test.ts` | `0e5932c6eb3dfb485f5baa141f242c8b24c27937202a4bcb800c3720c3c52286` | 5 future/fence |
| `tests/raptor3/core-structure/extension-b.contract.test.ts` | `47c297494697f8341b4d5d129b985729a548017043d524b290ca78e4f582d2db` | 4 future |
| `tests/raptor3/core-structure/extension-composition.contract.test.ts` | `4d2a6e5096845f171c1b10d08bee59d8f96724013d5718553261f4e5ca9a5d04` | 3 future plus 1 supported control |
| `../cs01-measurement-contract.md` | `357787c51566f1b0c9ef4d58baabeccff9548c51e8cd6f7c762053ce80f492be` | Frozen comparison protocol |
| `common-witness.patch` | `0c1de6dd1a9995fdcc190e8e8384943cd9185133e005c08dce9907414376a946` | Tests plus exact registration |

The common patch applies with `git apply --check` to both accepted detached
worktrees:

- reference: `/tmp/viborm-cs00-reference.FtGrx0`;
- candidate: `/tmp/viborm-cs00-candidate.V7lUlt`.

Neither worktree was modified. After CS-01 acceptance the same frozen patch can
be applied to both; only the candidate then receives the CS-02 implementation.

## Executed contract

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm test:types` | Only historical Pattern TS2345 at `pack.ts:1443` and `:2633`; no CS-01 diagnostic | Native typecheck, 6.86 s, 5,554.0 MiB peak |
| `node scripts/run-raptor3.mjs cs01-structural-reference` | 10/10 pass | `viborm-raptor3-g0-LL8c4B/vitest.json` |
| `node scripts/run-raptor3.mjs cs01-extension-a` | 1/5 pass, four expected capability failures | `viborm-raptor3-g0-P1hVc3/vitest.json` |
| `node scripts/run-raptor3.mjs cs01-extension-b` | 0/4 pass, four expected capability failures | `viborm-raptor3-g0-W7d0en/vitest.json` |
| `node scripts/run-raptor3.mjs cs01-extension-composition` | 1/4 pass, three expected capability failures | `viborm-raptor3-g0-Gbbjbx/vitest.json` |
| `node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs` | 12/12 pass | Direct Node TAP output |

The future gates contain no skip, `.fails`, conditional registration, or
reference-specific pass route. Every current capability failure reaches the
existing `updateMany`/`deleteMany` limit-or-returning refusal. A's fifth cell
passes because it is the non-widening fence, not an implementation substitute.

## Correction provenance

The initial unregistered run `H1NWSc` is setup evidence only. Registered
structural attempts `IQslN6` (2/10), `fP4PcS` (5/10), and `rSRmMx` (8/10) are
retained as failed witness-development evidence. They do not establish a
production defect.

After the two bounded corrections, independent diagnosis showed that the two
remaining cases used a different resolved relation edge. Arnaud approved one
additional test-only correction without resetting the earlier budgets. The
final fixture binds a separately admitted real `kids.updateMany` consumer to
the same authoritative `kids` edge. It passes without changing production.

Independent review then found that the first composition fixture matched only
one root and selected a root-written value. It could not falsify an ignored cap
or an early terminal read. The replacement kept three future candidates and a
positive cap of one, then added a supported all-members control. `bLFMdC` first
exposed the control's nested-bin refusal. Removing the root scalar write
(`Qask2Y`) and replacing the ORM back-write with a synchronous SQLite trigger
(`CvOEYa`) did not change that refusal.

The precise observed cause was cross-member: one root member's provisional bin
write preceded the next root member's unconstrained bin capture without a
disjointness proof. It was not a shelf-versus-bin target-write conflict and did
not establish a general nested-series defect. Arnaud authorized one further
test-only correction without resetting the inherited budgets. The supported
control alone now selects `s1`; receipt `Gbbjbx` proves the nested series,
choice, trigger-driven final value, and exact one-member effects. The three
future cells remain `where: {}` over three candidates with positive `limit: 1`
or zero, and still fail only at the missing capability boundary.

CLI `viborm-raptor3-cli-IBh0jS` passed 7/7, history `qvZzWw` passed 4/4,
and choices `WvzXRG` passed 10/10 on the immediately preceding harness
`09642553…`. They are retained as development evidence only: the composition
fixture correction changed the harness fingerprint. CS-01 requires the final
focused contracts and registration self-test above; full CLI and retained-suite
qualification belong to CS-04.

## Comparison and accounting protocol

The tests pin behavior, not an implementation shape. CS-02 must separately
report the exact deletion of range splice/suffix restore, mirrored branch
observations, prefix copies/full-root reanalysis, and repeated contribution-owner
scans. The replacement must retain distinct occurrence identities, Selection
reuse, conditional arm ownership, series expansion placement, finalized direct
contribution references, logical/physical traversal order, prepare-all timing,
member-first failure, uncached absence, and the exact published-parent exclusion.

Reference and candidate run the same supported and future contracts. CS-03
implements A, B, and composition independently in each isolated worktree and
runs 100 deterministic seeds per applicable profile on each implementation.
Each slice reports Raptor-core and broader code-bearing lines, parser-owned
token leaves, source bytes, semantic owners/rules/exceptions, and measured
depth/width 1, 2, 8, and 32 traversal work. No unmeasured marginal saving,
runtime claim, or arbitrary policy flag counts as evidence.
