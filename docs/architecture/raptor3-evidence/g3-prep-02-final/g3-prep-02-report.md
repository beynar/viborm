# Raptor 3 — G3P-02 final evidence

Date: 2026-09-09. Status: **implemented and qualified; independent review
pending. G3P-02, G3 preparation, and G3 are not accepted. G3P-03 remains
closed.**

## Outcome

G3P-02 now has one owner for each relevant fact:

- [`evidence-directory.ts`](../../../../tests/raptor3/harness/evidence-directory.ts)
  chooses a configured non-empty evidence directory or a private temporary
  directory. The transport and diagnostic corpus callers both consume it.
- [`keys.ts`](../../../../src/schema/model/keys.ts) owns the model-local public
  selector catalog and reports actual namespace overlaps. The one mandatory
  schema rule in [`model.ts`](../../../../src/schema/validation/rules/model.ts)
  emits I006 when a compound selector reuses any model field, `AND`, `OR`,
  `NOT`, or another compound selector. Separate models may reuse the spelling.
  Mapped columns and provider constraint names are not in this namespace.
- [`validator.ts`](../../../../src/schema/validation/validator.ts) applies I006 at
  the existing client, command-engine, and migration schema-admission boundary.
  Rejected definitions fail before callbacks or provider work. The ordinary
  same-kind builder guard remains only to preserve the first tuple before its
  record storage can overwrite it.
- [`constraint-identity.ts`](../../../../src/adapters/constraint-identity.ts) is the
  private adapter projection from the admitted schema key to its dialect's
  physical constraint identity. The stock adapters install it through the
  existing private adapter internals. It does not add a public adapter member.
- [`execution.ts`](../../../../src/query-engine/raptor3/commands/execution.ts)
  matches the one selected schema key against the adapter descriptor and the
  driver's normalized `UniqueConstraintError`. It requires the exact rejected
  INSERT producer. It does not parse provider messages or widen recovery.
  [`unique-conflict-target.ts`](../../../../src/query-engine/unique-conflict-target.ts)
  and [`JunctionStatements.ts`](../../../../src/query-engine/JunctionStatements.ts)
  consume the same physical-name owner, removing duplicate `_pkey`, `PRIMARY`,
  and `_key` synthesis from current-engine and junction placements.

A compound selector is a public query name for a compound ID or unique tuple;
it is not another model field. This definition is recorded in
[`CONTEXT.md`](../../../../CONTEXT.md). A rejected collision requires a schema
rename by the caller. VibORM does not choose precedence, rename the selector,
or migrate a database automatically.

The net driver contract is unchanged. During implementation, SQLite public
error metadata was mistakenly changed from qualified columns to a new
table/column shape. The full G2 gate caught two regressions (214/216) in
[`g2-contracts-compatibility-red.vitest.json`](receipts/g2-contracts-compatibility-red.vitest.json).
That unapproved change and its test expectations were restored. The adapter now
derives a private expected SQLite descriptor in the established qualified-column
shape; driver normalization remains authoritative. The minimized supplier gate
then passed 10/10 and the full G2 gate passed 216/216. The procedural lesson is
recorded in [`memory.md`](../../../../memory.md): a private ownership refactor does
not authorize a public-output compatibility change.

## Identity and accounting

The [index](g3-prep-02-index.json) binds an exact SHA-256 manifest for every
unit source and harness file, and the
[`SHA256SUMS`](g3-prep-02-SHA256SUMS) file binds every final evidence artifact.
The established Raptor runner records production
identity
`4c004953fa33571114dcad428a83a6fc25007f1b5b0999c0d9f5354231b27288`
and harness identity
`2d9e094375c4d60bfa1de86a6b2c401d3acefce26f031192f005d975ecd71f78`.
The seven final registered `review-final` receipts and both final native
`.verified.json` receipts embed those values. The exact per-receipt audit is:
evidence-directory 4/4, G1 comparison 66/66, G1 transport 44/44, G2 contracts
216/216, G2.5 6/6, G2.7 6/6, disputed diagnostics 2/2, PostgreSQL 5/5, and
MySQL 5/5; all nine record production `4c004953…` and harness `2d9e0943…`.

The [cost receipt](g3-prep-02-cost.json) uses a broader whole-owner source
census. Its identity is
`90c06cdb11497844fb464b560335303218b87717ea82624574f65297c46d45c5`.
The difference is scope and algorithm, not a source mutation: the cost manifest
includes every changed shared schema, adapter, driver, legacy-engine, and
candidate owner, while the runner identity uses the established Raptor
production manifest. Both exact manifests are retained.

The command candidate now charges 8,222 production token-lines across 28 whole
files (10,619 physical lines; 371,587 bytes). Of that total, 4,074 token-lines
across 16 files are retained/shared owners. The accepted G2.7 parent measured
4,592 token-lines under its earlier narrow scope. The
[matched-scope companion](g3-prep-02-matched-cost.json) uses the frozen G3P-01
per-file census to make the difference explicit: 3,516 lines already existed
but were outside the old candidate charge, so the same-owner parent is 8,108
lines. The final 8,222 total is a **114-token-line matched-scope increase**:
5 lines in the existing command language and 109 across shared owners,
including the new 47-line constraint-identity owner. Thus 3,630 is the total
scope difference, not newly written engine code. These values are whole-file
counts with no proportional discounts and are not a completion percentage. No
bundle-size claim is made; the cost receipt is explicitly source-accounted with
bundle measurement pending.

## Final validation

All commands ran serially on the frozen source under the existing resource
owners. Focused Vitest commands used `scripts/run-vitest-safe.mjs` with one
worker, 768 MiB heap, 1,536 MiB sampled process-group RSS, and a 120-second wall
limit. Registered Raptor gates used `scripts/run-raptor3.mjs`, which invokes the
same wrapper and validates file/count/identity receipts.

| Boundary | Final result | Receipt |
|---|---:|---|
| I006 schema matrix, including ordinary and variant relations | 35/35 | [`schema-boundary-green-review-final`](receipts/schema-boundary-green-review-final.vitest.json) |
| Public client construction | 12/12 | [`client-boundary-green-final-2`](receipts/client-boundary-green-final-2.vitest.json) |
| Trusted model-key catalog | 22/22 | [`model-key-catalog-green-final-2`](receipts/model-key-catalog-green-final-2.vitest.json) |
| Private adapter constraint identity | 20/20 | [`adapter-constraint-names-green-final-2`](receipts/adapter-constraint-names-green-final-2.vitest.json) |
| Driver normalization, unchanged public output | 79/79 | [`driver-constraint-normalization-green-final`](receipts/driver-constraint-normalization-green-final.vitest.json) |
| Minimized repaired G2 supplier pair | 10/10 | [`g2-supplier-compatibility-green`](receipts/g2-supplier-compatibility-green.vitest.json) |
| Actual evidence-directory callers | 4/4 | [`evidence-directory-green-review-final`](receipts/evidence-directory-green-review-final.verified.json) |
| G1 comparison | 66/66 | [`g1-comparison-green-review-final`](receipts/g1-comparison-green-review-final.verified.json) |
| G1 transport | 44/44 | [`g1-transport-green-review-final`](receipts/g1-transport-green-review-final.verified.json) |
| Full G2 contracts | 216/216 | [`g2-contracts-green-review-final`](receipts/g2-contracts-green-review-final.verified.json) |
| G2.5 polish | 6/6 | [`g25-contracts-green-review-final`](receipts/g25-contracts-green-review-final.verified.json) |
| G2.7 ownership | 6/6 | [`g27-contracts-green-review-final`](receipts/g27-contracts-green-review-final.verified.json) |
| PostgreSQL native constraints | 5/5 | [`native-pg-green-final-harness`](receipts/native-pg-green-final-harness.verified.json) |
| MySQL native constraints | 5/5 | [`native-mysql-green-final-harness`](receipts/native-mysql-green-final-harness.verified.json) |

Every result above has zero failed and zero pending tests. The existing
`g2-diagnostics` gate also reproduced its two disputed behaviors; its
[`2/2 receipt`](receipts/g2-diagnostics-disputed-review-final.verified.json) is not
qualification evidence and is not relabeled as accepted behavior.

The final native witness has SHA-256
`7459bdbeadf333cb3f21c1bd96e7e9ddf832fa800f32252efa50c4d56739b7e6`.
Each provider executes five independently reported cases: mapped scalar root
recovery, mapped compound nested recovery, definition-time collision refusal
plus distinct-name controls, unrelated-constraint refusal, and wrong-table
producer refusal. Thus the changed rules have a second placement: I006 is
proved at public client and private candidate construction plus migration
admission, while physical identity is proved at root and nested recovery and
at current-engine/junction consumers.

PostgreSQL used cached image
`sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b`
and runtime 16.14. The final harness run used container `dd0eae3eb1b4…`.
MySQL used cached image
`sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb`
and runtime 8.4.11, container `5a3c768b23df…`. Both used random loopback
ports, task-owned databases, tmpfs storage, two CPUs, and 1 GiB memory. Explicit
provider readiness passed. Before removal each was running with `OOMKilled=false`
and zero restarts. Both exact containers were removed, and the task-label census
was empty. The earlier PostgreSQL post-run inspection tried to read a Docker
Health field that this image does not define; that run remains valid runtime
evidence but the later final-harness run is the accepted resource-bound receipt.

Whole-estate typecheck is not green because of two unchanged errors in
`src/query-engine/pattern/pack.ts` at lines 1443 and 2633, outside G3P-02
ownership. The first run also found nine strict-type errors in the new native
witness. Its owner changed only existing runtime assertions into control-flow-
narrowing assertions. The second run has none of those nine errors and retains
only the same two Pattern errors. Exact outputs and resource bounds are in
[`typecheck-final-source-failure.txt`](receipts/typecheck-final-source-failure.txt)
and
[`typecheck-review-final-known-pattern-failure.txt`](receipts/typecheck-review-final-known-pattern-failure.txt).
This is a disclosed external estate failure, not a G3P-02 green typecheck claim.

## Failure and interim receipt integrity

The approved I006 change has real red-to-green evidence. Public schema/client
reds and native PostgreSQL/MySQL 4/5 reds are recorded in
[`native-definition-red-output.md`](native-definition-red-output.md) and the
adjacent `native-*-definition-red*.vitest.json` receipts. The failed collision
case observed the missing I006; the other four provider cases passed.

No failed or intermediate run is relabeled:

- Five zero-test JSON receipts are selection failures caused by using the wrong
  Vitest project: `adapter-constraint-names-green-final`,
  `client-boundary-green-final`, `model-key-catalog-green-final`,
  `schema-boundary-green-final`, and `schema-boundary-green-final-2`.
- `schema-boundary-green.vitest.json` is 33/34 because it retained a stale
  builder-time expectation after the approved admission decision.
- `driver-constraint-normalization-green.vitest.json` is 75/79 because its test
  scaffold omitted a destructured label. The later 79/79 receipts supersede it.
- `native-pg-green-attempt-1` and `native-pg-green-attempt-2` are 4/5 fixture
  failures: the first counted raw catalog attestations in the typed statement
  recorder; the second expected non-canonical seed order. The witness also had
  an earlier terminal-failure masking issue. These were test repairs, not engine
  behavior changes.
- `g2-contracts-compatibility-red.vitest.json` is the 214/216 production
  compatibility regression caused by the mistaken SQLite public metadata
  change. It is the one bounded production repair described above.
- Green receipts without a filename listed in the final table are interim
  evidence from an earlier source or harness identity. They remain immutable
  and are not part of the final qualification set.
- Specifically, the seven earlier registered receipts named `*-final` embed
  harness `0b8d371d…`, before the native witness reached its final shape. They
  are superseded by the distinct `*-review-final` receipts, which all embed
  harness `2d9e0943…`. The production identity is `4c004953…` in both sets.

The earlier paused bundle under [`../g3-prep-02`](../g3-prep-02/g3-prep-02-report.md)
also remains immutable. It records the evidence-directory red/green, the
four-case undisputed native partial, and the compatibility question before
Arnaud selected definition-time refusal. This report advances the live unit; it
does not rewrite that history.

## Review handoff

The implementation, manifests, tests, cost receipt, and final evidence are
frozen for independent Sol 5.6/high review. Review must verify the single I006
admission owner, the absence of selector precedence, the private-only adapter
descriptor, unchanged driver error output, exact rejected-INSERT producer
matching, both provider catalogs, all failed-run classifications, and both
identity scopes. G3P-02 remains pending until that review accepts it. G3P-03
must not start before acceptance.
