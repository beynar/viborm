# N4 — group A5: the census tool

Files written by this group, and no others:

- `scripts/raptor3-refusal-census.mjs` — NEW, the census tool.
- `docs/architecture/raptor3-evidence/g4/release/n4/census.md` — the report, written by the tool.
- `docs/architecture/raptor3-evidence/g4/release/n4/note-A5.md` — this note.

**No production code was changed by A5.** The invariant owner
(`src/query-engine/raptor3/shared/invariant.ts`, `EngineInvariantError` /
`assertInvariant` / `unreachable`) already existed when this group started; it
is imported by name and by module, never re-declared.

---

## 1. Truth

The first census (`g4/root-review-C-receipts/`, four throwaway scripts) could
answer exactly one question — *does a sentence thrown inside `raptor3/**` also
exist in the shipped engine's source?* — and called everything it could not
match an unmatched refusal. Plan §4's last bullet asks it for two distinctions
it never had: **an invariant assertion is not a refusal, and a sentence no
admitted payload reaches is not a public one.** Both are now made **by
construction**, never by reading a message:

| outcome | decided by | can it be spoofed by wording? |
|---|---|---|
| INVARIANT | the site throws through `shared/invariant.ts` — an `assertInvariant`/`unreachable` call, or `EngineInvariantError`, resolved through the file's own `import` so a same-named local helper is not mistaken for it | no |
| INTERNAL | the site lies inside a **declared private fit** whose privacy the run re-checks; today one fit, D-54's recursive read | no |
| REFUSAL | everything else thrown in `raptor3/**`, split *registered* (the shipped engine carries the sentence) / *public* (it does not) | no |

Four things this unit established that the map could not:

**(a) The 63 / 59 / 55 discrepancy is reconciled.** The map states up front that
it "could not reconcile 63 vs. 59". Replaying the receipts' own matching over
the frozen `refusals.json` against the shipped corpus yields **exactly 63**, and
the four entries beyond `unmatched.json`'s 59 are four further doc-comment
fragments — the same kind as the four the map had to skip by hand. So
`63 = 55 real sentences + 8 comment fragments`, all eight of them artefacts of a
line-regex extractor. This census parses TypeScript: a throw is a
`ThrowStatement` and a sentence is its message argument, so **none of the eight
can be produced**. Verified — see falsification F1, where the census at the
map's own revision differs from `unmatched.json` by exactly those four
fragments (plus two sentences the tree reworded and four that were added later).

**(b) The shipped corpus had to be pinned, and the pin is load-bearing.** The
shipped engine's own owners were retired at `356254a2d`
("retire the pattern experiment and the owners it kept alive") and `29622ac54`.
`src/**` outside `raptor3/` no longer contains the sentences the census matched
against, so running the receipts' matching against the working tree now reports
**83** public refusals (85 once the tool reads named constants; see the
addendum) — it would read 60-odd inherited contracts as new. The
corpus is therefore read with `git grep` at `SHIPPED_CORPUS_REV = 0cc61e61f`,
the revision where the shipped engine and the candidate still coexisted and the
one the receipts' own `newness.mjs` already used as its baseline. That
constant, and only it, restores the census's question.

**(c) The recursive-read cluster is exactly the 11 the map found, and its
privacy is a checked claim rather than an exemption list.** The fit names its
regions structurally — the declarations `recursive` and `decodeRecursive`, the
`case "recursive"` arm, and an `if (… === "recursive")` guard — and it carries
the evidence for its own privacy: the entry symbols `.recursive(` and
`kind: "recursive"`, and the one file allowed to name them. Every run greps
`src/**` for them. If a public caller ever appears, the fit is **contradicted**:
its sites go back to being refusals, the report says so in a banner, and the run
exits non-zero. D-54 stops being a comment somebody has to remember.

**(d) Seven public refusals have no row in the map** (`census.md` §Public
refusals; the list below). Three are rewordings of map rows #4 and #11 —
`Invalid provider collection` / `Invalid provider row` became
`InvalidScalarResult("collection" | "row", <reason>)`, so the census reads the
three reasons instead. **Four entered the candidate after the receipts were
frozen and were never ruled on:**

| sentence | site | reads like |
|---|---|---|
| `Dependency read is not under the write's tree` | `commands/commands.ts:953`, plain `Error` | the same occurrence-tree invariant as map rows #37–#42 — it has no row, so no group owns it |
| `INSERT … ON CONFLICT did not produce the required record` | `commands/commands.ts:1557` | INTEGRITY, the sibling of #28 |
| `Driver '…' reported ${written} of ${rows.length} inserted rows for operation '…'` | `shared/operation-context.ts:2028` | INTEGRITY (provider row count) |
| `Raptor 3 variant integrity requires junction storage` | `shared/query.ts:3968` | a NOT-IMPLEMENTED sibling of #32 |

A5 did not touch them — they are in other groups' files. **Request to the
integrator:** rule on these four, or record them as carried. The first is the
strongest candidate for `assertInvariant`, and it is the only one that is
plainly an invariant by the map's own reasoning for rows #37–#42.

### The three outcomes, apart (plan §4, "Reported apart")

Counts from `census.md`, written at `07:52` on `bf7ac30b4` + 8 dirty engine
files. Because the other four groups are converting sites concurrently, these
move; the base column is fixed and is the unit's real starting point.

| | base `bf7ac30b4` (F2) | first run, 07:45 | final run, 07:52 |
|---|---|---|---|
| invariant sentences | **0** | 18 | **18** |
| internal (D-54 private) | 11 | 11 | **11** |
| refusal — registered | 64 | 64 | **64** |
| refusal — public | **46** | 25 | **22** |
| sites without a sentence | 63 | 64 | 66 |
| total sites | 189 | 188 | 187 |

**Public refusals: 22, against the 55 the map started from.** Of the 24 gone
since the base: 18 became invariants through the owner (the other groups' ASSERT
rows) and the rest were deleted or re-expressed at their owners. The 11
recursive-read sentences are reported apart as internal in both columns — the
census never counted them as public once the fit was declared, which is the
"say so, do not touch" of plan §4 turned into an artefact.

---

## 2. Per-row table

A5's rows are plan §4's census-tool bullet plus the 11 recursive-read rows,
which §4 dispositions as "internal until a public argument reaches them (say so,
do not touch)". Saying so is this tool's job; no code moved for them.

| row | sentence | disposition | what changed | the fact | pin |
|---|---|---|---|---|---|
| — (§4 census-tool bullet) | "The census tool gains the distinction it lacks" | EXECUTED | `scripts/raptor3-refusal-census.mjs` (new, 785 lines on the final tree; 632 when this note was written) replaces the four frozen receipt scripts; TypeScript-parsed extraction, the receipts' matching unchanged against a pinned corpus, three outcomes apart, exits non-zero when it cannot produce the census it describes | An invariant is told from a refusal by CLASS through the one owner, and a private fit by a re-checked reachability claim — neither by message text | `census.md`; F1–F4 below |
| 1 | A recursive shape requires occurrence rows | INTERNAL (untouched) | nothing | inside `decodeValue`'s `shape.kind === "recursive"` guard; the fit's privacy re-checked this run | `census.md` §Internal, anchor `under === "recursive"` |
| 2 | A recursive traversal requires at least one seed | INTERNAL (untouched) | nothing | inside `Queries.recursive` | `census.md` §Internal, anchor `inside recursive` |
| 5 | Invalid provider recursive collection | INTERNAL (untouched) | nothing | inside `decodeRecursive` | `census.md` §Internal |
| 6 | Invalid provider recursive occurrence | INTERNAL (untouched) | nothing | inside `decodeRecursive` | `census.md` §Internal |
| 7 | Invalid provider recursive parent occurrence | INTERNAL (untouched) | nothing | inside `decodeRecursive` | `census.md` §Internal |
| 8 | Invalid provider recursive path | INTERNAL (untouched) | nothing | inside `decodeRecursive` | `census.md` §Internal |
| 9 | Invalid provider recursive row | INTERNAL (untouched) | nothing | inside `decodeRecursive` | `census.md` §Internal |
| 10 | Invalid provider recursive seed | INTERNAL (untouched) | nothing | inside `decodeRecursive` | `census.md` §Internal |
| 19 | Raptor 3 recursive traversal relation '…' is not self-referential | INTERNAL (untouched) | nothing | inside `Queries.recursive` | `census.md` §Internal |
| 20 | Raptor 3 recursive traversal requires one ordinary relation: … | INTERNAL (untouched) | nothing | inside `Queries.recursive` | `census.md` §Internal |
| 52 | The Raptor 3 route cannot encode a cached result for '…': a recursive read's published depth is not a fixed shape. | INTERNAL (untouched) | nothing | `route/client-route.ts`, `case "recursive"` | `census.md` §Internal, anchor `under case "recursive"` |

Rows 3, 4, 11–18, 21–51, 53–55 belong to the other four groups. The census
reports on them but takes no disposition for them: reachability per public row
stays the map's ruling and is not re-derived here.

---

## 3. Hunks

One new file, no edits to anything that existed.

| file | hunk | lines |
|---|---|---|
| `scripts/raptor3-refusal-census.mjs` | whole file, new | +785 on the final tree (+632 when this note was written) |
| `docs/architecture/raptor3-evidence/g4/release/n4/census.md` | whole file, new (tool output; regenerate with `node scripts/raptor3-refusal-census.mjs --out docs/architecture/raptor3-evidence/g4/release/n4/census.md`) | +238 |
| `docs/architecture/raptor3-evidence/g4/release/n4/note-A5.md` | whole file, new | this note |

Shape of the tool, in order: the pinned constants and the private-fit table ·
the CLI and the source reader (working tree, or a revision through
`git ls-tree`/`git show`) · extraction (`renderSentences`, `messageArgument`,
`fitAnchor`, `invariantBindings`, `collectSites`) · the receipts' matching ·
the fit check · classification · the report.

Two deliberate readings, both inherited from the receipts so the map's rows
still line up:

- **The message argument.** These error classes spell `(kind, reason)` as often
  as `(message)`; the first census recorded the *reason*
  (`InvalidScalarResult("enum", "a list scalar did not return an array")` →
  `a list scalar did not return an array`). The rule here is "a kind is one
  word, a sentence is a phrase" — the first argument that spells a phrase.
- **A conditional message spells both sentences.** One site, two contracts:
  `InvalidScalarResult(leaf.type, leaf.list ? "a required list is null" : "a
  required scalar is null")` is two rows in the census, as it is two rows in
  `refusals.json`. A conditional *inside* a `${…}` stays part of the one
  sentence around it, exactly as the receipts recorded it.

Biome: `npx biome check scripts/raptor3-refusal-census.mjs` — **clean** (three
diagnostics on the first draft, `useTopLevelRegex`,
`useSimplifiedLogicExpression` and `format`, all fixed by hand; no formatter was
run on any file). The two documents are new, so they had no prior `format`
diagnostic to preserve.

Runtime: **0.5 s** on the working tree, **6 s** with `--at <rev>` (one
`git show` per source file). No network. Well inside the one-minute budget.

---

## 4. Falsification record

Every pin falsified at the base. No file was ever restored with
`git checkout`; the one mutation below was reverted from a scratch copy
(`/private/tmp/viborm-n4-A5-tmp/census-backup.mjs`), byte-compared after.

**F1 — the extraction and the matching reproduce the first census, minus the
fragments a parser cannot produce.** At the map's own revision:

```
node scripts/raptor3-refusal-census.mjs --at 464705acc --out <out>
→ 48 public + 11 internal = 59 sentences; 0 invariant; 64 registered; 192 sites
```

`unmatched.json` has 59 entries. The two sets differ by exactly:

- **−4** `s grant names the caller` · `s own — a nested locate names the nested
  record, …` · `s published result, live or packaged. …` ·
  `updateHasRelations ? … : undefined` — the four the map had to skip by hand.
  The parser cannot emit them.
- **−2 / +3** `Invalid provider collection`, `Invalid provider row` (map rows #4,
  #11) → `a requested relation is not a provider array`, `a requested document
  is not a provider row`, `a document the statement always builds is null`: the
  same three sites, reworded in the tree since the receipts froze.
- **+3** `INSERT … ON CONFLICT did not produce the required record`,
  `Driver '…' reported … inserted rows …`, `Raptor 3 variant integrity requires
  junction storage` — added to the candidate after the freeze; no map row.

Had the tool merely re-run the old scripts, the four fragments would still be
there. Had it changed the matching, the 59↔59 correspondence would not hold.

**F2 — the INVARIANT class is not vacuous, and the tool is not reading
messages.** The base has no invariant owner at all (`shared/invariant.ts` is
untracked at `bf7ac30b4`):

```
node scripts/raptor3-refusal-census.mjs --at bf7ac30b4 → 46 public, 0 invariant, 11 internal
node scripts/raptor3-refusal-census.mjs             → 22 public, 18 invariant, 11 internal
```

The sentences that moved are word-for-word the same in both trees
(`Raptor 3 filter operator is not implemented: …` and its siblings): only the
class changed. A census that classified by wording would report the same
numbers twice. It does not.

**F3 — INTERNAL is a checked claim, not an exemption list.** The fit's evidence
needle was temporarily widened to `"recursive"` — a string the tree does contain
outside `query.ts`:

```
→ 0 internal (was 11); those 11 sentences reported as public instead;
  a banner naming the 16 contradicting files; exit 1
```

Restored from the scratch backup and byte-compared. The 11 sentences are
internal *because the grep says so today*, and they stop being internal the day
a public caller appears.

**F4 — the corpus pin is load-bearing, and a census that cannot be produced
fails loudly.**

```
--shipped-rev bf7ac30b4  → 83 public, 8 registered   (the shipped owners are retired there)
--shipped-rev deadbeef   → banner "the shipped corpus could not be read", 0 registered, exit 1
default (0cc61e61f)      → 22 public, 64 registered, exit 0
```

**Falsified, but negatively: the tool is not covered by the estate typecheck.**
`tsconfig.json` sets `allowJs: false`, so `scripts/**.mjs` is unchecked — true
of every script in `scripts/`. Its correctness rests on the runs above, which
between them exercise the working-tree reader, the revision reader, a tree with
no invariant owner, a held fit, a contradicted fit, a readable corpus and an
unreadable one.

---

## 5. Still red

`node scripts/run-typecheck.mjs` — **5 errors at 07:53, none in A5's files, all
from another group's in-progress edit.** Not fixed, per the brief. (The count
grew from 3 at 07:46 as a third new cell landed; the estate is moving.)

| error | file | whose |
|---|---|---|
| `TS2322: Type '"atomic-array"' is not assignable to type '"borrowed-transaction" \| "standalone"'` | `tests/raptor3/ownership/commands.test.ts:376` (file itself unmodified) | the group that deleted the `"atomic-array"` binding variant (map row #31, DELETE) in `src/query-engine/raptor3/shared/operation-context.ts`. The test names the variant the deletion removed and has to be re-expressed with the ruling named — never weakened |
| `TS2769` ×2, `PendingOperation` awaited where a `Promise` is expected | `tests/raptor3/g4/parity/batch-captured-bulk.test.ts:126,145` (untracked, new) | the group writing the map row #25 capability-execution cell |
| `TS2769` ×2, same shape | `tests/raptor3/g4/parity/postgres-declared-type-scratch.test.ts:144,158` (untracked, new) | the group writing the map row #16 / D-50 declared-type scratch cell |

No other diagnostic. The two historical Pattern `TS2345` errors named in the
common brief are gone with the pattern retirement; the estate is otherwise
clean.

No test was deleted, skipped or weakened by A5. A5 wrote no test: this unit's
pin is the census report itself (plan §4: "Its output is the census's pin"), and
the report is regenerable from the tree in half a second.

---

## 6. Unverified

1. **Per-row reachability is the map's, not the census's.** For a public
   refusal the tool reports only "nothing in the tree forecloses it". Which
   admitted payload reaches each one stays `refusals-map.md`'s ruling. The two
   foreclosures the tool *does* establish — the invariant owner and a verified
   private fit — are the only reachability claims it makes.
2. **The corpus revision is justified by reproduction, not by identity.** The
   receipts name their tree by a content fingerprint
   (`e2d5bcb2…`), not a commit, and I could not locate a commit whose
   `query.ts` matches their line numbers. `0cc61e61f` is justified because
   replaying the receipts' matching there over the frozen `refusals.json`
   reproduces **63** — the number the census's own task brief stated — and
   because `newness.mjs` already used that revision. I cannot claim the shipped
   half is byte-identical to theirs.
3. **The counts move under the other four groups.** Base and final are both in
   §1; the integrator's run after all groups finish is the one that counts. The
   report stamps `HEAD` and the number of dirty engine files, nothing more.
4. **One fit is declared.** `PRIVATE_FITS` has a single entry because D-54 is
   the only private mechanism the map found. If another exists, the census calls
   its sentences public — the conservative direction.
5. **The 66 sentence-less sites** (rethrows of a value another owner built:
   `ctx.failure`, `refusal`, `error`) are listed but unclassified. They carry no
   sentence of their own, so they are neither a refusal nor an invariant here;
   whether each rethrow preserves its origin's class is N3's question, not this
   census's.
6. Roughly a third of the tool's lines are the report's prose and the header
   that states its rules. That is deliberate — the report is the deliverable —
   but it is not a small script.

---

## 7. LOC

| | lines |
|---|---|
| `scripts/raptor3-refusal-census.mjs` (new) | 785 on the final tree (632 when this note was written) |
| production source changed by A5 | **0** |
| tests changed or added by A5 | **0** |
| `census.md` (generated) | 238 |

`scripts/` is outside the measured directory of
`node scripts/query-engine-structure.mjs` (which measures
`src/query-engine`), so the census tool adds **nothing** to the engine's
charged core LOC, parser tokens or bytes. It replaces the four frozen receipt
scripts (145 lines across `extract-throws.mjs`, `refusals2.mjs`,
`newness.mjs`, `classify.mjs`), which stay where they are as receipts of the
first census and are not re-run: they hard-code absolute paths into
`/Users/arnaud/code/viborm` and a scratchpad, and they match against a corpus
the tree no longer has.

## Integrator's addendum (after the Opus review)

F4's numbers and the "final run" column of §1 were measured on an intermediate
tree. Two blindnesses the review found were both in `collectSites`'s reading of
a throw: a sentence built by a local factory (`const changed = () => new
TransactionError(…)`, #24 / #36) and one built by a METHOD of the throw's own
class (`suppressionRefusal()`, G3P-04's `Raptor 3 borrowed createMany
skipDuplicates requires an operation-owned member rollback region.` — public,
candidate-only, contracted by three committed files) were counted as rethrows.
The tool now follows a call to a local factory, a function of the file or a
method of the throw's own class to the constructions its body returns, a
`const` bound to one of those, either arm of a conditional
(`constructionsOf`), and — after the third round — a message argument that is
a named constant or a `??` fallback (`CURSOR_ORDER_REFUSAL`,
`DISTANCE_NAME_COLLISION`, the GeoPoint fallback: five sites, three registered
sentences); the "Sites without a sentence" prose states what it still cannot
read (a rethrow of a value another owner built; a property access such as
`this.incompletePreparation`; a value assigned after its declaration; a message
computed at the site), and the binding walk stops at a parameter or catch
clause that shadows an outer name.
On the final tree the tool reads **23 public / 21 invariant / 11 internal / 71
registered / 188 sites**; the base `bf7ac30b4` reads **47 public / 0 / 11 /
71 / 189** (this note's 46 had G3P-04's sentence hidden); `--shipped-rev
bf7ac30b4` reads **85 public, 9 registered** (§1(b)'s 83 was the receipts'
reading; the two more are the named constants).
