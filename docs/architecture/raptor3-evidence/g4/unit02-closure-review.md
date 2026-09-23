# G4-02 closure repair — independent review (round 5)

Reviewer: independent, did not author the unit. Inputs read in order:
`briefs/common.md`, `briefs/review.md`,
`briefs/unit02-mysql-unique-race-regression.md`, the three phase-2 reviews and
their follow-ups (`unit02-phase2-review.md`,
`unit02-phase2-review-followup.md`, `unit02-phase2-review-followup-2.md`),
`unit02/note.md` (`# Closure repair (round 5…)`, §R4.0–§R4.9, and the in-place
corrections at §R2.2, §R2.9, §R3.1, §R3.8), the two closure patches, the
receipts, and the actual source.

Source: `/Users/arnaud/code/viborm` (main tree, branch `pattern-engine`,
`HEAD 0cc61e61`). Nothing was committed, staged, or repaired by this review.
Probes: `tests/raptor3/g4/review/unit02-closure/` (3 files + workspace).
Receipts: `docs/architecture/raptor3-evidence/g4/unit02-closure-review-receipts/`.

## Outcome

**REVISE.**

Obligation 1's stated goal is met where it was measured — `g2-mysql-contracts`
is 13/13 on the live container, and every registered suite and identity in the
note reproduces byte-for-byte here — but the two new owners this round
introduces are both **wider than the shipped owners they claim to mirror**, and
each widening changes a public answer and the rows the provider holds:

1. the unique-`where` repair marks the nested `disconnect` / `delete` /
   `update` target lookups as key-addressed, where the shipped engine compiles
   those targets as an `{ equals }` **filter** (`uniqueSelectorConjuncts`). On a
   case-insensitive collation the candidate now deletes, disconnects and
   updates child rows the shipped engine refuses to touch (finding 1, measured
   on the live MySQL container, falsified against the pre-closure tree);
2. `EngineSchema.keyTransitionRefusal` pins the key's pre-value from **every**
   equality in the selector (including an extended `where`'s filter half and
   its `AND`/`OR`/`NOT` arms) and accepts a **compound** reference key, where
   the shipped owner pins from the discriminator alone and requires exactly one
   referenced member. On an absent row the candidate now refuses a creation the
   shipped engine performs — the exact mirror image of round 3's blocking
   finding, reintroduced from the other side (findings 2 and 3).

Obligation 2 (B-1c) holds up under attack: 10 of 11 adversarial cache cells are
green, including every scalar crossing of the G4 codec world, lists, JSON,
relations, `_count` and a counted aggregate, with fresh materialized graphs and
NS-04 parity against the shipped route. The one red is a pre-existing candidate
**read** divergence (decimal `_sum` on SQLite), which leaves one codec branch
unreachable and therefore unverified (finding 6).

Everything the note claims about identities, patches, costs, typecheck and
registered counts reproduces, with one count misreported (finding 5).

## Findings

### 1. [must-fix] The discriminator repair widens to the nested `disconnect` / `delete` / `update` target lookups, where the shipped engine spells a filter

**Location.** `src/query-engine/raptor3/commands/relation-body.ts:214`
(`unique: true` on the `disconnect`/`delete` target lookup) and `:346-350`
(`prepareSelector(edge.target, conditional.where, true)`, the selector shared by
`connect` / `connectOrCreate` / `upsert` / **`update`**), consumed through
`commands/selection.ts:73` and `shared/query.ts:1485`.

**Mechanism.** The note's §R4.1.3 takes the shipped split from
`buildWhereUnique` → `buildUniqueEquality` (`builders/where-unique-builder.ts:63-73`,
`:213`). That split is real, but it is not the only shipped spelling of a unique
selector: the nested-write targets are recombined by
`write-engine/shared.ts:671` `uniqueSelectorConjuncts`, which emits
`{ fieldName: { equals: value } }` and hands it to `buildWhere` — i.e. the
`exactTextEq` folded pair on MySQL (`RelationWritePart.ts:987`,
`RecordUpdateCompiler.ts:3722`, `UpdateOperation.ts:469`). Marking those
lookups as key-addressed therefore drops the case-sensitivity conjunct on a
statement the shipped engine keeps it on.

**Failing probe.**
`tests/raptor3/g4/review/unit02-closure/mysql-discriminator-scope.review.test.ts`

```
VIBORM_RAPTOR3_PROVIDER=mysql VIBORM_RAPTOR3_PROVIDER_PORT=65515 \
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/unit02-closure/review.workspace.ts \
  tests/raptor3/g4/review/unit02-closure/mysql-discriminator-scope.review.test.ts
```

Receipt: [`probe-mysql-discriminator-scope.log`](unit02-closure-review-receipts/probe-mysql-discriminator-scope.log)
(container `viborm-raptor3-g3-mysql-20260914`, `d6da412eec3c`, `127.0.0.1:65515`,
table collation `utf8mb4_0900_ai_ci`, each cell re-seeded and run on both
engines, comparing the answer **and** the rows afterwards):

| request | shipped | candidate |
| --- | --- | --- |
| `owner.update({ where:{id:"wanted"}, data:{ notes:{ disconnect:[{id:"N1"}] } } })` | `NestedWriteError: Cannot disconnect relation 'notes': target record was not found for this parent.` — row untouched | `ok`, and `notes.ownerId` set to `NULL` |
| the same with `delete:[{id:"N1"}]` | `NestedWriteError: Cannot delete relation 'notes'…` — row untouched | `ok`, and **the child row is deleted** |
| the same with `update:[{where:{id:"N1"},data:{title:"u"}}]` | `NestedWriteError: Cannot update relation 'notes'…` | `ok`, and the child row is updated |

**Falsification (this round introduced it).** Reverse-applying
`production-closure.patch` reproduces the six base identities the note claims
(`query.ts 5143b7b3…`, `schema.ts 07b3df1a…`, `commands.ts f4ecd7ad…`,
`selection.ts 874dc5ec…`, `relation-body.ts 79066ea8…`,
`client-route.ts 82ba9c9e…`) and the same probe then reports a **different**
divergence set — the three cells above AGREE on the pre-closure tree, and the
five the repair fixed (root `delete`, root `upsert`, nested `set`, nested
`upsert`, the compound selector) are the ones that were red. Receipt:
[`falsify-discriminator-scope-2.log`](unit02-closure-review-receipts/falsify-discriminator-scope-2.log)
(identities recorded in and out of the swap; restored and re-hashed in the same
receipt).

**What would resolve it.** Either narrow `SelectionSource.unique` to the call
sites whose shipped counterpart is `buildWhereUnique` (the root verbs, the
`connect`/`connectOrCreate` probe, the `set` target, the compound selector) and
leave the nested `disconnect` / `delete` / `update` targets as filters; or keep
the wider rule and record it as an observable compatibility decision for Arnaud
with both engines' answers pinned (`common.md`: "A new observable compatibility
choice is a decision for Arnaud … do not copy or 'fix' legacy behavior"). It is
currently neither.

### 2. [must-fix] `keyTransitionRefusal` pins the pre-value from equalities the shipped owner never reads, and refuses a creation the shipped engine performs

**Location.** `src/query-engine/raptor3/shared/schema.ts:269-292` (the method,
`if (!pinned.has(keyField)) continue` at `:276`), called from
`src/query-engine/raptor3/commands/commands.ts:1169-1173` with
`lookup.selector.facts.equals`.

**Mechanism.** The shipped owner's pre-value comes from
`pinnedTargetValues` (`write-engine/shared.ts:154-166`) → `getWhereUniqueEntries`
→ `partitionWhereUnique`: the **discriminator only**. An extended `where`'s
filter half and its `AND`/`OR`/`NOT` arms are filters there by construction.
The candidate's `facts.equals` is populated by `prepareScalarPredicate`
(`shared/query.ts:1111`) for *every* equality the selector walks, including
the arms of `AND`/`OR`/`NOT` (`prepareWhere` passes the same `facts` object down
at `:1043-1047`). A key pinned only inside an arm therefore makes the candidate
name a post-transition value the shipped engine cannot name.

**Failing probe.**
`tests/raptor3/g4/review/unit02-closure/upsert-transition-scope.review.test.ts`
(`node scripts/run-vitest-safe.mjs run --workspace=tests/raptor3/g4/review/unit02-closure/review.workspace.ts tests/raptor3/g4/review/unit02-closure/upsert-transition-scope.review.test.ts`),
receipt [`probe-upsert-transition-scope.log`](unit02-closure-review-receipts/probe-upsert-transition-scope.log):

| request (`upsert`, SQLite, differential) | shipped | candidate |
| --- | --- | --- |
| `where:{ code:"c6", AND:[{id:6}] }`, `update:{ id:{divide:0}, items:{create:[…]} }`, **row present** | `QueryEngineError: Cannot divide primary key field 'id' by zero.` (the validator's sentence) | `QueryEngineError: Cannot divide a primary key by zero.` — **different error identity** |
| the same with `where:{ code:"nope", AND:[{id:6}] }`, **row ABSENT** | `ok:{"id":99,"code":"nope","label":"fresh"}` — **the row is created** | the transition refusal, **nothing written** |

**Falsification.** Reverse-applying only the `schema.ts` + `commands.ts` hunks
reproduces the round-4 identities (`07b3df1a…`, `f4ecd7ad…`) and both cells go
green, while the two cells this round genuinely fixed (a bigint `divide: 0n`,
and a `connect` payload on the child-held relation) go red — 2 failed / 7
passed on the base versus 4 failed / 5 passed on the closure tree. Receipt:
[`falsify-transition-owner.log`](unit02-closure-review-receipts/falsify-transition-owner.log).

**What would resolve it.** Consult the discriminator's own pins rather than
`facts.equals` — the selector already distinguishes them now that
`prepareSelector` carries `unique` (the `key: true` prepared columns are exactly
the shipped `entries`) — or pass the admitted discriminator map explicitly from
the upsert branch.

### 3. [must-fix] `keyTransitionRefusal` fires for a COMPOUND reference key, where the shipped owner requires exactly one referenced member

**Location.** `src/query-engine/raptor3/shared/schema.ts:280-289`
(`edge.pairs.some((pair) => pair.source === keyField)`).

**Mechanism.** `RecordUpdateCompilerState.interpretReferencedKeyTransition`
builds the analysis-time literal only under
`referencedFields.length === 1 && readSources[0].kind === "literal" &&
Object.hasOwn(input.rootScalarData, referencedFields[0])`
(`write-engine/RecordUpdateCompiler.ts:3309-3326`); the comment there is
explicit that "a compound one falls through to the per-member compile-time
source rather than borrowing member zero's answer". `pairs.some(...)` accepts
the compound edge, so the candidate refuses where the shipped engine proceeds.

**Failing probe.** Same file as finding 2, cells 3 and 4 (model `pairOwner`,
`.id(["a","b"])`, child `pairPart` referencing both members):

| request | shipped | candidate |
| --- | --- | --- |
| `upsert({ where:{a_b:{a:2,b:3}}, update:{ a:{divide:0}, parts:{create:[…]} } })`, row present | `QueryEngineError: Cannot divide primary key field 'a' by zero.` | `QueryEngineError: Cannot divide a primary key by zero.` |
| the same with `where:{a_b:{a:7,b:8}}`, **row ABSENT** | `ok:{"a":7,"b":8,"label":"fresh"}` — **row created** | the transition refusal, **nothing written** |

Both cells are green on the pre-closure tree (same falsification receipt as
finding 2).

**What would resolve it.** Mirror the arity condition: only a reference key
whose referenced members are exactly one field, and whose one member the payload
rewrites, may raise the transition sentence.

### 4. [note] §R4.1.5 misidentifies the nested call sites the repair changed — which is why the widened ones went unmeasured

`note.md` §R4.1.5 lists the nested sites as "the `connectOrCreate` probe
(`:214`), a conditional's own selector (`:346`) and a `set` target lookup
(`:580`)". In the source, `relation-body.ts:214` is the **`disconnect` / `delete`**
target lookup (`case "disconnect": case "delete":` at `:203-204`, error text
"target record was not found for this parent"), and `:346-350` is the selector
shared by `connect`, `connectOrCreate`, `upsert` **and nested `update`**
(`case "connect": … case "update":` at `:316-319`). The unit's own native cell
consequently measures `connectOrCreate` and root `update` but none of the four
verbs the second site actually covers. Correcting the list is what turns
finding 1 into a measured scope statement.

### 5. [note] `g4-route-lifecycle` is reported as 3 passed; its own receipt and this review both measure 8

§R4.2 ("`g4-route-admission` 7, `g4-route-lifecycle` 3, `g4-route-transactions`
13 — all unchanged") and the §R4.5 table both say 3. The cited receipt
[`closure/g4-route-lifecycle-final.log`](unit02/receipts/closure/g4-route-lifecycle-final.log)
says `Tests 8 passed (8)`, my re-run says 8
([`g4-route-lifecycle.log`](unit02-closure-review-receipts/g4-route-lifecycle.log)),
and the unit's own earlier receipts (`receipts/after2/`, §R.6, §P.12.2) say 7 —
so the registered count also moved 7 → 8 during the round (not by this unit's
files; `route-lifecycle.test.ts` is not in `tests-closure.patch`). "Registered
count changes … none" is therefore inaccurate as written, and the integrator
should be told which stream's +1 it is.

### 6. [note] B-1c's widened-sum branch is unreachable on the only provider it is exercised on

`route/client-route.ts` `leafCodec` compiles `compileWidenedSumCodec(declared)`
for a decimal `_sum`. On SQLite the candidate's **read** refuses any decimal
`_sum` first — `QueryEngineError: Driver "sqlite3" returned a malformed decimal
scalar for operation "aggregate": the sum is not an exact decimal at this
column's scale` (`shared/query.ts:3610-3627`) — where the shipped engine answers
`Decimal:123456.001`. The divergence is pre-existing (nothing in the closure
diff touches that decode), but it means the `widened` arm of the new codec is
never executed by any cell in the estate, on top of §R4.9 item 5. Probe:
[`probe-route-cache-codec.log`](unit02-closure-review-receipts/probe-route-cache-codec.log)
cells "aggregate, decimal sum of one row" and "aggregate". The other ten cells
pass, including the full 23-scalar codec world (bigint past 2^53, blob with NUL
and high bytes, epoch DateTime, date, time, enum, nullable JSON, nine list
types), a relation include, a NULL to-one, a relation `_count`, an integer-only
aggregate, a located `null`, and fresh-graph identity on every hit — each
compared with the shipped route's own cached value (NS-04).

### 7. [note] R-D4's divergence is created by this round, not inherited

§R4.9 item 7 records that "pre-existing is an argument here, not a receipt".
The receipt exists now: on the pre-closure tree the candidate **refused** the
collation-equal `connect` outright (`NestedWriteError: Cannot connect relation
'owner': target record was not found.`), so the FK byte difference the note
records as R-D4 is reachable only after this repair. R-D4 should be owned by
this round (and it applies to plain `connect`, not only `connectOrCreate`):
shipped writes `ownerId = "WANTED"` (the request literal), the candidate writes
`ownerId = "wanted"` (the located row's key). Receipts:
[`probe-mysql-discriminator-scope.log`](unit02-closure-review-receipts/probe-mysql-discriminator-scope.log)
and [`falsify-discriminator-scope-2.log`](unit02-closure-review-receipts/falsify-discriminator-scope-2.log).

### 8. [note] The transition refusal re-derives a fact the command tree already owns

`relation-body.ts:193-200` already computes, for exactly this shape, that a
child-held reference edge references a field the payload writes
(`parent.transitions.push(edge)`). `keyTransitionRefusal` walks
`model["~"].relationNames` over the raw payload a second time
(`schema.ts:280-289`) to answer the same question at a different moment — a
fourth inline `relationNames`-over-`data` walk added in the same round whose
note-item 4 makes `namesRelation` "the one spelling". The §7 cost of that second
derivation is findings 2 and 3: the two conditions drifted from the shipped
owner's precisely because they were restated instead of read off the structure
the tree already builds.

## What was verified and holds

**Suites re-run independently, serially, through the bounded runner** (receipts
in `unit02-closure-review-receipts/`; native rows on
`viborm-raptor3-g3-mysql-20260914` `d6da412eec3c` `127.0.0.1:65515` and
`viborm-raptor3-g3-pg-20260914` `7dfda37e8eea` `127.0.0.1:65504`):

| mode / suite | measured | note's claim |
| --- | --- | --- |
| `g2-mysql-contracts` (65515) | **13 passed** | 13 ✔ |
| `g2-mysql-baseline` (65515) | **13 passed** | 13 ✔ |
| `g2-pg-contracts` (65504) | **18 passed** | 18 ✔ |
| `g2-pg-baseline` (65504) | **17 passed** | 17 ✔ |
| `g2-contracts` / `g1-contracts` | **216 / 143 passed** | 216 / 143 ✔ |
| `g3-suppression-retry` / `g3-transaction-array` / `g3-bulk-series` | **2 / 4 / 6** | 2 / 4 / 6 ✔ |
| `g3-execution-review` / `g3-generated-transport-smoke` | **6 / 1** | 6 / 1 ✔ |
| `g29-result-progress` / `g4-read-contracts` | **2 / 62** | 2 / 62 ✔ |
| `g4-route-cache` / `g4-lifecycle-admission` / `g4-lifecycle-events` | **7 / 4 / 3** | 7 / 4 / 3 ✔ |
| `g4-route-admission` / `g4-route-lifecycle` / `g4-route-transactions` | **7 / 8 / 13** | 7 / **3** / 13 — finding 5 |
| G4-02 author estate, SQLite (19 files) | **98 passed / 7 skipped (105)** | 98 / 7 ✔ |
| G4-02 author estate, native MySQL | **104 passed / 1 skipped (105)** | 104 / 1 ✔ |
| frozen fast-path pins | `physical-envelope` **10**, `packaged-array` **5**, `prepared-operation` **5** | unchanged ✔ |
| `node scripts/run-typecheck.mjs` | exactly the two permitted `pattern/pack.ts` diagnostics (1443, 2633) | ✔ |

**Recovery scope (RF-12).** The repair adds no recovery owner and no replay:
`shared/operation-context.ts`, `commands/execution.ts`, `commands/assignments.ts`,
`commands/index.ts`, `shared/storage.ts`, `program/index.ts` and all four
adapters are byte-identical to their round-4 identities — all 18 production
hashes in `receipts/closure/identities-closure.txt` reproduce exactly here. The
MySQL adapter's only diff versus `HEAD` is `expressions.integerDivide`;
`exactTextEq`'s folded pair at `:537` is `HEAD`'s, which confirms the
attribution argument of §R4.1.4 (the regression's spelling was inherited, and
the file is this unit's to repair).

**Patches.** `production-closure.patch`
(`1eea9e9fbbcd61f9bddf3197db4c50f429d9d2c68709c0be36f7102a9d912ee1`) and
`tests-closure.patch`
(`3a3c082dd5a358466cbecdc6995c0250fb5adc3ba6d4365fcf3a23458cd8d6c4`) hash as
claimed, and the production patch reverse-applies cleanly and reproduces all six
base identities (verified twice, restored and re-hashed each time).

**Cost.** Recomputed independently: the whole `src/query-engine/raptor3` tree
(15 files) is **388,208 bytes / 11,142 physical**; the 12-file candidate core
(the tree minus `route/client-route.ts` and `program/`) is **352,596 / 10,128**;
`schema.ts` 16,837 / 477; `client-route.ts` 14,880 / 378;
`selection.ts` + `relation-body.ts` 32,971 / 1,010; the "four phase-2 files"
(`query.ts`, `commands.ts`, `shared/operation-context.ts`, `commands/index.ts`)
261,301 / 7,382. Every figure in §R4.6 is reproducible to the byte.

**Working tree.** Nothing staged; the modified-tracked-file set is exactly the
session-start set; the only additions are this review, its receipts directory
and `tests/raptor3/g4/review/unit02-closure/`.

## Unverified author claims

1. **NS-04 "same cached value identity rules"** beyond the shapes measured
   here: no cell compares cache KEYS across routes for the rich world; my
   probes compare stored/materialized VALUES only.
2. **"No PostgreSQL behaviour changes"** (§R4.9 item 4) — still an argument
   from `exactTextEq` being a plain `=` on PostgreSQL plus two green gates; no
   differential PostgreSQL cell can distinguish the spellings, and I added none.
3. **The upsert key gate on PGlite / native PostgreSQL** (§R4.9 item 3) —
   unchanged; my transition probes are SQLite-only, for the same
   provider-independence reason the note gives.
4. **`core-structure` (§R3.8 item 5)** was not re-measured by the author this
   round, and not by this review either.
5. **R-D3** (the scalar-only batch-publication gap) is recorded with both
   engines' answers pinned; I did not re-measure it.
6. **The `g4-unit02-author` registration request** (§R4.8) is still unmade, so
   the 105-cell estate remains outside every registered mode and outside the
   credential-free walk.
