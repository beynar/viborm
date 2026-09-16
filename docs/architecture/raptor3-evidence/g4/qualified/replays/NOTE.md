# Replay lane note (integrator, 03:15 2026-09-16)

The two entries `g4-seeds-20000.not-a-replay-input.*` and
`g4-transport-seeds-50000.not-a-replay-input.*` are NOT failures of the
candidate: a G4 READ campaign child corpus carries a `subject` field
(`candidate` / `shipped`, the independent-oracle campaign's subject) and the
generic `replay` mode's corpus schema rejects unknown keys ("Unrecognized key:
subject"). By the runner's own design (`scripts/run-raptor3.mjs`, the G4 read
child reproduction comment) a G4 read child is reproduced by re-running the
child command on the frozen identity — `g4-seed-batch 20000 --subject=candidate`
and `g4-transport-seed-batch 50000 --subject=candidate` — not through `replay`.
Those two reproductions are recorded under `receipts/g4-seed-batch-20000.receipt`
and `receipts/g4-transport-seed-batch-50000.receipt` (run after the
performance series, so the timing series stayed on a quiet machine). The
write families and the G3/CS-03 corpora replay through `replay` as before
(seven green); the nine G3-era inputs are the expected stale refusals.
