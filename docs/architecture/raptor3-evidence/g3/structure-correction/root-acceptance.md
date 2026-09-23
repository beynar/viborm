# G3 structural correction — root acceptance

## Outcome

**ACCEPT**, 2026-09-14. The requested correction and complete qualification are
finished on production
`fe544577cbc3c6747806f4b6a178ffe284d52d7ac3b5dd87fcd39adc2c3d54da`,
harness `3d9977876d5b8c0c80aec1ea6902f34b39ea80ab52e07e7242a287312dd2b922`,
and Node 24.21.0. The independent Sol 5.6/high reviewer
[accepts the same source and evidence](qualification-review.md).

The final diff removes three duplicated decisions: host-language scalar update
arithmetic, terminal cardinality inferred from physical query packaging, and
SQL construction discarded by the chosen physical route. `Queries.updateValue`
owns scalar update meaning; `OperationContext` owns explicit result cardinality
and the shared terminal decoder. Nested record execution no longer completes
the outer operation or releases its generated-key scratch. The same member
executor serves root and nested series, with completion at the root only.

The correction adds no interpreter, transaction authority, recovery permission,
downstream validation, public route, or G4 feature. G4 extends these owners;
it must not recreate the removed arithmetic or completion rules.

## Validation

The root inspected the final production diff, including the retained `return
await` inside the recovery boundary and root-only series completion. It checked
the independent unit reviews and final qualification review against the
author's source-bound report. The final qualification records:

- 42 fixed modes / 1,137 passing tests; overlapping aggregate 65 files / 758.
- PGlite 11, PostgreSQL 58, and MySQL 47 passing tests.
- Nine campaigns: 61,000 cells, 183,000 exact replays, zero skips.
- Seven current replay passes and two required historical-identity refusals.
- Driver integration 16, receipt self-tests 34, and CLI integrity 7 passes.
- Isolated structural measurement: 28 cases / 60 replays; source restored.
- Whole typecheck: only the two historical Pattern TS2345 errors, no new errors.

The root independently recomputed the source/harness identity, checked all
2,919 sealed SHA-256 entries, matched all nine source-allowlist hashes, and
verified that the source patch reverses cleanly. The independent reviewer also
checked the 868-file identity manifest and complete retention manifest. The
recovered G3P06 child receipts close the packaging omission without changing
source or relabeling any run. The interrupted ENOSPC attempt remains a failure;
the separate complete transport campaign supplies the passing evidence.

Core cost is 6,927 code-bearing LOC / 43,383 parser tokens / 230,397 bytes.
The broader charged perimeter is 11,849 LOC / 72,385 tokens / 499,927 bytes.
Each scope removes 28 LOC, 74 tokens, and 1,121 bytes against accepted unit04.
This is genuine source reduction, not comparison-engine retirement.

The root approves exactly the 4,849 paths in the sealed
`qualified-final/task-commit-allowlist.json`, plus `qualification-review.md`
and this file, for one local task-scoped Conventional Commit. Current acceptance
updates to the central plan, G3 ledger, resume and historical report are already
within that list. Unrelated `CONTEXT.md`, `memory.md`, Pattern changes, and
other archives remain outside it. No push is authorized. The sealed author
index intentionally retains its pre-review status; these attestations supply
the subsequent decision without rewriting that evidence.

## Risks

- The two existing Pattern type errors remain outside this correction.
- Source reduction does not prove runtime or bundle reduction. Symbolic key
  expressions can require more chunks at low bind limits.
- The new prepared generated-key witness uses the SQLite-derived batch-only
  driver; native PostgreSQL/MySQL claims remain those actually tested.
- G4 and public cutover remain unimplemented by this checkpoint.
