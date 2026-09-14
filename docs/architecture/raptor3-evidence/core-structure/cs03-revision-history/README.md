# CS-03 overwritten revision history

This directory preserves the exact bytes of three intermediate CS-03 revision
packages whose living paths were later reused for final cost and documentation
updates. These are historical checkpoints, not final qualification receipts.

- `a/` preserves the repaired extension-A checkpoint before the later error
  metadata addition and foundation cleanup.
- `b/` preserves the original feature-only extension-B checkpoint.
- `combined/` preserves the pre-metadata feature-only composition checkpoint.
- `cs04-report-pre-materialization-repair.md` preserves the pre-final-review
  report at SHA-256
  `12e52e211d677903efa59b7ee6b2aa10a38ccb1b1abf573bdfbc4f50f8229841`.
  Its selected-source identity and cost were superseded by the repeated
  enclosing-placement repair; its referenced receipts remain historical.

Each subtree retains the original relative package layout, so its unchanged
`SHA256SUMS` verifies the report, cost receipt, and sibling semantic patch.
The files were recovered byte-for-byte from preserved task source snapshots and
serialized file-change records. Recovery was accepted only when every recorded
SHA-256 digest matched. No test was rerun and no historical runtime receipt was
recreated or relabeled.

The living `cs03-*-candidate-revision` paths and top-level feature patches own
the later final accounting. They must not be used to replace these checkpoint
bytes again.
