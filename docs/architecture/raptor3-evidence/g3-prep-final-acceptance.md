# Raptor 3 — G3 preparation final acceptance

Date: 2026-09-12. Status: **accepted; G3 is ready and not started**.

## Outcome

All six bounded G3-preparation units are accepted. G3P-01 and G3P-02 passed
their original independent reviews. G3P-03, G3P-04, and G3P-05 passed after
their recorded bounded repairs and independent re-reviews. Independent review
accepted the original G3P-06 qualification. Final root review then found one
credential-free registration defect; the first bounded repair separated the
intentional local Raptor stage from ordinary discovery and repeated the full
qualification on a new frozen harness identity.

The accepted final identity is production
`934ef37d910c99efcea7c435e2db9ce65df6080cf91868bc0704dab1f1401ecb`,
harness
`a33ee9da46496cb2239ee567effc54766b6ca7011f89dfee5d559f0eafb41d70`,
and whole-source cost receipt
`77da78b0e7797eb509d2a7010887cc95b1c9ff68d94cfd4137464830e5b44bcc`.
The same 28 complete production owners measure 9,360 parser-token lines. The
registration repair changes no production owner or production line.

G3 may now extend these accepted private composition owners. This acceptance
does not start G3 and does not publish a new client route. G4 still owns the
actual public cutover, the complete query/projection/codec/lifecycle envelope,
and native recursive-read qualification.

## Validation

Final root review independently passed the 12-case harness receipt self-test
and the 21-case G3P-05 contract gate. It verified all 391 entries in the
[registration-repair checksum manifest](g3-prep-06-review-repair/g3-prep-06-repair-SHA256SUMS)
and confirmed 139 source-bound receipt identities against the accepted
production, harness, and Node 24.21.0 runtime. Receipt aggregation confirms
1,015 fixed tests, 50 PostgreSQL tests, and 39 MySQL tests, with no failures or
pending tests.

Both full campaigns contain 10,000 cells, 30,000 exact replays, and zero skips.
Both preparation schedules contain 200 cells, 600 exact replays, and zero
skips. The repaired ordinary credential-free stage passes 585/585 and selects
no native Raptor test.

The credential-free PGlite qualification passes these four exact paths:

- `tests/raptor3/expanded/produced-legacy.test.ts`
- `tests/raptor3/expanded/batch-produced-legacy.test.ts`
- `tests/raptor3/expanded/produced-commands.test.ts`
- `tests/raptor3/expanded/batch-produced-commands.test.ts`

The immutable original G3P-06 package remains independently accepted. The
separate [registration-repair report](g3-prep-06-review-repair/g3-prep-06-repair-report.md)
and [reproduction recipe](g3-prep-06-review-repair/g3-prep-06-repair-reproduction.md)
bind the later root-review correction without rewriting that history.

## Risks

- Whole-estate typecheck still reports only the two historical Pattern TS2345
  diagnostics at `src/query-engine/pattern/pack.ts:1443` and `:2633`.
- The private recursive-read fit is qualified on SQLite only. Its public and
  native provider envelope remains G4 work.
- No commit, public cutover, G3 implementation, or release is part of this
  acceptance.
