# Packaging notes from the integrator (freeze 2, 00:55 2026-09-16)

- Frozen identity: g4/freeze/identity.json (production fce8ec0c…, harness 2b5ed066…). identity-1-superseded.json is NOT the one.
- Attempt 1 (superseded identity) is kept under g4/qualified-attempt-1-stale-identity/ and is not part of this package.
- Child receipts of the campaign parents live under /private/tmp/viborm-g4-lane-tmp-N/ (see each parent receipt's verified.json batches[].directory). MOVE them into campaigns/<mode>/ rather than copying — disk is tight.
- The corpus of each child is already gzip-archived by the runner with generated-corpus.archive.json (originalSha256, archiveBytes); verify restore before unlinking any raw file that may remain.
- Replays: replays/ holds the frozen-identity replays (first child of each family + cs03 parents) and the G3-era inputs as expected stale refusals (*-stale.log). Structural measurement: structure/.
- Refused-mode re-runs (lock contention) are re-run by rerun-refused.sh before RUNS-COMPLETE; a mode whose log still says "Test command refused" after that is NOT a failure and must be listed as such.
- Known reds expected: none. Any red receipt is a finding, named in the report.
- Open decisions for Arnaud (not blockers of the package): D-7.1 and R-D3-class (g4.md decision table).
- (03:15) replays/: the two `*.not-a-replay-input.*` entries are by design (G4 read corpora carry `subject`; they are reproduced by the child command, see replays/NOTE.md). They are NOT reds. The two child reproductions land under replays/receipts/ after the performance series; if they are not there yet when you build the index, list them as pending in the report rather than failing.
