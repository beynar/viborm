# Nested-Write Boundaries — the ≥-Prisma Plan (N-waves)

> **Delivery status:** in progress on branch `nested-write-boundaries` (PR opened at wave start). Per-wave records land below each phase as waves close.

**Date:** 2026-07-29 · **Scope:** query engine only (no CLI, no ecosystem, per maintainer).
**Goal:** absorb the remaining nested-write refusals so every shape Prisma executes, viborm executes — and go past Prisma where the atom's flexibility allows. Baseline: `main` @ post-#17/#18 merge, refusal census **78** (`tests/query-engine-v2/route-inventory.test.ts:670`).

**The keystone insight:** almost every remaining refusal exists because a value the engine needs is not a **compile-time literal** — a located parent's id, a compound key member, a deeper FK. But the engine already owns the mechanism that makes non-literals flow: **`Ref`** (a not-yet-known value riding `Sql.values`, resolved from an earlier step), proven by the junction generated-PK work, the T4a planned-parent leaf, and T4b's updated-PK dataflow. This plan is one generalization applied family by family: **where a pin was required, thread a Ref from the locate step instead** — with the W4 wrong-row lesson as doctrine (a Ref derives from the row a step *acted on*, never from re-consulting the `where`).

**Harness:** per-wave opus workflow, implementer → contract attacker → theater attacker (falsify-by-mutation, staleness-injection for every new Ref/pin path), ≤2 fix rounds, memory-bounded verification, Docker legs at wave gates. Census edits deliberate, bidirectional, with the count-evolution log updated. One guard per invariant. Both execution substrates (tx AND atomic batch) per absorbed shape, or an explicit typed refusal for the batch side with the reason named.

---

## N1 — The located-parent Ref (keystone; runs ALONE — Pin Rule blast radius)

Today, `update({ where, data: { <child writes> } })` demands the referenced parent column be a compile-time literal: pinned by the unique `where` or rewritten by the root SET. That is why `where: { email }` + `posts: { create }` refuses while `where: { id }` works ([UpdateOperation.ts:1422](../../src/query-engine-v2/UpdateOperation.ts:1422)).

| Unit | What |
|---|---|
| N1-U1 | The update's **locate step returns the referenced column(s)**, and child-edge builders accept a `Ref` into that read wherever they accept a literal today — single-field first. The Pin Rule's *race* semantics survive intact: racePin attribution still keys on the discriminator; the Ref is a dataflow value, not a race signal. Staleness-injection: corrupt the locate's returned column → the child write must fail closed, never write a stale FK. |
| N1-U2 | **Compound referenced keys** ride the same mechanism per field (removes `does not support a compound-key nested create`, `requires a child with one primary key` where the cause was literal-only compounds). |
| N1-U3 | **Batch lowering**: the locate is a planning step; planning steps may Ref earlier planning steps (technique #1). Prove tx/batch equivalence with the dual-substrate oracle; where the batch side is genuinely inexpressible, a typed refusal naming the substrate. |
| N1-U4 | Census sweep of every site whose stated reason was "not pinned / not a compile-time literal" — absorb or re-justify each with the new mechanism available; falsify absorbed paths. |

**Acceptance:** `update({ where: { email }, data: { posts: { create } } })` executes identically to the `where: { id }` spelling on all local dialects + both substrates; the B6 family (unpinned PK-transition variants) re-audited against the Ref; census drops with per-site justifications.

### N1-U1 — delivered

`UpdateOperation.resolveLiteralCreateParent` became `resolveCreateParent`: when no
compile-time literal names the referenced parent column, the column joins `locateFields`
(so the locate SELECTs it *and* declares it as a `firstRowField` output) and the create
leaf gets a `plannedParentId`, resolving the foreign key at compile from the row the
locate ACTED ON. The literal path is untouched for the pinned single-field case — the
`where: { id }` spelling compiles byte-identically, pays no extra column and no extra
statement. The single-`create` leaf was already per-field compound-ready from T4a
(`buildPlannedParentCreatePart` / `plannedFkInject`); N1-U1 adds
`buildPlannedParentCreateManyPart` for the bulk arm, allocating step ids at construction
from a shape plan and ASSERTING (not assuming) that the compile-built plan has the same
statement count.

Census **78 → 77**: the refusal is deleted, not narrowed. Four sites were re-justified
rather than absorbed, each with the Ref explicitly considered — see the count-evolution
entry in `route-inventory.test.ts`. Notably `resolveCreateParent`'s "pre-transition value
is not pinned" survivor: the Ref *does* reach the pre-transition value, but the
absorption needs the post-transition derivation ordered against the root UPDATE, which is
**N5-U2**'s unit.

Witnesses: `located-parent-ref-behavior.ts` (7 shapes × every driver leg × both
substrates — state parity between spellings, the wrong-row decoy, a D4 non-PK referenced
column, `createMany`, the X1b create subtree); `located-parent-ref.test.ts` (plan parity:
identical statement count and write SQL between spellings; staleness injection: the FK
follows the locate's returned value, a value corrupted to a non-existent key fails closed,
an absent declared output fails closed at planning); `staleness-injection.test.ts` (race
story: a concurrent parent delete aborts the batch typed with no orphan);
`upsert-family-behavior.ts` (the upsert's UPDATE arm rides the same Ref; its CREATE arm's
produced-identity provenance is unaffected).

Four tests were deliberately RETARGETED from a decline to an accept-and-execute assertion
on the SAME payload, each with the reason written at the site:
`nested-update-d4-deep-nonpk-reference.test.ts` (this is also the depth-≥2 witness — the
Ref under X1c delegation), `extended-where-unique-behavior.ts` (the Pin-Rule claim), and
the two construction-surface tests in `update-family.test.ts` / `upsert-family.test.ts`.

**Fix-round correction (N1-F1).** This record first said the Pin-Rule claim "survives,
sharpened". That was wrong, and the reason written at the retarget site was provably
false. The deleted `UnsupportedOperationError` assertion was the estate's ONLY behavioral
falsification of "the filter half pins nothing", and the two retargeted `AND` cases cannot
carry it: the filter half is ANDed into the locate, so an `AND` branch either names the
located row's own referenced value (the two provenances coincide by construction) or names
a different row's and the locate matches nothing (nothing is written regardless of where
the FK came from). Measured, not argued: `locatedCreateParent` mutated to scan
`this.parentWhere.AND` for the referenced field and return it as a literal — i.e. the
filter read AS a pin — passes the whole suite, 68/68.

The falsification is restored as a third case rather than by reinstating the refusal (the
refusal is genuinely absorbed): an **OR** filter half, the one shape whose two halves can
disagree while the locate still finds a row. `where: { email: 'live@x', OR: [{ id: 2 },
{ id: 1 }] }` locates account 1 while account 2's id sits in the filter half; a
filter-as-pin writes the login against account 2 — a live, insertable key, so the wrong
parent is a silent wrong row, not an error. Both branch orderings are asserted, so no
positional filter-as-pin (first branch or last) survives. The mutation above fails it on
both substrates (`accountId: 2` for `accountId: 1`). N6-U1 (extended unique in nested
selectors) is planned on top of this claim, so it now rests on a witness that discriminates.

### N1-U2 — delivered

No new mechanism. A compound foreign key was already per-field in this model, and the
create leaf's inject already loops the FK columns index-aligned with the referenced ones,
resolving each BY NAME from one located row — so U1's `plannedParentId` covers arity ≥ 2
by construction. U2 is a **gate** change: every referenced column is registered in
`locateFields`, and the compound refusal moves *behind* the "does the root SET rewrite a
referenced column?" test instead of standing in front of it.

Census stays **77** — the site NARROWS rather than disappears, and its message now names
the surviving cause: a compound reference whose member the root SET rewrites. That
survivor is ordering, not dataflow (the located row carries the PRE-transition tuple), and
belongs to **N5**.

Witnesses (every driver leg, both substrates): a compound PK reference located by its own
compound where-unique; the same PK located by a `handle` unique naming NEITHER member,
with a sibling sharing `tenantId` so a dropped member would attach the child to it; a
compound NON-PK referenced unique (`[region, code]`) with a sibling sharing `region`; plus
a staleness probe that corrupts exactly ONE member of the tuple and asserts the WHOLE tuple
moved — the proof that every member travels from the same located row.

### N1-U3 — delivered

**No batch-side code was needed, and that is the finding.** The locate is a planning step,
and planning runs ahead of the atomic unit in batch mode exactly as it runs inside the
transaction — so the value the Ref carries is produced identically on both substrates and
inlined into the compiled statements before `compileToEntries` ever sees them. Technique #1
is satisfied by the existing lifecycle; nothing threads through the batch lowering.

The deliverable is therefore the ORACLE, not a mechanism: seven scenarios (single, bulk, D4
referenced column with a scalar SET, the create subtree, a compound reference by a unique
naming neither member, a missing row, a colliding child PK) run through BOTH substrates on
a FRESH database per arm, comparing the returned result, the whole persisted state, AND the
error class + message. They agree on all seven, including both failure classes. No shape
required a substrate-naming refusal — that is measured, not assumed.

One genuinely inexpressible batch case exists and is NOT new: `createMany` +
`skipDuplicates` on a dialect whose skip is not a SQL leaf (`recoverableUniqueError` —
MySQL) compiles to the savepoint-wrapped executor effect, which a single atomic batch
cannot carry. The planned-parent leaf inherits that disposition unchanged from the literal
one (same `onUniqueConflict` flag, same executor refusal). The shared behavior suite pins
it in BOTH directions rather than skipping it: the MySQL atomic-batch leg DECLARES
`skipDuplicatesInBatchIsInexpressible` and asserts the typed refusal with nothing written;
every other leg asserts the skip executing. A dialect that can express it cannot quietly
start refusing, and one that cannot cannot quietly start succeeding. **Measured**: the
Docker MySQL leg runs it green (749/749).

One harness note this wave paid for: the behavior suite drives the OPERATION, not the
routed client. A batch-only, non-returning driver (MySQL forced into atomic-batch mode)
refuses every single-row mutation at the client seam — "public result parsing cannot be
rolled back" — so a client-driven suite would have made the whole MySQL batch leg vacuous
while looking green. Every other update-family behavior suite already used the operation
seam for exactly this reason; this one now matches.

### N1-U4 — delivered

The sweep enumerates **every** surviving site whose stated reason cites a pin, a
compile-time literal, or "must locate by its primary key … so the value is known", and
gives each one of two verdicts: absorbed (U1/U2), or kept with the reason the Ref does not
close it AND the wave that owns it. Ten entries, `(a)`–`(j)`, written into the
count-evolution log in `route-inventory.test.ts` so they live beside the pin they justify.

The honest shape of the residue: three sites are ORDERING problems the Ref reaches but
cannot finish (a rewritten referenced member, an unpinned pre-transition PK, the
occupied-guard correlation) — **N5**; three are the "locate the target by its PK" family
where the Ref generalizes exactly as it does here — **N4-U1**, left for the wave that owns
it rather than guessed at from this one; four sites are on the CREATE root or an M2M fresh
target, where the Ref is structurally unavailable because there is no locate step and the
parent is fresh — **N3 / N4-U4**; and three ("requires a child with one primary key") were
never literal-propagation at all, listed only so the sweep is complete.

Census pin: **77**, edited in lockstep with U1 (78 → 77) and unchanged by U2's narrowing.
The decline-surface gate runs bidirectionally: side 1 gains the N1 shape (a nested create
under an update located by a non-PK unique EXECUTES, with the wrong-row decoy asserted
empty), side 2's named tripwire (`createMany` under a parent-held planned target) still
declines untouched.

**Measured, not fixed — recorded for a later wave.** In BATCH mode the root-presence guard
and the root UPDATE both address the ORIGINAL `where`, while child edges address the
captured located row. Under a concurrent rename-plus-reinsert on the discriminator those
two can name different rows. This is pre-existing for every alternate-unique locate (a
`connect` under `where: { email }` splits the same way) and is NOT introduced by the Ref —
but N1 makes the spelling common, so it is named here rather than left implicit.

### N1 — certification

TS 5.9.3 typecheck clean; Biome clean on every touched file. Gates 5/5 files, 69 tests.
Full estate ONCE, alone: **8321 passed / 0 failed** (1626 Docker-gated skips) — up from the
~8220 baseline by the wave's own witnesses. Local dialect legs (sqlite3 + libsql + pglite,
both substrates each): 2398 passed. Docker MySQL 3307: 749 passed. Docker Postgres 5434
(serial, pg + postgres.js): 856 passed, 14 skipped. Census pinned at **77**.

### N1 — wave gate (independent re-run at `77f5bc1`, 2026-07-29)

Every number below was re-measured on the branch tip, each step in its own shell, one
vitest at a time.

| Step | Result |
|---|---|
| `pnpm test:types` (TS 5.9.3) | clean, no output |
| Full estate, ALONE (`--minWorkers=1 --maxWorkers=4`) | **8327 passed / 0 failed**, 1629 skipped (Docker-gated); 248 files passed, 4 skipped; 417s |
| `pnpm test:gates` | **63 passed / 63**, 5 files; census pin **77** (`route-inventory.test.ts:780`), count-evolution log carries the 78 → 77 (U1), 77 → 77 narrowing (U2), and the ten-entry `(a)`–`(j)` sweep (U4) |
| Biome (repo-pinned 2.3.11, `main`-baseline worktree for comparison) | all 17 changed `.ts` files exit 0 — **zero** violations, so zero NEW violations by construction |
| Docker MySQL 3307 (`pnpm test:mysql`) | **750 passed**, PASSED not skipped |
| Docker Postgres 5434 (`pnpm test:pg`, serial) | **858 passed**, 14 skipped, PASSED not skipped |

The new Ref witnesses were confirmed **executed** (not collected-and-skipped) on both
Docker legs, on both substrates each: `located-parent Ref (N1)` runs 11 tests under
`transaction` and 11 under `atomic batch` on MySQL and on pg — including the compound
block, `createMany`, `createMany skipDuplicates`, the wrong-row decoy, and the
no-matching-row abort — plus `extended whereUnique > an OR filter naming another row's
referenced value pins NOTHING` (the restored falsification, both substrates) and
`upsert family > upsert UPDATE arm: a nested create by a non-PK unique rides the
located-parent Ref`.

**Two corrections to the certification block above, measured not argued.**
(1) The estate figure `8321` predates the fix-round commit `77f5bc1`, which added the OR
falsification across the driver legs; the branch tip measures **8327 passed / 0 failed**.
(2) "Gates 5/5 files, 69 tests" was wrong when written: `pnpm test:gates` runs **63**
tests, and no gate file (nor any module a gate file imports) has changed since that
record was committed, so 63 was also the true count at `5533587`. The gate-file set and
its bidirectional content are unchanged — only the stated number was off.

Docker MySQL 3307 and Postgres 5434 were already up (21h) and were not restarted.

## N2 — Inverse-side to-one family (the mainstream Prisma shape)

`user.update({ where, data: { profile: { create: { bio } } } })` still refuses ([UpdateOperation.ts:1720](../../src/query-engine-v2/UpdateOperation.ts:1720)); `createMany`/`deleteMany` on the inverse side likewise.

| Unit | What |
|---|---|
| N2-U1 | Inverse to-one **`create`**: child INSERT with FK = parent id (literal or N1's Ref), guarded by the **occupied-slot** rule (Prisma errors if a related row already exists — match it, tx + batch, race-safe: the unique FK constraint is the backstop and the racePin story must be stated). Reuse RelationWritePart/ConnectDisconnectPart machinery, not a new path. |
| N2-U2 | Inverse to-one **`createMany`** (single-element semantics per Prisma — or refuse exactly as Prisma refuses; MEASURE Prisma's actual behavior first and pin it in the test name) and **`deleteMany`** (delete-the-connected-row filtered form). |
| N2-U3 | The residual inverse-side declines re-audited: object-form `disconnect`/`delete` stay Prisma-parity refusals (Prisma only takes booleans there) — verify, don't assume. |

### The measurement this wave ran first

Prisma's inverse-to-one nested-write surface was MEASURED, not recalled: `prisma generate`
on a schema carrying `User.profile: Profile?` beside `User.posts: Post[]`, Prisma **7.9.1**,
`prisma-client` generator. Two generated inputs decide all three units:

```
ProfileUpdateOneWithoutUserNestedInput = {          // the INVERSE TO-ONE
  create?, connectOrCreate?, upsert?, connect?, update?,
  disconnect?: ProfileWhereInput | boolean,
  delete?:     ProfileWhereInput | boolean,
}
PostUpdateManyWithoutAuthorNestedInput = {          // the TO-MANY, for contrast
  create?, connectOrCreate?, upsert?, createMany?, set?, disconnect?, delete?,
  connect?, update?, updateMany?, deleteMany?,
}
```

Two of the wave's three premises did not survive it, and both corrections are recorded
below rather than quietly absorbed.

### N2-U1 — delivered

`user.update({ where, data: { profile: { create: { bio } } } })` executes. It needed no
mechanism: an inverse-side to-one create is the **arity-1 case** of the child-held create
the update root already builds, so the new `create` case enters `interpretChildHeldCreate`
unchanged and inherits both N1 provenances — the construction literal when the unique
`where` pins the referenced column, the **located-parent Ref** when it does not. The
to-one payload is a bare object where the to-many spelling is single-or-array, and
`normalizeItems` already read both. A detail that reframes the site: `nested-target-parts.ts`'s
`create` case has no `isInverseToOne` branch at all — one level deeper this already worked.
Only the ROOT dispatch refused it.

**The occupied slot** is the one rule the to-many case does not have, and it needed no
engine guard either. A 1:1 foreign key ALWAYS carries a UNIQUE constraint — `FK008` refuses
to *define* a 1:1 without one, and the DDL serializer adds it if a schema ever arrives
without it — so a create into an occupied slot raises `UniqueConstraintError` with nothing
written, which is Prisma's observable. There is no pre-check SELECT: it would be a second
guard on the one invariant (the AGENTS.md ban) and a racy one besides, since two concurrent
creates would both read an empty slot and leave the constraint to decide anyway.

**The race attribution is measured, not asserted.** The leaf carries no `racePin`, so
`race-retry.ts` reads the violation as matching no pin and not `meta.raceable` — a genuine
conflict, never a retryable race. Measured through the ROUTED client (the layer that owns
the retry): exactly **one** INSERT reaches the database, and **zero** SELECTs against the
child table. Both numbers are the same test.

Census **77 → 76**: `interpretInverseToOneKind`'s `default` is gone as a route. It did not
become a narrower refusal — the dispatch is now TOTAL over the parse boundary's
inverse-to-one surface, so reaching `default` would mean the schema emitted a key it does
not define. That is an engine invariant break, so it is a `QueryEngineError` (the X1c
disposition for a branch unreachable by construction), not an `UnsupportedOperationError`.

Witnesses (`inverse-to-one-create-behavior.ts`, every driver leg, both substrates): the
pinned and Ref spellings persisting the same shape; the wrong-row decoy staying empty; a D4
non-PK referenced column threaded from the located row; the created child carrying its own
nested writes one level deeper; the occupied slot rejecting under BOTH provenances with the
root's own scalar write rolled back too; a no-matching-row abort. **Falsified**: restoring
the refusal fails 19 of the file's 22 tests, and the 3 survivors are exactly the
parse-boundary surface pins, which do not depend on the absorption.

### N2-U2 — measured; nothing to build, so a pin instead

`createMany` is **not offered on a to-one in Prisma** (nor are `deleteMany` / `updateMany` /
`set`) — confirmed above. And viborm's `toOneUpdateFactory` does not offer them either: it
emits exactly Prisma's seven keys. So there was no engine arm owed AND no validation key to
remove; the surface already matched, and the unit's honest deliverable is the pin that keeps
it matching. `inverse-to-one-create.test.ts` asserts the offered key set EQUALS Prisma's,
and that each to-many-only key is refused on the to-one while `create` is accepted beside
it — so the test cannot pass by the schema rejecting everything, and neither direction of
drift is silent.

### N2-U3 — the premise was FALSIFIED; re-justified, with a named gap

The plan carried the object-form `disconnect` / `delete` declines as "believed Prisma-parity
(booleans only on to-one)". The generated types say the opposite: Prisma 7.9.1 types **both
as `ProfileWhereInput | boolean`** — a filter narrowing which connected record is
disconnected/deleted, the to-one analogue of W4-U3's `update: { where, data }` wrapper viborm
already has. Two corrections follow.

1. **The object form is not a Prisma-parity refusal.** It is a genuine viborm surface gap,
   and a VALIDATION one: `toOneUpdateFactory` types both keys `v.boolean()`, so the object
   form is refused at the PARSE boundary and never reaches the engine's two throws. Closing
   it is a schema widening (`boolean | where`) plus a filtered disconnect write — an
   absorption, not a re-audit, so it is recorded as a NAMED GAP for a follow-on unit rather
   than smuggled into this wave. (The `delete` half is nearly free: `delete: true` already
   compiles to `buildToManyDeleteManyParts(writeBase, {})`, which takes a filter. The
   `disconnect` half needs the filter folded into `RelationLinkPart`'s `disconnectAll`
   write. The type-surface widening is the real cost.)
2. **What the two sites actually refuse is the literal `false`** — that is their whole
   reachable surface. Pinned in both directions (`false` throws, `true` does not), so the
   message cannot outlive its cause.

### N2 — certification

TS 5.9.3 typecheck clean; Biome clean on all 9 touched files. `pnpm test:gates`: **64
passed** (63 + the new bidirectional decline-surface entry). Whole `tests/query-engine-v2`
suite: **709 passed / 0 failed**, 45 files. Local driver legs `sqlite3` + `libsql`: **1727
passed / 0 failed**, with the new suite confirmed EXECUTED (14 tests = 7 × 2 substrates on
each). Census pinned at **76**. The Docker legs (MySQL 3307, Postgres 5434) are wired and
belong to the wave gate, not to this lane.

### N2/N3 — wave gate (independent re-run at `e2adc8b`, 2026-07-29)

N2 and N3 were cherry-picked onto one branch, so ONE gate certifies both. Every number
below was re-measured on the branch tip, each step in its own shell, one vitest at a time.
The N3 half is cross-referenced from the N3 section below rather than duplicated.

| Step | Result |
|---|---|
| `pnpm test:types` (TS 5.9.3) | clean, no output |
| Full estate, ALONE (`--minWorkers=1 --maxWorkers=4`) | **8452 passed / 0 failed**, 1705 skipped (Docker-gated); 250 files passed, 4 skipped; 392s (8327 at the N1 gate) |
| `pnpm test:gates` | **66 passed / 66**, 5 files (63 at the N1 gate; +1 N2 decline-surface entry, +2 N3) |
| Census pin | **76** (`route-inventory.test.ts:961`), the merged value. The count-evolution log carries both lanes' entries with the MERGE NOTE reconciling file order (N3 then N2) against commit order (N2 then N3): 77 −1 +1 +0 (N3) then −1 (N2) = 76, or 77 −1 (N2) then −1 +1 +0 (N3) = 76. The pin is measured by counting sites, never derived from that arithmetic |
| Biome (repo-pinned, per file — multi-path invocations silently process 0 files here) | all 27 changed `.ts` files exit 0 — **zero** violations, so zero NEW violations by construction; no `main`-baseline comparison needed |
| Docker MySQL 3307 (`pnpm test:mysql`) | **788 passed**, PASSED not skipped (750 at the N1 gate; +38) |
| Docker Postgres 5434 (`pnpm test:pg`, serial) | **896 passed**, 14 skipped, PASSED not skipped (858 at the N1 gate; +38) |

Both waves' witnesses were confirmed **executed** (not collected-and-skipped) on both
Docker legs, on both substrates each — the +38 on each leg is exactly them:
`inverse to-one create (N2)` runs **7 tests under `transaction` and 7 under `atomic
batch`**, and `junction createMany + upsert identity (N3)` runs **12 and 12**, on MySQL and
on pg alike (14 + 24 = 38, counted per leg).

**One correction to the two certification blocks, measured not argued.** Each lane
measured `pnpm test:gates` from a tip carrying only its own entry — N2 recorded **64**
(63 + 1) and N3 recorded **65** (63 + 2). Neither number is wrong for the tip it was taken
on; the merged branch runs **66**, and 63 + 1 + 2 = 66 is the whole reconciliation. Docker
MySQL 3307 and Postgres 5434 were already up (23h) and were not restarted.

## N3 — M2M completions (after N1; junction machinery)

| Unit | What |
|---|---|
| N3-U1 | Nested **`createMany` through a junction** (`tags: { createMany: { data: [...] } }` under create and update roots), skipDuplicates included, generated target PKs via the existing produced-identity path. |
| N3-U2 | **upsert-through-junction with a generated create-arm PK** — the dedup ledger learns the create-data-unique identity source W4's closure gave plain upserts. |
| N3-U3 | Compound-PK M2M: measure what the correlation-utils refusal actually protects; absorb per-field or re-justify. |

### N3-U1 — delivered

`createMany` was the **last** `RelationMutationKind` with no junction arm, so
`buildJunctionParts`' `default:` — "does not support nested `createMany` on many-to-many
relation" — was a catch-all standing in for exactly one kind. It is absorbed with **no new
mechanism**: `createMany` reuses the `create` slot (per-row child INSERT then join row, the
produced-identity backward `Ref` when the target key is DB-generated, the same
one-level-deeper fold), and `skipDuplicates` rides each row's INSERT through
`buildCreateMany` — the SAME builder the root and child-held `createMany` families use, so
the per-dialect split (`ON CONFLICT DO NOTHING` / `INSERT OR IGNORE` as a SQL leaf, the
savepoint-wrapped `onUniqueConflict: "skip"` effect on MySQL) is decided in one place and
V1's `assertPortableCreateManySkip` default-only-row guard comes free, unduplicated. Under
the CREATE root the shape opens by adding `createMany` to `assertCreateTreeKinds`'
allowlist; that site narrows rather than disappears (the remaining kinds address a
PRE-EXISTING membership a fresh parent cannot have). With every kind handled, the
`default:` becomes an exhaustiveness `never` check — a `QueryEngineError` internal
invariant, not a route. Census **77 -> 76**.

**The semantics of `skipDuplicates` here are a CHOICE, pinned deliberately** — Prisma has
no M2M `createMany` to match. The skip drops the CHILD ROW's insert; the JOIN ROW is a
different row, never itself a duplicate of what the data spells, and is written for every
item. A duplicate item therefore leaves the pre-existing target untouched AND still links
it. The rejected alternative — skip the join too — is not decidable at compile without a
probe, and would make a duplicate item silently do nothing, unobservable to the caller.
Both halves are asserted on ONE call in `junction-create-many-behavior.ts`.

**The absorption REQUIRES one new refusal** (census **76 -> 77**): `skipDuplicates` with a
DB-generated target primary key. A skipped INSERT writes no row, so it produces no
identity, and every dialect degrades differently. Measured, refusal deleted, SQLite3
batch-only, `n3_labels` seeded `other`=1 then `existing`=2, article=1: `labels: {
createMany: { data: [{ slug: 'existing' }], skipDuplicates: true } }` **resolved
successfully and joined the article to label 1 (`other`)** — not label 2, the row the data
named. No error, no constraint violation: the junction foreign key was satisfied by the
stale `insertId`. The same mutation on the RETURNING transaction path fails loudly
(`TransactionError: Step 'label.create' did not produce row field 'id'`), which is why this
has to be a construction-time refusal rather than a lowering the executor catches. Both
escapes (supply the key, or drop `skipDuplicates`) execute.

Witnesses: `junction-create-many-behavior.ts`, 12 tests per substrate, on PGlite (tx +
forced batch) and every driver leg — both roots, explicit and DB-generated target keys, the
N1 located-parent Ref composition (an update located by a non-PK unique, with a decoy
asserted empty), `skipDuplicates` conflict counting (the duplicate's colour survives AND it
is linked), the no-`skipDuplicates` fail-closed duplicate, the empty-`data` no-op, and the
generated-key refusal with nothing written. MySQL's batch leg declares
`skipDuplicatesInBatchIsInexpressible` (the savepoint effect has no atomic-batch lowering)
and asserts the typed refusal with nothing written. Falsified: re-adding the refusal to the
`createMany` arm fails **14 of the suite's 24** PGlite witnesses.

### N3-U2 — delivered

`requireCreatePk` refused EVERY junction upsert create arm whose data omitted the target
primary key, on the stated ground that the arm's same-operation dedup ledger and its
duplicate-item UPDATE address the target by that literal. W4's closure gave the plain
`upsert` a second identity source — a create payload spelling a COMPLETE unique constraint
names the row it is about to insert — and the junction arm now takes the same one.
`createDataUniqueWhere` moved to `shared.ts` so both askers ask once (the X2 one-home norm).
The three needs split across the two sources: the **join row** rides the produced `Ref` the
create / connectOrCreate arms already build; the **ledger key** and the **duplicate's
UPDATE `where`** ride the create-data unique. No `Ref` ever reaches a `where`, and the
identity derives from the row the INSERT ACTED ON (its own data), never from re-reading the
item's `where` — the W4 wrong-row doctrine. The site survives, narrowed, with its message
naming exactly what is missing. Census **77 -> 77**.

**Honest qualification, measured while doing this.** The ledger justification the old
refusal rested on is currently **vacuous**: the own-write preflight rejects any SECOND
`upsert` item on one many-to-many relation — even two items with disjoint explicit primary
keys — because a junction upsert reads membership and an earlier item writes it (A14). So
`compileUpsert`'s duplicate branch is unreachable from the client and operation surfaces,
and the refusal it justified was stricter than any reachable behavior required. The ledger
is keyed correctly here anyway rather than left to mis-key if the preflight ever relaxes,
and the unreachability is now pinned by its own witness ("TWO upsert items on one M2M
relation are the own-write preflight's, not the ledger's") that fails the moment the
preflight changes.

One estate test was **retargeted**, from a decline to an accept-and-execute assertion on
the SAME payload: `many-to-many-behavior.ts`'s "upsert through the junction with a
generated create-arm PK is an explicit typed refusal" is now "… creates a target whose PK
the database generates", asserting the join row carries the id THIS INSERT produced and not
a decoy label's. Falsified: reinstating the literal-primary-key-only requirement fails **4
of the 24** PGlite witnesses.

### N3-U3 — re-justified, not absorbed (measured)

Both refusals fire at construction / DDL before any I/O, and they agree:
`getRequiredSinglePrimaryKeyField` (`correlation-utils.ts:260`, a `QueryEngineError`) and
`getPrimaryKeyFieldDef` (`migrations/serializer.ts:487`, a plain `Error`) both say
"Many-to-many relations with compound PKs are not supported". Neither is an
`UnsupportedOperationError`, so neither was ever in the census — N3-U3 changes no count.

**What the refusal protects, measured rather than argued.** This is NOT the shape the T-era
compound-FK work generalized. That work widened code that ALREADY looped index-aligned over
`fkFields` / `pkFields` — the foreign-key vocabulary was per-field before it was compound.
The junction vocabulary is scalar *to its root*:

1. **The public schema API cannot spell it.** `.A(fieldName: string)` / `.B(fieldName:
   string)` name exactly ONE junction column per side, and their state types, their
   pair-agreement check (`state.A !== paired.B`), and the self-referential-pair rule are all
   single-string. A compound side needs N column names per side — a public API change, not
   a generalization.
2. **`ManyToManyJoinInfo`'s six fields are scalar**, with **92 references across 7 files**
   (`migrations/serializer.ts`, `OwnWriteLedger.ts`, `RelationMembership.ts`,
   `ManyToManyStatements.ts`, `builders/many-to-many-utils.ts`, `schema/relation/helpers.ts`,
   `query-engine-v2/RelationJunctionPart.ts`).
3. **Every junction value is one `Sql`**: `buildJunctionParentValue` / `buildJunctionTargetValue`
   return a single value, `buildJunctionTargetIn` builds a scalar IN-list,
   `buildTargetPkSubquery` selects one column, `membershipRead` selects `{ [targetPkField]:
   true }`, and `RelationJunctionPart` addresses every target by `{ [targetPkField]: pk }`,
   dedups on `pkKey`, reads `pkOf(row)`, and captures ONE generated column.
4. **The migration DDL is two columns**: a fixed 2-column table with a 2-column primary key,
   one index and two single-column foreign keys.

So the query side and the migration side are inseparable here for the reason the matrix
already documents (a schema that migrates but cannot query is the vector/JSON-column
mistake) — and *both* are gated behind an API that cannot name the columns. Left for a named
follow-up: **"compound-key junctions"**, whose first unit is the `.A()` / `.B()` surface,
not the query engine.

### N3 — certification

TS 5.9.3 typecheck clean; Biome clean on all 13 touched `.ts` files. Every number below
measured on this branch, one vitest at a time, targeted suites (worktree lane).

| Step | Result |
|---|---|
| `pnpm test:types` (TS 5.9.3) | clean, no output |
| `pnpm test:gates` | **65 passed / 65**, 5 files (63 -> 65: the two N3 side-1 witnesses) |
| `tests/query-engine-v2/` | **712 passed / 0 failed**, 45 files |
| Local driver legs (sqlite3 + libsql + pglite, both substrates each) | **2450 passed** |
| Docker MySQL 3307 (`tests/drivers/mysql2.test.ts`) | **774 passed** (750 at the N1 gate; +24 = the N3 suite, 12 per substrate) |
| Docker Postgres 5434 (pg + postgres.js, serial) | **882 passed**, 14 skipped (858 at the N1 gate; +24) |
| Census pin | **77** — unchanged in TOTAL, changed in COMPOSITION: -1 (the junction `default:` arm) +1 (the `skipDuplicates` + generated-key refusal). Both edits are written into the count-evolution log with their falsifications |

The N3 witnesses were confirmed EXECUTED (not collected-and-skipped) on both Docker legs,
on both substrates each: `junction createMany + upsert identity (N3)` runs 12 tests under
`transaction` and 12 under `atomic batch` on MySQL and on pg.

Three estate tests were RETARGETED, each from a decline to a truthful replacement on the
same family, each noted in place:
  · `many-to-many-behavior.ts` — "upsert through the junction with a generated create-arm
    PK is an explicit typed refusal" -> "… creates a target whose PK the database
    generates" (N3-U2 absorbed the shape).
  · `unsupported-operation-error.test.ts` — its live-refusal specimen WAS that same upsert
    shape; it now uses the refusal N3-U1 added (M2M `createMany skipDuplicates` with a
    DB-generated target key), which is in the same family and on the same relation.
  · `capability-matrix-2026-07.md` §1.5 and §3.B rows, and `compatibility.mdx`'s nested-write
    section, which claimed `createMany` worked in both contexts while the M2M arm refused —
    the absorption makes the published claim true, and the surviving boundary is now stated.

### N3 — wave gate (independent re-run at `e2adc8b`, 2026-07-29)

N3 is certified by the SHARED N2/N3 wave gate recorded above (the two waves were
cherry-picked onto one branch, so one re-run answers for both). The N3-specific readings
from it: `pnpm test:gates` **66 / 66** — not the 65 this lane measured, because that number
was taken from a tip without N2's decline-surface entry (63 + 1 N2 + 2 N3 = 66); census pin
**76**, not the 77 this lane measured, because N2's deletion lands on the same count (N3's
own −1 +1 +0 is still zero net, and the MERGE NOTE in the count-evolution log carries the
reconciliation); Docker MySQL **788 passed** and Docker Postgres **896 passed / 14 skipped**,
each +38 over the N1 gate, of which N3 is 24 (12 per substrate) and N2 is 14 — all confirmed
EXECUTED by name on both legs. The lane's own targeted-suite numbers
(`tests/query-engine-v2/` 712, local driver legs 2450) were measured before N2 was
cherry-picked and are superseded by the full-estate figure **8452 passed / 0 failed**.

## N4 — Depth-seam boundaries (after N1; B3/B8/B9)

| Unit | What |
|---|---|
| N4-U1 | **Locate-by-any-unique for relation-carrying targets** (B3): a nested `update`/`upsert` addressed by a non-PK unique that carries deeper writes — the locate read returns the PK, deeper FKs Ref it. Removes `must locate the target by its primary key`. |
| N4-U2 | The **create-arm one-level-deeper guards** (B8: connectOrCreate/upsert create-arm nested kinds) — absorb with the recursive child-Part builder + Refs; each absorbed kind gets a depth witness. |
| N4-U3 | **createMany under a planned parent** (B9's live tripwire, `nested-target-parts.ts:537`) — the decline-surface gate's named backlog item. |
| N4-U4 | **Shared-PK edges** (B1): non-literal fold values Ref the producing step. |

### N4-U1 — delivered (two sites deleted, one replaced, one narrowed)

The three "must locate the target by its primary key" sites had one cause and three
homes, and the cause was never that the key was unknowable — it was that only the
`where` was allowed to say it. Each of those parts ALREADY locates its target and
already spends that row's primary key on its own write:
`RelationWritePart`'s correlated probe (`select { pk }`, `capturedPk` addresses the
self-UPDATE), `RelationUpsertPart`'s widened unique probe (`identitySelect` = pk ∪ fk),
`RelationJunctionPart`'s target-slot membership read (`select { targetPk }`,
`requireTarget` spends it on the join row). So the deeper edges take a `planned` source
into that same read — the same move N1 made at the update root, one level down.

Mechanically: the probe gains a `firstRowField` output for the key (so the deeper
PLANNING probes can `Ref` it in SQL) alongside the `rows` the compile-time inline
already reads, and — because that extraction is eager — the family's own verbatim
target-not-found postcondition, which is `UpdateOperation.buildParentHeldUpdate`'s
existing shape for exactly this reason. Two of the parts needed their probe id
allocated by the BUILDER rather than the constructor, because a `ParentIdSource` is a
value the child Parts are built with, so the id must exist before the payload folds.

Two boundaries survive, and both are absences of a value rather than missing wiring:

* the **upsert CREATE arm** inserts a fresh row, so its key must be SPELLED (by the
  `where`, or by the create data — `assertMatchingCreateIdentity` already reconciles
  the two). A DATABASE-GENERATED key with grandchildren is refused, and the refusal is
  a NEW, narrower site replacing the old one — the census count is unchanged there and
  that is the honest number.
* the **junction UPSERT arms** keep the old refusal: an upsert's update arm is also
  reachable by the created-earlier branch, whose global probe ran BEFORE this
  operation's own INSERT and located nothing.

Not absorbed, and named: a COMPOUND-primary-key target at these seams never reaches
the located-key question — every path refuses earlier on the child's own key ARITY
(sweep entry (i)), which no parent-side dataflow supplies.

### N4-U3 — delivered

`nested-target-parts.ts`'s "does not support a nested createMany … under a parent-held
target one level deeper" was guarding nothing: N1-U1 had already built
`buildPlannedParentCreateManyPart`, and the `create` case two lines above already
dispatched literal-vs-planned. The edit is that dispatch, verbatim. N3's
`skipDuplicates` wall does not recur — there the identity was PRODUCED by an INSERT a
skip might not run; here it is READ from a probe that has already run — so the skip
disposition is the literal leaf's, unchanged per dialect.

The decline-surface gate's named tripwire was this shape, so it is RETARGETED to the
junction upsert arm above (a still-declining, still-measured boundary), and the
absorbed shape moves to the gate's side-1 list.

### N4-U2 / N4-U4 — deferred by the first lane, DELIVERED here

The first N4 lane did not reach them. Sweep entry (g)'s reading was right and is what
this wave built on: these sites are on a CREATE root, which has no locate step, so the
absorption needs the producing INSERT's returned identity rather than a located-parent
read. **N1/N4-U1 answered "the row the step ACTED ON"; these two units answer the other
half of the same doctrine — the row the step PRODUCED, read out of the statement that
produced it.**

### N4-U2 — DELIVERED. Census 74 → 68 (six sites, one sentence).

**The sentence:** the adopt family's create arm PRODUCES its row, and a produced row's
relations are the create ROOT's surface. Everything else follows.

**Measured first, live, before anything was touched** (PGlite, the messages recorded per
shape). The reachable create-arm surface one level deeper is `create` / `createMany` /
`connect` / `connectOrCreate` / `upsert` — the parse boundary does not OFFER
`update`/`updateMany`/`delete`/`deleteMany`/`set`/`disconnect` inside a create payload
(a `ValidationError`, X2), so those never reached any of these sites. That reachable
surface is *exactly* what `CreateOperation` builds for a fresh root, m2m and
before-parent to-one arms included. So the arm is now a create SUBTREE — X1b's
`nestedFresh` reuse, which `nested-target-parts` already used for a relation-carrying
fresh nested `create` at depth. One home for the fresh create tree, not two.

The seam is INJECTED (`FreshArmBuilder`, a type-only import — the `NestedChildBuilder`
convention) because `CreateOperation` imports the adopt-family builders; a runtime import
the other way would close a cycle. `CreateOperation.nestedFresh` gained one field,
`rootRacePin`, so the arm's raceable missing-premise pin rides the subtree's ROOT record
INSERT — the statement that used to be the arm's own leaf. The Pin Rule is unchanged.

Five sites DELETED (`createArmParentId`'s database-generated-key refusal — added by
N4-U1 three commits earlier, on a reason true of the leaf and not of the shape;
`foldParentHeldConnect`'s three; `assertMatchingCreateIdentity`) and one CONVERTED to a
`QueryEngineError` (`RelationWritePart`'s "does not support nested relation writes in its
create arm", now unreachable by construction — the N2-U1/X1c disposition). Two sites
NARROWED and re-justified rather than absorbed: the update arm's one-level-deeper bound,
and its m2m / parent-held-to-one `create` refusals. The update arm's target is LOCATED,
not produced, and closing it needs machinery this module cannot import without a cycle
(`buildNestedTargetChildParts`) plus X1c's whole-target delegation for a CONDITIONAL arm
— named, not smuggled in.

**The connectOrCreate already-exists arm still runs none of the create arm's children**,
and that is asserted rather than assumed: a found arm whose create payload carries both a
`create` grandchild and a parent-held to-one `create` leaves both tables untouched while
the reparent lands.

### N4-U4 — DELIVERED. Census 68 → 68; three sites narrowed, one capability added.

**The honest finding first.** Sweep (g) named the shared-primary-key edge as this unit's
headline, and that shape was never reaching a census site. Measured:
`profile.create({ data: { bio, user: { create } } })` with `profile.userId` as both
primary and foreign key and `user.id` database-generated failed with a `NestedWriteError`
from `planNestedCreateIdentity` — "requires primary key field 'userId' to be known before
execution" — several frames before `interpretParentHeld`'s `UnsupportedOperationError`.
Absorbing it moves no count. What it moves is the capability.

**The absorption.** The record's foreign key already referenced the target's produced
identity by a backward `Ref` (since T1). The shared primary key IS that column, so the
record's identity — and the terminal read that addresses the created row — is that same
`Ref`. `resolveSharedPkIdentity` now resolves a produced source as well as a literal one,
pre-allocating the before-parent INSERT's step id so the `Ref` and the statement agree
(the N4-U1 allocation-order precedent), and `terminalIdentity` lowers a `Ref` identity
member exactly as the generated-key branch beside it already did.

**The three narrowed sites** (`referencedValue`, `edgeParentId`,
`targetReferencedValue`) read a fresh record's identity as its PRIMARY KEY alone, so an
edge referencing one of its other uniques (`badge.userCode -> user.code`, the D4 shape on
a create root) found nothing — while the value sat in the same create data the primary key
came from, one column over. One resolver (`freshReferenced`) now answers all three from
the widened identity, and each keeps its refusal for what is genuinely absent. What
"knowable" excludes has a named job: an `Sql` operand would be EVALUATED A SECOND TIME
for the foreign key, and two evaluations of `gen_random_uuid()` are two values.

**The survivors, measured.** The shared-primary-key site is reachable only when the
foreign-key column is itself declared `.increment()`, and its two live causes are genuine:
a `connect` by a NON-referenced unique resolves its FK through a lookup SUBQUERY (whose
re-evaluation for the identity is a second provenance of the row the arm's probe already
located), and a `connectOrCreate` decides its arm at compile, so one identity does not
describe both.

### N4-U2 / N4-U4 — witnesses, and what makes them falsifiable

`produced-identity-depth-behavior.ts` — 9 shapes × both substrates, wired into all four
driver files, every assertion naming the ROW: the create arm folding m2m + a before-parent
to-one + a child-held create at once; the connectOrCreate found arm running none of it;
grandchildren following a database-generated key with a decoy holding the lower one; a
create arm whose data names a DIFFERENT key than the `where`; the surviving update-arm
m2m refusal with nothing written; the shared-PK produced and spelled identities agreeing
on state; the D4 child edge and the D4 after-parent adopt.

`produced-identity-provenance.test.ts` — the instrument the claims actually need, N1's
corrupt-driver aimed at a PRODUCED value: rewrite what the INSERT RETURNED to another
LIVE row's key, and the child must follow the corruption. **The discrimination is
measured, not asserted.** Re-deriving a fresh record's generated key from its own spelled
unique (a subquery — the plausible alternative implementation, and the exact
re-consult-the-input failure mode) passes ALL 18 behavior-suite state assertions, because
every decoy differs from its target in the very column the payload spells; it fails
EXACTLY the create-arm provenance witness. The same re-derivation on the before-parent
target's key fails EXACTLY the shared-PK witness, whose two halves — the child's foreign
key and the terminal read that returns it — must both follow the corrupted value. Taking
the create arm off the subtree fails 16 of the 78 tests in the four affected files.

Two estate tests were RETARGETED from a decline to an accept-and-execute assertion on the
SAME payload, each with the reason written at the site:
`depth-seam-behavior.ts`'s generated-key create-arm refusal (N4-U1's, three commits old)
and `create-nested-upsert.test.ts`'s create-arm `connect` bound — an assertion that had
already been walked down this one shape twice.

### N4-U2 / N4-U4 — certification (main repo, one vitest at a time)

| Gate | Result |
|---|---|
| `pnpm test:types` (TS 5.9.3) | clean |
| Biome (repo-pinned, per file over the wave's 18 changed/new `.ts` files) | 0 diagnostics |
| `tests/query-engine-v2/` | **839 passed / 0 failed**, 50 files (816 at the N4/N5 gate; +18 behavior +3 provenance +2 gate) |
| `pnpm test:gates` | **72 / 72** (70 at the N4/N5 gate; +2 N4-U2/U4 side-1 witnesses) |
| Census pin | **68**, re-derived by RUNNING `route-inventory.test.ts`; the log's chain closes … 74 → 74 → **68** (N4-U2) → 68 (N4-U4) |
| Parse-boundary ratchet | 37 → **36** payload casts, 22 → **21** shape-check messages, both dropped in lockstep with `foldParentHeldConnect`'s removal (the equality tripwire forces it) |
| Local dialect legs (sqlite3 + libsql + pglite) | **2618 passed / 0 failed** |
| Docker MySQL 3307 | **858 passed / 0 failed** (840 at the N4/N5 gate; +18) |
| Docker Postgres 5434 (serial, pg + postgres.js) | **966 passed / 0 failed**, 14 skipped (948; +18) |
| Full estate, ALONE (`--minWorkers=1 --maxWorkers=4`) | **8696 passed / 0 failed**, 1845 skipped, 254 files + 4 skipped (8637 at the N4/N5 gate; +59 = 18 PGlite + 3 provenance + 2 gate + 18 sqlite3 + 18 libsql) |

The new suite was confirmed **EXECUTED, not collected-and-skipped**, by name on every leg:
`-t "produced identity at depth"` reports exactly **18 passed** on libsql, on sqlite3 and on
Docker MySQL (9 shapes × 2 substrates), and the +18 deltas on both Docker legs are those
same tests. One measurement note for a future gate: the pg leg's connection string is
`postgresql://postgres:password@127.0.0.1:5434/viborm` — a wrong password does not skip the
suite, it fails 939 of 980 tests including "creates driver with connection string", which is
the signature of a credentials problem rather than a regression.

### N4-U2 / N4-U4 — wave gate (independent re-run at `b0b2907`, 2026-07-30)

The certification above predates the two review fix rounds. The reviewers' verdict was
the same finding from opposite ends: six create-arm kinds counted in the 74 → 68 census
delta, three exercised by nothing, and the update-arm subtree asker (`MUT3A-UPD`)
exercised by nothing — capability real, coverage missing. `6717aaf` (fix round 1) and
`b0b2907` closed it with four row-asserting witnesses: the create-arm grandchild as a
SUBTREE (third write level + parent-held connect by a NON-referenced unique), the
update-arm sibling against the row the arm LOCATED, the fresh m2m target + child-held
reparent pair, and the deeper upsert's global probe pinned as a choice on both arms.
Falsified per family: rebinding the update-arm fold fails exactly the 2 update-arm
witnesses; restoring the pre-N4-U2 create-arm bound fails all 14 create-arm witnesses
(7 shapes × 2 substrates). `b0b2907` also carried the shared schema's new `ownerId`
column into the decline-surface gate's row expectation. Two API-killed fix attempts left
uncommitted drafts; both were audited and finished rather than discarded, and the second
draft is most of `b0b2907`'s witness text.

| Gate | Result |
|---|---|
| `pnpm test:types` (TS 5.9.3) | clean |
| Full estate, ALONE (`--minWorkers=1 --maxWorkers=4`) | **8729 passed / 0 failed**, 1865 skipped, 255 files + 4 skipped (8637 at the N4/N5 gate) |
| `pnpm test:gates` | **72 / 72**; census pin **68** re-derived by running `route-inventory.test.ts` |
| Biome (repo-pinned, per file over the fix's 2 touched files) | 0 diagnostics |
| Docker MySQL 3307 | **868 passed / 0 failed** (840 at the N4/N5 gate); 28 produced-identity witnesses executed by name |
| Docker Postgres 5434 (serial) | **976 passed / 0 failed**, 14 skipped (948); 28 produced-identity witnesses executed by name |

### N4 — certification

TS 5.9.3 typecheck clean; Biome clean on every touched file (measured against a
stashed-baseline count on the same file set). `pnpm test:gates` **69 passed / 69**
(up from 66 — three new side-1 witnesses). V2 suite **766 passed / 0 failed** (up from
735). Local dialect legs: sqlite3 937, libsql 894, pglite 703, all 0 failed. Census pin
**74** (was 76), with the count-evolution log carrying the 76 → 75 (U3), 75 → 74
(U1 site 1), 74 → 74 replacement (U1 site 2) and 74 → 74 narrowing (U1 site 3) entries.

Falsification, one refusal restored at a time against the 28-test PGlite witness pair:
`RelationWritePart` fails 6, the planned `createMany` 8, the upsert update arm 2, the
junction update 4 — and the suite is 28/28 with all four absorptions in place.

**Not run in this lane** (worktree memory bound): the full estate and the two Docker
legs. The new shared suite is wired into all four driver files (pg, mysql2, sqlite3,
libsql) so those legs execute it when a main-repo agent runs them; the mysql2 batch leg
declares `skipDuplicatesInBatchIsInexpressible`.

### N4 — wave gate (independent re-run at `c2714df`, 2026-07-30)

The lane's two deferrals are now discharged, and the gate was re-run after fix round 2
landed (the merge certification's numbers above predate it). Every step in its own shell.

| Gate | Result |
|---|---|
| `pnpm test:types` (TS 5.9.3) | clean |
| Full estate, alone (`--minWorkers=1 --maxWorkers=4`) | **8637 passed / 0 failed**, 1809 skipped, 252 files + 4 skipped (baseline at `f49047b`: 8452 / 0) |
| `pnpm test:gates` | **70 / 70** (baseline 66; +3 N4 side-1 witnesses, +1 N5) |
| Census pin | **74**, re-derived by RUNNING `route-inventory.test.ts`; the log's arrow chain closes 76 → 75 → 74 → 74 → 74 → 73 → 73 → 73 → 74 → 74 |
| Biome (repo-pinned, per file over `git diff --name-only main..HEAD`) | **0 diagnostics on all 39 files** — no new violations |
| Docker MySQL (3307) | **840 passed / 0 failed** (baseline 788) |
| Docker Postgres (5434, serial) | **948 passed / 0 failed**, 14 skipped (baseline 896) |

The lane's deferral is specifically answered: the N4 witnesses **EXECUTED, not skipped**,
on both Docker legs and on both substrates. MySQL ran 28 `depth-seam boundaries (N4)`
tests (14 transaction + 14 atomic batch, every one green, including the batch leg's
`skipDuplicates` arm under its `skipDuplicatesInBatchIsInexpressible` declaration);
Postgres ran the same 28.

## N5 — Ordering boundaries (independent of N1 mechanics; can run parallel to N4)

| Unit | What |
|---|---|
| N5-U1 | **B5 — nested adopt / child-edge writes under a non-cascade PK transition** (`RelationWritePart.ts:637` and the A15 adopt refusal): the plan-of-record fix is ORDERING — self-UPDATE after cascade-safe edges, or edge-writes against the post-transition id via Ref. "Routed for correctness, not inexpressibility" (PLAN §1314) — this is the wave that proves it. The T4c wrong-row witnesses are the falsification bed. |
| N5-U2 | B10 residue (located-only pre-transition PK, compound generated PK, non-portable arithmetic) — absorb what N1+N5-U1 machinery covers; re-justify the remainder with measured reasons. |

### N5-U1 — DELIVERED (the root adopt family). Census 76 → 75.

The plan's claim was that these routes exist "for correctness, not inexpressibility", and that
ORDERING is the fix. Measured at the root, that is exactly what the A15 refusal was.

**What it actually refused.** `list.update({ where: { id: 1 }, data: { id: 5, items: { connect } } })`
— a `connect`, `connectOrCreate`, `set`, or to-many `upsert` on a child-held relation whose
referenced primary key the same root update transitions, with a NON-cascade foreign key.
Reachable in ordinary schemas: `fk.onUpdate === "cascade"` is the only exemption, so a relation
that never spells `onUpdate` at all takes this path.

**Why it refused.** Its own words: an adopt "writes a fresh FK on the pre-transition value,
orphaned by the referential action". True — of the ORDER the parts were emitted in. Every child
Part of an update root was written before the root UPDATE, so an adopt could only ever bind the
id the transition was about to vacate. Nothing else about the shape was hard.

**What closed it.** Two facts the same code path already had:
1. the OLD slot is proven EMPTY by the CLASS IV occupied guard that method emits three lines
   later, so nothing is being moved off the dying id; and
2. the POST-transition value is a compile-time literal there — the `after` the method already
   computes with `getUpdatedPrimaryKeyValue`, and already hands to the to-one upsert create-arm
   reroute (T4c) and, by the same derivation, to the T4b transitioned-PK create leaf.
So the four adopt kinds take `after` and are ordered AFTER the root UPDATE, on the T4b
`afterRootCreateParts` list — renamed `afterRootParts` and generalized from "transitioned-PK
create leaves" to "every child write whose FK is the post-transition value", with GUARD steps
still hoisted to the front. No `Ref` was needed and no vocabulary moved: the value was already
a literal, the plan was already spellable, and it was being emitted in the one order that made
it illegal.

**The one mechanism genuinely missing**, now built: `RelationSetConfig.correlationParentId`.
`set` is the only adopt member that READS existing membership as well as writing it — its
departing half asks "which rows carry my key today" (a correlated planning read, and on a
REQUIRED child FK the orphan rejection), its target half writes "carry my key from now on".
Those coincide everywhere except under a transition. The field splits them and defaults to
`parentId`, so every other caller is byte-identical.

**Not changed:** the occupied guard (the accept-shape moved, the legality did not), the cascade
path's pre-transition + reorder ordering, and the to-many upsert's uncorrelated verdict — which
was MEASURED to equal its verdict with no transition in the payload rather than assumed.

**At depth (`RelationWritePart.ts`, the other half of N5-U1).** A nested update TARGET
rewriting its own primary key while carrying a deeper edge had the same shape and the same
fix, and the old refusal named the alternative itself: "V1 orders the edge against the
POST-transition id instead". It now does. The one thing ordering alone would NOT have
given is the LEGALITY: an occupied old slot, which the root rejects typed, would otherwise
have let the referential action silently null those children. So CLASS IV's read+verdict
pair became a Part (`RelationKeyOccupiedPart`) — the root's version rides the operation's
`relationKeyGuards` list because the root has one; at depth there is no list, and a Part is
what the architecture already provides. One rule, two depths, one message.

The refusal that replaces it is strictly narrower and its reason is measured: a junction
reads MEMBERSHIP at PLANNING, correlated to the parent key, and planning runs before the
self-UPDATE writes the new one — so a payload carrying BOTH a junction edge and a
non-cascade child-held edge on one transitioning target has no single ordering that serves
both. A junction alone still cascades; a non-cascade edge alone is absorbed. Closing the
mix needs `correlationParentId`'s two-source split carried into `RelationJunctionPart`.
Census net 75 → 75 (one site deleted, one narrower site added in the same place).

**Evidence.** `tests/query-engine-v2/post-transition-adopt-behavior.ts` (10 final-state
witnesses on every driver leg and both substrates) + `post-transition-adopt.test.ts` (the
statement-order and bound-value claims, plus the no-transition byte-identity half). Falsified
three ways — writes before the root UPDATE: 15/22 fail; located source instead of `after`:
15/22 fail; no `correlationParentId`: the required-FK `set` dies with "requires a planned parent
id to correlate its probe". Gate count 66 → 67 (one added N5 entry in the decline-surface gate).

### N5-U2 — DELIVERED (the B10 residue). Census 75 → 75; two sites narrowed, one re-justified.

Sweep entries (a) and (b) both existed to protect one thing: the POST-transition value a
fresh child must reference when the root SET rewrites the column its foreign key points at.
(a) refused a compound reference because the tuple is per member; (b) refused an unpinned
single key because the pre-value was not a construction literal.

**Neither reason applies when the edge cascades**, because then no post-transition value is
needed: write the fresh row against the LOCATED pre-transition values, before the root
UPDATE, and `ON UPDATE CASCADE` carries it. That is the ordering a reparent has had since
T3b1, applied to an INSERT, and `locatedCreateParent` (N1's per-field source) is entered
unchanged — so arity and pinning both stop mattering. Witnessed on every driver leg and
both substrates: a cascading key transitioned under a `where` naming a different unique
((b)'s shape), and a cascading COMPOUND key with both members rewritten ((a)'s).

**The survivors, measured.** A NON-cascading rewrite whose pre-value the `where` does not
pin, or any non-cascading compound rewrite. The needed SQL is a plain
`INSERT … VALUES (<new key>)` and its place in the ladder is already decided — the gap is
that no PARENT-ID SOURCE can name that value. All three kinds are fixed at construction:
`literal` (a value), `planned` (a located column, verbatim), `ref` (a SQL reference); none
transforms. One field closes both: a `planned` source carrying the SET operand, resolved
through `getUpdatedPrimaryKeyValue` in `referencedFieldValue` at compile.

**Sweep (d) is re-justified, and the sweep's own framing of it was incomplete.** It named
"a correlated read of the pre-transition slot ordered BEFORE the self-UPDATE" as the fix.
That half is right and cheap — the occupied guard's probe is a planning step and may carry
a `Ref` to the locate. Measured, the other half: the literal `before` also feeds the
**no-op test** (`sameScalarValue`), which is what makes `increment: 0` and same-value `set`
emit NO guard — pinned by two tests in `relation-key-update-legality.test.ts`. A
Ref-correlated guard without that decision moved to compile would reject an occupied slot
the engine deliberately accepts today: a regression, not a boundary. So (d) needs the no-op
verdict moved to compile first, and its unpinned third additionally needs the same
transforming source (a)/(b) name. Kept as one site rather than pre-split.

### N4 × N5 — the merge, and the one refusal it created

The two lanes ran in parallel off `f49047b` and were cherry-picked onto the branch N4
first. They edit disjoint sites and one shared file, `RelationWritePart.ts` — N4 in
`interpretChildParts`' parent-id provenance, N5 in the transition ordering and the new
`RelationKeyOccupiedPart`. Both lanes measured their census delta from **76**, so the
running number was re-based at the merge: **76 → 74 (N4) → 73 (N5-U1) → 74 (the merge)**.
The final pin was re-derived by RUNNING the census test, not by arithmetic, and the
count-evolution log in `route-inventory.test.ts` opens with a merge note recording all of
this.

The merge is **not net-zero**, and this is the honest reason. Inside `interpretChildParts`
the two absorptions answer different questions about the same edge — N4 *where the parent
value comes from* (the `where`'s literal, else a `planned` source into this part's probe),
N5 *when the edge is written and against which side of a primary-key transition*. Their
**intersection** — a target named by a NON-primary-key unique whose SET also rewrites its
primary key, carrying a non-cascade deeper edge — needs a value neither mechanism
produces. The probe runs before the self-UPDATE, so the `planned` source reads the key the
transition is about to vacate; no `ParentIdSource` applies the SET's operand to a planned
value; and the CLASS IV occupied guard needs the same pre-transition literal to name the
slot it checks. One refusal was added for exactly that intersection.

It is strictly narrower than either site it replaces (it needs all three of a non-PK
locator, a PK-rewriting SET, and a non-cascading deeper FK, where each old site needed
one), it regresses nothing (at the shared base the payload declined on BOTH lanes' sites),
and closing it is the **same follow-on unit** N5-U2 already names for sweep (a)/(b)/(d) —
an operand-applying `planned` parent-id source. It is that unit's fourth claimant, not a
new mechanism. Witnessed and falsified in
`nested-update-pk-transition-cascade.test.ts`: the refusal is a construction-time decline
with nothing written, bracketed by the same payload located BY the primary key (executes,
N5-U1b) and the same non-PK locator with no transition (executes, N4-U1); removing it
writes the deeper edge against the vacated key.

**Why no lane could have caught this.** Each lane was green in its own worktree, and the
shape declined in both for each lane's own reason. It is a property of the intersection,
which exists only after the merge — which is why it is recorded as a merge finding rather
than folded into either lane's entry.

### N4 × N5 — merge certification (supersedes both lanes' partial numbers)

Everything each lane deferred for its memory bound was run here, once, on the merged tree.

| Gate | Result |
|---|---|
| `pnpm test:types` (TS 5.9.3) | clean |
| Full estate, alone (`--minWorkers=1 --maxWorkers=4`) | **8622 passed / 0 failed**, 1809 skipped, 252 files (baseline at `f49047b`: 8452 / 0) |
| `pnpm test:gates` | **70 / 70** (66 at base + 3 N4 side-1 witnesses + 1 N5) |
| Docker MySQL (3307) | **840 passed / 0 failed** (baseline 788) |
| Docker Postgres (5434, serial) | **948 passed / 0 failed**, 14 skipped (baseline 896) |
| Biome | clean on every file either lane touched |
| Census pin | **74**, re-derived by RUNNING `route-inventory.test.ts`, not by arithmetic |

Both Docker legs picked up the new shared suites through the four driver files, and the
two shapes N5 flagged as carrying dialect risk were confirmed green on MySQL on BOTH
substrates: the required-FK `set` under a `restrict` transition, and the COMPOUND string
primary key with ON UPDATE CASCADE.

Merge conflicts were resolved by hand in six files. Five were mechanical (both lanes
appending to the same driver-file block, the census log, the plan). The sixth,
`RelationWritePart.interpretChildParts`, was the real one and produced the refusal above;
N5's move of the PK-arithmetic portability check INTO that method was kept, since its
post-transition derivation depends on the operand already being known portable.

### N4 × N5 — fix round (two blocking findings; both were assumptions the gates could not see)

Everything above was green when it was written. Two claims in it were still false, and
neither could fail: one was data-dependent in a way no seeded row reached, the other was
a provenance claim the whole bed was blind to.

**1. "One rule, two depths, one message" was not true as shipped.** The N5-U1b entry above
says an occupied old slot became the same typed rejection at depth that it is at the root.
Measured, it was the same rejection *plus one the root does not make*: `interpretChildParts`
decided "the primary key transitions" from `Object.hasOwn(scalarData, primaryKey)` alone and
then emitted the occupied guard unconditionally. The root's counterpart,
`interpretReferencedKeyTransition`, first asks whether the transition MOVES anything —
`sameScalarValue(before, after)`, its `{ regime: "none" }` — because `id: { set: <current> }`
and `id: { increment: 0 }` write the key without vacating its slot. So `proj.update({ data:
{ id: 10, tasks: { create } } })` on an occupied `setNull` relation was ACCEPTED at the root
(pinned by "allows same-value set on an occupied setNull relation" and "allows increment
zero …" in `relation-key-update-legality.test.ts`) and REJECTED one level down,
under a message asserting a transition that was not happening. Not a regression against
`f49047b` — the shape threw `UnsupportedOperationError` there — but the wave's absorption
newly ADMITTED it and then gave it a verdict contradicting the engine's own rule.

Nothing in the estate could catch it, because the false rejection is data-dependent: with
the old slot EMPTY the identical payload runs. N5-U2's own record had already named this
exact hazard as disqualifying for sweep (d) — "a Ref-correlated guard without that decision
moved to compile would reject an occupied slot the engine deliberately accepts: a
REGRESSION, not a boundary". The lane refused to ship it at the root and shipped it at depth.

Fixed at the one site that already held both operands: `interpretChildParts` derives `after`
with `getUpdatedPrimaryKeyValue` from the where-pinned pre-value and takes the root's own
no-op verdict, so a no-op emits no occupied guard, no post-transition ordering and no
reorder, and the deeper edges bind the key the target already carries. `sameScalarValue`
moved to `shared.ts` — the split copy is exactly how one rule came to answer two ways, so
now there is one function and both levels call it. Only the where-pinned spelling can be
decided; a target named by another unique has no compile-time pre-value, which is the same
place the root's `pastSurface` leaves an unpinned one. Witnessed by two arms mirroring the
two pinned root tests, on both substrates, in `nested-update-pk-transition-cascade.test.ts`;
they fail 4/4 without the fix.

**2. N4-U1's located-parent Ref had no falsifying witness.** The depth-seam bed pairs every
absorbed shape with a decoy, and the file header claims those decoys catch both "take the
first row" and "re-read the `where`". Only the first half is true. Each decoy differs from
its target in the very column the selector names (`code: 'P-DECOY'` vs `'P-TARGET'`), so an
implementation that re-resolves that selector a second time lands on the same row and every
assertion still passes. Measured: substituting a second, uncorrelated planning read for the
`planned` source into this part's probe passed **801/801** of `tests/query-engine-v2` — the
28 depth-seam arms, the 12 cascade arms, `located-parent-ref.test.ts`, the gates, all of it.
What that silently loses is the lock: `correlatedProbeStatement` carries
`forUpdate: this.config.txMode`, so the probe's row is LOCKED and a re-read's is not.

N1 had already built the instrument for the same claim one level up
(`CorruptLocatePGliteDriver`) and N4 inherited the decoys instead. It is now aimed at the
depth probe, in `depth-seam.test.ts`: corrupt what the probe RETURNED to another live row's
key and the grandchild must follow the corruption, because that is the row the operation
acted on. Re-measured with the witness in place, the same substitution now fails **1 of
809** in `tests/query-engine-v2`, and the one is this witness — it is the only assertion in
the estate that can tell a located value from a re-derived one. Two more arms come with it —
the batch substrate's split-witness guard re-checks the located key against the selector and
aborts with nothing written (stronger, and for that reason blind to provenance, which is why
the provenance claim is measured on the transaction substrate), and a probe row missing the
key fails closed at planning on both substrates, pinning that the deeper edges Ref a
DECLARED `firstRowField` output rather than a raw row read.

**Census unchanged at 74** (re-derived by running `route-inventory.test.ts`): no refusal was
added or removed. The no-op fix narrows what reaches an EXISTING guard, and the merge
refusal's three conditions are untouched.

**What the no-op fix WIDENS, asked and measured.** Fix 1 moves a derivation that can THROW
earlier: `getUpdatedPrimaryKeyValue` raises `QueryEngineError` for an operand it cannot
resolve (`unsafeScalarUpdate`), and it used to run only on the `postTransition` branch —
now every where-pinned primary-key SET reaches it, cascade-safe ones included. The root
gates it the same way it always did (non-cascade, single-PK, pinned), so the two levels are
NOT symmetric on this point, and asymmetry is what the whole fix was about. So the widening
was measured rather than argued: all five operand spellings that can reach
`unsafeScalarUpdate` past `assertPortablePrimaryKeyUpdateInput` — `id: null`,
`id: { set: null }`, `id: { nope: 1 }`, `id: sql\`10\``, `id: { set: sql\`10\`}` — were sent
through the client at depth against a cascade-safe deeper edge, and every one is refused by
the typed parse boundary (X2) with a `ValidationError` before the engine is entered. No
payload reaches the moved derivation that did not reach it before, which is why no guard was
added to shield it: the throw stays what X1c calls a structural invariant, not a route.

### N4 × N5 — fix round 2 (one blocking finding: the third seam did not take the move)

The N4-U1 entry above says all three seams "ALREADY locate their target and already spend
that row's primary key on their own write", and calls it "the same move" at each. For
`RelationUpsertPart` that was not true. Its update arm wrote
`buildUpdate(childScope, { where, … })` — the USER'S selector — while N4-U1 handed its
grandchildren `plannedParentId(probeId, childPrimaryKey)`, the row its PROBE located, and
its batch found pin re-read the selector alone with neither the captured key nor the parent
correlation. Two provenances that were the same literal before this wave (the `where` had
to name the primary key, or the shape refused) and nothing forcing them onto one row. The
other two seams were already immune: `compileTargeted` writes `{ pk: capturedPk }` and its
guard correlates `selector ∧ fk ∧ pk` on one row; `compileUpdate` writes
`{ targetPkField: targetPk }` from the membership read.

**Measured, not predicted**, on the wave's own `depthSeamSchema` with a batch-only PGlite
driver that commits a concurrent writer in the documented technique-#1 window (after
planning, before the atomic unit) moving the unique `code: 'P-TARGET'` from project 20 to
project 10 — a project of a DIFFERENT workspace. `workspace.update({ where: { id: 2 },
data: { projects: { upsert: { where: { code: 'P-TARGET' }, update: { title, tasks: {
create } }, create } } } })` did not throw and produced three wrongs at once: the scalar
update landed on project 10 (never located), project 10 was REPARENTED from workspace 1
into 2 (a cross-parent theft, since the arm also assigns the FK), and the grandchild landed
on project 20 — one nested write, two rows. The same harness on the other two seams aborts
with nothing written. Not pre-existing as a whole: at `f49047b` this exact payload was the
typed "must locate the child by its primary key" refusal, so the wave converted a
fail-closed refusal into an accepted payload whose halves land on two rows. The
scalar-only spelling mis-wrote at the base too, and is fixed by the same change.

Reachable in production: `assertRoutedAtomicResolution` refuses `update` only when the
driver is batch-only AND non-returning, and `neon-http` / `d1` are batch-only with
`supportsReturning: true`. Transaction mode was never exposed (the probe is `forUpdate`, so
the mover cannot commit ahead of it) — which is also why the new split-witness instrument
is batch-only, and the shape's transaction leg stays the ordinary one the behavior suite
already runs on both substrates.

**Fixed by porting the immune seam's shape, one home each.** The found arm addresses
`{ [childPrimaryKey]: capturedPk }`, read through a new `locatedRow` helper that is now the
single place the located row's columns are read — the correlation decision takes its FK from
the same record the write takes its identity from, so no arm can be deciding about a
different row than another is writing. The found pin stays the one the `Probe` DECLARES
(id, premise class, failure wording, validated at construction) and compile NARROWS its
statement to that row: `selector ∧ pk = <captured>`, plus `fk = <parent>` in `correlated`
mode only — `global-adopt` reads no FK, so pinning its current parent would fail every
ordinary connectOrCreate. `foundGuardStatement` is one builder called twice (declaration,
then narrowed), which is `RelationWritePart.correlatedProbeStatement`'s own pattern, and it
emits that seam's statement shape verbatim rather than a bespoke merge. The one arm that
cannot address a located row keeps the selector and says why: the first-create-wins
duplicate's row does not exist yet — an earlier sibling's INSERT in this same fragment
makes it, under this selector.

**Every conjunct has exactly one falsifying witness** (five new arms in
`depth-seam.test.ts`, each measured by reverting that one conjunct):

| Half of the fix | Witness | Why nothing else catches it |
|---|---|---|
| the write's captured-PK address | "an UPSERT's update arm and its grandchildren spend ONE located identity" (transaction, corrupt-locate) | the batch guard aborts before a wrong address can be observed, so provenance is only visible where no guard stands |
| the pin's `pk = <captured>` | "a to-many upsert whose unique moves WITHIN the same parent refuses" | a replacement in ANOTHER parent is caught by the FK conjunct; only a sibling under the same parent isolates this one |
| the pin's `fk = <parent>` | "a to-many upsert whose located row is concurrently REPARENTED refuses" | the unique never moves, so the captured-PK pin is satisfied and the arm's own FK assignment would steal the row back |

The two headline arms (the finding's exact payload, with and without grandchildren) and the
two contrast arms (the same window on `RelationWritePart` and the junction, which already
refused) come with them: the estate had no split-witness arm for ANY seam, and now the
three seams' answers to one window are asserted side by side.

**Census unchanged at 74** (re-derived by running `route-inventory.test.ts`), and no
count-evolution entry: no `UnsupportedOperationError` site was added, removed, or changed in
reach. A runtime found pin and a write's addressed row are neither routes nor census sites.

### N4-U2 / N4-U4 — fix round (both findings were this wave's own new paths, unasserted)

Neither finding is a defect in the engine. Both are the same omission on the same unit: the
N4-U2 absorption moved a behavior onto a new statement and the estate never asserted the new
statement. Each was proved by MUTATION — delete the mechanism, watch the estate stay green —
and each fix is a witness that now fails under that same mutation.

**1. The pin the absorption MOVED had no coverage.** The adopt arm's missing premise is
enforced by the fresh row's unique constraint, and `race-retry.ts` converts the violation
into retry-and-adopt only when it matches the failed step's `racePin`. A scalar arm's pin
rides `RelationUpsertPart`'s own INSERT (asserted since P1, `create-nested-upsert.test.ts`);
a relation-carrying arm is a create SUBTREE, so this wave moved the pin to that subtree's
root record INSERT via `nestedFresh.rootRacePin` — a statement built by a different file.
Replacing `CreateOperation.buildInsertStep`'s pin with `{}` passed `tests/query-engine-v2`
839/839 and 2,293 more across `tests/query-engine`, `tests/errors` and
`tests/instrumentation`. The field was emitted and load-bearing, and nothing looked at it.

The new `produced-identity-race-pin.test.ts` pins the move from both ends. Structurally, on
BOTH substrates: the pin is on `team.create` — the subtree's root record — and on nothing
deeper (the grandchild `task.create` and the before-parent `lead.create` are unconditional
creates, whose violations are genuine errors and must never be re-run), it names the same
constraint the SCALAR spelling of the same arm names, and the FOUND branch carries no pin at
all. Behaviorally: a `BeforeBatch` driver commits a concurrent writer holding the same
`code` under a DIFFERENT primary key (so the violation can only be the pinned `code` unique,
not the primary key — the pin is attributed per constraint), and the routed operation
CONVERGES: the retry's probe finds the winner, the update arm adopts it, and the create
arm's subtree — which describes a row this call did not create — never runs. Under the
mutation all three fail, and the convergence arm fails with exactly the
`UniqueConstraintError` the pin exists to prevent.

**2. A counted census site had no witness on either substrate.** The 74 → 68 delta spent one
of its six sites by CONVERTING `RelationWritePart.upsertCreateScalarData`'s refusal into a
`QueryEngineError` — the disposition for a branch unreachable by construction. The
construction that makes it unreachable is `buildInverseToOneUpsertPart`'s subtree, and
forcing that subtree to `undefined` passed 2,698 tests across `tests/query-engine-v2`,
`tests/query-engine`, `tests/client` and `tests/relations` while turning a working
user-facing payload into that internal throw.

`inverse-to-one-create-behavior.ts` now drives the shape on every driver leg and both
substrates: `account.update({ where: { email }, … profile: { upsert: { create: { …, tags: {
create } }, update } } })`. The parent is located by a NON-key unique, so the arm's foreign
key comes from the located row rather than a literal; both arms are asserted from the same
payload shape, because the pair is the claim (absent → the deeper writes run against the row
the arm produced; found → the update applies and NONE of the create arm's subtree runs); and
the decoy account is asserted empty so a wrong-row foreign key is visible.

**The census discipline this changes** (written into the count-evolution entry, not just
here): an `UnsupportedOperationError` → `QueryEngineError` conversion is the one delta class
the census tripwire cannot police, because the site leaves the grep whether or not the shape
it used to refuse now executes. A conversion therefore owes a behavioral witness of the
absorbed shape, not only a reachability argument.

One stale comment fell out with it: `buildInverseToOneUpsertPart`'s header still said a
relation-carrying arm "routes the whole tree to V1 at construction" — an engine deleted at
P6, and the opposite of the code directly beneath it.

**Census unchanged at 68** (re-derived by running `route-inventory.test.ts`), and no new
count-evolution entry: no site was added, removed, or changed in reach. The existing 74 → 68
entry gained the discipline note above.

### N5 — wave gate (independent re-run at `c2714df`, 2026-07-30)

The N4/N5 wave gate was run once on the merged tree AFTER both fix rounds, so it is the
first certification that covers fix round 1 (the depth no-op verdict) and fix round 2 (the
upsert update arm's located-row provenance) as well as the two lanes. Numbers are in the
N4 wave-gate table above — one run certifies both lanes and nothing here restates it.

What the run adds for N5 specifically: its witnesses **EXECUTED, not skipped**, on both
Docker legs and both substrates. MySQL ran 24 `post-transition adopt (N5-U1)` tests
(12 transaction + 12 atomic batch), Postgres ran the same 24, all green — which is what
carries N5's two dialect-risk shapes past assertion: the required-FK `set` under a
`restrict` transition, and the COMPOUND string primary key with ON UPDATE CASCADE.

The census closes where the merge left it: pin **74**, and the log's last entry is fix
round 1's `74 -> 74 (FIX ROUND, no site added or removed, recorded because it changes what
REACHES one of them)`. Fix round 2 correctly added no entry — a found pin's statement and a
write's addressed row are not census sites. N5's three survivors (sweep (a)/(b)/(d)) and
the merge refusal remain open as the FOUR claims on one unbuilt mechanism: a `planned`
parent-id source that applies the SET operand to the located value at compile, through
`getUpdatedPrimaryKeyValue` in `referencedFieldValue`. That follow-on unit is unstarted.

## N6 — Beyond Prisma (decision-gated; each unit needs a maintainer yes)

| Unit | What | Decision |
|---|---|---|
| N6-U1 | ~~**Extended whereUnique in nested target selectors**~~ — **DELIVERED** (maintainer yes). The nested `update`/`upsert`/`delete` targets take `{ <unique>, ...filters }`; Prisma is unique-only there, so this is the superset row of the capability matrix. See the note below. | D-N1 ✅ |
| N6-U2 | ~~**Relation filters inside a unique where**~~ — **DELIVERED** (maintainer yes). See the note below. | D-N2 ✅ |
| N6-U3 | ~~**Own-write linearization**~~ — **DELIVERED** (maintainer yes; ATOM §4.1 amended first, in its own commit). The premise in this row is wrong twice over and the note below says how. | D-N3 ✅ |

### N6-U1 delivered — what the measurement changed about the unit

The unit was scoped as a validation-schema widening, and the measurement agreed with
that only for the *refusal*: all seven nested positions rejected `{ <unique>, filter }`
at one site, `getWhereUniqueSchema`, with zero engine-side enforcement. The census never
counted it (it was a `ValidationError`, not an `UnsupportedOperationError`), so the pin
stays at **68** with the entry recorded in the count-evolution log.

What the plan did not anticipate is that **the schema swap alone is silently wrong**.
Flipping it made all seven positions execute, and two of them wrote the wrong row: with
a filter that EXCLUDED its target, the nested `update` renamed the row anyway and the
nested `delete` removed it. `RelationWritePart` built its locate from
`getWhereUniqueEntries` — the discriminator alone — so the filter half parsed and was
dropped. The two Parts that route through `buildFindUnique` were already correct, which
is exactly why three of four probes looked fine.

So the real unit was: give the filter half to every seam that addresses "the row the
caller named" — four of them, locate AND batch guard — from **one home**
(`uniqueSelectorConjuncts`, `shared.ts`), while the discriminator keeps its monopoly on
everything compile-time. `RelationUpsertPart` had predicted this in a comment ("if N6-U1
widens these selectors it owes BOTH seams the filter half"). The `racePin` withholding
the root already does under an extended `where` moved into `childRacePin` for the same
reason: one home, so no call site can forget it.

Doctrine note: the exclusion arms are the load-bearing witnesses. A test that only
asserts a matching filter passes against an implementation that parses the filter and
throws it away — accepting a predicate and dropping it is strictly worse than refusing
it, because it is the wrong row rather than an error. Every absorbed shape is therefore
witnessed twice, and the falsification is recorded: reverting the one seam fails exactly
the six exclusion arms and nothing else.

#### The correction the review round found — one seam per witness, not one unit

"Reverting the one seam fails exactly the six exclusion arms" was true and *insufficient*,
because it was measured on ONE of the four seams. Reverting each of the other three, one
at a time, was measured afterwards, and two of those reverts left the whole estate green:

- **`UpdateOperation.nestedTargetWhereFilters`** — the X1c delegation's locate and its
  batch presence guard. Live wrong-row write with no concurrency and no instrument:
  `owner.update({ tickets: { update: { where: { id, subject: <excluding> }, data: {
  subject, owner: { update: … } } } } })` renamed the excluded ticket, renamed its owner
  and filed a note under it. Reachable only when the target's data carries a PARENT-HELD
  to-one or a non-PK referenced edge (`targetNeedsFullUpdate`), which is precisely the
  condition every N6-U1 arm avoided — all of them used scalar data or a child-held
  to-many, which route through a Part. Now witnessed by a matching/excluding pair in
  `depth-seam-behavior.ts`, every driver leg, both substrates; the revert fails exactly
  the exclusion arm on both and nothing else.
- **`RelationUpsertPart.foundGuardStatement`** — the only seam whose two halves can
  DIVERGE: its probe compiles the whole selector through `buildFindUnique` while the
  guard assembles its own conjuncts, so the filter can be dropped from the guard alone
  and the batch then re-asserts a weaker premise than the probe established. Invisible to
  every quiescent test; visible on the split-witness instrument the N4-U1 arms already
  use, moving a FILTERED column (not the unique) between planning and the batch. Now
  witnessed in `depth-seam.test.ts`; the revert fails exactly that arm.
- **`RelationJunctionPart.capturedSelectorRead`** — recorded rather than witnessed,
  because it is UNREACHABLE: its callers are `connect` / `set` / `connectOrCreate`, whose
  selectors are strict by schema, so its filter branch is dead. The m2m selectors that
  are extended reach `membershipRead`, which compiles both halves through
  `buildWhereUnique`. It takes the one home for uniformity, not for a live path.

The generalisable lesson, and the reason it is written here rather than in a commit
message: an absorption's witness obligation is per ROUTE through the engine, not per
payload key in the schema. Four sites assemble these conjuncts; the census entry counted
the unit once and the tests covered three routes, and the mismatch is exactly where the
unwitnessed write lived. The seam table in ATOM §8.1 now carries the per-seam disposition
so the next widening starts from the routes rather than from the surface.

#### The route that correction itself missed — one slot, two probes

The audit above enumerated the seams that ASSEMBLE conjuncts, which is where a filter
gets dropped by omission. A route that hands its whole selector to `buildFindUnique` was
counted as correct by construction — true, and not a witness. One of them decides an ARM
rather than a row: `RelationJunctionPart.buildUpsertSlot` compiles TWO probes, the
correlated membership read AND a global `buildFindUnique` probe entered by no other
junction kind, and `compile` reads member / exists-not-member / absent from both.
Reducing that second probe's `where` to the discriminator leaves the whole V2 suite green
while an EXCLUDING selector stops taking the create arm and raises V7001 instead — it
sees the member its own filter excluded and reports "exists globally, not a member of
this parent". Fail-closed rather than a wrong-row write, and still an absorbed capability
that silently stops working, which is the N4-U1/N4-U2 standard.

Why the coverage looked complete: of the three extended m2m positions, only `update` had
a behavioral arm, and `delete` shares its membership read (`buildTargetSlot` treats both
as "connected"), so it was covered transitively. `upsert` — the one kind with a SECOND
route — had none, and the sibling capability at the child-held to-many position
(`RelationUpsertPart`'s probe) is witnessed four times over, which is what made the gap
invisible. The `N6-U1 junction upsert` pair in `depth-seam-behavior.ts` pays it on every
driver leg and both substrates: the EXCLUDING arm fails against the dropped filter, and
the KEPT-non-member arm (which must still refuse) fails against an engine that ignores
the global probe. The create-arm `racePin` at that slot is pinned too, by the junction
case added to `N6-U1 nested create-arm racePin` in `depth-seam.test.ts` — the withholding
rule lives in `childRacePin`, but the CALL SITE's pass-through was covered only at the
to-many Part and the junction's `connectOrCreate` adopt slot.

So the rule sharpens: a route is a PROBE, not a Part. Two probes in one slot are two
routes even when a single payload key builds both, and the one that selects between arms
needs an arm of its own on each side.

### N6-U2 delivered — relation filters inside a unique `where` (D-N2)

**The refusal, measured before anything was touched.** One site:
`extendedWhereUniqueRelationRefusal` in `src/validation/model/core/where.ts`, a
`v.refused` entry per relation key, reached identically by `findUnique`,
`findUniqueOrThrow`, `update`, `delete` and `upsert` — five families, one message.

**What it was actually protecting.** The plan named MySQL's ERROR 1093. Compiling the
payload past validation on all three dialects showed a second and more dangerous half
first: `buildUpdate`/`buildDelete` passed the EMPTY alias to `buildWhereUnique` (a
mutation target has no alias to give), so the relation filter's correlated `EXISTS` came
out with a **bare** outer column — `EXISTS (SELECT 1 FROM logins t1 WHERE id =
t1.accountId …)`. Where the related model carries a column of that name — `id`, in most
schemas — the outer reference binds to the INNER table and the predicate stops being about
the outer row at all. No dialect errors on it. Every dialect answers it wrong.

**The composition.** `buildUpdateMany`/`buildDeleteMany` have answered both halves since
they were written: qualify the `where` by the target's own table name (the unaliased
target IS addressable that way) and declare it as the `mutationTable`, which lets the
relation-filter builder hide a subquery reading the mutated table behind a derived table.
The two unique-`where` builders now do exactly the same — one spelling for a mutation's
`where`, not one per arity — and the validation entry collapsed into the model's own
`where`. `getScalarWhereSchema` / `ScalarWhereSchema`, the scalar-only recursion that
existed only to host the refusal, are deleted.

Measured: the wrapper engages precisely where the relation reads the mutated table (a
self-relation to-one or to-many, a self-M2M's target side) and stays off for cross-table
relations; PostgreSQL and SQLite never wrap.

**Where the filter reaches a mutation, which is where the witnesses had to go.** In
transaction mode `update`/`delete` address the located row by the primary key their
`FOR UPDATE` locate captured, so the filter reaches only the locate — a plain SELECT,
correlated correctly since forever. It reaches a WRITE in exactly three places: an atomic
batch's write (which keeps the original `where` so guard and write pin one row), the
transaction-mode RETURNING fold on `update` (`directWrite`, which has no locate at all),
and `upsert`'s UPDATE arm (which keeps the original `where` on BOTH substrates). Only the
third is reachable on a non-returning driver, which is why MySQL's leg of this unit is an
upsert.

**Not absorbed, and deliberately not refused either.** `upsert`'s CREATE arm needed no new
treatment: a relation filter partitions into `filters` exactly as a scalar one does, so it
withholds the create-arm `racePin` by the rule already there and a collision surfaces as
the genuine `UniqueConstraintError` W4 pinned. The witness asserts that rather than
assuming it. Nested target selectors were out of scope for the unit as built — that
boundary was N6-U1's, and the two units were built in parallel lanes.

**Census:** pin unchanged at **68**. The lifted refusal was a parse-boundary `v.refused`,
never an `UnsupportedOperationError` site; the count-evolution log's `68 -> 68 (N6-U2)`
entry says so, with the measurement and the four falsifications.

### N6-U1 × N6-U2 — the surface only the merge creates

Neither lane could see this: N6-U1 pointed the nested `update`/`upsert`/`delete` target
selectors at `getWhereUniqueExtendedSchema`, and N6-U2 put relation filters INTO that
schema. Merged, a nested target selector accepts a relation filter — a payload that
existed in neither lane's tree, and one each lane's notes described the opposite way
(N6-U2's read "nested target selectors keep the STRICT schema", true where it was
written). The merge makes exactly one of them true, and that is a claim to measure, not
to infer.

**Measured on the merged tree, both substrates, before anything was written down:** a
matching relation filter is transparent; an excluding one is a typed nested not-found with
the target untouched; and that holds for a cross-table filter and a self-relation one, for
nested `update`, nested `delete`, and both arms of a nested `upsert`. Nothing refused, and
nothing needed to.

**Why no second dose of N6-U2's composition was needed at depth.** A nested targeted write
addresses its row by the primary key its correlated probe captured — on both substrates —
so the filter half is carried only by `buildFind`, an ALIASED select. It correlates there
for the same reason the root locate always did, and MySQL's ERROR 1093 (a subquery reading
the table its own statement mutates) does not reach a separate SELECT. The root needed
`mutationTable` because its filter compiles into the UPDATE/DELETE; depth does not, because
it does not.

That is a statement about SHAPE, which no behavioural test can see — it passes either way
on the dialect that accepts both — so it is pinned at compile level
(`unique-where-relation-filter-plan.test.ts`, the `N6-U1 × N6-U2` pair) and falsified:
hand the nested write the selector instead of the captured key and exactly those two fail.
That is also the tripwire for the plausible future optimization of folding the probe into
the write; the fix, that day, is the one N6-U2 already wrote for the root. The behaviours
live in `extended-where-unique-behavior.ts` §8, on every driver leg.

### N6 wave gate — certified, and what it does NOT cover

Run on the merged branch after both lanes and both follow-up witness rounds, each step in
its own shell, on the wave's own commit range (`3c8ca0a..e551aee`):

| Gate | Baseline entering N6 | Measured | |
|---|---|---|---|
| `pnpm test:types` | clean | clean | ✅ |
| Full estate (`--maxWorkers=4`, alone) | 8729 passed / 0 failed | **8893 passed / 0 failed** (256 files, 4 skipped) | ✅ |
| `pnpm test:gates` | 72 | **72 / 72** | ✅ |
| Census pin | 68 | **68**, log coherent (three N6 entries: U1, U2, and the merge, each `68 -> 68` with its reason) | ✅ |
| Biome, per file over the wave's diff | — | clean on every checked file (the 6 `.md`/`.mdx` files are not Biome-handled) | ✅ |
| Docker MySQL (`:3307`) | 868 | **905** | ✅ |
| Docker pg (`:5434`) | 976 | **1018** (+14 skipped) | ✅ |

The two Docker legs were checked by NAME, not by count: the N6-U2 derived-table wrapper
witnesses (`self-relation filters` — `updateMany`/`deleteMany`, both `upsert` arms, and
`update`/`delete` by a self-relation-filtered unique `where`) and all 22 `N6-U1` depth-seam
arms ran on MySQL, each in BOTH substrates (transaction and atomic batch), plus the nested
extended-selector case in the extended-`whereUnique` block. None skipped.

**N6-U3 was NOT delivered in the N6 wave.** It is delivered now, in its own run, and the
record is below.

### N6-U3 delivered — own-write linearization (D-N3)

**Both halves of the row above were false, and the measurement said so before anything
was touched.**

*The payload was wrong.* `{ posts: { create, connect } }` — the shape this plan called
A14's headline, and the one the capability matrix printed as the example — does not
reject. It never did: not on a child-held to-many, not on a many-to-many, not with
disjoint identities and not with the same one. It executes and both rows land. What DOES
reject was enumerated exhaustively instead of guessed at: all 55 unordered sibling pairs
on one relation × {child-held to-many, many-to-many} × {disjoint identities, the SAME
identity}, plus the create root, evaluated at CONSTRUCTION so no I/O could confound it —
**92 rejections**.

*The doctrine was not what they rested on.* The 92 had one thing in common, and it was
not the payload: it was an arbitrary order, and there were **two of them**.
`RELATION_MUTATION_KEYS` ordered the parts the engine emits (four call sites, through
`getRelationMutationKinds`); `planRelationMutationSteps` ordered the footprints the
legality walk derives, in an if-chain of its own. They agreed on nine kinds and disagreed
on the tenth pair — emission ran `upsert` before `deleteMany`, derivation the reverse — so
a shape's soundness was being checked against a sequence the engine never executed. **The
fork ATOM §4 warned about was real and already present, and it was never in the Parts. It
was in the order.**

**The amendment (ATOM §4.1, committed alone and first).** One fixed, documented order,
declared once and used by BOTH the emission and the derivation, so the theorem is stated
over exactly the sequence that runs. The invariant that draws it: *every decision read is
ordered before every write that could not be bounded, and every kind that reads nothing is
ordered last.* Three stages fall out —

```
disconnect → delete → update → upsert → connectOrCreate   (named readers)
          → set → updateMany → deleteMany                 (unbounded writers)
          → connect → create → createMany                 (pure adders)
```

Nothing about the preflight is weakened; the order is chosen so the dependency does not
arise. Measured on the same sweep: **92 → 41**, and all eleven kinds at once on a
child-held to-many went from rejected to executing. The 41 survivors are two classes, both
re-justified: **33** where two kinds name the same row with conflicting intents (a payload
contradiction) and **8** where a many-to-many `deleteMany` must resolve its filter against
a membership a sibling rewrites — the one class no ordering can fix, and the one a later
unit must attack with technique #2 rather than with a reordering.

**The order was derived, not decreed.** Three candidates were measured through the same
sweep: this plan's suggested deleteMany-first order rejects **60**, a readers-ordered
variant of it **50**, the shipped one **41 (+1 accepted line)** — and only the shipped one
accepts the eleven-kind payload.

**Prisma, measured not recalled** (7.9.1, `prisma-client` generator, pg adapter, query log
captured per shape): Prisma has no order. It executes sibling kinds in the enumeration
order of the JavaScript object literal — `{ create, connect }` emits INSERT-then-UPDATE and
`{ connect, create }` the reverse; `{ create, deleteMany }` **deletes the row it just
created** while `{ deleteMany, create }` keeps it; `{ create, delete }` on one identity
raises a unique violation where `{ delete, create }` succeeds. That is not a documented
contract but [prisma/prisma#16606](https://github.com/prisma/prisma/issues/16606), open and
labelled `bug/2-confirmed`. Ours is fixed and independent of how the caller spelled the
object, and it is the spelling Prisma users are told to write. (Prisma also does not offer
`createMany` on an implicit many-to-many at all — a TypeScript error on the generated input
type — so N3-U1's arm has no Prisma order to match.)

**Witnesses.** `own-write-linearization-behavior.ts` — 18 shapes × both substrates, wired
into all four driver files, every one an ADJACENT PAIR in the sequence asserted on STATE:
`delete` then `create` of one identity leaves the fresh row; `set` then `create` leaves
exactly set ∪ created (before, `create` ran first and `set` orphaned the row the same
payload had just inserted); a filtered bulk kind never consumes a row the call is adding;
the eleven-kind payload; the m2m pairs; and the two surviving rejection classes asserted
directly so the file cannot pass by everything being accepted. Plus two structural tests
pinning the order and asserting the derivation walks it — the tripwire that fails the
moment a second order reappears. **Falsified by mutation:** swapping stage 2 with stage 3
fails 11 of the 38, stage 1 with stage 2 fails 7, `set` with `update` alone fails 7.

**Retargets — 17 estate tests, each with the reason written at the site.** Six shapes now
EXECUTE and assert their new state; nine still reject, write nothing, and name the guard
that now owns them (a correlated probe's not-found, the unique constraint, or the to-one
arity refusal) — the N2-U1 disposition, since adding a preflight check for a fact the
database already guards would be a second guard on one invariant. Two are ledger unit
tests, retargeted to assert the order and keep the "unknown identity fails closed" claim
on a pair that still has a read behind a write. One retarget is the fork made visible: the
m2m `deleteMany`/`upsert` pair's message used to blame `deleteMany` for the `upsert`'s
read and now blames `upsert` for the `deleteMany`'s — both cannot be right, and the old
one was derived over the order that never ran.

**Census: pin unchanged at 68.** The preflight rejects with `NestedWriteError`, never
`UnsupportedOperationError`, so this census could not count the surface in either
direction; the `68 -> 68 (N6-U3)` entry in the count-evolution log says so and carries the
measurement, the three candidate orders, and the falsifications.

## Ordering and parallelism

```
N1 (keystone, ALONE — Pin Rule/staleness blast radius, dual-substrate oracle)
        │
   N2 ∥ N3            (disjoint: UpdateOperation inverse arm vs junction Parts)
        │
   N4 ∥ N5            (disjoint: depth seams vs ordering)
        │
   N6 (decision-gated units, only those with a yes)
        │
Final: census at its floor (each survivor = genuinely inexpressible or Prisma-parity refusal,
each with a measured justification), full estate + gates + Docker, capability matrix §write rows updated.
```

Sizes: N1 = L (the keystone), N2 = M, N3 = M, N4 = M, N5 = M, N6 = S–M each. Census target: from 78 down to the floor — not a number picked in advance, but every survivor must answer "why can no mechanism express this?" with a measurement, the standard the census log already enforces.

## What "better than Prisma" means here, concretely

Already ahead and staying: unlimited depth, nested upsert-under-create, optional-`where` nested updateMany, to-one `{where,data}` non-unique filters, upsert `targetWhere`/`setWhere`, operand callbacks at every depth. This plan adds: located-parent dataflow Prisma resolves with multiple round-trips folded into single plans; nested extended-unique selectors (N6-U1) Prisma doesn't offer; and honest typed refusals with named reasons where Prisma silently degrades or errors opaquely.

---

## The floor — final census disposition

**Date:** 2026-07-30 · **Commit audited:** `6910728` · **Census at audit time:** 68 sites.

> **N7-U-A UPDATE (the audit's first work order, executed).** 23 of the 25 rows below marked
> **(c-i)** are now `QueryEngineError` internal invariants and the census pin reads **45**
> ([`route-inventory.test.ts`](../../tests/query-engine-v2/route-inventory.test.ts), the
> `no UnsupportedOperationError throw site` test). Their disposition column reads
> **(c-i) → CONVERTED**, and every one carries a witness in
> [`census-conversion-witnesses.test.ts`](../../tests/query-engine-v2/census-conversion-witnesses.test.ts)
> — a payload fed through the PUBLIC client surface asserting the `ValidationError` that
> answers first, or, for the four with no public spelling at all, the structural invariant
> that makes them unreachable. **No user-visible behavior changed: none of the 23 fires.**
>
> **TWO rows failed re-verification and were NOT converted** — which is why the number is
> 45 rather than the audit's predicted 43. `CreateOperation.ts:822` and
> `RelationUpsertPart.ts:708` are both **reachable**; see their corrected rows. Both stay
> census sites, reclassified **(c-ii)**. The counts table at the bottom of this section
> carries the revised totals.

> **N7-U-B UPDATE (the audit's second work order, executed).** The 27 rows marked
> **(c-ii)** or **(c-iii)** were measured against a **live Prisma 7.9.1 oracle** — a real
> client on a real Postgres, not the generated types — and five sites were ABSORBED, one
> was re-measured into **(a)**, four moved to **(b)** on a shared measurement, and the rest
> keep **(c-ii)** with a stated measurement and an owner. The census pin reads **40**. The
> (c-iii) class — *"reachable, no recorded reason at all"* — is now EMPTY. The oracle also
> caught something no census of refusals could see: **two paths where viborm silently did
> the opposite of what the payload asked** (`disconnect: false` disconnected, at the
> parent-held arm and one level deeper). Full record: *"N7-U-B — the (c-ii)/(c-iii)
> dispositions, measured"*, below the counts.

This is the FINAL row of the plan's own acceptance ladder: *"census at its floor (each
survivor = genuinely inexpressible or Prisma-parity refusal, each with a measured
justification)."* This section is the audit that tests that claim site by site. It is an
audit, not a wave: **nothing was absorbed here, no engine file was touched.**

### The counting rule, restated

The census counts what its own tripwire counts and nothing else: occurrences of the string
`new UnsupportedOperationError(` in the `.ts` files **directly inside**
`src/query-engine-v2/` (no recursion into subdirectories). Re-run here by hand: 68, spread
over ten files — `UpdateOperation.ts` 25, `CreateOperation.ts` 12, `RelationUpsertPart.ts`
9, `RelationJunctionPart.ts` 6, `RelationWritePart.ts` 5, `nested-target-parts.ts` 4,
`UpsertOperation.ts` 4, and one each in `ReadOperation.ts`,
`ManyAndReturnOperation.ts`, `DeleteOperation.ts`.

*After N7-U-A the same count is **45** over **eight** files — `UpdateOperation.ts` 16,
`CreateOperation.ts` 8, `RelationUpsertPart.ts` 6, `RelationJunctionPart.ts` 5,
`RelationWritePart.ts` 4, `UpsertOperation.ts` 3, `nested-target-parts.ts` 2,
`ManyAndReturnOperation.ts` 1. `DeleteOperation.ts` and `ReadOperation.ts` now have none
at all, and no longer import the class.*

*After N7-U-B it is **40** over the same eight files — `UpdateOperation.ts` 13,
`CreateOperation.ts` 8, `RelationUpsertPart.ts` 6, `RelationJunctionPart.ts` 5,
`RelationWritePart.ts` 3, `UpsertOperation.ts` 3, `nested-target-parts.ts` 1,
`ManyAndReturnOperation.ts` 1.*

### The three dispositions, and the line between them

| Code | Meaning |
|---|---|
| **(a) PARITY** | Prisma rejects the shape too. The refusal is a boundary viborm shares. |
| **(b) INEXPRESSIBLE** | Reachable, with a **measured** reason recorded, and **no existing engine mechanism** (`Ref`, the locate, produced identity, the ordering ladder, the `{where,data}` wrapper, the create/update-root delegations) spells the missing value. |
| **(c) UNJUSTIFIED** | Everything else — the audit's product. Split three ways below. |

The line between (b) and (c) is deliberately sharp, because it is the line the word
"floor" turns on: **(b) means no mechanism exists; (c) means a mechanism exists and is not
wired here, or no reason is recorded at all.** A site whose record names a follow-on unit
("the two-source split, carried into `RelationJunctionPart`"; "a builder this module
cannot import without a cycle") is by its own words NOT at the floor — it is a shape a
later wave absorbs. Those land in (c-ii), not (b). This is stricter than "does the record
say something", and it is the only reading under which "floor" means anything.

**Reachability was measured, not assumed.** Every site marked `M` in the table below was
probed live at construction through the public routing seam
(`constructRoutedOperation`, i.e. the parse boundary + operation construction) on PGlite,
with purpose-built schemas where the shipped fixtures had no shape for it. `M✗` means the
probe found **no payload that reaches the site** — the parse boundary answers first with a
`ValidationError`, or the dispatch above it is total. The probe harness was temporary and
is not committed; every verdict it produced is reproduced in the citation column.

### The 68 sites

`M` = reachability measured live · `M✗` = measured, no reachable payload found ·
`†` = parity asserted from Prisma's generated input shape, not re-measured in this branch.

#### `CreateOperation.ts` (12)

| Site | Shape | Disp. | Citation / what is missing |
|---|---|---|---|
| `:822` `M` | a relation whose type is neither child-held to-many nor inverse to-one, under a create root | **(c-ii)** *(was (c-i); RE-MEASURED and REFUTED by N7-U-A)* | the site's comment claimed *"a schema impossibility … kept as a defensive internal guard"*. **It is reachable.** A `manyToOne` declared WITHOUT `.fields()` — the inverse side spelled with the many-side helper, its FK resolved from the target's own back-reference — has `holdsFK === false` and `type === "manyToOne"`, lands here, and is refused. The SAME relation on the SAME schema **constructs under `update`**: `UpdateOperation.interpretChildHeld`'s gate asks `isToOne \|\| type === "oneToMany"`, admits it, and routes it down the very `interpretChildHeld` path this line withholds. A create-root predicate narrower than its own update-root twin — a mechanism that exists, unwired. Witness: `census-conversion-witnesses.test.ts`, *"the TWO (c-i) claims that failed re-verification"* |
| `:842` `M` | two kinds on one to-one arm (`{connect, create}`) | **(b)** | a payload contradiction: one FK column, two identities. Same class the N6-U3 log calls *"two kinds name the SAME row with conflicting intents (a payload contradiction, not a planning limit)"* |
| `:866` `M` | shared-PK parent-held edge whose fold value is not a compile-time literal | **(b)** | count-evolution log, `68 -> 68 (N4-U4)`: a non-referenced `connect` re-evaluates a lookup subquery (a second provenance of the same row); a `connectOrCreate` decides its arm at compile, so one identity cannot describe both |
| `:892` `M✗` | `update`/`delete`/`disconnect` on a to-one under create | **(c-i) → CONVERTED** | probe: `ValidationError: Unknown key: update` — `toOneCreateFactory` offers only `create`/`connect`/`connectOrCreate`. Comment still says *"is V1's rejection (routed to V1…)"*; V1 is deleted |
| `:1107` | before-parent target's referenced field unresolvable | **(b)** | `68 -> 68 (N4-U4)`: an `Sql` operand would be evaluated a second time for the FK (two `gen_random_uuid()` calls are two values); `null`/absent references no row |
| `:1194` `M✗` | an unenumerated nested kind on a child-held to-many under create | **(c-i) → CONVERTED** | probe: `ValidationError: Unknown key: update` / `Unknown key: set`. `toManyCreateFactory` offers exactly the five kinds the switch handles |
| `:1326` | this record's own referenced field unresolvable | **(b)** | `68 -> 68 (N4-U4)`, same measurement as `:1107` |
| `:1341` `M` | a compound-referenced child edge under a create root (`connectOrCreate` / `upsert`) | **(c-ii)** | the adopt/M2M `ParentIdSource` carries ONE value. N1-U2 proved a compound reference is per-field and generalizes at the update root; no measurement says why the fresh-parent adopt cannot take the same per-field source |
| `:1348` | the adopt/M2M parent id unresolvable | **(b)** | `68 -> 68 (N4-U4)`, same measurement as `:1107` |
| `:1648` `M` | a nested kind outside the M2M create-tree allowlist | **(a)** *(was (c-iii); MEASURED by N7-U-B)* | **only `upsert` reaches it** (probe: the other six are `ValidationError`). The recorded reason — *"address a PRE-EXISTING membership a fresh parent cannot have"* — is true of the six that never arrive and **false of the one that does**: viborm's `upsert`-under-create is a documented GLOBAL-LOOKUP ADOPT-AND-UPDATE superset (`create.ts`'s own compatibility note), which the child-held sibling executes on the same payload. **N7-U-B measured Prisma live and the refusal is PARITY after all**: Prisma rejects `upsert` under a create root on EVERY to-many relation (`Unknown argument 'upsert'`). What the row really found is an asymmetry inside viborm's own superset |
| `:1843` `M✗` | a non-record to-one `connect` where | **(c-i) → CONVERTED** | probe: `ValidationError: Expected object` |
| `:1867` `M✗` | `requireRecord` — an `unknown → Record` narrowing on a parsed sub-payload | **(c-i) → CONVERTED** | X2's record says the surviving narrowings *"throw `QueryEngineError`, never `UnsupportedOperationError`, so they are outside this census."* Four of them do not; this is one |

#### `UpdateOperation.ts` (25)

| Site | Shape | Disp. | Citation / what is missing |
|---|---|---|---|
| `:489` `M✗` | a model with no primary key | **(c-i) → CONVERTED** | probe: the PK-less model's `whereUnique` has no discriminator, so `ValidationError: Missing required field` answers first. §3.A A16 already states every model must have a PK |
| `:622` | no validation schema for a relation the model declares | **(c-i) → CONVERTED** | an engine invariant: `separated.relations` and `parentSchemas.relations` are built from the same model |
| `:1180` `M` | two kinds on one to-one arm under update | **(b)** | payload contradiction, as `CreateOperation.ts:842` |
| `:1202` | a child-held relation of an impossible type | **(c-i) → CONVERTED** | defensive: m2m and parent-held dispatched above |
| `:1231` `M` | a nested targeted mutation on a **compound-PK child** | **(b)** *(was (c-ii); MEASURED by N7-U-B)* | sweep entry (i) lists it *"so the sweep is complete"* and names no owner. The ROOT supports compound PKs (`UpdateOperation.ts:494` — *"Compound primary keys are supported"*); the per-field generalization ATOM §1 applied to FKs has not been applied to the child's own key arity. **N7-U-B correction:** that premise conflates two objects — N1-U2 generalized the FK ASSIGNMENT, and this needs the produced identity a later step ADDRESSES, which is `field: string` in §1's own `firstRowField`. No mechanism to wire → (b) |
| `:1256` | a nested kind while the root transitions a compound / non-PK / unpinned referenced column | **(b)** | N5-U2 (d), measured: the no-op verdict `sameScalarValue(before, after)` must move to compile or an occupied slot the engine deliberately accepts becomes a rejection; the unpinned third needs the same operand-applying source (a)/(b) name |
| `:1502` | a compound-key nested create under a **non-cascading** rewrite | **(b)** | N5-U2 (a), measured: `getUpdatedPrimaryKeyValue(before, operand)` is computable only at compile, and no `ParentIdSource` (`literal`/`planned`/`ref`) transforms |
| `:1532` | a nested create under an unpinned **non-cascading** PK transition | **(b)** | N5-U2 (b), same missing mechanism, measured |
| `:1547` | a nested create referencing a **non-literal rewritten** column | **(b)** *(was (c-ii); N7-U-B ABSORBED the `{ set: v }` half)* | sweep entry (c): *"What would close it is `{ set: v }` unwrapping (`classifyRelationKeyScalarUpdate` already calls that shape 'resolved'), a normalization question, not a Ref one"* — a mechanism that exists. **N7-U-B DID the unwrapping**; the residue is the operands with no construction-time value (`Sql`, `{ increment }`, `null`), which is (b) with its own measurement at the site |
| `:1738` `M✗` | an unenumerated to-many kind under update | **(c-i) → CONVERTED** | probe: all 11 keys of `toManyUpdateFactory` are handled (`create`/`createMany` upstream at `interpretChildHeldCreate`, the other nine in the switch). The comment *"create / createMany nested under update are V1's surface"* has been false since T3b-2 |
| `:1923` `M` | `disconnect: false` on an inverse-side to-one | **ABSORBED (N7-U-B)** | N2-U3 measured the OBJECT form as a parse-boundary gap and pinned `false`'s behavior in both directions — but recorded **no reason to refuse `false`** rather than treat it as the no-op Prisma's `boolean` arm makes it. **N7-U-B measured Prisma live: it is the no-op.** Absorbed in `getRelationMutationKinds`; witness `boolean-noop-arm-behavior.ts` |
| `:1950` `M` | `delete: false` on an inverse-side to-one | **ABSORBED (N7-U-B)** | as `:1923` |
| `:2248` `M✗` | an unenumerated kind on a parent-held to-one | **(c-i) → CONVERTED** | probe: `ValidationError: Unknown key: set`; `connect`/`disconnect` are dispatched to `interpretToOneLink` above |
| `:2318` `M` | a **compound or non-PK** parent-held to-one reference | **SPLIT (N7-U-B): (b)** compound / **(c-ii)** non-PK | recorded reason is *"needs V1's staged mutation-identity resolution"* — V1 is deleted. X1c's whole-target delegation and N1's per-field located reads both exist; nothing measures why they do not reach here. **N7-U-B measurement:** the guard rejects four conditions at once. The three COMPOUND ones are the single-column produced identity of `:1231` → (b). The fourth — a single-field NON-PK reference — is not tuple-shaped and stays (c-ii): the correlation already reads the child by that column, and capturing its PK from that read is N4-U1's move |
| `:2485` `M` | `delete: false` on a parent-held to-one | **ABSORBED (N7-U-B)** | as `:1923` |
| `:2594` `M` | nested relation writes in a parent-held to-one **`upsert`** arm's data | **(c-ii)** | probe: the `update` arm is ABSORBED (X1c delegation, constructs); only `upsert` still refuses. The reason is the conditional three-way arm — the same wiring problem `RelationUpsertPart.ts:1019` names as a follow-on, not an absence of mechanism |
| `:2773` `M` | a shared-PK parent-held `create`/`connectOrCreate` at an UPDATE root | **(c-ii)** | recorded reason cites V1's `getUpdatedPrimaryKeyWhere`. N4-U4 built the produced-identity fold for exactly this edge at the CREATE root (`resolveSharedPkIdentity`); it is not wired at the update root, and no measurement says it cannot be |
| `:2788` `M` | a nested-relation **target create** on a parent-held to-one | **(c-ii)** | recorded reason cites *"V1's appendCreate recursion"*. X1b's `nestedFresh` create-subtree reuse exists and N4-U2 used it for exactly this shape one seam over |
| `:2839` | the before-root target's referenced field unresolvable | **(c-ii)** | the create root's analogue (`CreateOperation.ts:1107`) was **narrowed** by N4-U4's widened fresh identity (`freshReferenced`, which resolves a referenced non-PK unique the create data spells). The update root's before-root target still reads its identity as PK-or-generated only |
| `:2856` `M` | to-one `connectOrCreate` by a **non-referenced** unique | **(c-ii)** | T3c absorbed exactly this for the create root's `connect`, *"through V1's verbatim `buildConnectSubqueryForField` lookup subquery"*. The mechanism exists; whether it transfers to a SET-folded assignment is unmeasured |
| `:3265` `M✗` | `interpretToOneLink` reached with a kind other than connect/disconnect | **(c-i) → CONVERTED** | probe: `ValidationError: Unknown key: set`; the other five to-one keys dispatch elsewhere |
| `:3280` `M` | to-one `connect` by a **non-referenced** unique | **(c-ii)** | as `:2856`; the comment still says *"out of P2a scope — route the whole tree to V1"* |
| `:3589` `M✗` | multiple targets on a to-one connect/disconnect | **(c-i) → CONVERTED** | probe: `ValidationError: Expected object` — the to-one `connect` schema is a single object, not `singleOrArray` |
| `:3595` `M✗` | a non-record to-one connect/disconnect target | **(c-i) → CONVERTED** | as `:3589` |
| `:3612` `M✗` | `requireRecord(args.where / args.data)` | **(c-i) → CONVERTED** | probe: `ValidationError: Expected object` from the whole-args parse, which runs first |

#### `RelationUpsertPart.ts` (9)

| Site | Shape | Disp. | Citation / what is missing |
|---|---|---|---|
| `:708` `M` | a non-`oneToMany` relation reaching the to-many upsert builder | **(c-ii)** *(was (c-i); RE-MEASURED and REFUTED by N7-U-A)* | the audit said *"no reachable payload identified"*. **It is reachable.** The ROOT dispatches direction before this builder — but `buildUpdateArmParts`, the GRANDCHILD fold on an upsert's UPDATE arm, dispatches on the KIND alone and hands any `connectOrCreate` to `buildConnectOrCreateParts` with the direction unexamined, so a **parent-held to-one grandchild** arrives with `type === "manyToOne"`: `user.update({ posts: { upsert: [{ …, update: { author: { connectOrCreate } } }] } })`. `upsert-family.test.ts`'s *"depth-2 to-one grandchild refusal"* was already standing in front of it — converting it turned that test red, which is how the claim was caught. Same family as `:1079`; what it needs is the target's own SET fold, which X1c's delegation owns |
| `:814` | a parent-held or arity-mismatched FK reaching the upsert part | **(c-i) → CONVERTED** | direction is dispatched by the caller; `fields`/`references` are index-aligned by schema rule |
| `:847` `M` | the relation's owned FK spelled in the nested **update** arm data | **(a)†** | probe: reachable via `update: { userId }` (the create arm is `M✗` — `v.omit(core.create, fkFields)` removes it). Prisma's `<Model>UpdateWithout<Relation>Input` omits the FK too — asserted from the generated input shape, not re-measured here |
| `:853` `M` | a **compound-PK child** on a nested upsert | **(b)** *(was (c-ii); MEASURED by N7-U-B)* | as `UpdateOperation.ts:1231` (sweep entry (i)), including its N7-U-B correction |
| `:1019` `M` | a deeper kind outside {upsert, connectOrCreate, create} on the upsert **update** arm | **(c-ii)** | N4-U2's own narrowing text: *"The link/bulk/delete families and an m2m edge need `buildNestedTargetChildParts`, which this module cannot import without a cycle … Named follow-on, not smuggled in."* An import cycle is not an inexpressibility — N4-U2 itself solved one with an injected `FreshArmBuilder` seam |
| `:1073` | an m2m grandchild `create` on the upsert update arm | **(c-ii)** | same record, same cycle |
| `:1079` `M` | a parent-held to-one grandchild `create` on the upsert update arm | **(c-ii)** | same record; needs the target's own SET fold, which X1c's delegation owns |
| `:1134` | a non-record upsert item | **(c-i) → CONVERTED** | shape narrowing on a parsed payload |
| `:1144` | `requireRecord` on `item.where`/`item.create`/`item.update` | **(c-i) → CONVERTED** | as `CreateOperation.ts:1867` |

#### `RelationJunctionPart.ts` (6)

| Site | Shape | Disp. | Citation / what is missing |
|---|---|---|---|
| `:1185` `M` | junction `createMany` + `skipDuplicates` + a DB-generated target PK | **(b)** | N3-U1, measured live: a skipped INSERT produces no identity; PG's `ON CONFLICT DO NOTHING … RETURNING` yields zero rows while SQLite/MySQL leave `insertId` at a **live unrelated row's** key — reproduced, joining the article to the wrong label with no error |
| `:1199` `M✗` | `resolveCreatePk`'s absent / explicit-null target PK | **(c-i) → CONVERTED** | probe found no payload: `s.string().id()` implies `ulid` + a default (so the key is always present), `s.int().id()` without `.increment()` makes it **required** (`ValidationError: Missing required field: id`), `null` fails a non-nullable PK, and `increment` takes the produced-identity branch above. A PK whose `autoGenerate` is `now`/`updatedAt` was not constructed |
| `:1264` | upsert-through-junction create arm addressing no row | **(b)** | N3-U2: the arm needs one value for the join row, one ledger key and one `where` for the duplicate item's UPDATE; a create payload spelling neither the PK nor a complete unique names nothing, and a `Ref` may never reach a `where` (the W4 wrong-row doctrine) |
| `:1647` `M` | an m2m **upsert** arm carrying relations, located by a non-PK unique | **(b)** | N4-U1 site 3, measured: the created-earlier branch's global probe ran BEFORE this operation's own INSERT and located nothing — *"a genuine absence of a value, not a missing wire."* Probe confirms the `update` kind on the same payload constructs |
| `:1662` `M` | a **relation-carrying** junction create arm with a generated target PK | **(c-ii)** | the recorded reason — *"its deeper child Parts fold against a compile-time `literalParentId`"* — is verbatim the reason N4-U2 **measured and deleted** at `RelationUpsertPart.createArmParentId`: *"a create ROOT hands its grandchildren a generated key as a backward `Ref`, so nothing has to be known beforehand."* The delegated arm here already builds a create subtree and still demands the literal |
| `:2120` `M` | relation writes inside m2m `updateMany` / `connectOrCreate` adopt data | **(c-ii)** | split cause. The `updateMany` half has a real reason (a filter target has no per-row identity) — but it is pre-empted by CLASS V legality (`NestedWriteError`, measured), so it is not what reaches this site. What reaches it is the **connectOrCreate adopt arm** (measured), and its create arm's children are exactly what N4-U2 absorbed for the child-held sibling |

#### `RelationWritePart.ts` (5)

| Site | Shape | Disp. | Citation / what is missing |
|---|---|---|---|
| `:439` `M✗` | the owned FK spelled in the nested upsert **create** arm data | **(c-i) → CONVERTED** | probe: `ValidationError: Unknown key: userId` — the nested create schema omits the FK |
| `:666` `M` | a nested `update`/`updateMany` whose data has **no scalar assignment** | **ABSORBED (N7-U-B)** | no recorded reason anywhere. Measured inconsistency: the ROOT `update({where, data: {}})` **constructs**; the nested spelling of the same emptiness refuses, at both arities. **N7-U-B measured Prisma live:** it accepts both, writes nothing, and does not require the target to exist. Absorbed as `RelationWritePart.isNoOpUpdate` |
| `:681` `M` | an **inverse-side to-one** `update` carrying relations | **(c-ii)** | the decline is gated on `!this.config.where`, and an inverse-to-one target has no selector. But this Part already runs a correlated probe and N4-U1 taught it to publish the located PK as a `planned` source — the gate simply never asks. The exact shape of N2-U1's finding (*"Only the ROOT dispatch refused it"*), one seam over |
| `:765` | a PK-transitioning target carrying BOTH an m2m edge and a non-cascade child-held edge | **(c-ii)** | N5-U1b measured the conflict honestly and then names the fix: *"the two-source split N5-U1 built for `set` (`RelationSetConfig.correlationParentId`), carried into `RelationJunctionPart`. Named for a follow-up, not smuggled in here."* A mechanism that exists, unwired |
| `:787` | the N4 × N5 merge shape: a non-PK locator + a PK-rewriting SET + a non-cascading deeper FK | **(b)** | the merge entry, measured: *"no `ParentIdSource` transforms (`literal`, `planned`, `ref` each carry a value verbatim)"*, and the falsification measured the consequence (the deeper edge written against the VACATED key) |

#### `nested-target-parts.ts` (4)

| Site | Shape | Disp. | Citation / what is missing |
|---|---|---|---|
| `:308` | a relation of an impossible type one level deeper | **(c-i) → CONVERTED** | defensive; the parent-held and non-PK branches beside it are already `QueryEngineError` internal invariants (X1c) |
| `:336` `M` | a **compound-PK child** one level deeper | **(b)** *(was (c-ii); MEASURED by N7-U-B)* | as `UpdateOperation.ts:1231` (sweep entry (i)), including its N7-U-B correction |
| `:486` `M` | `delete: false` on an inverse-side to-one one level deeper | **ABSORBED (N7-U-B)** | as `UpdateOperation.ts:1950` |
| `:573` `M✗` | an unenumerated nested kind one level deeper | **(c-i) → CONVERTED** | probe: all 11 to-many keys have a case above |

#### `UpsertOperation.ts` (4)

| Site | Shape | Disp. | Citation / what is missing |
|---|---|---|---|
| `:207` | a model with no primary key | **(c-i) → CONVERTED** | as `UpdateOperation.ts:489` |
| `:794` | an upsert create arm spelling no complete identity | **(b)** | W4-U1b, measured and **corrected in review**: the three identity sources are a literal PK, a complete unique the create data carries, and a single generated `increment` PK. What remains refused is chiefly a generated COMPOUND PK with no other unique — and that model is already refused upstream by `mutation-identity.ts:44`, measured live |
| `:964` `M` | an unknown / missing top-level `upsert` argument key | **(a)** *(MEASURED by N7-U-B, dagger retired)* | X2's recorded KEEP: upsert has no whole-args parse (a whole-args `parseValidated` would feed the arms a transformed output the sub-op re-parses AND validate the UNTAKEN arm, which `deferArmLegality` forbids). Prisma rejects unknown arguments too — **N7-U-B measured it**: `Unknown argument 'bogusKey'. Available options are marked with ?.` |
| `:971` `M` | a non-object `upsert.where` / `.create` / `.update` | **(a)** *(MEASURED by N7-U-B)* | same X2 KEEP; probe: `'upsert.where' must be an object.` — the only `requireRecord` of the four that any payload reaches. **N7-U-B measured the Prisma half the verifier asked for**: `Argument 'where': Invalid value provided. Expected UserWhereUniqueInput, provided Int.` |

#### One site each

| Site | Shape | Disp. | Citation / what is missing |
|---|---|---|---|
| `ManyAndReturnOperation.ts:430` | `createMany` + `select` + `skipDuplicates` on a non-returning driver | **(b)** | the one maintainer-authorized refusal, pinned as `REMAINING_ROUTE` and the sole entry of the route inventory's corpus that must still throw: no portable `ON CONFLICT DO NOTHING` reports **which** rows it inserted. The `{ count }` arm supports `skipDuplicates` everywhere |
| `DeleteOperation.ts:89` `M✗` | a model with no primary key | **(c-i) → CONVERTED** | probe: `ValidationError: Missing required field` |
| `ReadOperation.ts:90` | a requested operation outside the read base set | **(c-i) → CONVERTED** | `ROUTED_OPERATIONS` dispatches only read families here |

### The counts

| Disposition | Sites at audit (68) | After N7-U-A (45) | After N7-U-B (40) |
|---|---:|---:|---:|
| **(a) PARITY** — Prisma rejects it too | **3** (one asserted, not measured: `RelationUpsertPart.ts:847`) | **3** | **4** (`CreateOperation.ts:1648` joins, measured) |
| **(b) INEXPRESSIBLE** — measured, no mechanism exists | **15** | **15** | **19** |
| **(c) UNJUSTIFIED** — the audit's product | **50** | **27** | **17** |
|   · (c-i) no reachable payload — a defensive / narrowing guard in the user-facing error class | 25 | **0** — 23 CONVERTED to `QueryEngineError`, 2 reclassified | **0** |
|   · (c-ii) reachable; a mechanism exists elsewhere in this engine and is not wired here | 19 | **21** (`CreateOperation.ts:822` and `RelationUpsertPart.ts:708` join them) | **17** |
|   · (c-iii) reachable; no recorded reason at all | 6 | **6** | **0** — 5 ABSORBED, 1 measured into (a) |
| **Total** | **68** | **45** | **40** |

The right-hand column is what the census pin now counts. The 23 conversions removed no
route and changed no behavior — they removed 23 *non-refusals* from a count that claimed to
be a count of refusals. The 45 after U-A were: 3 parity, 15 inexpressible, 21 reachable with
a mechanism named elsewhere, 6 reachable with no reason recorded. **27 of 45 still owed a
justification** — that was U-B's work order, and finding 1 of the verdict below is now
retired.

After U-B the 40 are: **4 parity, 19 inexpressible, 17 reachable with a mechanism named
elsewhere, 0 with no reason recorded.** The (c-iii) class is empty — every site in it was
either absorbed or measured into (a). **17 of 40 still owe a justification**, each now with
a MEASUREMENT of what exactly is missing and an owner; finding 3 is retired and finding 2 is
narrowed. This is not the floor, and the section says so in the same words it used before.

### N7-U-B — the (c-ii)/(c-iii) dispositions, measured

**Date:** 2026-07-30 · **Census:** 45 → **40**.

U-A retired the class that refused nothing. U-B's work order was the other 27: measure
first, then either ABSORB the shape or RE-JUSTIFY the refusal with a measurement that would
survive a spot-check. The measuring instrument was new and is worth naming, because three
of the verdicts below could not have been reached without it: **a live Prisma 7.9.1 oracle**
(`prisma-client` generator + `@prisma/adapter-pg`, on a scratch Postgres database), driven
payload by payload beside the same payload on viborm. Prior waves compared against Prisma's
*generated input types*; this compares against what Prisma's engine actually DOES.

#### What the oracle said, and what it cost viborm

| Payload | Prisma 7.9.1, measured | viborm, before |
|---|---|---|
| `profile: { disconnect: false }` (inverse side) | parent unchanged, child FK untouched | **REFUSED** |
| `profile: { delete: false }` (inverse side) | parent unchanged, child row alive | **REFUSED** |
| `card: { delete: false }` (parent-held) | parent unchanged, target alive | **REFUSED** |
| `label: { delete: false }` (one level deeper) | unchanged | **REFUSED** |
| `card: { disconnect: false }` (parent-held) | unchanged | **SILENTLY DISCONNECTED** |
| `label: { disconnect: false }` (one level deeper) | unchanged | **SILENTLY DISCONNECTED** |
| `profile: {}` / `posts: {}` (empty relation payload) | parent unchanged | **REFUSED** (`… it has none`) |
| `posts: { update: { where, data: {} } }` | writes nothing | **REFUSED** |
| `posts: { updateMany: { where, data: {} } }` | writes nothing | **REFUSED** |
| `posts: { update: { where: <no such row>, data: {} } }` | **no error** — the arm is skipped, never located | **REFUSED** |
| `posts: { update: { where: <no such row>, data: { title } } }` | P2025 | (already parity) |
| `tags: { upsert: … }` under a **create** root (M2M) | `Unknown argument 'upsert'` | REFUSED |
| `posts: { upsert: … }` under a **create** root (child-held) | `Unknown argument 'upsert'` | *accepted* (viborm superset) |
| `upsert({ …, bogusKey: 1 })` | `Unknown argument 'bogusKey'` | REFUSED |
| `upsert({ where: 5, … })` | `Expected UserWhereUniqueInput, provided Int` | REFUSED |

Two of those rows are the reason this unit exists: **viborm was doing the opposite of what
the payload asked**, at two paths that had no census site at all. The parent-held
`disconnect` arm never read its boolean (`interpretToOneLink` nulls the FK on sight), and
the depth arm coerced it (`isInverseToOne && kind === "disconnect" ? true : …`). A census of
refusals cannot see a wrong ACCEPT — which is the strongest argument in this whole audit for
measuring behavior rather than counting throws.

#### ABSORBED — 5 sites, and 2 silent divergences with them

**(1) The boolean no-op arm** — `UpdateOperation.ts:1923` / `:1950` / `:2485` and
`nested-target-parts.ts:486`. A to-one `disconnect`/`delete` is `v.boolean()` at the parse
boundary (`validation/relations/update.ts`, on OPTIONAL relations only), so `false` is the
whole reachable non-`true` surface — N2-U3 established that and then recorded *"no reason to
refuse `false`"*. There was none. The resolution is ONE point, not four:
`getRelationMutationKinds` — the single derivation of "which kinds does this payload ask
for", read by all six V2 dispatches and by the own-write legality walk (ATOM §4) — drops a
kind whose value is `false`. A kind that asks for nothing is not a kind, so no arm is built,
no legality footprint is derived, and the two silent paths lose their input rather than
gaining a fifth check. `UpdateOperation.interpretRelation` returns early on an empty kind
list, which is also what makes `profile: {}` agree with Prisma; the `kinds.length > 1`
refusal (a payload naming two conflicting intents) is untouched.

**(2) The empty nested update** — `RelationWritePart.ts:666`. The root already accepted
`update({ where, data: {} })`; only the nested spelling refused. `isNoOpUpdate` now emits NO
step for an arm with no scalar assignment, no deeper relation write and no upsert create arm
— not the probe, not the presence guard, not an empty SET — which reproduces the measured
Prisma behavior exactly, INCLUDING that a `where` matching no row raises nothing. The upsert
arm is excluded by construction (its CREATE half still runs when the probe finds nothing).

**(3) The `{ set: v }` envelope** — `UpdateOperation.ts:1547`, absorbed as a normalization,
which changes the row's disposition rather than the count. `classifyRelationKeyScalarUpdate`
is the engine's existing reader of that envelope (`TargetConstraint`, the legality walk and
`OwnWriteSteps` all ask it), so `{ set: 5 }` resolves to `5` and the create leaf inlines it.
The throw remains for the operands that HAVE no construction-time value, and that residue is
now (b) with its own measurement: an `Sql` re-evaluated for the FK is a second provenance
(N4-U4's `gen_random_uuid()` finding), a `{ increment }` needs the pre-transition read plus
the arithmetic — the same missing source the two branches above it name — and `null`
references no row.

Witnesses: `boolean-noop-arm-behavior.ts`, 15 shapes × 2 substrates, wired into all four
driver legs, asserting STATE with the `true` controls beside them. Falsified both ways
(restoring the unfiltered kind list fails 14/30; removing the two `isNoOpUpdate` returns
fails the other 14).

#### RE-JUSTIFIED — the measurements

**`CreateOperation.ts:1648` — (c-iii) → (a) PARITY, measured.** The audit was right that the
recorded reason describes six kinds that never arrive and not the one that does. It does not
follow that the refusal is wrong: **Prisma rejects `upsert` under a create root outright**,
on the M2M relation and on the child-held to-many alike (`Unknown argument 'upsert'` — the
create-root nested input type has no such key). So the refusal is a boundary viborm SHARES.
What the audit actually found is an asymmetry inside viborm's own SUPERSET: the child-held
sibling accepts `upsert` under create as a documented adopt-and-update extension, and the
M2M leg does not. Closing that is extending a superset, not restoring parity — named as a
follow-on, and the site's false comment is the thing to fix first.

**The compound identity family — 4 rows, (c-ii) → (b), one shared measurement.**
`UpdateOperation.ts:1231`, `RelationUpsertPart.ts:853`, `nested-target-parts.ts:336` (a
compound-PK CHILD in any nested targeted mutation) and the compound half of
`UpdateOperation.ts:2318`. The audit proposed *"the per-field generalization ATOM §1 applied
to FKs"*. **Measured, that premise conflates two different objects.** N1-U2 generalized the
FK ASSIGNMENT — values written INTO columns — and the structures for it are already
per-field: `ParentHeldCorrelation` carries `childReferencedFields` and `parentFkFields` as
arrays with a per-field `override` map. What a nested targeted mutation needs is the other
object: the **produced identity a later step ADDRESSES**. That is single-column all the way
down — `childPrimaryKey: string` threaded through 96 occurrences in five V2 files, a
`capturedWhere` built as `{ [childPrimaryKey]: capturedPk }`, and, at the bottom, ATOM §1's
own step vocabulary: `StatementOutputSource`'s `firstRowField` carries **`field: string`**,
one column, no tuple form. There is no mechanism to wire; the value cannot be named. Closing
it is a VOCABULARY amendment (a multi-column produced output, then a tuple `capturedPk`),
which is why these move to (b) rather than staying (c-ii) — the section's line is "no
existing mechanism spells the missing value", and none does.

**`UpdateOperation.ts:2318` — SPLIT, and only half of it moves.** The guard rejects four
conditions at once. The compound conditions (`fkFields.length !== 1`, `pkFields.length !== 1`,
`childPrimaryKeys.length !== 1`) are the (b) above. The FOURTH — `pkFields[0] !==
childPrimaryKeys[0]`, a single-field reference to a NON-PK unique — is a different animal
and stays **(c-ii)**: nothing about it is tuple-shaped, the correlation reads the child by
that column, and capturing the child's PK from that same read is precisely what N4-U1 taught
`RelationWritePart` to do. Counted once, in (c-ii), because that is the class that still
owes.

**`RelationWritePart.ts:681` — (c-ii) CONFIRMED, with the sharpest recipe in the set.** The
decline is gated on `!this.config.where`. Measured: `isTargeted()` is `kind === "update" ||
kind === "delete"`, so an inverse-side to-one `update` **does** build the correlated probe —
the locate exists, the payload simply spelled no selector. The gate asks the wrong question
("did the user name a row?") where the answerable one is "does this Part locate a row?".
N4-U1 already publishes that probe's captured PK as a `planned` source
(`probeCarriesLocatedPk`). One condition, not one mechanism.

**The remaining 12 (c-ii) rows keep their disposition, each with its measurement stated.**
Grouped by the ONE thing each family needs, because the audit's row-by-row form hid that
they are four jobs, not twelve:

| Family | Rows | What was measured |
|---|---|---|
| **The upsert-arm grandchild fold** | `RelationUpsertPart.ts:708` / `:1019` / `:1073` / `:1079` | `buildUpdateArmParts` dispatches on the KIND with the direction unexamined — the same defect that made `:708`'s (c-i) claim false. What it needs is `buildNestedTargetChildParts`, which this module cannot import without a cycle; N4-U2 solved exactly that with an injected `FreshArmBuilder` seam, so the mechanism AND the technique both exist. One wave, four rows |
| **Parent-held to-one, the non-link kinds** | `UpdateOperation.ts:2594` / `:2773` / `:2788` / `:2839` / `:2856` / `:3280` | Every recorded reason names V1 (`getUpdatedPrimaryKeyWhere`, `appendCreate`, *"routed to V1"*, *"out of P2a scope"*) on a branch where V1 is deleted. Three have a named twin at the CREATE root: `resolveSharedPkIdentity` (N4-U4), `nestedFresh` (X1b), and `buildConnectSubqueryForField` (T3c) — the last is a two-line lift, `toOneFkAssignLiteral` is `toOneFkAssign` minus the subquery branch. **The one question a wave must answer first, newly measured:** an engine-injected lookup subquery lands in the root SET, where `assertRelationKeyUpdatesAreCompilable` walks relation-key columns and refuses a non-resolved operand. It walks USER `scalarData`, so today it does not see the injection — the wave has to decide whether that stays true when the FK column is itself referenced by another relation |
| **Junction** | `RelationJunctionPart.ts:1662` / `:2120` | Unchanged from the audit, and the audit's reading holds on re-read: `:1662`'s *"deeper child Parts fold against a compile-time `literalParentId`"* is verbatim the reason N4-U2 measured and DELETED at `RelationUpsertPart.createArmParentId`, and `:2120`'s reachable half is the connectOrCreate adopt arm, whose create-arm children are what N4-U2 absorbed for the child-held sibling |
| **Create root + PK-transition merge** | `CreateOperation.ts:822` / `:1341`, `RelationWritePart.ts:765` | `:822` is a predicate narrower than its own update-root twin (`isToOne \|\| type === "oneToMany"`), re-measured by U-A and still reachable. `:1341` needs the fresh-parent adopt's `ParentIdSource` to carry per-field values — the ASSIGNMENT object, so unlike the family above this one really is N1-U2's generalization. `:765` names its own fix (`RelationSetConfig.correlationParentId`, carried into `RelationJunctionPart`) |

None of the twelve was absorbed here, and saying why is part of the record: each is a WAVE,
not an edit — the smallest is the two-line connect subquery, and it carries the legality
question above with it. Recording them as measured (b) would have been the easy way to reach
a "floor", and it would have been false: the mechanism exists in this engine for every one
of them. They stay (c-ii). **The floor is 23 sites away, not 0.**

#### N7-U-B — certification

| Step | Result |
|---|---|
| `pnpm test:types` (TS 5.9.3) | clean |
| Full estate, ALONE (`--minWorkers=1 --maxWorkers=4`) | **9116 passed / 0 failed**, 259 files (9003 at the U-A baseline; the +113 is this wave's witnesses on the three local engines) |
| `pnpm test:gates` | **72 / 72**, 5 files (unchanged) |
| Census pin | **40** (`route-inventory.test.ts`), with the count-evolution entry naming the five sites and the two silent divergences |
| Biome (repo-pinned, per file) | every changed file exits 0 |
| Docker MySQL 3307 | **971 passed / 0 failed** (941 baseline + 15 × 2 substrates) |
| Docker Postgres 5434 (`pg` + `postgres`, serial) | **1084 passed / 0 failed**, 14 skipped (1054 baseline + 30) |
| SQLite3 + LibSQL | **2161 passed / 0 failed** |
| PGlite, both substrates | **32 passed** (15 × 2, plus the two public-client witnesses) |

That estate figure is a re-run AFTER the witness harness was reworked for the Docker legs,
so the caveat this table carried in its first form — *"the estate ran once, green, before
the rework; everything changed after that point is a test file"* — is retired rather than
inherited. The re-run is what moved the number from 9114 to 9116: the rework drives the
subject at the operation seam, and the two tests it added to keep the PUBLIC client path
witnessed are the whole delta. The reworking is recorded in its own commit because what it
had to survive is a fact about this test estate worth keeping: a per-test driver starves
the Docker legs of connections, a cached push is dropped by a sibling suite's `force` push
(MySQL errno 1146), and a repeated push errors on the SQLite family.

#### The verifier's three notes, closed

1. **`UpsertOperation.ts:971`'s (a) citation named no Prisma behavior.** Measured: Prisma
   rejects a non-object `upsert.where` (`Argument 'where': Invalid value provided. Expected
   UserWhereUniqueInput, provided Int.`) and a non-object `.create` likewise. The row stays
   **(a)**, now with a behavioral citation instead of an internal one. (viborm answers with
   `UnsupportedOperationError` where Prisma answers with a validation error; the class
   differs, the boundary does not.)
2. **`UpsertOperation.ts:964`'s "Prisma rejects unknown arguments too" was asserted.**
   Measured: `Unknown argument 'bogusKey'. Available options are marked with ?.` The claim
   is true and no longer needs the dagger.
3. **`UpdateOperation.ts:1502` / `:1532` / `:1256` sit between (b) and (c-ii).** They stay
   **(b)**, and U-B's own work is the reason. Their N5-U2 record names a follow-on *"planned
   source carrying the SET operand"*; U-B went to that exact spot (`:1547`, the third branch
   of the same method), absorbed everything a normalization could reach, and found the
   residue to be precisely the operands with no construction-time value. The follow-on those
   three name is therefore not an unwired mechanism but the same absent one — a source that
   applies a transform, which `literal` / `planned` / `ref` each do not. All three move
   together, as the note required, and they move nowhere.

**Two of the 25 (c-i) claims were wrong, and how each was caught is worth keeping.** `:822`
fell to a purpose-built schema in the re-verification probe. `:708` fell to the ESTATE:
converting it turned `upsert-family.test.ts`'s *"depth-2 to-one grandchild refusal"* red —
a test that had been standing in front of the site all along. A reachability argument about
"every caller" is only as strong as the caller list, and the grandchild fold was not on it.
The lesson for U-B: a *"no reachable payload"* claim is refuted by one caller that
dispatches on the KIND instead of the shape.

### The verdict, plainly

**68 is not the floor, and the census number is not a count of refusals.**

Three separate findings, in descending order of how much they matter:

1. **25 of 68 sites refuse nothing.** No payload reaches them: the parse boundary answers
   first with a `ValidationError`, or the dispatch above them is total over the schema's
   own key set. They are `unknown → Record` narrowings, defensive type guards, and
   `default:` arms of exhaustive switches. This branch has twice given exactly this shape
   the right disposition — N2-U1 converted `interpretInverseToOneKind`'s `default` to a
   `QueryEngineError` (*"the dispatch is now TOTAL over the parse boundary's surface"*),
   and X1c did the same for `foldOneNestedRelation`'s two branches — and the census
   dropped by a whole site each time. Applying that established disposition to the 25
   would take the census to **43** without changing one line of user-visible behavior.
   *(N7-U-A EXECUTED this. The landing number is **45**, not 43: re-verification found
   `CreateOperation.ts:822` AND `RelationUpsertPart.ts:708` REACHABLE, so 23 converted and
   those two stayed. Finding retired. Of the four contradicted `requireRecord`/`isRecord`
   narrowings named just below, the THREE unreachable ones now throw `QueryEngineError`;
   the fourth — `UpsertOperation.ts:971`, the only one a payload reaches — keeps
   `UnsupportedOperationError` under its **(a)** disposition, which is exactly the line X2
   should have drawn.)*
   Two of them additionally contradict a claim already in the record: X2 wrote that the
   surviving `requireRecord`/`isRecord` narrowings *"throw `QueryEngineError`, never
   `UnsupportedOperationError`, so they are outside this census"* — four of them do throw
   `UnsupportedOperationError`, and three of those four are unreachable.

2. **19 of 68 are shapes this engine already has the mechanism for.** *(N7-U-A: now
   **21 of 45** — `CreateOperation.ts:822` and `RelationUpsertPart.ts:708` joined this
   class when their (c-i) claims were refuted. N7-U-B: now **17 of 40** — the compound
   identity family left for (b) on a measurement, `RelationWritePart.ts:681` was CONFIRMED
   with a one-condition recipe, and the twelve that remain are grouped into FOUR waves
   rather than twelve rows. This finding stands, narrowed, and it is the whole of what the
   census still owes.)* Every one is
   reachable, and every one's record either names a follow-on unit in its own words
   (`RelationWritePart.ts:765`, `RelationUpsertPart.ts:1019/1073/1079`) or rests on a
   reason that the engine has since retired — *"V1's staged mutation-identity
   resolution"*, *"V1's appendCreate recursion"*, *"routed to V1"* — on a branch where V1
   no longer exists. The three sharpest:
   · `RelationJunctionPart.ts:1662` refuses a relation-carrying junction create arm with
   a generated PK for **verbatim the reason N4-U2 measured and deleted** at the
   child-held sibling.
   · `RelationWritePart.ts:681` refuses an inverse-side to-one `update` carrying
   relations because it has no `where` — inside a Part that N4-U1 taught to publish its
   probe's located key as a `planned` source. This is N2-U1's finding one seam over:
   *"Only the ROOT dispatch refused it."*
   · `UpdateOperation.ts:2856` / `:3280` refuse a connect by a non-referenced unique
   through a lookup subquery that T3c already wired at the create root.
   Plus one family of three (`UpdateOperation.ts:1231`, `RelationUpsertPart.ts:853`,
   `nested-target-parts.ts:336`): a **compound-PK child** in any nested targeted
   mutation, refused while the compound-PK ROOT is supported. Sweep entry (i) listed it
   *"so the sweep is complete, not because the Ref was ever a candidate"* — a statement
   about the Ref, never a measurement about the child's key arity, and no wave has owned
   it since.

3. **6 of 68 are reachable refusals with no recorded reason at all.** *(N7-U-B
   EXECUTED this, and the class is now EMPTY: the four `false` sites and the empty nested
   `data` were ABSORBED — Prisma no-ops all five, measured live — and the M2M `upsert`
   turned out to be a PARITY refusal after all, because Prisma rejects `upsert` under a
   create root on every to-many relation. Finding retired.)*
   · `RelationWritePart.ts:666` — a nested `update`/`updateMany` with empty `data`. The
   root accepts `data: {}` and constructs; the nested spelling refuses. Measured here.
   · `UpdateOperation.ts:1923` / `:1950` / `:2485` and `nested-target-parts.ts:486` —
   `disconnect: false` and `delete: false`. N2-U3 measured Prisma's OBJECT form and
   pinned `false`'s behavior in both directions, but recorded no reason to refuse the
   literal `false` instead of no-opping it, which is what Prisma's `boolean` arm does.
   · `CreateOperation.ts:1648` — an M2M `upsert` under a create root. Its recorded
   reason describes six kinds the parse boundary never delivers, and does not describe
   the one kind that reaches it: `upsert` is viborm's own documented adopt-and-update
   superset, which the child-held sibling executes on the same payload.

**What this does NOT say.** None of the 50 is a correctness defect, and none is a
regression — every site fails closed with a typed message, and the (c-i) group cannot fire
at all. The claim being refuted is narrower and specific: that each of the 68 survivors is
*"genuinely inexpressible or a Prisma-parity refusal, each with a measured justification."*
18 of them are. For the other 50, the record does not establish it — 25 because they refuse
nothing, 19 because the record itself names the mechanism that would close them, and 6
because there is no record.

**What a justification would require, per class.** (c-i): either a payload that reaches the
site, or the N2-U1/X1c disposition — convert to `QueryEngineError` and let the census
drop. (c-ii): a measurement showing the named mechanism does **not** transfer (the shape
N4-U1 used when it kept the junction upsert arm: *"the global probe ran BEFORE this
operation's own INSERT and located nothing — a genuine absence of a value, not a missing
wire"*), or the wave that wires it. (c-iii): a live Prisma comparison for the three
`false`-literal sites and the M2M `upsert`, and a stated rule for empty nested `data`
consistent with what the root already does. *(N7-U-B: the live Prisma comparison was
run and produced all three (c-iii) verdicts — two absorptions and one parity finding — and
the rule for empty nested `data` is the one the root already used, now shared.)*

**Open notes from this audit's verifier, recorded here so they stop living nowhere.**
Three, none of them in the classes N7-U-A executed on. **All three are CLOSED by N7-U-B**
— see *"The verifier's three notes, closed"* in its section above; the originals are kept
verbatim below because a note is only worth closing if what it asked for is still legible:
1. `UpsertOperation.ts:971`'s **(a)** citation names no Prisma behavior — it cites X2's
   KEEP (why upsert has no whole-args parse), which explains why the CHECK exists, not why
   the refusal is parity. Either measure Prisma on a non-object `upsert.where` or move the
   row out of (a).
2. `UpsertOperation.ts:964`'s *"Prisma rejects unknown arguments too"* is asserted, not
   measured, and carries no `†`. It needs the dagger or a live comparison.
3. `UpdateOperation.ts:1502` / `:1532` / `:1256` sit between **(b)** and **(c-ii)**: their
   N5-U2 record names a follow-on *"planned source carrying the SET operand"*, and by this
   section's own line — a record that names a follow-on unit is NOT at the floor — that
   reads as (c-ii). They are left at **(b)** pending U-B's decision on whether that
   mechanism now exists; whichever way it goes, the three move together.

**Honest note on the (a) column.** Only three sites are parity refusals, and that is a
result rather than a gap: X2 moved viborm's Prisma-parity surface to the **parse
boundary**, where it raises `ValidationError`. A census of engine-side
`UnsupportedOperationError` sites structurally cannot see it. §3.A A17 of the capability
matrix lists nine parity refusals inside nested writes; the probe found every one of the
reachable ones answering with a `ValidationError` before any engine site is entered. The
census and A17 are both right; they are counting different layers.
