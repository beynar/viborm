# Witness follow-up brief — native fixtures, write-envelope campaign, G4-01 evidence landing

Read `common.md`, the accepted witness record (`g4/witness/note.md`,
`handoff.md`, `witness-review*.md`), and `g4/unit02/note.md` §12.3 (first
native run). You are the witness/harness author continuing after acceptance.
You own, again as sole writer: `tests/raptor3/g4/**` except `route-*` and
`review/unit02*`, `tests/raptor3/harness/**`, `tests/raptor3/transitions/live-world.ts`
(additive, keep every existing native suite green), `scripts/raptor3-manifest.mjs`,
`scripts/run-raptor3.mjs`, `scripts/raptor3-campaign-receipts.test.mjs`,
`scripts/raptor3-cli.test.mjs`, `scripts/credential-free-test-manifest.mjs`,
`vitest.workspace.ts`. No production file.

Providers are up (see `g4.md`; `docker port viborm-raptor3-g3-pg-20260914 5432`
and `docker port viborm-raptor3-g3-mysql-20260914 3306`; pass the port through
`VIBORM_RAPTOR3_PROVIDER_PORT`). Another author may be validating in the main
tree; validation is serial (retry on lock refusal). Note: every edit to
`tests/raptor3/**` or `scripts/**` changes the harness identity; batch your
edits, then validate.

## Outcome

1. **Native fixture repairs.** `read-envelope-native.test.ts` fails on
   PostgreSQL because `live-world.ts` builds its own `pg.Pool` (the driver's
   DATE text override is bypassed; both engines would decode identically on a
   driver-owned pool — `tests/raptor3/g4/unit02/native-date-codec.test.ts`
   proves it) and on MySQL because the seed writes `'2024-01-15T10:30:00.123Z'`
   into `DATETIME(3)`. Seed and inspect through provider-accepted physical
   forms (the fixture owns raw SQL; use the same physical spelling the driver
   would send, or route the fixture's pool through the driver's own pool
   factory), keep expectations independent of both engines, and re-run both
   G4 native modes. The remaining PostgreSQL `42883` in the recursive fit is a
   candidate gap (phase 2), not yours; keep that cell red and say so.
2. **Write-envelope campaign on new seeds.** Register `g4-write-seeds` and
   `g4-write-transport-seeds` as data-only campaign constants reusing the G3
   generator, `runG3SQLiteBatch`/transport runner and
   `assertG3GeneratedBatchReceipt` (it takes the campaign as a parameter) with
   fresh disjoint ranges: SQLite family 75000–99999 and transport family
   100000–124999, batch 100, three replays, the same actor/fault quotas and
   contract rotation. Add the modes to the runner (`campaignFor`, archive
   branch, mode list), the receipts self-test and the CLI test; run one
   1-batch child of each to prove the path and record child cost.
3. **Land the G4-01 evidence in the main tree.** Copy from
   `/private/tmp/viborm-g4-unit01`: `tests/raptor3/g4/unit01/` (author checks,
   83 tests) and `tests/raptor3/g4/review/unit01*/` (four reviewer probe
   directories) into the same paths in the main tree; fix the one TS2638 in
   `review/unit01-followup2/cursor-refusal.test.ts:29` (`(orderBy as { team?: unknown }).team`)
   and record that byte change; register them as fixed modes
   `g4-unit01-author` and `g4-unit01-review` with exact counts, excluded from
   the credential-free lane like the other G4 suites. The three probes that
   pin finding K (`competing-refusals`, `refusal-order-history`) are expected
   red until G4-02 phase 2 lands; register them anyway and record the red.
4. **Registration hygiene.** Confirm the `route-transactions` count (11) and
   every other G4 count against the files; run
   `node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs`
   and the CLI self-test in a quiet window; run the whole-estate typecheck.
5. Update `g4/witness/note.md` (append "Follow-up") with receipts under
   `g4/witness/receipts/followup/`, the measured native results, the new
   campaign constants, the landed modes and counts, and the disk projection
   for the two new families.

## Exit and return value

Structured summary: note path, native results per mode with receipts (port
and container recorded), new modes and counts, child cost for the write
campaign, landed G4-01 modes and counts with red cells named, self-test and
typecheck results, blockers, unverified claims.
