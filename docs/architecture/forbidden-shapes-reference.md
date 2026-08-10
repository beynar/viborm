# The Forbidden Shapes — a reference with examples

**Date:** 2026-08-05
**Re-anchored:** 2026-08-09, against the tree at the limitation-lift plan commit.
**Scope:** the 30 refusals standing after PR #20, MINUS the 9 the final re-audit re-filed as expressible work, MINUS the 2 that Package B of the limitation lift deleted (2026-08-10; see "What has been DELIVERED since"). What remains is **21 shapes**, each with the payload that raises it and the reason it stands.

Every refusal below is an `UnsupportedOperationError` raised at CONSTRUCTION — before any statement runs, so nothing is written. Each has a committed witness in `tests/contracts/engine/write/`. The examples are derived from the refusal conditions in code, the re-audit's per-site arguments, and those witnesses; they show the SHAPE, not a runnable fixture.

**Anchoring convention.** A refusal SITE is anchored on its
`throw new UnsupportedOperationError(` line, not on the message template one line
below it. A named guard FUNCTION is anchored on its declaration line instead, and
is always given by name — `RelationWritePart.ts:1167`
(`assertOwnedFkAbsentFromUpdateData`) is a throw, and `:1157` is that same
function's declaration. The limitation-lift plan and the parity witnesses use the
same two rules; when a number here and a number there differ, the file that moved is
the one at fault.

Every site coordinate below was re-anchored on 2026-08-09. Two things had moved
since the original writing, and neither changes a shape:

- The selected-record refusals left `UpdateOperation.ts`; `RecordUpdateCompiler.ts`
  owns them now, and `UpdateOperation.ts` holds no refusal site at all.
- Three shapes gained a bound-polymorphic twin position (§2.2, §2.5, and the
  compound-child-PK family under "What is NOT here"), and one shape moved out of
  the write engine entirely (that section's last row).

The executable census owner is
`tests/contracts/engine/write/operation-construction-inventory.test.ts`; it pins
29 `new UnsupportedOperationError` sites under `src/query-engine/write-engine`.
Sites are positions, not shapes: the 21 shapes below occupy 23 of those sites,
and the remaining 6 belong to the shapes under "What is NOT here".

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

## 1. Two intents for one to-one slot (4)

A to-one slot holds exactly one row. Two identity-supplying kinds are two intents, and no ordering makes them one.

**1.1 — parent-held to-one under `create`** · `CreateOperation.ts:1378`

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

**1.2 — child-held/inverse to-one under `create`** · `CreateOperation.ts:1687`

```ts
client.user.create({
  data: { email: "a@b.c", badge: { create: { label: "x" }, connect: { id: 3 } } },  // ✗
});
```

Newly forbidden in PR #20 (D5). Before the fix this ran **both** kinds and put two rows in a to-one slot.

**1.3 — parent-held to-one under `update`** · `RecordUpdateCompiler.ts:1253`

```ts
client.user.update({
  where: { id: 1 },
  data: { profile: { disconnect: true, connect: { id: 2 } } },   // ✗ on the PARENT-held side
});
```

The vacate-then-supply pairs E6.5 absorbed apply to the **child-held** direction only. Here `delete`'s FK-null lands in the post-root bucket *after* the supplier's rebind has been folded into the root SET, so the pair would orphan the supplied row. Measured, not assumed.

**1.4 — child-held to-one under `update`, supplier × supplier** · `RecordUpdateCompiler.ts:4116` (`assertToOneMutationArity`, reached from the inverse dispatches at `:1296` and `:1437`)

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

---

## 2. A value that names no row (5)

A foreign key equal to `NULL` references nothing. These fire when the referenced column has no value knowable at construction.

**Maintainer ruling, 2026-08-06.** For the genuinely unknowable case the engine's refusal is CORRECT and stays: a value no row holds cannot be written, and no round trip produces one. That ruling does not cover a value the DATABASE produces — one the provider could RETURN, or that a stable unique selector could refetch after the INSERT. Those are re-audited under the limitation-lift plan's Package F (demand-driven fresh-record field publication), which classifies each site by value state and keeps the refusal only for the null, absent, or unnameable-row rows of its table. Read every entry below with that split in mind: **2.1**, **2.2**, and **2.3** are the database-produced cases Package F re-audits; **2.4** and **2.5** are the unknowable cases the ruling confirms.

**2.1 — the record's own referenced column, under `create`** · `CreateOperation.ts:1968`

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

Three provenances are accepted: the key the INSERT generates (a backward `Ref`), a key already in the identity, and a non-PK column the create data **spells**. A column left to the database has none of them at plan time.

**2.2 — a before-parent target's referenced column, under `create`** · `CreateOperation.ts:1647`, and its bound-polymorphic twin at `:884`

```ts
client.member.create({
  data: { name: "x", org: { create: { name: "Acme" } } },   // org.code not spelled
});
```

**2.3 — the same, at an `update` root** · `RecordUpdateCompiler.ts:3161`

```ts
client.member.update({
  where: { id: 1 },
  data: { org: { create: { name: "Acme" } } },              // org.code not spelled
});
```

**2.4 — one COMPONENT of a compound edge** · `CreateOperation.ts:2052`

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

**2.5 — a nested create referencing a column the root rewrites to a non-literal** · `RecordUpdateCompiler.ts:1877`, `:1956` (the per-member twin inside `transitionedCreateParent`), and `:1670` (the bound-polymorphic twin inside `resolvePolymorphicParent`)

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

## 3. Shared primary key (1)

**3.1 — a shared-PK edge whose value is not a compile-time literal, under `create`** · `CreateOperation.ts:2737` (`assertSharedPkResolved`)

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

---

## 4. Junction / many-to-many (3)

**4.1 — `skipDuplicates` where no single unique names the skipped-on row** · `RelationJunctionPart.ts:1348`

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

**4.2 — a junction create arm whose subtree cannot name its own row** · `RelationJunctionPart.ts:1813`

The target's primary key is neither spelled in the create data, nor produced by the INSERT, nor knowable — so the join row would reference a value no row holds. *Narrow: the parse boundary fills every defaulted key and requires undefaulted ones, so the public surface reaching this is small.*

**4.3 — relation writes inside m2m `updateMany` data** · `RelationJunctionPart.ts:2314`

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

**5.1 — spelled in nested UPDATE data** · `RelationWritePart.ts:1167` (`assertOwnedFkAbsentFromUpdateData`)

```ts
client.user.update({
  where: { id: 1 },
  data: { profile: { update: { bio: "x", userId: 2 } } },   // ✗ profile owns userId
});
```

Newly forbidden in PR #20 (D4). Before the fix the spelled value **won** — it rides the target's own SET, which lands *after* the correlation already chose the row, so the parent silently lost the child it was updating through. Measured live at three positions.

**5.2 — spelled with a DISAGREEING value at the adopt seam** · `RelationUpsertPart.ts:733`

```ts
client.author.update({
  where: { id: 1 },
  data: {
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

The agree case is absorbed only where the parent value is a construction-time **literal**; a `planned`/`ref` source has nothing to compare against, and deferring the comparison to compile would move a typed refusal behind writes that already ran.

---

## 6. Depth on an upsert's update arm (1)

**6.1 — a parent-held to-one write one level deeper** · `RelationUpsertPart.ts:1196` (`assertArmEdgeIsChildHeld`)

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

## 7. Primary-key transition interactions (1)

**7.1 — an adopt kind while the root transitions an unpinned referenced column** · `RecordUpdateCompiler.ts:1347`

```ts
client.org.update({
  where: { name: "Acme" },              // located by a NON-PK unique → the pre-value is unpinned
  data: {
    code: "new-code",                   // transitions the referenced column
    members: { connect: [{ id: 5 }] },  // ✗ an adopt kind, not a create
  },
});
```

The adopt kinds need the occupied guard's PRE-transition value **and** the POST value. `parentFkLocateFields` publishes the pre-value and E6.7 derives the post one, so the remaining wall is the guard's own construction-time shape — narrow, and flagged as worth its own measurement before any lift.

---

## 8. Relation writes in the wrong data clause (1)

**8.1 — relation writes inside child-held `updateMany` data** · `RelationWritePart.ts:663`

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

*(One thing the surviving half does NOT answer, measured at the gate rather than reasoned about, and named here so Package K/N does not have to rediscover it: `parseScalarUpdateData` reads only `scalarData` and `relations`, so the third parsed member — a direct polymorphic mutation whose resolved intent carries no relation program, i.e. a `disconnect` — passes the wall untouched and is then dropped. `author.update > posts.updateMany.data: { subject: { disconnect: true } }` compiles to the terminal select ALONE and succeeds having cleared nothing; with a scalar beside it, `UPDATE … SET "body" = $1 WHERE "authorId" = $2` runs and the private pair is silently left in place. That is a silent wrong answer rather than a refusal, which is why it has never appeared in this document — and it is exactly the defect Package G fixed on the upsert half by forwarding `polymorphic`. It has nothing to do with capture roots and is refusable today; `updateManyCarriesRelations` and `findRelationBearingUpdateManyData` share the blind spot, both reading `.relations` alone.)*

---

## 9. Read-back identity (1)

**9.1 — an upsert create arm that names no row to read back** · `UpsertOperation.ts:1134`

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

**10.1** · `CreateOperation.ts:1998` (`edgeParentId`)

```ts
const org = s.model({ region: s.string(), code: s.string(), tags: s.manyToMany(() => tag) })
  .id(["region", "code"]);                             // compound primary key

client.org.create({
  data: { region: "eu", code: "1", tags: { connect: [{ id: 2 }] } },   // ✗
});
```

A junction row keys its parent half with ONE column by construction (`getManyToManyJoinInfo` → `getRequiredSinglePrimaryKeyField`). This refusal reaches that fact one statement earlier than the schema layer does; N3-U3 re-proved it.

**Reclassified 2026-08-09: this is an unimplemented FUTURE CAPABILITY, not a semantic seal.** Compound many-to-many join sides are a topology the schema layer does not describe yet; the shape is coherent and the refusal is only where today's engine meets that gap. The limitation-lift plan keeps the focused refusal here (§7.4, Package N2) and names the work it waits on: compound join-side schema metadata, migration and introspection support, join SQL with ordered multi-column halves, and engine membership and identity projection. Do not restate it as a validation rule to move the error earlier, and do not read it as permanent.

---

## What is NOT here

The refusals the final re-audit re-filed as expressible work — they still throw today, but each has a named post-E mechanism and should not be treated as a boundary:

| Site | Shape |
|---|---|
| `RecordUpdateCompiler.ts:1324`, `:1495`, `:2631`, `RelationUpsertPart.ts:1049`, `nested-target-parts.ts:190` | any nested write whose CHILD model has a compound primary key (five positions; `:1495` is the bound-polymorphic inverse one) |
| `RecordUpdateCompiler.ts:3084` | shared-PK create/connectOrCreate/upsert at an update root |

Changes since this list was written, each verified against the tree:

- (2026-08-09) The list had **six** rows. One of them — a deeper write on the update arm "whose planning read asserts that its own target exists" — is **DELIVERED and removed**: the selected-record compiler makes a conditional arm's descendant outputs optional until the found arm is selected (`conditionalArmPlanning`, `write-engine/Part.ts:63`; `StatementOutputSource.optional`, `write-engine/OperationFragment.ts:37`; resolution at `write-engine/OperationExecutor.ts:905`). That message no longer occurs anywhere in `src`.
- (2026-08-09) The compound-child-PK row grew from four positions to five with the bound-polymorphic inverse write parity, and the last row moved OUT of the write engine into `src/query-engine/relation-key-legality.ts`, so the write-engine census no longer counts it.
- (2026-08-10, Package B) **Two more rows are DELIVERED and removed**, both by the same change — the upsert arm's found arm delegates to `RecordUpdateCompiler`:
  - `assertArmPkStable`, "an upsert arm that moves its own PK while carrying deeper writes". The compiler owns primary-key transitions: it derives the post-transition value, defers the writes that reference it until after the root UPDATE, and refuses an OCCUPIED old slot with V1's referential-action message — which is the half of the invariant that was real. RESIDUE, measured and deliberately unguarded: a junction pair that opts out of the implicit `ON UPDATE CASCADE` has no engine owner for the transition at the arm OR at the update root; both fail closed at the constraint with identical statements and no partial effect, so the constraint owns it and a refusal at the arm alone would be an asymmetric duplicate (`nested-arm-dispatch.test.ts`, "B1 RESIDUE").
  - `assertArmEdgeReferencesLocatedPk`, "a compound / non-PK referenced edge deeper on the update arm". Its recorded reason named the mechanism it waited for — widen the arm probe's projection and give the leaf a per-column source — and the delegation is that mechanism: every consumed referenced field joins `locateFields`, the probe publishes the target projection, and each foreign-key member resolves by NAME (`upsert-arm-referenced-edge.test.ts`).
  The three remaining rows then held seven positions, six of them inside the write engine. A THIRD deletion was attempted in the same package — `assertArmEdgeIsChildHeld`, §6.1 above — and was falsified at the package gate; it is neither delivered nor listed here.
- (2026-08-10, Package D) **One more row is DELIVERED and removed**: `assertPinnedTransitionIsCompilable` (`relation-key-legality.ts`), "a target PK transition plus a non-cascading deeper edge, located by another unique". Its recorded obstacle was that the pre-transition value had to be a compile-time LITERAL; the value it actually needed was the PRE-TRANSITION one, which the probe that located the target already publishes. `RecordUpdateCompiler.interpretReferencedKeyTransition` now reads every reference-key member's old value from the located row and derives every member's new value at compile (`postTransitionReference`), so the whole function is deleted with its five eager arm-side call sites. The same change deleted the update root's `pastSurface` refusal — the compound, non-primary-key, and unpinned reference shapes it covered now compile through the same two sources. Witnessed in `parity-d-transition` (structural, both substrates, three falsifications), `pk-transition-junction-mixed-edge`, `nested-update-pk-transition-cascade`, `inverse-to-one-update-depth`, and `nested-arm-dispatch`.
  RESIDUE, deliberate and narrow: a same-value write of a referenced column is treated as a real transition wherever the pre-value is not a construction literal — which needs BOTH a single-member reference and a locator that pins it, a compound reference having no construction-time post-value even when the locator pins every member. So an occupied old slot then refuses with the occupied message where a pinning single-member locator would accept. The no-op question needs the pre-value, and the two things the regime decides — `afterRootParts` ordering and the to-one upsert's create-arm reroute — are construction-time structure. For every nested kind but `create` / `createMany` this NARROWS a refusal that used to cover the whole shape.
  NOT a lift, and the ledger says so rather than letting the sentence above imply it: for nested `create` / `createMany` the occupied guard is a NEW REFUSAL on payloads that previously executed. `pastSurface` returned before the guard could be emitted and its caller let those two kinds through untouched, so a compound / non-primary-key / unpinned reference carrying create-only relations used to compile with no probe and no guard however occupied the old slot was — while the PINNED single-member twin of the same payload was refused with the occupied message throughout. The guard is kind-blind and relation-level, so unifying the two spellings costs that accept. This is a §3.1 change of "guards and postconditions", "statement count and round trips", and "error class, message" on an accepted payload, and it needs the coordinator's ratification rather than a package's. Measured on every driver leg (`compiled-key-transition-behavior.ts`, "an OCCUPIED old slot refuses the same nested create the empty slot accepts").
  BOUNDED at the gate: an old reference tuple with a NULL member addresses no row under MATCH SIMPLE, so the guard does not fire for it. That is decided once for both substrates, because the guard's two carriers lower a null pre-value differently — the planning probe binds it as a parameter (`= $n`, never true of NULL), the atomic batch's premise resolves it to a literal (`IS NULL`, true of NULL) — and the same payload was resolving on a transaction while throwing the occupied error on a batch (`RelationKeyGuard.oldReferenceIsAddressable`; pinned on both substrates in the same behavior file).
- (2026-08-10, Package G) **The last row of this section is DELIVERED and removed**: the inverse-to-one upsert-arm HALF of §8.1's site. Its recorded obstacle was that the arm had no captured target to hand a nested write; the arm's own correlated probe had been publishing exactly that since Package C, and Package D removed the last reason an UNPINNED target could not carry one. `RelationWritePart`'s `inverseUpsert` branch now parses the arm ONCE through `buildParsedRelationPrograms` and hands all three members — `scalarData`, `relations`, and the `polymorphic` map it used to drop on the floor — to `RecordCompilerSeam.updateSelected`, with no `incomingMembership` (the probe found the row BY the membership, so the arm never reparents) and no `pinnedTarget` (a correlated inverse to-one has no unique `where`, so nothing is construction-known). The relation owner keeps the correlated probe, the found/missing decision, the batch premise guard and the transaction affected-rows failure; what moved is the found arm's body and the timing of its legality, which is now a deferred closure invoked after the arm is selected — ATOM §13's wording, which this seam was the last one not to obey.
  DELIVERED TOO, in the same parse: a direct polymorphic `disconnect` resolves to an intent with no relation program, so it lived only in the dropped third member. Measured at `a8349793`, `owner.update > card.upsert.update: { subject: { disconnect: true } }` compiled the found arm to ZERO steps and the call succeeded having cleared nothing, while the sibling nested `update` kind emitted the UPDATE. That was a silent wrong answer, not a refusal, so it was never in this document; it is recorded here because the same line caused both.
  §3.1 CHANGE, small and named: PK-portability and relation-key legality used to run at CONSTRUCTION for this seam, so a `profile.upsert.update` that fails them threw with an empty statement log whether or not the found arm was taken. They now run after the planning probe and only on the found arm; on a MISSING probe they do not run at all. Same class as Package D's two retargets. Witnessed on both substrates in `inverse-to-one-update-depth` (found-arm depth and grandchild depth, missing-arm inertness, deferred legality, empty found arm), `record-compiler-contract` (convergence with the nested `update` kind, compound captured row key with a decoy, the polymorphic forward), and `polymorphic-write-family` (the singular polymorphic inverse, which rides the same Parts). Three falsifications: dropping `conditionalArmPlanning` breaks the missing arm on both substrates, dropping the deferred call breaks the legality split, dropping `polymorphic` restores the silent discard.
  NOT DELIVERED, stated so the §8.1 entry is not read as half-dead: the `updateMany` half stays, and so does the guarded-transition reroute (`RecordUpdateCompiler.rerouteTransitionedUpsertCreateArm`), which drops an inverse upsert's update payload WHOLESALE when the root transitions a referenced key — no wall fires there today and none fires after G, because the update arm is claimed unreachable under that regime. Package G left it untouched and records it here rather than silently inheriting it.

## The honesty note

All 21 of these **type-check and pass validation**, then throw at construction. TH measured the type-narrowable surface as empty *for the current generator* — one relation-input type serves positions with opposite dispositions, so removing a key would forbid shapes that execute. Roughly five of the 21 are permanent AND statically decidable (the `updateMany` relation writes ×2, the supplier×supplier pairs, the unnameable-unique `skipDuplicates`) and could in principle become compile errors if the generator emitted position-aware inputs — at an instantiation-depth cost the estate has already measured once (34s → 172s for three guarded clauses). That measurement is proposed, not done. The compound junction edge is statically decidable too, but §10 reclassifies it as a future capability rather than a permanent refusal, so a type that forbade it would have to be reopened when that topology lands.
