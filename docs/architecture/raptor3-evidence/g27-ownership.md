# Raptor 3 G2.7 execution-ownership freeze

Date: 2026-09-09

## Current status

**G2.7 is complete.** G2.7-01, G2.7-02, and G2.7-03 passed independent review,
and the single root global review accepted the frozen implementation. G3 is not
started. The unit sections below preserve their as-of-review checkpoints; any
pending-review statement inside them is historical, not the current status.
The immutable qualification archive intentionally retains that earlier state.

## Historical checkpoint — G2.7-01 outcome

G2.7-01 is complete. It freezes one private execution-ownership clarification
before G3. Production source, tests, runners, manifests, public routing, and
driver APIs are unchanged. `commands/` remains selected; `program/` remains a
comparison specimen.

The private call becomes `execute(modelName, operation, rawArgs, binding?)`,
where the exact optional forms are:

```ts
type ExecutionBinding =
  | { readonly kind: "borrowed-transaction"; readonly driver: AnyDriver }
  | { readonly kind: "atomic-array" };
```

- Omitted preserves the factory driver. Interactive writes keep their
  operation-owned transaction; reads remain direct; no-transaction drivers keep
  qualified batch segmentation, acknowledgement, progress, and recovery.
- `borrowed-transaction` executes directly through the exact supplied
  transaction-bound driver. The candidate does not begin, commit, roll back,
  savepoint, disconnect, or replay. The driver owns lifecycle and explicit
  nested savepoints.
- `atomic-array` raises `TransactionError` before admission,
  defaults/transforms, or provider work. It does not
  implement array execution.
- `OperationContext` resolves ownership once. Rename private `atomic` to
  `usesBatch`; it means physical queue/submit routing, not general atomicity,
  ownership, replay eligibility, or commit certainty.

Do not add downstream shape validation, driver detection, an options-boolean
matrix, a universal scope class, or another interpreter. Admission remains once
and internal values remain trusted. Command/transport attempt replacement and
operation-lifetime admission, continuation, progress, acknowledgement, and
standalone recovery facts retain their current owners. Borrowed execution has no
replay allowance. Full arrays, public callback/array integration, bulk,
suppression, wider retry, and recursive composition remain G3.

The unchanged whole-owner census is
[`g27-baseline-cost.json`](g27-baseline-cost.json). It reused the parser-token
definition in `scripts/query-engine-structure.mjs`.

| Cost | Frozen value |
|---|---:|
| Commands language | 2,124 token-bearing lines |
| Shared private engine | 1,990 token-bearing lines |
| Retained owners | 449 token-bearing lines |
| Complete candidate | **4,563 token-bearing / 4,980 physical lines / 164,394 bytes** |
| Historical G2 | 4,342 token-bearing lines |
| Delta from G2 | +221 lines (+5.09%) |

The census recorded HEAD `3a291a59764eae961bb105136c155298a9f1191f`,
no production working-tree changes, and calibration identity
`7b5e72064164e274d2daf72300bd15e2aaeefefeddea3ca5b63a46b8e67d28c4`.
Historical receipts are not relabeled.

| Requirement | Existing witness | Disposition |
|---|---|---|
| Omitted binding and standalone driver | `commands/index.ts`; all current candidate fixtures | Preserve |
| Interactive transaction and rollback | `candidate.test.ts`; S1 rollback in `scenarios/contracts/conditional.ts` | Preserve |
| Batch segments, acknowledgement, progress, recovery | `g2-transport.test.ts`; `expanded/batch-produced.ts`; `transitions/supplier-continuations.ts`; `polish/supplier-fields.ts`; recovery fixtures | Preserve |
| One admission and attempt-lifetime facts | G1 instance cases; G2 campaign; `polish/recovery-live.ts`; command/transport attempts | Preserve |
| Exact borrowed driver, direct read/write execution, and concurrent isolation | No candidate binding exists; read and write use separate entry branches | Missing G27-F01a–F01c |
| Atomic-array refusal before admission/provider work | Shipped client has an analogous error; candidate has no binding | Missing G27-F03 |
| Driver-owned explicit savepoints | Driver-only tests prove the substrate, not the candidate binding | Missing candidate-integrated G27-F01d |
| Native PostgreSQL and MySQL borrowed execution | Existing native gates use standalone candidate engines | Missing G27-F01e; execute in G2.7-03 |
| Trusted normalized failure remains exact without replay | Existing recovery fixtures use standalone ownership | Missing G27-F02 |
| Batch routing is not an atomicity promise | Current behavior exists, but the field is named `atomic` | Mechanical rename; no new model |
| Comparison specimen remains runnable | `g1-compare` | Mechanical compatibility only |

The new binding-path falsifiers are:

1. **G27-F01a — borrowed read:** exercise the separate read entry branch and
   prove direct dispatch through the exact supplied driver, never the factory
   driver, with zero candidate lifecycle, savepoint, or disconnect calls.
2. **G27-F01b — borrowed write:** execute inside a caller-opened transaction and
   prove the exact supplied driver performs the write, the candidate opens no
   nested scope, and only the caller's later commit or rollback determines
   persistence.
3. **G27-F01c — concurrent isolation:** overlap two calls carrying distinct
   borrowed drivers and prove every read/write remains on its supplied driver;
   no mutable context or factory transport crosses calls.
4. **G27-F01d — explicit savepoint ownership:** let the caller invoke the
   transaction driver's existing `withTransaction` savepoint and run the
   candidate through the resulting bound driver. Prove exactly that one
   caller-owned savepoint and zero candidate-created savepoints.
5. **G27-F01e — native conformance (G2.7-03):** run borrowed reads and writes on
   both native PostgreSQL and native MySQL transaction drivers, including
   caller-controlled commit and rollback. Deterministic substitutes do not
   qualify this provider witness.
6. **G27-F02 — trusted failure identity:** inject an already-normalized,
   recovery-shaped driver failure and require the identical failure value,
   cause, and metadata to escape unchanged after one attempt, with no factory
   fallback, implicit lifecycle/disconnect, or recovery replay.
7. **G27-F03:** make admission/default/transform and provider/lifecycle entries
   observable; require `TransactionError` with zero observations and calls.

No separate runtime falsifier is justified for the `usesBatch` spelling or for
forbidden machinery that must remain absent; source review plus existing
semantic gates own those checks.

## Validation

All runs were serial. Every bounded launcher verified teardown. Raptor receipts
share production identity
`dafdda6ae547ca38bddd49fdd7358fa87221d1e83c41d5fb7cb217979444018d`
and harness identity
`b720e2f0a11d0cd8a1ec00f94319310a22ee92648db94919752ae832a34a3e9f`.
Runtime: Node v24.20.0, better-sqlite3 12.6.0, Vitest 3.1.4, macOS arm64;
limits: 768 MiB heap, 1,536 MiB sampled group RSS, 120 s child wall.

| Command | Result | Peak RSS |
|---|---:|---:|
| `node scripts/run-node-safe.mjs 768 120000 scripts/measure-raptor3-baseline.mjs --output docs/architecture/raptor3-evidence/g27-baseline-cost.json` | passed | 363.9 MiB |
| `node scripts/run-raptor3.mjs g1-compare` | 4 files / 66 passed / 0 skipped | 707.8 MiB |
| `node scripts/run-raptor3.mjs g2-contracts` | 16 / 216 / 0 | 793.6 MiB |
| `node scripts/run-raptor3.mjs g2-transport` | 1 / 16 / 0 | 676.3 MiB |
| `node scripts/run-raptor3.mjs g25-contracts` | 1 / 6 / 0 | 513.5 MiB |

No typecheck ran, so G2.7-01 makes no new type-qualification claim. The expected
G2.7-03 baseline remains only the existing Pattern errors at
`pattern/pack.ts:1443` and `:2633`.

## Risks

This unit does not prove F01–F03. It does not run generated campaigns, external
replay, native providers, package, bundle, performance, or type qualification.
G2.7-03 owns full fixed/generated/transport/native PostgreSQL/MySQL evidence,
both complete G2 campaigns, fresh replay, native typecheck, and final cost.
This baseline does not start G3 or upgrade older receipts to this identity.

## G2.7-02 implementation outcome

The private ownership seam is implemented and ready for independent review.
`OperationContext` makes one `standalone` or `borrowed-transaction` decision,
retains only the selected driver, and derives `usesBatch` only for standalone
execution. Borrowed reads and writes call the exact supplied transaction driver
without a candidate transaction, savepoint, disconnect, factory fallback, or
recovery replay. `atomic-array` throws `TransactionError` while the context is
created, before the raw arguments reach admission. The private command entry is
the selected implementation; the program comparison received only the same
optional call shape and context construction order.

The focused witnesses resolve the frozen gaps as follows:

| Requirement | G2.7-02 witness |
|---|---|
| G27-F01a borrowed read | `ownership/commands.test.ts`: exact borrowed row, zero factory dispatch/lifecycle, zero candidate savepoint/disconnect |
| G27-F01b borrowed write | Same file: caller commit persists and caller rollback does not |
| G27-F01c concurrent isolation | Same file: two overlapped calls retain distinct borrowed databases and never touch the factory |
| G27-F01d savepoint ownership | Same file: zero implicit savepoints, then exactly one caller-owned `SAVEPOINT`/`RELEASE` pair |
| G27-F01e native conformance | `ownership/live.test.ts`, registered as `g27-pg-contracts` and `g27-mysql-contracts`: caller rollback plus borrowed read/write/commit; execution remains assigned to G2.7-03 |
| G27-F02 trusted failure | `ownership/commands.test.ts`: a borrowed root upsert observes its selector absent once, then its matching missing-arm `INSERT` fails; the exact error, cause, and metadata objects escape with no winner lookup, replay, factory work, savepoint, or disconnect |
| G27-F03 early refusal | Same file: hostile input reflection, scalar transform, default evaluation, driver dispatch, transaction entry, and disconnect all remain zero |

The final witness harness was also run against the pre-G2.7 private engine in
an isolated workspace; live source was never restored or overlaid. The private
runtime extracted from archive
`68b513729abde95c698f20396c61a6ed03ecbb31f882b396ce1208a33a935b6b`
matched the snapshot exactly: 15 files, 168,619 bytes, and tree fingerprint
`6ed92ea3400b5a2eab926dde37100193bc18a8fc99a28d6f952acfb375fa5b59`.
The complete harness-identity file set also matched the green workspace byte
for byte. It covers `tests/raptor3`, `scripts`, `benchmarks`, the public-client
CLI helper, and the six configuration files named by
`captureRaptor3Identity`.

That red composition has production fingerprint
`39b1e7176748d77390acb14b001c19abe8463dfdd8b4c0b11bd47a5a817a74f3`
and final harness fingerprint
`c00265252b8300053db26dcfc0e30e79ac8d61e3f01f770b4c3eec85ed3ed41e`.
It is deliberately described as the **pre-G2.7 private engine with final
witness harness**, not as the untouched earlier full-source identity: the
production lane hashes every current `src` file plus shared configuration, and
those configuration files also participate in the harness lane. In particular,
the final `vitest.workspace.ts` necessarily changes both fingerprints.

`node scripts/run-raptor3.mjs g27-contracts` ran one file and six tests with
zero skips; all six failed on the archived private engine. The old entry used
the factory for borrowed reads and writes, did not preserve the injected failed
missing-arm `INSERT`, and admitted `atomic-array`. The bounded report SHA-256
is `7a540bc3d1d6a9c159e1d7a092759ef593a82c8b3cda9b7a189d46604547b867`.
The durable composition and result receipt is
[`g27-unit2-red.json`](g27-unit2-red.json).

## G2.7-02 validation

All final focused receipts share production identity
`9a4964d55ba06358f5bcbadd76142a93a18379cac1db5f1fa5d7ba99b8733374`
and harness identity
`c00265252b8300053db26dcfc0e30e79ac8d61e3f01f770b4c3eec85ed3ed41e`.
Runs were serial, and every bounded launcher verified teardown.

| Command | Result | Peak RSS | Evidence directory |
|---|---:|---:|---|
| `node scripts/run-raptor3.mjs g27-contracts` | 1 file / 6 passed / 0 skipped | 506.7 MiB | `viborm-raptor3-g0-s5MsSe` |
| `node scripts/run-raptor3.mjs g1-compare` | 4 / 66 / 0 | 724.5 MiB | `viborm-raptor3-g0-QiW6D7` |
| `node scripts/run-raptor3.mjs g2-contracts` | 16 / 216 / 0 | 775.2 MiB | `viborm-raptor3-g0-o29S4V` |
| `node scripts/run-raptor3.mjs g2-transport` | 1 / 16 / 0 | 642.8 MiB | `viborm-raptor3-g0-ChXzIC` |
| `node scripts/run-raptor3.mjs g25-contracts` | 1 / 6 / 0 | 509.4 MiB | `viborm-raptor3-g0-JVfIYL` |

The final native whole-estate typecheck used 5,668.6 MiB. It reports no G2.7
errors and exits 1 only for the two pre-existing errors at
`src/query-engine/pattern/pack.ts:1443` and `:2633`.

## G2.7-02 risks

The native provider fixture port was unavailable, so neither newly registered
PostgreSQL nor MySQL gate was executed in this unit. G2.7-03 still owns those
executions and the full fixed/generated/transport/provider/campaign/replay/cost
closure. Independent G2.7-02 review is pending. No public route or driver API
changed, and this unit does not start G3.

## G2.7-03 qualification outcome

The final private source is qualified for the frozen execution-ownership scope.
All checks ran against production identity
`9a4964d55ba06358f5bcbadd76142a93a18379cac1db5f1fa5d7ba99b8733374`
and harness identity
`c00265252b8300053db26dcfc0e30e79ac8d61e3f01f770b4c3eec85ed3ed41e`.
The [source-bound index](g27-closure-index.json), [run record](g27-closure-runs.log),
[cost receipt](g27-cost.json), and `g27-closure-evidence.tar.gz` preserve the
qualification. Its [checksum sidecar](g27-closure-evidence.sha256) records
the final archive SHA-256 outside the archive bytes.

The native ownership witness now passes once on PostgreSQL and once on MySQL.
The caller owns each real provider transaction; the candidate uses the exact
bound driver for read/write and owns no lifecycle, savepoint, replay, or factory
fallback. This completes G27-F01e. The six local witnesses continue to cover
G27-F01a–d, F02, and F03.

### Validation

Every registered fixed gate ran unfiltered. Each qualifying Vitest gate had
zero skips and verified teardown under the fixed 768 MiB heap, 1,536 MiB sampled
group-RSS, and 120 second child limits.

| Gate | Fresh result | Receipt suffix |
|---|---:|---|
| Campaign receipt integrity | 7 passed / 0 skipped | bounded Node receipt |
| G0 fixed/gate | 33 / 0 | `uO0LBC` |
| G1 baseline / contracts / comparison | 141 + 143 + 66 / 0 | `TlBZwo`, `UCUMef`, `cIA5e9` |
| G1 generated / transport | 35 + 44 / 0 | `rV65rS`, `mZvaUr` |
| G2 baseline / contracts | 216 + 216 / 0 | `Ilb4CG`, `A67Cjk` |
| G2 generated / transport | 52 + 16 / 0 | `MP4yQ5`, `HdppDZ` |
| G2.5 polish / G2.7 ownership | 6 + 6 / 0 | `3ZEV1M`, `Pao1dt` |
| PostgreSQL baseline / G2 / G2.5 / G2.7 | 17 + 18 + 2 + 1 / 0 | `om1SdT`, `amti07`, `KjGnue`, `vX95Mq` |
| MySQL baseline / G2 / G2.7 | 13 + 13 + 1 / 0 | `n3mB7o`, `jEiXXI`, `q6JEcB` |
| External polish / conditional-upsert replay | 1 + 1 / 0 | `BYMrQC`, `3AUHG3` |
| Disputed diagnostic reproducer | 2 / 0; non-qualifying by design | `WfLpDs` |

SQLite parent `viborm-raptor3-g2-seeds-vxe7OO` and scripted-transport
parent `viborm-raptor3-g2-transport-seeds-Nyq9yY` each contain 50 exact batch
receipts, 5,000 seeds on each of two profiles, 10,000 seed/profile cells,
30,000 exact candidate replays, and zero skips. Together: 20,000 cells and
60,000 replays. No historical receipt is relabelled as fresh.

The fresh polish corpus SHA-256 is
`a0878177c79b1a7e94f59d6d36e58dc2e6d48412374c8381e2c680a6198b2c9d`;
the conditional-upsert corpus SHA-256 is
`32d47656ed1c4cd0452b08d198e0f2cf2733e994d75e5ac01f9c6d1479e60cdd`.
Both were written by final-source gates and consumed by the external replay
command, which rechecked identity and bytes.

The native whole-estate typecheck completed in 5.31 seconds at 5,566.5 MiB
sampled group RSS under its existing 8,192 MiB ceiling. It reports only the two
pre-existing Pattern TS2345 errors at `src/query-engine/pattern/pack.ts:1443`
and `:2633`; there is no G2.7 or harness type error.

### Cost and ownership review

`g27-cost.json` has calibration source identity
`c746ec6dd5f0e91263343f562cc98aaeb5d6551327e268972563e358bbc0fb7b`
and SHA-256
`f5ad262aa47342bc160963c009442549c1d6fb959761112cb32e10221b09ef7d`.
It charges source maps, retained integration, and every mixed owner whole.

| Charged scope | Freeze | Final | Delta |
|---|---:|---:|---:|
| Command language | 2,124 | 2,129 | +5 |
| Shared private engine | 1,990 | 2,014 | +24 |
| Retained owners | 449 | 449 | 0 |
| **Total code-bearing LOC** | **4,563** | **4,592** | **+29** |
| Physical lines | 4,980 | 5,011 | +31 |
| Source bytes | 164,394 | 165,458 | +1,064 |

The final source is +250 code-bearing LOC against historical G2 (4,592 versus
4,342). The +29 G2.7 delta puts the optional private call shape and one-time
ownership decision in the existing entry/context owners. It adds no interpreter
or lifecycle owner. The mechanical program compatibility change is fully charged
in the separately reported 3,089-line comparison candidate; it is not included
in the selected command candidate's 4,592 lines. This is an explicit ownership
review, not a package reduction, whole-engine compression, bundle, declaration,
or performance claim.

### Native safety and limits

This unit created only `viborm-raptor3-g27-pg-20260901` and
`viborm-raptor3-g27-mysql-20260901`, labelled
`viborm.test=raptor3-g27`. They used random loopback ports, test database
`raptor3_g2`, one CPU, 512/768 MiB memory limits, 256/512 MiB tmpfs data, and no
host mounts or user credentials. Final probes returned PostgreSQL 16.14 and
MySQL 8.4.11; both had zero OOM kills and restarts. Only those exact containers
were stopped and removed; the ownership-label census is empty.

The documented aggregate CLI command,
`node scripts/run-node-safe.mjs 768 600000 scripts/raptor3-cli.test.mjs`, passed
7/7 tests with zero failures or skips in 200.28 seconds at 217.8 MiB peak sampled
group RSS; teardown was verified. Fresh evidence is
`viborm-raptor3-cli-JfwByI`. The 600 second allowance bounds the aggregate
runner; each subordinate child retains its own 120 second deadline. Independent
unit3 review and the final global review remain pending. G3, public
callback/array integration, bulk, suppression, wider recovery, package, bundle,
declaration, and performance qualification remain outside this closure.

## Final review acceptance

Independent review accepted G2.7-01, G2.7-02, and G2.7-03, including all 100
campaign batches and archive preservation. The final root global review then
accepted the frozen implementation: exactly five runtime files differ from the
pre-G2.7 source, limited to the private entry/context ownership change and the
mechanical `atomic` to `usesBatch` consumer rename. It found no command-language
redesign, new interpreter, public wiring, or movement of G3 obligations.

The accepted identities are production
`9a4964d55ba06358f5bcbadd76142a93a18379cac1db5f1fa5d7ba99b8733374`, harness
`c00265252b8300053db26dcfc0e30e79ac8d61e3f01f770b4c3eec85ed3ed41e`, and frozen
archive
`f54dfc6e74e6a18b998beb787567ae09bf17bb1110cc05361a2c698db49b1063`.
The root also reran `g27-contracts` (6/6, zero skips) and `g2-transport` (16/16,
zero skips) serially with teardown verified and those exact source identities.
This final attestation is live documentation outside the immutable qualification
archive; it does not relabel or rebuild the archive's as-of-review contents.

G3 still owns public callback/array integration and packaging, set-oriented and
relation-bearing bulk, suppression, wider scoped recovery, bind partitioning,
ancestor re-entry, and recursive composition. No package, bundle, declaration,
performance, or whole-engine reduction claim follows from G2.7 acceptance.
