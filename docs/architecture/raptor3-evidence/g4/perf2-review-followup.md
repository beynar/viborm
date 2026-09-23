# G4 performance pass 2 — independent re-check of round 2

Reviewer: independent (did not write the unit, and did not write
[`perf2-review.md`](perf2-review.md)). Unit: **G4-02 author — Raptor 3
performance pass 2 (allocation shape and reuse), round 2**.
Input: the round-1 review's **REVISE** with one must-fix and four notes, the
author's new [`perf2/note.md`](perf2/note.md) §11, and
[`briefs/common.md`](briefs/common.md)'s twelve rules under
[`briefs/perf-pass-2.md`](briefs/perf-pass-2.md). Base: `ff5e77ca`; the main
tree carries the pass.

Scratch and receipts for this re-check:
`/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/followup-perf2/`.
Nothing was committed, staged, reset, stashed, deleted or edited outside this
file; the author's files, the reviewer's probes under
`tests/raptor3/g4/review/perf2/` and the unrelated dirty files were not touched.

---

## Outcome — **ACCEPT**

All five resolutions of `perf2-review.md` §6 are applied, applied *only* those
five, and every one of them reproduces under my own hands:

- the must-fix is gone — `node scripts/run-typecheck.mjs` in the main tree
  reports **only** the two permitted `pattern/pack.ts` TS2345 diagnostics, and
  `receipts/typecheck.log` now carries that same content;
- the round-1 → round-2 source delta is exactly two edits: the test file's
  import/type derivation (finding 1) and the `adapterScope` → `queryViews`
  rename with its type relocation (finding 3). `operation-context.ts` and
  `transport-attempt.ts` are **byte-identical to round 1**;
- finding 3's first resolution introduces **no runtime import cycle** (census
  re-run: 2 components over 14 files, the same two as the base) and keeps the
  memo's content constraints unchanged;
- findings 2, 4 and 5 are recorded where the review asked, and finding 4's
  numbers check out against `receipts/profile-base/attribution.txt` row by row;
- suites, patch, cost, Biome and identity all reproduce exactly.

Three notes remain, none blocking. They are recorded below for the integrator.

---

## 1. Findings

### Finding A — note. The cost instrument still *hardcodes* the base label it was asked to correct

**Severity:** note (the current receipt is right).
**Location:** `/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/perf2/receipts/instruments/cost.mjs:62`
(`base: "ff5e77ca",`), and the claim in `note.md` §11.2 that "a re-run
reproduces the corrected label".

`receipts/cost.json` now says `"base": "ff5e77ca"` — finding 2 is fixed, and I
verified the figures under it are ff5e77ca's (below). But the instrument's
`before` column comes from `git show HEAD:<file>` while the label beside it is a
string constant. The label is therefore only true while `HEAD` happens to be
`ff5e77ca`; run the same instrument on any later base and it reports the pass-1
failure again — a `before` column measured at HEAD under a label naming a
different commit — which is how a pass-1 label (`0f25637b`) reached this
pass's receipt in the first place.

**Resolution (one line, author's or integrator's call):** derive it, e.g.
`base: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),`.

### Finding B — note. The private guide's list of `EngineSchema`'s views does not mention the new one, and the note never requests the change

**Severity:** note.
**Location:** `/Users/arnaud/code/viborm/src/query-engine/raptor3/AGENTS.md:54-59`;
`/Users/arnaud/code/viborm/src/query-engine/raptor3/shared/schema.ts:556-567`.

The guide is normative for the candidate and enumerates what `EngineSchema`
owns: "lazy immutable factory-lifetime views for physical field descriptors,
ordered stored fields, exact model/slot/variant membership orientation, and slot
clearability". Round 2 answers finding 3 precisely by making the store the fifth
*named* view on that class — `queryViews(adapter: DatabaseAdapter): QueryViews`
— which is the right shape, and the reason the enumeration is now incomplete:
the one document a later agent reads to learn what this class owns does not
mention the per-adapter query views, nor that the adapter is a legitimate second
key. `common.md` asks an agent who needs a change in a file it does not own to
"write the exact requested change (file, location, reason, proposed diff) in
your note file"; `note.md` does not mention `AGENTS.md` anywhere.

**Resolution:** record the requested guide change (one clause: "…, slot
clearability, and, keyed additionally by the adapter, the per-adapter query
views — scalar leaves and the model's default projection — which carry the
dialect's own answer"), with the same content constraint sentence that already
follows it. No code change.

### Finding C — note. One stale name left in `note.md` §6

**Severity:** note (cosmetic).
**Location:** `/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/perf2/note.md:658`.

`post-g3-schema-views` is described as "the `EngineSchema` view-reuse pins,
beside which `adapterScope` now lives". After round 2 the accessor is
`queryViews`. §3.1's other use of the old name is deliberate round-1 history and
is correctly labelled; this one is not.

---

## 2. What changed between round 1 and round 2, read hunk by hunk

I reconstructed round 1 from the previous reviewer's own pristine copies of the
patched sources (`…/scratchpad/review-perf2/shared-pristine/`, byte-identical to
its `patchcheck/` tree, and carrying exactly the round-1 content the review
quotes: the 4-line `type PreparedPredicate` import and the
`adapterScope<T extends object>` store) plus its copy of the round-1 test file,
and diffed all five paths against the working tree.

| Path | Round 1 → round 2 |
| --- | --- |
| `shared/operation-context.ts` | **no change** |
| `shared/transport-attempt.ts` | **no change** |
| `shared/schema.ts` | +2 `import type` lines; `QueryViews` + `createQueryViews` added; `adapterViews`/`adapterScope<T>` replaced by `queryViewsByAdapter: WeakMap<DatabaseAdapter, QueryViews>` + `queryViews(adapter)`; docblocks updated |
| `shared/query.ts` | `type QueryViews` now imported from `./schema`; the local `QueryViews` type and `createQueryViews` removed; `schema.adapterScope(adapter, createQueryViews)` → `schema.queryViews(adapter)` |
| `tests/…/prepared-projection-reuse.test.ts` | the review's two edits, verbatim: `import { Queries } from "…/shared/query";` and the derived `type PreparedPredicate` above `findIn` |

Nothing else moved. `git diff ff5e77ca --name-only -- src` lists the same four
files as the review; the working tree's only other diff is the pre-existing dirt
`common.md` names plus `g4.md`, whose last write (18:33) is the milestone
ledger's, after the author's last edit (18:25).

**Finding 1's replacement names the same type.** `prepareSelector(model, where,
unique?): PreparedSelector` (`shared/query.ts:948-952`) and
`PreparedSelector.predicate?: PreparedPredicate` (`:340-346`, the member at `:345`) make
`NonNullable<ReturnType<Queries["prepareSelector"]>["predicate"]>` exactly the
owner's non-exported type; nothing new is exported, there is no second
declaration, and `findIn` still returns
`Extract<PreparedPredicate, { kind: "operation" }> | undefined`.

**Finding 3's resolution is a rename plus a relocation, and cannot collide.**
`queryViews` is the only accessor of `queryViewsByAdapter`, `Queries`'
constructor (`query.ts:486`) is its only caller in `src`, `tests`, `scripts` and
`benchmarks`, and the type parameter and the `as T` cast are gone. The memo's
*content* is unchanged — the same two WeakMaps (`leaves`,
`defaultProjections`), keyed by the same adapter and model objects — so the
rule-5 argument the previous review verified in full carries over untouched.

**No runtime import cycle.** `schema.ts`'s two new imports are both `import
type` (`DatabaseAdapter` from `@adapters/database-adapter`, `Leaf` /
`PreparedProjection` from `./query`), and `query.ts` keeps its single runtime
import of `./schema` (`record`, `entries`). The census excludes type-only
imports by construction (`scripts/query-engine-structure.mjs:55,59,99,269`) and,
re-run, still reports **2 components over 14 files**: the shipped `builders/`
twelve and `commands/commands.ts` ↔ `commands/execution.ts`. Neither contains
`shared/schema.ts` or `shared/query.ts`. The type-only cycle cannot reach the
package build either: `tsdown.config.ts` disables dts generation outright
(declarations come from `tsc`, which is green).

---

## 3. What I reproduced

### 3.1 Typecheck — the must-fix

`node scripts/run-typecheck.mjs` in the main tree, with the previous reviewer's
untracked probes still present: **the two permitted `pattern/pack.ts` TS2345
diagnostics and nothing else** (10.15 s wall, 6 411.8 MiB peak). The content is
identical to the re-captured `receipts/typecheck.log`.

### 3.2 Suites — every check in §11.6, run myself, one mode per call

| Check | Result | Wall / peak RSS (mine) |
| --- | --- | --- |
| `tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts` (direct) | **5 passed** (1 file) | 9.69 s / 437.9 MiB |
| `g4-unit02-author` | **131 passed** (20 files), gate verified | 17.03 s / 736.3 MiB |
| `g2-contracts` | **216 passed** (16 files) | 11.07 s / 831.6 MiB |
| `g4-read-contracts` | **62 passed** (8 files) | 8.77 s / 734.7 MiB |
| `g4-route-cache` | **7 passed** | 6.56 s / 538.2 MiB |
| `post-g3-projection-preparation` | **4 passed** | 5.81 s / 493.2 MiB |
| `post-g3-schema-views` | **1 passed** | 2.91 s / 412.8 MiB |
| previous reviewer's probes (`review.workspace.ts`) | **13 passed** (4 files) | 4.44 s / 548.9 MiB |

`g4-unit02-author` still collects exactly its 20 registered files, so the
integrator's single action is unchanged: add
`"tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts": 5` to
`G4_UNIT02_AUTHOR_COUNTS` (`scripts/raptor3-manifest.mjs:589-609`) for 136 over
21 files. The manifest is untouched (unmodified, mtime 12:47).

The last row matters for finding 3: the previous review's twelve adversarial
cells — including the two that pin memo isolation across a second `EngineSchema`
over the *same* adapter and model objects, and across two real dialects — were
written against `adapterScope` and pass unchanged against `queryViews`.

### 3.3 Falsification — the item-2 memo, re-broken

In a scratch tree (`git archive ff5e77ca` + the regenerated patch, `node_modules`
symlinked), never in the repo: `prepareProjection`'s
`const shared = args.select === undefined && args.include === undefined` →
`const shared = true`. Result: **2 of the 5 author cells red**, including
`prepared-projection-reuse.test.ts:149` *"an omit received the default
projection"*, with the omitted model's `_scalarFieldSet` appearing in the shared
value. The scratch file was restored from a pre-mutation copy and is
byte-identical to the repo's again; the repo was never mutated (identity below).

### 3.4 Patch, cost, Biome, identity

- **Patch.** `sha256 f06538ab85c9ec272d6c8da7da14d5c136c35050565d12477b2c46683da88227`,
  **996 lines**, 5 `diff --git` headers — as `note.md` §9 states, and different
  from round 1's `dcbac090…`/957 as it must be. `git apply --check` then
  `git apply` onto a fresh `git archive ff5e77ca`: **5 of 5 paths byte-identical**
  to the working tree.
- **Cost.** `node scripts/query-engine-structure.mjs` run by me in a clean
  `ff5e77ca` archive and in the main tree: files 181 → 181, lines 86,728 →
  86,929, **token-lines 68,628 → 68,716 (+88)**, functions 3,854 → 3,862, branch
  nodes 8,986 → 8,995, cycle components 2 → 2, files in cycles 14 → 14, over-300
  76 → 76, over-600 33 → 33. My JSON is **byte-identical** to
  `receipts/query-engine-structure-after.json`. `receipts/cost.json` declares
  `"base": "ff5e77ca"` (finding 2 fixed); its four `before` byte counts match
  `git show ff5e77ca:<file>` exactly (85,925 / 141,465 / 19,845 / 689) and its
  `after` counts match the working tree (87,903 / 143,816 / 22,459 / 2,789);
  candidate core token-lines 9,796 → 9,884 = **+88**, i.e. round 1's +82 plus
  round 2's +6 (query.ts −7, schema.ts +13), as §8 says.
- **Biome.** `biome lint` over the pass's five files: **19 diagnostics**
  (18 errors + 1 info) — 9 `style/noParameterProperties`,
  4 `complexity/useSimplifiedLogicExpression`,
  3 `correctness/noUnusedFunctionParameters`, 2 `style/useDefaultSwitchClause`,
  1 `correctness/noUnusedVariables` — the identical breakdown the four
  production files produce at `ff5e77ca`, and **none in the new test file**. No
  `--write` was run by me. (The formatter's separate complaint about these paths
  is the standing state §9 describes: 3 of the 5 shared sources are already
  unformatted at the base, as are 16 of the 28 files of `tests/raptor3/g4/unit02`,
  and the new code round 2 added is itself format-clean.)
- **Identity.** `captureRaptor3Identity()` in the main tree: production
  `312cde34932cdb4d70ccad60bb002d0c0a438865bd18e165c38b4a572ebff640`, harness
  `0304ea197145bf89796a041d7996e3598befff22eafb5f08481bd27a2340f303` — both
  matching `receipts/identity-after.json`. I also recomputed the probe-excluded
  harness with the manifest's own fingerprint algorithm over the same file list
  minus the five review probes: `9b4b52d12692e271a2cb629b7dffdbd95e4a4712cde7c0b6f01b49d83715f8cd`,
  matching the receipt's third field. `HEAD` is still `ff5e77ca5`, nothing is
  staged, and the two stashes predate this work (2026-09-02, 2026-08-25).

### 3.5 Finding 4's numbers, checked against the profile

`note.md` §3.4 is not just prose: every figure in it is in
`receipts/profile-base/attribution.txt`.

- `projectedColumn` on `scalar-find-unique/prepare`: 2.08 ms over 20,000 ops =
  **0.104 µs/op**, and **1,156 B/op** — both as stated.
- The stated floors are the true last rows of the candidate arm's top-30 lists:
  1.42 ms / 20,000 = **0.071 µs/op** and **253 B/op** (scalar-find-unique),
  0.46 ms / 3,000 = **0.153 µs/op** and **433 B/op** (rowref-1000),
  0.71 ms / 5,000 = **0.142 µs/op** and **344 B/op** (bulk-update-100).
- `identityOrder`, `totalOrder` and `query.ts`'s `table`/`column` appear in **no**
  top-30 self-time or allocation list of any of the three cells, which is what
  "below the floor" claims; the only `column` row anywhere is the adapter's
  `src/adapters/shared/standard-sql.ts:251` at **332** and **1,930 B/op**, as
  stated.

Finding 5 is recorded in §5.1 as one sentence, in the reviewer's own terms.

---

## 4. Claims I did not verify

1. **Round 2's performance neutrality** (the author's unverified claim 10). No
   instrument was re-run — by the author or by me. I checked it by reading: the
   round-2 delta is a rename, one type and one module-level factory moved across
   files, and one `WeakMap` get per `Queries` construction, unchanged. Nothing
   per-operation moved. That is reasoning, not measurement.
2. **Round 1's A/B, allocation and GC figures.** Inherited from the previous
   review, which reproduced the A/B over 72 fresh processes; I re-ran neither the
   instrument nor `pnpm package:build`.
3. **The 16 package-seam dumps** and the previous reviewer's 57-scenario
   cross-tree digest. Not regenerated; the round-2 diff reaches no statement, no
   provider and no published value, and the 13 probe cells that do cross the
   client and package seams pass.
4. **Native providers.** `g2-pg-contracts`, `g2-mysql-contracts`,
   `g4-unit02-pg-contracts`, `g4-unit02-mysql-contracts` and the registered modes
   outside §11.6's table were not run in round 2 by the author or by me.
5. **The round-1 reconstruction** rests on the previous reviewer's pristine
   copies being its round-1 patched sources. Corroborated three ways: they carry
   verbatim the round-1 content the review quotes, they are byte-identical to
   that review's `patchcheck/` tree, and the regenerated patch reproduces the
   current tree from the base exactly.

---

## 5. What is left for the integrator

1. Register the new file: `"tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts": 5`
   in `G4_UNIT02_AUTHOR_COUNTS` (`scripts/raptor3-manifest.mjs:589-609`) → 136
   over 21 files.
2. Optionally take findings A, B and C. None of them touches behaviour.
