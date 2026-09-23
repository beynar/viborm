# RQ-05 — the live recursive cache codec and its cache/extension lifecycle (unit `rq-cache`)

Unit `rq-cache`, 2026-09-22/23. Scope: RQ-05's "live recursive cache codec"
and "default/query/model omit, canonical cache defaults, lifecycle bypasses and
unchanged extension restrictions" items, §3.4 (cache), and §5's "Cache" and
"Execution placement" rows of [recursive-query.md](../../../../features-docs/recursive-query.md);
the bounded design is the handoff's "Remaining consumer design already
inspected → Live cache". This is a unit record, not a qualification verdict:
the independent review, the integrated native lanes and RQ-07 are owed by their
owners.

## Identity of what was executed

| Fact | Recorded value |
| --- | --- |
| Repository / branch / HEAD | `/Users/arnaud/code/viborm`, `pattern-engine`, `076fad02b1c77435ce7389a51996163c66aad819` (uncommitted tree preserved; nothing staged or committed) |
| Runtime | `/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin/node`, Node `24.21.0`, Darwin arm64; `TMPDIR=/private/tmp/viborm-rq-cache-tmp` |
| Dependency identity | `pnpm-lock.yaml` unchanged (SHA-256 `c366c980…aceb`) |
| Owned production, final bytes | `src/query-engine/raptor3/route/client-route.ts` `49deb8d150988a6d880ba103d75a18e5050974244ef4d06e8a6d8c2a8933731f` (HEAD `d70f4631…07fd`); `src/query-engine/result/cache-value-codecs.ts` `324d612cf27b2926d683efb21eac549a9635202ad6e048099d6f6484476c3484` (HEAD `5aef8e7f…876a`) |
| Owned witnesses, final bytes (new, untracked) | `tests/raptor3/recursive-query/cache-codec.test.ts` `b882822ff1a048bcf924c1c2eb325235e9ebf7eb0a0593ee57a2f9b4ba7d9fd8` (10 cells); `tests/raptor3/recursive-query/cache-lifecycle.test.ts` `1eaa0a2be2c0cbb7d853fcfeb852353e340d7dcb7b75924af03452b1519fb3ed` (7 cells) — the repair round's bytes; the first round's `fddc3b7f…` (9 cells) and `69585a11…` (6 cells) are recorded in the Repair round section |
| Harness | `scripts/run-vitest-safe.mjs` (Vitest `3.1.4`, `--heap-limit-mb=768 --rss-limit-mb=1536 --wall-limit-ms=120000`), `scripts/run-typecheck.mjs` |
| Baseline copies (falsification / red runs) | `cp` of both HEAD sources to `$TMPDIR/backup-baseline/`; every restore by `cp` from `$TMPDIR/final/`, digest re-verified after each run. Repair round: out-of-tree copies served by a Vite redirect, working files untouched (Repair round section) |

**Pre-registration harness.** The two new files are in no manifest yet (the
integrator owns `scripts/raptor3-manifest.mjs`), so they were run through a
scratch workspace `$TMPDIR/rq-cache.workspace.mjs` — one inline project that
`extends` the repository's own `vitest.config.ts` and includes exactly these two
files — still through `run-vitest-safe.mjs` and the shared workspace lock.
Refused lock attempts were retried after 20 s (`$TMPDIR/run-when-free.sh`); no
lock file was touched.

**Concurrency caveat.** The rq-types and rq-34 authors edited
`validation/relations/*`, `query-engine/types.ts`, `client/typescript-type-renderer.ts`
and `raptor3/shared/query.ts` during this unit. Three falsification runs taken
at 00:05–00:06 met their transient admission state (`recurrenceSchema` had
changed arity before its caller, so most cells failed with "Schema validation
failed unexpectedly"); those runs are **void** and were repeated at 00:07 on a
tree whose green re-check passed (below). Every result here is therefore bound
to MY bytes above and to the other units' bytes of the moment, not to a frozen
integrated identity.

## Change 1 — the route's recursive arm composes the structural codec

**Red witness (before).** Baseline production, final test bytes
(`$TMPDIR/red-final-2.log`): **14 of 15 fail**. The 13 route-level cells stop at

```
UnsupportedOperationError: The Raptor 3 route cannot encode a cached result for
'findMany': a recursive read's published depth is not a fixed shape.
```

— including every cached read through the shipped client — and the owner cell
at `(0 , recursiveRelationCodec) is not a function`. The one pass is the bypass
control, which never builds a codec (by design; see its cell). The first
authoring round recorded the same refusal on its earlier test bytes
(`red-codec-1.log` 9/9 fail; `red-lifecycle-1.log` 5/6 fail, bypass passing).
Cells 3 and 4 of that first run passed their hand-written expectations of the
decoder's value before reaching the refusal, so the fixture itself was sound.

**The fact and its owner.** *Which value codec describes a published recursive
slot* — owned by `shapeCodec` in `raptor3/route/client-route.ts`, the live
cache path (`cacheResultCodec → cacheCodec → shapeCodec`), which already
composes every other published shape from the official owners in
`result/cache-value-codecs.ts`.

**The hunk.** The `case "recursive"` arm returns
`recursiveRelationCodec({ relation, many, optional, depth: recurrence.depth },
shapeCodec(shape.row, requestedOperation))`, plus one import. It reads only the
prepared slot's own facts — asking relation, cardinality, singular emptiness,
normalized depth — and the ORDINARY node codec composed through `shapeCodec`
(so a second recursive slot inside the node is ordinary composition over the
finite projection). It reads neither `identity`, nor `carriers`, nor
`recurrence.cycles`: the decoder already applied them.

**What was deleted.** The refusal arm: `throw new UnsupportedOperationError(…
"a recursive read's published depth is not a fixed shape.")` and its four-line
justification. `UnsupportedOperationError` stays imported for the kept
no-prepared-read vocabulary boundary in `cacheResultCodec()`.

**Second placement.** The same arm is reached (a) directly through the route's
codec (`cache-codec.test.ts`), (b) through the official cache on the shipped
client (`cache-lifecycle.test.ts`, every cached cell), (c) under a single-row
verb whose own absence is wrapped by `nullableCodec` (`findUnique`, singular
cell), (d) nested inside another recursive node's row (the `links` slot inside
`children`, rich cell), and (e) on projections rewritten by client default omit
(omit cell).

**After.** First-round final bytes, `green-final.log`: **15/15**, 3.48 s wall,
587.4 MiB peak (ceiling 1,536). Production has not changed since; the repair
round's two cells are recorded in the Repair round section.

## Change 2 — one iterative structural codec for a recursive slot

**Red witness (before).** The owner cell (`refuses with its own failure class,
never a stack overflow (owner)`) fails with `recursiveRelationCodec is not a
function`; every route cell fails at Change 1's refusal (above).

**The facts and their owner.** All in `recursiveRelationCodec` /
`walkRecursiveSlot` (`result/cache-value-codecs.ts`), the official structural
owner beside `recordCodec`/`arrayCodec`/`nullableCodec`:

1. *Where the repeated key must exist.* The slot's occurrences are level 1; an
   occurrence at level `L` carries the asking key exactly when
   `depth === false || L < depth` — ABSENT at the numeric cutoff, PRESENT on
   every occurrence of an exhaustive read (`[]` or `null` at a natural end).
   The snapshot states the same fact as a tuple — `[node]` at the cutoff,
   `[node, slot]` before it — and both directions hold their input to it.
2. *The node is the ordinary row.* Snapshot separates the asking key from the
   occurrence's own entries and hands the rest to the ordinary node codec, whose
   exact-key checks stay in force; materialization defines the key back onto the
   fresh record that codec returns.
3. *Data depth is iterated, never recursed.* One explicit-stack walker serves
   both directions (`RecursiveDirection` = read + write); an occurrence joins the
   SAME `active` set every ordinary codec uses when it is reached and leaves it
   once it is written — at the cutoff (`:351`) or when its own slot completes
   (`:363`). The enter refuses a cyclic value or snapshot at its first re-entry.
   The leave covers exactly one behavior, **aliasing**: one object — an
   occurrence, or a stored tuple — reached at two places that do not nest is
   accepted and restored as separate objects, as `withSnapshotObject` accepts
   an alias; a walker that never leaves (a global visited set) refuses it as a
   cycle. Its witness is the aliasing cell (codec witness 8, repair round).
4. *Singular emptiness is the prepared fact.* A singular slot is one occurrence,
   or `null` only when the prepared slot is `optional`.

**The hunk.** +172 physical lines in `cache-value-codecs.ts`: the exported
`RecursiveRelationSlot` facts and `recursiveRelationCodec`, the private
`RecursiveDirection`, `RecursiveFrame`, `walkRecursiveSlot`, and
`enterSnapshotObject` — `withSnapshotObject`'s rule in the enter-now /
leave-later form an explicit stack can hold (a callback scope cannot span it).
No other codec changed.

**What was deleted.** No deletion: this is a new consumer of new published
meaning. During authoring, one draft element was removed as redundant — the
walker also entered each *slot container* on the active set; every cycle a slot
can close passes through an occurrence (already entered), and
`readSnapshotArray` already refuses a non-array slot, so container tracking had
no unique coverage and is not in the final bytes.

**Second placement.** The same walker runs in both directions; over collection
slots (`children`, `links`) and singular slots (`parent`); numeric (1, 2, 3, 99,
1,000) and exhaustive depth; FK and junction topologies; graph `prevent`
(diamond: `d` published twice) and `allow` (the root repeated along one path,
r → a → d → r, in the lifecycle keys cell). Those values publish a repeated row
as DISTINCT objects, so they round-trip with or without the leave: they place
the walker, they do not test its path-scoped rule (all 15 first-round cells
pass with the leave removed — the review's falsification L).

**Falsification (each on the final bytes, mutation applied to the working copy,
restored by `cp`, digest `324d612c…` re-verified).** Scripts:
`$TMPDIR/mutations/*.py`, driver `$TMPDIR/falsify.sh`.

| Mutation | Unique coverage it removes | Result (log `falsify-final-<m>.log`) |
| --- | --- | --- |
| F1: the same walker recursed over data depth (both directions) | call-stack independence | 1 fail / 8 pass: the **12,000-level** cell, refused at *snapshot* (a wrapped stack overflow); the 1,000-level cell **passes** |
| F1b: materialization alone recursed | call-stack independence of materialization | 1 fail / 8 pass: the 12,000-level cell, refused at *materialize* |
| F2: exact repeated-key rule removed in both directions | the key PRESENT at the cutoff (value side) | 1 fail / 8 pass: `outcome(snapshot(keyPastCutoff))` = `accepted` (`cache-codec.test.ts:561`) |
| F2b: the width rule removed on materialization only | a tuple widened at the cutoff | 1 fail / 8 pass: `outcome(materialize(widened))` = `accepted` (`:590`) |
| F3: singular `null` accepted regardless of `optional` | a required singular slot's null | 1 fail / 8 pass: owner cell, `required.snapshot(null)` did not throw (`:719`) |
| F4: `enterSnapshotObject` no longer refuses re-entry | termination on a cyclic value | the cyclic cell never terminates: worker **JavaScript heap out of memory**, 15.87 s, 1,073.9 MiB peak |

The same six mutations were first run on the pre-refactor bytes (production
`71912293…`) with the same outcomes (F4 there: 18.90 s, 1,177.7 MiB); those runs
are kept as history. What F2 does **not** remove: a missing key or a narrowed
tuple at a continued level is still refused downstream (`readSnapshotArray` of
`undefined`), so the rule's unique coverage is the absent-at-cutoff side, as the
table says.

F5 — the leave removed — is the repair round's (Repair round section). The
line citations above name the first-round test bytes; the repair round's two
header lines move `:561`, `:590` and `:719` to `:563`, `:592` and `:721`.

**After.** 15/15 (above, first round); the codec-owner, route-vocabulary and
client cache pins unchanged (Runs). Repair round: the aliasing cell is red with
the leave removed and green on the final bytes.

## The witnesses

`cache-codec.test.ts` — 10 cells: eight through the real route codec for a
prepared recursive read (`createCandidateRoute(…).operation(…).cacheResultCodec()`)
on values the real decoder published (executed SQLite reads through the shipped
client, or synthetic provider rows parsed by the same prepared read's
`prepareSingle(…).parseResult`), and two (7, 8) at the structural owner,
composed as `shapeCodec` composes it:

1. a hit is deep-equal to the miss and shares no object with it or another hit
   at any level (scalar, Date, JSON, bytes leaves; ordinary relation and second
   recursive slot inside the node; diamond `d` stays two objects), and the
   stored form survives a JSON round trip;
2. caller mutations of a hit (scalar, Date, bytes, JSON, arrays) and of the miss
   after storage never reach the next hit;
3. depth-2 cutoff key ABSENT at level 2, `children: []` PRESENT at level 1;
   exhaustive key present to `[]` ends — hand-written expectations, before and
   after the round trip;
4. singular `parent` recursion: `null` at the outer slot, `null` at a natural
   end, key absent at a depth-1 cutoff; plus a `findUnique` round trip and the
   read's own `null`;
5. malformed values (missing key before the cutoff, key past it, an unknown
   key, an open exhaustive end, a list in a singular slot) and snapshots (narrowed,
   widened and empty tuples, the key smuggled into the node's own record, a
   non-array slot) are refused by their own direction;
6. a cyclic published value (a leaf holding its ancestor; a JSON leaf holding
   its occurrence) and a cyclic stored tuple are refused promptly;
7. owner cell: the refusal class is `CacheSnapshotFailure`, never a stack
   overflow (the route boundary redacts causes, so the class is read at the
   owner, composed as `shapeCodec` composes it); a required singular slot's
   `null` and primitives where a slot or occurrence belongs are refused;
8. aliasing (repair round): at `depth: 2`, one cutoff occurrence at both places
   of its slot (`[{ id: "a", children: [x, x] }]`), one continued occurrence
   twice (`[y, y]`, `y = { id: "y", children: [] }`, its slot completed in
   between) and one stored cutoff tuple at both places
   (`[[[["id", "a"]], [t, t]]]`) are each accepted and restored as separate
   objects — the one behavior only the walker's leave covers;
9. a 1,000-level bounded chain (the public ceiling) parsed, stored, restored:
   key absent exactly at level 1,000; no shared object;
10. a 12,000-level exhaustive chain, the same three phases.

`cache-lifecycle.test.ts` — 7 cells, through `createClient(…).$extends(cache(…))`
on SQLite (a recording driver counts statements):

1. `true`, `{}`, `{ depth: 100 }` and `{ depth: undefined }` are ONE entry (hits
   run no SQL and hide a later database change); depths 3 / 99 / `false` are
   three more entries answered from the database; graph `{ depth: 3 }` and
   `{ depth: 3, preventCycles: true }` share an entry, `preventCycles: false` is
   another, and its unfolded value is itself restored on a hit;
2. detached hits (caller mutation of miss and hits), a fresh hit hiding a
   database change, a stale hit served then refreshed by exactly one background
   recursive read (clocked backend, `ttl: 10, swr: 100`);
3. the existing invalidation policy only: a mutation asking nothing clears
   nothing; `cache: { autoInvalidate: true }` clears the model prefix and the next
   read misses — no stronger freshness is claimed;
4. array transaction, the pending operation's driver override, callback
   transaction (`tx.$withCache` absent) and a statement-transform chain bypass
   the cache for the recursive read **and** for the ordinary relation read
   control, mirroring `official-cache-reads.test.ts` "bypasses cache work …"
   (green before and after: a preserved-behavior control, not a red→green
   witness);
5. request-extension chains of 0, 1 and 5: handlers never see
   `select`/`include`/`omit`; their patches replacing `recurse` inside those keys
   are ignored — uncached results are the caller's, and every chain hits the ONE
   entry chain 0 wrote (same admitted key); a top-level `recurse` patch is a
   `ValidationError` before any cache call or statement;
6. model (`.omit({ hidden })`), client-default (`defaultOmit` `secret`) and query
   (`omit: { note }`) omit hold at every one of the 4 repeated occurrences, before
   keying (a plain client spelling the same projection hits the same entry); an
   explicit `select` overrides the default at every level while a query omit
   still subtracts; selecting the model-omitted field is refused with no set;
7. the failure boundary the removed refusal opened (repair round): with r's
   parent set to `a1` (an FK cycle inside the traversed window), a cached
   `findMany(tree(true))` rejects twice with a `QueryEngineError` carrying the
   decoder's sentence ("Recursive relation 'children' contains a cycle.") and
   the backend records no `set`.

### §5 "Execution placement" through the cache

For each item of the row, what this unit tests through the official cache
(cell numbers are `cache-lifecycle.test.ts`'s):

| Row item | Through the cache in this unit | Cell |
| --- | --- | --- |
| Read/build | Read: every cell reads through `$withCache()` (`findMany`). Build: not exercised here. | 1–7 |
| Supported row-returning mutations | Not here — RQ-06. | — |
| Pre-delete/post-write snapshots | Not here — RQ-06. | — |
| Arrays | The array transaction (`$transaction([pending])`) and the pending operation's driver override (`executeWith(driver)`) answer uncached — the recursive read and the ordinary relation control — with no cache call. | 4 |
| Callback transactions | Inside `$transaction(async (tx) => …)`, `tx.$withCache` is absent and the read answers uncached, with no cache call. | 4 |
| Concurrency | Not here — RQ-06. | — |
| Original errors/progress | Original error: with an FK cycle inside the window, a cached `findMany` rejects twice with the decoder's own `QueryEngineError` and writes no entry. Progress (write-outcome reporting): not here. | 7 |

Beside the row, the statement transform (§2.5's statement extensions, the
"Cache" row's statement-transform bypass): a statement-transform chain runs
its hook on each of two calls and the cache sees no call, for the recursive
read and the ordinary control (cell 4).

Supported row-returning mutations, pre-delete/post-write snapshots and
concurrency belong to RQ-06 ("Exercise all RQ-00 placements through the
shipped client, including supported mutations, both upsert arms, deletion
result timing, arrays and borrowed callback transactions"). Read-only build and
write progress are not exercised through the cache here either: the handoff
assigns build composition to RQ-06 (step 6), and RQ-06 owns "existing
write-outcome reporting" and provider failure identity.

## Stack-safety measurements

Wall time per phase, read from the JSON reporter's `meta.phaseMs` (the deep cells
record it; `--reporter=json`). One sample per run on a machine shared with two
other units; not a benchmark.

| Chain | Phase | `green-final` | `green-both-4` | `green-both-2` |
| --- | --- | ---: | ---: | ---: |
| 1,000 bounded (public ceiling) | parse | 2.66 ms | 4.54 ms | 3.03 ms |
| | snapshot | 2.15 ms | 3.46 ms | 2.52 ms |
| | materialize | 2.63 ms | 4.53 ms | 2.75 ms |
| 12,000 exhaustive | parse | 31.27 ms | 56.16 ms | 45.42 ms |
| | snapshot | 16.95 ms | 29.46 ms | 23.30 ms |
| | materialize | 30.93 ms | 50.93 ms | 46.89 ms |

Scaling, one temporary run (the 12,000 cell edited to loop, file restored by `cp`
and re-verified, `scaling.log`, 701.8 MiB peak): 3,000 → 15.2 / 6.5 / 9.0 ms;
12,000 → 55.0 / 43.6 / 54.5 ms; 48,000 → 341.8 / 148.9 / 316.6 ms
(parse / snapshot / materialize). Snapshot is flat at ≈3.1 µs per level from
12,000 to 48,000; materialization rises from ≈4.6 to ≈6.6 µs per level (a
quadratic ancestor copy would be 16× at 4× the depth).

**What this does and does not show.** The 12,000-level cell discriminates
call-stack dependence separately for snapshot (F1) and materialization (F1b).
The 1,000-level cell pins the ceiling round trip only: a data-recursive walker
survives 1,000 levels (F1), so that cell alone is not a stack-independence
witness. Parsing is the decoder's (`raptor3/shared/query.ts`, not this unit's):
it is measured here at both depths through the prepared read, not falsified here
(its own falsification is the 12,000-level cell of
[rq01-decoder-repair.md](rq01-decoder-repair.md)). **Not run:** chains beyond
48,000; per-phase memory; a stack-constrained run at 1,000; any provider other
than in-memory SQLite.

## Runs

*First round, on the first-round test bytes; the repair round's runs are in
the Repair round section.*

| Run | Files | Result | Wall / peak RSS | Log (`$TMPDIR`) |
| --- | --- | --- | --- | --- |
| Red, baseline production, first test bytes | codec | 9 fail / 9 | 25.06 s / 394.8 MiB | `red-codec-1.log` |
| Red, baseline production | lifecycle | 5 fail, 1 pass (bypass control) / 6 | 11.58 s / 434.6 MiB | `red-lifecycle-1.log` |
| **Red, baseline production, final test bytes** | both | **14 fail, 1 pass (bypass control) / 15** | 4.43 s / 474.0 MiB | `red-final-2.log` |
| **Green, final bytes** | both | **15 / 15** | 3.48 s / 587.4 MiB | `green-final.log` |
| Green re-check between other units' edits | both | 15 / 15 | 8.55 s / 579.2 MiB | `green-both-5.log` |
| Existing pins: `g4/parity/cacheable-read-vocabulary` (raptor3, 3), `engine/query/cache-result-codec-boundaries.core` (layer-query-engine, 9), `official-cache-extension.core` (10), `official-cache-swr.core` (7), `official-cache-instrumentation.core` (8), `request-transforms.core` (43), `default-omit-extension.core` (8) (layer-client) | 7 | **88 / 88** | 22.59 s / 599.0 MiB | `existing-pins-1.log` |
| Existing unregistered pin `g4/parity/json-read-schema` (cached read + SWR, SQLite; in no lane — see Observations) | 1 | **7 / 7** | 5.82 s / 414.0 MiB | `existing-pins-2.log` |
| F1, F1b, F2, F2b, F3 on final bytes | codec | as tabled above | 7.05–19.58 s / ≤ 560.2 MiB | `falsify-final-f*.log` |
| F4 on final bytes | codec cyclic cell | heap exhaustion (red) | 15.87 s / 1,073.9 MiB | `falsify-final-f4.log` |
| Void: F2/F2b/F3 at 00:05–00:06 | codec | contaminated by a transient admission state (not this unit's) | — | overwritten by the repeat |
| Fixture defect of my own (`get` refused callable proxies) | lifecycle | 6 fail, fixed in the test | — | `green-both-3.log` |

Biome (`node_modules/.bin/biome check`) is clean on all four owned files.

## Typecheck

*First round; the repair round's typecheck (zero diagnostics) is in the Repair
round section.*

`node scripts/run-typecheck.mjs` (native TS7, whole estate), taken on the final
bytes (owned digests identical immediately before and after):
`typecheck-2.log`, 33.72 s wall, 5,394.2 MiB peak (ceiling 8,192 MiB), exit 1
with **10 diagnostics, none in an owned file**:
`src/client/typescript-type-renderer.ts` (2, `recurrence` absent on
`ExpectedRelationResultShape` — mid-edit), `src/validation/relations/select-include.ts`
(1), `tests/types/client/recursive-query.core.types.ts` (4) — all rq-types'
in-flight files — and `tests/contracts/public-client/relation-types.test.ts` (1),
`tests/types/client/polymorphic-result.core.types.ts` (2), type probes downstream
of the relation-node types (zero-diagnostic at the decoder unit's frozen
typecheck earlier the same night). A first typecheck on the previous lifecycle
bytes (`typecheck.log`, 8 diagnostics, none owned) is withdrawn: one test
assertion was added after it. The RQ-05 exit's "zero diagnostics" is therefore
**not** established by this unit; it needs the integrated frozen tree.

## Cost

| Measure (code-bearing = non-blank, not comment-only) | HEAD | Final | Δ |
| --- | ---: | ---: | ---: |
| `client-route.ts` physical / code-bearing / bytes | 434 / 263 / 18,169 | 440 / 269 / 18,213 | +6 / +6 / +44 |
| `cache-value-codecs.ts` physical / code-bearing / bytes | 507 / 457 / 15,600 | 679 / 576 / 22,315 | +172 / +119 / +6,715 |
| **Production total** | | | **+125 code-bearing** (+185 / −7 physical per `git diff --numstat`) |
| `cache-codec.test.ts` (new; repair round +49 / +39) | — | 823 / 673 | +823 physical |
| `cache-lifecycle.test.ts` (new; repair round +25 / +17) | — | 725 / 608 | +725 physical |

One necessary new rule (where a recursive slot's repeated key exists, and its
snapshot form) with one owner; one exceptional path changed (the refusal arm
became the composition); one deletion (the refusal). No bundle, allocation or
runtime claim is made.

## Registrations owed (integrator — `scripts/raptor3-manifest.mjs`)

- `tests/raptor3/recursive-query/cache-codec.test.ts` → **10** cells.
- `tests/raptor3/recursive-query/cache-lifecycle.test.ts` → **7** cells.

Both are deterministic, in-memory SQLite, credential-free, like the FC-04 pin
`g4/parity/cacheable-read-vocabulary.test.ts` they extend: a counts object beside
`RQ01_SQLITE_COUNTS` (e.g. `RQ05_CACHE_COUNTS`) spread into
`RAPTOR3_DETERMINISTIC_TESTS` puts them in the `raptor3` project. They allocate a
database, so they do not belong in `layer-cache` (`src/cache/AGENTS.md`).

## Documentation owed (not this unit's files)

- `src/query-engine/raptor3/AGENTS.md:693-702` lists the official codec owners
  without `recursiveRelationCodec` and still says "a shape with no fixed codec,
  such as a recursive read's unbounded depth, is refused rather than
  half-encoded" — now false.
- `scripts/raptor3-refusal-census.mjs:108-109` (the `recursive-read` entry of
  `PRIVATE_FITS`, lines 103-116) declares `route/client-route.ts` part of the
  recursive-read private fit ("the route's recursive cache codec"); the route's
  recursive arm is no longer a refusal, and
  the census declaration belongs to its owner (the whole private fit is being
  retired by RQ-03).
- `src/cache/AGENTS.md:37` still names `query-engine/result/cache-result-codec.ts`
  as the snapshot codec; the live codec is the route's `cacheCodec` over
  `cache-value-codecs.ts`, and `compileCacheResultCodec` has no importer
  (pre-existing, outside this unit).

## Measured / not measured

Measured: per-phase wall time at 1,000 / 12,000 (three samples) and one scaling
run to 48,000; peak process-group RSS per run; physical/code-bearing LOC and
bytes. Not measured: allocation counts, bundle size, end-to-end cached-read
latency, memory per phase, any provider other than in-memory SQLite, and the
ordinary non-recursive cache codec's performance (unchanged code, not re-timed).

## Unverified

- PGlite, native PostgreSQL and native MySQL: not run (no provider lanes in this
  unit). `official-cache-reads.test.ts` (PGlite, extended-local) was not run; the
  ordinary cache path was covered by the SQLite and core pins listed above.
- The integrated frozen tree: other units' bytes moved during this unit. The
  first-round typecheck had 10 diagnostics (none owned); the repair round's had
  zero, on the tree of that moment — neither is a frozen integrated identity.
- A required singular recursive slot is unreachable through admitted schemas
  (CM002), so its `null` refusal is pinned at the owner only.
- The cause class of a refusal is invisible at the public boundary (sanitized),
  so "never a stack overflow" is witnessed at the owner and by F1/F1b/F4, not by
  the route's error object.

## Blockers

None.

## Observations for the integrator (no action taken)

- The level predicate `depth === false || L < depth` is stated at the producer
  (the decoder's `cutoff`) and at this validating consumer, both reading the one
  normalized depth. One shared predicate would need an owner both may import
  (`validation/relations/recurrence.ts` is the natural one); not in this unit's
  files.
- `enterSnapshotObject` restates `withSnapshotObject`'s rule for an explicit
  stack. Splitting that rule into enter/leave inside `cache-snapshot-structure.ts`
  (not owned) would let both forms share one statement.
- `tests/raptor3/g4/parity/json-read-schema.test.ts` (7 cells, green here via a
  scratch workspace) is registered in no lane — already recorded by
  [rq01-decoder-repair.md](rq01-decoder-repair.md).

## Repair round — 2026-09-23

The independent review returned two minor findings. Each requested change is
applied exactly, and nothing else. **No production byte changed**: both owned
production files keep the digests of the identity table (`49deb8d1…`,
`324d612c…`), re-verified before and after every run below.

| Test file | First-round bytes | Repair-round bytes (final) | Cells |
| --- | --- | --- | --- |
| `cache-codec.test.ts` | `fddc3b7f…` | `b882822ff1a048bcf924c1c2eb325235e9ebf7eb0a0593ee57a2f9b4ba7d9fd8` | 9 → 10 |
| `cache-lifecycle.test.ts` | `69585a11…` | `1eaa0a2be2c0cbb7d853fcfeb852353e340d7dcb7b75924af03452b1519fb3ed` | 6 → 7 |

**Falsification without touching the tree.** Both reds serve an out-of-tree
copy of an owned production module through a Vite `resolveId` redirect
(`$TMPDIR/repair/redirect-plugin.mjs`; workspaces `leave.workspace.mjs` and
`baseline.workspace.mjs`; copies built by `make-copies.py`). A copy differs
from its source only by absolute imports (it no longer sits beside its
siblings) and one load-marker line, which printed in each red run. The working
files were never modified: their digests were identical before and after each
run.

### Finding 1 — the walker's leave had no witness

*Review.* No cell tested the leave: the two `active.delete` calls,
`cache-value-codecs.ts:351` at the cutoff and `:363` when a slot completes. All
15 first-round cells passed with a walker that never leaves (the review's
falsification L). The note cited the diamond and the allow-policy root as proof
of the path-scoped rule, but both are distinct objects.

*Change (test only).* One owner-level cell next to the owner cell,
`cache-codec.test.ts:754`, "restores one object reached at two places as two
occurrences (owner)". It composes `recursiveRelationCodec({ relation:
"children", many: true, optional: false, depth: 2 }, recordCodec(id))`, as
`shapeCodec` composes it. It uses three aliases:

- (a) the value `[{ id: "a", children: [x, x] }]`, where `x` is one cutoff
  object;
- (b) the value `[y, y]`, where `y = { id: "y", children: [] }`;
- (c) the stored form `[[[["id","a"]], [t, t]]]`, where `t = [[["id","x"]]]` is
  one tuple.

All three first go through the file's `outcome` helper together, which records
one outcome per alias. Then the cell compares each restored value with its
expected value and shows that its two aliased places are separate objects. For
(b), that covers both the two occurrences and their two `children` arrays. The
file header also gains one bullet naming the pin. In this note, aliasing is now
named as the one behavior only the leave covers (Change 2, fact 3; witness 8).
The diamond and allow values are no longer cited as tests of the path-scoped
rule (Change 2, second placement). The codec file now owes 10 cells.

*Red (F5).* Run on the final codec with both `active.delete` calls removed
(`repair/mutant-leave/cache-value-codecs.ts`) and the final test bytes
(`repair/red-leave.log`): **1 failed | 9 skipped (10)**. The outcomes were
`["failed with Error", "failed with Error", "failed with Error"]` where
`["accepted", "accepted", "accepted"]` was expected, so every alias was
refused. (`outcome` prints `String(error)`, and `CacheSnapshotFailure` carries
no message.) By reading, (a) and (c) need the cutoff leave at `:351`, because
`x` and `t` sit at level 2, the cutoff. (b) needs the completion leave at
`:363`, because `y` continues into an empty slot. The red removed both lines at
once, so this per-line split rests on reading, not on a run.

*Green.* On the final bytes (`repair/green-repair.log`), the cell passes.

### Finding 2 — the failure path the removed refusal opened

*Review.* Before this unit, `cacheResultCodec()` refused every recursive shape
before execution. Now execution runs inside the cache (`#executeCached`), so a
decoder refusal reaches the cache path, and no cell tested that. The note also
did not say which items of §5's "Execution placement" row it covers.

*Change (test only).* One cell, `cache-lifecycle.test.ts:705`, "rejects a
cached read with the decoder's own cycle error and stores nothing". The cell
sets r's `parentId` to `"a1"` in its own world, so the shared `world()` fixture
stays acyclic for the other six cells. Through
`client.$extends(officialCache(recording).extension).$withCache()`,
`findMany(tree(true))` rejects twice with a `QueryEngineError` matching
`/Recursive relation 'children' contains a cycle\./`. Background work settles
after each attempt, and `RecordingCache.sets` stays `[]`. Supporting bytes:
`QueryEngineError` joins the `@errors` import; the pattern is a top-level
constant, `FK_CYCLE`, just as the file keeps `RECURSIVE_READ`; and the header
gains one bullet. This note now maps that row item by item (section §5
"Execution placement" through the cache) and owes 7 lifecycle cells.

*Red.* Run on baseline production, meaning the HEAD bytes of both owned
production files (`repair/baseline/`), with the final test bytes
(`repair/red-baseline.log`): **1 failed | 6 skipped (7)**. The first attempt
rejects with `UnsupportedOperationError: The Raptor 3 route cannot encode a
cached result for 'findMany': a recursive read's published depth is not a fixed
shape.` That class is a `QueryEngineError` subclass, so the sentence is what
fails the validation function.

*Green.* On the final bytes (`repair/green-repair.log`), the cell passes.

### Runs (repair round)

| Run | Files / filter | Result | Wall / peak RSS | Log (`$TMPDIR/repair/`) |
| --- | --- | --- | --- | --- |
| F5 red: leave removed (redirect) | codec, `-t "two places"` | **1 failed**, 9 skipped (10) | 10.28 s / 414.7 MiB | `red-leave.log` |
| Red: baseline production (redirect) | lifecycle, `-t "own cycle error"` | **1 failed**, 6 skipped (7) | 15.81 s / 387.2 MiB | `red-baseline.log` |
| Green: final bytes | both, `-t "two places\|own cycle error"` | **2 passed**, 15 skipped (17) | 7.91 s / 479.4 MiB | `green-repair.log` |

All three runs went through `run-vitest-safe.mjs` (`--heap-limit-mb=768
--rss-limit-mb=1536 --wall-limit-ms=120000 --reporter=verbose`) on the shared
lock. The two reds met a held lock and ran on their second attempt, 20 s later.
The totals (10 and 7) are the registrations. By instruction, only the affected
cells were re-run. The other 15 cells, the existing cache pins and the
deep-chain measurements were not re-run on the repair-round bytes. Those files
gained only the two cells, one import name, one constant and two header
bullets, and production is unchanged. Biome (`node_modules/.bin/biome check`)
is clean on both test files.

### Typecheck (repair round)

`node scripts/run-typecheck.mjs` ran once, on the final bytes, with the owned
digests identical immediately before and after (`repair/typecheck-repair.log`,
finished at 00:45). Result: **exit 0, zero diagnostics**, 38.46 s wall,
4,936.2 MiB peak (ceiling 8,192 MiB). The result is bound to my final bytes and
to the other units' bytes of that moment. It is not a frozen integrated
identity, so RQ-05's "zero diagnostics" exit still belongs to the integrated
tree.

### Registrations owed (updated)

- `tests/raptor3/recursive-query/cache-codec.test.ts` → **10** cells.
- `tests/raptor3/recursive-query/cache-lifecycle.test.ts` → **7** cells.

### Measured, not measured, unverified, blockers

- **Measured:** wall time and peak RSS of the three cell runs and of the
  typecheck, and the test files' growth: +49 physical / +39 code-bearing lines
  in the codec file, +25 / +17 in the lifecycle file.
- **Not measured:** nothing new on performance. The stack-safety figures above
  stand from the first round, on unchanged production and unchanged deep
  cells.
- **Unverified:** the per-line split of F5 (reading only, above); a provider
  failure's identity through the cache, build, progress and the RQ-06 items
  (none of them this unit's). The review's falsification L — every first-round
  cell green with the leave removed — is the reviewer's run
  (`review-falsify-L.log`), cited, not repeated.
- **Blockers:** none.
