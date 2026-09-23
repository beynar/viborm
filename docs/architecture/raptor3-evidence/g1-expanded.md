# G1 — expanded non-variant checkpoint

**Historical checkpoint. [Full G1 closed on 2026-09-08](g1-closure.md).** The
scope, counts and remaining-work list below describe this earlier snapshot.

This is a frozen passing checkpoint, not the full G1 exit. The selected command
engine now covers ordinary reference and junction associations, complete
assignments, selected/missing alternatives, correlated reads, generated output,
and the tested admission and operation lifetimes. Public routing is unchanged.

The [archive index](g1-expanded-index.json) records the exact source identities,
cost, receipt locations and archive checksum. The archive contains the private
candidate, harness, configuration and receipts against the named dirty checkout;
it is not a standalone repository. Later edits do not extend these receipts.

## Evidence

| Check | Result |
|---|---|
| Expanded real-SQLite differential contracts | 93 tests passed across interactive and restricted atomic-batch profiles |
| Original S1–S4 comparison | 66 tests and 144 candidate replays passed |
| G0 harness regression | 24 fixed cells, 200 seeded cells, 672 replays and 21 falsifiers passed |
| Generated smoke and shrink gate | 35 tests passed; original and minimized wrong-parent specimens retain the same named failure |
| Lane B campaign | 1,000 seeds per SQLite profile; 2,000 cells; 6,000 exact candidate replays; no skips |
| Campaign composition | Each profile has 250 two-actor cases and 250 cases with an actual injected fault |
| Actual PostgreSQL through PGlite | Three interactive produced-key and two forced-batch continuation cases passed |
| Whole-estate native typecheck | No candidate or new-test errors; two existing Pattern errors remain in `pattern/pack.ts` |

The saved minimal specimen also fails through the external replay command with
the expected `generated:membership` property. It does not merely fail an identity
or codec check. Two earlier generator failures remain archived as historical
diagnostics with their own identities, not as replayable passing evidence.

Those corrections preserved the contracts: conditional create members use
independently known keys where existing public admission requires them; a
first-dispatch fault is not treated as the same semantic cut when the two
engines dispatch different first actions. Error attribution was not weakened.

## Whole-slice cost

The [measurement](g1-expanded-cost.json) counts **2,395 production code-bearing
lines**: 838 command-language lines, 1,108 shared lines, and 449 lines of named
unchanged integration. All shared files are charged in full. The measured
evidence footprint is 16,757 code-bearing lines, including shared G0 and
benchmark tools; it is reported separately, not hidden in production cost.

The original equal-scope comparison remains in [g1.md](g1.md). The retained
program specimen does not implement this expanded scope, so its current size is
not an equal-functionality comparison. This slice is not a whole-engine size,
gzip or performance result. The whole-engine forecast remains 20,200–31,000
code-bearing lines until broader feature evidence changes it.

## Boundaries and next unit

Both generated profiles above are **Lane B**. Queued SQLite operations use the
provider's serial transaction lease; they are not arbitrary concurrent database
interleavings. Forced-batch PGlite proves the named generated-output continuation
contract, not hosted provider support or CTE-capable PostgreSQL batching.

The remaining G1 work includes basic variant references and junctions, extended
unique-selector identity, decoded captured-key handoff, and the distinct Lane A
explicit-response transport simulator. Publication/progress/liveness guarantees
need their own legal witnesses and falsifiers. Retry and discarded-attempt
guarantees cannot be inferred from rollback reuse or from a runner that has no
retry mechanism.

Full G1 stays in progress. G2 may begin only after the central plan's remaining
G1 inventory, same-source campaigns and adversarial review are complete.
