/**
 * What admission does with `$through`, on the slot a declared model holds and on
 * every other: the operation schemas alone, with no database under them.
 */

import { s } from "@schema";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

const AT_LEAST_ONE = /at least one truthy/;
const UNKNOWN_KEY = /Unknown key/;
const NO_LINK_ROW_ON_A_WALK = /not available on a recurse walk/;
const NO_FILTER_ON_A_WALK = /cannot filter a recurse walk/;
const NOT_AN_OBJECT = /must be an object/;
const MEMBER_COLUMN = /filled from the two rows/;
const NOT_A_COLUMN = /not a column/;

const schema = () => {
  const link = s
    .model({
      childId: s.string(),
      parentId: s.string(),
      role: s.string(),
      rank: s.int().default(1),
      child: s
        .toOne(() => node)
        .fields("childId")
        .references("id"),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
    })
    .id(["childId", "parentId"]);
  const node = s.model({
    id: s.string().id(),
    parents: s
      .toMany(() => node)
      .name("graph")
      .through(() => link)
      .source("child")
      .target("parent"),
    children: s.toMany(() => node).name("graph"),
    tags: s.toMany(() => tag),
  });
  const tag = s.model({ id: s.string().id(), nodes: s.toMany(() => node) });
  return { link, node, tag };
};

const models = schema();
const registry = createSchemaRegistry(models);
const args = registry.getModelSchemas(models.node).args as Record<string, any>;
const issues = (operation: string, value: unknown) => {
  const result = parse(args[operation], value);
  return "issues" in result && result.issues
    ? result.issues
        .map((issue: { message: string }) => issue.message)
        .join("; ")
    : "";
};
const output = (operation: string, value: unknown) => {
  const result = parse(args[operation], value) as { value: any };
  return result.value;
};

describe("reading", () => {
  test("true is every projectable scalar, false asks for nothing", () => {
    const read = output("findMany", {
      select: { parents: { select: { id: true, $through: true } } },
    });
    expect(read.select.parents.select.$through).toEqual({
      select: {
        childId: true,
        parentId: true,
        role: true,
        rank: true,
      },
    });
    const none = output("findMany", {
      select: { parents: { select: { id: true, $through: false } } },
    });
    expect(none.select.parents.select.$through).toBe(false);
  });

  test("a stated select names scalars, and at least one", () => {
    expect(
      issues("findMany", {
        select: { parents: { select: { $through: { select: {} } } } },
      })
    ).toMatch(AT_LEAST_ONE);
    expect(
      issues("findMany", {
        select: {
          parents: { select: { $through: { select: { child: true } } } },
        },
      })
    ).toMatch(UNKNOWN_KEY);
  });

  test("a walk refuses it by name, in select and include", () => {
    for (const clause of ["select", "include"])
      expect(
        issues("findMany", {
          select: {
            parents: {
              recurse: { depth: false },
              [clause]: { $through: true },
            },
          },
        })
      ).toMatch(NO_LINK_ROW_ON_A_WALK);
  });

  test("a string or generated junction has no such key", () => {
    expect(
      issues("findMany", {
        select: { tags: { select: { id: true, $through: true } } },
      })
    ).toMatch(UNKNOWN_KEY);
  });
});

describe("filtering", () => {
  test("each quantifier takes it beside the target's own conditions", () => {
    for (const quantifier of ["some", "none", "every"])
      expect(
        issues("findMany", {
          where: {
            parents: { [quantifier]: { id: "x", $through: { role: "o" } } },
          },
        })
      ).toBe("");
  });

  test("a walk refuses it by name on every quantifier, read twice", () => {
    for (const quantifier of ["some", "some", "every"])
      expect(
        issues("findMany", {
          where: {
            parents: {
              recurse: { depth: false },
              [quantifier]: { $through: { role: "o" } },
            },
          },
        })
      ).toMatch(NO_FILTER_ON_A_WALK);
  });

  test("a nested where takes it, on each read of the schema", () => {
    const node = {
      select: {
        parents: { where: { $through: { role: "o" } }, select: { id: true } },
      },
    };
    expect(issues("findMany", node)).toBe("");
    expect(issues("findMany", node)).toBe("");
    expect(
      issues("findMany", {
        where: { tags: { some: { $through: { role: "o" } } } },
      })
    ).toMatch(UNKNOWN_KEY);
  });
});

describe("writing", () => {
  const connect = ($through: unknown) => ({
    where: { id: "a" },
    data: { parents: { connect: { id: "b", $through } } },
  });

  test("stated columns pass; what is unstated stays unstated", () => {
    const admitted = output("update", connect({ role: "owner" }));
    expect(admitted.data.parents.connect[0].$through).toEqual({
      role: "owner",
    });
    const skipped = output(
      "update",
      connect({ role: "owner", rank: undefined })
    );
    expect(skipped.data.parents.connect[0].$through).toEqual({ role: "owner" });
  });

  test("a non-object, a member and an unknown column are each refused", () => {
    expect(issues("update", connect("owner"))).toMatch(NOT_AN_OBJECT);
    expect(issues("update", connect({ childId: "x" }))).toMatch(MEMBER_COLUMN);
    expect(issues("update", connect({ nope: 1 }))).toMatch(NOT_A_COLUMN);
    expect(issues("update", connect({ rank: "high" }))).toContain("");
  });

  test("a value the column refuses names its path; a bad target stops first", () => {
    const refused = parse(args.update, connect({ rank: "high" })) as {
      issues?: { path?: unknown }[];
    };
    expect(refused.issues?.length).toBeGreaterThan(0);
    expect(
      issues("update", {
        where: { id: "a" },
        data: { parents: { connect: { nope: 1, $through: { role: "o" } } } },
      })
    ).not.toBe("");
  });

  test("a target that is no object is its own schema's refusal", () => {
    expect(
      issues("update", {
        where: { id: "a" },
        data: { parents: { connect: "b" } },
      })
    ).not.toBe("");
  });

  test("every verb that links takes it; every slot without one refuses", () => {
    const $through = { role: "o" };
    for (const parents of [
      { create: { id: "c", $through } },
      {
        connectOrCreate: {
          where: { id: "c" },
          create: { id: "c" },
          $through,
        },
      },
      { set: [{ id: "c", $through }] },
    ])
      expect(issues("update", { where: { id: "a" }, data: { parents } })).toBe(
        ""
      );
    expect(
      issues("update", {
        where: { id: "a" },
        data: { tags: { connect: { id: "c", $through } } },
      })
    ).not.toBe("");
    expect(
      issues("create", {
        data: { id: "a", parents: { connect: { id: "c", $through } } },
      })
    ).toBe("");
  });
});
