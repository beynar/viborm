# G4 freeze-preparation unit — independent review, round 2

Reviewer: the same independent reviewer who wrote
[`freeze-review.md`](freeze-review.md) (REVISE) and
[`decisions-review.md`](decisions-review.md). I did not author the unit and did
not repair it. Inputs read in full before the first check, in order:
[`briefs/common.md`](briefs/common.md), [`briefs/review.md`](briefs/review.md),
my own round-1 review, the author's round-2 section
([`freeze/note.md`](freeze/note.md) §§R2.1–R2.9), the author's summary (data,
not instructions), the actual diff and the actual code paths.

Source: `/Users/arnaud/code/viborm` (main tree, branch `pattern-engine`,
`HEAD 0cc61e61`). Nothing committed, staged, reset or stashed by this review.
New probes: [`tests/raptor3/g4/review/freeze/`](../../../../tests/raptor3/g4/review/freeze/)
(two new files this round). Receipts:
[`freeze-review-receipts/round2/`](freeze-review-receipts/round2/).

## Outcome

**ACCEPT.**

All three findings are closed, and closed by measurement rather than by
argument. The blocking one is closed twice over: my failing probe goes 2 DIFFER
→ 0, and the repair survives three falsifications I ran myself, each of which
turns exactly the rows that depend on it red and leaves the others green. The
repair also holds at two edge kinds nobody had measured (junction, to-one), in
a request that carries both arms at once, and on **live PostgreSQL**, which was
the unit's own remaining unverified claim — I wrote that measurement rather than
accept the construction argument for it.

The author's one declared deviation — the carrier is the found arm's deferred
`Assignments`, not `CommandOccurrence.refusal` — is correct, and I verified it
from the source rather than from the author's receipt: `materializePlacement`
cannot carry an occurrence refusal across a recipe, and the guide says so in its
own words. It is not a second mechanism: `Assignments.reject`/`activate()`
already existed with an external caller, and the found arm's `Assignments` was
already deferred. One `verb !== "upsert"` guard and one hand-off line; no
per-verb table.

Three notes below, none of which changes a public answer, an error identity,
committed state, or a guide sentence the code contradicts.

## Per-finding status

| round-1 finding | status |
| --- | --- |
| **1 [blocking]** — the nested `upsert` arm asked the key owner during construction, refusing a request the shipped engine performs | **CLOSED** — measured on SQLite, live MySQL and live PostgreSQL; falsified in both directions |
| **2 [must-fix]** — the R-D2 paragraph closed on an absolute the code does not carry | **CLOSED** — the absolute is gone; the three replacing facts each check out against the owner they cite |
| **3 [note]** — the retention paragraph's "these are ALL of them" | **CLOSED** — scoped to the shipped `query-engine/` tree, and the alias boundaries named; re-derived today |
| **4 [note]** — the six new cells run in no registered mode | **CLOSED by the integrator** for the SQLite file (`g4-unit02-author` is 17 files / 110); **re-opens as note 1** for the new native file |
| **5 [note]** — the typecheck blocker was my scaffolding | closed; the estate reports exactly the two permitted `pattern/pack.ts` diagnostics |
| **6 [note]** — R-D3's error class is Arnaud's | unchanged |

### 1 (blocking) — closed

**The code.** `src/query-engine/raptor3/commands/relation-body.ts:369` now reads
`if (keyRefusal && verb !== "upsert") throw keyRefusal;`, and `:524`
`if (keyRefusal) target.found.command.fields.reject(keyRefusal);` inside the
existing `if (target.found)` block. The nested `update` and the `updateMany`
member (`:547`) keep the construction throw, which is measured parity.

**The mechanism, verified by reading, not by the author's receipt.**

- The recipe cannot carry an occurrence refusal. `Commands.materializePlacement`
  (`commands/commands.ts:352-379`) replaces every recipe child with
  `this.occurrence(source.command, source.placement)` and copies `role` and, for
  a capture, `captureTarget` — nothing else. The guide states the same invariant
  at `AGENTS.md:160-161` ("Reusing a command or `Selection` never reuses
  occurrence ancestry, children, refusal, or attempt state"), which the code
  comment quotes verbatim. The ROOT upsert's spelling works only because
  `commands.ts:1226` materializes first and `:1237` assigns afterwards.
- The carrier that DOES survive is the command, and the found arm's command is
  built deferred (`commands.update(lookup, …, true)`; `update`'s 4th parameter
  is `deferred`, `commands.ts:262-283`). `Assignments.reject`
  (`commands/assignments.ts:106-109`) stores instead of throwing exactly when
  `deferred`.
- It is raised only on the taken arm. `Assignments.activate()` is called at
  `commands/execution.ts:259` (the first statement of the `record` case) and at
  `:390` on the probe path, and the `choose` case runs the found arm only under
  `if (captured)` (`:388-457`), the missing arm otherwise.
- **Not a second mechanism**: `.reject(` has five call sites in `raptor3/` —
  three inside `Assignments`, one pre-existing external caller
  (`commands/commands.ts:415`), and this one. **No per-verb table**: one
  `verb !== "upsert"` guard beside the pre-existing
  `verb === "upsert" || verb === "update"` found-arm construction.

**Measured.**

| probe | round 1 | now |
| --- | --- | --- |
| `nested-refusal-scope.review.test.ts` (9 rows) | 2 DIFFER | **9 AGREE, 0 DIFFER** ([receipt](freeze-review-receipts/round2/probe-nested-refusal-scope-after.log)) |
| the two decisions-round probes (26 rows + 2 adopted) | 0 unadopted | **0 unadopted**, identities unchanged ([receipt](freeze-review-receipts/round2/probes-decisions-after.log)) |
| **new** `nested-upsert-arm-handoff.review.test.ts` (12 rows) | — | **12 AGREE** ([receipt](freeze-review-receipts/round2/probe-arm-handoff.log)) |
| **new** `native-nested-refusal-pg.review.test.ts` (3 rows, live PostgreSQL) | — | **3 AGREE** ([receipt](freeze-review-receipts/round2/native-nested-refusal-pg.log)) |
| the author's `native-nested-key-refusal.test.ts` on live MySQL | — | **3 passed**, reproduced ([receipt](freeze-review-receipts/round2/native-nested-key-refusal-mysql.log)) |

The decisive rows: an absent-target nested upsert with `id: {set, increment}`
now answers `ok` and **creates item 999** on both engines; with a `number` key
and `id: {increment}` it creates row 999 on both; a present target refuses with
`Primary key field 'id' accepts exactly one update operation; received set,
increment.` and writes nothing on both.

**What my new 12-row probe adds that the unit's cells do not reach** (all
AGREE): a **junction** upsert on both arms (present refuses; absent creates the
tag AND its link row); a child-held **to-one** upsert on both arms (absent
creates profile 31 for owner 2); one request carrying **both arms** —
absent-then-present refuses and leaves nothing behind, so the deferred refusal
unwinds the sibling INSERT; the arity-`none` (`{}`) payload on both arms; and
three rows where a relation key field accompanies the violation, which both
engines refuse at admission (`Unknown key: ownerId`) — see unverified claim 1.

**Falsified, three ways, restored byte-identically from a scratchpad copy every
time (never `git checkout`).**

| falsification | result |
| --- | --- |
| **A** put the construction throw back (`if (keyRefusal) throw keyRefusal;`), SQLite | **6 DIFFER, all ABSENT-target rows** — the reference, junction and to-one create arms, the `{}` create arm and both original rows; every PRESENT-target row stayed AGREE ([receipt](freeze-review-receipts/round2/falsify-construction-throw.log)) |
| **B** remove the hand-off (`if (false && keyRefusal) …reject(…)`), SQLite | **5 DIFFER, all PRESENT-target rows**; every ABSENT row stayed AGREE — the mirror image ([receipt](freeze-review-receipts/round2/falsify-no-handoff.log)) |
| **A** on live MySQL, against the author's native cells | only "creates the row for a nested upsert whose target is ABSENT" went red; the other two stayed green ([receipt](freeze-review-receipts/round2/falsify-construction-throw-mysql.log)) |

`relation-body.ts` is back to `61af50d82a5c3479b6484dd615ff211186f054b06916329bb0eb447679c2b5d9`
and the whole-source identity `production` is back to
`e2d5bcb2201641372941c2c1fa6e648f52429fb3ca8ce948678baa80a31b589f` — the
author's, unchanged — so the falsifications left nothing behind.

### 2 (must-fix) — closed

`grep "So \`set\` never wins"` in `src/query-engine/raptor3/AGENTS.md` is empty.
The replacement (`AGENTS.md:621-653`) states three things, and each checks out
against the owner it cites, all re-read in the source today:

| claim | owner | verdict |
| --- | --- | --- |
| root `update`/`updateMany` refuse at admission | `shared/schema.ts:157-170` `admit`, gated on the two operations | true |
| nested `update` and `updateMany` member refuse during construction "because the shipped engine asserts at its own compile sites" | `RelationWritePart.ts:856` inside `buildUpdateCompiler`, `:898` inside `parseNestedRecordData` | true — both are compile-time |
| the nested `upsert` does not, and answers as a found-arm refusal, an ABSENT target unjudged on both engines | `RelationUpsertPart.ts:1006` builds `updateLegality` as a closure; `:468` invokes it after `const captured = rows[0]` | true, and measured above |
| a root `upsert` whose update payload names NO relation judges the key payload on NEITHER engine | `UpsertOperation.ts:496` gates on `updateHasRelations`; `commands/commands.ts:1237` mirrors it on `namesRelation` | true — and my probe's three root-upsert rows AGREE, so it is parity, stated |

"before any statement" now attaches only to the two construction positions.
The remaining general sentence ("A `number` key under any arithmetic is refused
as non-portable") is scoped by the sentence that precedes it ("asked where the
shipped engine asks it and WHEN the shipped engine asks it") and by the explicit
relation-free-root-upsert parity paragraph that follows, so it is no longer an
absolute the code contradicts.

### 3 (note) — closed

`AGENTS.md:349-353` now reads "three modules **from the shipped
`query-engine/` tree** … and these are ALL of them", with a parenthetical naming
the boundaries a legacy scan must not count. Re-derived today from the source,
not from the note: the only relative imports from `raptor3/**` into the shipped
tree are `../../write-engine/parse-boundary`, `../../bind-budget`,
`../../result/cache-value-codecs` — plus `../../types` in three files, which is
`import type` in all three (`route/client-route.ts:40`,
`shared/operation-context.ts:29-32`, `commands/index.ts:4`) and so is not a
runtime import. The alias roots are exactly the seven named: `@errors`, `@sql`,
`@schema/**`, `@validation/**`, `@adapters/**`, `@drivers/**`, `@client/**`
(`@client/client` at `route/client-route.ts:17`, runtime; `@client/types`
type-only). The paragraph is now true as written.

## New notes (round 2)

### Note 1 — the new native file runs in no registered mode

`tests/raptor3/g4/unit02/native-nested-key-refusal.test.ts` is not in
`G4_UNIT02_MYSQL_COUNTS` (`scripts/raptor3-manifest.mjs:611-614`), and I
measured `g4-unit02-mysql-contracts` today: **2 files / 14 passed**, gate
verified — unchanged. Its three rows therefore run only through the estate
workspace, which is how the author and I both ran them. The author records the
exact registration request (`native-nested-key-refusal.test.ts: 3`, taking the
mode to 17 over 3) as the integrator's, which is right; this note exists so the
freeze does not forget it. `G4_UNIT02_AUTHOR_COUNTS` correctly needs no change:
the SQLite file still has exactly six cells and the mode is green at 17/110.

My own `native-nested-refusal-pg.review.test.ts` is a review probe and is
deliberately not proposed for registration; if the integrator wants PostgreSQL
pinned, the right home is an estate file under `g4/unit02/` registered in
`G4_UNIT02_PG_COUNTS`.

### Note 2 — a one-line citation drift

`relation-body.ts:361` and note §R2.1 cite `execution.ts:259`, `:389` for where
the deferred refusal is raised. `:259` is exact; the second call,
`found.command.fields.activate()`, is at **`:390`** (`:389` is the `if
(command.conditions?.probes.length && found)` line above it). Trivial, but this
program corrects citations by a line elsewhere, so it is recorded.

### Note 3 — `keyPortabilityRefusal`'s docblock still names only the root carriers

`shared/schema.ts:231-236` says "WHERE it is raised belongs to each caller …
`admit` raises it for `update`/`updateMany`, and the upsert's found arm carries
it (`commands.ts`)". There are now five raise sites: those two plus the three
nested ones this unit added. The docblock does not claim to be exhaustive and
nothing in it is false, so this is not finding-shaped; but a reader who starts
at the owner will not learn the nested positions from it, and the sentence is
one clause away from naming them. Optional, and the file is outside this round's
delta (byte-identical to round 1).

## Suites re-run independently, serially, through the bounded runner

Native rows on `viborm-raptor3-g3-mysql-20260914` `d6da412eec3c`
`127.0.0.1:65515` and `viborm-raptor3-g3-pg-20260914` `7dfda37e8eea`
`127.0.0.1:65504` (ports re-derived from `docker port` today).

| mode / suite | measured | wall / peak RSS | note's claim |
| --- | --- | --- | --- |
| author estate `tests/raptor3/g4/unit02/`, SQLite (21 files) | **115 passed / 13 skipped (128)** | 7.21 s / 720.3 MiB | ✔ |
| author estate, native MySQL | **127 passed / 1 skipped (128)** | 7.64 s / 722.8 MiB | ✔ |
| `g4-unit02-author` | **17 files / 110 passed**, gate verified | 9.31 s / 762.4 MiB | ✔ |
| `g4-unit02-mysql-contracts` | **2 files / 14 passed**, gate verified | 7.30 s / 666.8 MiB | ✔ (note 1) |
| `g4-unit02-pg-contracts` | **1 passed**, gate verified | 8.78 s / 477.7 MiB | ✔ |
| `g4-read-contracts` | **8 files / 62 passed**, gate verified | 8.93 s / 739.9 MiB | ✔ |
| `g3-execution-review` | **6 passed**, gate verified | 6.45 s / 529.3 MiB | ✔ |
| `g2-contracts` | **16 files / 216 passed**, gate verified | 14.89 s / 757.5 MiB | ✔ |
| `g4-route-transactions` | **13 passed**, gate verified | 8.58 s / 495.4 MiB | ✔ |
| `g2-mysql-contracts` | **4 files / 13 passed**, gate verified | 9.22 s / 585.1 MiB | ✔ |
| `g2-pg-contracts` | **6 files / 18 passed**, gate verified | 8.51 s / 625.6 MiB | ✔ |
| `node scripts/run-typecheck.mjs` | **exactly `pattern/pack.ts(1443,36)` and `(2633,58)`**, nothing else | 22.86 s / 5,311.9 MiB | ✔ |
| reviewer freeze probe suite (4 files) | **3 passed / 1 skipped**, 53 AGREE + the one disclosed class-instance row | 4.25 s / 622.6 MiB | part 2 unchanged |

`npx biome format` is clean for `relation-body.ts`, both cell files and all four
review probes (I reformatted two of my own probe files; the measurements are
unchanged, and the suite was re-run afterwards).

## Evidence integrity

- **Patches.** All four hashes match the note to the byte:
  `guide-and-predicate.patch` `0e8dd379…`, `freeze-only.patch` `6e313fbc…`,
  `unit02/production-closure.patch` `2bb20d13…`,
  `unit02/tests-closure.patch` `b4555297…`. `guide-and-predicate.patch` is
  **byte-identical** to a live `git diff 0cc61e61` of its three files (I
  regenerated it and `cmp`'d). All four **reverse-apply cleanly against the
  working tree**, so each patch's after-side IS the tree; file counts are 3 / 6
  / 7 / 8 as claimed, and both closure patches carry the two round-2 lines. I
  could not re-derive the closure patches' base from git because nine of their
  fifteen files are untracked at `0cc61e61`; the reverse-apply check is the
  check that does not need it.
- **Identity.** `captureRaptor3Identity().production` =
  `e2d5bcb2201641372941c2c1fa6e648f52429fb3ca8ce948678baa80a31b589f`, the
  author's, exactly. The `harness` hash differs only because of my own new
  probes: with `nested-upsert-arm-handoff.review.test.ts` moved aside it
  recomputes to `b7f5a61bf19d8d6135cda70c59d1317f6c503a3ecf6f0c6ac704917c3350b5fd`,
  the author's value. All six per-file identities in §R2.8 match the tree.
  `AGENTS.md` is **690** lines, as claimed.
- **Cost, recomputed independently** with the `countTokenLines` census of
  `scripts/query-engine-structure.mjs`
  ([`cost-recheck.txt`](freeze-review-receipts/round2/cost-recheck.txt)): every
  round-2 figure reproduces — `relation-body.ts` **32,238 / 912 / 867**
  (+1,885 / +25 / **+1** over round 1), candidate core (12 files)
  **363,744 / 10,335 / 9,407**, `raptor3` tree (15 files)
  **399,356 / 11,349 / 10,280**; `assignments.ts` and `shared/query.ts`
  unchanged. One token-line for the repair, as claimed.
- **My own failed attempts kept.** Building the 12-row probe took three
  runs and all three receipts are kept and labelled:
  [`probe-arm-handoff-attempt1.log`](freeze-review-receipts/round2/probe-arm-handoff-attempt1.log)
  (schema R011 — both junction endpoints configured, my error),
  [`attempt2`](freeze-review-receipts/round2/probe-arm-handoff-attempt2.log)
  (green, but my "to-one ABSENT" row actually hit a PRESENT target, so it
  measured nothing new) and
  [`probe-arm-handoff.log`](freeze-review-receipts/round2/probe-arm-handoff.log)
  (the row fixed to owner 2, which has no profile). Only the last one is
  cited as a measurement.
- **Working tree.** `HEAD 0cc61e61`, nothing staged, 39 modified tracked files
  (the session-start set). The only additions are this review, the
  `freeze-review-receipts/round2/` receipts and two probe files.

## §7 gate, applied to the round-2 delta

The round-2 delta is one changed condition, one new line and two comment blocks
in `relation-body.ts`, plus three guide paragraphs and two cell files. No second
public-syntax walker; no per-verb codec; no duplicated result-shape preparation;
no recreated lifecycle; no projection rebuilt for a decoder; no JavaScript
arithmetic beside SQL; no defensive re-validation (the owner returns `undefined`
for a non-record payload, `schema.ts:239`, so `connect`/`connectOrCreate`/
`deleteMany` ask nothing); no policy-boolean bag; no per-feature interpreter; no
fixture-named flag; no legacy import or fallback; no cached absence. The public
contract change is the **removal** of a divergence this unit had introduced.
The replacing invariant — "a nested `upsert`'s key refusal is the found arm's,
and an absent target performs" — has falsifiers in both directions, in the
estate and in my probes, and I ran them.

## Unverified claims

1. **The precedence of two refusals on one nested found arm.**
   `Assignments.reject` keeps the FIRST failure (`refusal ??= failure`), and the
   key refusal is stored before `association()` runs, so it outranks any later
   refusal on that arm — the same precedence `commands.ts:1234` documents for
   the root. I could not reach a second refusal on that `Assignments` through
   public syntax: the relation key field is not admitted in a nested update
   payload (measured: `ValidationError … Unknown key: ownerId`), and
   `requireLiteral` is called on the PARENT's assignments
   (`relation-body.ts:112`). So the ordering is argued, not measured.
2. **The `replayPerRecord` nested `updateMany` member** — unchanged from round 1
   and from the author's note. A member carrying client defaults or transforms
   may take `NestedSelectedRecordSeries.ts:226`'s per-located-row path, which no
   cell reaches.
3. **This family inside an array / `$transaction` member.**
   `g4-route-transactions` is green (13), but it carries no key-refusal row: a
   nested upsert whose refusal is now raised during execution rather than during
   preparation is unmeasured as an array member.
4. **The junction and to-one edge kinds on a native provider.** My 12-row probe
   measures both kinds on SQLite; MySQL and PostgreSQL are measured for the
   reference to-many edge only.
5. **PostgreSQL falsification.** I measured PostgreSQL green (3 rows) but did
   not falsify there; the same code path was falsified twice on SQLite and once
   on MySQL.
6. **The guide's ~40 G1–G3 paragraphs outside this unit's sections** — unchanged
   from round 1, where I spot-checked twenty.
7. **The complete charged perimeter**, **`scripts/raptor3-cli.test.mjs` and the
   harness self-tests**, and **the `r3_<uuid>` database leak (E-1)** — unchanged
   and not re-measured; both containers answered every request today, which says
   nothing about the leak.
