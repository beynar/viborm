import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { operationFragmentSchema } from "@tests/contracts/engine/write/create-nested-upsert-behavior";
import { depthSeamSchema } from "@tests/contracts/engine/write/depth-seam-behavior";
import { producedIdentitySchema } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { manyToManySchema } from "@tests/fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import { describe, expect, test } from "vitest";

/**
 * The decline-surface gate (P6). With V1 deleted, the single engine either
 * constructs a payload's whole tree or declines it with an
 * {@link UnsupportedOperationError} — there is no fallback to catch that decline.
 * This gate holds both sides of that boundary:
 *
 *  1. **The absorbed write surface executes end-to-end on the one engine.** Every
 *     shape the migration absorbed — root/nested/child-held/parent-held create,
 *     inverse-side and FK-holder-side to-one update/delete/upsert, m2m through the
 *     junction, and the deepest nested-relation-in-update chains — persists the
 *     correct state. FALSIFY by re-introducing a decline for a listed shape (e.g.
 *     narrowing a type guard): the corresponding test then throws instead of
 *     persisting.
 *
 *  2. **A documented semantic boundary still declines.** On batch-only execution,
 *     a parent-held target write cannot precede a skippable createMany root: if the
 *     root skips, that target would be stranded. The public payload below must fail
 *     with `UnsupportedOperationError` before either row is written.
 */

async function freshClient(schema: Record<string, Model<any>>) {
  const family = (() => {
    if (schema === opf) return getOperationFragmentFamily();
    if (schema === nb) return getNestedWriteFamily();
    if (schema === m2m) return getManyToManyFamily();
    if (schema === seam) return getDepthSeamFamily();
    if (schema === pi) return getProducedIdentityFamily();
    if (schema === t1CrossSchema) return getCrossFamily();
    if (schema === t3bMembershipSchema) return getMembershipFamily();
    if (schema === n5AdoptSchema) return getAdoptFamily();
    throw new Error("The decline-surface schema has no database family");
  })();
  await family.reset();
  const client = createClient({
    schema,
    driver: new PGliteDriver({ client: family.database }),
  });
  return client as any;
}

const opf = operationFragmentSchema;
const nb = nestedWriteBehaviorSchema;
const m2m = manyToManySchema;
const seam = depthSeamSchema;
const pi = producedIdentitySchema;
const getOperationFragmentFamily = usePGliteSchemaFamily(opf);
const getNestedWriteFamily = usePGliteSchemaFamily(nb);
const getManyToManyFamily = usePGliteSchemaFamily(m2m);
const getDepthSeamFamily = usePGliteSchemaFamily(seam);
const getProducedIdentityFamily = usePGliteSchemaFamily(pi);

// Two parent-held to-one relations on one record, both referencing `account` —
// the sibling-coupling witness the P6-prereq-2 incident lives in. Absorbed in T1
// so the create-then-connect scenario now executes on V2 with the
// fallback OFF (its own before-parent coverage ledger resolves the connect).
const t1CrossSchema = (() => {
  const account = s
    .model({
      id: s.int().id(),
      label: s.string(),
      primaryRecords: s.oneToMany(() => record).name("primary"),
      secondaryRecords: s.oneToMany(() => record).name("secondary"),
    })
    .map("decline_gate_cross_accounts");
  const record = s
    .model({
      id: s.int().id(),
      primaryId: s.int().nullable(),
      secondaryId: s.int().nullable(),
      primary: s
        .manyToOne(() => account)
        .fields("primaryId")
        .references("id")
        .name("primary")
        .optional(),
      secondary: s
        .manyToOne(() => account)
        .fields("secondaryId")
        .references("id")
        .name("secondary")
        .optional(),
    })
    .map("decline_gate_cross_records");
  return { account, record };
})();
const getCrossFamily = usePGliteSchemaFamily(t1CrossSchema);

describe("decline-surface gate: absorbed create shapes execute on the one engine", () => {
  test("root scalar create executes on production engine", async () => {
    const c = await freshClient(opf);
    const created = await c.user.create({ data: { name: "root" } });
    expect(created).toMatchObject({ name: "root" });
  });

  test("nested child-held to-many create executes on production engine", async () => {
    const c = await freshClient(opf);
    await c.user.create({
      data: {
        name: "with-posts",
        posts: {
          create: [
            { id: 1, title: "t1", slug: "s1" },
            { id: 2, title: "t2", slug: "s2" },
          ],
        },
      },
    });
    const posts = await c.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((p: { userId: number }) => p.userId)).toEqual([1, 1]);
  });

  // The falsification target: this is the shape absorbed in P6-prereq-2. Narrowing
  // the child-held type guard back to one-to-many only makes THIS test throw an
  // UnsupportedOperationError (the fallback that would have hidden it is OFF).
  test("child-held ONE-TO-ONE create executes on production engine — the newly absorbed shape", async () => {
    const c = await freshClient(nb);
    await c.user.create({
      data: {
        id: "u1",
        name: "a",
        profile: { create: { id: "pr1", bio: "b" } },
      },
    });
    const profiles = await c.profile.findMany();
    expect(profiles).toEqual([{ id: "pr1", bio: "b", userId: "u1" }]);
  });

  test("nested createMany under create executes on production engine", async () => {
    const c = await freshClient(opf);
    await c.user.create({
      data: {
        name: "cm",
        posts: {
          createMany: {
            data: [
              { id: 3, title: "t3", slug: "s3" },
              { id: 4, title: "t4", slug: "s4" },
            ],
          },
        },
      },
    });
    const posts = await c.post.findMany({ orderBy: { id: "asc" } });
    expect(posts).toHaveLength(2);
  });

  test("parent-held to-one connect executes on production engine", async () => {
    const c = await freshClient(opf);
    await c.user.create({ data: { name: "owner" } });
    const post = await c.post.create({
      data: { id: 5, title: "t5", slug: "s5", author: { connect: { id: 1 } } },
      select: { id: true, userId: true },
    });
    expect(post).toEqual({ id: 5, userId: 1 });
  });

  // T1: the parent-held to-one `create` family (the before-parent-write ordering),
  // absorbed under create roots. It executes end-to-end on V2 with the fallback
  // OFF — the target INSERTs first, its identity Ref'd into the record FK.
  // Re-narrowing the parent-held type guard back to connect-only makes this throw.
  test("parent-held to-one create executes on production engine — the newly absorbed shape", async () => {
    const c = await freshClient(opf);
    const post = await c.post.create({
      data: {
        id: 6,
        title: "t6",
        slug: "s6",
        author: { create: { name: "x" } },
      },
      select: { id: true, userId: true },
    });
    expect(post).toEqual({ id: 6, userId: 1 });
  });

  // T1: THE P6-prereq-2 KILL-SIGNAL INCIDENT, now on V2 with the fallback OFF. A
  // sibling `connect` observing the before-parent `create` of the same target —
  // the construction-time coverage ledger resolves it with no probe. Absorbing
  // parent-held create standalone broke exactly this; disabling the ledger (or
  // re-narrowing the type guard) makes this throw instead of persisting.
  test("INCIDENT: sibling create-then-connect executes on production engine", async () => {
    const c = await freshClient(t1CrossSchema);
    await c.record.create({
      data: {
        id: 1,
        primary: { create: { id: 2, label: "created" } },
        secondary: { connect: { id: 2 } },
      },
    });
    const records = await c.record.findMany();
    expect(records).toEqual([{ id: 1, primaryId: 2, secondaryId: 2 }]);
  });

  test("M2M create-through-junction executes on production engine", async () => {
    const c = await freshClient(m2m);
    await c.post.create({
      data: { id: "p1", title: "t", tags: { create: { id: "t1", name: "x" } } },
    });
    const tags = await c.tag.findMany();
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ id: "t1", name: "x" });
  });

  // T2: the parent-held to-one `connectOrCreate` under UPDATE — a
  // before-root target INSERT (missing arm) or existence guard (found arm) whose
  // FK the root parent UPDATE absorbs. Was residual entry 1; executes on V2 with
  // the fallback OFF. Re-narrowing the parent-held update guard makes this throw.
  test("parent-held connectOrCreate under update executes on production engine — absorbed", async () => {
    const c = await freshClient(opf);
    await c.user.create({ data: { name: "owner" } }); // id=1
    await c.post.create({ data: { id: 6, title: "t6", slug: "s6" } });
    const updated = await c.post.update({
      where: { id: 6 },
      data: {
        author: {
          connectOrCreate: { where: { id: 1 }, create: { name: "x" } },
        },
      },
      select: { id: true, userId: true },
    });
    expect(updated).toEqual({ id: 6, userId: 1 });
  });

  // T2: the inverse-side (child-held) to-one `update` — a correlated
  // targeted update whose locator is the FK correlation alone (no unique selector).
  // Was residual entry 2; executes on V2 with the fallback OFF. Re-narrowing the
  // child-held type guard back to one-to-many only makes this throw.
  test("inverse-side to-one update executes on production engine — absorbed", async () => {
    const c = await freshClient(nb);
    await c.user.create({ data: { id: "u1", name: "a" } });
    await c.profile.create({ data: { id: "pr1", bio: "old", userId: "u1" } });
    await c.user.update({
      where: { id: "u1" },
      data: { profile: { update: { bio: "new" } } },
    });
    const profiles = await c.profile.findMany();
    expect(profiles).toEqual([{ id: "pr1", bio: "new", userId: "u1" }]);
  });

  // N2-U1: the inverse-side (child-held) to-one `create` — the mainstream Prisma shape,
  // `user.update({ where, data: { profile: { create } } })`. It was the last write shape
  // on this relation that declined; it now executes on V2 with the fallback OFF, and the
  // OCCUPIED SLOT (a related row already present) errors instead of writing a second one
  // — the DB's 1:1 FK unique constraint, no pre-check probe. Restoring the
  // `does not support nested 'create' on the inverse-side to-one relation` refusal makes
  // the first half throw; removing the occupied-slot constraint makes the second half
  // silently persist two profiles.
  test("inverse-side to-one create executes on production engine — absorbed (N2-U1)", async () => {
    const c = await freshClient(nb);
    await c.user.create({ data: { id: "u1", name: "a" } });
    await c.user.update({
      where: { id: "u1" },
      data: { profile: { create: { id: "pr1", bio: "made" } } },
    });
    expect(await c.profile.findMany()).toEqual([
      { id: "pr1", bio: "made", userId: "u1" },
    ]);
    await expect(
      c.user.update({
        where: { id: "u1" },
        data: { profile: { create: { id: "pr2", bio: "second" } } },
      })
    ).rejects.toThrow();
    expect(await c.profile.findMany()).toEqual([
      { id: "pr1", bio: "made", userId: "u1" },
    ]);
  });

  // T3-r2, family F: the inverse-side (child-held) to-one `upsert`
  // — a correlated locate (WHERE fk = parent, no unique selector). Both arms and a
  // second-parent correlation witness: u2's profile must be untouched by u1's
  // upsert (create arm), and by u1's second upsert (update arm). Was residual
  // family F; executes on V2 with the fallback OFF. Re-narrowing the inverse-side
  // upsert case back to the default V1-route makes this throw.
  test("inverse-side to-one upsert executes on production engine — absorbed", async () => {
    const c = await freshClient(nb);
    await c.user.create({ data: { id: "u1", name: "a" } });
    // Correlation witness: a second parent with its own connected profile.
    await c.user.create({ data: { id: "u2", name: "b" } });
    await c.profile.create({
      data: { id: "pr2", bio: "witness", userId: "u2" },
    });

    // Absent arm: no profile correlated to u1 → create it (fk = u1).
    await c.user.update({
      where: { id: "u1" },
      data: {
        profile: {
          upsert: {
            create: { id: "pr1", bio: "created" },
            update: { bio: "x" },
          },
        },
      },
    });
    // Found arm: u1 now has a correlated profile → update it (create arm ignored).
    await c.user.update({
      where: { id: "u1" },
      data: {
        profile: {
          upsert: {
            create: { id: "pr-unused", bio: "nope" },
            update: { bio: "updated" },
          },
        },
      },
    });

    const profiles = await c.profile.findMany({ orderBy: { id: "asc" } });
    expect(profiles).toEqual([
      { id: "pr1", bio: "updated", userId: "u1" },
      // The witness parent's child is untouched — no cross-parent leak.
      { id: "pr2", bio: "witness", userId: "u2" },
    ]);
  });

  // T3a, family A: the FK-holder-side (parent-held) to-one `update`
  // — mutate the REFERENCED target located through the parent's own FK column, at its
  // FINAL value (a same-root scalar rebind moves the target). MULTI-PARENT WITNESS: a
  // second post pointing at a different author must be untouched. Re-narrowing the
  // parent-held `update` case to the V1 route makes this throw.
  test("parent-held to-one update executes on production engine — absorbed", async () => {
    const c = await freshClient(nb);
    await c.user.create({ data: { id: "u1", name: "Original" } });
    await c.user.create({ data: { id: "u2", name: "Final" } });
    await c.user.create({ data: { id: "uW", name: "Witness" } });
    await c.post.create({ data: { id: "po1", title: "t", userId: "u1" } });
    // Correlation witness: a second post held by a different author.
    await c.post.create({ data: { id: "poW", title: "w", userId: "uW" } });
    await c.post.update({
      where: { id: "po1" },
      // Rebind the FK AND update the referenced target: the arm must hit the FINAL
      // author (u2), never the located pre-rebind one (u1).
      data: { userId: "u2", author: { update: { name: "Updated" } } },
    });
    const users = await c.user.findMany({ orderBy: { id: "asc" } });
    expect(users).toEqual([
      { id: "u1", name: "Original" },
      { id: "u2", name: "Updated" },
      { id: "uW", name: "Witness" },
    ]);
    const posts = await c.post.findMany({ orderBy: { id: "asc" } });
    expect(posts).toEqual([
      { id: "po1", title: "t", userId: "u2" },
      { id: "poW", title: "w", userId: "uW" },
    ]);
  });

  // T3a (family A): the FK-holder-side to-one `delete: true` — NULL the parent FK,
  // then delete the referenced target (V1's null-then-delete). MULTI-PARENT WITNESS:
  // a second post's author must survive. Re-narrowing the case makes this throw.
  test("parent-held to-one delete executes on production engine — absorbed", async () => {
    const c = await freshClient(nb);
    await c.user.create({ data: { id: "u1", name: "target" } });
    await c.user.create({ data: { id: "uW", name: "Witness" } });
    await c.post.create({ data: { id: "po1", title: "t", userId: "u1" } });
    await c.post.create({ data: { id: "poW", title: "w", userId: "uW" } });
    await c.post.update({
      where: { id: "po1" },
      data: { author: { delete: true } },
    });
    const users = await c.user.findMany({ orderBy: { id: "asc" } });
    expect(users).toEqual([{ id: "uW", name: "Witness" }]);
    const posts = await c.post.findMany({ orderBy: { id: "asc" } });
    expect(posts).toEqual([
      { id: "po1", title: "t", userId: null },
      { id: "poW", title: "w", userId: "uW" },
    ]);
  });

  // T3a (family A): the FK-holder-side to-one `upsert` — absent → INSERT the target
  // and rebind the parent FK to it; found → UPDATE the located target. MULTI-PARENT
  // WITNESS: a second post's author must survive both arms. Re-narrowing the case
  // makes this throw.
  test("parent-held to-one upsert executes on production engine — absorbed", async () => {
    const c = await freshClient(nb);
    await c.user.create({ data: { id: "uW", name: "Witness" } });
    await c.post.create({ data: { id: "po1", title: "t", userId: null } });
    await c.post.create({ data: { id: "poW", title: "w", userId: "uW" } });
    // Absent arm: po1 has no author → create u1 and bind it.
    await c.post.update({
      where: { id: "po1" },
      data: {
        author: {
          upsert: {
            create: { id: "u1", name: "Created" },
            update: { name: "x" },
          },
        },
      },
    });
    // Found arm: po1 now points at u1 → update it (create arm ignored).
    await c.post.update({
      where: { id: "po1" },
      data: {
        author: {
          upsert: {
            create: { id: "u-unused", name: "no" },
            update: { name: "Updated" },
          },
        },
      },
    });
    const users = await c.user.findMany({ orderBy: { id: "asc" } });
    expect(users).toEqual([
      { id: "u1", name: "Updated" },
      { id: "uW", name: "Witness" },
    ]);
    const posts = await c.post.findMany({ orderBy: { id: "asc" } });
    expect(posts).toEqual([
      { id: "po1", title: "t", userId: "u1" },
      { id: "poW", title: "w", userId: "uW" },
    ]);
  });
});

// T3b-1 (family B + A-remainder — mechanism 1, update-arm literal-
// parent recursion). A self-referential membership schema: `children` (self one-to-
// many), `friends` (self m2m, its junction FK ON UPDATE CASCADE by default), and
// `container` (parent-held to-one). The witnesses below execute on V2 with the
// fallback OFF — re-narrowing the recursion (RelationWritePart's `interpretChildParts`
// throwing on relations, or `parentHeldUpdateData` throwing) makes them throw instead.
const t3bMembershipSchema = (() => {
  const container = s
    .model({ id: s.int().id(), nodes: s.oneToMany(() => node) })
    .map("t3b_gate_containers");
  const node: ReturnType<typeof s.model> = s
    .model({
      id: s.int().id(),
      label: s.string(),
      containerId: s.int().nullable(),
      container: s
        .manyToOne(() => container)
        .fields("containerId")
        .references("id")
        .optional(),
      parentId: s.int().nullable(),
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .name("t3bParent")
        .optional(),
      children: s.oneToMany(() => node).name("t3bParent"),
      friends: s
        .manyToMany(() => node)
        .name("t3bFriends")
        .A("friendSourceId")
        .B("friendTargetId"),
      friendedBy: s.manyToMany(() => node).name("t3bFriends"),
      partnerId: s.int().unique().nullable(),
      partner: s
        .oneToOne(() => node)
        .fields("partnerId")
        .references("id")
        .name("t3bPartner")
        .optional(),
      partnerOf: s
        .oneToOne(() => node)
        .name("t3bPartner")
        .optional(),
    })
    .map("t3b_gate_nodes");
  return { container, node };
})();
const getMembershipFamily = usePGliteSchemaFamily(t3bMembershipSchema);

describe("decline-surface gate: absorbed nested-relation-in-update shapes execute on the one engine (family B + A-remainder)", () => {
  // Family B — the PK-transition + self-m2m CASCADE witness at the DEEPEST mutated
  // level (the strongest reorder/cascade proof, per §7.7). The nested child update
  // sets id 1→4 AND connects friend 2; the friend junction row is written against the
  // located id (1) and the child UPDATE's ON UPDATE CASCADE carries `friendSourceId`
  // to 4. MULTI-PARENT WITNESS: node 3's own friend edge (sourceId 3) is untouched.
  // Re-narrowing RelationWritePart's recursion makes this throw.
  test("family B: child-held nested update — PK transition + self-m2m cascade", async () => {
    const c = await freshClient(t3bMembershipSchema);
    await c.node.create({ data: { id: 10, label: "root" } });
    await c.node.create({ data: { id: 2, label: "two" } });
    await c.node.create({ data: { id: 1, label: "one", parentId: 10 } });
    await c.node.create({ data: { id: 3, label: "three", parentId: 10 } });
    await c.node.update({
      where: { id: 3 },
      data: { friends: { connect: { id: 2 } } },
    });
    await c.node.update({
      where: { id: 10 },
      data: {
        children: {
          update: [
            {
              where: { id: 1 },
              data: { id: 4, friends: { connect: { id: 2 } } },
            },
            {
              where: { id: 3 },
              data: {
                friends: {
                  update: { where: { id: 2 }, data: { label: "after" } },
                },
              },
            },
          ],
        },
      },
    });
    const nodes = await c.node.findMany({
      orderBy: { id: "asc" },
      include: { friends: { orderBy: { id: "asc" } } },
    });
    const edges = nodes.flatMap(
      (n: { id: number; friends: { id: number }[] }) =>
        n.friends.map((f) => ({ sourceId: n.id, targetId: f.id }))
    );
    // The PK transition (1→4) cascaded to the friend junction: sourceId is the FINAL 4.
    expect(edges).toEqual([
      { sourceId: 3, targetId: 2 },
      { sourceId: 4, targetId: 2 },
    ]);
    expect(nodes.find((n: { id: number }) => n.id === 2)?.label).toBe("after");
  });

  // Family A-remainder — a parent-held `update` whose located target's data carries a
  // nested relation write (`container: { update: { nodes: { update } } }`). The
  // container is located at the parent's FINAL FK (rebind 10→20), and its own child
  // Parts correlate to its captured PK by a planned source. MULTI-PARENT WITNESS:
  // container 10 keeps node 9. Re-narrowing `parentHeldUpdateData` makes this throw.
  test("family A-remainder: parent-held update with a nested to-many update target", async () => {
    const c = await freshClient(t3bMembershipSchema);
    await c.container.create({ data: { id: 10 } });
    await c.container.create({ data: { id: 20 } });
    await c.node.create({ data: { id: 9, label: "nine", containerId: 10 } });
    await c.node.create({ data: { id: 1, label: "one", containerId: 10 } });
    await c.node.create({ data: { id: 3, label: "three", containerId: 20 } });
    await c.node.update({
      where: { id: 1 },
      data: {
        containerId: 20,
        container: {
          update: {
            nodes: { update: { where: { id: 3 }, data: { label: "after" } } },
          },
        },
      },
    });
    const nodes = await c.node.findMany({ orderBy: { id: "asc" } });
    expect(
      nodes.map((n: { id: number; label: string }) => [n.id, n.label])
    ).toEqual([
      [1, "one"],
      [3, "after"],
      [9, "nine"],
    ]);
    // Witness: node 1 rebound to 20; node 9 stayed in 10; node 3 updated in 20.
    expect(
      nodes.map((n: { id: number; containerId: number | null }) => [
        n.id,
        n.containerId,
      ])
    ).toEqual([
      [1, 20],
      [3, 20],
      [9, 10],
    ]);
  });

  // Family B + A-remainder — the 3-level chain: `children.update.partnerOf.create`
  // (inverse-to-one create under a literal parent) AND
  // `container.update.nodes.update.partnerOf.upsert` (parent-held → to-many update →
  // inverse-to-one upsert, the deepest mutated level). Re-narrowing any layer throws.
  test("deep chain: children.partnerOf.create + container.nodes.update.partnerOf.upsert", async () => {
    const c = await freshClient(t3bMembershipSchema);
    await c.container.create({ data: { id: 10 } });
    await c.node.create({ data: { id: 9, label: "nine", containerId: 10 } });
    await c.node.create({
      data: { id: 1, label: "one", containerId: 10, parentId: 9 },
    });
    await c.node.create({ data: { id: 4, label: "four", containerId: 10 } });
    await c.node.update({
      where: { id: 9 },
      data: {
        children: {
          update: {
            where: { id: 1 },
            data: { partnerOf: { create: { id: 2, label: "two" } } },
          },
        },
        container: {
          update: {
            nodes: {
              update: {
                where: { id: 4 },
                data: {
                  partnerOf: {
                    upsert: {
                      create: { id: 3, label: "three" },
                      update: { label: "updated" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const nodes = await c.node.findMany({ orderBy: { id: "asc" } });
    const partners = nodes.map(
      (n: { id: number; partnerId: number | null }) => [n.id, n.partnerId]
    );
    // node 2 (partnerOf.create) points at node 1; node 3 (partnerOf.upsert create arm)
    // points at node 4 — the exact cross-scope disjoint final state.
    expect(partners).toEqual([
      [1, null],
      [2, 1],
      [3, 4],
      [4, null],
      [9, null],
    ]);
  });
});

// ---------------------------------------------------------------------------
// N1 — the located-parent Ref joins the absorbed surface. A child-held nested
// create under an update located by a NON-PK unique used to decline (no
// compile-time literal held the referenced column); it now reads that column from
// the located row. This is the gate's own side-1 witness for the family: FALSIFY
// by restoring the literal-only requirement in `resolveCreateParent` — the update
// then throws instead of persisting, and the second assertion (the wrong-row
// decoy keeps nothing) is what catches a resolution that reads the value from
// somewhere other than the located row.
// ---------------------------------------------------------------------------
describe("decline-surface gate: the located-parent Ref executes on the one engine (N1)", () => {
  test("nested create under an update located by a non-PK unique", async () => {
    const c = await freshClient(nb as Record<string, Model<any>>);
    // `tag.name` is the unique the update locates by; `postTag.tagId` references
    // `tag.id`, which no literal in the payload holds. The decoy is seeded first.
    await c.tag.create({ data: { id: "t-decoy", name: "decoy" } });
    await c.tag.create({ data: { id: "t-target", name: "ref" } });
    await c.post.create({ data: { id: "p1", title: "host", userId: null } });
    await c.tag.update({
      where: { name: "ref" },
      data: { postTags: { create: { id: "j1", postId: "p1" } } },
    });
    const joins = await c.postTag.findMany({ orderBy: { id: "asc" } });
    expect(
      joins.map((j: { id: string; tagId: string }) => [j.id, j.tagId])
    ).toEqual([["j1", "t-target"]]);
  });
});

// ---------------------------------------------------------------------------
// N3 — the M2M completions join the absorbed surface. `createMany` was the last
// `RelationMutationKind` with no junction arm, and the junction `upsert`'s create arm
// refused a DB-generated target key. Both now execute; each test names the mutation
// that falsifies it.
// ---------------------------------------------------------------------------
describe("decline-surface gate: the M2M completions execute on the one engine (N3)", () => {
  // N3-U1: `createMany` THROUGH A JUNCTION, both roots. `buildJunctionParts`' `default:`
  // arm declined it as the last unhandled `RelationMutationKind`; it is now the `create`
  // slot per row (child INSERT then join row) with `skipDuplicates` riding each INSERT.
  // Re-adding a decline to the `createMany` arm makes both halves throw.
  test("M2M createMany-through-junction executes on production engine, under update AND create", async () => {
    const c = await freshClient(m2m);
    await c.post.create({ data: { id: "p1", title: "t" } });
    await c.post.update({
      where: { id: "p1" },
      data: {
        tags: {
          createMany: {
            data: [
              { id: "t1", name: "x" },
              { id: "t2", name: "y" },
            ],
          },
        },
      },
    });
    await c.post.create({
      data: {
        id: "p2",
        title: "t2",
        tags: { createMany: { data: [{ id: "t3", name: "z" }] } },
      },
    });
    const linked = await c.post.findMany({
      orderBy: { id: "asc" },
      include: { tags: { orderBy: { id: "asc" } } },
    });
    expect(
      linked.map((post: { id: string; tags: { id: string }[] }) => [
        post.id,
        post.tags.map((tag) => tag.id),
      ])
    ).toEqual([
      ["p1", ["t1", "t2"]],
      ["p2", ["t3"]],
    ]);
  });

  // N3-U2: the junction `upsert` create arm with a DB-GENERATED target key. Was an
  // `UnsupportedOperationError` ("requires the target primary key … in the create data")
  // because the arm's dedup ledger addressed the target by a literal; the join row rides
  // the produced `Ref`. N7-U-C deleted the ledger (its every reachable firing was a
  // wrong-row update — see the 40 -> 39 census entry), and with it the last reason the arm
  // needed any compile-time `where`: the arm now asks `resolveCreatePk`, the same resolver
  // `create` / `connectOrCreate` / `createMany` ask. Reinstating either the literal-only
  // requirement or the create-data-unique gate makes this throw.
  test("M2M upsert-through-junction with a generated create-arm PK executes on production engine", async () => {
    const c = await freshClient(m2m);
    const article = await c.article.create({ data: { title: "a" } });
    await c.article.update({
      where: { id: article.id },
      data: {
        labels: {
          upsert: {
            where: { name: "gen" },
            create: { name: "gen" },
            update: { name: "gen2" },
          },
        },
      },
    });
    const withLabels = await c.article.findUnique({
      where: { id: article.id },
      include: { labels: true },
    });
    expect(
      (withLabels?.labels ?? []).map((label: { name: string }) => label.name)
    ).toEqual(["gen"]);
  });
});

describe("decline-surface gate: the depth seams execute on the one engine (N4)", () => {
  // N4-U1: a nested `update` named by a NON-primary-key unique whose data carries deeper
  // relation writes. `RelationWritePart` declined it ("must locate the target by its
  // primary key"); the target's own correlated probe already captured that key, so the
  // deeper edges read it from there. Restoring the refusal makes this throw.
  test("a nested update named by a non-PK unique carries deeper writes", async () => {
    const c = await freshClient(seam);
    await c.workspace.create({ data: { id: 1, slug: "w" } });
    await c.project.create({
      data: { id: 10, code: "P-1", title: "t", workspaceId: 1 },
    });
    await c.workspace.update({
      where: { id: 1 },
      data: {
        projects: {
          update: {
            where: { code: "P-1" },
            data: {
              title: "edited",
              tasks: { create: { id: 100, label: "d" } },
            },
          },
        },
      },
    });
    const tasks = await c.task.findMany({});
    expect(
      tasks.map((t: { id: number; projectId: number }) => [t.id, t.projectId])
    ).toEqual([[100, 10]]);
  });

  // N4-U1 (junction): a junction `update` named by a NON-primary-key unique whose target
  // carries its own relation writes. The membership read already selects the target key.
  test("a junction update named by a non-PK unique carries deeper writes", async () => {
    const c = await freshClient(m2m);
    await c.post.create({ data: { id: "p1", title: "t" } });
    await c.post.create({ data: { id: "p2", title: "t2" } });
    await c.post.update({
      where: { id: "p1" },
      data: { tags: { create: { id: "t1", name: "x" } } },
    });
    await c.post.update({
      where: { id: "p1" },
      data: {
        tags: {
          update: {
            where: { name: "x" },
            data: { posts: { connect: { id: "p2" } } },
          },
        },
      },
    });
    const tag = await c.tag.findUnique({
      where: { id: "t1" },
      include: { posts: { orderBy: { id: "asc" } } },
    });
    expect((tag?.posts ?? []).map((p: { id: string }) => p.id)).toEqual([
      "p1",
      "p2",
    ]);
  });

  // U-E6.1: the UPSERT twin of the test above, and the shape this file's representative
  // decline used to be. Reinstating that refusal makes this throw — the other half of
  // this gate's bidirectional pin. The arm's update payload addresses the primary key
  // the slot's own membership probe captured, so a target named by `name` carries its
  // deeper edges exactly as the `update` kind's does.
  test("a junction upsert named by a non-PK unique carries deeper writes", async () => {
    const c = await freshClient(m2m);
    await c.post.create({ data: { id: "p1", title: "t" } });
    await c.post.create({ data: { id: "p2", title: "t2" } });
    await c.post.update({
      where: { id: "p1" },
      data: { tags: { create: { id: "t1", name: "x" } } },
    });
    await c.post.update({
      where: { id: "p1" },
      data: {
        tags: {
          upsert: {
            where: { name: "x" },
            create: { id: "t9", name: "x" },
            update: { posts: { connect: { id: "p2" } } },
          },
        },
      },
    });
    const tag = await c.tag.findUnique({
      where: { id: "t1" },
      include: { posts: { orderBy: { id: "asc" } } },
    });
    expect((tag?.posts ?? []).map((p: { id: string }) => p.id)).toEqual([
      "p1",
      "p2",
    ]);
    // The create arm never ran: the probe found the member.
    expect(await c.tag.count({ where: { id: "t9" } })).toBe(0);
  });

  // N4-U3: `createMany` under a parent-held (`planned`) target — an earlier
  // representative decline. Reinstating that refusal makes this throw.
  test("a createMany under a parent-held planned target executes on production engine", async () => {
    const c = await freshClient(nb);
    await c.user.create({ data: { id: "u1", name: "u" } });
    await c.post.create({ data: { id: "po1", title: "t", userId: "u1" } });
    await c.post.update({
      where: { id: "po1" },
      data: {
        author: {
          update: {
            posts: { createMany: { data: [{ id: "po2", title: "bulk" }] } },
          },
        },
      },
    });
    const posts = await c.post.findMany({ orderBy: { id: "asc" } });
    expect(
      posts.map((p: { id: string; userId: string | null }) => [p.id, p.userId])
    ).toEqual([
      ["po1", "u1"],
      ["po2", "u1"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// N5 — ORDERING joins the absorbed surface. The adopt family under a non-cascade
// referenced-PK transition was declined because every child edge was emitted BEFORE
// the root UPDATE, so an adopt could only bind the id the transition was vacating. The
// edge now binds the post-transition id and is emitted after that UPDATE.
// ---------------------------------------------------------------------------
const n5AdoptSchema = (() => {
  const shelf = s
    .model({
      id: s.int().id(),
      name: s.string(),
      books: s.oneToMany(() => book),
    })
    .map("n5_gate_shelves");
  const book = s
    .model({
      id: s.int().id(),
      title: s.string(),
      shelfId: s.int().nullable(),
      shelf: s
        .manyToOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .optional()
        .onUpdate("setNull"),
    })
    .map("n5_gate_books");
  return { shelf, book };
})();
const getAdoptFamily = usePGliteSchemaFamily(n5AdoptSchema);

describe("decline-surface gate: the adopt family under a PK transition executes on the one engine (N5)", () => {
  // N5-U1: the root moves its own primary key AND connects a child in one payload.
  // Restoring the A15 refusal (or emitting the adopt write before the root UPDATE)
  // makes this throw instead of persisting.
  test("connect under a non-cascade referenced-PK transition executes on production engine", async () => {
    const c = await freshClient(n5AdoptSchema as Record<string, Model<any>>);
    await c.shelf.create({ data: { id: 1, name: "target" } });
    await c.book.create({ data: { id: 10, title: "free", shelfId: null } });
    await c.shelf.update({
      where: { id: 1 },
      data: { id: 5, books: { connect: { id: 10 } } },
    });
    await expect(c.shelf.findMany({})).resolves.toEqual([
      { id: 5, name: "target" },
    ]);
    await expect(c.book.findMany({})).resolves.toEqual([
      { id: 10, title: "free", shelfId: 5 },
    ]);
  });
});

describe("decline-surface gate: the adopt family's create arm is a create subtree on the one engine (N4-U2 / N4-U4)", () => {
  // N4-U2: a nested `connectOrCreate` whose CREATE arm carries an m2m edge, a
  // before-parent to-one `create`, and a child-held `createMany` — three kinds that were
  // three separate refusals, all of them now the create root's ordinary surface. Restore
  // any of them (or take the create arm off the subtree) and this throws instead of
  // persisting.
  test("a create arm carrying m2m + parent-held to-one + createMany executes on production engine", async () => {
    const c = await freshClient(pi as Record<string, Model<any>>);
    await c.org.create({ data: { id: 1, slug: "o1" } });
    await c.label.create({ data: { id: 1, name: "l1" } });
    await c.org.update({
      where: { id: 1 },
      data: {
        teams: {
          connectOrCreate: {
            where: { code: "T-GATE" },
            create: {
              id: 5,
              code: "T-GATE",
              title: "gate",
              labels: { connect: [{ id: 1 }] },
              lead: { create: { id: 3, name: "gate-lead" } },
              tasks: { createMany: { data: [{ id: 7, label: "bulk" }] } },
            },
          },
        },
      },
    });
    await expect(c.team.findMany({})).resolves.toEqual([
      { id: 5, code: "T-GATE", title: "gate", orgId: 1, leadId: 3 },
    ]);
    await expect(c.task.findMany({})).resolves.toEqual([
      { id: 7, label: "bulk", teamId: 5, ownerId: null },
    ]);
  });

  // N4-U4: a shared-primary-key child create whose parent key the DATABASE generates.
  // The record's identity — and the terminal read that returns it — ride the same
  // backward `Ref` its own foreign key does, so the operation can name the row it wrote.
  test("a shared-primary-key create under a generated parent key executes on production engine", async () => {
    const c = await freshClient(pi as Record<string, Model<any>>);
    const created = await c.profile.create({
      data: {
        bio: "gate",
        account: { create: { email: "g@x", handle: "g", name: "g" } },
      },
    });
    const accounts = await c.account.findMany({});
    expect(accounts).toHaveLength(1);
    expect(created).toMatchObject({ accountId: accounts[0].id, bio: "gate" });
  });
});

// ---------------------------------------------------------------------------
// Construction now accepts every shape in this gate. The surviving boundary is
// execution-order semantics: on a batch-only route, a write before a skippable root
// would remain committed if the root skipped. The progressive preflight must decline
// that public payload before either operation row is written.
// ---------------------------------------------------------------------------
describe("decline-surface gate: the surviving progressive boundary declines typed", () => {
  test("a parent-held write before a skippable root refuses before effects", async () => {
    const family = getOperationFragmentFamily();
    await family.reset();
    const client = createClient({
      schema: opf,
      driver: new BatchOnlyPGliteDriver({ client: family.database }),
    });

    let caught: unknown;
    try {
      await client.post.createMany({
        data: [
          {
            id: 1,
            title: "skippable",
            slug: "skippable",
            author: { create: { id: 99, name: "must-not-land" } },
          },
        ],
        skipDuplicates: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnsupportedOperationError);
    if (!(caught instanceof UnsupportedOperationError)) throw caught;
    expect(caught.code).toBe("V8003");
    expect(caught.message).toBe(
      "Driver 'pglite' cannot execute this record series as committed segments because skipping root 'post.create' would leave prior effect 'user.create' committed."
    );
    await expect(client.user.findMany({})).resolves.toEqual([]);
    await expect(client.post.findMany({})).resolves.toEqual([]);
  });
});
