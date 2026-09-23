# RQ-01 — the recursive decoder's four confirmed defects, repaired

Unit `rq-decoder`, 2026-09-22. Scope: the four production defects recorded in
[handoff-2026-09-22.md](handoff-2026-09-22.md) § "Confirmed production defects",
and nothing else. This is a repair record, not an RQ-01 acceptance verdict:
the expanded PGlite/native placement matrix, the 900-case campaign and the
independent review are still owed by their own owners.

**2026-09-23 — read with `rq07-review-followups.md` P2**, which changed this
unit's walk. The levelled walk now answers a third question: a bounded hop
below the cutoff must carry the parent's one set of children at the next
level (`Invalid provider recursive depth`), so three refusals fall out of it,
not the two "The hunk" names. `carrier-boundary.test.ts` is **13** cells. The
wrong-level carrier (`root→child@2`, `child→grandchild@1`) is now answered by
that hop check at the root's hop, so round A's falsification below stopped
holding with it: deleting the consumed-facts guard left that carrier refused.
The guard's unique witness is now the carrier `root→P@1`, `P→C@2`, `P→C@3` at
depth 3 in the same cell, which turns the cell red when the guard is deleted
(`rq07-review-followups.md`, "Final repair round"). The second "Left
unverified" item ("Whether the provider states *every* edge fact…") is partly
superseded: a bounded carrier that transports a
hop's children at one level its parent is reached below the cutoff but not at
another is refused; a fact omitted at every level, and any omission on an
exhaustive carrier, is still decoded from the successors it did transport.

## Identity of what was executed

| Fact | Recorded value |
| --- | --- |
| Repository / branch / HEAD | `/Users/arnaud/code/viborm`, `pattern-engine`, `076fad02b1c77435ce7389a51996163c66aad819` (uncommitted tree preserved) |
| Runtime | `/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin/node`, Node `24.21.0`, Darwin arm64 |
| Dependency identity | `pnpm-lock.yaml` SHA-256 `c366c9806e268e19970626c34e0c5ea1bb74cc7c24b388fa072d580d7bf9aceb` (unchanged) |
| Files owned and changed | `src/query-engine/raptor3/shared/query.ts` SHA-256 `7ba81f05fd890eb8aab20a181f2c8da132a8136182cc5b3dd14daf857581c1cb`; `tests/raptor3/recursive-query/carrier-boundary.test.ts` SHA-256 `5b680217244d6eb69cb585a7d10c9cc4736d9f73a5caf68f195dab67b6f78605` (post-repair-round bytes; the first round's, superseded, were `1f226ed7…` and `2cdaa2f1…`) |
| Harness | `scripts/run-vitest-safe.mjs`, Vitest `3.1.4`, `--heap-limit-mb=768 --rss-limit-mb=1536 --wall-limit-ms=120000`; `scripts/run-typecheck.mjs` |
| Recorded red baseline | 11 carrier cells: 8 pass, 3 fail (below) |

No other file was edited. `scripts/raptor3-manifest.mjs` was read, not written:
its cell-count change is reported at the end for its owner.

## Defect 1 — the first hop escaped the cycle policy

**Red witness.** `carrier-boundary.test.ts` › *applies cycle policy to a direct
root self-loop*, before the repair:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
+ [ { id: 'root', links: [], mutable: {} } ]
- []
  at carrier-boundary.test.ts:277
```

**The fact and its owner.** *Which identities are on the path this occurrence
descends from* — owned by `Queries.decodeRecursiveCarrier`. The outer loop
built each root child's frame with `new Set([rootKey, child])` and only the
inner loop consulted a path, so the root→child edge itself was never offered to
the policy: a root self-loop was published under `prevent` and raised nothing
under `reject`/FK, while every later hop was admitted correctly.

**The hunk.** One active path is seeded with the root before any edge is
followed, and one `follow(from, key)` performs the admission — the cycle
answer, then the push — for the first hop and for every later one. The root
loop calls `follow(0, child)`; the inner loop calls
`follow(current.depth, nextKey)`.

**What was deleted.** The per-frame `path` field and the `new Set([rootKey,
child])` seeding; the inline cycle test inside the descend branch; the second
(implicit) rule under which a first hop needed no admission at all.

**Second placement.** The same cell now also drives the third policy: with
`cycles: "allow"` and `depth: 2` the same root self-loop is *not* pruned by the
seeding — it unfolds one repeated occurrence and the cut-off occurrence omits
its repeated slot. The real-SQL placement (`provider-sql-sqlite.test.ts`, whose
junction case contains a cycle) is unchanged by the repair: 2/2 before and
2/2 after, verified by restoring the pre-repair copy of `query.ts`.

**After.** Cell green: `prevent` answers `[]`, `reject` raises
`Recursive relation 'children' contains a cycle.`, `allow` unfolds to the
cutoff.

## Defect 2 — the recorded edge depth was parsed and then ignored

**Red witness.** `carrier-boundary.test.ts` › *rejects bounded edge facts
attributed to the wrong traversal level*, before the repair:

```
AssertionError [ERR_ASSERTION]: Missing expected exception.
  at carrier-boundary.test.ts:301
```

(the carrier with root→child at depth 2 and child→grandchild at depth 1 decoded
successfully).

**The fact and its owner.** *The level at which a transported edge was
discovered* — stated by the provider in `__rq_depth` and owned, at the result
boundary, by `decodeRecursiveCarrier`. The value was range-checked and stored
on the edge entry, and then nothing ever read it, so any attribution passed.

**The hunk.** The decoder's existing reachability walk became the one walk that
consumes both facts: it carries a level, the root is reached at level 0, and a
bounded edge is consumable only one level below its own recorded depth. Its
visited unit is `"<depth> <identity>"` for a bounded carrier and the identity
alone for an exhaustive one — which is what keeps a legal cyclic junction
carrier finite. Two refusals fall out of that single walk: an edge no level can
consume (`Invalid provider recursive depth`) and an identity no consumed edge
reaches (`Invalid provider unreachable recursive node`, the pre-existing
sentence).

**What was deleted.** The key-only `reachable` set and its `pending` list; the
per-frame re-dedup inside `children()`, whose distinct-successor answer and
singular-cardinality refusal now belong to one pass over the complete edge
index (`successors`), beside the endpoint check that was already there. No
depth is re-derived per frame: the traversal keeps counting its own hops.

**Second placement.** The same cell now also *accepts* the shape this refusal
resembles: `near` reached at level 1 from the root and at level 2 through
`far`, so its own edge is transported at both levels, the deeper occurrence
stops at the cutoff, and every transported fact is consumed. Falsified by
mutation: collapsing the visited unit to the identity alone (i.e. treating one
identity as reachable at one level only) makes that legitimate carrier raise
`Invalid provider recursive depth` — the exact over-refusal the constraint
forbids.

**After.** Cell green; the wrong-level carrier raises
`Invalid provider recursive depth`, the multi-level carrier decodes.

## Defect 3 — a cyclic JavaScript JSON leaf escaped as a stack overflow

**Red witness.** `carrier-boundary.test.ts` › *rejects sparse node and edge
containers and a cyclic JavaScript carrier*, before the repair:

```
AssertionError [ERR_ASSERTION]: The input did not match the regular
expression /Invalid provider json/. Input:
'RangeError: Maximum call stack size exceeded'
  at carrier-boundary.test.ts:333
```

**The fact and its owner.** *Whether a value is in the JSON domain* — owned by
`Queries.jsonValue`, the result boundary that already answers for non-finite
numbers, unsafe integers, sparse arrays and exotic prototypes. A JavaScript
carrier can hand it a container that contains itself, which provider text never
can, and it recursed into a `RangeError` instead of answering.

**The hunk.** `jsonValue` takes the containers it is being normalized inside;
`enterJsonContainer` is the one entry rule for both container arms — already
open means inside itself, which is `InvalidScalarResult("json", "a JSON value
contains itself")` — and each arm leaves its container after its members.

**What was deleted.** Nothing was deleted; this is a boundary that did not
answer for one of its own inputs. No recursion-specific JSON parser, no second
codec and no downstream validation framework was added: one existing boundary
gained one more sentence in its existing failure class.

**Second placement.** The same cell now also refuses a cyclic *array* leaf (the
other container arm; falsified by mutation — with the array arm's entry removed
it is a `RangeError` again). The *diamond* cell proves the other side: one JSON
object repeated twice in one document is not a cycle, both members normalize,
and they are distinct public objects. The ordinary codec pins stay green
(below), so what valid JSON decodes to is unchanged.

**After.** Cell green for both the cyclic record and the cyclic array.

## Defect 4 — ancestor prefix copying (confirmed by source, no red cell)

**The fact and its owner.** The same active path as defect 1. Every descended
frame did `const nextPath = new Set(current.path)`, so a chain held its whole
ancestry once per hop.

**The hunk.** One `active` path, entered by `follow` and left when a frame
pops. It is a `Map<identity, count>` so that the path stays a faithful image of
the stack under `cycles: "allow"`, the one policy under which one identity sits
on the stack twice. **No cell can tell that map from a plain `Set<string>`**,
and none is claimed to: the path is read to decide anything only under `reject`
and `prevent`, and there a key is pushed only when it is absent, so its count
never exceeds one. The `cutoff` rule now takes a depth, so the frame builder and
the leave step read one expression instead of two, and `collapse` states the
cardinality/emptiness rule once for a frame's slot and for the carrier's answer.

**What was deleted.** The per-frame `path` set and its per-hop copy; the
duplicated cutoff expression; the duplicated collapse expression at the return.

**Second placement.** One new cell — *decodes a synthetic chain far beyond a
copied ancestry* — decodes a 12,000-level exhaustive chain under the ordinary
ceilings. The existing 1,101-level cell stays: it pins the public depth
ceiling, which is a different fact. Bounded unfolding of a repeated key is
preserved by the `cycles: "allow"` placement in defect 1's cell, path-local
prevention across sibling branches and fresh diamond occurrences by the
existing diamond cell.

**Measured.** Same cell, same harness, one sample each, vitest-reported cell
time: the 1,101-level chain took **108 ms** with the copied ancestry and
**19 ms** with the active path. The new 12,000-level cell takes **65 ms**, and
the whole 12-cell file peaks at **409.4 MiB** sampled process-group RSS against
the 1,536 MiB ceiling (the 12,000-level cell alone: 425.0 MiB).

**Not measured.** The 12,000-level chain was never run against the quadratic
version, so no factor is claimed at that depth. No allocation, bundle or
end-to-end query measurement was taken; these numbers are one wall-clock sample
per configuration on a loaded machine, and the carrier construction inside the
test (identical in both runs) is included in them.

## Runs

| File(s) | Result |
| --- | --- |
| `carrier-boundary.test.ts` (before) | 11 cells: **8 pass, 3 fail** (defects 1, 2, 3) |
| `carrier-boundary.test.ts` (after defect 3) | 11 cells: 9 pass, 2 fail |
| `carrier-boundary.test.ts` (after defect 2) | 11 cells: 10 pass, 1 fail |
| `carrier-boundary.test.ts` (after defects 1+4) | 11 cells: **11 pass** |
| `carrier-boundary.test.ts` (final, with the new cell) | 12 cells: **12 pass**, 409.4 MiB peak |
| `provider-sql-sqlite.test.ts` + `graph-oracle.test.ts` | **11 pass** (2 + 9) |
| `provider-sql-sqlite.test.ts` on the PRE-repair `query.ts` | **2 pass** — the real-SQL matrix was already green before this unit and is unchanged by it |
| `carrier-boundary.test.ts` + `provider-sql-sqlite.test.ts` + `graph-oracle.test.ts` (final source) | **23 pass**, 460.1 MiB peak, 12.66 s wall |
| `g4/review/unit01-followup2/json-sentinel.test.ts` + `unit01-followup3/json-sentinel-sweep.test.ts` | **12 pass** — the ordinary JSON read path |
| `g4/read-codecs.test.ts` + `g4/unit01/codec-roundtrip.test.ts` | **17 pass** — the ordinary codec pins |
| `node scripts/run-typecheck.mjs` | **zero diagnostics**, whole estate, native, 71.46 s, 3,945.9 MiB peak (ceiling 8,192 MiB) — re-taken in the repair round on the frozen bytes above (their SHA-256 verified identical immediately before and after the run); see that section for what the receipt does and does not attest. The first round's 17.65 s run predated the last falsification restore and is withdrawn. |

Two falsifying mutations were run under `-t` filters and then reverted by
restoring the saved copy (never `git checkout`): the collapsed visited unit
(defect 2's accepted placement goes red) and the array arm without its
container entry (defect 3's array placement goes red). The final working copy's
SHA-256 was re-verified after each restore.

`tests/raptor3/g4/parity/json-read-schema.test.ts` was **not** run: it is
registered in no manifest lane, so no project includes it. That is a
pre-existing registration gap, not this unit's to fix.

## Cost

| Measure | Before | After |
| --- | --- | --- |
| `query.ts` physical lines | 5,302 | 5,364 |
| `query.ts` code-bearing lines (no blanks or comment-only lines) | 4,365 | 4,373 |
| `carrier-boundary.test.ts` physical lines | 469 | 583 |

The production change is **+8 code-bearing lines**; the remaining +54 physical
lines are the doc comments that state the three rules (one successor answer,
one levelled walk, one active path) and the JSON boundary's new sentence.

## For the manifest owner

`scripts/raptor3-manifest.mjs`, `RQ06_CARRIER_BOUNDARY_COUNTS`:
`tests/raptor3/recursive-query/carrier-boundary.test.ts` is now **12** cells,
declared as 11. No other declared count changed. No gate currently reads this
constant, so nothing is red today; the declaration is simply stale.

## Left unverified by this unit

- PGlite, native PostgreSQL and native MySQL placements (the integrator owns
  those lanes; only SQLite was executed here).
- Whether the provider states *every* edge fact a complete traversal needs. The
  boundary can only prove that every transported fact is consumable at a level
  its parent occupies; a carrier that omits a fact its own graph implies is
  still decoded from the successors it did transport.
- Everything outside these four defects: the expanded fixture's mutation
  assertions, the 900-case campaign, RQ-02/03/04/05 and the independent review.

## Repair round — 2026-09-22 (post-review)

Three review findings against the first round, all minor, all applied. Nothing
else in the decoder changed: no new rule, no new cell, no behaviour outside the
one narrowed refusal below.

### A — the consumption guard was unscoped (`query.ts:4663` → `:4667`)

**Red witness.** A new assertion inside the *existing* cell that already owns
the unreachable sentence — `carrier-boundary.test.ts` › *rejects dangling,
unreachable, and duplicate edge facts* — on an exhaustive carrier whose second
edge hangs off a parent nothing reaches
(`[node("reached"), node("stranded")]`, `[root→reached, stranded→reached]`):

```
AssertionError: The input did not match the regular expression
/Invalid provider unreachable recursive node/. Input:
'TypeError: Invalid provider recursive depth'
  at carrier-boundary.test.ts:232:12
```

**The fact and its owner.** *Whether a transported edge was attributed to a
level it was not discovered at* — a fact only a carrier that states depths can
carry. The guard asked it of every carrier, so on an exhaustive one — where
`__rq_depth` is refused outright at `:4589` — it had no fact to answer and
simply answered first, taking the diagnosis away from the unreachable-node
guard behind it.

**The hunk.** One condition: `if (shape.recurrence.depth !== false &&
consumed.size !== facts.size)`. The walk's doc comment now says which of its two
questions each carrier is asked.

**What was deleted.** The guard's claim over exhaustive carriers, where it had
no unique coverage: with no depth filter an unconsumed edge means its parent was
never reached, that parent is `rootKey` (reached at level 0) or is in `nodes`
(endpoint check at `:4623`), and every child is in `nodes` (`:4582`) — so
`reached.size !== nodes.size` fires on exactly the same carriers.

**Why not the swap.** Ordering the unreachable check first would have covered
the same carrier, but the pinned bounded witness
(`carrier-boundary.test.ts:316`, `root→child@2` + `child→grandchild@1`) reaches
no node at all, so it would then report an unreachable node for a carrier whose
defect is a misattributed depth. The scope is the discriminating fix; the order
is not.

**Falsified.** The scoped guard still carries unique coverage on bounded
carriers: deleting it outright (backup copy, restored by `cp`; SHA-256
re-verified at `7ba81f05…`) turns *rejects bounded edge facts attributed to the
wrong traversal level* red.

**After.** 12 cells, 12 pass. The cell count is unchanged — the witness is one
more assertion in the cell that already owns that sentence, not a new cell.

### B — the multiset justification was unwitnessed

The `Map<identity, count>` is kept: it is the honest image of the stack, and a
plain set would leave state behind that the stack no longer holds. What was
wrong was the *reason given*. The first round's comment (`query.ts:4708`-`4714`)
and this note (defect 4, "The hunk") claimed a plain `Set<string>` "could not
describe that path", which no cell can show and no policy can observe: `active`
decides something only on the `reject` and `prevent` arms of `follow`, and there
a key is pushed only when it is absent, so its count never exceeds one. A count
above one arises only under `cycles: "allow"` — the one policy under which the
map is never consulted. Both places now say that, and say that no cell can tell
the two apart, so no reader goes looking for a witness that cannot exist.

Comment and prose only: no code, no cell, and no recorded expectation changed.
(The enter/leave discipline itself stays witnessed — the first round recorded
that removing the leave turns prevention into global deduplication and reddens
the diamond and multi-level cells.)

### C — the typecheck receipt did not attest the frozen source

The first round's typecheck (22:47:59, 17.65 s) was taken before the last
falsification restore of `query.ts`, so it did not attest the bytes whose
SHA-256 the identity table records. That receipt is withdrawn and replaced by a
single run taken here on the final bytes.

### Runs (this round)

| Command | Result |
| --- | --- |
| `carrier-boundary.test.ts -t "rejects dangling, unreachable, and duplicate edge facts"` (before A) | **1 fail** — the red witness above |
| `carrier-boundary.test.ts` (after A) | 12 cells, **12 pass**, 275.8 MiB peak |
| `carrier-boundary.test.ts -t "…wrong traversal level"` with the guard deleted (falsification, restored) | **1 fail**, as required |
| `provider-sql-sqlite.test.ts` + `graph-oracle.test.ts` | **11 pass** (2 + 9), 398.5 MiB peak |
| `node scripts/run-typecheck.mjs` (once, on the frozen bytes) | **zero diagnostics**, whole estate, native, 71.46 s, 3,945.9 MiB peak (ceiling 8,192 MiB) |

The typecheck ran between two `shasum -a 256` readings of both owned files that
were identical (`7ba81f05…`, `5b680217…`), so it attests exactly the bytes the
identity table records. It emitted its resource line and nothing else; the
runner's exit code mirrors `tsc --noEmit`, which is non-zero only when it prints
diagnostics. The status was not separately captured — the one permitted run was
piped through `tail` — so this receipt attests *zero diagnostics on the frozen
bytes*, which is the fact, rather than an observed exit code.

Wall-clock numbers this round are ~2–4× the first round's on the same machine
under a heavier load; they are a runtime receipt, not a measurement, and defect
4's timing claims were **not** re-taken.

### Cost and manifest, after this round

| Measure | First round | After the repair round |
| --- | --- | --- |
| `query.ts` physical lines | 5,364 | 5,370 |
| `query.ts` code-bearing lines | 4,373 | 4,373 |
| `carrier-boundary.test.ts` physical lines | 583 | 598 |

The production delta is **zero code-bearing lines** (the guard gained a
condition on the line it already occupied); the +6 physical lines are the two
corrected doc comments.

**For the manifest owner: unchanged.** `RQ06_CARRIER_BOUNDARY_COUNTS` still
needs `tests/raptor3/recursive-query/carrier-boundary.test.ts` at **12** cells,
declared as 11. This round added an assertion, not a cell.

### Still unverified after this round

Everything the first round left unverified stands, plus: the narrowed refusal
was exercised only through the carrier boundary — no provider is known to emit
an exhaustive carrier with a stranded parent, so the sentence a real provider
would see for that shape is pinned by the unit test alone.
