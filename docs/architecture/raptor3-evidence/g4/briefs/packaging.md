# Packaging unit — seal the G4 qualification evidence

Read `common.md`, `g4/qualification-plan.md`, the ledger `g4.md` ("Freeze"
and "Qualification" records), and the G3 sealed package
`docs/architecture/raptor3-evidence/g3/structure-correction/qualified-final/`
(its `README.md`, `reproduction.md`, `qualification-index.json`,
`support/build-*.mjs`, `package-g2-corpora.mjs`, `retain-g2-corpora.mjs`,
`audit-retained-corpora.mjs`, `SHA256SUMS`, `retained-files.json`,
`task-commit-allowlist.json`). The G4 package lives at
`docs/architecture/raptor3-evidence/g4/qualified/` with the same layout:
`fixed/`, `native-pg/`, `native-mysql/`, `campaigns/`, `replays/`,
`structural-measurement/`, `support/`, `README.md`, `reproduction.md`,
`qualification-report.md`, `qualification-index.json`, `source-allowlist.json`,
`source.patch`, `retained-files.json`, `SHA256SUMS`, `task-commit-allowlist.json`.
The receipts are already there (the integrator's driver copied every mode's
receipt directory as `<group>/<mode>.receipt` with its log beside it;
campaign parents under `campaigns/`, their child receipts under the
runner's evidence directories named in each parent's `verified.json`).

## Work

1. Adapt the six G3 support scripts to `g4/qualified/support/` (paths,
   identity from `support/final-identity.json` = `g4/freeze/identity.json`,
   baseline commit `0cc61e61`'s full sha, the G4 campaign list: `g4-seeds`,
   `g4-transport-seeds`, `g4-write-seeds`, `g4-write-transport-seeds` (250
   children each, 25,000 seeds, two profiles, three replays per cell) plus
   the nine inherited campaigns with G3's retention rules; replays: the seven
   G3 inputs re-run on the frozen identity plus the two stale refusals;
   support: receipts self-test, CLI self-test, typecheck (only the two Pattern
   diagnostics), driver integration (2 files / 16 tests), the two log-only
   credential-free selectors with provenance, `query-engine-structure`,
   `source-cost.json` + `parser-token-census.json`; structural measurement
   receipt (28 cases / 60 replays / 0 skipped, instrumentation restored).
2. Corpus retention: compress every child receipt directory of the four G4
   campaigns and the inherited ones per G3's `package-g2-corpora.mjs`
   (gzip per child, restored bytes and sha256 verified against the archive
   descriptor before the raw corpus is unlinked); write the packaging and
   retention reports and the audit; disk is tight — verify free space before
   and after (`df -h`), never delete a receipt that failed to verify.
3. `source-allowlist.json` + `source.patch`: the exact task file set is
   `git status --porcelain` under `scripts/`, `src/`, `tests/raptor3/`,
   `tests/types/raptor3/`, `tests/contracts/adapters/dialect-vocabulary.core.test.ts`,
   `vitest.workspace.ts` (modified and untracked; untracked files are added
   to the patch with `git diff --no-index` or listed with their hashes as
   "untracked"); EXCLUDE `CONTEXT.md`, `memory.md`,
   `tests/pattern/pack/program-dump.ts`, `tests/pattern/match/decode-malformed.core.test.ts`,
   the untracked evidence archives at `docs/architecture/raptor3-evidence/*.gz|*.json`
   that predate G4, and every `docs/` file (evidence is documentation);
   `task-commit-allowlist.json` lists exactly what the integrator's commit
   will stage.
4. `qualification-index.json` built by the adapted script, with totals
   asserted against the receipts actually present (compute the expected
   totals from the receipts, then pin them in the script as G3 did);
   `README.md`, `reproduction.md` (commands, ports as recorded, lanes and
   their own `TMPDIR` locks, the E-1 environment step), `qualification-report.md`
   (Outcome / Validation / Risks, claim boundaries, pre-existing reds, every
   blocker still open), `retained-files.json` and `SHA256SUMS` last.
5. Never commit or stage; never delete anything outside `g4/qualified/` raw
   corpora you verified; report free disk before/after.

## Exit and return value

Structured summary: unit, summary, location, indexPath, reportPath, totals
(fixed modes/tests, native, campaigns cells/replays, replays, stale
refusals), retention (archives, bytes), sha256sums, blockers,
unverifiedClaims.
