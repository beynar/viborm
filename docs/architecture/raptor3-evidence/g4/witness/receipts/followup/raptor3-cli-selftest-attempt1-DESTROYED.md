# Attempt 1 of the CLI self-test — raw log destroyed by this stream

**The raw receipt for attempt 1 no longer exists.** A retry wrapper this stream
wrote reused the filename `raptor3-cli-selftest-attempt1.log` when it was
restarted, and truncated the original 30,718-byte log to a one-line lock
refusal before it was noticed. That is this stream's mistake, not a failed run
being relabelled, and it is recorded here rather than quietly replaced.

What the destroyed log said, transcribed from this session's own reading of it
before it was overwritten. **This is a reconstruction, not a receipt**, and no
claim in the note rests on it:

- Command: `node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs`
- Result: `tests 10, pass 6, fail 4`; `219.20s wall, 203.6 MiB peak sampled
  process-group RSS`, teardown verified.
- Both cells added by this follow-up **passed**: "the command refuses a
  filtered G4 mode and an off-boundary G4 child" and "the G4 write lanes own
  their own range and take no subject".
- The four failures were all consequences of blocker 2, identity drift: the
  `after()` hook's `assertRaptor3Identity` reported
  `production: 'c945b8a25d16f1f89c9b873566d10ff72078f1143a2dd78ebb1337b7d1d10fd5'`
  against the `'d844ae0fe9b6392759ef67ca2e54ec5c7904ed94a13437d3a10b9403aff0332a'`
  captured at module load — the G4-02 phase-2 author writing `src/` mid-run.
  The failing cells were the three that compare saved evidence or re-capture
  identity ("the same replay command accepts saved fixed, cut/fault and clock
  corpora", "saved evidence with a stale identity, empty corpus or malformed
  wire fails", "completed G2 progress survives watchdog termination without
  becoming qualifying evidence") plus "test:all cannot replace the required
  lane through inherited specimen variables".

Attempt 2 was abandoned by this stream mid-run (see
`raptor3-cli-selftest-attempt2-abandoned.log`). The run that stands is
attempt 3.
