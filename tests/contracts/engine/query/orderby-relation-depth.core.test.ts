import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const DEPTH_CAP_RE = /const MAX_RELATION_ORDER_DEPTH = (\d+);/;
const UNKNOWN_PARENT_KEY_ERROR = /Unknown key: parent/;
const TO_MANY_MID_CHAIN_ERROR = /cannot order through a to-many relation/;

const readDepthCap = (relativePath: string): number => {
  const source = readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
  const match = source.match(DEPTH_CAP_RE);
  if (!match?.[1]) {
    throw new Error(`No MAX_RELATION_ORDER_DEPTH found in ${relativePath}`);
  }
  return Number(match[1]);
};

const node = s.model({
  id: s.string().id(),
  label: s.string(),
  depth: s.int(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => node),
});

const schema = { node };
hydrateSchemaNames(schema);
const engine = new QueryEngine(
  new PlanningDriver("postgresql"),
  createModelRegistry(schema, createSchemaRegistry(schema))
);

const parentChainOrderBy = (hops: number): Record<string, unknown> => {
  let chain: Record<string, unknown> = { label: "asc" };
  for (let i = 0; i < hops; i++) {
    chain = { parent: chain };
  }
  return chain;
};

describe("orderBy relation-depth deterministic contracts", () => {
  test("validation and engine pin the same cap, and it is 8", () => {
    const validationCap = readDepthCap("src/validation/relations/order-by.ts");
    const engineCap = readDepthCap(
      "src/query-engine/builders/relation-orderby-builder.ts"
    );

    expect(validationCap).toBe(engineCap);
    expect(validationCap).toBe(8);
  });

  test("a 9-hop chain is rejected before provider dispatch", async () => {
    await expect(
      engine.prepare(node, "findMany", {
        where: { depth: 9 },
        orderBy: parentChainOrderBy(9),
        select: { id: true },
      })
    ).rejects.toThrow(UNKNOWN_PARENT_KEY_ERROR);
  });

  test("the 9-hop rejection is a validation error", async () => {
    let failure: unknown;
    try {
      await engine.prepare(node, "findMany", {
        where: { depth: 9 },
        orderBy: parentChainOrderBy(9),
        select: { id: true },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected validation to reject the query.");
    }
    expect(failure.name).toBe("ValidationError");
  });

  test("a to-many relation inside a to-one chain is rejected", async () => {
    await expect(
      engine.prepare(node, "findMany", {
        orderBy: { parent: { children: { _count: "asc" } } },
        select: { id: true },
      })
    ).rejects.toThrow(TO_MANY_MID_CHAIN_ERROR);
  });
});
