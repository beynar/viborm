# G4 common brief (read first, every agent)

You are working on Raptor 3 G4 in the VibORM repository. Read, in order:

1. `AGENTS.md`, `src/query-engine/AGENTS.md`, `src/query-engine/raptor3/AGENTS.md`
   (the private guide is normative for the candidate), and the nested guide of
   every other layer you touch.
2. `docs/architecture/raptor3-implementation-plan.md` §§1–2, 4, 6 (G4 section,
   6.1–6.3), 7 (decision-elimination gate, performance budgets), 8, 9, 10.
3. `docs/architecture/raptor3-evidence/g4.md` (current milestone ledger, unit
   ownership, seed ranges, environment blockers).
4. `docs/architecture/raptor3-evidence/g3-prep-inventory.md` for the rows your
   unit owns. The status column is a 2026-09-09 baseline: reconcile it with the
   current source and registered suites before treating a row as missing.
5. `docs/architecture/raptor3-evidence/g3.md` "Current structural-correction
   checkpoint" and `g3/structure-correction/root-acceptance.md` for what G3
   fixed and what G4 must not recreate.

## Hard rules that apply to every agent

- **Pinned runtime.** Use `/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin/node`
  (the `node` on PATH resolves to it). Do not change dependency versions.
- **Validation is serial** under the existing workspace lock. Run tests only
  through `node scripts/run-vitest-safe.mjs run <files…>` (or the raptor3
  runner) so the lock and resource ceilings apply. Never run two test or
  typecheck commands concurrently yourself. If the lock is held, wait and
  retry; do not bypass it. Never run the full G3/G4 campaigns during unit work.
- **Whole-estate typecheck** is `node scripts/run-typecheck.mjs` (about 25 s,
  4.5 GB RSS). Only the two historical Pattern TS2345 errors at
  `src/query-engine/pattern/pack.ts:1443` and `:2633` are permitted; any other
  diagnostic is yours to fix or report.
- **Preserve unrelated work.** Never `git reset`, `git stash`, `git checkout --`
  a file you did not author, delete archives, or stage files. Dirty unrelated
  files (`CONTEXT.md`, `memory.md`, `tests/pattern/pack/program-dump.ts`) and the
  untracked evidence archives stay untouched. Do not commit.
- **Own only your files.** Your brief names the files you may edit. If you need
  a change in a file owned by another stream, write the exact requested change
  (file, location, reason, proposed diff) in your note file and continue with
  work that does not depend on it. Two agents editing different functions in
  the same file is a conflict.
- **One fact, one authority.** Prepare selectors/projections once per admission
  scope; SQL and dependency meaning consume the same prepared predicate. No
  second public-syntax walker, no raw-selector authority, no projection
  rebuilt to obtain a decoder, no per-verb codec, no JavaScript arithmetic
  beside SQL, no new interpreter/context/scope class, no policy-boolean bags.
- **Adapters spell SQL; existing codecs own scalar meaning.** Reuse the
  existing adapter vocabulary (`adapter.operators`, `filters`, `orderBy`,
  `aggregates`, `json`, `expressions`, `literals`, `subqueries`, `identifiers`,
  `result`) and the existing validation/schema codecs (decimal, DateTime,
  date/time, JSON, blob, vector, GeoPoint, lists, enums). Add an adapter
  capability only when a provider genuinely lacks a spelling, in the exact
  adapter seam, and record it.
- **Validate once at admission; trust downstream.** Provider rows and errors
  are a separate real boundary and are decoded once. Existence, membership,
  affected-row counts and transaction outcomes are execution semantics, keep
  them. Localized `as`/non-null assertions are allowed where an upstream
  invariant establishes the fact.
- **No legacy imports or fallbacks.** The candidate never imports the shipped
  engine's compiler, lowerer, executor, query builders or result engine and
  never falls back to it. Existing schema/validation, resolved topology,
  parameterized `Sql`, adapters and drivers remain available boundaries.
- **Refusals are contracts.** Preserve the registered refusals (inventory
  section G). A new observable compatibility choice is a decision for Arnaud:
  record it as a blocker in your note, do not copy or "fix" legacy behavior.
- **Evidence discipline.** Save raw receipts (JSON reporters, logs, identities)
  under your evidence directory as each command runs. Failed attempts stay
  failed and keep their receipts; never relabel. Record wall time and peak RSS
  from the bounded runner line. Report unverified claims as unverified.
- **Stop rules.** The same minimized failure surviving two attempted repairs,
  a needed public-contract change, a needed legacy fallback, or duplicated
  semantic interpretation to pass a witness is a blocker: save a reproducer,
  record it in your note, and continue only independent work.
- **Decision-elimination gate.** Before your first production edit, write
  `note.md`: required behavior, current owner, smallest proposed change, and
  the exact decisions that disappear (mechanism, consumers, replacing
  invariant, falsifier). At completion answer the four §7 questions against
  your actual diff and report incremental core / complete charged LOC, parser
  tokens and bytes using `node scripts/query-engine-structure.mjs` (see the
  G3 `qualified-final/support/source-cost.json` for the charged file lists;
  tests and evidence are counted separately).
- **Your final message is data, not prose for a human.** Return exactly the
  structured fields your prompt asks for, with absolute paths to your note,
  handoff, receipts and patch.
