# Raptor 3 G3P-02 — paused evidence report

Date: 2026-09-09. Status: **partially implemented; blocked on an explicit
public selector-precedence decision. G3P-02 is not accepted, G3P-03 is closed,
and neither G3 preparation nor G3 has passed.**

## Implemented slice

- The transport and diagnostic corpus writers now share
  [`selectRaptor3EvidenceDirectory`](../../../../tests/raptor3/harness/evidence-directory.ts#L4).
  An unset or empty `VIBORM_RAPTOR3_EVIDENCE_DIRECTORY` selects a private
  temporary directory; a non-empty value is used exactly.
- [`transport.test.ts`](../../../../tests/raptor3/transport.test.ts#L291)
  exercises the real `saveCorpus` caller with unset, empty, and explicit
  values, plus a repository-root corpus hash census. The eight pre-existing
  root corpora were byte-identical before and after the targeted and regression
  runs.
- The native witness
  [`native-constraint-ownership.test.ts`](../../../../tests/raptor3/prep/native-constraint-ownership.test.ts#L954)
  contains six independently reportable cases. The full provider modes expect
  all six. The unmistakably named `*-undisputed-partial` modes register only
  the four settled cases; this is registration selection, not Vitest filtering,
  and produces zero pending tests.
- No file under `src/` changed. Constraint matching, validation precedence, the
  public error shape, and provider normalization are unchanged.

## Evidence-directory red to green

The first scaffold used an invalid empty replay corpus and failed 0/4 at the
existing replay decoder. That is a fixture failure, not the target red. With
one existing minimal valid transport record, the unchanged `??` choice failed
only the empty-value case: 3/4 passed, and the task-owned isolated working
directory received the corpus. Replacing that choice with the single truthy
fallback made the focused gate pass 4/4.

| Phase | Result | Preserved receipt | Source binding |
|---|---|---|---|
| Invalid first fixture | 0/4; replay record list was empty | [`evidence-directory-invalid-fixture.vitest.json`](receipts/evidence-directory-invalid-fixture.vitest.json) | Diagnostic only. The failed runner writes no `verified.json`; no historical harness identity is invented. |
| Target red | 3/4; empty value selected the isolated cwd | [`evidence-directory-red.vitest.json`](receipts/evidence-directory-red.vitest.json) | Production remained the accepted parent `9a4964d55ba06358f5bcbadd76142a93a18379cac1db5f1fa5d7ba99b8733374`; the failed runner did not persist its intermediate harness identity. |
| Focused green | 4/4, zero pending | [`vitest`](receipts/evidence-directory-green.vitest.json), [`verified`](receipts/evidence-directory-green.verified.json) | Production `9a4964d5…`, harness `606dd9382e5429e9bc9497705ca55f74d66d7cc8794f5de9b37c89b5ad2d52ad`, Node 24.21. |
| Transport regression | 44/44, zero pending | [`vitest`](receipts/g1-transport-regression.vitest.json), [`verified`](receipts/g1-transport-regression.verified.json) | Same verified production/harness/runtime as the focused green. |
| Diagnostic regression | 2/2 disputed behaviors reproduced; remains non-qualifying | [`vitest`](receipts/g2-diagnostics-disputed.vitest.json), [`verified`](receipts/g2-diagnostics-disputed.verified.json) | Same verified production/harness/runtime as the focused green. |

## Native evidence

Fresh task-owned containers used the established native closure shape: random
loopback-only ports, database `raptor3_g2`, one CPU, 512/768 MiB container
memory, 256/512 MiB tmpfs data, no host mounts, and no existing user database or
container. PostgreSQL reported 16.14; MySQL reported 8.4.11. The successful
partial containers reported zero OOM kills and restarts, were stopped and
auto-removed, and the final `viborm.test=raptor3-g3p02` container census was
empty.

Both partial gates bind the same source: production
`26f841e410f163682bbfde7e728416f8551f1b809857427ca9f9ef1d0a766fed`,
harness `81e6a09d5c96ecfe05559aada158c8379a05d1d1ad6c7ffae24677e1ee09a774`,
Node 24.21, Vitest 3.1.4. They executed exactly these four cases with zero
pending tests:

1. `g3p02-mapped-scalar-root-recovery`
2. `g3p02-mapped-compound-nested-recovery`
3. `g3p02-unrelated-constraint-refusal`
4. `g3p02-wrong-table-producer-refusal`

| Provider | Result | Resources | Preserved receipt |
|---|---:|---:|---|
| PostgreSQL 16.14 | 4/4 | 3.98 s / 507.4 MiB | [`vitest`](receipts/native-pg-undisputed-partial.vitest.json), [`verified`](receipts/native-pg-undisputed-partial.verified.json) |
| MySQL 8.4.11 | 4/4 | 3.62 s / 539.7 MiB | [`vitest`](receipts/native-mysql-undisputed-partial.vitest.json), [`verified`](receipts/native-mysql-undisputed-partial.verified.json) |

The setup failures are retained without turning them into engine evidence:

- [`native-registration-failure.vitest.json`](receipts/native-registration-failure.vitest.json):
  the live-provider Vitest project initially omitted the new suite.
- [`native-port-setup-failure.vitest.json`](receipts/native-port-setup-failure.vitest.json):
  the provider port was not provisioned; collection ran zero tests.
- [`native-mysql-fixture-failure.vitest.json`](receipts/native-mysql-fixture-failure.vitest.json):
  the first witness looked only in PostgreSQL's `uniqueConstraints` snapshot
  bucket. MySQL's finalized authoritative unique object is a unique index.
- [`native-pg-collision-red.vitest.json`](receipts/native-pg-collision-red.vitest.json):
  PostgreSQL completed the mapped scalar and mapped compound positive controls,
  then the selected-scalar collision reached its post-world check with zero
  failed batches. The later three tests did not execute. The failed runner did
  not write `verified.json`; this receipt is bound to its named source behavior
  and output, not to an invented historical harness hash.

## Why the production identity changed while production code did not

`captureRaptor3Identity` deliberately hashes all `src` files **and execution
configuration**, including `vitest.workspace.ts`. G3P-02 added only the
`G3P02_PG_CONTRACT_TESTS` import and live-provider include to
[`vitest.workspace.ts`](../../../../vitest.workspace.ts#L20). Recomputing the
fingerprint with those two configuration lines removed returns the accepted
parent production identity exactly:
`9a4964d55ba06358f5bcbadd76142a93a18379cac1db5f1fa5d7ba99b8733374`.
With the required registration present, the identity is `26f841e4…`. Thus the
hash change is a truthful execution-configuration change, not an unreported
constraint implementation.

The fresh [cost receipt](g3-prep-02-cost.json) recounts the command candidate at
4,592 charged token-lines, 5,011 physical lines, and 165,458 bytes across 17
files: exactly the accepted G2.7 count. Combined new production also remains
4,769 token-lines / 4,837 physical lines / 158,818 bytes across 14 files. No
measured LOC gain or completion percentage is claimed.

## Blocking public decision

The same-name collision has two contradictory current owners:

- [`where.ts` lines 156–159](../../../../src/validation/model/core/where.ts#L156)
  spreads compound identities after scalar identities. A compound unique named
  `lookup` therefore overwrites the scalar `lookup` admission schema, and
  `{ lookup: "wanted" }` fails before any provider INSERT.
- [`keys.ts` lines 84–102](../../../../src/schema/model/keys.ts#L84) explicitly
  says and implements bare-scalar precedence for the public selector grammar.
  Query construction and candidate recovery consume that catalog answer.

No current implementation can honestly call both authoritative. Arnaud must
choose a public policy before production changes continue:

1. **Bare scalar wins.** Align runtime validation and its inferred type with the
   model-key catalog. This newly admits the scalar spelling currently refused
   by the overwrite; the same-named compound remains a physical constraint but
   is not publicly addressable by that selector name. The two collision native
   witnesses then mean “recover the selected scalar constraint; propagate the
   unrelated compound constraint.”
2. **Ambiguous declarations are refused.** Add a definition-time schema error
   when a scalar unique and grouped key share a selector name. This removes an
   unaddressable/ambiguous public grammar, but newly rejects model definitions
   that currently construct. The collision provider witnesses become refusal
   witnesses rather than recovery witnesses.

Retaining accidental compound overwrite would require changing the canonical
catalog and all consumers to compound precedence while leaving the colliding
scalar physical unique unaddressable. That is a wider third compatibility
policy, not an implicit default; no evidence here approves it.

Until the decision is explicit, there is no authorized adapter naming or driver
normalization change. The full six-case PostgreSQL/MySQL modes are deliberately
unqualified, G3P-02 remains paused, and G3P-03 remains closed.

## Changed files in G3P-02

- Execution configuration and manifests: `vitest.workspace.ts`,
  `scripts/raptor3-manifest.mjs`, `scripts/run-raptor3.mjs`, and
  `scripts/credential-free-test-manifest.mjs`.
- Caller regression: `tests/raptor3/harness/evidence-directory.ts`,
  `tests/raptor3/transport.test.ts`, and
  `tests/raptor3/transitions/diagnostics.test.ts`.
- Independent native witness:
  `tests/raptor3/prep/native-constraint-ownership.test.ts`.
- Live planning/evidence: `docs/architecture/raptor3-implementation-plan.md`,
  `docs/architecture/raptor3-evidence/g3-prep.md`, and this evidence directory.
- Production implementation: none under `src/`.

