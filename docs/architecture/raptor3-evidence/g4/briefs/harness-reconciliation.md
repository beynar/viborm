# Harness reconciliation brief — cuts and transport plans after the G4-02 physical changes

Read `common.md`, plan §5.2–5.4 (cuts, eliminated cuts, transport lane), the
G4-02 notes (`g4/unit02/note.md` phase 1 and phase 2, especially the
statement-atomic fold, the envelope rule, root create fold and their §5.4
records), and `g4/witness/note.md` §15 (write-transport red at cell 54). You
are the harness author. You own: `tests/raptor3/core-structure/**`,
`tests/raptor3/g3/generation/transport-plans.ts` and the other
`tests/raptor3/g3/generation/*` harness files, `tests/raptor3/transport/**`,
`tests/raptor3/harness/**`, `tests/raptor3/scenarios/**`, and the manifest /
runner / self-test scripts if a registration changes. **No production file.**
Every expectation you change must be justified by the engine's recorded
physical strategy, never by "make it pass".

## Outcome

1. **CS-03 extension-campaign self-test** (`tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts`,
   42/42 on clean `0cc61e61`, 10 red on the current tree with
   `Missing semantic cut choice:found|missing/root-member/0`, receipt
   `g4/environment/cs03-selftest-main-0705.log`). For each red cell: trace
   the candidate's actual statements for that recipe (the recorder tape),
   determine whether the observation cut was **eliminated by an evidenced
   atomic strategy** (e.g. the root member's found/missing decision now
   happens inside one statement or one atomic submission) or **merely moved**
   (a different statement boundary that still exposes the same interleaving).
   For an eliminated cut: record it per §5.4 in the harness (the cut is
   reported as absent-because-atomic with the strategy named, and the same
   semantic property is checked at the legal surrounding cuts — before the
   atomic statement and after it); the self-test and the `cs03-*-seeds`
   campaign receipts must reflect that honestly (an eliminated cut is not
   counted as an injected interleaving). For a moved cut: re-register the
   cut at its new boundary. If neither applies, the engine regressed: stop
   and report the minimized reproducer for the G4-02 author instead of
   editing expectations.
2. **Transport plans** (`tests/raptor3/g3/generation/transport-plans.ts` and
   `transport-scenario.ts`): `g3-generated-transport-smoke` and
   `g4-write-transport-seed-batch 100000` fail at cell 54 with an unscripted
   statement (`actual=INSERT`, expected the previous shape). The scripted
   returning-weak / returning-ack profiles must script the candidate's
   **current** physical shape (folded root writes, no envelope for
   single-statement operations, prepared reads) while preserving every fault
   family and response fixture of §5.4 (returning-weak loss, acknowledged
   returning, late completion, multi-fault healthy suffix). Do not thin the
   fault coverage; a fault that no longer has a statement to attach to must
   be re-attached to the statement that now carries the same semantic
   boundary, or recorded as eliminated with the same §5.4 evidence.
3. **Re-run** in this order, serially: the CS-03 self-test (42 cells), the
   three `cs03-*-seeds` modes, `g3-generated-transport-smoke`,
   `g3-generated-smoke`, `g3-generated-minimization`, one child of
   `g3-transport-seed-batch 8000`, `g4-write-transport-seed-batch 100000`,
   `g4-transport-seed-batch 50000`, the receipts self-test, the CLI
   self-test (quiet window), and the whole-estate typecheck. Save receipts
   under `g4/witness/receipts/reconciliation/`.
4. Write `g4/witness/note.md` "Reconciliation" section: per cut a row
   (recipe, cut, classification, strategy, surrounding-cut checks, receipt),
   per transport plan change a row (statement, old/new shape, faults kept),
   and the exact registered counts if any changed.

## Exit and return value

Structured summary: note path, cut classification table, transport plan
changes, suites run with counts and receipts, typecheck, blockers (any
engine regression with its reproducer), unverified claims.
