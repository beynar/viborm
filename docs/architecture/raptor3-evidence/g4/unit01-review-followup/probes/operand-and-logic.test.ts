import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { both, bothOutcomes } from "./world";

/** Findings 4 and 5 follow-up: whole-value operands and the array NOT. */
const ROWS = `
  INSERT INTO fu_teams VALUES (1,'one'),(2,'two');
  INSERT INTO fu_members(id, team_id, member_name, rank, weight, bucket, avatar, active) VALUES
    (1,1,'a',1,1,'x',X'0102FA',1),
    (2,1,'b',2,2,'y',X'09',0),
    (3,2,'c',3,NULL,'x',NULL,1);
`;

async function parity(
  model: "team" | "member",
  operation: string,
  args: Record<string, unknown>,
  label: string
): Promise<unknown> {
  const { shipped, candidate } = await both(ROWS, model, operation, args);
  assert.deepEqual(
    candidate,
    shipped,
    `${label}\n  candidate ${JSON.stringify(candidate)}\n  shipped   ${JSON.stringify(shipped)}`
  );
  return candidate;
}

const first = new Uint8Array([1, 2, 250]);
const second = new Uint8Array([9]);

describe("G4-01 follow-up — object operands are one whole value", () => {
  it("reads a Uint8Array inside in / notIn lists", async () => {
    const included = await parity(
      "member",
      "findMany",
      {
        where: { avatar: { in: [first, second] } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      "blob in"
    );
    assert.deepEqual(included, [{ id: 1 }, { id: 2 }]);
    await parity(
      "member",
      "findMany",
      {
        where: { avatar: { notIn: [second] } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      "blob notIn"
    );
  });

  it("reads a Node Buffer the same way as a bare Uint8Array", async () => {
    const buffer = Buffer.from([1, 2, 250]);
    const answer = await parity(
      "member",
      "findMany",
      { where: { avatar: buffer }, select: { id: true } },
      "Buffer shorthand"
    );
    assert.deepEqual(answer, [{ id: 1 }]);
  });

  it("reads a blob operand inside a relation scope and inside NOT", async () => {
    await parity(
      "team",
      "findMany",
      {
        where: { members: { some: { avatar: first } } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      "blob inside some"
    );
    await parity(
      "member",
      "findMany",
      {
        where: { NOT: { avatar: first } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      "blob inside NOT"
    );
    await parity(
      "member",
      "findMany",
      {
        where: { team: { is: { members: { some: { avatar: second } } } } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      "blob two scopes deep"
    );
  });

  it("keeps a null blob operand and an isNull test at parity", async () => {
    await parity(
      "member",
      "findMany",
      { where: { avatar: null }, orderBy: { id: "asc" }, select: { id: true } },
      "blob null"
    );
    await parity(
      "member",
      "findMany",
      {
        where: { avatar: { not: null } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      "blob not null"
    );
  });
});

describe("G4-01 follow-up — the array NOT in every scope", () => {
  it("negates an array NOT inside a relation quantifier", async () => {
    await parity(
      "team",
      "findMany",
      {
        where: {
          members: { some: { NOT: [{ bucket: "y" }, { active: false }] } },
        },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      "array NOT inside some"
    );
    await parity(
      "team",
      "findMany",
      {
        where: {
          members: { every: { NOT: [{ bucket: "y" }] } },
        },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      "array NOT inside every"
    );
  });

  it("negates an array NOT inside a nested read's own where", async () => {
    await parity(
      "team",
      "findMany",
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          members: {
            where: { NOT: [{ bucket: "y" }, { rank: 3 }] },
            orderBy: { id: "asc" },
            select: { id: true },
          },
        },
      },
      "array NOT in a nested where"
    );
  });

  it("keeps an array NOT over a relation arm at parity", async () => {
    await parity(
      "member",
      "findMany",
      {
        where: { NOT: [{ team: { is: { label: "one" } } }] },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      "array NOT over a relation arm"
    );
  });
  // The empty-arm forms live in `empty-arm.test.ts`, where every combinator is
  // characterized against the shipped engine in one place.

  it("keeps an array NOT in having at parity", async () => {
    await parity(
      "member",
      "groupBy",
      {
        by: ["bucket"],
        having: { NOT: [{ bucket: { equals: "x" } }] },
        orderBy: { bucket: "asc" },
        _count: { _all: true },
      },
      "array NOT in having"
    );
  });

  it("agrees with the shipped engine on a NOT the validator refuses", async () => {
    const outcome = await bothOutcomes(ROWS, "member", "findMany", {
      where: { NOT: "alpha" },
      select: { id: true },
    });
    assert.deepEqual(
      outcome.candidate,
      outcome.shipped,
      `NOT scalar\n  candidate ${JSON.stringify(outcome.candidate)}\n  shipped   ${JSON.stringify(outcome.shipped)}`
    );
  });
});
