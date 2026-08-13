import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  buildParsedRelationPrograms,
  buildRelationMutationProgram,
  partitionModelData,
} from "@query-engine/builders/relation-mutation-parser";
import { createQueryScope, getRelationInfo } from "@query-engine/context";
import { hydrateSchemaNames, s } from "@schema";
import { validateSchemaOrThrow } from "@schema/validation";
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

const polymorphicSchema = (() => {
  const article = s.model({ id: s.int().id(), title: s.string() });
  const video = s.model({ id: s.int().id(), title: s.string() });
  const reaction = s.model({
    id: s.int().id(),
    subject: s
      .polymorphic({ article: () => article, video: () => video })
      .optional(),
  });
  return { article, video, reaction };
})();

hydrateSchemaNames(polymorphicSchema);
validateSchemaOrThrow(polymorphicSchema);

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
    ).toEqual({
      kind: "connectOrCreate",
      items: [
        {
          where: duplicate.where,
          create: { parsed: duplicate.create, source: undefined },
        },
        {
          where: duplicateAgain.where,
          create: { parsed: duplicateAgain.create, source: undefined },
        },
      ],
    });
    expect(program?.entries.find((entry) => entry.kind === "set")).toEqual({
      kind: "set",
      targets: [],
    });
    expect(
      program?.entries.find((entry) => entry.kind === "createMany")
    ).toEqual({
      kind: "createMany",
      rows: [
        { parsed: firstCreate, source: undefined },
        { parsed: secondCreate, source: undefined },
      ],
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
            data: { parsed: transformedData, source: undefined },
          },
        ],
      },
      {
        kind: "upsert",
        items: [
          {
            target: { kind: "correlated" },
            create: {
              parsed: { id: 2, name: "Grace" },
              source: undefined,
            },
            update: {
              parsed: { name: { set: "Grace" } },
              source: undefined,
            },
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
            data: { parsed: updateData, source: undefined },
          },
        ],
      },
      {
        kind: "upsert",
        items: [
          {
            target: { kind: "unique", where: { id: 2 } },
            create: {
              parsed: { id: 2, title: "new" },
              source: undefined,
            },
            update: { parsed: upsertUpdate, source: undefined },
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
    // ONE collection, one entry per relation key, each entry naming its own kind —
    // so the shape assertion covers the arm and the name, not just the entries.
    expect(parsed.relations.map((entry) => [entry.kind, entry.name])).toEqual([
      ["ordinary", "posts"],
    ]);
    const posts = parsed.relations.find((entry) => entry.name === "posts");
    if (posts?.kind !== "ordinary") throw new Error("Expected posts program");
    expect(posts.program.entries).toEqual([
      {
        kind: "update",
        items: [
          {
            target: { kind: "unique", where: { id: 2 } },
            data: { parsed: transformedData, source: undefined },
          },
        ],
      },
    ]);
  });

  test("keeps each record arm beside its exact source record", () => {
    const relationInfo = requireRelationInfo(user, "posts");
    const sourceCreate = { id: 1, title: "source create" };
    const sourceCreateMany = { id: 2, title: "source createMany" };
    const sourceConnectOrCreate = { id: 3, title: "source adopt" };
    const sourceUpdate = { title: "source update" };
    const sourceUpdateMany = { title: "source updateMany" };
    const sourceUpsertCreate = { id: 4, title: "source upsert create" };
    const sourceUpsertUpdate = { title: "source upsert update" };
    const program = buildRelationMutationProgram(
      relationInfo,
      {
        create: { id: 1, title: "parsed create" },
        createMany: { data: [{ id: 2, title: "parsed createMany" }] },
        connectOrCreate: {
          where: { id: 3 },
          create: { id: 3, title: "parsed adopt" },
        },
        update: {
          where: { id: 1 },
          data: { title: { set: "parsed update" } },
        },
        updateMany: {
          where: { id: 1 },
          data: { title: { set: "parsed updateMany" } },
        },
        upsert: {
          where: { id: 4 },
          create: { id: 4, title: "parsed upsert create" },
          update: { title: { set: "parsed upsert update" } },
        },
      },
      {
        create: sourceCreate,
        createMany: { data: [sourceCreateMany] },
        connectOrCreate: {
          where: { id: 3 },
          create: sourceConnectOrCreate,
        },
        update: { where: { id: 1 }, data: sourceUpdate },
        updateMany: { where: { id: 1 }, data: sourceUpdateMany },
        upsert: {
          where: { id: 4 },
          create: sourceUpsertCreate,
          update: sourceUpsertUpdate,
        },
      }
    );

    const entries = program?.entries ?? [];
    expect(
      entries.find((entry) => entry.kind === "create")?.items[0]?.source
    ).toBe(sourceCreate);
    expect(
      entries.find((entry) => entry.kind === "createMany")?.rows[0]?.source
    ).toBe(sourceCreateMany);
    expect(
      entries.find((entry) => entry.kind === "connectOrCreate")?.items[0]
        ?.create.source
    ).toBe(sourceConnectOrCreate);
    expect(
      entries.find((entry) => entry.kind === "update")?.items[0]?.data.source
    ).toBe(sourceUpdate);
    expect(
      entries.find((entry) => entry.kind === "updateMany")?.items[0]?.data
        .source
    ).toBe(sourceUpdateMany);
    const upsert = entries.find((entry) => entry.kind === "upsert");
    expect(upsert?.items[0]?.create.source).toBe(sourceUpsertCreate);
    expect(upsert?.items[0]?.update.source).toBe(sourceUpsertUpdate);
  });

  test("projects bare and wrapped to-one update sources from the canonical form", () => {
    const relationInfo = requireRelationInfo(post, "author");
    const bareSource = { name: "bare source" };
    const wrappedSource = { name: "wrapped source" };
    const bare = buildRelationMutationProgram(
      relationInfo,
      { update: { data: { name: { set: "parsed bare" } } } },
      { update: bareSource }
    );
    const wrapped = buildRelationMutationProgram(
      relationInfo,
      {
        update: {
          where: { name: { contains: "A" } },
          data: { name: { set: "parsed wrapped" } },
        },
      },
      {
        update: {
          where: { name: { contains: "A" } },
          data: wrappedSource,
        },
      }
    );

    expect(bare?.entries[0]?.kind).toBe("update");
    expect(
      bare?.entries[0]?.kind === "update"
        ? bare.entries[0].items[0]?.data.source
        : undefined
    ).toBe(bareSource);
    expect(
      wrapped?.entries[0]?.kind === "update"
        ? wrapped.entries[0].items[0]?.data.source
        : undefined
    ).toBe(wrappedSource);
  });

  test("keeps direct polymorphic record provenance through concrete-edge lowering", () => {
    const ctx = createQueryScope(adapter, polymorphicSchema.reaction);
    const sourceCreate = { id: 9, title: "source" };
    const parsed = buildParsedRelationPrograms(
      ctx,
      {
        subject: {
          create: {
            type: "article",
            data: { id: 9, title: "parsed" },
          },
        },
      },
      {
        subject: {
          create: { type: "article", data: sourceCreate },
        },
      }
    );
    const mutation = parsed.relations[0];
    expect(mutation?.kind).toBe("polymorphicTarget");
    const create =
      mutation?.kind === "polymorphicTarget"
        ? mutation.program.entries[0]
        : undefined;
    expect(
      create?.kind === "create" ? create.items[0]?.source : undefined
    ).toBe(sourceCreate);
  });
});
