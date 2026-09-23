import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { bothOutcomes } from "../unit01-followup/world";

/**
 * Non-vacuity guard for the repair-2 review probes: the parity probes would
 * pass trivially if BOTH engines refused at admission or answered nothing, so
 * these pin the absolute answer of the shapes the repair actually changed.
 */
const ROWS = `
  INSERT INTO fu_teams VALUES (1,'one'),(2,'two');
  INSERT INTO fu_members(id, team_id, member_name, rank, weight, bucket, active) VALUES
    (1,1,'a',1,1,'x',1),
    (2,1,'b',2,2,'y',0),
    (3,2,'c',3,NULL,'x',1),
    (4,NULL,'d',4,4,'z',1);
`;

async function ids(where: Record<string, unknown>): Promise<{
  shipped: number[];
  candidate: number[];
}> {
  const outcome = await bothOutcomes(ROWS, "member", "findMany", {
    where,
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const read = (side: unknown): number[] => {
    const box = side as { ok?: { id: number }[]; error?: string };
    if (box.error !== undefined)
      throw new Error(`refused instead of answering: ${box.error}`);
    return box.ok!.map((row) => row.id);
  };
  return { shipped: read(outcome.shipped), candidate: read(outcome.candidate) };
}

describe("G4-01 repair 2 review — non-vacuity of the empty-arm probes", () => {
  const PINS: [string, Record<string, unknown>, number[]][] = [
    ["NOT around an empty OR array is TRUE", { NOT: [{ OR: [] }] }, [1, 2, 3, 4]],
    ["OR whose only arm is an empty AND is FALSE", { OR: [{ AND: [] }] }, []],
    ["AND around an empty OR array is FALSE", { AND: [{ OR: [] }] }, []],
    ["NOT of a NOT of nothing is absent", { NOT: { NOT: {} } }, [1, 2, 3, 4]],
    ["OR of two empty arms is FALSE", { OR: [{}, {}] }, []],
    ["NOT of two empty arms is absent", { NOT: [{}, {}] }, [1, 2, 3, 4]],
    ["AND of two empty arms is absent", { AND: [{}, {}] }, [1, 2, 3, 4]],
    [
      "vacuous OR beside a real key is FALSE",
      { OR: [{}], bucket: "x" },
      [],
    ],
    [
      "empty AND beside a real key keeps the key",
      { AND: [], bucket: "x" },
      [1, 3],
    ],
    [
      "OR of an empty NOT beside a real arm keeps only the real arm",
      { OR: [{ NOT: [] }, { bucket: "y" }] },
      [2],
    ],
  ];
  for (const [label, where, expected] of PINS)
    it(`pins ${label}`, async () => {
      const seen = await ids(where);
      assert.deepEqual(seen.shipped, expected, `shipped ${label}`);
      assert.deepEqual(seen.candidate, expected, `candidate ${label}`);
    });
});
