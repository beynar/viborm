import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * X1b COMBINED DEPTH STRESS — all four lifted mechanisms in ONE tree at >= 6 levels.
 *
 * update(r0) -> children.update(c1) -> children.create(n2) -> …create(n6) is a SEVEN-
 * level relation nesting (>= 6 deep), and at successive levels it exercises every X1b
 * mechanism at once:
 *   · MECHANISM 1 (fresh) + 2 — a parent-held to-one `tag: { create }` with a
 *     database-GENERATED PK (n2 and n5): the before-parent tag id folds into the fresh
 *     node's own FK column (a backward Ref at depth).
 *   · MECHANISM 4 — an M2M `labels` connect+create on n2, and an adopt `children:
 *     { connect }` reparenting a committed row onto n4 (fresh-parent global elision).
 *   · MECHANISM 3 — a `children.createMany({ skipDuplicates })` leaf under n6 whose
 *     duplicate PK is skipped.
 * plus the base X1 create-context depth (n2..n6, each fresh node the parent of the next).
 *
 * FIXED-EXPECTATION oracle: pinned transaction and batch state. The
 * WRONG-ROW witness spans every level — each node's parent is pinned to its IMMEDIATE
 * ancestor by name, so an off-by-one in ANY level's FK/produced-id threading diverges.
 * A disjoint witness subtree (w0) stays untouched.
 */

const schema = (() => {
  const tag = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      nodes: s.toMany(() => node),
    })
    .map("x1b_cds_tag");
  const label = s
    .model({
      id: s.string().id(),
      name: s.string(),
      nodes: s.toMany(() => node),
    })
    .map("x1b_cds_label");
  const node = s
    .model({
      id: s.string().id(),
      name: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
      tagId: s.int().nullable(),
      tag: s
        .toOne(() => tag)
        .fields("tagId")
        .references("id"),
      labels: s.toMany(() => label),
    })
    .map("x1b_cds_node");
  // Referenced models first (migration DDL orders tables by schema key position).
  return { tag, label, node };
})();

function makeClient(db: PGlite) {
  return createClient({
    schema: schema as never,
    driver: new PGliteDriver({ client: db }),
  });
}
type AnyClient = ReturnType<typeof makeClient>;

async function runObserved(
  substrate: "tx" | "batch",
  seed: (c: AnyClient) => Promise<void>,
  op: (c: Record<string, any>) => Promise<void>,
  snap: (c: AnyClient) => Promise<unknown>
): Promise<{ state: unknown; engines: Set<"direct" | "production"> }> {
  const db = new PGlite();
  const base = makeClient(db);
  await push(base as never, { force: true });
  await seed(base);
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  const observed = observeClientOperations({
    schema: schema as never,
    driver,
  });
  await op(observed.client);
  const state = await snap(base);
  await base.$disconnect();
  return {
    state,
    engines: new Set(observed.operations.map((r) => r.boundary)),
  };
}

describe("X1b combined depth stress — four mechanisms in one >=6-level tree", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.node.create({ data: { id: "r0", name: "r0" } });
    await client.node.create({
      data: { id: "c1", name: "c1", parentId: "r0" },
    });
    // A committed row to be adopted at level 4, and its duplicate-PK skip target.
    await client.node.create({ data: { id: "adopt", name: "adopt" } });
    await client.node.create({ data: { id: "dup", name: "dup" } });
    // An existing label the M2M connect adopts, and a disjoint witness subtree.
    await client.label.create({ data: { id: "lblA", name: "lblA" } });
    await client.node.create({ data: { id: "w0", name: "w0" } });
  };

  const op = async (c: Record<string, any>) => {
    await c.node.update({
      where: { id: "r0" },
      data: {
        children: {
          update: {
            where: { id: "c1" },
            data: {
              children: {
                create: {
                  id: "n2",
                  name: "n2",
                  tag: { create: { name: "tag2" } }, // mech 1 + 2
                  labels: {
                    connect: { id: "lblA" },
                    create: { id: "lblNew", name: "lblNew" },
                  }, // mech 4 (M2M)
                  children: {
                    create: {
                      id: "n3",
                      name: "n3",
                      children: {
                        create: {
                          id: "n4",
                          name: "n4",
                          children: {
                            connect: { id: "adopt" }, // mech 4 (adopt)
                            create: {
                              id: "n5",
                              name: "n5",
                              tag: { create: { name: "tag5" } }, // mech 1 + 2
                              children: {
                                create: {
                                  id: "n6",
                                  name: "n6",
                                  children: {
                                    createMany: {
                                      data: [
                                        { id: "n7a", name: "n7a" },
                                        { id: "dup", name: "dup-skip" },
                                      ],
                                      skipDuplicates: true, // mech 3
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  };

  const snap = async (c: AnyClient) => {
    const client = c as any;
    const tags = await client.tag.findMany();
    const tagName = new Map(tags.map((t: any) => [t.id, t.name]));
    const nodes = await client.node.findMany({
      orderBy: { id: "asc" },
      include: { labels: { orderBy: { id: "asc" } } },
    });
    return nodes.map((n: any) => [
      n.id,
      n.parentId,
      n.tagId === null ? null : tagName.get(n.tagId),
      n.labels.map((l: any) => l.id),
    ]);
  };

  // Each node under its IMMEDIATE ancestor; the two generated tags fold into n2/n5;
  // n2 carries both labels; adopt reparented onto n4; dup skipped (stays parentless);
  // w0 untouched.
  const expected = [
    ["adopt", "n4", null, []],
    ["c1", "r0", null, []],
    ["dup", null, null, []],
    ["n2", "c1", "tag2", ["lblA", "lblNew"]],
    ["n3", "n2", null, []],
    ["n4", "n3", null, []],
    ["n5", "n4", "tag5", []],
    ["n6", "n5", null, []],
    ["n7a", "n6", null, []],
    ["r0", null, null, []],
    ["w0", null, null, []],
  ];

  test("tx: all four mechanisms compose in one >=6-level tree, native Observed", async () => {
    const { state, engines } = await runObserved("tx", seed, op, snap);
    expect(engines).toEqual(new Set(["production"]));
    expect(state).toEqual(expected);
  });

  test("batch composes the same four mechanisms", async () => {
    const { state, engines } = await runObserved("batch", seed, op, snap);
    expect(engines).toEqual(new Set(["production"]));
    expect(state).toEqual(expected);
  });
});
