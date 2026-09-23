# Compact found consumption — final checkpoint ledger

**Status (2026-09-22): accepted bounded checkpoint, not whole-release qualification.**
Measurements are frozen at `bd264d329221f1c6257aac264fedd59c413707e6`, against
`8346e15daa8688fc5d834ccfe0321491580ef993`, on Node 24.21.0.

## Scope and contract

- This checkpoint covers bounded source consolidation and exact found-consuming
  `UPDATE ... RETURNING` behavior.
- It does not qualify the whole release or establish an adoption verdict.
- No public API, retry or transaction authority, or refusal contract changed.
- Hosted drivers remain out of scope.
- Semantic-mode legacy `keepGate` remains `false` by design; the other semantic
  flags remain present.
- No waiver was requested or granted.

## Ownership result

- Query/schema facts now use their existing factory owner.
- Junction writes now use the shared junction-predicate owner.
- Count-bearing statements now use ordered count slots.
- `INSERT` lowering now uses its shared `insertStatement` owner, and
  set-mutation publication uses its existing owner.
- Command traversal now uses the existing recursive command owner.
- The exact child-held found path consumes `UPDATE ... RETURNING` directly and
  falls from five statements to four.
- Richer membership, condition, alternate-unique, batch, and non-`RETURNING`
  paths retain confirmation where their evidence requirements remain.

## Source census

| Census | Before | Measured | Delta |
| --- | ---: | ---: | ---: |
| Engine code-bearing LOC | 16,259 | 16,234 | -25 |
| Engine physical lines | 21,105 | 21,095 | -10 |
| Engine bytes | 799,139 | 799,114 | -25 |
| Engine production files | 38 | 38 | 0 |
| Broader charged LOC | 24,052 | 24,027 | -25 |
| Broader physical lines | 31,870 | 31,860 | -10 |
| Broader bytes | 1,178,252 | 1,178,227 | -25 |
| Broader files | 63 | 63 | 0 |

- Gross consolidation removed 89 code-bearing LOC.
- The exact performance proof added 64 code-bearing LOC.
- The net source result is therefore -25 code-bearing LOC.
- The earlier 150–220 LOC estimate was not achieved.
- No bundle-size reduction is claimed.

## Final validation

| Gate | Final result |
| --- | --- |
| Type check | exit 0; 7.06 s; 5,129.1 MiB peak RSS under 8,192 MiB |
| Fixed suite | 956 passed across 89 files |
| Core suite | 8,439 passed across 403 files |
| SQLite provider | 797 passed, 1 skipped across 9 files |
| PostgreSQL native | 490 passed, 7 skipped across 7 files |
| MySQL native | 793 passed, 1 skipped across 15 files |
| G1 PGlite pins | 11 passed across 5 files |
| Provider execution integrity | 27 files; all exit 0; teardown verified |

These suites overlap; their test counts are not summed as distinct coverage.
The retained historical red expected at most four statements but observed five,
while state and output were correct. The final focused found-consumption suite
is 15/15 green, and the final query-focused group is 49/49 green.

The earlier 649-case query-layer and 50-case write-layer runs predate the last
wiring change. They are supplementary evidence, not fresh final gates.

## Performance evidence

The two primary reports used the exact Node 24.21.0 executable in both arms,
five alternating replicates, separate CPU and allocation measurements, and
fresh processes.

| Comparison | CPU | Wall | Allocation | Statements |
| --- | ---: | ---: | ---: | ---: |
| Immediate parent, found path | -14.7682% | -21.3055% | -12.5032% | 5 → 4 |
| Old engine, found path | -20.0669% | -9.5008% | -33.0251% | 4 → 4 |

The old-engine comparison uses
`5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062`. The immediate-parent found path
clearly improves in wall time, CPU, allocation, and statement count. The
old-engine found improvement is also significant against twice its run MAD.

Controls qualify that conclusion:

- Missing-path allocation increased 0.719% (982.696 B); that increase exceeds the
  363.165 B 2×MAD threshold. Missing CPU and wall improved 3.364% and 3.833% within twice their MAD.
- Bulk allocation improved 0.761%; bulk CPU increased 4.803% and wall increased
  1.073%, both within twice their MAD. Cascade remained near flat.
- In the old-engine pair, the candidate allocates 21.199% more than the old engine
  (about 147,219 B versus 121,468 B). The direct parent pair is about 148,018 B for the
  parent versus 146,892 B for the candidate, so the large old-engine gap predates this patch and is not attributed to it.

The original three Node 24.14.0 reports remain unchanged as supplemental
evidence. They are not relabeled or used for the primary runtime-pinned claim.

The supported conclusion is a clear improvement versus the immediate parent,
not a formal whole-milestone or adoption pass.

## Reviews and evidence custody

- Independent Sol/high query review: **ACCEPT**.
- Independent Sol/high execution review: **ACCEPT**.
- Root global review: **ACCEPT**.
- The evidence package is indexed by [`artifact-index.json`](compact-found-consumption/artifact-index.json).
- Native execution and frozen source identities are indexed by
  [`source-count-index.json`](compact-found-consumption/native/source-count-index.json).
- The package contains 41 payloads plus the index and occupies 19,242,873
  archived payload bytes.
- Five performance reports and four source reports are lossless gzip payloads.
- Thirty-one raw logs and the native index are byte-identical copies.
- Raw and gzip SHA-256 values are recorded in the artifact index.
- Original absolute origins are retained; archive paths are repository-relative.
- All 37 prior payloads are preserved; the four pinned additions were hash- and
  round-trip-checked against their explicitly named origins.
- Historical `closure-repair-2` count/table corrections and the clarified MySQL
  comment are included; their old raw receipts remain unchanged.

The final task commit adds only documentation and evidence over the measured snapshot,
preserving the four recorded `src`, `tests`, `scripts`, and `benchmarks` tree identities.
Root verifies those identities after the amend; no documentation commit hash is predeclared.

## Residual risks

- The source-size benefit is modest: net -25 code-bearing LOC.
- Missing-path allocation shows a small measured increase.
- The bounded checkpoint is not a whole-release, adoption, or bundle verdict.
