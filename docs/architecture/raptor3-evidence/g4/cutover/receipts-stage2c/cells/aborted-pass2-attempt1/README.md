# Aborted pass-2 attempt 1 — kept, never relabelled

The first attempt at the one permitted repeat of the stage-2c series was
**aborted after 9 of its 40 commands**, on a recorded machine condition and
**before any of its numbers were read**. Nothing here is a result; nothing was
deleted.

## Why it was aborted

`pass2__scalar-find-unique__execute__retained` failed after **1,014 s** with

```
Error: baseline package build failed:
Node command exceeded its 300 second wall limit.
```

(`pass2__scalar-find-unique__execute__retained.log`). That is
`buildCheckout` (`benchmarks/operation-pipeline-compare.mjs:290`) — an
infrastructure failure of the harness's own build step, not a cell refusal and
not a measurement.

The cause is the machine, not the candidate. Pass 1 ran at a 1-minute load
average of **5.8–8** (`../../machine-before-series.txt`). By the time this
attempt reached its sixth command the same average was **43–51**, with
`fseventsd` at 155 % and `syspolicyd`, `PerfPowerServices`, `WindowServer`,
Cursor, Devin and Raycast all heavy (`machine-at-abort.txt`). Per-command wall
time had gone from ~10 s to 24–56 s. Two commands later
`pass2__flat-scalar-update__prepare__cpu` also exited non-zero.

Running the one permitted repeat under a system-level storm that had already
broken a 300 s build limit would have produced a pass whose MADs, and therefore
whose `E`, describe the machine rather than the engines — and under the frozen
verdict rule ("the worse of the two full series") that noise decides cells. The
attempt was therefore stopped **on the environment**, not on its results: no
aggregation had been run over any file in this directory when the decision was
made.

## What "aborted" means here, exactly

- The driver process was terminated between commands; the compare process it
  had spawned was terminated with it.
- That left a **stale workspace lock**,
  `/private/tmp/viborm-g4-cutover-tmp/viborm-test-c33ebb4c906dfea8.lock`
  (`{"pid":81219,...}`; PID 81219 confirmed absent from the process table).
  **It was NOT removed** — this unit removes no lock file. A copy is kept here
  as `stale-lock-left-in-place.json`. The integrator can clear it with the
  instruction `scripts/test-run-lock.mjs:223` prints.
- Because that lock path is derived from `TMPDIR`, the replacement pass 2 runs
  with `TMPDIR=/private/tmp/viborm-g4-cutover-tmp2`. This is
  **measurement-neutral**: the only two uses of `tmpdir()` in the protocol files
  are the lock path (`scripts/test-run-lock.mjs:52`) and a `--calibrate`-only
  scratch directory (`operation-pipeline-compare.mjs:864`), and every sqlite3
  fixture in this series is `:memory:`
  (`operation-pipeline-fixtures.mjs:164`). Same machine, same filesystem, same
  commands, same counts.
- Everything this attempt produced is in this directory: 9 journal lines, 7
  evidence reports, every log, the driver's stdout, and the machine state at
  its start and at its abort.
