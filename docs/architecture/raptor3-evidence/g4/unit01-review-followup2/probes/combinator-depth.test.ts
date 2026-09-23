import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { bothOutcomes } from "../unit01-followup/world";

/**
 * Repair-2 review (finding B). The repair introduced `states()` and one
 * `combine()` assembler. These probes attack the RECURSION and the
 * COMPOSITION of that rule, not the six rows the finding listed: a vacuous
 * FALSE produced by an inner `OR` must survive its enclosing arm, a
 * non-stating arm must disappear at every depth and inside a relation scope,
 * and the rule must not change any arm that does state something.
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
  model: "team" | "member",
  operation: string,
  args: Record<string, unknown>
): Promise<void> {
  const outcome = await bothOutcomes(ROWS, model, operation, args);
  assert.deepEqual(
    outcome.candidate,
    outcome.shipped,
    `${label}\n  candidate ${JSON.stringify(outcome.candidate)}\n  shipped   ${JSON.stringify(outcome.shipped)}`
  );
}

/** A vacuous FALSE from an inner arm must propagate, not vanish. */
const DEEP: [string, Record<string, unknown>][] = [
  ["NOT around an empty OR array", { NOT: [{ OR: [] }] }],
  ["NOT around an OR with one empty arm", { NOT: [{ OR: [{}] }] }],
  ["AND around an empty OR array", { AND: [{ OR: [] }] }],
  ["OR whose only arm is an empty AND", { OR: [{ AND: [] }] }],
  ["OR whose only arm is an empty NOT object", { OR: [{ NOT: {} }] }],
  ["OR of an empty NOT beside a real arm", { OR: [{ NOT: [] }, { bucket: "y" }] }],
  ["OR of a vacuous FALSE beside a real arm", { OR: [{ OR: [] }, { bucket: "y" }] }],
  ["NOT of a NOT of nothing", { NOT: { NOT: {} } }],
  ["three empty ANDs deep", { AND: [{ AND: [{ AND: [] }] }] }],
  ["empty AND beside a vacuous OR in one object", { AND: [], OR: [{}] }],
  ["empty AND beside a real key in one object", { AND: [], bucket: "x" }],
  ["empty NOT beside a real key in one object", { NOT: [], bucket: "x" }],
  ["vacuous OR beside a real key in one object", { OR: [{}], bucket: "x" }],
  ["NOT around an AND holding an empty OR", { NOT: [{ AND: [{ OR: [] }] }] }],
  ["OR of two empty arms", { OR: [{}, {}] }],
  ["NOT of two empty arms", { NOT: [{}, {}] }],
  ["AND of two empty arms", { AND: [{}, {}] }],
  ["OR nested three deep with one real leaf", { OR: [{ OR: [{ OR: [{ bucket: "y" }] }] }] }],
  ["NOT of an OR holding an empty and a real arm", { NOT: [{ OR: [{}, { bucket: "y" }] }] }],
];

describe("G4-01 repair 2 review — the empty-arm rule under composition", () => {
  for (const [label, where] of DEEP)
    it(`answers ${label} the way the shipped engine does`, async () => {
      await agree(label, "member", "findMany", {
        where,
        orderBy: { id: "asc" },
        select: { id: true },
      });
    });

  it("applies the rule inside a relation scope", async () => {
    const forms: [string, Record<string, unknown>][] = [
      ["some with an empty NOT", { members: { some: { NOT: {} } } }],
      ["some with a vacuous OR", { members: { some: { OR: [{}] } } }],
      ["some with an empty AND", { members: { some: { AND: [] } } }],
      ["every with a vacuous OR", { members: { every: { OR: [] } } }],
      ["every with an empty NOT", { members: { every: { NOT: [] } } }],
      ["none with a vacuous OR", { members: { none: { OR: [{}] } } }],
      ["none with an empty AND", { members: { none: { AND: [] } } }],
      [
        "NOT around a some with a vacuous OR",
        { NOT: [{ members: { some: { OR: [{}] } } }] },
      ],
      [
        "OR of a relation arm and an empty arm",
        { OR: [{}, { members: { some: { bucket: "y" } } }] },
      ],
    ];
    for (const [label, where] of forms)
      await agree(label, "team", "findMany", {
        where,
        orderBy: { id: "asc" },
        select: { id: true },
      });
  });

  it("applies the rule to a to-one relation filter", async () => {
    const forms: [string, Record<string, unknown>][] = [
      ["to-one is with a vacuous OR", { team: { is: { OR: [{}] } } }],
      ["to-one is with an empty AND", { team: { is: { AND: [] } } }],
      ["to-one bare with an empty NOT", { team: { NOT: {} } }],
      ["to-one isNot with a vacuous OR", { team: { isNot: { OR: [] } } }],
    ];
    for (const [label, where] of forms)
      await agree(label, "member", "findMany", {
        where,
        orderBy: { id: "asc" },
        select: { id: true },
      });
  });

  it("applies the rule in a nested read's own where", async () => {
    for (const [label, nested] of [
      ["nested vacuous OR", { OR: [{}] }],
      ["nested empty NOT", { NOT: {} }],
      ["nested empty AND beside a real key", { AND: [], bucket: "x" }],
    ] as [string, Record<string, unknown>][])
      await agree(label, "team", "findMany", {
        orderBy: { id: "asc" },
        select: {
          id: true,
          members: { where: nested, orderBy: { id: "asc" }, select: { id: true } },
        },
      });
  });

  it("applies the rule to every read verb that admits a where", async () => {
    for (const operation of ["findFirst", "count", "aggregate"] as const)
      for (const [label, where] of [
        ["vacuous OR", { OR: [{}] }],
        ["empty NOT", { NOT: [{}] }],
      ] as [string, Record<string, unknown>][])
        await agree(
          `${operation} ${label}`,
          "member",
          operation,
          operation === "aggregate"
            ? { where, _count: { _all: true } }
            : operation === "count"
              ? { where }
              : { where, orderBy: { id: "asc" }, select: { id: true } }
        );
  });

  it("applies the rule to a grouped having at depth", async () => {
    for (const [label, having] of [
      ["having NOT around a vacuous OR", { NOT: [{ OR: [] }] }],
      ["having OR whose only arm is an empty AND", { OR: [{ AND: [] }] }],
      ["having OR of an empty arm and a real arm", { OR: [{}, { rank: { _sum: { gt: 0 } } }] }],
      ["having AND of two empty arms", { AND: [{}, {}] }],
      ["having empty AND beside a real key", { AND: [], rank: { _sum: { gt: 0 } } }],
    ] as [string, Record<string, unknown>][])
      await agree(label, "member", "groupBy", {
        by: ["bucket"],
        having,
        orderBy: { bucket: "asc" },
        _count: { _all: true },
        _sum: { rank: true },
      });
  });
});
