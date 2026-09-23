# Why the v1 seam probe was superseded (the attempt is kept, not relabelled)

`seam-probe.mjs` v1 timed BOTH seams in ONE process, statement seam first.
The second timing therefore ran on an already-warm JIT and an already-shaped
heap. The confound is visible in its own receipt: on
`fixed-collection-rowref-1000` the candidate's package seam reads 28.5 µs/op
against its statement seam's 44.6 µs/op for work that is a superset of it.

Kept as `seam-samples-v1-ordering-confound.json` /
`seam-summary-v1-ordering-confound.json`. v2 times ONE seam per process and
uses the frozen protocol's own iteration counts for the cell, so its
statement-seam arm is a falsifier against the 20-cell series' own ratio.
