/** REVIEW PROBE 2 (lens B): the shape of the AND/OR/NOT collision. */
import type { Operations } from "@client/types";
import { s } from "@schema";
import {
  createWitnessWorld,
  type WitnessWorld,
} from "@tests/raptor3/g4/witness-world";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const world = () => {
  const row: any = s
    .model({
      id: s.int().id(),
      AND: s.int(),
      OR: s.int(),
      NOT: s.int(),
      title: s.string(),
    })
    .map("n4rc2_rows");
  return { row };
};

describe("N4 review 2 — AND/OR/NOT collisions", () => {
  let live: WitnessWorld;
  beforeAll(async () => {
    live = await createWitnessWorld(world() as never, { foreignKeys: false });
    await live.candidate.execute("row", "create" as Operations, {
      data: { id: 1, AND: 5, OR: 5, NOT: 5, title: "x" },
    });
  });
  afterAll(async () => {
    await live?.close();
  });

  const call = async (operation: string, args: unknown) => {
    try {
      return `OK ${JSON.stringify(await live.candidate.execute("row", operation as Operations, args))}`;
    } catch (failure) {
      return `${(failure as Error).name}: ${(failure as Error).message}`;
    }
  };

  it("reports each payload", async () => {
    const cases: [string, unknown][] = [
      ["where AND gt", { where: { AND: { gt: 1 } } }],
      ["where OR gt", { where: { OR: { gt: 1 } } }],
      ["where NOT gt", { where: { NOT: { gt: 1 } } }],
      ["where AND shorthand", { where: { AND: 999 } }],
      ["where AND equals", { where: { AND: { equals: 999 } } }],
      ["where AND in", { where: { AND: { in: [999] } } }],
    ];
    for (const [label, args] of cases) {
      // eslint-disable-next-line no-console
      console.log(`findMany ${label}:`, await call("findMany", args));
    }
    // eslint-disable-next-line no-console
    console.log(
      "groupBy having AND:",
      await call("groupBy", {
        by: ["title"],
        having: { AND: { gt: 1 } },
      })
    );
    // eslint-disable-next-line no-console
    console.log(
      "updateMany where AND shorthand:",
      await call("count", { where: { AND: 999 } })
    );
    expect(true).toBe(true);
  });
});
