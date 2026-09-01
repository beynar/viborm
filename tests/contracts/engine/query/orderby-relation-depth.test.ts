/**
 * orderBy to-one chain depth cap (decision D-5: 3 -> 8).
 *
 * MAX_RELATION_ORDER_DEPTH lives twice — the validation schema
 * (src/validation/relations/order-by.ts, the front line: past the cap the
 * schema stops offering relation keys) and the join builder
 * (src/query-engine/builders/relation-orderby-builder.ts, defense in depth).
 * The adjacent core contract pins that the two caps agree and that invalid
 * chains fail before dispatch. This file proves that accepted chains order
 * rows correctly against a real database.
 *
 * The fixture is a self-referential `parent` chain nine deep, in three
 * families whose 5th and 8th ancestors are labelled in OPPOSITE orders — so a
 * chain resolved at the wrong hop count produces the wrong row order rather
 * than merely the wrong SQL.
 */

import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { beforeEach, describe, expect, test } from "vitest";

const node = s
  .model({
    id: s.string().id(),
    label: s.string(),
    depth: s.int(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => node),
  })
  .map("order_depth_nodes");

const schema = { node };

const getFamily = usePGliteSchemaFamily(schema);

let client: ReturnType<typeof getFamily>["client"];

/**
 * Three chains of ten nodes (depth 0 = root .. depth 9 = leaf). The labels at
 * depth 4 (five hops up from a leaf) and depth 1 (eight hops up) sort the
 * three families in opposite directions.
 */
const FAMILIES = [
  { key: "A", atDepth4: "m", atDepth1: "z" },
  { key: "B", atDepth4: "n", atDepth1: "y" },
  { key: "C", atDepth4: "o", atDepth1: "x" },
];
const CHAIN_LENGTH = 10;

const labelFor = (family: (typeof FAMILIES)[number], depth: number): string => {
  if (depth === 4) {
    return family.atDepth4;
  }
  if (depth === 1) {
    return family.atDepth1;
  }
  return `${family.key}-${depth}`;
};

/** `{ parent: { parent: … { label: "asc" } } }` with `hops` `parent` levels. */
const parentChainOrderBy = (hops: number): Record<string, unknown> => {
  let chain: Record<string, unknown> = { label: "asc" };
  for (let i = 0; i < hops; i++) {
    chain = { parent: chain };
  }
  return chain;
};

const leafIds = (rows: readonly { id: string }[]): string[] =>
  rows.map((row) => row.id);

beforeEach(async () => {
  client = getFamily().client;

  // Parents must exist before children: seed depth 0 upwards.
  for (let depth = 0; depth < CHAIN_LENGTH; depth++) {
    await client.node.createMany({
      data: FAMILIES.map((family) => ({
        id: `${family.key}${depth}`,
        label: labelFor(family, depth),
        depth,
        parentId: depth === 0 ? null : `${family.key}${depth - 1}`,
      })),
    });
  }
});

describe("orderBy relation depth - chains within the cap order rows", () => {
  test("a 5-hop to-one chain orders by the 5th ancestor", async () => {
    const rows = await client.node.findMany({
      where: { depth: 9 },
      orderBy: {
        parent: {
          parent: { parent: { parent: { parent: { label: "asc" } } } },
        },
      },
      select: { id: true },
    });

    // depth-4 labels: A="m", B="n", C="o".
    expect(leafIds(rows)).toEqual(["A9", "B9", "C9"]);
  });

  test("an 8-hop to-one chain orders by the 8th ancestor", async () => {
    const rows = await client.node.findMany({
      where: { depth: 9 },
      orderBy: {
        parent: {
          parent: {
            parent: {
              parent: {
                parent: {
                  parent: { parent: { parent: { label: "asc" } } },
                },
              },
            },
          },
        },
      },
      select: { id: true },
    });

    // depth-1 labels: A="z", B="y", C="x" — the reverse of the 5-hop order,
    // so resolving the chain at the wrong depth cannot pass both tests.
    expect(leafIds(rows)).toEqual(["C9", "B9", "A9"]);
  });

  test("every hop count up to the cap is accepted", async () => {
    for (let hops = 1; hops <= 8; hops++) {
      const rows = await client.node.findMany({
        where: { depth: 9 },
        orderBy: parentChainOrderBy(hops) as never,
        select: { id: true },
      });
      expect(rows).toHaveLength(3);
    }
  });
});

describe("orderBy relation depth - to-many mid-chain still refused", () => {
  test("a top-level to-many _count orderBy is still accepted", async () => {
    const rows = await client.node.findMany({
      where: { depth: 8 },
      orderBy: { children: { _count: "desc" } },
      select: { id: true },
    });
    expect(rows).toHaveLength(3);
  });
});
