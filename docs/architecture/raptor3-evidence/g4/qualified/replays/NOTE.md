# Replay lane note (packaging, qualification attempt 6)

The two entries `g4-seeds-20000.not-a-replay-input.*` and
`g4-transport-seeds-50000.not-a-replay-input.*` are NOT failures of the
candidate: a G4 READ campaign child corpus carries a `subject` field
(`candidate` / `shipped`, the independent-oracle campaign's subject) and the
generic `replay` mode's corpus schema rejects unknown keys ("Unrecognized key:
subject"). By the runner's own design (`scripts/run-raptor3.mjs`, the G4 read
child reproduction comment) a G4 read child is reproduced by re-running the
child command on the frozen identity — `g4-seed-batch 20000 --subject=candidate`
and `g4-transport-seed-batch 50000 --subject=candidate` — not through `replay`.
That is also what those children's own archive descriptors name as their
`replayCommand`.

The sequencer ran them under their plain names and recorded both as failures in
`FAILURES.log`, which is the driver's own record and is kept exactly as it was
written. The packaging step renamed the two receipts and logs to
`.not-a-replay-input` — the previous two packages' spelling — and
`support/build-qualification-index.mjs` classifies them from the gate's own
`unrecognized_keys` / `subject` sentence rather than from the file name, so a
receipt that does not carry that sentence would stay a red.

The two correct reproductions run in the main tree after the cutover timing
series, so the series stays on a quiet machine, and land here as
`receipts/g4-seed-batch-20000.receipt` and
`receipts/g4-transport-seed-batch-50000.receipt`. If they are absent, the index
records each as a `pending-read-child-reproduction` gap and the report says so;
they are never assumed.

The write families and the G3/CS-03 corpora replay through `replay` as before
(seven green); the nine G3-era inputs are the expected stale refusals
(`*-stale.log`, exit 1, "Stale Raptor 3 evidence: executed source or runtime
changed").

`inputs/` holds the restored corpora the seven green replays consumed, kept
compressed with a descriptor beside each one (`package-corpora.mjs` proves each
restores to its exact bytes before the raw copy is unlinked). Each is a copy of
a corpus this package already retains compressed under
`campaigns/<family>/seed-<first>.receipt/`; the two G4 read inputs are kept for
the same reason even though the gate refused them, because they are what the
sequencer actually fed it.
