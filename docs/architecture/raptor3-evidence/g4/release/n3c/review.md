# Release unit "n3c" — independent review

Reviewer: independent, main tree `/Users/arnaud/code/viborm`, branch
`pattern-engine`, head `279b23606`, unit UNCOMMITTED. All runs under
`TMPDIR=/private/tmp/viborm-n3c-review-tmp`. Nothing under `src`, `tests` or
`scripts` was edited; the only file written is this one. The falsification ran
in a scratch detached worktree at HEAD (`/private/tmp/viborm-n3c-verify-base`),
now removed.

## Verdict: **BLOCK**

The unit repairs the batch route's symptom by making **both** routes name the
parent's pre-write key. On the live route the same lookup is placed **after**
the parent's write (`relation-body.ts:870-871`), where the pre-write key is
the value the provider's cascade has just superseded. For a child-held edge
with `ON UPDATE CASCADE` under a parent key transition, a nested `update` that
**executed correctly at HEAD now refuses**. Reproduced twice on SQLite and
confirmed on PGlite by the repo's own conformance oracle, which moves its
failing assertion from "the two routes disagree" to "both routes reject a
scenario that must not reject". A per-file red-count comparison cannot see
this, which is why the unit's own evidence reports "no file worse".

---

## 1. The rule — one fact with a necessary branch, or a policy boolean?

**Structurally: one fact, no new policy.** `Membership` (`shared/storage.ts:11-33`)
has exactly two kinds, so `edge.kind !== "junction"` ≡ `edge.kind === "reference"`;
the only semantic addition at `relation-body.ts:497-501` is the third conjunct
`edge.owner === "source"`. No new boolean, no flag, no second reader
*introduced by the unit*, and the verb branch it narrows is the shipped one the
raptor3 fixed stage pins. The `owner === "source"` discriminant already exists
in this file (`:125`, `:247`, `:535`, `:871`, `:875`), so the unit adds no new
vocabulary. On that narrow question the unit is clean, and the narrowing does
what the note claims — it does not add a third policy.

**Substantively: the fact chosen is the wrong one.** §0's principle is *"every
consumer receives a value or an observation valid at its execution point"*.
The value's validity is a function of the lookup's **position** relative to the
parent's write. That position is already owned, in the same file, by
`association`:

```ts
// src/query-engine/raptor3/commands/relation-body.ts:870-871
const placement =
  edge.kind === "reference" && edge.owner === "source" ? "before" : "after";
```

The unit reads the *same* discriminant at `:497-501` to pick the *value*, and
picks `parent.located!.fields` (the pre-write key) precisely on the arm that
`association` places **`"after"`** the parent's write. The two readers of
`edge.owner` now answer "where does this run" and "which key does it name" in
opposite directions. Under Arnaud's NO PATCHWORK rule this is a second reader
of one fact reaching the contradictory conclusion, not one owner.

**How I would state it.** Not "a child-held key names the located identity",
but: *the membership names the parent's key as it is at the lookup's own
execution point. A parent-held edge is placed before the parent's write and
keeps the shipped verb distinction (a nested `update` follows the parent's
assignments — a rebound foreign key names the final target, an unchanged one
reads the captured row; an upsert's found requirement and every other verb name
the current member). A child-held edge is placed after the parent's write, so
the value valid there is the post-write key, which the provider's cascade has
already put in the child. What is broken is not the value the live route names —
it is that on the batch route this "after"-placed read is dispatched as a
planning read before the batch, where neither key is valid.* That is N1's
seam ("a dependent lookup is an ordered observation or an established
producer": either the read is ordered after the write behind a `submit`
barrier, or the produced key rides the reference scratch as D-50's child
foreign key does), not a value swap at the emission.

Note §2's headline — "A statement names the parent's key AS IT IS at the
statement's position" — is also not what the code does on the parent-held arm,
which deliberately names the key the parent's write will hold. The bullets
below the headline are honest about that; the headline is not.

## 2. Is `parent.located!` safe? — **YES, verified**

`correlated` requires `parent.fields.operation === "update"`
(`relation-body.ts:412-414`). An `Assignments` whose `operation` is `"update"`
is constructed at exactly one site — `Commands.update(located, …)`,
`commands/commands.ts:293-318` — and that site sets `located` on the same
`RecordCommand` literal. The only other `new Assignments(...)` calls are
`commands.ts:278` (`"create"`), `commands.ts:1360`, `selection.ts:128`,
`relation-body.ts:562` and `:757` (all `"select"`). Nothing clears
`RecordCommand.located`. So `correlated ⟹ parent.located !== undefined`. The
`!` is also not new: the same expression's else-branch already carried it
before this unit (junction edges, and every non-`update` verb), as do `:234`,
`:245`, `:779`, `:783`. This is ELEGANCE §5's "narrow assertion of an
invariant established upstream" and is acceptable as written.

## 3. The after-the-write side left to N5 — **partly right, wrongly reasoned**

- **The unit does not touch `shared-pk-update-root`: verified exactly.** Run at
  HEAD in the scratch worktree and in the main tree with the unit: 16 failed |
  55 passed (71) both times, the **same 16 cell names and the same failure
  messages** (`UPDATE RETURNING did not produce the required record` ×4,
  `…cannot resolve the parent id for relation 'tokens'…` ×3,
  `expected undefined to deeply equal { accountProviderId: 'p2' }` ×3,
  `Foreign key constraint violation` ×3,
  `Cannot update relation 'chits': target record was not found for this parent.`
  ×2, `Nested write assertion failed…` ×1). The note's *outcome* claim holds.

- **The note's stated reason is wrong.** Note §5 says that suite's edges "are
  the shared-primary-key kind". The cell in question —
  `update publishes the target's post-update key before descendant writes`,
  `tests/contracts/engine/write/shared-pk-update-root-behavior.ts:441-478` — nests
  two different edges under the root `card.update`: `account` (parent-held, the
  shared primary key) and `chits`. `chits` is declared at
  `shared-pk-update-root-behavior.ts:63-73`: `chit.cardId` `.references("accountId")`
  `.onUpdate("cascade")`. From the root `card`'s side that edge is
  **CHILD-HELD** (`edge.owner === "target"`) — exactly the kind this unit
  re-owns, so the changed line does apply to it. The cell is unmoved because in
  that shape both the pre- and the post-transition key miss for the fold's own
  reason, not because the edge is a different kind. Please restate the
  attribution; "shares the sentence, not the owner" is right, "that suite's
  edges are the shared-primary-key kind" is not.

## 4. Runs (all green where the note says green)

| what | command | result |
|---|---|---|
| SQLite pin | `node scripts/run-vitest-safe.mjs tests/raptor3/g4/parity/parent-key-at-position-sqlite.test.ts` | **2 / 2** |
| PGlite pin, through the gate's own stage | `pnpm test:all --only "parent-key-at-position"` | **2 / 2**, ran as `raptor3-provider` (the manifest rename is correctly wired) |
| raptor3 fixed stage | `pnpm test:all --only "Raptor 3 fixed"` | **758 / 758** (65 files) |
| occupied-to-one | launcher, `relation-key-update-legality-occupied-to-one.test.ts` | **7 / 7** |
| occupied-to-many | launcher, `relation-key-update-legality-occupied-to-many.test.ts` | **6 / 6** |
| membership conformance | launcher, `nested-write-conformance-membership.test.ts` | **13 red / 17 pass**, the **same 13 cells** as `receipts/run3/` (receipt names are width-truncated; each is a prefix of the current name) |
| biome, changed source | `npx biome check src/query-engine/raptor3/commands/relation-body.ts`, base vs working tree | **identical**: the same 6 diagnostics (5 × `lint/style/noParameterProperties` at `:83-87`, 1 × `lint/correctness/noUnusedVariables`), only the line number shifted `885 → 899` by the 14 added lines. The note's claim holds. |
| biome, new tests | `npx biome check tests/raptor3/g4/parity/parent-key-at-position*.test.ts` | **clean** |
| cell-level, not count-level, HEAD vs unit | `parent-held-lookup` (10 red), `nested-write-conformance-{fk,root-dependency,transitive,m2m,to-one}`, `shared-pk-update-root` | **same failing cell names** in every file; no green → red swap |

## 5. The falsification — and what it exposed

`git worktree add --detach /private/tmp/viborm-n3c-verify-base HEAD`,
`pnpm install --frozen-lockfile --ignore-scripts`, `npx prebuild-install` for
better-sqlite3, own `TMPDIR`. The SQLite pin copied in, `src` pristine:

```
× N3c on SQLite, batch-only route … → QueryError V2001 (driver sqlite3, model child)
✓ N3c on SQLite, live route …
Tests  1 failed | 1 passed (2)
```

**The pin falsifies on the batch-only cell only. Its live-route cell is
non-discriminating.** I traced the emitted SQL and parameters at HEAD and with
the unit's `relation-body.ts` copied in; on the live route they are
**byte-identical**, because in the pin's schema (`onUpdate("setNull")`)
`requireTransitions` raises the occupied refusal **before** the nested lookup is
ever dispatched. The only `n3c_*_children` statement the live route emits is the
transition guard's own probe —

```
SELECT … FROM "n3c_probe_children" AS "q0"
 WHERE ("q0"."parentId" = ? AND NOT (? = (CAST(? AS INTEGER) + ?))) …   params=[1,1,1,1,1]
```

— which is what the pin's `CHILD_LOOKUP` regex matches and what its
`assert.ok(!SCRATCH.test(lookup))` then trivially passes (the live route never
names the scratch). The live-route cell asserts nothing this unit changed.

### 5.1 The regression

Chasing a live-route shape that *does* reach the changed line — a child-held
edge whose parent key transition cascades, so `requireTransitions` continues —
reproduces the defect. SQLite, `container.id 10 → 11`, `node.containerId`
`.references("id").onUpdate("cascade")`, nested `update`; identical on the
to-many and the to-one spelling:

| route | HEAD | with the unit |
|---|---|---|
| live | lookup runs **after** `UPDATE containers SET id=11`, names `containerId = 11`, finds the cascaded row, updates it. **RESOLVED**, final state `nodes=[{id:1,label:"after",containerId:11}] containers=[{id:11}]` | lookup names `containerId = 10`, which the cascade has just vacated → **`NestedWriteError: Cannot update relation 'nodes': target record was not found for this parent.`**, nothing written |
| batch-only | lookup before the batch names `11`, finds nothing → refuses, **nothing written** | lookup names `10`, finds the row; inside the batch the premise re-asserts `containerId = 10` **after** `UPDATE containers SET id=11` has committed → refuses, and the parent's transition **stays committed** (`containers=[{id:11}]`, `nodes containerId=11`, label unchanged) |

HEAD's live result is exactly the `expected` of the plan's own conformance cell
`non-self child-holds cascade keeps membership through a key transition`
(`tests/contracts/engine/query/nested-write-conformance-membership.test.ts:818-847`).

### 5.2 The repo's own oracle says so, and counts hide it

That cell is red before and after, so the count is unchanged — but the failing
assertion moves:

- **HEAD** — fails at `nested-write-conformance-fixtures.ts:139`,
  `expect(batch.rejected).toBe(transaction.rejected)`: the routes **disagreed**;
  the transaction route did **not** reject.
- **with the unit** — fails at `:140`,
  `expect(transaction.rejected).toBe(scenario.expectReject === true)`: the routes
  now agree, and they agree on **rejecting** a scenario that must not reject.

`receipts/comparison.md` measures red **counts** per file ("Files measured: 126;
red before 142, red now 137; no file worse"). A cell whose red changes cause,
and whose live route regresses from correct to refusing, is invisible to that
instrument. This is the evidence-method gap that let the regression through.

### 5.3 Why this is BLOCK, not REVISE

- It converts *supported, executing* behaviour into a refusal on the default
  (live) route, for every schema with a child-held `ON UPDATE CASCADE` edge
  under a parent key transition — against D-52 ("a refusal is kept where it
  names an execution fact that no owner can execute around"; HEAD executed
  around it) and against "refusals are contracts".
- On a batch-only transport it introduces a new partial-effect surface: a
  committed parent key transition followed by a refusal, where HEAD refused
  before writing anything.
- No minimal in-unit edit fixes it. Naming `parent.fields` restores the live
  route and restores the batch red; naming `parent.located!.fields` fixes the
  batch and breaks the live route. The value that is correct at both positions
  does not exist, because the two routes execute the read at different
  positions — which is precisely N1's subject (an ordered observation behind a
  `submit` barrier, or the produced key on the reference scratch). Shipping a
  value swap here makes the routes agree on the wrong answer and will have to be
  undone when N1 lands.
- The premise the unit writes into the guide is false as stated. "A nested
  lookup runs before the parent's own write"
  (`src/query-engine/raptor3/AGENTS.md` new paragraph, `relation-body.ts:480-492`,
  note §2) holds on the batch route and is contradicted on the live route by
  `relation-body.ts:870-871`, which places a child-held target `"after"`. A
  guide paragraph that states the opposite of the code is worse than no
  paragraph.

### 5.4 What would make it ACCEPT-able

Not resolutions I can call "minimal", but the shape that would satisfy the
principle:

1. **Re-own the position, not the value.** Keep `parent.fields` as the membership
   source (the value valid at the `"after"` position the child-held arm already
   has), and make the batch route dispatch that read where its value is valid —
   ordered after the queued write behind a `submit` barrier, or carrying the
   scratch reference the way D-50's child foreign key does. That is N1's work;
   N3c then becomes a pin on N1, not a unit of its own.
2. **If N3c must land before N1**, it has to be restricted to the shapes it
   actually repairs — the occupied/restrict legality cells, where
   `requireTransitions` refuses before the lookup and the located key is the
   only key that can be named — and must not change the value for a child-held
   edge whose transition cascades. That restriction is a third condition on the
   same line and is, by construction, the policy boolean the standing rule bans.
   I do not recommend it.
3. **Make the pin discriminate.** Whatever lands, the SQLite pin needs a
   live-route cell that reaches the nested lookup: assert the lookup's bound
   parameters, not just the absence of `__viborm_batch_refs`, and add a cascade
   arm. As written, the live-route cell is green at HEAD with identical SQL.
4. **Replace the count comparison.** `receipts/comparison.md` must compare
   failing **cell identities and messages**, not per-file counts; on this unit
   the count was right and the behaviour was not.

## 6. What I could not verify

- No Docker lanes (`pg`, `mysql`). The note already records this as unverified.
- I did not re-run the full 8-shard shared-family estate or the imported-PGlite
  shards at HEAD; my cell-level HEAD-vs-unit comparison covers eight files
  (`parent-held-lookup`, the six `nested-write-conformance-*`,
  `shared-pk-update-root`). A green → red swap outside those files is possible
  and unmeasured.
- Coverage floors (`coverage:query-engine-core`, `coverage:policy`) were not
  re-run; I read the author's receipts only.
- I did not re-run typecheck; the author's `receipts/typecheck.log` records
  `exit=0 errors=0` and I did not contradict it.
- The regression was reproduced on SQLite (both routes) and confirmed on PGlite
  through the conformance harness's assertion line; I did not capture PGlite
  statement traces for it directly.
