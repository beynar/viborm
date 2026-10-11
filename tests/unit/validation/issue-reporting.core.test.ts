import { s } from "@schema";
import { getSchemas } from "@schema/schemas";
import v, { parse } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * What a refusal SAYS (types-11, types-14).
 *
 * A union refuses by naming the member the value was written for: the member
 * that read deepest into the value before refusing reports its own issue at
 * its own path. Only when every member refused the value as a whole is there
 * no such member, and the refusal then lists what each member expected.
 *
 * `parse(schema, value, { allIssues: true })` reports every issue of one
 * payload instead of the first: each object member, each list item, and every
 * unknown or missing key.
 */

const issuesOf = (result: { issues?: readonly unknown[] }) => result.issues;

describe("a union names the member the value was written for", () => {
  test("the member that read deepest reports its own issue at its path", () => {
    const schema = v.union([
      v.integer(),
      v.object({ gt: v.integer(), lt: v.integer() }),
    ]);
    expect(issuesOf(parse(schema, { gt: "3" }))).toEqual([
      { message: "Expected integer", path: ["gt"] },
    ]);
    expect(issuesOf(parse(schema, { gt: 1, mdoe: 2 }))).toEqual([
      { message: "Unknown key: mdoe", path: ["mdoe"] },
    ]);
  });

  test("members that share a tag, or omit it, are not dispatched by it", () => {
    const shared = v.union([
      v.object({ kind: v.literal("a"), x: v.integer() }, { partial: false }),
      v.object({ kind: v.literal("a"), y: v.string() }, { partial: false }),
    ]);
    expect(issuesOf(parse(shared, { kind: "a", y: "s" }))).toBeUndefined();
    const omitted = v.union([
      v.object({ kind: v.literal("a"), x: v.integer() }, { partial: false }),
      v.object(
        { kind: v.literal("b"), z: v.integer() },
        { partial: false, omit: ["kind"] }
      ),
    ]);
    expect(issuesOf(parse(omitted, { z: 1 }))).toBeUndefined();
  });

  test("nested unions keep the inner member's path", () => {
    const direction = v.union([
      v.enum(["asc", "desc"]),
      v.object({ sort: v.enum(["asc", "desc"]) }, { partial: false }),
    ]);
    const orderBy = v.union([
      v.object({ email: direction }),
      v.object({ email: direction }, { array: true }),
    ]);
    expect(issuesOf(parse(orderBy, { email: { sort: "up" } }))).toEqual([
      { message: "Expected one of: asc | desc", path: ["email", "sort"] },
    ]);
    expect(issuesOf(parse(orderBy, [{ email: "asc" }, { email: 1 }]))).toEqual([
      {
        message: "Expected one of: asc | desc, or Expected object",
        path: [1, "email"],
      },
    ]);
  });

  test("a tagged union answers with the member its tag names, even at the same depth", () => {
    const variant = (type: string) =>
      v.object({ type: v.literal(type), data: v.object({ n: v.integer() }) });
    const tagged = v.union([variant("post"), variant("video")]);
    // `video` refuses `data` at depth 1, as deep as `post` refuses the tag:
    // only the tag says which member the value was written for.
    expect(issuesOf(parse(tagged, { type: "video", data: 5 }))).toEqual([
      { message: "Expected object", path: ["data"] },
    ]);
    // Members that refused alike keep the issue's own path.
    expect(issuesOf(parse(tagged, { type: "video", dat: {} }))).toEqual([
      { message: "Unknown key: dat", path: ["dat"] },
    ]);
    expect(issuesOf(parse(tagged, { type: "post", data: { n: "1" } }))).toEqual(
      [{ message: "Expected integer", path: ["data", "n"] }]
    );
    expect(parse(tagged, { type: "video", data: { n: 1 } })).toEqual({
      value: { type: "video", data: { n: 1 } },
    });
  });

  test("when every member refused the whole value, it lists each expectation once", () => {
    expect(issuesOf(parse(v.union([v.string(), v.integer()]), true))).toEqual([
      { message: "Expected string, or Expected integer" },
    ]);
    expect(
      issuesOf(parse(v.union([v.integer(), v.integer({ array: true })]), "3"))
    ).toEqual([{ message: "Expected integer, or Expected array" }]);
    expect(issuesOf(parse(v.union([v.integer(), v.integer()]), "3"))).toEqual([
      { message: "Expected integer" },
    ]);
    // Members that said the same thing at the same path keep that path.
    const alike = v.union([
      v.object({ a: v.integer() }),
      v.object({ a: v.integer(), b: v.string() }, { partial: true }),
    ]);
    expect(issuesOf(parse(alike, { a: "x" }))).toEqual([
      { message: "Expected integer", path: ["a"] },
    ]);
  });

  test("no refusal speaks the generic union sentence", () => {
    const { user } = getSchemas({ user: model() });
    const refusals = [
      parse(user.args.findMany, { orderBy: { email: "up" } }),
      parse(user.args.findMany, { where: { age: { gt: "3" } } }),
      parse(user.args.findMany, {
        where: { email: { contains: "x", mdoe: "insensitive" } },
      }),
      parse(user.args.update, {
        where: { id: 1 },
        data: { age: { divide: 0 } },
      }),
    ];
    for (const refusal of refusals) {
      expect(JSON.stringify(refusal.issues)).not.toContain(
        "did not match any union member"
      );
    }
    expect(refusals.map((refusal) => refusal.issues?.[0]?.path)).toEqual([
      ["orderBy", "email"],
      ["where", "age", "gt"],
      ["where", "email", "mdoe"],
      ["data", "age", "divide"],
    ]);
  });
});

function model() {
  return s.model({
    id: s.int().id(),
    email: s.string(),
    age: s.int().nullable(),
    tags: s.string().array(),
  });
}

describe("parse(schema, value, { allIssues: true })", () => {
  const create = getSchemas({ user: model() }).user.core.create;

  test("reports every issue of one payload (p07b: four problems, four issues)", () => {
    const payload = { id: 1, age: "x", tags: 3, nmae: 1 };
    expect(issuesOf(parse(create, payload))).toHaveLength(1);
    expect(issuesOf(parse(create, payload, { allIssues: true }))).toEqual([
      { message: "Unknown key: nmae", path: ["nmae"] },
      { message: "Missing required field: email", path: ["email"] },
      { message: "Expected integer", path: ["age"] },
      { message: "Expected array", path: ["tags"] },
    ]);
  });

  test("reports every refused list item and every member at depth", () => {
    const schema = v.object({
      rows: v.object({ n: v.integer(), s: v.string() }, { array: true }),
    });
    expect(
      issuesOf(
        parse(
          schema,
          {
            rows: [
              { n: 1, s: "a" },
              { n: "x", s: 2 },
              { n: 3, s: 4 },
            ],
          },
          { allIssues: true }
        )
      )
    ).toEqual([
      { message: "Expected integer", path: ["rows", 1, "n"] },
      { message: "Expected string", path: ["rows", 1, "s"] },
      { message: "Expected string", path: ["rows", 2, "s"] },
    ]);
    expect(
      issuesOf(
        parse(v.integer({ array: true }), [1, "a", 2, "b"], { allIssues: true })
      )
    ).toEqual([
      { message: "Expected integer", path: [1] },
      { message: "Expected integer", path: [3] },
    ]);
  });

  test("a union in all-issues mode reports every issue of the member it chose", () => {
    const schema = v.union([
      v.integer(),
      v.object({ gt: v.integer(), lt: v.integer() }),
    ]);
    expect(
      issuesOf(parse(schema, { gt: "a", lt: "b" }, { allIssues: true }))
    ).toEqual([
      { message: "Expected integer", path: ["gt"] },
      { message: "Expected integer", path: ["lt"] },
    ]);
  });

  test("scales to a wide realistic payload: one issue per broken field", () => {
    const fields = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`f${index}`, s.int()])
    );
    const wide = getSchemas({ wide: s.model({ id: s.int().id(), ...fields }) })
      .wide.core.create;
    const payload = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`f${index}`, `bad${index}`])
    );
    const issues = issuesOf(
      parse(wide, { id: 1, ...payload }, { allIssues: true })
    );
    expect(issues).toHaveLength(60);
    expect(issuesOf(parse(wide, { id: 1, ...payload }))).toHaveLength(1);
  });

  test("a refused default and an unmet requirement are each one more issue", () => {
    // A default is an ordinary field value: one that fails its own rules is
    // refused at its key, after the requirement the payload already missed.
    for (const partial of [true, false]) {
      const schema = v.object(
        {
          n: v.integer({ default: () => 1.5 }),
          m: v.integer({ optional: true }),
        },
        { partial, nonEmpty: true }
      );
      const refusedDefault = { message: "Expected integer", path: ["n"] };
      expect(issuesOf(parse(schema, {}, { allIssues: true }))).toEqual([
        { message: "Object cannot be empty" },
        refusedDefault,
      ]);
      expect(issuesOf(parse(schema, {}))).toEqual([
        { message: "Object cannot be empty" },
      ]);
      expect(issuesOf(parse(schema, { m: 1 }))).toEqual([refusedDefault]);
    }
  });

  test("the mode is scoped to its call: a later default parse reports one issue", () => {
    const payload = { id: 1, age: "x", tags: 3, nmae: 1 };
    parse(create, payload, { allIssues: true });
    expect(issuesOf(parse(create, payload))).toHaveLength(1);
  });
});
