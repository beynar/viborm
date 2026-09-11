# Raptor 3 — G3P-06 registration review repair

Date: 2026-09-12. Status: **qualified; final root review pending**.

## Outcome

The independently accepted original G3P-06 package remains immutable. Root
global review found one first-round registration defect, not an engine defect:
native G2.7 and G3P-04 tests entered ordinary credential-free discovery, while
local G2.7/G3P-04/G3P-05 tests depended on the same accidental discovery.

The credential-free manifest now excludes every explicit Raptor fixed and
native suite from ordinary discovery and publishes one intentional fixed-local
list composed from the existing Raptor manifest constants. The credential-free
runner consumes that list. G3P-02 remains represented once by its existing
44-case transport owner. The campaign receipt self-test now proves that the
supported local G2.7/G3P-03/G3P-04/G3P-05 suites remain in the fixed stage and
that their native counterparts appear in neither local list. No test-discovery
framework, production code, public API, or provider route changed.

Before the repair, the direct selection probe returned `true` for all eight
checked local/native paths. After the repair, `nativeInExtended`,
`localInExtended`, and `missingFixed` are all empty. The actual ordinary
credential-free Raptor stage executes 38 files and 585 tests at 829.5 MiB under
the unchanged 1,536 MiB ceiling, with no native Raptor file selected.

## Validation

The repaired frozen identity is production
`934ef37d910c99efcea7c435e2db9ce65df6080cf91868bc0704dab1f1401ecb`
and harness
`a33ee9da46496cb2239ee567effc54766b6ca7011f89dfee5d559f0eafb41d70`.
The [index](g3-prep-06-repair-index.json) binds the three changed harness files,
all final receipts, and the whole-source cost receipt identity
`77da78b0e7797eb509d2a7010887cc95b1c9ff68d94cfd4137464830e5b44bcc`.

Fresh qualification passes 1,015/1,015 fixed tests with zero pending, plus the
two nonqualifying diagnostic reproductions. The actual credential-free fixed
stage passes 585/585; registration/harness self-tests pass 12/12; CLI self-tests
pass 7/7. The four exact PGlite paths in the [reproduction
recipe](g3-prep-06-repair-reproduction.md) pass 10/10 under their isolated
2,560 MiB ceiling.

Native PostgreSQL passes 50/50 top-level tests and MySQL passes 39/39. The
G3P-04 file executes eight PostgreSQL worlds and seven MySQL worlds. Both exact
task containers reported no OOM and no restart, were removed by ID, and left
an empty label census.

The refreshed transition and transport G2 campaigns each execute 10,000 cells,
30,000 exact replays, and zero skips. The two 7000–7099 lanes each execute 200
cells, 600 replays, and zero skips. Both fresh saved corpora replay successfully.
The structure audit passes. Typecheck has no new diagnostics; only the two
historical Pattern TS2345 diagnostics remain.

The complete 28-owner production cost remains 9,360 parser-token lines: no
production owner and no production line changed. The historical 4,592-line
scope is not comparable. No bundle, whole-engine reduction, or performance
claim is made.

## Risks

- Final root review has not accepted this registration repair. G3 and commit
  remain closed.
- The private recursive-read fit remains SQLite-only. G4 owns its public
  envelope, actual client cutover, and native recursive qualification.
- Whole-estate typecheck remains non-green only because of the two disclosed
  historical Pattern diagnostics.
