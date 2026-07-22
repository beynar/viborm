import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  constructRoutedOperation,
  setV1FallbackDisabled,
} from "../../src/query-engine-v2/routing";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";
import { manyToManySchema } from "../fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";
import { operationFragmentSchema } from "./create-nested-upsert-behavior";
import {
  FALLBACK_OFF_RESIDUAL,
  FALLBACK_OFF_RESIDUAL_COUNT,
} from "./fallback-off-residual";

/**
 * The decline-surface gate (P6-prerequisite 2, the P6-rerun probe made a committed
 * invariant). The two blocked P6 attempts failed because family-level assertions
 * (route-inventory: "every family is in ROUTED_OPERATIONS") cannot see SHAPE-level
 * declines: a family constructs on V2 for the shapes V2 owns, and hands whole trees
 * to V1 for the shapes it declines with {@link UnsupportedOperationError}. A large
 * subset of those declines are ACCEPT-AND-EXECUTE shapes V1 runs correctly today —
 * reachable behavior living behind the router's V1 fallback arm. P6's deletion
 * premise ("no reachable behavior lives behind the fallback") is therefore an
 * invariant about the decline surface, and this gate machine-checks it.
 *
 * The whole file runs with the V1 fallback DISABLED ({@link setV1FallbackDisabled}
 * — inert in production, engaged only here): a V2 decline RE-THROWS instead of
 * routing to V1, so any shape that secretly depended on the fallback surfaces as a
 * hard failure rather than silently passing through V1.
 *
 * Two halves, both machine-checked:
 *
 *  1. **The absorbed slice carries NO fallback (must pass).** Every create shape V2
 *     owns — including the newly-absorbed child-held one-to-one `create` — executes
 *     end-to-end on V2 with the fallback OFF and persists the correct state. This is
 *     P6's premise proven for the slice it holds. FALSIFY it by re-introducing a
 *     decline for a listed shape (e.g. narrowing the child-held type guard back to
 *     one-to-many only): the corresponding test then throws instead of persisting.
 *
 *  2. **The reachable residual STILL lives behind the fallback (P6 not yet met).**
 *     {@link FALLBACK_OFF_RESIDUAL} (tests/query-engine-v2/fallback-off-residual.ts)
 *     is the MEASURED accept-and-execute + reject-parity decline surface: 31
 *     nested-write-conformance scenarios (43 at T3 start; −1 T3-r2 family F; −11 T3a
 *     family A) whose whole tree V2 declines with the fallback OFF, across the
 *     remaining decline families (parent-held to-one update with nested-relation
 *     TARGET data — the 2 unabsorbed family-A shapes; nested-relation-in-nested-
 *     update; m2m nested-create/update-with-relations; top-level upsert with nested
 *     arms; nested-create-under-update / D4; connectOrCreate create-arm depth;
 *     to-many upsert identity). This CORRECTS the census the gate
 *     carried through T1/T2 — a curated three-then-one to-one pin list that hid the
 *     true surface (the T2 "theater replay" lesson: the census is a run of the FULL
 *     conformance suite fallback-off, not a hand-maintained list). The bidirectional
 *     machine-check is the `VIBORM_FALLBACK_OFF=1` census harness in the conformance
 *     file, now part of `pnpm test:gates`: a pinned scenario MUST decline on both
 *     substrates; a non-pinned one MUST run natively on V2. Below, this gate pins
 *     the census SIZE (so no entry can be silently trimmed) and re-proves one
 *     representative construct-time decline. **P6 may bulk-delete V1's runtime only
 *     when this set is EMPTY. It is not: 31 shapes remain, V1 is NOT deletable.**
 *     The day a family is absorbed, its entries leave FALLBACK_OFF_RESIDUAL, the
 *     count drops by the family size, and those scenarios must then pass
 *     fallback-off natively — both this gate and the conformance census move
 *     together, or the run is red.
 */

// The absorbed create decline surface is exercised end-to-end below. The residual
// is pinned by construction (no I/O needed — a decline is observable at construct
// time). A minimal engine, mirroring route-inventory.test.ts's `pgEngine`.
function pgEngine(schema: Record<string, Model<any>>): QueryEngine {
  hydrateSchemaNames(schema);
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(
    new PGliteDriver({ client: new PGlite() }),
    createModelRegistry(schema, schemas)
  );
}

async function freshClient(schema: Record<string, Model<any>>) {
  const client = createClient({
    schema,
    driver: new PGliteDriver({ client: new PGlite() }),
  });
  await push(client as never, { force: true } as never);
  return client as any;
}

let previous = false;
beforeAll(() => {
  previous = setV1FallbackDisabled(true);
});
afterAll(() => {
  setV1FallbackDisabled(previous);
});

const opf = operationFragmentSchema;
const nb = nestedWriteBehaviorSchema;
const m2m = manyToManySchema;

// Two parent-held to-one relations on one record, both referencing `account` —
// the sibling-coupling witness the P6-prereq-2 incident lives in. Absorbed in T1
// (TO-ONE.md), so the create-then-connect scenario now executes on V2 with the
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

describe("decline-surface gate: absorbed create shapes carry NO fallback (P6 premise, absorbed slice)", () => {
  test("root scalar create executes on V2 (fallback off)", async () => {
    const c = await freshClient(opf);
    const created = await c.user.create({ data: { name: "root" } });
    expect(created).toMatchObject({ name: "root" });
    await c.$disconnect();
  });

  test("nested child-held to-many create executes on V2 (fallback off)", async () => {
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
    await c.$disconnect();
  });

  // The falsification target: this is the shape absorbed in P6-prereq-2. Narrowing
  // the child-held type guard back to one-to-many only makes THIS test throw an
  // UnsupportedOperationError (the fallback that would have hidden it is OFF).
  test("child-held ONE-TO-ONE create executes on V2 (fallback off) — the newly absorbed shape", async () => {
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
    await c.$disconnect();
  });

  test("nested createMany under create executes on V2 (fallback off)", async () => {
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
    await c.$disconnect();
  });

  test("parent-held to-one connect executes on V2 (fallback off)", async () => {
    const c = await freshClient(opf);
    await c.user.create({ data: { name: "owner" } });
    const post = await c.post.create({
      data: { id: 5, title: "t5", slug: "s5", author: { connect: { id: 1 } } },
      select: { id: true, userId: true },
    });
    expect(post).toEqual({ id: 5, userId: 1 });
    await c.$disconnect();
  });

  // T1: the parent-held to-one `create` family (the before-parent-write ordering),
  // absorbed under create roots. It executes end-to-end on V2 with the fallback
  // OFF — the target INSERTs first, its identity Ref'd into the record FK.
  // Re-narrowing the parent-held type guard back to connect-only makes this throw.
  test("parent-held to-one create executes on V2 (fallback off) — the newly absorbed shape", async () => {
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
    await c.$disconnect();
  });

  // T1: THE P6-prereq-2 KILL-SIGNAL INCIDENT, now on V2 with the fallback OFF. A
  // sibling `connect` observing the before-parent `create` of the same target —
  // the construction-time coverage ledger resolves it with no probe. Absorbing
  // parent-held create standalone broke exactly this; disabling the ledger (or
  // re-narrowing the type guard) makes this throw instead of persisting.
  test("INCIDENT: sibling create-then-connect executes on V2 (fallback off)", async () => {
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
    await c.$disconnect();
  });

  test("M2M create-through-junction executes on V2 (fallback off)", async () => {
    const c = await freshClient(m2m);
    await c.post.create({
      data: { id: "p1", title: "t", tags: { create: { id: "t1", name: "x" } } },
    });
    const tags = await c.tag.findMany();
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ id: "t1", name: "x" });
    await c.$disconnect();
  });

  // T2 (TO-ONE.md §7): the parent-held to-one `connectOrCreate` under UPDATE — a
  // before-root target INSERT (missing arm) or existence guard (found arm) whose
  // FK the root parent UPDATE absorbs. Was residual entry 1; executes on V2 with
  // the fallback OFF. Re-narrowing the parent-held update guard makes this throw.
  test("parent-held connectOrCreate under update executes on V2 (fallback off) — absorbed", async () => {
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
    await c.$disconnect();
  });

  // T2 (TO-ONE.md §7): the inverse-side (child-held) to-one `update` — a correlated
  // targeted update whose locator is the FK correlation alone (no unique selector).
  // Was residual entry 2; executes on V2 with the fallback OFF. Re-narrowing the
  // child-held type guard back to one-to-many only makes this throw.
  test("inverse-side to-one update executes on V2 (fallback off) — absorbed", async () => {
    const c = await freshClient(nb);
    await c.user.create({ data: { id: "u1", name: "a" } });
    await c.profile.create({ data: { id: "pr1", bio: "old", userId: "u1" } });
    await c.user.update({
      where: { id: "u1" },
      data: { profile: { update: { bio: "new" } } },
    });
    const profiles = await c.profile.findMany();
    expect(profiles).toEqual([{ id: "pr1", bio: "new", userId: "u1" }]);
    await c.$disconnect();
  });

  // T3-r2 (TO-ONE.md §7.2, family F): the inverse-side (child-held) to-one `upsert`
  // — a correlated locate (WHERE fk = parent, no unique selector). Both arms and a
  // second-parent correlation witness: u2's profile must be untouched by u1's
  // upsert (create arm), and by u1's second upsert (update arm). Was residual
  // family F; executes on V2 with the fallback OFF. Re-narrowing the inverse-side
  // upsert case back to the default V1-route makes this throw.
  test("inverse-side to-one upsert executes on V2 (fallback off) — absorbed", async () => {
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
    await c.$disconnect();
  });

  // T3a (TO-ONE.md §7.2, family A): the FK-holder-side (parent-held) to-one `update`
  // — mutate the REFERENCED target located through the parent's own FK column, at its
  // FINAL value (a same-root scalar rebind moves the target). MULTI-PARENT WITNESS: a
  // second post pointing at a different author must be untouched. Re-narrowing the
  // parent-held `update` case to the V1 route makes this throw.
  test("parent-held to-one update executes on V2 (fallback off) — absorbed", async () => {
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
    await c.$disconnect();
  });

  // T3a (family A): the FK-holder-side to-one `delete: true` — NULL the parent FK,
  // then delete the referenced target (V1's null-then-delete). MULTI-PARENT WITNESS:
  // a second post's author must survive. Re-narrowing the case makes this throw.
  test("parent-held to-one delete executes on V2 (fallback off) — absorbed", async () => {
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
    await c.$disconnect();
  });

  // T3a (family A): the FK-holder-side to-one `upsert` — absent → INSERT the target
  // and rebind the parent FK to it; found → UPDATE the located target. MULTI-PARENT
  // WITNESS: a second post's author must survive both arms. Re-narrowing the case
  // makes this throw.
  test("parent-held to-one upsert executes on V2 (fallback off) — absorbed", async () => {
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
    await c.$disconnect();
  });
});

// T3b-1 (TO-ONE.md §7.7, family B + A-remainder — mechanism 1, update-arm literal-
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

describe("decline-surface gate: absorbed nested-relation-in-update shapes carry NO fallback (T3b-1 family B + A-remainder)", () => {
  // Family B — the PK-transition + self-m2m CASCADE witness at the DEEPEST mutated
  // level (the strongest reorder/cascade proof, per §7.7). The nested child update
  // sets id 1→4 AND connects friend 2; the friend junction row is written against the
  // located id (1) and the child UPDATE's ON UPDATE CASCADE carries `friendSourceId`
  // to 4. MULTI-PARENT WITNESS: node 3's own friend edge (sourceId 3) is untouched.
  // Re-narrowing RelationWritePart's recursion makes this throw.
  test("family B: child-held nested update — PK transition + self-m2m cascade (fallback off)", async () => {
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
    await c.$disconnect();
  });

  // Family A-remainder — a parent-held `update` whose located target's data carries a
  // nested relation write (`container: { update: { nodes: { update } } }`). The
  // container is located at the parent's FINAL FK (rebind 10→20), and its own child
  // Parts correlate to its captured PK by a planned source. MULTI-PARENT WITNESS:
  // container 10 keeps node 9. Re-narrowing `parentHeldUpdateData` makes this throw.
  test("family A-remainder: parent-held update with a nested to-many update target (fallback off)", async () => {
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
    await c.$disconnect();
  });

  // Family B + A-remainder — the 3-level chain: `children.update.partnerOf.create`
  // (inverse-to-one create under a literal parent) AND
  // `container.update.nodes.update.partnerOf.upsert` (parent-held → to-many update →
  // inverse-to-one upsert, the deepest mutated level). Re-narrowing any layer throws.
  test("deep chain: children.partnerOf.create + container.nodes.update.partnerOf.upsert (fallback off)", async () => {
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
    await c.$disconnect();
  });
});

// ---------------------------------------------------------------------------
// The reachable accept-and-execute + reject-parity residual: shapes V1 runs (or
// V1-rejects with its own typed message) today but V2 still DECLINES, so the
// router hands their whole tree to V1. The AUTHORITATIVE census is
// {@link FALLBACK_OFF_RESIDUAL} (tests/query-engine-v2/fallback-off-residual.ts):
// 43 nested-write-conformance scenarios, MEASURED by running the FULL conformance
// suite with `VIBORM_FALLBACK_OFF=1` (that run — the bidirectional machine-check
// that these EXACTLY are the fallback carriers — is part of `pnpm test:gates`).
// **P6 may delete V1 only when FALLBACK_OFF_RESIDUAL is EMPTY.** It is not.
//
// This replaces the curated single-entry `FALLBACK_CARRYING_RESIDUAL` the gate
// carried through T1/T2, which understated the surface as "exactly one entry"
// while the measured truth was 43 across eight families (the T2 theater-replay
// lesson). Below: pin the census size (no silent trimming) and re-prove one
// representative shape declines at CONSTRUCTION (no I/O — a decline is observable
// before any effect), so the gate keeps a fast construct-time tripwire alongside
// the full conformance census.
// ---------------------------------------------------------------------------
const REPRESENTATIVE_CONSTRUCT_DECLINE = {
  // A parent-held (FK-holder-side) to-one `update` whose located target's DATA carries
  // a nested CREATE (`author: { update: { posts: { create } } }`). T3b-1 absorbed the
  // update-arm literal-parent recursion (a parent-held update's target builds its own
  // child Parts), but a create/createMany leaf under a parent-held (`planned`) target
  // resolves its FK at construction and so needs a compile-time literal parent it does
  // not have here — a documented narrower boundary that still routes the whole tree to
  // V1 (create-context depth is a later mechanism). A construct-time probe: no seed,
  // no execution.
  label:
    "parent-held to-one update whose target creates under a parent-held (planned) id",
  schema: nb as Record<string, Model<any>>,
  operation: "update",
  args: {
    where: { id: "po1" },
    data: {
      author: { update: { posts: { create: { id: "po2", title: "t" } } } },
    },
  } as Record<string, unknown>,
  rootModel: nb.post as Model<any>,
} as const;

describe("decline-surface gate: the reachable residual STILL lives behind the fallback (P6 blocked)", () => {
  test("the fallback-carrying residual is NON-EMPTY — V1 is not deletable", () => {
    // The census is a fact, not prose. When this reaches 0, P6 may delete V1.
    expect(FALLBACK_OFF_RESIDUAL.size).toBeGreaterThan(0);
  });

  test("the census is the MEASURED surface (8), not a curated pin list", () => {
    // Guards against silently trimming the census without a real absorption: the
    // set and its declared count must agree, and the count is the running measurement.
    // Absorbing a family (or a coherent slice) drops BOTH by the same amount (and its
    // scenarios must then pass the fallback-off conformance run).
    expect(FALLBACK_OFF_RESIDUAL.size).toBe(FALLBACK_OFF_RESIDUAL_COUNT);
    // 43 (T3) → 42 (T3-r2 family F) → 31 (T3a absorbed 11 of family A's 13) → 25
    // (T3b-1 absorbed the 6 child-held family-B nested-relation-in-update shapes) →
    // 21 (T3b-1 extended mechanism 1 to the parent-held `update` arm: family B's 2
    // membership-root shapes + family A-remainder's 2) → 11 (T3b-2 absorbed family C:
    // the 10 m2m-junction-target-carrying-relations shapes, mechanism 2 create-arm /
    // mechanism 1 update-arm reuse) → 9 (T3b-2 absorbed family E: the 2 nested-create-
    // under-update shapes incl. D4's rewritten-non-PK-reference threading) → 8 (T3b-2
    // absorbed family G: the connectOrCreate create-arm one-level-deeper create,
    // mechanism 3). The remaining 8 are T3c's surface (family D ×7 + family H ×1).
    expect(FALLBACK_OFF_RESIDUAL_COUNT).toBe(8);
  });

  test(`still declines at construction (routes to V1): ${REPRESENTATIVE_CONSTRUCT_DECLINE.label}`, () => {
    const shape = REPRESENTATIVE_CONSTRUCT_DECLINE;
    const engine = pgEngine(shape.schema);
    // Fallback disabled: a decline RE-THROWS, so a shape that still routes to V1
    // surfaces its UnsupportedOperationError here rather than returning undefined.
    expect(() =>
      constructRoutedOperation(
        engine,
        shape.rootModel,
        shape.operation,
        shape.args
      )
    ).toThrow(UnsupportedOperationError);
  });
});
