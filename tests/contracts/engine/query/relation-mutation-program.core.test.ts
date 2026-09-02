import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  buildParsedRelationPrograms,
  buildRelationMutationProgram,
  partitionModelData,
} from "@query-engine/builders/relation-mutation-parser";
import { lookupRelation } from "@query-engine/context";
import { s } from "@schema";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.int().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.int().id(),
  title: s.string(),
  authorId: s.int().nullable(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});

const adapter = new PostgresAdapter();

prepareSchema({ user, post });

const polymorphicSchema = (() => {
  const article = s.model({ id: s.int().id(), title: s.string() });
  const video = s.model({ id: s.int().id(), title: s.string() });
  const reaction = s.model({
    id: s.int().id(),
    subject: s.toOne({ article: () => article, video: () => video }).optional(),
  });
  return { article, video, reaction };
})();

prepareSchema(polymorphicSchema);

const collectionSchema = (() => {
  const post = s.model({ id: s.int().id(), title: s.string() });
  const video = s.model({ id: s.int().id(), title: s.string() });
  const board = s.model({
    id: s.int().id(),
    items: s.toMany({ post: () => post, video: () => video }),
  });
  return { post, video, board };
})();

prepareSchema(collectionSchema);

/** The one collection arm of a parsed board payload. */
function collectionArm(payload: unknown, source?: unknown) {
  const ctx = scopeFor(adapter, collectionSchema.board);
  const parsed = buildParsedRelationPrograms(
    ctx,
    { items: payload },
    source === undefined ? undefined : { items: source }
  );
  const arm = parsed.relations[0];
  if (arm?.kind !== "polymorphicCollection") {
    throw new Error("expected a polymorphic collection arm");
  }
  return arm;
}

function requireRelationInfo(
  model: typeof user | typeof post,
  relationName: string
) {
  const relationRef = lookupRelation(scopeFor(adapter, model), relationName);
  if (!relationRef) throw new Error(`Expected relation '${relationName}'`);
  return relationRef;
}

describe("relation mutation program", () => {
  test("uses fixed kind order while preserving arrays and duplicate entries", () => {
    const relationRef = requireRelationInfo(user, "posts");
    const firstCreate = { id: 1, title: "first" };
    const secondCreate = { id: 2, title: "second" };
    const duplicate = { where: { id: 3 }, create: { id: 3, title: "first" } };
    const duplicateAgain = {
      where: { id: 3 },
      create: { id: 3, title: "second" },
    };

    const program = buildRelationMutationProgram(relationRef, {
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
    const relationRef = requireRelationInfo(post, "author");
    const transformedData = { name: { set: "Ada" } };
    const program = buildRelationMutationProgram(relationRef, {
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
    const relationRef = requireRelationInfo(user, "posts");
    const updateData = { title: { set: "updated" } };
    const upsertUpdate = { title: { set: "existing" } };
    const program = buildRelationMutationProgram(relationRef, {
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
    const ctx = scopeFor(adapter, user);
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
      buildRelationMutationProgram(posts.relationRef, posts.payload)
    ).toThrow("Unsupported nested write operation on relation 'posts'");
  });

  test("builds programs for an already parsed model data tree", () => {
    const ctx = scopeFor(adapter, user);
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
    const relationRef = requireRelationInfo(user, "posts");
    const sourceCreate = { id: 1, title: "source create" };
    const sourceCreateMany = { id: 2, title: "source createMany" };
    const sourceConnectOrCreate = { id: 3, title: "source adopt" };
    const sourceUpdate = { title: "source update" };
    const sourceUpdateMany = { title: "source updateMany" };
    const sourceUpsertCreate = { id: 4, title: "source upsert create" };
    const sourceUpsertUpdate = { title: "source upsert update" };
    const program = buildRelationMutationProgram(
      relationRef,
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
    const relationRef = requireRelationInfo(post, "author");
    const bareSource = { name: "bare source" };
    const wrappedSource = { name: "wrapped source" };
    const bare = buildRelationMutationProgram(
      relationRef,
      { update: { data: { name: { set: "parsed bare" } } } },
      { update: bareSource }
    );
    const wrapped = buildRelationMutationProgram(
      relationRef,
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

  test("collection entries are MUTATION-KIND order outer, declared position inner", () => {
    // The outer order is `RELATION_MUTATION_KEYS` — the own-write linearization,
    // unchanged by this arm — so `disconnect` precedes `connect` however the
    // payload spelled them.
    const arm = collectionArm({
      connect: [{ type: "post", where: { id: 1 } }],
      disconnect: [{ type: "video", where: { id: 2 } }],
    });
    expect(arm.entries.map((entry) => entry.program.entries[0]?.kind)).toEqual([
      "disconnect",
      "connect",
    ]);
    expect(arm.entries.map((entry) => entry.publicType)).toEqual([
      "video",
      "post",
    ]);
  });

  test("runs are MAXIMAL CONTIGUOUS: post, video, post is THREE entries", () => {
    // Never regrouped into two. Declared position is a behavior surface — the
    // junction estate's own `contiguousJunctionCreateManyRuns` preserves it for
    // the same reason — so a batching regroup would silently reorder writes.
    const arm = collectionArm({
      connect: [
        { type: "post", where: { id: 1 } },
        { type: "video", where: { id: 2 } },
        { type: "post", where: { id: 3 } },
      ],
    });
    expect(arm.entries.map((entry) => entry.publicType)).toEqual([
      "post",
      "video",
      "post",
    ]);
    // …while ADJACENT same-variant items DO share one run.
    const merged = collectionArm({
      connect: [
        { type: "post", where: { id: 1 } },
        { type: "post", where: { id: 3 } },
      ],
    });
    expect(merged.entries).toHaveLength(1);
    const only = merged.entries[0]?.program.entries[0];
    expect(only?.kind === "connect" ? only.targets : []).toEqual([
      { id: 1 },
      { id: 3 },
    ]);
  });

  test("each entry carries its variant, an OWNER-oriented junction, and a path", () => {
    const arm = collectionArm({
      connect: [
        { type: "post", where: { id: 1 } },
        { type: "video", where: { id: 2 } },
      ],
    });
    expect(arm.name).toBe("items");
    const [first, second] = arm.entries;
    expect(first?.path).toBe("items.connect[0..0]");
    expect(second?.path).toBe("items.connect[1..1]");
    // The arm's `name` is the PAYLOAD KEY while each entry's program carries the
    // VARIANT-QUALIFIED carrier name — the one place the union's
    // `name === program.relationRef.name` invariant does not hold.
    expect(first?.program.relationRef.name).toBe("items.post");
    expect(second?.program.relationRef.name).toBe("items.video");
    // OWNER-oriented: the junction's SOURCE side is the board, not the variant.
    expect(first?.junction.membership.source.model).toBe(
      collectionSchema.board
    );
    expect(first?.junction.membership.target.model).toBe(collectionSchema.post);
    // The reference is the CARRIER's own resolved slot narrowed to this member
    // (D9): there is no synthetic relation to brand, and re-classifying it
    // reaches the same member junction rather than a pair table nothing emits.
    expect(first?.junction.relationRef.resolved.slot.source).toBe(
      collectionSchema.board
    );
    expect(first?.junction.relationRef.resolved.slot.field).toBe("items");
    expect(first?.junction.relationRef.resolved.member?.variant).toBe("post");
  });

  test("`set: []` records the clear even though it produces no entries", () => {
    // The only fact `entries` cannot carry: `set: []` clears every configured
    // variant and has no run to derive that from.
    const cleared = collectionArm({ set: [] });
    expect(cleared.entries).toEqual([]);
    expect(cleared.clearsAll).toBe(true);
    expect(collectionArm({ connect: [] }).clearsAll).toBe(false);
  });

  test("`source` provenance survives the tagged unwrap", () => {
    const sourceData = { id: 9, title: "source" };
    const arm = collectionArm(
      { create: [{ type: "post", data: { id: 9, title: "parsed" } }] },
      { create: [{ type: "post", data: sourceData }] }
    );
    const create = arm.entries[0]?.program.entries[0];
    expect(
      create?.kind === "create" ? create.items[0]?.source : undefined
    ).toBe(sourceData);
  });

  test("keeps direct polymorphic record provenance through concrete-edge lowering", () => {
    const ctx = scopeFor(adapter, polymorphicSchema.reaction);
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

  test("lowers every polymorphic collection record verb through ordinary programs", () => {
    const arm = collectionArm({
      createMany: [
        {
          type: "post",
          data: [{ id: 1, title: "first" }],
          skipDuplicates: true,
        },
        {
          type: "post",
          data: [{ id: 2, title: "second" }],
        },
      ],
      connectOrCreate: {
        type: "video",
        where: { id: 3 },
        create: { id: 3, title: "created" },
      },
      update: {
        type: "post",
        where: { id: 4 },
        data: { title: { set: "updated" } },
      },
      updateMany: {
        type: "video",
        where: { title: { contains: "old" } },
        data: { title: { set: "new" } },
      },
      deleteMany: {
        type: "post",
        where: { title: { contains: "obsolete" } },
      },
      upsert: {
        type: "video",
        where: { id: 5 },
        create: { id: 5, title: "created" },
        update: { title: { set: "updated" } },
      },
    });

    expect(
      arm.entries.map((entry) => [
        entry.publicType,
        entry.program.entries[0]?.kind,
      ])
    ).toEqual([
      ["post", "update"],
      ["video", "upsert"],
      ["video", "connectOrCreate"],
      ["video", "updateMany"],
      ["post", "deleteMany"],
      ["post", "createMany"],
      ["post", "createMany"],
    ]);
    const createManyEntries = arm.entries.filter(
      (entry) => entry.program.entries[0]?.kind === "createMany"
    );
    expect(createManyEntries).toHaveLength(2);
    expect(createManyEntries.map((entry) => entry.path)).toEqual([
      "items.createMany[0..0]",
      "items.createMany[1..1]",
    ]);
    const firstCreateMany = createManyEntries[0]?.program.entries[0];
    expect(
      firstCreateMany?.kind === "createMany"
        ? firstCreateMany.skipDuplicates
        : undefined
    ).toBe(true);
  });

  test("keeps polymorphic collection sources aligned with their parsed runs", () => {
    const sourceCreateMany = { id: 11, title: "source bulk" };
    const sourceUpdate = { title: "source update" };
    const arm = collectionArm(
      {
        createMany: {
          type: "post",
          data: [{ id: 11, title: "parsed bulk" }],
        },
        update: {
          type: "post",
          where: { id: 11 },
          data: { title: { set: "parsed update" } },
        },
      },
      {
        createMany: {
          type: "post",
          data: [sourceCreateMany],
        },
        update: {
          type: "post",
          where: { id: 11 },
          data: sourceUpdate,
        },
      }
    );
    const createMany = arm.entries.find(
      (entry) => entry.program.entries[0]?.kind === "createMany"
    )?.program.entries[0];
    const update = arm.entries.find(
      (entry) => entry.program.entries[0]?.kind === "update"
    )?.program.entries[0];

    expect(
      createMany?.kind === "createMany" ? createMany.rows[0]?.source : undefined
    ).toBe(sourceCreateMany);
    expect(
      update?.kind === "update" ? update.items[0]?.data.source : undefined
    ).toBe(sourceUpdate);
  });

  describe("coverage low value: malformed transformed collection programs", () => {
    test("fails closed on malformed payloads, discriminators, and source arity", () => {
      expect(() => collectionArm(42)).toThrow(
        "produced an invalid mutation payload"
      );
      expect(() => collectionArm({ connect: { where: { id: 1 } } })).toThrow(
        "every item must carry its 'type' discriminator"
      );
      expect(() =>
        collectionArm({
          connect: { type: "unknown", where: { id: 1 } },
        })
      ).toThrow("Unknown polymorphic target 'unknown'");
      expect(() =>
        collectionArm(
          {
            create: [
              { type: "post", data: { id: 1, title: "first" } },
              { type: "post", data: { id: 2, title: "second" } },
            ],
          },
          {
            create: [{ type: "post", data: { id: 1, title: "first" } }],
          }
        )
      ).toThrow("has 1 'create' item(s) for 2 parsed item(s)");
    });

    test("contains malformed ordinary envelopes already rejected by operation schemas", () => {
      const toOne = requireRelationInfo(post, "author");
      const toMany = requireRelationInfo(user, "posts");

      expect(() =>
        buildRelationMutationProgram(toOne, {
          upsert: [
            {
              create: { id: 1, name: "created" },
              update: { name: { set: "updated" } },
            },
          ],
        })
      ).toThrow("expected a single object envelope for to-one relations");
      expect(() =>
        buildRelationMutationProgram(toMany, { connect: 42 })
      ).toThrow("expected an object envelope");
      expect(() =>
        buildRelationMutationProgram(toMany, {
          update: { where: { id: 1 } },
        })
      ).toThrow("expected 'data' to be an object");
      expect(() =>
        buildRelationMutationProgram(toMany, {
          createMany: { data: { id: 1, title: "not an array" } },
        })
      ).toThrow("expected 'data' to be an array of objects");
      expect(() =>
        buildRelationMutationProgram(
          toMany,
          {
            create: [
              { id: 1, title: "first" },
              { id: 2, title: "second" },
            ],
          },
          { create: [{ id: 1, title: "source" }] }
        )
      ).toThrow("has 1 record(s) for 2 parsed record(s)");
    });
  });
});
