# G4-01 query/projection — independent review of the THIRD repair pass

Reviewer: independent (did not author the unit, did not repair anything).
Source reviewed: `/private/tmp/viborm-g4-unit01` (detached at `0cc61e61`, the
thrice-repaired change already applied). This document follows
`unit01-review.md` (REVISE, 3 blocking + 4 must-fix),
`unit01-review-followup.md` (REVISE, 4 findings) and
`unit01-review-followup-2.md` (REVISE, 5 findings: J blocking; F, H, I
must-fix; G note).

**Outcome: REVISE.**

**All five findings the repair was asked to close — F, G, H, I and J — are
resolved, and resolved well.** Each of the three production repairs lives in the
owner the review pointed at, states its rule once, copies the shipped sentence
character-for-character, and has a falsifier that actually fails on the
pre-repair source. I wrote 49 new adversarial checks aimed squarely at the
repairs — the *precision* half of the decimal rule (the author only probed
scale), the shorthand and `not` routes into the repaired owner, every read verb
and both write verbs, three relation scopes, the check order against the two
guards that precede it, the sentinel kind and the second JSON column, and
sixteen shapes that must **not** refuse — and **46 pass**. Every earlier probe
set, every registered suite, the cost census, the production identity and the
patch reproduce exactly. The typecheck diagnostic that finding F was about is
gone.

It is REVISE for one thing, and it is not this repair's doing:

**K (must-fix, new).** When a single call violates *two* contracts at once — a
`where` refusal and the cursor refusal — the two engines answer **different
error identities**. The candidate answers the `where` refusal; the shipped
engine answers the cursor refusal. I established by probe that this is **not a
regression of repair 3**: the same divergence reproduces with the *cross-model
field-reference refusal*, which has been in this unit since **r2** and has now
survived three reviews, mine included, because nobody paired a where-refusal
with a cursor-refusal before. Repair 3's new refusal merely joins the existing
class. Both engines refuse, with the same error class, and both messages are
true of the caller's query — so the blast radius is small — but it breaks the
invariant this unit states in its own harness (`world.ts:166-168`: *"the
candidate may not answer an admitted input differently"*), and error identity is
inside this round's REVISE gate.

The fix is a **sequencing** change (which owner runs first in `readQuery`), not
a string, and it touches three call sites — so it is one decision, briefly
stated below, rather than a fourth one-line repair. If Arnaud rules that the
*precedence between two independently owed refusals* is outside the parity
contract (`common.md` says "preserve the registered refusals", not "preserve the
order two of them arrive in"), then K converts to a recorded decision and this
unit is **ACCEPT as delivered** — nothing else is open.

---

## Identity and reproduction

| Fact | Value |
| --- | --- |
| Production identity (`captureRaptor3Identity()`) | `db3c07dac7cea4a4c7a0da3b94a684c20d993a5b6ec4ed1e02d9ff7f4665528c` — **identical** to `repair3/identity.json` |
| Harness identity | `3915c164257a8c47199ceba5beed921efc07f6f074456dff35001aadcc9e3292` after adding my 7 new probe files; the author's `repair3/identity.json` harness hash is what the tree carried before I touched it |
| `production.patch` vs worktree `git diff -- src` | **byte-identical** (4 files, +2315 / −423) |
| Files edited at r5 | **`src/query-engine/raptor3/shared/query.ts` only** (mtime 02:21:56). `commands/index.ts` (22:52:28), `shared/operation-context.ts` (22:52:41) and `shared/schema.ts` (22:52:14) still carry their r2 mtimes — the author's claim verified |
| My 25 probe files (r1: 11, r3: 6, r5: 8) | **byte-identical** to the copies under `unit01-review/`, `unit01-review-followup/probes/` and `unit01-review-followup2/probes/` — the author did not touch one of them |
| r2/r3/r4 receipts (`receipts/`, `repair/`, `repair2/`) | untouched; the one stale receipt kept and **marked**, not replaced or relabeled |
| Staged or committed | **nothing** (`git diff --cached` empty; HEAD still `0cc61e61`) |
| Runtime | Node v24.21.0, darwin/arm64, better-sqlite3 12.6.0, Vitest 3.1.4 |

Everything was re-run serially through `node scripts/run-vitest-safe.mjs` on the
current bytes. The workspace lock was held by another agent's session twice; I
waited and retried rather than bypassing it (`serial-run.log` records the
attempt counts). Receipts:
`/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/unit01-review-followup3/`.

| Suite set | Result | Review receipt | Author receipt |
| --- | --- | --- | --- |
| **New review probes (this pass)** — `tests/raptor3/g4/review/unit01-followup3/` | **49 checks, 46 pass, 3 fail.** The 3 failures are one finding (K) and 1 of them is pre-existing r2 code | `decimal-domains.json` (17/17), `cursor-sweep.json` (11/11), `json-sentinel-sweep.json` (9/9), `decimal-reach.json` (5/5), `competing-refusals.json` (3/4), `refusal-order-history.json` (1/3) | — |
| `tests/raptor3/g4/review/unit01-followup2/` (my r5 probes) | **63/63 pass** — was 58/63; the five named failures are gone | `followup2-probes-rerun.json` | `repair3/followup2-probes.json` (63) — reproduced |
| `tests/raptor3/g4/review/unit01-followup/` (my r3 probes) | **44/44 pass** | `followup-probes-rerun.json` | `repair3/followup-probes.json` (44) — reproduced |
| `tests/raptor3/g4/review/unit01/` (my r1 probes) | **44/44 pass** | `review-probes-r1-rerun.json` | `repair3/review-probes.json` (44) — reproduced |
| `tests/raptor3/g4/unit01` (69 + 14 new) | **83/83 pass** | `author-tests-rerun.json` | `repair3/author-tests.json` (83) — reproduced |
| `candidate-handoff`, `candidate-ordering`, `candidate-pagination`, `candidate`, `cleanup-failure` | **68/68 pass** | `registered-candidate-suites.json` | reproduced |
| `post-prep/{clearability-consumption,history-analysis,projection-preparation,schema-view-reuse,selector-preparation}` + `prep/{recursive-read-fit,selector-dependencies,variant-collection-order}` | **39/39 pass** | `registered-prep-suites.json` | reproduced |
| `prep/{g3p04-review-regressions,set-preparation,suppression-replay}` | **16/16 pass** | `write-regressions-prep.json` | reproduced |
| `post-prep/g29-*` minus the PGlite file | **30/30 pass** | `write-regressions-g29.json` | reproduced |
| `ownership/commands`, `polish/commands`, `transitions/junctions-commands`, `transitions/keys-commands` | **52/52 pass** | `write-regressions-ownership.json` | reproduced |
| `post-prep/g29-result-progress-pglite.test.ts` (alone) | **1/1 pass** at 1520.0 MiB — **third** attempt; attempts 1 and 2 breached the 1,536 MiB ceiling at 1556.5 and 1543.5 MiB. Recorded as failed, not relabeled. Same environment behavior as r4 | `g29-pglite.json`, `g29-pglite-attempt1-breached.log` | same behavior |
| Whole-estate typecheck (my own run, on the current bytes) | the two permitted `pattern/pack.ts` TS2345, the pre-existing `tests/pattern/pack/program-dump.ts(131,7)` TS2532, **and one TS2638 that is mine, in my own r5 probe file** — see note L. **The unit's own harness is clean** | `typecheck.log` | `repair3/typecheck.log` — same four lines, reproduced exactly |

**The author's falsification evidence is honest, and I verified both halves
programmatically rather than reading the claim.**
`repair3/followup2-probes-before.json` fails on **exactly the same five named
checks** as my own r5 receipt (`unit01-review-followup2/new-probes.json`) — set
equality verified. `repair3/new-witnesses-falsified.json` fails 8 of 14 on the
pre-repair source, and the 6 that pass are **precisely the six controls** (the
scalar-order cursor page, the `path` + `equals: null`, the whole-column
sentinels, the same-domain reference, the two non-decimal columns, the
same-domain reference inside a `NOT`).

---

## Status of the five findings

| # | Follow-up-2 finding | Status |
| --- | --- | --- |
| **J** | (blocking) The decimal field-reference domain refusal is missing; the candidate silently answers | **RESOLVED.** |
| **H** | (must-fix) The cursor refusal is reworded | **RESOLVED.** |
| **I** | (must-fix) The JSON sentinel-with-path refusal is reworded and loses its subject | **RESOLVED.** |
| **F** | (must-fix) A typecheck diagnostic in the unit's own harness, behind a stale receipt | **RESOLVED.** |
| **G** | (note) Two numbers for one fact | **RESOLVED**, and made permanently checkable. |
| — | **K (new, must-fix)** | Refusal **precedence** between the selector owner and the pagination owner diverges. Pre-existing since r2, not a repair-3 regression. |
| — | **L (new, note)** | The one remaining non-permitted typecheck diagnostic is in **my own** probe file, not the unit's. |
| — | **M (new, note)** | `handoff.md` was not updated for r5: no r5 revision entry, falsifiers stop at 18, and the three refusals restored here are recorded only in `note.md`. |

### J — resolved, in the right owner, and it holds everywhere I could reach it

The refusal is raised in `prepareOperand` (`shared/query.ts:989-1021`), the one
function that reads a field-reference operand and the one that already raises
this unit's other two field-reference refusals. I checked the shape of the
repair against the shipped rule rather than against the note:

- **The rule is not restated.** `sameDecimalDescriptor` is imported from
  `@validation/primitives/decimal-codec` — the same comparison the shipped
  where-builder uses (`builders/where-builder.ts:447`) — and grep confirms it is
  imported once (`:41`) and used once (`:1009`). There is no shipped-builder
  import: `grep -rn "builders/\|operations/" src/query-engine/raptor3/` finds no
  import at all.
- **The state reading is spelled once.** `exactDecimalDomain` (`:236-247`) has
  one definition and exactly two call sites, both in the new guard, and is a
  line-for-line mirror of the shipped `decimalDescriptorOfState`
  (`builders/decimal-field.ts:30-35`) including the deliberate `undefined` for a
  decimal **list**. `grep -rn "precision" src/query-engine/raptor3/` turns up no
  second domain comparison.
- **The message is the shipped message.** I concatenated the shipped four-part
  template (`where-builder.ts:450-453`) and compared: identical, including the
  argument order (`referencedField` first, `fieldName` second). My probes pin it
  absolutely, so the agreement cannot pass by both engines being wrong alike.
- **The signature change is inert.** `prepareOperation`'s guard moved from
  `target.scalar?.model` to `target.scalar`; since `PreparedScalar.model` is
  non-optional, `!!model === !!owner` and no branch changed.

Verified green — `decimal-domains.test.ts` (17 checks) and
`decimal-reach.test.ts` (5 checks), all differential against the shipped client
over identical SQLite data:

- the **precision-only** difference (`decimal(12,2)` vs `decimal(10,2)`) refused
  with the reversed-argument sentence pinned absolutely — the author only probed
  a scale difference, and this is the other half of `sameDecimalDescriptor`;
- the **shorthand** form (`where: { cents: <ref> }`, no operator object), which
  reaches the owner through `prepareOperations`' shorthand branch rather than
  through `equals`;
- under `not`, under `lt`/`lte`/`gt`/`gte`, inside `NOT: […]`, inside an `OR`
  beside a satisfiable arm, and inside `OR → NOT → AND` at depth;
- on **every read verb** — `findFirst`, `count`, `aggregate`, `groupBy` — and in
  both write verbs' `where` (`deleteMany`, `updateMany`);
- in a **relation quantifier** (`some`, `none`) and in a **nested read's own
  where**, with the sentence naming the *related* model and its fields
  (`'fee' is decimal(8,2) and 'feeMicros' is decimal(8,3)` on `'line'`) — so the
  scope the refusal names is the filtered scope, not the root;
- and it does **not** over-refuse: a same-domain reference still answers
  `[{id:1}]`, so does one to a **nullable** decimal, so does a same-domain
  reference under `NOT` and inside a relation, and so does a reference between
  two **int** columns.

Two ordering checks, because a new throw can pre-empt an older one:

- a **cross-model** reference whose domains also differ answers the **scope**
  refusal on both engines — the new guard is correctly third, after scope and
  after "does not name a scalar field", exactly as
  `assertComparableDecimalDomains` is called after both in the shipped owner;
- `in: [<ref>]` and a **type-mismatched** reference agree on both engines
  (admission owns them — the interned list schemas are `v.string({array:true})` /
  the decimal list schema, so the shipped `is not supported by the '<op>' filter`
  refusal is unreachable on both, like the vector `"filter"` arm already
  recorded).

I also closed the two reach questions the author did not: a field reference in a
**`having` aggregate operand** and in a **unique selector** agree on both
engines (`havingAggregateSchema` builds plain `v.decimal` operands, not
comparison operands, so no reference is admitted there), and a refusing
reference beside `distinct` or beside a window refuses identically.

### H — resolved, and it does not over-refuse

`page()` (`:1799-1802`) now carries the shipped sentence verbatim
(`operations/cursor-order.ts:56-58`, compared character for character).
`cursor-refusal-sweep.test.ts` (11 checks): the sentence is pinned **absolutely**
on a to-one relation path, a collection `_count`, a scalar order *beside* a
relation order, a relation order *first*, a negative window, and a cursor with
no `take` — and the shapes that must still page do:

- a scalar order beside a cursor pages to `[{id:2},{id:3}]` on both;
- a relation order with a **window but no cursor**, and with a **skip but no
  cursor**, still answer rows on both — the refusal is gated on
  `args.cursor !== undefined`, matching `normalizeCursorOrder`'s own
  `if (cursorEntries)`;
- a cursor with **no `orderBy` at all** pages identically;
- the same violation inside a **nested read** refuses identically.

### I — resolved, and the field it names is the right one

`lowerJsonOperation` (`:1409-1412`) now carries the shipped template including
`'${field}'` and the sentinel kind (`builders/json-filter-builder.ts:308-310`,
compared character for character). The doc-comment invariant is real: I checked
`lowerOperation` (`:1216-1219`) — the JSON branch is entered only when
`target.scalar` resolved a state, so the `!` is sound rather than hopeful.

`json-sentinel-sweep.test.ts` (9 checks) pins the sentence absolutely for
**`DbNull`, `JsonNull` and `AnyNull`** — and does it on the **second** of two
JSON columns in one `AND`, so a hard-coded or mis-targeted field name would
fail; under `not`, under `NOT`, under `OR`, at a two-segment path, and in a
relation scope (naming `payload`, the related field). The shapes that must still
answer do: an **empty** `path: []` beside every sentinel, the three whole-column
sentinels, and `path` with a plain `equals: null` → `[{id:1}]`.

### F — resolved, and the receipt is now honest

`tests/raptor3/g4/unit01/world.ts:173` types `differential`'s `operation` as
`Parameters<World["engine"]["execute"]>[1]`. My own whole-estate typecheck on
the current bytes no longer contains `world.ts(188,7) TS2345`. The evidence
handling is the right shape: `repair2/typecheck.log` is kept **byte-untouched**
and marked stale by `repair2/typecheck.SUPERSEDED.md`, the r4 record's "nothing
else" sentence is struck through and corrected **in place with an r5 marker**
rather than quietly rewritten, and `repair3/typecheck.log` was captured at
02:23:28 — after the last source edit at 02:21:56, which I verified from the
file mtimes rather than from the claim.

### G — resolved, and the class is closed rather than papered over

Neither "32" nor "35" is claimed any more; both places now say the split is
unverifiable (correct — the r3 source is not reachable) and state only the net.
Better, the author made *this* revision's split permanently checkable:
`repair3/query-r4-to-r5.diff` is +37/−9 physical (I counted: 38 and 10 lines
minus one header each), netting +28, which is exactly the measured line delta
and exactly consistent with the patch stat moving from +2289/−425 to
+2315/−423. I verified the diff is a real record of the change, not a
reconstruction: every added line appears in the current source and no removed
line survives.

---

## New findings

### K. (must-fix) Two owed refusals, two different winners

`src/query-engine/raptor3/shared/query.ts:2013-2023` (`readQuery`'s owner
sequence), observable through `prepareSelector` (`:2019`, whose `prepareWhere` is at
`:672`) and `page()` (`:2023`).

When one call violates both a `where` contract and the cursor contract, the
engines answer different errors:

| input (plain SQLite, no provider tier) | candidate | shipped |
| --- | --- | --- |
| `where: { cents: { equals: fields.micros } }` **+** `orderBy: { lines: { _count: "asc" } }` **+** `cursor` | `Field reference 'micros' cannot be compared with 'cents' on 'led': …` | `Cursor pagination supports direct scalar sort directions only; relation and vector-distance orderBy are not supported.` |
| `where: { cents: { equals: <cross-model ref> } }` **+** the same order and cursor | `Field reference 'line.fee' cannot be used while filtering 'led': …` | the same cursor sentence |

The candidate prepares the projection, then the selector, then pages
(`:2013-2023`); the shipped engine normalizes the cursor order before it builds
the `where`. So every `where`-owned refusal wins on the candidate and loses on
the shipped engine.

**This is not a repair-3 regression.** The second row uses the cross-model
scope refusal, which is **r2 code** — it predates all three repairs and all
three reviews, mine included. My control in the same file confirms the scope of
the divergence is exactly this: with a *valid* `where` beside the same cursor
violation, both engines answer the cursor refusal.

Probe: `tests/raptor3/g4/review/unit01-followup3/competing-refusals.test.ts`
(1 of 4 failing) and `refusal-order-history.test.ts` (2 of 3 failing, one of
them the r2-code row). Receipts: `competing-refusals.json`,
`refusal-order-history.json`.

**Why it is a finding rather than a nit.** Both engines refuse, with the same
error class, and both sentences are true of the caller's query, so no data is
wrong and nothing is silent. But the unit states the invariant itself, in its
own harness: *"the candidate may not answer an admitted input differently"*
(`tests/raptor3/g4/unit01/world.ts:166-168`), and this is an admitted input
answered differently.

**Resolution — and it is one decision, not a fourth one-line repair.** Either:

1. Move the cursor-order normalization ahead of the selector preparation in
   `readQuery` (`:2013-2023`) and at the two other `page()` call sites (`:2159`,
   `:2858`), deriving the target order from the shipped sequence rather than
   guessing it — note that a **projection** refusal (`Distance select supports
   only one _distance field per select.`) sits ahead of both today, so the
   correct order has to be established for all three owners at once, not two; or
2. Record, as a decision for Arnaud, that `common.md`'s "refusals are contracts"
   governs *which* refusals exist and *what they say*, not the **precedence**
   between two independently owed ones — in which case K closes as a recorded
   decision and this unit is ACCEPT as delivered.

I have not chosen between them; that is the maintainer's call, and it plausibly
applies to G4 units beyond this one.

### L. (note) The one remaining typecheck diagnostic is the reviewer's, not the unit's

`tests/raptor3/g4/review/unit01-followup2/cursor-refusal.test.ts(29,32): error
TS2638` — `"label" in (orderBy.team ?? {})`. **That file is mine**, written at
r5. The unit's own harness is clean, which is what finding F asked for, and the
author correctly evidenced that by also capturing
`repair3/typecheck-without-review-probes.log` (clean apart from the three known
diagnostics) beside the as-delivered log.

I deliberately did **not** edit it: the author's `repair3/typecheck.log` and the
byte-identity of my 25 probe files are both load-bearing evidence right now, and
silently changing a probe after the author reproduced it would cost more than
the diagnostic does. The fix is one line for whoever lands the review probes —
`(orderBy as {team?: unknown}).team` or a typed table instead of the `in` test.
My seven new r5 probe files add **no** diagnostics.

### M. (note) `handoff.md` was not updated for r5

`docs/architecture/raptor3-evidence/g4/unit01/handoff.md` (mtime 01:38:25, the
r4 timestamp). Its Revisions list ends at **r4**, its falsifier list ends at
**18**, and its §5 refusal section still enumerates only "the registered
**distance** refusals". Nothing in it is now *false* — that sentence is scoped
to the distance refusals and they are still verbatim — but the three refusals
restored at r5 are genuine contract statements with falsifiers, and every prior
revision of this unit recorded exactly that in the handoff. As delivered they
live only in `note.md` and in `repair3.test.ts`.

Resolution: an r5 entry in §Revisions and falsifiers 19–21 (the cursor sentence,
the JSON sentinel template with its field and kind, the decimal domain refusal),
each already witnessed by `repair3.test.ts`.

---

## §7 decision-elimination gate, answered against the r4 → r5 diff

**1. Necessary decision or representation repair?** Repair, and the smallest
available one. The diff adds one local reading (`exactDecimalDomain`), one
parameter type change (`AnyModel` → the `PreparedScalar` the caller already
held), two copied strings and one doc-comment sentence. No new mechanism: no
cache, no scope, no capability, no policy boolean, no second interpreter, no
per-verb codec, no projection rebuilt for a decoder, no JavaScript arithmetic
beside SQL, no cached absence, no fixture-named flag. No legacy import
(`grep -rn "builders/\|operations/" src/query-engine/raptor3/` → no import) and
no fallback.

**2. Did the named mechanism disappear, and does the replacing invariant have a
falsifier?** Yes. `prepareOperand(model, …)` is gone — grep finds one definition
and three call sites, all passing `owner`. The three refusals the review named
are gone as strings: `grep` for `relation and distance` and for
`A JSON null sentinel describes the column` matches nothing. The replacing
invariants each have a falsifier that fails on the pre-repair source: 8 of the
author's 14 witnesses do, and 3 of my own absolute pins would too (they assert
the refusal, which the pre-repair source did not raise).

**3. Is each rule stated once and used by every consumer?** The decimal rule is:
one import of `sameDecimalDescriptor`, one use; one `exactDecimalDomain`, two
uses, both inside the guard. The two copied sentences each have one site. The
rule *"a registered refusal is a contract"* is now honored across the unit's
whole message vocabulary — I re-enumerated all **23** refusal sites in
`query.ts` and every one either matches the shipped text exactly or is
unreachable on both engines by admission (the two already recorded). What is
**not** stated once is the *precedence* among refusals raised by different
owners — that is finding K, and it is an architectural sequencing property, not
a duplicated rule.

**4. What grew?** Reproduced exactly (below).

## Cost check

Recomputed independently with the census's own `countTokenLines` walk over
`raptor3/commands` + `raptor3/shared` (receipt: `core-cost-recheck.json`):

| Scope | Author | Recomputed | Match |
| --- | --- | --- | --- |
| **Core after r5** | **8,889 / 8,660 / 54,569 / 296,423** | **8,889 / 8,660 / 54,569 / 296,423** | **yes, byte for byte** |
| Repair-3 delta (r4 → r5) | +28 / +19 / +143 / +1,438 | same (against my own r4 measurement) | yes |
| `shared/query.ts` | 3,465 → 3,493 physical | 3,493 / 3,333 / 21,886 / 119,206 | yes |
| Every other core file | unchanged from r4 | **identical, file by file** | yes |

The +28 net is independently corroborated three ways: the census delta, the
patch stat moving from +2289/−425 to +2315/−423, and the +37/−9 of
`repair3/query-r4-to-r5.diff`.

## Unverified author claims

| Claim | Status after this review |
| --- | --- |
| PostgreSQL / MySQL lowering is adapter-spelled but not executed | **Still unverified and correctly labeled.** Unchanged by r5, which touches no lowering. |
| The distance projection's positive path / the vector positive path are not executed | Unchanged, correctly labeled. |
| The `"filter"` spelling of `distanceExpression` is unreachable for a vector | Verified true at r5, unchanged. |
| "The rule stays owned by `sameDecimalDescriptor`, not a shipped-builder import" | **Verified true** by grep and by reading both owners. |
| "Only the state reading is spelled locally, as `exactDecimalDomain`" | **Verified true**; it is a line-for-line mirror of `decimalDescriptorOfState`, list case included. |
| "`lowerOperation` reaches this owner only when the scalar's state is JSON, which is why the refusal can name the field" | **Verified true** at `:1216-1219`; the `!` is sound. |
| "Production edits are confined to `shared/query.ts`; the other three files carry their r2/r3 mtimes" | **Verified true** from the filesystem. |
| "The typecheck was re-run AFTER the last edit" | **Verified true** (02:23:28 vs 02:21:56), and my own run on the current bytes reproduces the author's log line for line. |
| "The reviewer's 25 probe files are byte-identical before and after" | **Verified true** for all 25. |
| "58/63 before, 63/63 after, 83/83, 44/44, 44/44, 68/68, 39/39, 16/16, 30/30, 52/52, 1/1, 14 new witnesses, 8/14 falsified" | **Reproduced in full**, and the pre-repair failure set is **set-equal** to my own. |
| The r4 added/removed split | Correctly marked **unverified** and no longer claimed — finding G. |
| handoff §5 / §10 as the unit's contract record | **Stale for r5** — note M. No statement in it is false. |

## What would make this ACCEPT

One decision, and two record edits:

1. **K.** Either align the owner sequence in `readQuery` (`:2013-2023`, and the
   two other `page()` call sites) so a cursor violation is raised where the
   shipped engine raises it, or record — as Arnaud's decision — that precedence
   between two independently owed refusals is outside the parity contract.
   Witness either way: `competing-refusals.test.ts` and
   `refusal-order-history.test.ts`. Note that the second row of that probe is
   **r2** code, so whichever way this goes it is a statement about the unit's
   architecture, not about repair 3.
2. **M (note).** An r5 entry in `handoff.md` §Revisions and falsifiers 19–21.
3. **L (note).** One line in **my** probe file, for whoever lands the review
   probes.

F, G, H, I and J are closed. No compatibility decision is owed from any of them:
each had the shipped engine as an unambiguous oracle, and each is now
message-for-message identical to it.
