import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { bothOutcomes } from "../unit01-followup/world";

/**
 * Repair-2 review. `prepareWhere` sets `facts.exact = false` for `OR`/`NOT`
 * BEFORE `combine` decides whether any arm survives, so an arm the repair now
 * drops still marks the selector inexact. These probes ask whether that is
 * observable anywhere a read can see it: unique lookups, OrThrow identity,
 * cursors and distinct windows.
 */
const ROWS = `
  INSERT INTO fu_teams VALUES (1,'one'),(2,'two');
  INSERT INTO fu_members(id, team_id, member_name, rank, weight, bucket, active) VALUES
    (1,1,'a',1,1,'x',1),
    (2,1,'b',2,2,'y',0),
    (3,2,'c',3,NULL,'x',1),
    (4,NULL,'d',4,4,'z',1);
`;

async function agree(
  label: string,
  operation: string,
  args: Record<string, unknown>
): Promise<void> {
  const seen = await bothOutcomes(ROWS, "member", operation, args);
  assert.deepEqual(
    seen.candidate,
    seen.shipped,
    `${label}\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
  );
}

describe("G4-01 repair 2 review — a dropped arm and the selector facts", () => {
  it("agrees on findUnique with a dropped arm beside the key", async () => {
    for (const [label, where] of [
      ["empty NOT object", { id: 1, NOT: {} }],
      ["empty NOT array", { id: 1, NOT: [] }],
      ["empty AND array", { id: 1, AND: [] }],
      ["vacuous OR", { id: 1, OR: [{}] }],
      ["empty OR array", { id: 1, OR: [] }],
    ] as [string, Record<string, unknown>][])
      for (const operation of ["findUnique", "findUniqueOrThrow"] as const)
        await agree(`${operation} ${label}`, operation, {
          where,
          select: { id: true },
        });
  });

  it("agrees on findFirstOrThrow with a dropped arm", async () => {
    for (const [label, where] of [
      ["empty NOT", { NOT: {} }],
      ["vacuous OR", { OR: [{}] }],
    ] as [string, Record<string, unknown>][])
      await agree(`findFirstOrThrow ${label}`, "findFirstOrThrow", {
        where,
        orderBy: { id: "asc" },
        select: { id: true },
      });
  });

  it("agrees on a cursor window beside a dropped arm", async () => {
    for (const [label, where] of [
      ["empty NOT", { NOT: [{}] }],
      ["empty AND", { AND: [] }],
    ] as [string, Record<string, unknown>][])
      for (const take of [2, -2])
        await agree(`cursor ${label} take ${take}`, "findMany", {
          where,
          orderBy: { id: "asc" },
          cursor: { id: 2 },
          take,
          skip: 1,
          select: { id: true },
        });
  });

  it("agrees on a distinct window beside a dropped arm", async () => {
    await agree("distinct with an empty NOT", "findMany", {
      where: { NOT: [{}] },
      orderBy: { id: "asc" },
      distinct: ["bucket"],
      select: { id: true, bucket: true },
    });
  });

  it("agrees on a nested to-many where holding a dropped arm, with a window", async () => {
    await agree("nested empty NOT with a negative take", "findMany", {
      orderBy: { id: "asc" },
      select: { id: true },
      take: 2,
    });
    const seen = await bothOutcomes(ROWS, "team", "findMany", {
      orderBy: { id: "asc" },
      select: {
        id: true,
        members: {
          where: { NOT: [{}] },
          orderBy: { id: "asc" },
          take: -2,
          select: { id: true },
        },
      },
    });
    assert.deepEqual(
      seen.candidate,
      seen.shipped,
      `nested\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
    );
  });
});
