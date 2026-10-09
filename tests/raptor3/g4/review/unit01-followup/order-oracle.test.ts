import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { both } from "./world";

/**
 * All query shapes use the public ASC NULLS LAST / DESC NULLS FIRST defaults.
 * Every shape is asked of both engines over identical data, with independent
 * expected rows so matching regressions cannot satisfy the contract.
 */
const NULLS = `
  INSERT INTO fu_teams VALUES (1,'bravo'),(2,'alpha'),(3,'charlie');
  INSERT INTO fu_members(id, team_id, member_name, rank, weight, bucket, active) VALUES
    (1,1,'m1',1,3,'a',1),
    (2,NULL,'m2',2,NULL,'b',0),
    (3,2,'m3',3,1,'a',1),
    (4,NULL,'m4',4,NULL,'c',0),
    (5,3,'m5',5,2,'b',1);
`;

async function parity(
  model: "team" | "member",
  operation: string,
  args: Record<string, unknown>,
  label: string
): Promise<unknown> {
  const { shipped, candidate } = await both(NULLS, model, operation, args);
  // biome-ignore lint/suspicious/noMisplacedAssertion: This parity helper is awaited by each registered test.
  assert.deepEqual(
    candidate,
    shipped,
    `${label}\n  candidate ${JSON.stringify(candidate)}\n  shipped   ${JSON.stringify(shipped)}`
  );
  return candidate;
}

describe("G4-01 follow-up — null placement, every windowing shape", () => {
  it("settles the disputed bare relation-path order against the shipped engine", async () => {
    // Rows 2 and 4 have no team; direction changes their placement explicitly.
    const ascending = await parity(
      "member",
      "findMany",
      { orderBy: { team: { label: "asc" } }, select: { id: true } },
      "bare to-one relation path asc"
    );
    const descending = await parity(
      "member",
      "findMany",
      { orderBy: { team: { label: "desc" } }, select: { id: true } },
      "bare to-one relation path desc"
    );
    assert.deepEqual(ascending, [
      { id: 3 },
      { id: 1 },
      { id: 5 },
      { id: 2 },
      { id: 4 },
    ]);
    assert.deepEqual(descending, [
      { id: 2 },
      { id: 4 },
      { id: 5 },
      { id: 1 },
      { id: 3 },
    ]);
  });

  it("keeps the default scalar null placement in both directions", async () => {
    for (const direction of ["asc", "desc"] as const)
      await parity(
        "member",
        "findMany",
        { orderBy: { weight: direction }, select: { id: true } },
        `unwindowed ${direction}`
      );
  });

  it("keeps the same default null placement for a skip-only read", async () => {
    for (const direction of ["asc", "desc"] as const)
      await parity(
        "member",
        "findMany",
        { orderBy: { weight: direction }, skip: 1, select: { id: true } },
        `skip-only ${direction}`
      );
  });

  it("keeps the same null-placement contract for every window", async () => {
    for (const direction of ["asc", "desc"] as const) {
      await parity(
        "member",
        "findMany",
        { orderBy: { weight: direction }, take: 5, select: { id: true } },
        `take ${direction}`
      );
      await parity(
        "member",
        "findMany",
        { orderBy: { weight: direction }, take: -3, select: { id: true } },
        `negative take ${direction}`
      );
      await parity(
        "member",
        "findMany",
        {
          orderBy: { weight: direction },
          cursor: { id: 5 },
          take: 3,
          select: { id: true },
        },
        `cursor ${direction}`
      );
    }
  });

  it("answers findFirst and findFirstOrThrow the way the shipped engine does", async () => {
    for (const direction of ["asc", "desc"] as const) {
      await parity(
        "member",
        "findFirst",
        { orderBy: { weight: direction }, select: { id: true } },
        `findFirst ${direction}`
      );
      await parity(
        "member",
        "findFirstOrThrow",
        { orderBy: { weight: direction }, select: { id: true } },
        `findFirstOrThrow ${direction}`
      );
    }
  });

  it("keeps a spelled placement and a multi-key order at parity", async () => {
    for (const nulls of ["first", "last"] as const)
      for (const windowed of [{}, { take: 5 }])
        await parity(
          "member",
          "findMany",
          {
            orderBy: { weight: { sort: "asc", nulls } },
            ...windowed,
            select: { id: true },
          },
          `spelled ${nulls} ${JSON.stringify(windowed)}`
        );
    await parity(
      "member",
      "findMany",
      {
        orderBy: [{ bucket: "asc" }, { weight: "desc" }],
        select: { id: true },
      },
      "two keys unwindowed"
    );
    await parity(
      "member",
      "findMany",
      {
        orderBy: [{ bucket: "asc" }, { weight: "desc" }],
        take: 5,
        select: { id: true },
      },
      "two keys windowed"
    );
  });

  it("keeps a nested to-many order at parity with and without a window", async () => {
    await parity(
      "team",
      "findMany",
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          members: { orderBy: { weight: "asc" }, select: { id: true } },
        },
      },
      "nested unwindowed"
    );
    await parity(
      "team",
      "findMany",
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          members: {
            orderBy: { weight: "asc" },
            take: 3,
            select: { id: true },
          },
        },
      },
      "nested windowed"
    );
  });

  it("keeps a collection _count order and a grouped order at parity", async () => {
    await parity(
      "team",
      "findMany",
      { orderBy: { members: { _count: "desc" } }, select: { id: true } },
      "relation count order"
    );
    await parity(
      "member",
      "groupBy",
      { by: ["weight"], orderBy: { weight: "asc" }, _count: { _all: true } },
      "grouped unwindowed"
    );
    await parity(
      "member",
      "groupBy",
      {
        by: ["weight"],
        orderBy: { weight: "asc" },
        take: 3,
        _count: { _all: true },
      },
      "grouped windowed"
    );
  });

  it("keeps an aggregate window at parity", async () => {
    await parity(
      "member",
      "aggregate",
      { orderBy: { weight: "asc" }, take: 3, _sum: { rank: true } },
      "aggregate windowed"
    );
    await parity(
      "member",
      "count",
      { orderBy: { weight: "asc" }, take: 3 },
      "count windowed"
    );
  });
});
