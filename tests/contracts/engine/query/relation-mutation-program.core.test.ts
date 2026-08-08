import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  buildParsedRelationPrograms,
  buildRelationMutationProgram,
  partitionModelData,
} from "@query-engine/builders/relation-mutation-parser";
import { createQueryScope, getRelationInfo } from "@query-engine/context";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.int().id(),
  name: s.string(),
  posts: s.oneToMany(() => post),
});

const post = s.model({
  id: s.int().id(),
  title: s.string(),
  authorId: s.int().nullable(),
  author: s
    .manyToOne(() => user)
    .fields("authorId")
    .references("id")
    .optional(),
});

const adapter = new PostgresAdapter();

function requireRelationInfo(
  model: typeof user | typeof post,
  relationName: string
) {
  const relationInfo = getRelationInfo(
    createQueryScope(adapter, model),
    relationName
  );
  if (!relationInfo) throw new Error(`Expected relation '${relationName}'`);
  return relationInfo;
}

describe("relation mutation program", () => {
  test("uses fixed kind order while preserving arrays and duplicate entries", () => {
    const relationInfo = requireRelationInfo(user, "posts");
    const firstCreate = { id: 1, title: "first" };
    const secondCreate = { id: 2, title: "second" };
    const duplicate = { where: { id: 3 }, create: { id: 3, title: "first" } };
    const duplicateAgain = {
      where: { id: 3 },
      create: { id: 3, title: "second" },
    };

    const program = buildRelationMutationProgram(relationInfo, {
      createMany: {
        data: [firstCreate, secondCreate],
        skipDuplicates: true,
      },
      create: [firstCreate, secondCreate],
      connect: [{ id: 2 }, { id: 1 }],
      deleteMany: [{ title: "second" }, { title: "first" }],
      updateMany: [
        { where: { title: "first" }, data: { title: { set: "one" } } },
        { data: { title: { set: "all" } } },
      ],
      set: [],
      connectOrCreate: [duplicate, duplicateAgain],
      upsert: [
        {
          where: { id: 8 },
          create: { id: 8, title: "new" },
          update: { title: { set: "updated" } },
        },
      ],
      update: [
        {
          where: { id: 7 },
          data: { title: { set: "updated" } },
        },
      ],
      delete: [{ id: 6 }, { id: 5 }],
      disconnect: [{ id: 5 }, { id: 4 }],
    });

    expect(program?.entries.map((entry) => entry.kind)).toEqual([
      "disconnect",
      "delete",
      "update",
      "upsert",
      "connectOrCreate",
      "set",
      "updateMany",
      "deleteMany",
      "connect",
      "create",
      "createMany",
    ]);
    expect(
      program?.entries.find((entry) => entry.kind === "connectOrCreate")
    ).toEqual({ kind: "connectOrCreate", items: [duplicate, duplicateAgain] });
    expect(program?.entries.find((entry) => entry.kind === "set")).toEqual({
      kind: "set",
      targets: [],
    });
    expect(
      program?.entries.find((entry) => entry.kind === "createMany")
    ).toEqual({
      kind: "createMany",
      rows: [firstCreate, secondCreate],
      skipDuplicates: true,
    });
  });

  test("drops false to-one no-op arms and keeps the canonical update filter", () => {
    const relationInfo = requireRelationInfo(post, "author");
    const transformedData = { name: { set: "Ada" } };
    const program = buildRelationMutationProgram(relationInfo, {
      disconnect: false,
      delete: false,
      update: {
        where: { name: { contains: "A" } },
        data: transformedData,
      },
      upsert: {
        create: { id: 2, name: "Grace" },
        update: { name: { set: "Grace" } },
      },
    });

    expect(program?.entries).toEqual([
      {
        kind: "update",
        items: [
          {
            target: {
              kind: "correlated",
              filter: { name: { contains: "A" } },
            },
            data: transformedData,
          },
        ],
      },
      {
        kind: "upsert",
        items: [
          {
            target: { kind: "correlated" },
            create: { id: 2, name: "Grace" },
            update: { name: { set: "Grace" } },
          },
        ],
      },
    ]);
  });

  test("normalizes to-many update and upsert targets without changing data", () => {
    const relationInfo = requireRelationInfo(user, "posts");
    const updateData = { title: { set: "updated" } };
    const upsertUpdate = { title: { set: "existing" } };
    const program = buildRelationMutationProgram(relationInfo, {
      update: { where: { id: 1 }, data: updateData },
      upsert: {
        where: { id: 2 },
        create: { id: 2, title: "new" },
        update: upsertUpdate,
      },
    });

    expect(program?.entries).toEqual([
      {
        kind: "update",
        items: [
          {
            target: { kind: "unique", where: { id: 1 } },
            data: updateData,
          },
        ],
      },
      {
        kind: "upsert",
        items: [
          {
            target: { kind: "unique", where: { id: 2 } },
            create: { id: 2, title: "new" },
            update: upsertUpdate,
          },
        ],
      },
    ]);
  });

  test("partitions relation payloads without interpreting mutation kinds", () => {
    const ctx = createQueryScope(adapter, user);
    const unknownPayload = { futureMutation: { id: 1 } };
    const partitioned = partitionModelData(ctx, {
      id: 1,
      name: "Ada",
      posts: unknownPayload,
    });

    expect(partitioned.scalarData).toEqual({ id: 1, name: "Ada" });
    expect(partitioned.relationPayloads.posts?.payload).toBe(unknownPayload);
    const posts = partitioned.relationPayloads.posts;
    if (!posts) throw new Error("Expected posts relation payload");
    expect(() =>
      buildRelationMutationProgram(posts.relationInfo, posts.payload)
    ).toThrow("Unsupported nested write operation on relation 'posts'");
  });

  test("builds programs for an already parsed model data tree", () => {
    const ctx = createQueryScope(adapter, user);
    const transformedData = { title: { set: "parsed" } };
    const parsed = buildParsedRelationPrograms(ctx, {
      id: 1,
      posts: {
        update: { where: { id: 2 }, data: transformedData },
      },
    });

    expect(parsed.scalarData).toEqual({ id: 1 });
    expect(parsed.relations.posts?.entries).toEqual([
      {
        kind: "update",
        items: [
          {
            target: { kind: "unique", where: { id: 2 } },
            data: transformedData,
          },
        ],
      },
    ]);
  });
});
