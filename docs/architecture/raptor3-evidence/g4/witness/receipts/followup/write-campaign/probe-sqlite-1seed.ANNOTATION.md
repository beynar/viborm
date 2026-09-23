# What `probe-sqlite-1seed.log` actually covered

Added by the repair round (`note.md` §15.1). **The log is unaltered**; this file
exists because the log's own text does not say what the run covered, which the
independent review of 2026-09-15 correctly called out.

That run was
`VIBORM_RAPTOR3_GENERATED_SEED_COUNT=1 node scripts/run-raptor3.mjs g4-write-seed-batch 75000`
— a **one-seed** smoke probe of the path, taken before the full 100-seed child
in `sqlite-75000/`. It prints "Raptor 3 g4-write-seed-batch contract gate
verified" because, at the time, the child read that variable and the receipt
assertion admits a truthful short batch. Nothing in the log distinguishes it
from a full child, and no claim in `note.md` rests on it.

The hole it walked through is closed: `tests/raptor3/g4/generation/write-campaign.test.ts`
now passes `G4_WRITE_CAMPAIGN.batchSize`, and `scripts/run-raptor3.mjs` deletes
`VIBORM_RAPTOR3_GENERATED_SEED_COUNT` from every child environment. The same
command now yields a 100-seed / 200-cell / 600-replay receipt —
`../../repair/write-child-ambient-count/generated-campaign.json`.
