# `repair2/typecheck.log` is SUPERSEDED — it was captured before the last r4 edit

Marker added at **r5 (Repair 3)**. The log file beside it is left byte-for-byte
untouched; it is not deleted and it is not relabeled as something it was not.

`repair2/typecheck.log` ran at **01:31:11**, before two harness files it was
meant to cover were written:

| File | mtime |
| --- | --- |
| `repair2/typecheck.log` | 01:31:11 |
| `tests/raptor3/g4/unit01/world.ts` (r4) | 01:32:40 |
| `tests/raptor3/g4/unit01/repair2.test.ts` (r4) | 01:33:37 |

So its "nothing else" reading was not true of the r4 delivered identity: the
independent review's follow-up-2 finding **F** found
`tests/raptor3/g4/unit01/world.ts(188,7) error TS2345` in the delivered tree.

The authoritative typecheck for the delivered unit is now:

- `../repair3/typecheck.log` — the whole estate as delivered (run **after** the
  last edit of this revision), and
- `../repair3/typecheck-without-review-probes.log` — the same run with the
  independent reviewer's own probe directories parked outside the tree.

See `../note.md` §"Revision 5 — Repair 3", finding F.
