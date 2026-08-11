# The Forbidden Shapes — a reference with examples

**Date:** 2026-08-05
**Re-anchored:** 2026-08-11 (Package N3) — COMPLETE, every section, against the tree at the Package N commit. The three partial re-anchors this file used to record (Packages F, E, and K's one-line fix) are folded in and their deferral notes deleted, because there is nothing left for them to defer.
**Re-anchored again:** 2026-08-11 (the **Package O gate**), against the tree after "refactor: give query engine guards one owner". Package O compressed the census from 21 write-engine sites to 15 and this file went on stating 21/24/26 and "12 distinct invariants" in the present tense — the exact failure its own anchoring convention exists to prevent, one package later. What changed here: §12's site tables gained a HEAD column and RETIRED markers, the distinct-invariant section was corrected (row 4 is two invariants, so the base was 13 and not 12), the §O4 verdict paragraph now records that the architecture review WAS conducted and approved all 19 survivors, and every coordinate pointing into a file Package O touched was re-resolved. **The shapes themselves did not change: not one refusal was lifted, added or narrowed by Package O.** Its subject was ownership, not capability.
**Scope:** the 30 refusals standing after PR #20, MINUS the 9 the final re-audit re-filed as expressible work, MINUS the 2 Package B deleted, MINUS the 1 Package F deleted, MINUS the 4 of §1 Package H delivered, MINUS §7.1, which Package D deleted and which this file went on presenting as standing for a day. What remains is **18 shape entries**, each with the payload that raises it and the reason it stands. They covered 20 of the 21 write-engine sites when N3 wrote this: §2.2 and §2.5 each held two positions, and the twenty-first (an atomic batch cannot publish a produced column) is a substrate fact rather than a shape and is classified in §12 instead. **After Package O the same 18 shapes are expressed by 15 sites** — six positions folded into owners that already said the same sentence, and one (§10.1) changed error class. A shape whose site count fell is still refused, by the same words, at the same moment.

Every refusal below is an `UnsupportedOperationError` raised at CONSTRUCTION — before any statement runs, so nothing is written. Each has a committed witness in `tests/contracts/engine/write/`. The examples are derived from the refusal conditions in code, the re-audit's per-site arguments, and those witnesses; they show the SHAPE, not a runnable fixture.

**Anchoring convention.** A refusal SITE is anchored on its
`throw new UnsupportedOperationError(` line, not on the message template one line
below it. A named guard FUNCTION is anchored on its declaration line instead, and
is always given by name — `RelationWritePart.ts:1250`
(`assertOwnedFkAbsentFromUpdateData`) is a throw, and `:1240` is that same
function's declaration (N3 anchored the same pair at `:1244`/`:1234`, before
Package O shifted the file). The limitation-lift plan and the parity witnesses use the
same two rules; when a number here and a number there differ, the file that moved is
the one at fault.

**Every coordinate below was resolved against the tree on 2026-08-11**, one at a
time, by opening the line. Eighteen of the twenty-two were stale; four were correct.
The re-anchor is a Package N3 obligation, not Package O's — the two sentences that
used to defer it, and the third that deferred the compound-child-PK row, are gone
with the drift they described.

Two things had moved before that and neither changes a shape:

- The selected-record refusals left `UpdateOperation.ts`; `RecordUpdateCompiler.ts`
  owns them now, and `UpdateOperation.ts` holds no refusal site at all. The one
  remaining site in that neighbourhood is `UpsertOperation.ts:1147` (§9.1) — a
  different file, and the sentence said `UpdateOperation` until the Package N gate
  re-measured it (`grep -c` over the file returns 0).
- Three shapes gained a bound-polymorphic twin position (§2.2, §2.5, and the
  compound-child-PK family under "What is NOT here"), and one shape moved out of
  the write engine entirely (that section's last row).

The executable census owner is
`tests/contracts/engine/write/operation-construction-inventory.test.ts`; it pins
**15** `new UnsupportedOperationError` sites under `src/query-engine/write-engine`
(2026-08-11, after Packages B, C, D, G, F, J, H, K, N and O — J added one, H removed
four and added one, K added one, N added and removed none, **O removed six**). It
pinned **21** when N3 wrote the paragraph above. The whole-`src` count is **19**:
those 15, plus `relation-key-legality.ts` ×1 and `builders/decimal-portability.ts`
×1 inside `src/query-engine`, plus `src/drivers/shared/transaction-options.ts` and
`src/client/raw.ts` outside it. The query-engine count — the scope §O4's grep names —
is **17**.

Sites are positions, not shapes, and the mapping between the two is what that census
test's narrative owns — including the sites that are deliberately not shapes in
this document, each named where it belongs below. **§12 gives every one of the 19 its
single classification bucket**, which is the measure the limitation-lift plan's §O4
calls the more important one: the 17 query-engine sites express **12 distinct
invariants**, and the engine owns **13** (the thirteenth, compound many-to-many, is
refused by `getRequiredSinglePrimaryKeyField` as a `QueryEngineError`, so no census
grep sees it). The per-site reasoning, the §O3 five-question audit and the §O4
adjudication record live in `docs/architecture/guard-ownership-ledger.md`, which is
this document's companion: **this file owns the SHAPES, the ledger owns the
OWNERSHIP, and the inventory test owns WHAT IS THERE.**

## The schema these examples use

```ts
const org = s.model({
  id: s.int().id().increment(),
  name: s.string(),
  code: s.string().unique().nullable(),      // a NON-PK unique some FKs reference
  members: s.oneToMany(() => member),
  tags: s.manyToMany(() => tag),
});

const member = s.model({
  id: s.int().id().increment(),
  name: s.string(),
  orgCode: s.string().nullable(),
  org: s.manyToOne(() => org).fields("orgCode").references("code").optional(),
});

const user = s.model({
  id: s.int().id().increment(),
  email: s.string().unique(),
  profileId: s.int().unique().nullable(),
  profile: s.oneToOne(() => profile).fields("profileId").references("id").optional(),  // PARENT-held
  badge: s.oneToOne(() => badge).optional(),                                            // CHILD-held (inverse)
  posts: s.oneToMany(() => post),
});
```

---

## 1. Two intents for one to-one slot (4, ALL DELIVERED BY PACKAGE H, 2026-08-10) — and the one shape that replaced them (1)

A to-one slot holds exactly one row. Two identity-supplying kinds are two intents, and no ordering makes them one. **That premise survives; the four sites below do not.** Package H replaced "how many kinds" with "which composition": a to-one relation accepts `(vacate?, supplier, modify?)`, and `composeToOneEntries` (child-held and polymorphic-inverse) plus `interpretParentHeldComposition` (parent-held) enumerate that lattice TOTALLY. Two suppliers are still two intents and are still refused — by `to-one-mutation-schema.ts`, the lattice's single owner, before any of this code runs.

Each entry below is kept with its original text and a **delivered** note, because a coordinate that vanishes teaches nothing. The census moved 23 → 20 across this package: four `UnsupportedOperationError` sites removed, one added — **§1.5**, which is a shape in its own right and is written out below rather than left as prose.

**What the four became.** `CreateOperation`'s two lines survive as `QueryEngineError` assertions in place — under the CREATE root the to-one input owns neither `update` nor a vacate key, so their only multi-entry payload is supplier + supplier and the schema answers first; reaching them means the schema and the dispatch disagree, which is an engine fault, not a declined shape. `RecordUpdateCompiler`'s two are deleted outright.

**The one site added,** and it is a different claim: `create` or `connectOrCreate` composed with `update` is refused because a selected-record compiler locates its record with a PLANNING read, planning precedes every write, and those two suppliers only produce the row's identity by inserting it. `connect` composes, because a unique selector is an identity that exists before the fragment's first write. The site names that obstacle, so it stays truthful until the produced-identity selector channel lands.

**Three shapes the lattice admits and `OwnWriteLedger` still refuses** (a `NestedWriteError`, not a census site): parent-held `delete` + `connect`, and child-held `delete` + supplier + `update`, both because `delete: true` names the CURRENT member — an identity unknown at construction — so the analyzer cannot rule out that it is the very row the sibling reads.

Witnesses: `parity-h-to-one-lattice.test.ts` (plans, refusal sentences, census), `vacate-then-supply.test.ts` (all 21 pairs and all 6 triples by OWNER, plus the parent-held direction's state), `shared-pk-supply-modify.test.ts` (the shared-key fold through a composition).

**1.1 — parent-held to-one under `create`** · was `CreateOperation.interpretParentHeld` — **DELIVERED (H): now a `QueryEngineError` engine-fault assertion in place**

```ts
client.user.create({
  data: {
    email: "a@b.c",
    profile: { create: { bio: "x" }, connect: { id: 7 } },   // ✗ two kinds
  },
});
// query-engine-v2 create supports one operation on the to-one relation 'profile'; it has connect, create.
```

The site is still spelled `!== 1`, so it reads as if it also refused **zero** kinds (`profile: {}`). It does not, and the parity question this note used to carry is settled: `buildRelationMutationProgram` returns `undefined` for a payload with no active kind (`builders/relation-mutation-parser.ts:309`) and `buildParsedRelationPrograms` records no program for it (`:354`), so an empty to-one payload is Prisma's measured no-op in BOTH directions and reaches no record compiler at all. The `!== 1` and its `|| "none"` message tail are unreachable spelling; the child-held twin already counts `> 1`.

**1.2 — child-held/inverse to-one under `create`** · was `CreateOperation.interpretChildHeld` — **DELIVERED (H): now a `QueryEngineError` engine-fault assertion in place**

```ts
client.user.create({
  data: { email: "a@b.c", badge: { create: { label: "x" }, connect: { id: 3 } } },  // ✗
});
```

Newly forbidden in PR #20 (D5). Before the fix this ran **both** kinds and put two rows in a to-one slot.

**1.3 — parent-held to-one under `update`** · was `RecordUpdateCompiler.interpretRelation`'s `kinds.length !== 1` — **DELIVERED (H): deleted; `interpretParentHeldComposition` accepts the five replacements and `connect` + `update`**

```ts
client.user.update({
  where: { id: 1 },
  data: { profile: { disconnect: true, connect: { id: 2 } } },   // ✗ on the PARENT-held side
});
```

The vacate-then-supply pairs E6.5 absorbed apply to the **child-held** direction only. Here `delete`'s FK-null lands in the post-root bucket *after* the supplier's rebind has been folded into the root SET, so the pair would orphan the supplied row. Measured, not assumed.

**Delivered by H/R2.** The orphan was an ORDERING fact, and the ordering is now owned: when a sibling supplier rebinds the edge's foreign-key columns, the vacate contributes no assignment at all (per-column precedence, decided before the root SET is assembled — replacing an `Object.assign` order accident) and the FK-null UPDATE is not emitted. The correlated DELETE stays and still addresses the OLD value, inlined at compile from the located row. `delete` + `connect` on this direction is the one replacement that does not execute, and its owner is the own-write ledger, not this site.

**1.4 — child-held to-one under `update`, supplier × supplier** · was `assertToOneMutationArity` — **DELIVERED (H): deleted; `composeToOneEntries` owns the order and the membership question. The supplier × supplier shape below stays refused, by the LATTICE.**

```ts
client.user.update({
  where: { id: 1 },
  data: { badge: { create: { label: "x" }, connect: { id: 3 } } },   // ✗
});

// ✓ this now WORKS (absorbed by E6.5 — vacate then supply):
client.user.update({
  where: { id: 1 },
  data: { badge: { disconnect: true, connect: { id: 3 } } },
});
```

**1.5 — a PRODUCING supplier composed with `update`, child-held** · `RecordUpdateCompiler.ts:4728` (`composeToOneEntries`; the throw is `:4767`) — **ADDED by Package H, and the one shape in this document with a NAMED EXPIRY**

```ts
client.user.update({
  where: { id: 1 },
  data: {
    badge: {
      create: { label: "x" },      // ✗ so is connectOrCreate
      update: { label: "y" },
    },
  },
});

// ✓ connect composes, because a unique selector is an identity that already exists:
client.user.update({
  where: { id: 1 },
  data: { badge: { connect: { id: 3 }, update: { label: "y" } } },
});
```

A selected-record compiler locates its record with a PLANNING read, planning precedes every write, and `create` / `connectOrCreate` only produce the row's identity by inserting it. The refusal names that obstacle in its own sentence, so it stays truthful until the work expires it: **a produced-identity selector channel for `RecordUpdateCompiler`** — a final reference into an earlier INSERT's outputs, consumed by `writeWhere`, the captured-key guards and the terminal read. Type-admitted and engine-refused deliberately: the schema keeps the pair legal so the lattice has one owner, and the engine owns coherence.

---

## 2. A value that names no row (5)

A foreign key equal to `NULL` references nothing. These fire when the referenced column has no value knowable at construction — and, since Package F, only then: a value the DATABASE will produce is knowable, because the statement that produces it is one this operation is about to send.

**Maintainer ruling, 2026-08-06.** For the genuinely unknowable case the engine's refusal is CORRECT and stays: a value no row holds cannot be written, and no round trip produces one. That ruling does not cover a value the DATABASE produces — one the provider could RETURN, or that a stable unique selector could refetch after the INSERT. Those are re-audited under the limitation-lift plan's Package F (demand-driven fresh-record field publication), which classifies each site by value state and keeps the refusal only for the null, absent, or unnameable-row rows of its table. Read every entry below with that split in mind: **2.1**, **2.2**, and **2.3** are the database-produced cases Package F re-audits; **2.4** and **2.5** are the unknowable cases the ruling confirms.

**Package F delivered that re-audit (2026-08-10), and every site below SURVIVES with a narrower population.** What changed is which value states reach them, so the examples had to be rewritten: each one now spells a value the database does NOT produce, because the produced one compiles. `autoGenerate` is the only generation knob the schema language has, and `uuid`/`ulid`/`nanoid`/`cuid`/`now`/`updatedAt` all carry an application default factory the parse boundary materializes into the create data — so the database produces exactly one thing, an absent `increment` column, and that column now publishes to whoever demands it: through the INSERT's own `RETURNING` on a returning provider in a transaction, and through one focused post-insert SELECT by the created-row selector on a non-returning one. What remains refused at 2.1, 2.2, 2.3 **and 2.4** is the value state the ruling named: an omitted `.nullable()` column, which arrives as an explicit `null` because `.nullable()` sets `hasDefault: true, default: null`.

**The split sentence above is superseded for 2.4, and the correction is stated rather than edited away** because the pre-Package-F reading was the maintainer's. 2.4's site is `referencedParentSource`, which resolves each component through the SAME `recordReferenced` seam as 2.1 — so a compound edge whose failing component is a database-produced column is narrowed exactly like the single-column cases, and only its NULL member survives. Measured: `org.unique(["region","code"])` with `code: s.int().increment()` and a nested `seats: { create: … }` threw at that site at `5bf1893f` and compiles at the Package F tree with `RETURNING "code"`. **2.5** is the only entry in this section the ruling confirms untouched — its value is a column the ROOT rewrites to a non-literal, which no INSERT of this operation produces.

Package F also added **one new refusal**, kept deliberately outside this section because it is a substrate fact rather than a shape: on an atomic-batch substrate no statement's rows are addressable and the reference scratch carries the generated identity alone, so a produced column cannot be published there at all and says so in its own sentence (`CreateOperation.ts:2788`, `producedReference`, declared `:2777`). Witnessed in `fresh-produced-field-behavior.ts` and `fresh-produced-field.test.ts`; the before-picture is `parity-f-fresh-field.test.ts`.

**2.1 — the record's own referenced column, under `create`** · `CreateOperation.ts:2109` (`referencedValue`, declared `:2101`) · **PACKAGE O (2026-08-11): the shape is unchanged; its POSITION moved.** The site folded into `requireRecordReferenced` (`CreateOperation.ts:2772`, declared `:2764`, position `childEdge`); the sentence is byte-identical and `parity-f-fresh-field.test.ts:813`/`:819` still pin it.

```ts
client.org.create({
  data: {
    name: "Acme",                                  // `code` NOT spelled (nullable, no default)
    members: { create: [{ name: "x" }] },          // member.orgCode references org.code
  },
});
// … cannot resolve referenced field 'code' for relation 'members': it is neither this
// record's primary key nor a knowable value in its own create data.
```

FOUR provenances are accepted since Package F: the key the INSERT generates (a backward `Ref`), a key already in the identity, a non-PK column the create data **spells**, and — new — a non-PK column the DATABASE produces, published by the same INSERT and spent through the same `Ref` vocabulary. `code` above is none of them: it is `.nullable()` and omitted, so the parsed create data holds an explicit `null`. Declare it `s.int().unique().increment()` instead and the same payload compiles.

**Where it compiles is a provider fact, and narrower than the engine's** — worth stating because §3.2 lets a newly accepted shape cost round trips only where the provider needs them, so the matrix belongs with the shape. The lifted population is an absent NON-primary-key `increment` column, and this migration estate can only represent that on PostgreSQL (`SERIAL`/`BIGSERIAL`, any number per table) and on MySQL when it is the table's ONE auto column (`AUTO_INCREMENT`, which must also be a key — the inline `UNIQUE` satisfies that). The SQLite family cannot host it at all: its migration driver emits `INTEGER PRIMARY KEY AUTOINCREMENT` for any auto-increment column, so a non-primary one collides with the table's own primary key and a `bigInt` one is refused outright. SQLite declares `supportsReturning`, so the engine's F2 path is live there and no schema reaches it. Measured from the generated DDL of all three drivers.

**2.2 — a before-parent target's referenced column, under `create`** · `CreateOperation.ts:1789` (`targetReferencedValue`, declared `:1781`), and its bound-polymorphic twin at `:991` (inside `interpretPolymorphicRelation`, declared `:961`) · **PACKAGE O (2026-08-11): the shape is unchanged; its POSITION moved.** Both folded into `requireRecordReferenced` (`CreateOperation.ts:2772`, declared `:2764`, position `beforeParentTarget`) — this is the owner the other three cluster-1 positions joined. The polymorphic twin's prefix was normalised from `query-engine` to `query-engine-v2`, matching its siblings; nothing pinned the difference. Its `connectOrCreate` counterpart at `:1027` keeps its `QueryEngineError` class and now shares the owner's message builder.

```ts
client.member.create({
  data: { name: "x", org: { create: { name: "Acme" } } },   // org.code omitted → NULL
});
```

**2.3 — the same, at an `update` root** · `RecordUpdateCompiler.ts:3612` (`beforeTargetReferencedValue`, declared `:3604`)

```ts
client.member.update({
  where: { id: 1 },
  data: { org: { create: { name: "Acme" } } },              // org.code not spelled
});
```

**2.4 — one COMPONENT of a compound edge** · `CreateOperation.ts:2193` (`referencedParentSource`, declared `:2186`) · **PACKAGE O (2026-08-11): the shape is unchanged; its POSITION moved.** Folded into `requireRecordReferenced` (`CreateOperation.ts:2772`, position `parentId`); `parity-f-fresh-field.test.ts:830` and `compound-relation-adoption-behavior.ts:318` still pin the sentence byte-for-byte.

```ts
// org.unique(["region", "code"]); seat.(orgRegion, orgCode) references (region, code)
client.org.create({
  data: {
    region: "eu",                                  // `code` omitted → one component unresolvable
    seats: { connectOrCreate: { where: { id: 5 }, create: { label: "A" } } },
  },
});
```

E4 made the source per-field, so this is now judged **per component**: a null member makes the adopt probe match nothing silently on a nullable column, and raises a bare NOT NULL on a required one.

**2.5 — a nested create referencing a column the root rewrites to a non-literal** · `RecordUpdateCompiler.ts:1800` (inside `postTransitionReference`, declared `:1772`, which Package D collapsed THREE closures onto — `transitionedCreateParent` and `resolvePolymorphicParent` both delegate to it now) and `:2017` (the nested-create leaf, inside `resolveCreateParent`, declared `:1911`)

```ts
client.org.update({
  where: { id: 1 },
  data: {
    code: null,                                    // rewriting the referenced column
    members: { create: [{ name: "x" }] },          // would reference that column
  },
});
```

E6.6 measured that `Sql` operands are **parse-unreachable** in write data, so the reachable operand here is `null` — which names no row.

---

## 3. Shared primary key (2)

**3.1 — a shared-PK edge whose value is not a compile-time literal, under `create`** · `CreateOperation.ts:3077` (`assertSharedPkResolved`; the throw is `:3091`, and this file's convention anchors a named guard on its declaration)

```ts
const profile = s.model({
  userId: s.int().id(),                                        // PK *and* FK — the shared key
  user: s.oneToOne(() => user).fields("userId").references("id"),
  bio: s.string(),
});

client.profile.create({
  data: { bio: "x", user: { connect: { email: "a@b.c" } } },   // ✗ a lookup subquery, not a literal
});

// ✓ works — the value is a compile-time literal on both arms:
client.profile.create({ data: { bio: "x", user: { connect: { id: 7 } } } });
```

The record's own primary key **is** the edge, so its value must exist before this record's plan is built. A lookup subquery or another INSERT has no value at that phase. E6.3 tried to re-phase this and proved it impossible — a consumer structurally requires a construction-time value.

**3.2 — a shared-PK arm at a SELECTED RECORD that names no one final value** · `RecordUpdateCompiler.ts:3513` (`recordSharedKeyFold`; the throw is `:3533`) — **the narrowed residue Package E left when it LIFTED the shape**

```ts
client.profile.update({
  where: { userId: 7 },
  data: { user: { connect: { email: "a@b.c" } } },   // ✗ a lookup subquery keys nothing
});

// ✓ works since Package E — the arm's final value folds into the one root UPDATE's SET:
client.profile.update({ where: { userId: 7 }, data: { user: { connect: { id: 9 } } } });
```

Package E lifted `create`, `connectOrCreate`, `upsert` and the literal `connect` at every selected record — a shared primary key IS a primary-key transition of that record, so the arm's final value feeds the same occupied-guard and ordering machinery a scalar key move feeds. What survives is ONE sentence covering three disjuncts: the arm answers with no value at all (a correlated lookup subquery, or two arms naming different rows), the arm answers NULL, or a root SET spells the same member the arm folds and DISAGREES. §12 flags that last disjunct as a different invariant from the first two — the site is one sentence over two buckets, which is a Package O finding rather than a defect. `disconnect` and `delete` on a shared key are refused elsewhere and are not census sites; the full argument, including the deliberate over-inclusive residue, is in the "What is NOT here" Package E paragraph.

---

## 4. Junction / many-to-many (2)

**4.1 — `skipDuplicates` where no single unique names the skipped-on row** · `RelationJunctionPart.ts:1374` (inside `resolveCreatePk`, declared `:1362`)

```ts
const tag = s.model({
  id: s.int().id().increment(),
  slug: s.string().unique(),
  code: s.string().unique(),                        // TWO independent uniques
});

client.post.create({
  data: {
    title: "x",
    tags: { createMany: { data: [{ slug: "a", code: "1" }], skipDuplicates: true } },  // ✗
  },
});
```

E6.8 absorbed the two nameable cases (no conflictable unique at all → the flag is vacuous; exactly one complete unique per row → rewritten as an adopt). What remains: the probe can name a *different* row than the constraint that actually fired. Widening it was **falsified** — it joined the parent to a row the constraint may not have fired on. A compound unique with a `NULL` member stays refused for the same reason (NULL-distinct semantics).

**4.2 — a junction create arm whose subtree cannot name its own row** — **DELIVERED AND REMOVED (2026-08-10, Package F).** The recorded narrowing — "the parse boundary fills every defaulted key and requires undefaulted ones, so the public surface reaching this is small" — understated it: the surface is EMPTY. `targetPkField` is `getRequiredSinglePrimaryKeyField`, and `planNestedCreateIdentity` is total over a single-member primary key — a spelled value enters the record's identity, an absent auto-increment becomes its `generatedField`, and an absent key that is neither throws `NestedWriteError` one line earlier, inside the `createFresh` call that builds the subtree. The other two candidates die further upstream: an `Sql` primary key is parse-unreachable in write data (E6.6), and a `null` one is refused by the target's own create schema (measured: `ValidationError: … Expected integer`). So `rootReferenced` cannot answer `undefined` here, before Package F or after. The position survives as a `QueryEngineError` naming an internal invariant — the disposition `assertCreateTreeKinds` already carries — and leaves the census.

**4.3 — relation writes inside m2m `updateMany` data** · `RelationJunctionPart.ts:2354` (inside `scalarOnly`, declared `:2343`) · **PACKAGE O (2026-08-11): the shape is unchanged; its POSITION moved.** The site is DELETED and the shape is refused by the single owner, `relation-key-legality.ts:173` (`assertSelectedUpdateManyDataIsScalar`, declared `:167`), which every route into a junction `updateMany` already passed; `junction-adopt-create-relations.test.ts:678` answers there now, with the same words. The deleted copy was also the fourth reader of `Object.keys(relations)` alone — the map-only question Package K proved is a silent wrong answer for a direct polymorphic key — so the owner is strictly stronger than what it replaced.

```ts
client.post.update({
  where: { id: 1 },
  data: {
    tags: {
      updateMany: {
        where: { archived: false },
        data: { label: "x", notes: { create: [{ body: "y" }] } },   // ✗ nested relation write
      },
    },
  },
});
```

A set-based `UPDATE … WHERE id IN (…)` learns no per-row identity, and the existing per-row capture is INSERT-side (`insertId` per row) — the step vocabulary has no UPDATE-side per-row output to hand a deeper edge. Prisma refuses this at the type level; the engine's reason is its own.

---

## 5. The relation's own foreign key, spelled by hand (2)

**5.1 — spelled in nested UPDATE data** — **THE SITE IS DELETED (2026-08-11, distinct-truth Phase 2); the SHAPE is still refused, at the parse boundary, on every schema.** The retained site (`assertOwnedFkAbsentFromUpdateData`) existed for one measured divergence: `getInverseRelationMap` read a zero-argument `.fields()` as fields-bearing while the engine read length. Phase 2 aligned both filters onto one schema-layer resolver (`src/schema/relation/inverse.ts`), making the divergent schema's omission agree with the engine — the spelled key now answers `ValidationError: … Unknown key` with zero statements on the degenerate schemas too (re-measured; `nested-update-owned-fk.test.ts` re-authored). History below kept as written.

```ts
client.user.update({
  where: { id: 1 },
  data: { profile: { update: { bio: "x", userId: 2 } } },   // ✗ profile owns userId
});
```

Newly forbidden in PR #20 (D4). Before the fix the spelled value **won** — it rides the target's own SET, which lands *after* the correlation already chose the row, so the parent silently lost the child it was updating through. Measured live at three positions.

**A FOURTH position was never guarded and was still live at `e52c93de`.** `buildToManyUpdateManyParts` calls no owned-FK guard, so `posts: { updateMany: { where, data: { userId } } }` compiled to a correlated bulk `UPDATE … SET user_id = $1 WHERE user_id = <parent> …` and SUCCEEDED, reparenting the row — the same silent wrong answer PR #20 fixed one arm over. Measured through the public client before the change.

**Package N1 answers all four, plus the to-many `upsert` UPDATE arm under an update root, at the PARSE BOUNDARY.** Nested update data is now built from the omitted-FK owner nested create data has always been built from — `v.omit(core.update, fkFields)`, `UpdateWithOmittedFk` in `src/validation/relations/create.ts` — so the payload above is `ValidationError: … Unknown key: userId` before an operation is constructed, and the column is not offered by the schema TYPE either. The omission is scoped to the edges whose TARGET row holds the foreign key; a `manyToMany` arm and a parent-held to-one omit nothing, because the engine has no fold there to contradict (the create side does over-omit in both, which predates this package and is recorded in §12's ledger notes, not fixed here).

**(HISTORY — superseded by the deletion note above.) Why the site was RETAINED rather than deleted at Package N**, per the plan's Package N1 rule that a guard goes only when its falsifier can no longer construct the invalid program: the two scanners that answer "which column does this relation own" read `.fields()` differently. `getInverseRelationMap` (validation) tests it for TRUTHINESS, so a relation spelled `.fields()` with ZERO arguments answers `[]` and the omission removes nothing; `bindRelation` (engine) tests `fields && fields.length > 0`, so the same relation is child-held and `findInverseRelationState` resolves the target's real back-reference. Every other route was enumerated and MEASURED closed: depth ≥ 2, `UpdateManyRecordSeries` members (which are handed the raw constructor args), `CreateManyRecordSeries` rows, the composed supplier+modify locator, the X1c whole-target delegation, and the inverse-upsert seam. **Census unchanged at 21.**

**The parse closes the fourth position only where the two scanners AGREE, so the Package N gate gave that position the same owner as the other three.** On the divergent schema the omission removes nothing, and `buildToManyUpdateManyParts` called no guard at all: measured through the public client at the implementer's HEAD, `posts: { updateMany: { where, data: { userId: "thief" } } }` returned SUCCESS and left the row under `thief` — position 4 was still silently reparenting, one schema over. The gate added `assertOwnedFkAbsentFromUpdateData` to that builder. It is the SAME guard, not a second owner: one invariant, one function, one message, now called from every position that can violate it (`RelationWritePart.ts` :1268, :1310, :1339, :1365 at the Package N commit; :1274, :1316, :1345, :1371 after Package O) instead of three of four. No new construction site — **census still 21 at Package N; the whole site moved to `:1250` under Package O and is still one site** — and junction and polymorphic child-held relations never reach any of the four (`RecordUpdateCompiler.interpretRelation` returns for both first), so the guard cannot see the `manyToMany` arm the omission also declines to touch.

Three of the four call positions are reachable through the public client and are pinned in `nested-update-owned-fk.test.ts` (to-one `update`, to-one `upsert`, and now the to-many `updateMany`); deleting any of the three conditions turns a test red, each with the reparented row as the failure. The fourth, `buildToManyUpdateParts`, has no measured live route: on the very same divergent to-many schema the TARGETED arm dies earlier, in the engine's own scanner (`Cannot determine FK fields for relation 'ghost'`), because a targeted to-many update binds the target's relations and the zero-argument side cannot be bound. That asymmetry is why position 4 was the one left standing — the bulk arm binds nothing, so it is the arm that arrives. Both halves are pinned side by side in that file, the second as an expectation on the scanner's message rather than on a guard that does not run.

**§3.1 note, needing ratification like Package D's:** two previously-ACCEPTED payload classes now refuse. The nested `updateMany` spelling above (whose accepted outcome was the silent reparent), and `{ userId: undefined }` in nested update data — `strict` object parsing keys on a key's PRESENCE, and nested CREATE data has answered `Unknown key` for the identical spelling since it was written, so the two contexts now agree. Both measured; both in `nested-update-owned-fk.test.ts`.

**5.2 — spelled with a DISAGREEING value at the adopt seam** · `RelationUpsertPart.ts:743` (`withoutAgreeingOwnedFk`; the throw is `:754`)

The root must be a **create**. An UPDATE root cannot reach this seam any more: Package N1 built the to-many `upsert` arm of a nested UPDATE from `getUpdateSchema`, so `client.author.update({ … posts: { upsert: { update: { authorId } } } })` answers `ValidationError: … Unknown key: authorId` at the parse and never arrives (`adopt-owned-fk-agreement-behavior.ts`, "WALL: an UPDATE root cannot spell the owned FK in the upsert arm either"). The create context is the one position N1 deliberately left un-omitted, precisely so this absorbed capability keeps a value to agree with.

```ts
client.author.create({
  data: {
    id: 1,
    posts: {
      upsert: {
        where: { id: 10 },
        create: { title: "x" },
        update: { title: "y", authorId: 99 },   // ✗ the fold assigns 1
      },
    },
  },
});

// ✓ works since E5-U2 — the same value said twice is redundancy, not contradiction:
//   update: { title: "y", authorId: 1 }
```

The agree case is absorbed only where the parent value is a construction-time **literal**; a `ref` source has nothing to compare against, and deferring the comparison to compile would move a typed refusal behind writes that already ran. The `planned` source no longer arrives here at all, for the reason above — the type gate pins the surviving arm as `_createRootUpsertUpdateKeepsTheOwnedFk` (`tests/types/client/contextual-typing-gate.core.types.ts`), and the `planned` branch is now exercised only through the divergent schema whose parse omits nothing.

---

## 6. Depth on an upsert's update arm (1)

**6.1 — a parent-held to-one write one level deeper** · `RelationUpsertPart.ts:1204` (`assertArmEdgeIsChildHeld`; the throw is `:1211`)

*Package B (commit `4ef2fa57`) attempted this deletion and RESTORED the guard on a
measured defect: when the deeper parent-held write names the relation the upsert
ARRIVED THROUGH, the arm's own reparent silently overrides it (`connect` no-ops,
`create` commits an unreferenced row, `delete` removes the enclosing root row).
The guard's docblock now carries that measurement in place of the original
architecture argument, which the same package disproved for relations the arm
did NOT arrive through.*

```ts
client.org.update({
  where: { id: 1 },
  data: {
    posts: {
      upsert: {
        where: { id: 10 },
        create: { title: "x" },
        update: { title: "y", category: { create: { name: "z" } } },  // ✗ post holds categoryId
      },
    },
  },
});
```

The original argument was an architecture one — "a delegated sub-operation would emit a
SECOND UPDATE of the same row and fork the premise this Part pins" — and that argument
is now WRONG: the arm's found arm IS the selected-record compiler, and
`interpretParentHeldToOne` folds the target's key into the ONE root UPDATE that compiler
already emits. Package B3 (2026-08-10) attempted the deletion on exactly that ground and
was FALSIFIED at the package gate, so the shape stands for a different, measured reason.

This seam also hands that compiler an `incomingMembership` — the reparent onto the
enclosing row — and `compileLocatedRecord` applies it AFTER the fold, over the same
column. For a parent-held relation the arm did NOT arrive through (`category` above) the
fold lands correctly; for the relation the arm ARRIVED THROUGH the enclosing membership
silently wins. Measured with `org.update` → `teams.upsert[].update.org`: `connect`
resolved with the target probe run and the membership unchanged, `create` committed an
unreferenced row, `disconnect` was ignored, the same payload resolved to opposite
memberships on the two arms, and `delete` removed the enclosing operation's own root row
and failed the terminal read with a bare `TransactionError`. The nested targeted-update
seam passes no `incomingMembership` and lands the same `connect` correctly, so this is
not parity — it is unique to this seam.

Because one guard owns one invariant, the refusal covers BOTH directions rather than
being narrowed to the colliding one. Lifting it needs the fold and the incoming reparent
reconciled in a single owner, with a per-column refusal when they disagree; that is
carried as a Package D case.

*(The other three arm-depth refusals — the asserting probe, the arm moving its own PK,
and the compound/non-PK deeper edge — are all DELIVERED and gone; see "What has been
DELIVERED since".)*


---

## 7. Primary-key transition interactions (1) — **DELIVERED BY PACKAGE D (2026-08-10)**

**7.1 — an adopt kind while the root transitions an unpinned referenced column** · was `RecordUpdateCompiler`'s `pastSurface` regime — **DELIVERED: no such refusal exists. NO `UnsupportedOperationError` stands here.**

```ts
client.org.update({
  where: { name: "Acme" },              // located by a NON-PK unique → the pre-value is unpinned
  data: {
    code: "new-code",                   // transitions the referenced column
    members: { connect: [{ id: 5 }] },  // ✗ an adopt kind, not a create
  },
});
```

The adopt kinds need the occupied guard's PRE-transition value **and** the POST value. `parentFkLocateFields` publishes the pre-value and E6.7 derives the post one, so the remaining wall was the guard's own construction-time shape — narrow, and flagged as worth its own measurement before any lift.

**That measurement was Package D, and it lifted the shape.** `interpretReferencedKeyTransition` returns `none | guarded` only; the `pastSurface` third answer is gone (the deletion is recorded at `RecordUpdateCompiler.ts:2522`), and compound, non-primary-key and unpinned references all compile, with old values read from the located row and adopt writes derived through the transitioned sources. `D3` then lowers the COMPLETE correlated binding through the occupied guard on both substrates.

**This entry was a live falsehood in this document from 2026-08-10 to 2026-08-11**, and the file contradicted itself two sections apart: the "What is NOT here" Package D paragraph already said the `pastSurface` refusal was deleted while §7 went on presenting it as one of the standing shapes with a coordinate that had become a comment. Recorded rather than quietly corrected, because it is the exact failure mode this file's re-anchoring convention exists to prevent — a stale coordinate that still resolves to *something*.

**What Package D left behind is a NEW refusal, not this one**, and it lives at the occupied guard rather than here: for nested `create` / `createMany` under a compound / non-primary-key / unpinned reference with an OCCUPIED old slot, a payload that used to compile now raises the typed `NestedWriteError` occupied message. That is a `NestedWriteError`, so it is not a census site; it is a ratified §3.1 deviation and its full argument is in the "What is NOT here" Package D paragraph.

---

## 8. Relation writes in the wrong data clause (1)

**8.1 — relation writes inside child-held `updateMany` data** · `RelationWritePart.ts:691` (inside `parseScalarUpdateData`, declared `:676`) · **PACKAGE O (2026-08-11): the shape is unchanged; its POSITION moved.** The site is DELETED and the shape is refused by the same single owner as §4.3, `relation-key-legality.ts:173`, which chooses its noun from `invalid.isJunction`; `upsert-untaken-arm-legality.test.ts:163` and `inverse-to-one-update-depth.test.ts:643` still pin the ordinary wording. `nested-target-parts.buildJunctionTargetRelationParts` — the one producer that had no owner call — now makes one at its seam.

```ts
client.author.update({
  where: { id: 1 },
  data: {
    posts: {
      updateMany: {
        where: { draft: true },
        data: { title: "x", tags: { connect: [{ id: 2 }] } },   // ✗
      },
    },
  },
});
```

The `:2314` wall verbatim, one relation kind over. *(This site used to be SHARED: its other half refused the inverse-to-one UPSERT arm, wording itself `upsert` when `config.kind === "inverseUpsert"`. Package G delivered that half — see "What has been DELIVERED since" — so the site now serves `updateMany` alone and the branching ternary is gone. The `updateMany` half is not future work of the same kind: a set-based UPDATE has no per-row captured identity for a descendant write to correlate to, so lifting it means capturing roots, which is the limitation-lift plan's Package K/L2.)*

*(DELIVERED by Package K, 2026-08-10 — kept below because it is the complete pre-fix diagnosis and the shape it describes is now REFUSED rather than dropped. The fix is one shared predicate, `relation-key-legality.relationWriteKeys`, reading BOTH parsed maps; the three readers named at the end of this note now call it instead of each asking `.relations` alone, and `assertUpdateManyRelationsAreCompilable` takes the key list because its own meta used to compute `Object.keys(relations)` — empty for exactly this case, so even reaching it would not have thrown. No new message, no new census site.)*

*(One thing the surviving half did NOT answer, measured at the gate rather than reasoned about, and named here so Package K/N did not have to rediscover it: `parseScalarUpdateData` read only `scalarData` and `relations`, so the third parsed member — a direct polymorphic mutation whose resolved intent carries no relation program, i.e. a `disconnect` — passes the wall untouched and is then dropped. `author.update > posts.updateMany.data: { subject: { disconnect: true } }` compiles to the terminal select ALONE and succeeds having cleared nothing; with a scalar beside it, `UPDATE … SET "body" = $1 WHERE "authorId" = $2` runs and the private pair is silently left in place. That is a silent wrong answer rather than a refusal, which is why it has never appeared in this document — and it is exactly the defect Package G fixed on the upsert half by forwarding `polymorphic`. It has nothing to do with capture roots and is refusable today; `updateManyCarriesRelations` and `findRelationBearingUpdateManyData` share the blind spot, both reading `.relations` alone.)*

---

## 9. Read-back identity (1)

**9.1 — an upsert create arm that names no row to read back** · `UpsertOperation.ts:1103` (`createArmIdentity`; the throw is `:1147`)

The create arm's data carries neither a complete primary key, nor any complete unique constraint of the model, and its absent PK members are not a single database-generated identity the INSERT can capture.

```ts
// E6.2 ABSORBED the common case — a compound PK with ONE increment member:
const cell = s.model({ a: s.int().increment(), b: s.string(), label: s.string() }).id(["a", "b"]);
client.cell.upsert({
  where: { a_b: { a: 1, b: "x" } },
  create: { b: "x", label: "L" },       // ✓ works: captured `a` ⊎ spelled `b`
  update: { label: "M" },
});
```

What remains refused is the residue: **two** database-assigned members, which is not expressible on MySQL or SQLite anyway (one auto-increment per table). The PostgreSQL two-serial corner is **unmeasured** — recorded as a probe, not a claim.

---

## 10. Compound edge into a junction (1)

**10.1** · `CreateOperation.ts:2162` (`edgeParentId`; the throw is `:2168`; N3 anchored the pair at `:2133`/`:2139`) — **PACKAGE O CONVERTED THIS SITE TO A `QueryEngineError` (2026-08-11). The shape is still refused, in the engine, before any I/O — but by the owner that actually answers it.**

```ts
const org = s.model({ region: s.string(), code: s.string(), tags: s.manyToMany(() => tag) })
  .id(["region", "code"]);                             // compound primary key

client.org.create({
  data: { region: "eu", code: "1", tags: { connect: [{ id: 2 }] } },   // ✗
});
```

A junction row keys its parent half with ONE column by construction (`getManyToManyJoinInfo` → `getRequiredSinglePrimaryKeyField`). This refusal reaches that fact one statement earlier than the schema layer does; N3-U3 re-proved it.

**THE FACT HAS TWO OWNERS AND NEITHER IS THIS SITE** (Package N2, measured 2026-08-11). `edgeParentId` is the only position the census sees, and its own docblock says it "is not the child-edge arity boundary any more" — Package E4-U2 gave the child-held adopt kinds a per-column source and they no longer arrive here. What answers compound M2M for every other shape is `getRequiredSinglePrimaryKeyField` (`src/query-engine/builders/correlation-utils.ts:149`, throwing at `:154`), a **`QueryEngineError`, so not a census site**, reached through `getManyToManyJoinInfo` by every junction read and write; and its migration twin `getPrimaryKeyFieldDef` (`src/migrations/serializer.ts:661`, a raw `Error`). The two sentences are near-identical but NOT byte-identical: "uses **a** compound primary key" against "uses compound primary key". A reader following §7.4's old coordinate landed on an unrelated comment; a reader following this one lands on a refusal that is real but no longer the boundary. Both are stated here so the next reader lands on all three.

**NOTHING HAS SEALED IT** (Package N2's verification, negative in both places it looked). `src/validation/**` mentions `manyToMany` only for to-many dispatch, `disconnect` availability and `select` arity, and reads `compoundId` only for compound-unique filters — there is no compound/PK rule for a junction anywhere in it. `src/schema/validation/**` (definition time) pairs m2m sides ONLY to derive junction table and column names and to detect `through` / `A` / `B` conflicts; the one rule that reads `compoundId` beside a relation is the polymorphic one. Repo-wide, the sentence occurs exactly twice, at the two owners above. The junction carve-outs are intact and self-documenting (`RelationJunctionPart.ts:337` and `:1768` both name `JunctionSide` by name), `ManyToManyJoinInfo` still carries the singular `sourcePkField` / `targetPkField` / `sourcePkColumn` / `targetPkColumn` channels the future contract deletes, and `JunctionRelation` (`builders/relation-data-builder.ts`) carries none of the two-sides topology — exactly as §6 N2 requires, since that is a future contract and not a type to add now. The refusal was re-measured live and still says its sentence.

**Reclassified 2026-08-09: this is an unimplemented FUTURE CAPABILITY, not a semantic seal.** Compound many-to-many join sides are a topology the schema layer does not describe yet; the shape is coherent and the refusal is only where today's engine meets that gap. The limitation-lift plan keeps the focused refusal here (§7.4, Package N2) and names the work it waits on: compound join-side schema metadata, migration and introspection support, join SQL with ordered multi-column halves, and engine membership and identity projection. Do not restate it as a validation rule to move the error earlier, and do not read it as permanent.

---

## 11. Bulk roots that carry relation writes (2)

Packages J and K gave root `createMany` and root `updateMany` the ordinary nested-write surface, each as a `RecordSeriesOperation`. Each added exactly one refusal, and neither is a shape either of the sections above could hold.

**11.1 — `skipDuplicates` beside nested relation writes, at a `createMany` root** · `CreateManyRecordSeries.ts:126` (the constructor)

```ts
client.org.createMany({
  data: [{ name: "Acme", members: { create: [{ name: "x" }] } }],
  skipDuplicates: true,                                            // ✗
});
```

Not an identity problem and not a substrate one — the only refusal in this document that is neither. A skipped row has no defined meaning for its nested effects: they could be SUPPRESSED, or APPLIED to the row that already exists, and both are defensible public contracts. The limitation-lift plan (§5.1, §7.3) says not to guess, so the site is an `UnsupportedOperationError` rather than the `TransactionError` the substrate refusals carry — no driver capability would change the answer. Drop the flag, or write the relations in a second call. Scalar `createMany` keeps `skipDuplicates` on its old owner, byte-identically.

**11.2 — a single-target membership move across more than one `updateMany` root** · `UpdateManyRecordSeries.ts:337` (`assertMembershipAppliesToEveryRoot`; the throw is `:348`)

```ts
client.org.updateMany({
  where: { region: "eu" },                       // matches 3 rows
  data: { members: { connect: [{ id: 5 }] } },   // ✗ member 5 can belong to one org
});
```

A child-held `connect` / `connectOrCreate` / `set` names ONE existing target row, and that row holds one foreign key. Applying it to every matched root means the last root updated takes the target from the others — so "apply this to every row" and "this target belongs to one row" are the contradiction, and the message names the observed N. The refusal fires before any member is constructed, over the RAW `program.entries`, which is what catches Package H's composed suppliers (composition preserves `entry.kind`). It does NOT cover `create` (each root gets its own), the junction kinds (a junction admits many parents), the parent-held kinds, or an EMPTY `set: []` / `connect: []` / `connectOrCreate: []`, which names no target at all — that last narrowing was a gate fix, measured: `set: []` at N = 1 clears that row's children, so at N rows it clears each row's own.

**DEPTH, measured and deliberately NOT refused, pending a plan ruling:** the same arithmetic one level down runs unrefused. `owner.updateMany({ where: <2 roots>, data: { posts: { create: { title, comments: { connect: [{ id: 7 }] } } } } })` answers `{ count: 2 }` and leaves comment 7 under the LAST root's post. Refusing it would make the bulk spelling reject what N ordinary `update` calls execute — the kind-gated incoherence Package D2 removed. Pinned as behavior in `update-many-relation-series.test.ts`; widening it is a plan amendment (§5.2), not a package's.

---

## What is NOT here

The refusals the final re-audit re-filed as expressible work — they still throw today, but each has a named post-E mechanism and should not be treated as a boundary:

| Site | Shape |
|---|---|
| ~~`RecordUpdateCompiler.ts`, `RelationUpsertPart.ts`, `nested-target-parts.ts` (five positions)~~ | any nested write whose CHILD model has a compound primary key — **DELIVERED BY PACKAGE C (2026-08-10), row closed 2026-08-11.** `rg childPrimaryKey src` returns nothing, all five `UnsupportedOperationError` sites are deleted, the two direct-polymorphic `QueryEngineError` twins were migrated, and no refusal message about a compound child primary key exists anywhere in `src` — verified against all 26 sites remaining at the Package N commit (19 after Package O; the grep still returns nothing). `TargetProjection` replaced the singular row key it guarded; the falsifier is `parity-c-selected-identity.test.ts` (row key `[id]` vs reference key `[tenantId, code]` vs stored `[tenantId, targetCode]`). This row spent two packages marked "coordinates stale, Package O owns it"; what it needed was one grep. |

Changes since this list was written, each verified against the tree:

- (2026-08-09) The list had **six** rows. One of them — a deeper write on the update arm "whose planning read asserts that its own target exists" — is **DELIVERED and removed**: the selected-record compiler makes a conditional arm's descendant outputs optional until the found arm is selected (`conditionalArmPlanning`, `write-engine/Part.ts:63`; `StatementOutputSource.optional`, `write-engine/OperationFragment.ts:37`; resolution at `write-engine/OperationExecutor.ts:992`). That message no longer occurs anywhere in `src`.
- (2026-08-09) The compound-child-PK row grew from four positions to five with the bound-polymorphic inverse write parity, and the last row moved OUT of the write engine into `src/query-engine/relation-key-legality.ts`, so the write-engine census no longer counts it.
- (2026-08-10, Package B) **Two more rows are DELIVERED and removed**, both by the same change — the upsert arm's found arm delegates to `RecordUpdateCompiler`:
  - `assertArmPkStable`, "an upsert arm that moves its own PK while carrying deeper writes". The compiler owns primary-key transitions: it derives the post-transition value, defers the writes that reference it until after the root UPDATE, and refuses an OCCUPIED old slot with V1's referential-action message — which is the half of the invariant that was real. RESIDUE, measured and deliberately unguarded: a junction pair that opts out of the implicit `ON UPDATE CASCADE` has no engine owner for the transition at the arm OR at the update root; both fail closed at the constraint with identical statements and no partial effect, so the constraint owns it and a refusal at the arm alone would be an asymmetric duplicate (`nested-arm-dispatch.test.ts`, "B1 RESIDUE").
  - `assertArmEdgeReferencesLocatedPk`, "a compound / non-PK referenced edge deeper on the update arm". Its recorded reason named the mechanism it waited for — widen the arm probe's projection and give the leaf a per-column source — and the delegation is that mechanism: every consumed referenced field joins `locateFields`, the probe publishes the target projection, and each foreign-key member resolves by NAME (`upsert-arm-referenced-edge.test.ts`).
  The three remaining rows then held seven positions, six of them inside the write engine. A THIRD deletion was attempted in the same package — `assertArmEdgeIsChildHeld`, §6.1 above — and was falsified at the package gate; it is neither delivered nor listed here.
- (2026-08-10, Package D) **One more row is DELIVERED and removed**: `assertPinnedTransitionIsCompilable` (`relation-key-legality.ts`), "a target PK transition plus a non-cascading deeper edge, located by another unique". Its recorded obstacle was that the pre-transition value had to be a compile-time LITERAL; the value it actually needed was the PRE-TRANSITION one, which the probe that located the target already publishes. `RecordUpdateCompiler.interpretReferencedKeyTransition` now reads every reference-key member's old value from the located row and derives every member's new value at compile (`postTransitionReference`), so the whole function is deleted with its five eager arm-side call sites. The same change deleted the update root's `pastSurface` refusal — the compound, non-primary-key, and unpinned reference shapes it covered now compile through the same two sources. Witnessed in `parity-d-transition` (structural, both substrates, three falsifications), `pk-transition-junction-mixed-edge`, `nested-update-pk-transition-cascade`, `inverse-to-one-update-depth`, and `nested-arm-dispatch`.
  RESIDUE, deliberate and narrow: a same-value write of a referenced column is treated as a real transition wherever the pre-value is not a construction literal — which needs BOTH a single-member reference and a locator that pins it, a compound reference having no construction-time post-value even when the locator pins every member. So an occupied old slot then refuses with the occupied message where a pinning single-member locator would accept. The no-op question needs the pre-value, and the two things the regime decides — `afterRootParts` ordering and the to-one upsert's create-arm reroute — are construction-time structure. For every nested kind but `create` / `createMany` this NARROWS a refusal that used to cover the whole shape.
  NOT a lift, and the ledger says so rather than letting the sentence above imply it: for nested `create` / `createMany` the occupied guard is a NEW REFUSAL on payloads that previously executed. `pastSurface` returned before the guard could be emitted and its caller let those two kinds through untouched, so a compound / non-primary-key / unpinned reference carrying create-only relations used to compile with no probe and no guard however occupied the old slot was — while the PINNED single-member twin of the same payload was refused with the occupied message throughout. The guard is kind-blind and relation-level, so unifying the two spellings costs that accept. This is a §3.1 change of "guards and postconditions", "statement count and round trips", and "error class, message" on an accepted payload, and it needs the coordinator's ratification rather than a package's. Measured on every driver leg (`compiled-key-transition-behavior.ts`, "an OCCUPIED old slot refuses the same nested create the empty slot accepts").
  BOUNDED at the gate: an old reference tuple with a NULL member addresses no row under MATCH SIMPLE, so the guard does not fire for it. That is decided once for both substrates, because the guard's two carriers lower a null pre-value differently — the planning probe binds it as a parameter (`= $n`, never true of NULL), the atomic batch's premise resolves it to a literal (`IS NULL`, true of NULL) — and the same payload was resolving on a transaction while throwing the occupied error on a batch (`RelationKeyGuard.oldReferenceIsAddressable`; pinned on both substrates in the same behavior file).
- (2026-08-10, Package F) **§4.2 leaves this document**, and the "honest note" count below drops with it: the junction create arm that "cannot name its own row" has no reachable payload, measured rather than argued (see §4.2's entry). Package F's own work is not a deletion but a NARROWING of §2.1, §2.2, §2.3 and §3.1 to the value states the maintainer's ruling actually named. Each of those four used to refuse two different facts under one sentence — "no row holds this value" and "the row that will hold it has not been inserted yet" — and only the first is a boundary. A referenced column the database produces (an absent `.increment()`, which is the whole of that population in this schema language) is now published by the INSERT that produces it: through its own `RETURNING` list on a returning provider in a transaction, and through ONE focused post-insert SELECT by the created-row selector on a non-returning one, in the same transaction. Demand is registered only by `rootReferenced(field)`, so a create that asks for nothing extra is byte-identical; the generated primary key keeps its historical output channel for the same reason. What still refuses at all four sites is the omitted `.nullable()` column — `.nullable()` sets `hasDefault: true, default: null`, so it arrives as an explicit `null`. ONE refusal was ADDED and is deliberately not a shape in this document: on an atomic-batch substrate no statement's rows are addressable and the reference scratch carries the generated identity alone, so the produced column cannot be published there and says so in its own sentence (`CreateOperation.ts:2788`, inside `producedReference`, declared `:2777`). Witnessed in `fresh-produced-field-behavior.ts` (live, both provider families) and `fresh-produced-field.test.ts` (three substrate spellings, the channel-collision pin, the K2 survivors); the before-picture is `parity-f-fresh-field.test.ts`, which also gained the junction produced-identity consumer Package A had left unpinned.

- (2026-08-10, Package G) **The last row of this section is DELIVERED and removed**: the inverse-to-one upsert-arm HALF of §8.1's site. Its recorded obstacle was that the arm had no captured target to hand a nested write; the arm's own correlated probe had been publishing exactly that since Package C, and Package D removed the last reason an UNPINNED target could not carry one. `RelationWritePart`'s `inverseUpsert` branch now parses the arm ONCE through `buildParsedRelationPrograms` and hands all three members — `scalarData`, `relations`, and the `polymorphic` map it used to drop on the floor — to `RecordCompilerSeam.updateSelected`, with no `incomingMembership` (the probe found the row BY the membership, so the arm never reparents) and no `pinnedTarget` (a correlated inverse to-one has no unique `where`, so nothing is construction-known). The relation owner keeps the correlated probe, the found/missing decision, the batch premise guard and the transaction affected-rows failure; what moved is the found arm's body and the timing of its legality, which is now a deferred closure invoked after the arm is selected — ATOM §13's wording, which this seam was the last one not to obey.
  DELIVERED TOO, in the same parse: a direct polymorphic `disconnect` resolves to an intent with no relation program, so it lived only in the dropped third member. Measured at `a8349793`, `owner.update > card.upsert.update: { subject: { disconnect: true } }` compiled the found arm to ZERO steps and the call succeeded having cleared nothing, while the sibling nested `update` kind emitted the UPDATE. That was a silent wrong answer, not a refusal, so it was never in this document; it is recorded here because the same line caused both.
  §3.1 CHANGE, small and named: PK-portability and relation-key legality used to run at CONSTRUCTION for this seam, so a `profile.upsert.update` that fails them threw with an empty statement log whether or not the found arm was taken. They now run after the planning probe and only on the found arm; on a MISSING probe they do not run at all. Same class as Package D's two retargets. Witnessed on both substrates in `inverse-to-one-update-depth` (found-arm depth and grandchild depth, missing-arm inertness, deferred legality, empty found arm), `record-compiler-contract` (convergence with the nested `update` kind, compound captured row key with a decoy, the polymorphic forward), and `polymorphic-write-family` (the singular polymorphic inverse, which rides the same Parts). Three falsifications: dropping `conditionalArmPlanning` breaks the missing arm on both substrates, dropping the deferred call breaks the legality split, dropping `polymorphic` restores the silent discard.
  NOT DELIVERED, stated so the §8.1 entry is not read as half-dead: the `updateMany` half stays, and so does the guarded-transition reroute (`RecordUpdateCompiler.rerouteTransitionedUpsertCreateArm`), which drops an inverse upsert's update payload WHOLESALE when the root transitions a referenced key — no wall fires there today and none fires after G, because the update arm is claimed unreachable under that regime. Package G left it untouched and records it here rather than silently inheriting it.
- (2026-08-10, Package E) **The last row of the table above is DELIVERED and removed**: the shared-primary-key `create` / `connectOrCreate` / `upsert` at an update root. The refusal was of the SHAPE; what it was waiting for was the transition machinery, and Packages C, D and F built all three halves of it. A shared primary key at a selected record is a PRIMARY-KEY TRANSITION OF THAT RECORD, so the arm's final value — the literal it spells, or the `Ref` the target's own INSERT publishes — folds into the one root UPDATE's SET (no shared-PK Part, no second statement at the record), feeds the SAME occupied-guard/ordering machinery a scalar key move feeds (`sharedKeyMembers`, consulted by `interpretReferencedKeyTransition`, `resolveCreateParent` and the after-children reorder), and reaches the terminal read (`updatedPrimaryKeyWhere`), which now addresses the key the record ENDS on. Witnessed byte-for-byte on both substrates in `parity-e-shared-pk` — including a child-held sibling on the shared key, whose plan is indistinguishable from the scalar twin's, and a produced key spending one reference in both the SET and the terminal — with three falsifications, one per rule.
  WHAT STILL REFUSES, in ONE narrowed sentence at the same site (`recordSharedKeyFold`; census 22 → 22): an arm that names NO ONE VALUE for the row-key member. THREE coverages, one per disjunct, each with its own witness and none sharing one — the arm answers with no value at all (a `where` that does not spell the referenced column, so the foreign key resolves through a correlated lookup SUBQUERY and no literal keys the record; or two arms naming different rows); the arm answers NULL (a nullable referenced unique named NULL — nothing upstream refuses it, so without this a NULL would be assigned to a row-key column); or a root SET spells the same member the arm folds, disagreeing. A fourth disjunct, `isSql`, was DELETED at the Package E gate: re-measurement found it had no producer on any of the four resolvers, and the write-up that claimed a witness for it had mis-read which branch fired. A shared-key `connect` used to be refused instead at COMPILE by `getUpdatedPrimaryKeyValue`'s `Sql` branch, after the planning locate had been issued; the literal spelling now executes and the subquery spelling refuses before any statement.
  NOT LIFTED, and not this package's to lift: `disconnect` and `delete` on a shared key. A row-key member is never nullable, so `assertRelationCanDisconnect` (`relation-nullability.ts`) refuses on an OPTIONAL shared edge and the parse boundary refuses first on a required one. Both pinned; neither is a write-engine census site.
  RESIDUE, inherited deliberately from Package D, and stated at the Package E gate as its CONSEQUENCE rather than its mechanism, because the mechanism alone reads as harmless: the fold's transition detection is topological (arm kind plus the row-key overlap) and therefore OVER-INCLUSIVE — an arm that folds the value the record already holds still takes the occupied guard, which means a shared-key `connect` naming the key the record ALREADY HOLDS is REFUSED whenever a child-held old slot is occupied, while the scalar spelling of the identical final state is ACCEPTED. The scalar half reaches `sameScalarValue`; this half cannot, because it must answer before any arm has run. Closing it means deriving each arm's value a second time in the pre-pass — a second enumeration of "what does this arm fold", and a fold the two enumerations disagree about is the silent orphan. Refusing a satisfiable payload is the recoverable direction. Measured on both substrates and pinned in `shared-pk-update-root-behavior.ts`, so it is a decision rather than a drift; at `33368eb6` both relation spellings refused unconditionally, so this is a narrowing and never a regression.
  SCOPE, a §3.1 deviation from the plan's "at an update root", MEASURED AND KEPT: the refusal this replaced was scope-blind, and so is the fold — a NESTED selected record (the target of a parent-held `update`) moves its own row key too. What decides the outcome there is the ENCLOSING record's foreign key, which is the database's to decide, and the lift is coherent rather than an oversight because the relation spelling and the SCALAR spelling of the same nested move now AGREE on both edges: under ON UPDATE RESTRICT both raise the database's foreign-key error with the state untouched, and under ON UPDATE CASCADE both succeed with the enclosing row's key following. Gating the fold to the operation's own root would have made the relation spelling refuse where the scalar spelling at the same position succeeds — the kind-gated incoherence D2 removed. Both edges are pinned on both substrates, and the pin was falsified against the rejected root-only gate (exactly the nested rows turn red). For O's ledger this is a refusal-to-refusal retarget on the RESTRICT edge (typed construction refusal, zero statements → `ForeignKeyError` at execution, nothing written) and a lift on the CASCADE edge.
  H7 SETTLED, since this document is where Package G left it: the guarded-transition reroute above is CORRECT, not a silent drop. It and the occupied guard come from one regime decision over one population, and `compileRelationKeyGuards` runs first — so an occupied slot has already refused the whole operation, and what the arm can still see is an empty slot where `create` is the only branch with a row to write. Measured on both substrates in `relation-key-update-legality.test.ts`:519 (occupied → refused, nothing written), :630/:664 (empty → created, with the ignored `update` payload spelled `label: "Untaken"` beside the asserted `label: "Created"`), :698 (the batch plant race → refused). The reasoning is now recorded at the code site.

---

## 12. The classification (Package N3)

Every remaining refusal, in exactly one bucket. The five buckets are the limitation-lift plan's §6 N3 list, and "exactly one" is the point: a site whose reason splits across two buckets is a site expressing two invariants, which is a Package O finding rather than a classification.

- **SC — semantic contradiction.** The payload asks for two incompatible things. No mechanism lifts it; a lift would have to pick a winner, and picking silently is what this project refuses.
- **MSI — missing stable identity.** There is no value, at the moment the decision must be made, that names the row the operation would have to address.
- **PSI — provider/substrate impossibility.** The deployment cannot express it. Another provider, or another transaction mode, answers the same payload.
- **DPC — deliberately deferred product contract.** Implementable today; refused because the public meaning has not been chosen, and guessing it would ship a semantics nobody agreed to.
- **UFF — unimplemented future feature.** Coherent, wanted, and waiting on named work. Every UFF row below states its expiry.

### The write-engine sites — 21 at Package N3, **15** after Package O

Coordinates are N3's, which is where this document's re-anchoring convention put
them; the **HEAD** column is where each site stands after Package O and is what
`operation-construction-inventory.test.ts` re-resolves. A row marked RETIRED has
no HEAD coordinate — Package O folded it into another owner or changed its class —
and is kept because a coordinate that vanishes teaches nothing.

| # | Site | Owner | Bucket | HEAD | Basis |
|---|---|---|---|---|---|
| 1 | `UpdateManyRecordSeries.ts:348` | `assertMembershipAppliesToEveryRoot` (`:337`) | **SC** | `:348` / `:337` | K. A single-target membership move applied to N matched roots would leave the target under the last one; "apply to every row" and "one target row" contradict. N-dependent, so no schema can own it. |
| 2 | `RecordUpdateCompiler.ts:1800` | `postTransitionReference` (`:1772`) | **MSI** | `:1800` / `:1772` | §2.5. `Sql` operands are parse-unreachable, so the reachable operand is `null`, which names no row. |
| 3 | `RecordUpdateCompiler.ts:2017` | `resolveCreateParent` (`:1911`) | **MSI** | `:2017` / `:1911` | §2.5, the nested-create leaf. Same invariant as 2. |
| 4 | `RecordUpdateCompiler.ts:3533` | `recordSharedKeyFold` (`:3513`) | **MSI**, with one SC disjunct — see below | `:3533` / `:3513` | E. Three disjuncts under one sentence: no value, and NULL, are MSI; "a root SET spells the same member the arm folds, disagreeing" is SC. **Flagged for Package O**: one site, two invariants. |
| 5 | `RecordUpdateCompiler.ts:3612` | `beforeTargetReferencedValue` (`:3604`) | **MSI** | `:3612` / `:3604` | §2.3, narrowed by F to the null/absent population. |
| 6 | `RecordUpdateCompiler.ts:4767` | `composeToOneEntries` (`:4728`) | **UFF** | `:4767` / `:4728` | H. **Expiry: the produced-identity selector channel for `RecordUpdateCompiler`** — a final reference into an earlier INSERT's outputs, consumed by `writeWhere`, the captured-key guards and the terminal read. The site names the obstacle itself. |
| 7 | `CreateManyRecordSeries.ts:126` | the constructor | **DPC** | `:126` | J, §7.3. `skipDuplicates` plus nested effects has two defensible meanings (suppress the effects, or apply them to the row that already exists) and the plan says not to guess. The site's own docblock says product gap, not substrate. |
| 8 | `RelationJunctionPart.ts:1374` | `resolveCreatePk` (`:1362`) | **MSI** | `:1374` / `:1362` | §4.1, §7.3's identity half. A skipped row produces no identity for its join row. |
| 9 | `RelationJunctionPart.ts:2354` | `scalarOnly` (`:2343`) | **MSI** | **RETIRED → 22** | §4.3. A set-based UPDATE learns no per-row identity. **NO EXPIRY MAY BE STATED** — see the Package L note below. |
| 10 | `RelationWritePart.ts:691` | `parseScalarUpdateData` (`:676`) | **MSI** | **RETIRED → 22** | §8.1. Same invariant as 9, 22 and 23: four sentences, one invariant. |
| 11 | `RelationWritePart.ts:1244` | `assertOwnedFkAbsentFromUpdateData` (`:1234`) | **SC** | `:1250` / `:1240` | §5.1, §7.1 of the plan: two different values claimed for one FK member. |
| 12 | `RelationUpsertPart.ts:754` | `withoutAgreeingOwnedFk` (`:743`) | **SC** | `:754` / `:743` | §5.2. Same invariant as 11, from the same string. An AGREEING literal is absorbed, so only the contradiction refuses. |
| 13 | `RelationUpsertPart.ts:1211` | `assertArmEdgeIsChildHeld` (`:1204`) | **SC** | `:1211` / `:1204` | §6.1. Two writers of one column, one of them the arm's own reparent. Package B attempted the deletion and was FALSIFIED at the gate — the strongest evidence of unique coverage in this table. |
| 14 | `CreateOperation.ts:991` | `interpretPolymorphicRelation` (`:961`) | **MSI** | **RETIRED → 15** | §2.2's bound-polymorphic twin. |
| 15 | `CreateOperation.ts:1789` | `targetReferencedValue` (`:1781`) | **MSI** | `:2772` / `:2764` (`requireRecordReferenced`) | §2.2. |
| 16 | `CreateOperation.ts:2109` | `referencedValue` (`:2101`) | **MSI** | **RETIRED → 15** | §2.1. |
| 17 | `CreateOperation.ts:2139` | `edgeParentId` (`:2133`) | **UFF** | **RETIRED (converted)** | §10.1, §7.4. **Expiry: the `JunctionSide` topology** (limitation-lift plan §6 N2), with its schema, migration, join-SQL, OwnWrite and engine work enumerated there. |
| 18 | `CreateOperation.ts:2193` | `referencedParentSource` (`:2186`) | **MSI** | **RETIRED → 15** | §2.4, narrowed by F to its NULL member. |
| 19 | `CreateOperation.ts:2788` | `producedReference` (`:2777`) | **PSI** | `:2850` / `:2839` | F, §7.5. An atomic batch addresses no statement's rows, so a produced column cannot be published there. The message names the workaround: run it on a driver offering an interactive transaction. Deliberately not a shape in §1–§10 — it is a substrate fact. |
| 20 | `CreateOperation.ts:3091` | `assertSharedPkResolved` (`:3077`) | **MSI** | `:3154` / `:3140` | §3.1. The record's own primary key IS the edge, so its value must exist before the plan is built. |
| 21 | `UpsertOperation.ts:1147` | `createArmIdentity` (`:1103`) | **MSI** | `:1147` / `:1103` | §9.1, plan §7.2 bullets 1 and 3. |

### The query-engine sites outside the write engine — 3 at N3, **2** after Package O

| # | Site | Owner | Bucket | HEAD | Basis |
|---|---|---|---|---|---|
| 22 | `relation-key-legality.ts:162` | `assertSelectedUpdateManyDataIsScalar` (`:155`), junction arm | **MSI** | `:173` / `:167` (both arms) | Twin of 9. |
| 23 | `relation-key-legality.ts:166` | the same function, ordinary arm | **MSI** | **RETIRED → 22** | Twin of 10. |
| 24 | `builders/decimal-portability.ts:56` | `assertExactDecimalOperation` (`:48`) | **PSI** | `:56` / `:48` | §7.5. SQLite has no exact decimal type; the message already names the workaround. |

### The 2 `src` sites outside the query engine

| # | Site | Owner | Bucket | HEAD | Basis |
|---|---|---|---|---|---|
| 25 | `src/drivers/shared/transaction-options.ts:144` | `refuseTransactionOption` (`:139`) | **PSI** | `:144` / `:139` | The driver does not implement the option. |
| 26 | `src/client/raw.ts:129` | `rawOperationInBatchError` (`:128`) | **SC** | `:129` / `:128` | A raw statement has already run; there is nothing left to batch. |

### Distinct invariants — the measure §O4 calls the more important one

The query-engine sites collapse to twelve cluster HEADINGS — and to **13**
invariants before Package O, **12** after it, because row 4 is one phrase over
two of them. **Package O settled that on row 4's own evidence** (two invalid
states, two first-knowable boundaries, two buckets, two falsifiers that do not
answer each other), so the "12" this section used to headline was an undercount
of one and the number below is the corrected series. The same correction is
carried in `guard-ownership-ledger.md` and
`operation-construction-inventory.test.ts`.

| # | invariant | sites at N3 | sites after O |
|---|---|---|---|
| 1 | an unresolvable referenced value | 8 (2, 3, 5, 14, 15, 16, 18, 20) | **4** (2, 3, 5, 15) |
| 2 | nested bulk data carries relation writes | 4 (9, 10, 22, 23) | **1** (22) |
| 3 | a second provenance for the owned foreign key | 2 (11, 12) | 2 (11, 12) |
| 4a | `skipDuplicates` whose nested-effect meaning is unchosen (DPC) | 1 (7) | 1 (7) |
| 4b | `skipDuplicates` whose skipped row produces no identity (MSI) | 1 (8) | 1 (8) |
| 5 | an upsert create arm with no readable-back row | 1 (21) | 1 (21) |
| 6 | a shared primary key with no one final value | 1 (4) | **2** (4, 20 — the ledger moves 20 here from cluster 1: same invariant, create root instead of update root) |
| 7 | a single-target membership move across N > 1 roots | 1 (1) | 1 (1) |
| 8 | a composed supplier + modify | 1 (6) | 1 (6) |
| 9 | a compound child edge into a junction | 1 (17) | **0 as a census site** — CONVERTED; the invariant is still engine-owned by `getRequiredSinglePrimaryKeyField` and still refused before any I/O |
| 10 | depth on an upsert's update arm | 1 (13) | 1 (13) |
| 11 | publication on a batch substrate | 1 (19) | 1 (19) |
| 12 | decimal portability | 1 (24) | 1 (24) |

By scope, as §O4 asks: write-engine **15 sites / 10 invariants** · query-engine
**17 / 12** · whole `src` **19 / 14**. Engine-owned refusal invariants: **13**,
the twelfth plus the converted compound-many-to-many one.

**§O4's band is a SITE gate, and 15 does not meet it either.** The plan says "Expected result: 8–12 construction sites" and "a result above 12 blocks finalization until an architecture review examines every survivor", so Package O's architecture review was MANDATORY. **IT WAS CONDUCTED AND IT APPROVED ALL 19 SURVIVORS, none rejected** — the record, including the verdict verbatim and the site-by-site table, is in `guard-ownership-ledger.md` under "§O4 — the architecture review: adjudication record", and the five-question §O3 audit is in the same file. The approval rests on a fact worth repeating here: 15 write-engine sites express 10 invariants, so even a perfect one-site-per-invariant estate would sit at 10, and the whole overshoot is five extra sites across three multi-boundary invariants, each with a trust boundary verified in code. The invariant count is what §O4 asks to be *reported* beside the raw count, not a second gate that can be met instead. An earlier version of this paragraph said the band was already satisfied — it was reading a site gate against an invariant count — and the version before this one still read "24 does not meet it" after the census had become 17.

Cluster 1 was eight sites saying one thing, and it is precisely §O2's "fresh referenced field publication" group — the largest single compression opportunity in Package O, and arithmetic rather than judgement. **Package O took it: sites 14, 16 and 18 fold into `CreateOperation.requireRecordReferenced` (`:2764`, throwing at `:2772`), which takes a position argument that selects the noun and makes the decision once; every previously pinned sentence survives byte-identically.** Its eight were also counted over ONE error class: `CreateOperation.ts:1027` (this document read it at `:1015`) repeats site 14's sentence BYTE-IDENTICALLY as a `QueryEngineError`, and `RecordUpdateCompiler.ts:939`, `:964` and `:1164` state the same invariant in that class as well. Package F filed the first pair as a For-O item; all four are named here because a class change removes a site from the census grep without removing the refusal, and cluster 1 is where that bites. The twin now shares the owner's message BUILDER so the two sentences cannot drift, and keeps its class: converting it owes a behavioral witness of the shape, and no payload reaches either polymorphic position (a direct polymorphic edge's referenced field is always the target's primary key, and the three spellings that would make it unresolvable are refused by the parse boundary first).

Bucket distribution at N3 (before Package O), with site 4 counted under MSI and flagged for its SC disjunct: over the 24 query-engine sites **MSI 15 · SC 4 · PSI 2 · UFF 2 · DPC 1** (= 24); adding the two `src` sites outside the query engine **MSI 15 · SC 5 · PSI 3 · UFF 2 · DPC 1** (= 26); over the 21 write-engine sites alone **MSI 13 · SC 4 · PSI 1 · UFF 2 · DPC 1** (= 21).

After Package O: over the 17 query-engine sites **MSI 9 · SC 4 · PSI 2 · UFF 1 · DPC 1** (= 17); over all 19 `src` sites **MSI 9 · SC 5 · PSI 3 · UFF 1 · DPC 1** (= 19); over the 15 write-engine sites alone **MSI 8 · SC 4 · PSI 1 · UFF 1 · DPC 1** (= 15). Six MSI positions left (9, 10, 14, 16, 18, 23) and one UFF changed class (17). Each line carries its total because the previous version's two lines summed to 23 and 25.

### Residues with a stated expiry, and one without

Sites 6 and 17 are UFF and both name their expiry above. **Site 9 / 10 / 22 / 23 do NOT get one**, and this is the correction Package L bought: BOTH of its prototypes were REJECTED, so nothing in this lift lifts the nested-bulk wall, and a document that implied otherwise would be promising work no one has scheduled. Package L's boundary, verbatim:

> the fragment atom's single planning phase is the wall; a record series is operation-level, so a nested capture has no home.

The truthful future path is not a series at all — it is the **desugar already standing on the junction leg**: `RelationJunctionPart`'s `case createMany` folds one fresh target per row, identically to its `case create`, and `nested-target-parts.ts` does the same through `createFresh` + `bindRelationMembership`. Extending that to the other three legs is a NEW capability outside this lift, and it is the shape any future attempt should start from.

### Ledger notes for Package O, raised by this classification

- **Site 4 expresses two invariants** under one sentence (above). Splitting it is O's call.
- **Sites 11 and 12 share one message from one string** (`messages.ts`, `relationOwnsForeignKey`) and one invariant, at two seams with opposite dispositions — one refuses, the other absorbs the agreeing case first. That is deliberate and documented at both, but it is the only place in this table where one invariant has two owners by design.
- **`assertOwnedFkAbsentFromUpdateData` has FOUR call positions and only ONE of them is dead.** The Package N gate re-measured this row after the implementer's version claimed the opposite shape. `buildToManyUpdateManyParts` — which the implementer's note recorded as needing no guard — was measured ACCEPTING the spelled key on a divergent schema and reparenting the row, so the gate wired it to the same guard (`:1365`). What is dead is `buildToManyUpdateParts` (`:1268`): on that same schema the targeted arm dies earlier, in the engine's own scanner (`Cannot determine FK fields for relation 'ghost'`), because a targeted to-many update binds the target's relations while the bulk arm binds nothing. **O must not read "no live route" as licence to delete a call position without re-measuring the arm's own binding behaviour** — that is precisely the mistake this row is correcting. The site as a whole is reachable through three of four positions, each pinned. **PACKAGE O OBEYED THIS: it kept all four positions and did not re-measure them, recording the disposition as N's measurement rather than its own** (`guard-ownership-ledger.md`, site 11). It also applied the same rule at the one seam it touched — `nested-target-parts.buildJunctionTargetRelationParts` now calls the bulk-leaf owner even though that position has no measured live route, because the arm in question is again a bulk one.
- **The compound-M2M fact has two owners across layers and NEITHER is a census site**: `builders/correlation-utils.ts:154` (`getRequiredSinglePrimaryKeyField`, a `QueryEngineError`) and `src/migrations/serializer.ts:661` (a raw `Error`). Their sentences are near-identical but NOT byte-identical — "uses a compound primary key" against "uses compound primary key". N2 wrote here that §10.1's `edgeParentId` reached the same fact one statement earlier and was the only one the census saw. **PACKAGE O MEASURED THAT FALSE**: driven through the public client on a compound-primary-key model carrying a many-to-many relation, the answer comes from `getRequiredSinglePrimaryKeyField` via `getManyToManyJoinInfo` ← `RelationMembership.getRelationMembershipScope` ← `OwnWriteRelation.create` ← `OwnWriteAnalyzer.analyze`, at the record-program boundary, BEFORE `CreateOperation` interprets any relation. `edgeParentId` never reached the fact at all, so it was converted to a `QueryEngineError` naming a structural invariant, with the behavioral witness the conversion law demands (`operation-construction-witnesses.test.ts`, "a compound primary key carrying a many-to-many relation"). A §O4 grep now finds none of the three, which is the honest state of it — and the plan's §7.4 coordinate (`CreateOperation.ts:1998`) needs re-pointing at `getRequiredSinglePrimaryKeyField` in the FINAL docs pass.
- **`relation-key-legality.ts:61-71` (`assertUpdateManyRelationsAreCompilable`) is NOT a census site** — it throws `NestedWriteError`. Package L's outcome brief listed it among "4 census sites unchanged"; correcting it here so O does not hunt for a site that never existed.
- **The create side over-omits where the update side does not.** `CreateWithOmittedFk` applies the inverse-FK map without asking whether the TARGET row holds the key, so a `manyToMany` arm cannot spell an unrelated foreign key of its target (`post.tags.create` refuses `featuredPostId`) and a self-referential parent-held to-one cannot spell its own (`node.parent.create` refuses `parentId`). Both refuse at HEAD, both predate this lift, and both are a capability lift with their own measurement rather than a Package N correction. `UpdateWithOmittedFk` is scoped correctly and is the model.
- **A per-deployment determinism boundary, not a refusal:** `sortCapturedRowKeys` (`target-projection.ts`) orders `updateMany` series members deterministically per deployment but NOT identically across providers — node-postgres decodes an int8 row key as the string `"9"`, PGlite as the number `9`, better-sqlite3 as `9n`, which ranks them differently. Visible in the `select` arm's row order. Measured by Package K; it belongs in a truthful record of what varies, not in a list of what is refused.

---

## The honesty note

All 19 of these **type-check and pass validation**, then throw at construction (26 when this paragraph was written; Package O folded six positions and converted one, lifting nothing). TH measured the type-narrowable surface as empty *for the current generator* — one relation-input type serves positions with opposite dispositions, so removing a key would forbid shapes that execute. Package N1 is the first counter-example and a narrow one: the relation-owned foreign key IS position-decidable, and removing it from nested update data cost nothing that executes, because the engine had a fold for that column at every position it was removed from. Roughly four of them are permanent AND statically decidable (the `updateMany` relation writes — sites 9 and 10 at the time, now the one owner, site 22 — the supplier×supplier pairs, and the unnameable-unique `skipDuplicates`) and could in principle become compile errors if the generator emitted position-aware inputs — at an instantiation-depth cost the estate has already measured once (34s → 172s for three guarded clauses). That measurement is proposed, not done. The compound junction edge is statically decidable too, but §10 and §12 both classify it as UFF rather than a permanent refusal, so a type that forbade it would have to be reopened when that topology lands.
