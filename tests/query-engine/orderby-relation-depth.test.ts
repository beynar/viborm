/**
 * orderBy to-one chain depth cap (decision D-5: 3 -> 8).
 *
 * MAX_RELATION_ORDER_DEPTH lives twice — the validation schema
 * (src/validation/relations/order-by.ts, the front line: past the cap the
 * schema stops offering relation keys) and the join builder
 * (src/query-engine/builders/relation-orderby-builder.ts, defense in depth).
 * This file pins that the two agree, that chains up to the cap actually order
 * rows correctly against a real database, and that one hop past the cap is
 * still refused.
 *
 * The fixture is a self-referential `parent` chain nine deep, in three
 * families whose 5th and 8th ancestors are labelled in OPPOSITE orders — so a
 * chain resolved at the wrong hop count produces the wrong row order rather
 * than merely the wrong SQL.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEPTH_CAP_RE = /const MAX_RELATION_ORDER_DEPTH = (\d+);/;
const UNKNOWN_PARENT_KEY_ERROR = /Unknown key: parent/;
const TO_MANY_MID_CHAIN_ERROR = /cannot order through a to-many relation/;

const readDepthCap = (relativePath: string): number => {
  const source = readFileSync(join(REPO, relativePath), "utf8");
  const match = source.match(DEPTH_CAP_RE);
  if (!match?.[1]) {
    throw new Error(`No MAX_RELATION_ORDER_DEPTH found in ${relativePath}`);
  }
  return Number(match[1]);
};

const node = s
  .model({
    id: s.string().id(),
    label: s.string(),
    depth: s.int(),
    parentId: s.string().nullable(),
    parent: s
      .manyToOne(() => node)
      .fields("parentId")
      .references("id")
      .optional(),
    children: s.oneToMany(() => node),
  })
  .map("order_depth_nodes");

const createDepthClient = () =>
  createClient({
    schema: { node },
    driver: new PGliteDriver({ client: new PGlite() }),
  });

let client: ReturnType<typeof createDepthClient>;

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

beforeAll(async () => {
  client = createDepthClient();
  await push(client, { force: true });

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

afterAll(async () => {
  await client.$disconnect();
});

describe("orderBy relation depth - the two caps agree", () => {
  test("validation and engine pin the same cap, and it is 8", () => {
    const validationCap = readDepthCap("src/validation/relations/order-by.ts");
    const engineCap = readDepthCap(
      "src/query-engine/builders/relation-orderby-builder.ts"
    );

    expect(validationCap).toBe(engineCap);
    // Decision D-5 (docs/architecture/prisma-parity-v2-plan.md) raised 3 -> 8.
    expect(validationCap).toBe(8);
  });
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

describe("orderBy relation depth - past the cap", () => {
  test("a 9-hop chain is rejected", async () => {
    await expect(
      client.node.findMany({
        where: { depth: 9 },
        orderBy: parentChainOrderBy(9) as never,
        select: { id: true },
      })
    ).rejects.toThrow(UNKNOWN_PARENT_KEY_ERROR);
  });

  test("the 9-hop rejection is a validation error, not a database error", async () => {
    let failure: unknown;
    try {
      await client.node.findMany({
        where: { depth: 9 },
        orderBy: parentChainOrderBy(9) as never,
        select: { id: true },
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).name).toBe("ValidationError");
  });
});

describe("orderBy relation depth - to-many mid-chain still refused", () => {
  test("a to-many relation inside a to-one chain is rejected", async () => {
    await expect(
      client.node.findMany({
        orderBy: { parent: { children: { _count: "asc" } } } as never,
        select: { id: true },
      })
    ).rejects.toThrow(TO_MANY_MID_CHAIN_ERROR);
  });

  test("a top-level to-many _count orderBy is still accepted", async () => {
    const rows = await client.node.findMany({
      where: { depth: 8 },
      orderBy: { children: { _count: "desc" } },
      select: { id: true },
    });
    expect(rows).toHaveLength(3);
  });
});
