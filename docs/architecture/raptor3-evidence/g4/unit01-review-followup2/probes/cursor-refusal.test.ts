import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { bothOutcomes } from "../unit01-followup/world";

/**
 * Repair-2 review (new finding H). `page()` raises its own cursor refusal when
 * the requested order is not a direct scalar one. The shipped owner
 * (`operations/cursor-order.ts:55-59`) words it differently, and this path is
 * reachable on SQLite with no special provider tier — a relation-path order
 * beside a cursor.
 */
const ROWS = `
  INSERT INTO fu_teams VALUES (1,'one'),(2,'two');
  INSERT INTO fu_members(id, team_id, member_name, rank, weight, bucket, active) VALUES
    (1,1,'a',1,1,'x',1),
    (2,1,'b',2,2,'y',0),
    (3,2,'c',3,NULL,'x',1),
    (4,NULL,'d',4,4,'z',1);
`;

describe("G4-01 repair 2 review — the cursor refusal identity", () => {
  const ORDERS: [string, Record<string, unknown>][] = [
    ["a to-one relation path", { team: { label: "asc" } }],
    ["a collection _count", { members: { _count: "asc" } }],
  ];

  for (const [label, orderBy] of ORDERS)
    it(`words the cursor refusal for ${label} the way the shipped engine words it`, async () => {
      const model = "label" in (orderBy.team ?? {}) ? "member" : "team";
      const seen = await bothOutcomes(ROWS, model, "findMany", {
        orderBy,
        cursor: { id: 1 },
        take: 2,
        select: { id: true },
      });
      assert.deepEqual(
        seen.candidate,
        seen.shipped,
        `${label}\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
      );
    });
});
