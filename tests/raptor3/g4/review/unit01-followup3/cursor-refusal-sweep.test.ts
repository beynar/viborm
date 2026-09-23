import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { both, bothOutcomes } from "../unit01-followup/world";

/**
 * Third review (repair 3). Finding H asked for the shipped cursor sentence.
 * The repair changed one word. These probes pin the sentence ABSOLUTELY on
 * every shape that reaches the owner, and — the risk a reworded refusal
 * carries — check the shapes that must still PAGE instead of refusing.
 */
const ROWS = `
  INSERT INTO fu_teams VALUES (1,'one'),(2,'two');
  INSERT INTO fu_members(id, team_id, member_name, rank, weight, bucket, active) VALUES
    (1,1,'a',1,1,'x',1),
    (2,1,'b',2,2,'y',0),
    (3,2,'c',3,NULL,'x',1),
    (4,NULL,'d',4,4,'z',1);
`;

const SENTENCE =
  "Cursor pagination supports direct scalar sort directions only; relation and vector-distance orderBy are not supported.";

const agrees = (
  label: string,
  seen: { shipped: unknown; candidate: unknown }
): void => {
  assert.deepEqual(
    seen.candidate,
    seen.shipped,
    `${label}\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
  );
};

describe("G4-01 repair 3 review — the cursor refusal, pinned absolutely", () => {
  const REFUSING: [string, "team" | "member", Record<string, unknown>][] = [
    ["a to-one relation path", "member", { team: { label: "asc" } }],
    ["a collection _count", "team", { members: { _count: "asc" } }],
    [
      "a scalar order BESIDE a relation order",
      "member",
      [{ rank: "asc" }, { team: { label: "asc" } }] as never,
    ],
    [
      "a relation order FIRST, scalar second",
      "member",
      [{ team: { label: "desc" } }, { id: "asc" }] as never,
    ],
  ];

  for (const [label, model, orderBy] of REFUSING)
    it(`answers the shipped sentence for ${label}`, async () => {
      const seen = await bothOutcomes(ROWS, model, "findMany", {
        orderBy,
        cursor: { id: 1 },
        take: 2,
        select: { id: true },
      });
      agrees(label, seen);
      assert.deepEqual(seen.candidate, { error: SENTENCE }, label);
    });

  it("answers the shipped sentence for a NEGATIVE window too", async () => {
    const seen = await bothOutcomes(ROWS, "member", "findMany", {
      orderBy: { team: { label: "asc" } },
      cursor: { id: 3 },
      take: -2,
      select: { id: true },
    });
    agrees("negative window", seen);
    assert.deepEqual(seen.candidate, { error: SENTENCE });
  });

  it("answers the shipped sentence for a cursor with NO take", async () => {
    const seen = await bothOutcomes(ROWS, "member", "findMany", {
      orderBy: { team: { label: "asc" } },
      cursor: { id: 1 },
      select: { id: true },
    });
    agrees("cursor without take", seen);
    assert.deepEqual(seen.candidate, { error: SENTENCE });
  });
});

describe("G4-01 repair 3 review — and the shapes that must still page", () => {
  it("pages a scalar order beside a cursor", async () => {
    const seen = await both(ROWS, "member", "findMany", {
      orderBy: { rank: "asc" },
      cursor: { id: 2 },
      take: 2,
      select: { id: true },
    });
    agrees("scalar order with cursor", seen);
    assert.deepEqual(seen.candidate, [{ id: 2 }, { id: 3 }]);
  });

  it("answers a relation order with a WINDOW but no cursor", async () => {
    const seen = await bothOutcomes(ROWS, "member", "findMany", {
      orderBy: { team: { label: "asc" } },
      take: 2,
      select: { id: true },
    });
    agrees("relation order, take, no cursor", seen);
    assert.ok(
      (seen.candidate as { ok?: unknown }).ok !== undefined,
      `must answer rows, saw ${JSON.stringify(seen.candidate)}`
    );
  });

  it("answers a relation order with a SKIP but no cursor", async () => {
    const seen = await bothOutcomes(ROWS, "member", "findMany", {
      orderBy: { team: { label: "asc" } },
      skip: 1,
      select: { id: true },
    });
    agrees("relation order, skip, no cursor", seen);
    assert.ok(
      (seen.candidate as { ok?: unknown }).ok !== undefined,
      `must answer rows, saw ${JSON.stringify(seen.candidate)}`
    );
  });

  it("pages a cursor with NO orderBy at all", async () => {
    const seen = await both(ROWS, "member", "findMany", {
      cursor: { id: 2 },
      take: 2,
      select: { id: true },
    });
    agrees("cursor, default order", seen);
  });

  it("refuses a relation order beside a cursor in a NESTED read the same way", async () => {
    const seen = await bothOutcomes(ROWS, "team", "findMany", {
      select: {
        id: true,
        members: {
          orderBy: { team: { label: "asc" } },
          cursor: { id: 1 },
          take: 1,
          select: { id: true },
        },
      },
    });
    agrees("nested cursor refusal", seen);
  });
});
