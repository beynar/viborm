/**
 * The root row per write operation (pattern-engine-ideal-state.md §3, "Top-level
 * operations are the same rows with no incoming edge").
 */
import { ValidationError } from "@errors";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import {
  arms,
  cells,
  construct,
  constructRaw,
  rows,
  variables,
} from "./harness";

const schema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      score: s.int(),
    })
    .map("root_users");
  const ticket = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
    })
    .map("root_tickets");
  return { user, ticket };
})();

describe("root rows", () => {
  test("create: a fresh row whose spelled key is a literal, cells in payload order", () => {
    const { pattern } = construct(schema, schema.user, "create", {
      data: { id: "u1", name: "n", score: 1 },
    });
    expect(pattern.root).toBe(0);
    expect(rows(pattern)).toEqual([
      {
        id: 0,
        table: "root_users",
        mode: "assert",
        cardinality: "one",
        fresh: true,
        key: ['lit("u1")'],
      },
    ]);
    expect(cells(pattern)).toEqual([
      { row: 0, column: "id", mode: "assert", value: 'lit("u1")' },
      { row: 0, column: "name", mode: "assert", value: 'lit("n")' },
      { row: 0, column: "score", mode: "assert", value: "lit(1)" },
    ]);
    // The key cell IS the key variable: one variable, bound once.
    expect(variables(pattern)).toEqual([
      'v0=lit("u1"):id',
      'v1=lit("n"):name',
      "v2=lit(1):score",
    ]);
  });

  test("create: an omitted database-generated key is bound by the assertion (`returned`)", () => {
    const { pattern } = construct(schema, schema.ticket, "create", {
      data: { title: "t" },
    });
    expect(rows(pattern)[0]!.key).toEqual(["returned(r0.id)"]);
    expect(cells(pattern)).toEqual([
      { row: 0, column: "title", mode: "assert", value: 'lit("t")' },
    ]);
  });

  test("update: a matched row (required, not a decision) whose pinned key member is a literal", () => {
    const { pattern } = construct(schema, schema.user, "update", {
      where: { id: "u1" },
      data: { name: "m" },
    });
    expect(rows(pattern)).toEqual([
      {
        id: 0,
        table: "root_users",
        mode: "match",
        cardinality: "one",
        fresh: false,
        key: ['lit("u1")'],
      },
    ]);
    expect(pattern.rows[0]!.matchIsDecision).toBeUndefined();
    expect(pattern.rows[0]!.predicate).toEqual({
      kind: "scalar",
      column: "id",
      operator: "equals",
      operand: pattern.variables[1],
    });
    expect(cells(pattern)).toEqual([
      { row: 0, column: "name", mode: "assert", value: 'lit("m")' },
    ]);
  });

  test("update: a scalar key change allocates newKey (k′) beside key (k)", () => {
    const { pattern } = construct(schema, schema.user, "update", {
      where: { id: "u1" },
      data: { id: "u2" },
    });
    expect(rows(pattern)[0]).toMatchObject({
      key: ['lit("u1")'],
      newKey: ['lit("u2")'],
    });
    expect(cells(pattern)).toEqual([
      { row: 0, column: "id", mode: "assert", value: 'lit("u2")' },
    ]);
  });

  test("update: a relative assignment is an assert cell with `relative`", () => {
    const { pattern } = construct(schema, schema.user, "update", {
      where: { id: "u1" },
      data: { score: { increment: 2 } },
    });
    expect(cells(pattern)).toEqual([
      {
        row: 0,
        column: "score",
        mode: "assert",
        value: "lit(2)",
        relative: "increment(lit(2))",
      },
    ]);
  });

  test("delete: the matched row in retract mode", () => {
    const { pattern } = construct(schema, schema.user, "delete", {
      where: { id: "u1" },
    });
    expect(rows(pattern)).toEqual([
      {
        id: 0,
        table: "root_users",
        mode: "retract",
        cardinality: "one",
        fresh: false,
        key: ['lit("u1")'],
      },
    ]);
    expect(cells(pattern)).toEqual([]);
  });

  test("upsert: a decision match with both arms present and tagged", () => {
    const { pattern } = construct(schema, schema.user, "upsert", {
      where: { id: "u1" },
      create: { id: "u1", name: "c", score: 0 },
      update: { name: "u" },
    });
    expect(rows(pattern)).toEqual([
      {
        id: 0,
        table: "root_users",
        mode: "match",
        cardinality: "one",
        fresh: false,
        key: ['lit("u1")'],
        decision: true,
      },
      {
        id: 1,
        table: "root_users",
        mode: "assert",
        cardinality: "one",
        fresh: true,
        arm: 1,
        key: ['lit("u1")'],
      },
    ]);
    expect(arms(pattern)).toEqual(["0:found@r0", "1:missing@r0"]);
    // The found arm's cells sit on the unconditional decision row, arm-tagged.
    expect(cells(pattern, 0)).toEqual([
      { row: 0, column: "name", mode: "assert", value: 'lit("u")', arm: 0 },
    ]);
    expect(cells(pattern, 1).map((c) => c.arm)).toEqual([1, 1, 1]);
  });

  test("createMany: N fresh rows; skipDuplicates makes each its own merge with an inert found arm", () => {
    const { pattern } = construct(schema, schema.user, "createMany", {
      data: [
        { id: "a", name: "a", score: 0 },
        { id: "b", name: "b", score: 0 },
      ],
      skipDuplicates: true,
    });
    expect(rows(pattern).map((r) => [r.id, r.fresh, r.arm])).toEqual([
      [0, true, 1],
      [1, true, 3],
    ]);
    expect(arms(pattern)).toEqual([
      "0:found@r0",
      "1:missing@r0",
      "2:found@r1",
      "3:missing@r1",
    ]);
  });

  test("createMany without skipDuplicates: unconditional rows, no arms", () => {
    const { pattern } = construct(schema, schema.user, "createMany", {
      data: [{ id: "a", name: "a", score: 0 }],
    });
    expect(arms(pattern)).toEqual([]);
    expect(rows(pattern)[0]!.arm).toBeUndefined();
  });

  test("updateMany: a set-valued matched row with the predicate, `limit` in the window", () => {
    const { pattern } = construct(schema, schema.user, "updateMany", {
      where: { name: { contains: "x" } },
      data: { score: 5 },
      limit: 3,
    });
    // The set-valued key variable (§7.2): bound by the one match over the predicate.
    expect(rows(pattern)).toEqual([
      {
        id: 0,
        table: "root_users",
        mode: "match",
        cardinality: "set",
        fresh: false,
        key: ["matched(r0.id)"],
      },
    ]);
    expect(pattern.rows[0]!.predicate).toMatchObject({
      kind: "scalar",
      column: "name",
      operator: "contains",
    });
    expect(cells(pattern)).toEqual([
      { row: 0, column: "score", mode: "assert", value: "lit(5)" },
    ]);
    expect(pattern.projection?.window).toEqual({ orderBy: [], take: 3 });
  });

  test("deleteMany: a set-valued row in retract mode", () => {
    const { pattern } = construct(schema, schema.user, "deleteMany", {
      where: { score: { gt: 1 } },
    });
    expect(rows(pattern)[0]).toMatchObject({
      mode: "retract",
      cardinality: "set",
    });
  });

  test("boolean predicates and compound selectors lower to the predicate tree", () => {
    const { pattern } = construct(schema, schema.user, "updateMany", {
      where: {
        OR: [{ name: "a" }, { name: { not: "b" } }],
        NOT: { score: { in: [1, 2] } },
      },
      data: { score: 1 },
    });
    const predicate = pattern.rows[0]!.predicate;
    expect(predicate?.kind).toBe("and");
    if (predicate?.kind !== "and") return;
    expect(predicate.items.map((p) => p.kind)).toEqual(["or", "not"]);
  });

  test("a select projects the named scalars", () => {
    const { pattern } = construct(schema, schema.user, "update", {
      where: { id: "u1" },
      data: { name: "m" },
      select: { id: true, name: true },
    });
    expect(pattern.projection).toMatchObject({ scalars: ["id", "name"] });
  });

  test("construction refuses a missing payload with ValidationError and nothing else", () => {
    expect(() =>
      constructRaw(schema, schema.user, "update", { where: { id: "u1" } })
    ).toThrow(ValidationError);
    expect(() => constructRaw(schema, schema.user, "create", {})).toThrow(
      ValidationError
    );
  });
});
