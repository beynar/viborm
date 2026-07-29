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

### N4-U2 / N4-U4 — NOT delivered in this lane

`N4-U2` (create-arm one-level-deeper kinds) and `N4-U4` (shared-PK edges, the
`CreateOperation` sweep entry (g) sites) were not reached. Sweep entry (g)'s reading
still stands and is untouched by this lane: those sites are on a CREATE root, which has
no locate step, so their absorption needs the producing INSERT's returned identity, not
a located-parent read. Both remain open with their owners as written.

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

## N6 — Beyond Prisma (decision-gated; each unit needs a maintainer yes)

| Unit | What | Decision |
|---|---|---|
| N6-U1 | **Extended whereUnique in nested target selectors** — W4 deliberately kept them strict; with N1/N4 landed, the collision that forced that scoping is gone. Superset: Prisma's nested selectors are unique-only in several positions. | D-N1 |
| N6-U2 | **Relation filters inside a unique where** — refused today because the filter half compiles into UPDATE/DELETE where MySQL rejects reading the mutated table; the 1093 derived-table wrapper already exists for updateMany — compose it. | D-N2 |
| N6-U3 | **Own-write linearization** (A14: `{ posts: { create, connect } }` same-tree overlap) — Prisma linearizes some of these; ATOM §4 refuses by doctrine because per-Part legality re-derivation "forks the theorem". Default: KEEP the refusal. Only revisit with an explicit doctrine change. | D-N3, default NO |

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
