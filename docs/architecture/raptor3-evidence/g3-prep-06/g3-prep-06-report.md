# Raptor 3 — G3P-06 preparation qualification

Date: 2026-09-12. Status: **qualified; independent review pending. G3 and
commit remain closed.**

## Outcome

G3P-06 freezes and qualifies the preparation assembled by the five accepted
units. It changes no production owner or public API. The only implementation
work is an eight-file test-harness extension that reserves seeds 7000–7099 for
an additional fixed transition and transport schedule. The existing G2
campaigns remain 2000–6999 and unchanged.

The final runner identity is production
`934ef37d910c99efcea7c435e2db9ce65df6080cf91868bc0704dab1f1401ecb`
and harness
`43807d2e06380d3ead820491614ba252adbdc2d91ea3fe3f002c45fbc2c12de8`.
The complete cost receipt binds its measured source set to
`dde4f9f217486619852f0d6e67dc6c708e480caa98af057ec2f44affd5798985`.
The [index](g3-prep-06-index.json) records every exact harness hash, receipt
group, provider image, campaign count, cost comparison, and archive omission.

G3 extends this accepted preparation if independent review accepts G3P-06. It
does not rebuild the engine, relabel an earlier receipt, route the public client
to Raptor 3, or treat the private SQLite recursive fit as native or public
recursive-query qualification.

## Validation

The complete fixed qualification passes 1,015/1,015 tests with zero failures
and zero pending tests:

| Gate | Result |
|---|---:|
| G0 | 33/33 |
| G1 baseline / contracts / comparison | 141/141 + 143/143 + 66/66 |
| G1 generated / transport | 35/35 + 44/44 |
| G2 baseline / contracts | 216/216 + 216/216 |
| G2 generated / transport | 52/52 + 16/16 |
| G2.5 / G2.7 | 6/6 + 6/6 |
| G3P-02 / G3P-03 | 4/4 + 6/6 |
| G3P-04 original / review | 5/5 + 5/5 |
| G3P-05 | 21/21 |

The two known G2 diagnostic cases reproduce separately at 2/2 and are not
counted as qualification. Campaign receipt self-tests pass 11/11; CLI
self-tests pass 7/7 under the unchanged process ceilings.

Credential-free PGlite qualification passes 10/10 across produced-relations
legacy/commands and batch-relations legacy/commands. It alone uses the
allowlisted 2,560 MiB RSS ceiling; its peak was 1,558.0 MiB. Each process
verified teardown.

Native PostgreSQL passes 50/50 top-level tests and native MySQL passes 39/39.
The G3P-04 provider file has four top-level tests but executes eight PostgreSQL
worlds and seven MySQL worlds. PostgreSQL used cached image
`sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b`
(server 16.14); MySQL used
`sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb`
(server 8.4.11). Both task-owned containers used random loopback ports, tmpfs,
two CPUs, 1 GiB memory, no host mount, and the dedicated label. Neither was
OOM-killed or restarted. Both exact IDs were removed, and the final label
census was empty.

The two full retained campaigns each execute 5,000 seeds in two profiles:
10,000 cells, 30,000 exact replays, and zero skips per lane. The two new
7000–7099 campaigns each execute 100 seeds in two profiles: 200 cells, 600
exact replays, and zero skips per lane. The archive keeps every parent receipt,
every child verified/Vitest receipt, and each compact generated-campaign
summary. It deliberately omits the redundant per-batch multi-megabyte corpora
and progress snapshots. The [reproduction recipe](g3-prep-06-reproduction.md)
defines how to regenerate them. Fresh source-bound G2.5 polish and G2
conditional-upsert corpora are retained and each replays successfully.

The structure audit passes. Whole-estate typecheck has no new diagnostic; its
only errors are the unchanged historical Pattern TS2345 diagnostics at
`pack.ts:1443` and `pack.ts:2633`.

The [whole-owner receipt](g3-prep-06-cost.json) and [matched
comparison](g3-prep-06-matched-cost.json) charge 9,360 parser-token lines across
the same 28 complete owners as accepted G3P-05. G3P-06 changes production by
zero lines and zero owners. The total remains +615 lines from accepted G3P-04's
8,745-line baseline. The historical 4,592-line figure uses a narrower scope and
is not comparable. No bundle, whole-engine reduction, or performance claim is
made.

The checksum manifest covers the index, report, cost evidence, reproduction
recipe, fixed/provider/replay receipts, campaign summaries and child receipts,
and the two saved corpora.

## Risks

- Independent review has not accepted G3P-06, so the six-unit preparation and
  G3 remain closed. No files are staged or committed.
- G3P-05 recursive-read evidence remains private SQLite-only. Native recursive
  lowering and any public feature envelope remain G4 work.
- Whole-estate typecheck remains non-green only because of the two disclosed
  historical Pattern diagnostics.
- Campaign child corpora are reproducible but intentionally absent from this
  compact archive; only the two named saved-replay corpora are retained.
