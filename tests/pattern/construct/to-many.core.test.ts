/**
 * The verbs on a PLURAL edge whose reference the target row holds
 * (user.posts: post stores authorId), the fixed verb order, and the §5
 * collection order of relation keys.
 */
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { arms, cells, construct, references, rows } from "./harness";

const schema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
      profile: s.toOne(() => profile),
    })
    .map("m_users");
  const profile = s
    .model({
      id: s.string().id(),
      userId: s.string().nullable(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("m_profiles");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      views: s.int(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("m_posts");
  return { user, profile, post };
})();

const updateUser = (posts: Record<string, unknown>) =>
  construct(schema, schema.user, "update", {
    where: { id: "u1" },
    data: { posts },
  });

describe("to-many verbs", () => {
  test("connect: one matched row per selector, each asserting its reference cell", () => {
    const { pattern } = updateUser({ connect: [{ id: "p1" }, { id: "p2" }] });
    expect(rows(pattern).map((r) => [r.id, r.mode, r.key])).toEqual([
      [0, "match", ['lit("u1")']],
      [1, "match", ['lit("p1")']],
      [2, "match", ['lit("p2")']],
    ]);
    expect(cells(pattern)).toEqual([
      { row: 1, column: "authorId", mode: "assert", value: 'lit("u1")' },
      { row: 2, column: "authorId", mode: "assert", value: 'lit("u1")' },
    ]);
  });

  test("disconnect [X]: match X ∈ N by selector and membership; retract its cell", () => {
    const { pattern } = updateUser({ disconnect: [{ id: "p1" }] });
    expect(cells(pattern)).toEqual([
      { row: 1, column: "authorId", mode: "match", value: 'lit("u1")' },
      { row: 1, column: "authorId", mode: "retract", value: "lit(null)" },
    ]);
  });

  test("delete [X]: match X ∈ N; retract the row", () => {
    const { pattern } = updateUser({ delete: [{ id: "p1" }] });
    expect(rows(pattern)[1]).toMatchObject({
      mode: "retract",
      key: ['lit("p1")'],
    });
    expect(cells(pattern)).toEqual([
      { row: 1, column: "authorId", mode: "match", value: 'lit("u1")' },
    ]);
  });

  test("set S: a set-valued departure row (N \\ S) then one matched row per member of S", () => {
    const { pattern } = updateUser({ set: [{ id: "p1" }, { id: "p2" }] });
    expect(rows(pattern).map((r) => [r.id, r.mode, r.cardinality])).toEqual([
      [0, "match", "one"],
      [1, "match", "set"],
      [2, "match", "one"],
      [3, "match", "one"],
    ]);
    expect(pattern.rows[1]!.predicate).toMatchObject({ kind: "not" });
    expect(cells(pattern)).toEqual([
      { row: 1, column: "authorId", mode: "match", value: 'lit("u1")' },
      { row: 1, column: "authorId", mode: "retract", value: "lit(null)" },
      { row: 2, column: "authorId", mode: "assert", value: 'lit("u1")' },
      { row: 3, column: "authorId", mode: "assert", value: 'lit("u1")' },
    ]);
  });

  test("set []: is not erased — a departure over all of N and nothing asserted", () => {
    const { pattern } = updateUser({ set: [] });
    expect(rows(pattern)).toHaveLength(2);
    expect(pattern.rows[1]!.predicate).toBeUndefined();
    expect(cells(pattern).map((c) => c.mode)).toEqual(["match", "retract"]);
  });

  test("updateMany: a set-valued member row with the filter; assert over it", () => {
    const { pattern } = updateUser({
      updateMany: { where: { views: { gt: 1 } }, data: { title: "t" } },
    });
    expect(rows(pattern)[1]).toMatchObject({
      mode: "match",
      cardinality: "set",
      key: ["matched(r1.id)"],
    });
    expect(pattern.rows[1]!.predicate).toMatchObject({
      column: "views",
      operator: "gt",
    });
    expect(cells(pattern)).toEqual([
      { row: 1, column: "authorId", mode: "match", value: 'lit("u1")' },
      { row: 1, column: "title", mode: "assert", value: 'lit("t")' },
    ]);
  });

  test("deleteMany: a set-valued member row in retract mode", () => {
    const { pattern } = updateUser({ deleteMany: { views: { lt: 1 } } });
    expect(rows(pattern)[1]).toMatchObject({
      mode: "retract",
      cardinality: "set",
    });
  });

  test("createMany: N fresh rows each linked; skipDuplicates arms each one", () => {
    const { pattern } = updateUser({
      createMany: {
        data: [
          { id: "p1", title: "a", views: 0 },
          { id: "p2", title: "b", views: 0 },
        ],
        skipDuplicates: true,
      },
    });
    expect(
      rows(pattern)
        .slice(1)
        .map((r) => [r.fresh, r.arm])
    ).toEqual([
      [true, 1],
      [true, 3],
    ]);
    expect(arms(pattern)).toHaveLength(4);
    expect(cells(pattern).filter((c) => c.column === "authorId")).toEqual([
      {
        row: 1,
        column: "authorId",
        mode: "assert",
        value: 'lit("u1")',
        arm: 1,
      },
      {
        row: 2,
        column: "authorId",
        mode: "assert",
        value: 'lit("u1")',
        arm: 3,
      },
    ]);
  });

  test("upsert [X]: match by selector and membership; both arms", () => {
    const { pattern } = updateUser({
      upsert: {
        where: { id: "p1" },
        create: { id: "p1", title: "c", views: 0 },
        update: { title: "u" },
      },
    });
    expect(arms(pattern)).toEqual(["0:found@r1", "1:missing@r1"]);
    expect(
      references(pattern).map((r) => [r.holder, r.referenced, r.arm])
    ).toEqual([
      [1, 0, undefined],
      [2, 0, 1],
    ]);
  });
});

describe("order", () => {
  test("verbs run in the fixed order whatever the payload spelled: readers, unbounded, adders", () => {
    const { pattern } = updateUser({
      create: { id: "p9", title: "n", views: 0 },
      connect: { id: "p2" },
      set: [{ id: "p3" }],
      disconnect: { id: "p1" },
    });
    // r1 disconnect target, r2 set departures, r3 set member, r4 connect, r5 create
    expect(
      rows(pattern)
        .slice(1)
        .map((r) => [r.mode, r.cardinality, r.fresh, r.key[0]])
    ).toEqual([
      ["match", "one", false, 'lit("p1")'],
      ["match", "set", false, "matched(r2.id)"],
      ["match", "one", false, 'lit("p3")'],
      ["match", "one", false, 'lit("p2")'],
      ["assert", "one", true, 'lit("p9")'],
    ]);
  });

  test("scalar cells precede every relation; relation keys follow payload key order", () => {
    const { pattern } = construct(schema, schema.user, "update", {
      where: { id: "u1" },
      data: {
        profile: { connect: { id: "pr1" } },
        name: "n",
        posts: { connect: { id: "p1" } },
      },
    });
    expect(cells(pattern).map((c) => `${c.row}.${c.column}`)).toEqual([
      "0.name",
      "1.userId",
      "2.authorId",
    ]);
    expect(rows(pattern).map((r) => r.table)).toEqual([
      "m_users",
      "m_profiles",
      "m_posts",
    ]);
  });

  test("nested records recurse with the same walk", () => {
    const { pattern } = construct(schema, schema.user, "create", {
      data: {
        id: "u1",
        name: "n",
        posts: {
          create: {
            id: "p1",
            title: "t",
            views: 0,
            author: { connect: { id: "u1" } },
          },
        },
      },
    });
    // r0 user (fresh), r1 post (fresh), r2 user (matched by the nested connect)
    expect(rows(pattern).map((r) => [r.table, r.fresh])).toEqual([
      ["m_users", true],
      ["m_posts", true],
      ["m_users", false],
    ]);
    expect(
      references(pattern).map((r) => [r.holder, r.referenced, r.relation])
    ).toEqual([
      [1, 2, "author"],
      [1, 0, "posts"],
    ]);
  });
});
