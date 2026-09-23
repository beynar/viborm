# Release unit "triage" — the Docker provider reds (brief)

Integrator: Fable. Worktree `/private/tmp/viborm-triage`, branch `triage`
from `383f830c` (commit 10; the rulings units o1/o2 land beside this lane and are merged by the integrator). `TMPDIR=/private/tmp/viborm-triage-tmp`, always
exported. Note, review and receipts under
`docs/architecture/raptor3-evidence/g4/release/triage/`.

## The situation

Two provider lanes carry pre-existing reds that predate the Raptor 3
program (memory: MySQL was 156 red on a clean tree in August 2026; the
pg container has no PostGIS). Measured on commit 8 (`g4/rulings/verification/`):

| lane | red | recorded set |
| --- | --- | --- |
| `provider-mysql2` | 165 | `g4/rulings/verification/rulings-mysql-red.txt` |
| `provider-pg` | 25 | `g4/rulings/verification/rulings-pg-red.txt` |

Known families (from the parity and rulings notes): MySQL — a migration
fingerprint mismatch, `ER_LOCK_DEADLOCK` concurrency cells, four namespace
containment cells; pg — five kept-red "batch primary-key dataflow"
registration cells (`Raptor 3 G1 atomic output requires exact identity
scratch or segmented RETURNING`), GeoPoint cells red for want of PostGIS.

Two FRESH containers exist beside the old ones, never touched by any run:
PostgreSQL with PostGIS at `postgresql://postgres@127.0.0.1:55732/raptor3_g2`
and MySQL 8 at `mysql://root@127.0.0.1:55731/raptor3_g2`. The old ones
(55729, 55730) stay untouched for comparison. `VIBORM_RAPTOR3_PROVIDER_PORT`
selects the port for the raptor3 modes.

## Required

1. **Separate container state from code.** Run `provider-pg` against 55732
   and `provider-mysql2` against 55731; diff each red set against the
   recorded one. Every cell that goes green on the fresh container is
   classified ENVIRONMENTAL with the mechanism named (PostGIS present;
   stale migration fingerprint; leftover schemas). Every cell red on both
   is a candidate defect.
2. **Triage every remaining red by family**, one table row per family:
   cells, the failing assertion, the owner, the class — (a) engine defect
   (repair at the owner under the rules, with falsifier), (b) test that
   pins an environment the estate does not promise (say what it promises,
   re-express only with a stated reason, never weaken), (c) registered
   kept-red contract (the five pg registration cells: state the contract
   that keeps them red and whether the release can carry them), (d) real
   concurrency flakiness (measure 3× and say so).
3. **Repair class (a) cells** at their owners, each with its falsifier;
   report the after-state red sets for both lanes on the fresh containers
   AND on the old containers.
4. A **release statement** per lane in the note: what is green, what stays
   red and why, what the user-facing consequence is.

## Rules (binding)

The twelve rules of `common.md`. No patchwork. Never delete, weaken or
`.skip` a test to go green. Refusals are contracts. Never restart, drop or
alter the OLD containers or their databases; the fresh containers are
yours to run against (schemas the tests create are theirs to drop).

## Verification (the minimum)

The two provider projects on both container pairs (`PG_TEST_CONNECTION_STRING`,
`MYSQL_TEST_CONNECTION_STRING`), the raptor3 modes `g2-pg-contracts` and
`g2-mysql-contracts`, the falsifiers of every repair, the whole-estate
typecheck at zero. Receipts per run.

## Deliverables

- `docs/architecture/raptor3-evidence/g4/release/triage/note.md` (the two
  diffs, the family table, the repairs with hunks and falsifiers, the after
  red sets, the release statements); code at owners for class (a).
- The reviewer writes `.../release/triage/review.md`.
- Never commit, stage, reset, stash or push; never write outside the worktree.
