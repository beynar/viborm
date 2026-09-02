/**
 * The eleven verbs on a SINGULAR edge, for both places a row-held reference can
 * live: the parent row (post.author stores authorId) and the target row
 * (user.profile: profile stores userId). The sugar row is the same; the cell
 * map decides which row the cells land on.
 */
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import {
  arms,
  cells,
  construct,
  constructRaw,
  references,
  rows,
} from "./harness";

const schema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
      profile: s.toOne(() => profile),
    })
    .map("o_users");
  const profile = s
    .model({
      id: s.string().id(),
      bio: s.string(),
      userId: s.string().nullable(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("o_profiles");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("o_posts");
  return { user, profile, post };
})();

const sharedKey = (() => {
  const account = s
    .model({ id: s.string().id(), settings: s.toOne(() => settings) })
    .map("o_accounts");
  const settings = s
    .model({
      accountId: s.string().id(),
      theme: s.string(),
      account: s
        .toOne(() => account)
        .fields("accountId")
        .references("id"),
    })
    .map("o_settings");
  return { account, settings };
})();

const updatePost = (author: Record<string, unknown>) =>
  construct(schema, schema.post, "update", {
    where: { id: "p1" },
    data: { author },
  });

const updateUser = (profile: Record<string, unknown>) =>
  construct(schema, schema.user, "update", {
    where: { id: "u1" },
    data: { profile },
  });

describe("to-one, reference held by the parent row", () => {
  test("connect: match X by selector; assert the parent's reference cells", () => {
    const { pattern } = updatePost({ connect: { id: "u1" } });
    expect(rows(pattern).map((r) => [r.id, r.table, r.mode, r.key])).toEqual([
      [0, "o_posts", "match", ['lit("p1")']],
      [1, "o_users", "match", ['lit("u1")']],
    ]);
    expect(references(pattern)).toEqual([
      {
        holder: 0,
        referenced: 1,
        columns: ["authorId->id"],
        relation: "author",
      },
    ]);
    // The reference cell's value IS the target's key variable (D2).
    expect(cells(pattern)).toEqual([
      { row: 0, column: "authorId", mode: "assert", value: 'lit("u1")' },
    ]);
    expect(pattern.cells[0]!.value).toBe(pattern.rows[1]!.key[0]);
  });

  test("create: a fresh target; the parent's cells take its key", () => {
    const { pattern } = updatePost({ create: { id: "u2", name: "n" } });
    expect(rows(pattern)[1]).toMatchObject({
      table: "o_users",
      fresh: true,
      key: ['lit("u2")'],
    });
    expect(cells(pattern, 0)).toEqual([
      { row: 0, column: "authorId", mode: "assert", value: 'lit("u2")' },
    ]);
  });

  test("disconnect: true retracts the parent's cells with no target row", () => {
    const { pattern } = updatePost({ disconnect: true });
    expect(rows(pattern)).toHaveLength(1);
    expect(references(pattern)).toEqual([]);
    expect(cells(pattern)).toEqual([
      { row: 0, column: "authorId", mode: "retract", value: "lit(null)" },
    ]);
  });

  test("delete: true matches the member by membership, retracts it and the parent's cells", () => {
    const { pattern } = updatePost({ delete: true });
    expect(rows(pattern)[1]).toMatchObject({
      table: "o_users",
      mode: "retract",
      cardinality: "one",
      key: ["matched(r1.id)"],
    });
    expect(cells(pattern)).toEqual([
      { row: 0, column: "authorId", mode: "match", value: "matched(r1.id)" },
      { row: 0, column: "authorId", mode: "retract", value: "lit(null)" },
    ]);
  });

  test("update: match X ∈ N (with the envelope's filter), assert its scalar cells", () => {
    const { pattern } = updatePost({
      update: { where: { name: "old" }, data: { name: "new" } },
    });
    expect(rows(pattern)[1]).toMatchObject({
      mode: "match",
      cardinality: "one",
    });
    expect(pattern.rows[1]!.predicate).toMatchObject({
      kind: "scalar",
      column: "name",
      operator: "equals",
    });
    expect(cells(pattern)).toEqual([
      { row: 0, column: "authorId", mode: "match", value: "matched(r1.id)" },
      { row: 1, column: "name", mode: "assert", value: 'lit("new")' },
    ]);
  });

  test("upsert: both arms present; found updates the decision row, missing creates and links", () => {
    const { pattern } = updatePost({
      upsert: { create: { id: "u9", name: "c" }, update: { name: "u" } },
    });
    expect(rows(pattern)).toEqual([
      expect.objectContaining({ id: 0, table: "o_posts" }),
      expect.objectContaining({
        id: 1,
        table: "o_users",
        mode: "match",
        decision: true,
      }),
      expect.objectContaining({ id: 2, table: "o_users", fresh: true, arm: 1 }),
    ]);
    expect(arms(pattern)).toEqual(["0:found@r1", "1:missing@r1"]);
    expect(cells(pattern)).toEqual([
      { row: 0, column: "authorId", mode: "match", value: "matched(r1.id)" },
      { row: 1, column: "name", mode: "assert", value: 'lit("u")', arm: 0 },
      { row: 2, column: "id", mode: "assert", value: 'lit("u9")', arm: 1 },
      { row: 2, column: "name", mode: "assert", value: 'lit("c")', arm: 1 },
      {
        row: 0,
        column: "authorId",
        mode: "assert",
        value: 'lit("u9")',
        arm: 1,
      },
    ]);
  });

  test("connectOrCreate: found asserts the reference to the decision row; missing creates", () => {
    const { pattern } = updatePost({
      connectOrCreate: { where: { id: "u1" }, create: { id: "u1", name: "c" } },
    });
    expect(arms(pattern)).toEqual(["0:found@r1", "1:missing@r1"]);
    expect(references(pattern)).toEqual([
      {
        holder: 0,
        referenced: 1,
        columns: ["authorId->id"],
        arm: 0,
        relation: "author",
      },
      {
        holder: 0,
        referenced: 2,
        columns: ["authorId->id"],
        arm: 1,
        relation: "author",
      },
    ]);
  });
});

describe("to-one composition (vacate?, supplier, modify?)", () => {
  test("connect + update: ONE target row, located by the supplier's selector, then modified", () => {
    const { pattern } = updatePost({
      connect: { id: "u1" },
      update: { name: "renamed" },
    });
    expect(rows(pattern)).toHaveLength(2);
    expect(cells(pattern)).toEqual([
      { row: 0, column: "authorId", mode: "assert", value: 'lit("u1")' },
      { row: 1, column: "name", mode: "assert", value: 'lit("renamed")' },
    ]);
  });

  test("disconnect + create: vacate first, then the fresh supplier", () => {
    const { pattern } = updatePost({
      disconnect: true,
      create: { id: "u2", name: "n" },
    });
    expect(cells(pattern, 0)).toEqual([
      { row: 0, column: "authorId", mode: "retract", value: "lit(null)" },
      { row: 0, column: "authorId", mode: "assert", value: 'lit("u2")' },
    ]);
  });

  test("connectOrCreate + update: the modify lands on each arm's row, at most one per arm", () => {
    // The public lattice refuses this pair today; the composition owner names
    // it (`membershipCapture`), so construction is exercised on the canonical
    // validated shape directly.
    const { pattern } = constructRaw(schema, schema.post, "update", {
      where: { id: "p1" },
      data: {
        author: {
          connectOrCreate: {
            where: { id: "u1" },
            create: { id: "u1", name: "c" },
          },
          update: { data: { name: { set: "m" } } },
        },
      },
    });
    const byArm = (arm: number) =>
      rows(pattern).filter((r) => r.arm === arm || (arm === 0 && r.decision));
    expect(byArm(0)).toHaveLength(1);
    expect(byArm(1)).toHaveLength(1);
    expect(
      cells(pattern).filter((c) => c.column === "name" && c.mode === "assert")
    ).toEqual([
      { row: 2, column: "name", mode: "assert", value: 'lit("c")', arm: 1 },
      { row: 1, column: "name", mode: "assert", value: 'lit("m")', arm: 0 },
      { row: 2, column: "name", mode: "assert", value: 'lit("m")', arm: 1 },
    ]);
  });
});

describe("to-one, reference held by the target row", () => {
  test("create: the fresh target's cells take the parent's key", () => {
    const { pattern } = updateUser({ create: { id: "pr1", bio: "b" } });
    expect(references(pattern)).toEqual([
      {
        holder: 1,
        referenced: 0,
        columns: ["userId->id"],
        relation: "profile",
      },
    ]);
    expect(cells(pattern, 1)).toEqual([
      { row: 1, column: "id", mode: "assert", value: 'lit("pr1")' },
      { row: 1, column: "bio", mode: "assert", value: 'lit("b")' },
      { row: 1, column: "userId", mode: "assert", value: 'lit("u1")' },
    ]);
  });

  test("disconnect: true matches the member by membership and clears ITS cells", () => {
    const { pattern } = updateUser({ disconnect: true });
    expect(rows(pattern)[1]).toMatchObject({
      table: "o_profiles",
      mode: "match",
    });
    expect(cells(pattern)).toEqual([
      { row: 1, column: "userId", mode: "match", value: 'lit("u1")' },
      { row: 1, column: "userId", mode: "retract", value: "lit(null)" },
    ]);
  });

  test("delete: true retracts the member row; the parent holds nothing to clear", () => {
    const { pattern } = updateUser({ delete: true });
    expect(rows(pattern)[1]).toMatchObject({ mode: "retract" });
    expect(cells(pattern)).toEqual([
      { row: 1, column: "userId", mode: "match", value: 'lit("u1")' },
    ]);
  });

  test("connect: match by selector; the target's cells take the parent's key", () => {
    const { pattern } = updateUser({ connect: { id: "pr2" } });
    expect(cells(pattern)).toEqual([
      { row: 1, column: "userId", mode: "assert", value: 'lit("u1")' },
    ]);
  });

  test("under a fresh parent the target's cell takes the parent's literal key", () => {
    const { pattern } = construct(schema, schema.user, "create", {
      data: {
        id: "u3",
        name: "n",
        profile: { create: { id: "pr3", bio: "b" } },
      },
    });
    expect(cells(pattern, 1).at(-1)).toEqual({
      row: 1,
      column: "userId",
      mode: "assert",
      value: 'lit("u3")',
    });
  });
});

describe("key transition through a reference the row itself holds", () => {
  test("a connect whose holder columns are the row's key allocates newKey from the target's key", () => {
    const { pattern } = construct(sharedKey, sharedKey.settings, "update", {
      where: { accountId: "a1" },
      data: { account: { connect: { id: "a2" } } },
    });
    expect(rows(pattern)[0]).toMatchObject({
      key: ['lit("a1")'],
      newKey: ['lit("a2")'],
    });
    expect(pattern.rows[0]!.newKey![0]).toBe(pattern.rows[1]!.key[0]);
  });

  test("a merge supplying that key is recorded as the shared-key ambiguity refusal", () => {
    const { deferredRefusals } = construct(
      sharedKey,
      sharedKey.settings,
      "create",
      {
        data: {
          theme: "t",
          account: {
            connectOrCreate: { where: { id: "a" }, create: { id: "a" } },
          },
        },
      }
    );
    expect(deferredRefusals.map((r) => r.kind)).toEqual([
      "sharedKeyAmbiguousArm",
      "sharedKeyAmbiguousArm",
    ]);
  });
});
