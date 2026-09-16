import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { bothOutcomes } from "./world";

/**
 * Characterizing the empty logical arm across every combinator, after the
 * finding-5 repair made the array NOT reachable.
 */
const ROWS = `
  INSERT INTO fu_teams VALUES (1,'one');
  INSERT INTO fu_members(id, team_id, member_name, rank, weight, bucket, active) VALUES
    (1,1,'a',1,1,'x',1),
    (2,1,'b',2,2,'y',0),
    (3,1,'c',3,NULL,'x',1);
`;

const FORMS: [string, Record<string, unknown>][] = [
  ["NOT object empty", { NOT: {} }],
  ["NOT array empty", { NOT: [] }],
  ["NOT array with one empty arm", { NOT: [{}] }],
  ["NOT array with an empty arm beside a real arm", { NOT: [{}, { bucket: "y" }] }],
  ["NOT array with a real arm beside an empty arm", { NOT: [{ bucket: "y" }, {}] }],
  ["AND array with an empty arm", { AND: [{}, { bucket: "y" }] }],
  ["OR array with an empty arm", { OR: [{}, { bucket: "y" }] }],
  ["AND array empty", { AND: [] }],
  ["OR array empty", { OR: [] }],
  ["NOT nested around an empty arm", { NOT: [{ NOT: [{}] }] }],
  ["empty where", {}],
];

describe("G4-01 follow-up — empty logical arms", () => {
  for (const [label, where] of FORMS)
    it(`answers ${label} the way the shipped engine does`, async () => {
      const outcome = await bothOutcomes(ROWS, "member", "findMany", {
        where,
        orderBy: { id: "asc" },
        select: { id: true },
      });
      assert.deepEqual(
        outcome.candidate,
        outcome.shipped,
        `${label} ${JSON.stringify(where)}\n  candidate ${JSON.stringify(outcome.candidate)}\n  shipped   ${JSON.stringify(outcome.shipped)}`
      );
    });

  it("answers an empty having arm the way the shipped engine does", async () => {
    for (const having of [
      { NOT: {} },
      { NOT: [{}] },
      { NOT: [{}, { bucket: { equals: "x" } }] },
      { AND: [{}] },
    ]) {
      const outcome = await bothOutcomes(ROWS, "member", "groupBy", {
        by: ["bucket"],
        having,
        orderBy: { bucket: "asc" },
        _count: { _all: true },
      });
      assert.deepEqual(
        outcome.candidate,
        outcome.shipped,
        `having ${JSON.stringify(having)}\n  candidate ${JSON.stringify(outcome.candidate)}\n  shipped   ${JSON.stringify(outcome.shipped)}`
      );
    }
  });
});
