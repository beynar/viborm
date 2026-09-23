# Release unit "cs03" — the CS-03 A self-test under the plans the parity program changed (brief)

Integrator: Fable. Worktree `/private/tmp/viborm-cs03`, branch `cs03` from
`29622ac54` (commit 15, the branch head). `TMPDIR=/private/tmp/viborm-cs03-tmp`,
always exported. The worktree is the only write target; note, review and
receipts live under `docs/architecture/raptor3-evidence/g4/release/cs03/`.

## The finding

`pnpm test:all` (what CI's credential-free gate runs) is red at its raptor3
stage — the credential-free runner's `RAPTOR3_FIXED_LOCAL_TESTS` under a
cleared replay/specimen/evidence environment
(`scripts/run-credential-free-tests.mjs`, the "Raptor 3 fixed contracts"
stage) — on ONE file: `tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts`,
10 of 42 cells: "records and exactly replays CS-03 A seed 7109 / 7117 / 7119 /
7128 / 7149 under 'sqlite-interactive' and 'sqlite-atomic-batch'", each
failing with `Missing semantic cut capture:nested/root-member/0; observed
outcome: {"kind":"success", …}` (some seeds observe a `TransactionError:
updateMany with …` outcome instead). Reproduce it first:
`VIBORM_RAPTOR3_REPLAY_PATH= VIBORM_RAPTOR3_SPECIMEN= VIBORM_RAPTOR3_EVIDENCE_DIRECTORY= node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=raptor3 tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts --rss-limit-mb=1536 --heap-limit-mb=768`
(receipt of the integrator's run: the branch's `g4/release/…` will carry
yours). This stage never ran on the branch before commit 12 (stage 1 failed
on the inventory cell since the cutover), so the file was never measured
against the plans the program changed. No fixed raptor3 mode runs it.

## What changed, by design

The expected cuts come from the CS-03 A scenario
(`tests/raptor3/core-structure/measurement/extension-a-scenario.ts`, lines
around 109–125 and 316–345 and 520–545: `capture:roots/N`,
`capture:nested/root-member/N`, the admission and effect cuts, conditioned on
`recipe.nestedShape` — updateMany, deleteMany, upsert-found, …). Since the
parity program: **U6.2** (`docs/architecture/raptor3-parity-plan.md`,
`g4/parity/lane-x-note.md`): a nested `updateMany`/`deleteMany` without
nested relation writes is ONE correlated statement — no planning read, no
captured member; the repair round re-expressed `cs01-extension-a` for it
(`g4/parity/repair-note.md` R6, the method to follow). **D-29**
(`g4/rulings/note.md`): a queued premise rides the atomic unit it protects.
**D-46** (`g4/release/d46/note.md`): the array route's upsert. **D-32**:
raceable capture premises. The unit decides, per red cell, which ruling
moved which cut, and re-expresses the scenario's EXPECTED cuts to the plan
the rulings pin — never by deleting an assertion that still holds, never by
weakening a cut the plan still performs.

## Required

1. Reproduce, then attribute each of the 10 cells' missing cuts to the ruling
   that removed the capture (read the recipe of each seed: the harness under
   `tests/raptor3/harness/` and `extension-a-scenario.ts` build recipes from
   seeds; `tests/raptor3/harness/sqlite-world.ts:419` raises the message).
2. Re-express the scenario at ONE owner (`extension-a-scenario.ts`'s cut
   expectations), stating the plan the parity program pins: the shapes whose
   nested member is a set mutation carry no capture cut; keep every other cut.
   If a seed's outcome differs in KIND (the `TransactionError: updateMany
   with …` observations), say why under the rulings (it may be the parity
   admission refusal of an empty nested filter — U1 — or the D-29 premise);
   if a cell reveals a genuine engine regression instead, STOP and report it
   as a blocker with the reproduction.
3. Falsifier: the self-test file green under the credential-free stage's
   cleared environment (all 42), and red again when the re-expression is
   reverted in a scratch copy; the fixed modes `cs01-extension-a`,
   `cs03-member-scope`, `g2-baseline` unchanged (`node scripts/run-raptor3.mjs <mode>`);
   the whole-estate typecheck at zero; `npx biome check` clean on the touched files.
4. Then `pnpm test:all`'s raptor3 stage alone: run
   `node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=raptor3 <the 65 files of RAPTOR3_FIXED_LOCAL_TESTS from scripts/credential-free-test-manifest.mjs>`
   with the same cleared environment and report it green.

## Rules (binding)

The twelve rules of `docs/architecture/raptor3-evidence/g4/briefs/common.md`.
No patchwork. Refusals are contracts. A scenario expectation may be
re-expressed only where the physical plan changed by design; name the ruling
per cut. Never commit, stage, reset, stash or push; never write outside the
worktree; never touch `/Users/arnaud/code/viborm`.

## Deliverables

- The re-expressed scenario; `docs/architecture/raptor3-evidence/g4/release/cs03/note.md`
  (per cell: seed, transport, the missing cut, the ruling, the change; the
  falsification record; the stage run; receipts under `receipts/`).
- The reviewer writes `.../release/cs03/review.md` with ACCEPT / REVISE (exact
  minimal resolutions) / BLOCK.
