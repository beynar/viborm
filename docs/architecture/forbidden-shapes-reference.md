# The Forbidden Shapes — a reference with examples

**Date:** 2026-08-05
**Scope:** the 30 refusals standing after PR #20, MINUS the 9 the final re-audit re-filed as expressible work. What remains is **21 shapes**, each with the payload that raises it and the reason it stands.

Every refusal below is an `UnsupportedOperationError` raised at CONSTRUCTION — before any statement runs, so nothing is written. Each has a committed witness in `tests/query-engine-v2/`. The examples are derived from the refusal conditions in code, the re-audit's per-site arguments, and those witnesses; they show the SHAPE, not a runnable fixture.

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

**1.1 — parent-held to-one under `create`** · `CreateOperation.ts:1113`

```ts
client.user.create({
  data: {
    email: "a@b.c",
    profile: { create: { bio: "x" }, connect: { id: 7 } },   // ✗ two kinds
  },
});
// query-engine-v2 create supports one operation on the to-one relation 'profile'; it has connect, create.
```

The same site refuses **zero** kinds (`profile: {}`). *Note: this half is flagged in the plan as a parity question — the child-held twin treats an empty payload as Prisma's measured no-op. The two dispatches should agree; not yet decided.*

**1.2 — child-held/inverse to-one under `create`** · `CreateOperation.ts:1393`

```ts
client.user.create({
  data: { email: "a@b.c", badge: { create: { label: "x" }, connect: { id: 3 } } },  // ✗
});
```

Newly forbidden in PR #20 (D5). Before the fix this ran **both** kinds and put two rows in a to-one slot.

**1.3 — parent-held to-one under `update`** · `UpdateOperation.ts:1372`

```ts
client.user.update({
  where: { id: 1 },
  data: { profile: { disconnect: true, connect: { id: 2 } } },   // ✗ on the PARENT-held side
});
```

The vacate-then-supply pairs E6.5 absorbed apply to the **child-held** direction only. Here `delete`'s FK-null lands in the post-root bucket *after* the supplier's rebind has been folded into the root SET, so the pair would orphan the supplied row. Measured, not assumed.

**1.4 — child-held to-one under `update`, supplier × supplier** · `UpdateOperation.ts:1427`

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

**2.1 — the record's own referenced column, under `create`** · `CreateOperation.ts:1621`

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

**2.2 — a before-parent target's referenced column, under `create`** · `CreateOperation.ts:1363`

```ts
client.member.create({
  data: { name: "x", org: { create: { name: "Acme" } } },   // org.code not spelled
});
```

**2.3 — the same, at an `update` root** · `UpdateOperation.ts:3260`

```ts
client.member.update({
  where: { id: 1 },
  data: { org: { create: { name: "Acme" } } },              // org.code not spelled
});
```

**2.4 — one COMPONENT of a compound edge** · `CreateOperation.ts:1705`

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

**2.5 — a nested create referencing a column the root rewrites to a non-literal** · `UpdateOperation.ts:1792` and `:1861` (the per-member twin inside the transitioned source)

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

**3.1 — a shared-PK edge whose value is not a compile-time literal, under `create`** · `CreateOperation.ts:2216`

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

**4.1 — `skipDuplicates` where no single unique names the skipped-on row** · `RelationJunctionPart.ts:1481`

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

**4.2 — a junction create arm whose subtree cannot name its own row** · `RelationJunctionPart.ts:2029`

The target's primary key is neither spelled in the create data, nor produced by the INSERT, nor knowable — so the join row would reference a value no row holds. *Narrow: the parse boundary fills every defaulted key and requires undefaulted ones, so the public surface reaching this is small.*

**4.3 — relation writes inside m2m `updateMany` data** · `RelationJunctionPart.ts:2727`

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

**5.1 — spelled in nested UPDATE data** · `RelationWritePart.ts:1565`

```ts
client.user.update({
  where: { id: 1 },
  data: { profile: { update: { bio: "x", userId: 2 } } },   // ✗ profile owns userId
});
```

Newly forbidden in PR #20 (D4). Before the fix the spelled value **won** — it rides the target's own SET, which lands *after* the correlation already chose the row, so the parent silently lost the child it was updating through. Measured live at three positions.

**5.2 — spelled with a DISAGREEING value at the adopt seam** · `RelationUpsertPart.ts:834`

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

**6.1 — a parent-held to-one write one level deeper** · `RelationUpsertPart.ts:1284`

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

An architecture boundary, not a missing value: the arm is ONE UPDATE carrying the reparent, the upsert-premise `expects` and the found pin. A delegated sub-operation would emit a SECOND UPDATE of the same row and fork the premise this Part pins.

*(The other three arm-depth refusals — the asserting probe, the arm moving its own PK, and the compound/non-PK deeper edge — all failed the re-audit and are listed as future work, not here.)*

---

## 7. Primary-key transition interactions (1)

**7.1 — an adopt kind while the root transitions an unpinned referenced column** · `UpdateOperation.ts:1481`

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

**8.1 — relation writes inside child-held `updateMany` data** · `RelationWritePart.ts:729`

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

The `:2727` wall verbatim, one relation kind over. *(The inverse-to-one UPSERT-arm half of this same site failed the re-audit and is future work.)*

---

## 9. Read-back identity (1)

**9.1 — an upsert create arm that names no row to read back** · `UpsertOperation.ts:1004`

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

**10.1** · `CreateOperation.ts:1646`

```ts
const org = s.model({ region: s.string(), code: s.string(), tags: s.manyToMany(() => tag) })
  .id(["region", "code"]);                             // compound primary key

client.org.create({
  data: { region: "eu", code: "1", tags: { connect: [{ id: 2 }] } },   // ✗
});
```

A junction row keys its parent half with ONE column by construction (`getManyToManyJoinInfo` → `getRequiredSinglePrimaryKeyField`). This refusal reaches that fact one statement earlier than the schema layer does; N3-U3 re-proved it.

---

## What is NOT here

The **nine** refusals the final re-audit re-filed as expressible work — they still throw today, but each has a named post-E mechanism and should not be treated as a boundary:

| Site | Shape |
|---|---|
| `UpdateOperation.ts:1456`, `:2671`, `RelationUpsertPart.ts:1109`, `nested-target-parts.ts:424` | any nested write whose CHILD model has a compound primary key (four positions) |
| `UpdateOperation.ts:3184` | shared-PK create/connectOrCreate/upsert at an update root |
| `RelationUpsertPart.ts:1331` | a deeper planning read that asserts its own target exists |
| `RelationUpsertPart.ts:1384` | an upsert arm that moves its own PK while carrying deeper writes |
| `RelationUpsertPart.ts:1432` | a compound / non-PK referenced edge deeper on the update arm |
| `RelationWritePart.ts:828` | a target PK transition plus a non-cascading deeper edge, located by another unique |

Plus the inverse-to-one upsert-arm half of `RelationWritePart.ts:729`.

## The honesty note

All 21 of these **type-check and pass validation**, then throw at construction. TH measured the type-narrowable surface as empty *for the current generator* — one relation-input type serves positions with opposite dispositions, so removing a key would forbid shapes that execute. Roughly six of the 21 are permanent AND statically decidable (the compound junction edge, the `updateMany` relation writes ×2, the supplier×supplier pairs, the unnameable-unique `skipDuplicates`) and could in principle become compile errors if the generator emitted position-aware inputs — at an instantiation-depth cost the estate has already measured once (34s → 172s for three guarded clauses). That measurement is proposed, not done.
