import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { NotFoundError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { type Sql, sql } from "@sql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

class NonReturningPostgresAdapter
  extends PostgresAdapter
  implements DatabaseAdapter
{
  constructor() {
    super();
    this.capabilities = {
      ...this.capabilities,
      supportsReturning: false,
    };
    this.mutations = {
      ...this.mutations,
      returning: (_columns: Sql): Sql => sql``,
    };
  }
}

class NonReturningPGliteDriver extends PGliteDriver {
  override readonly adapter: DatabaseAdapter =
    new NonReturningPostgresAdapter();
}

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  posts: s.oneToMany(() => post),
  autoPosts: s.oneToMany(() => autoPost),
});

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    userId: s.string(),
    author: s
      .manyToOne(() => user)
      .fields("userId")
      .references("id"),
  })
  .map("non_returning_posts");

const autoUser = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("non_returning_auto_users");

const autoPost = s
  .model({
    id: s.int().id().increment(),
    title: s.string(),
    userId: s.string(),
    author: s
      .manyToOne(() => user)
      .fields("userId")
      .references("id"),
  })
  .map("non_returning_auto_posts");

const schema = { user, post, autoUser, autoPost };

function createNonReturningClient() {
  return createClient({
    schema,
    driver: new NonReturningPGliteDriver(),
  });
}

let client: ReturnType<typeof createNonReturningClient>;

beforeAll(async () => {
  client = createNonReturningClient();
  await push(client, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  await client.autoPost.deleteMany();
  await client.post.deleteMany();
  await client.user.deleteMany();
  await client.autoUser.deleteMany();
});

describe("non-RETURNING mutation returns", () => {
  test("create returns the created row when primary key is provided", async () => {
    const result = await client.user.create({
      data: { id: "user-1", email: "user-1@test.com", name: "Alice" },
    });

    expect(result).toEqual({
      id: "user-1",
      email: "user-1@test.com",
      name: "Alice",
    });
  });

  test("create returns the created row using inserted id for generated primary key", async () => {
    const result = await client.autoUser.create({
      data: { email: "generated@test.com", name: "Generated" },
    });

    expect(result.id).toBe(1);
    expect(result.email).toBe("generated@test.com");
    expect(result.name).toBe("Generated");
  });

  test("update returns the updated row and throws not-found for a missing row", async () => {
    await client.user.create({
      data: { id: "user-1", email: "user-1@test.com", name: "Alice" },
    });

    const result = await client.user.update({
      where: { id: "user-1" },
      data: { name: "Ada" },
    });

    expect(result.id).toBe("user-1");
    expect(result.name).toBe("Ada");
    await expect(
      client.user.update({
        where: { id: "missing" },
        data: { name: "Nobody" },
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("delete returns the deleted row and throws not-found for a missing row", async () => {
    await client.user.create({
      data: { id: "user-1", email: "user-1@test.com", name: "Alice" },
    });

    const result = await client.user.delete({ where: { id: "user-1" } });

    expect(result.id).toBe("user-1");
    expect(result.name).toBe("Alice");
    await expect(
      client.user.delete({ where: { id: "missing" } })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("upsert returns rows from both create and update branches", async () => {
    const created = await client.user.upsert({
      where: { id: "user-1" },
      create: { id: "user-1", email: "user-1@test.com", name: "Alice" },
      update: { name: "Updated" },
    });
    const updated = await client.user.upsert({
      where: { id: "user-1" },
      create: { id: "user-1", email: "ignored@test.com", name: "Ignored" },
      update: { name: "Ada" },
    });

    expect(created.name).toBe("Alice");
    expect(updated.name).toBe("Ada");
    expect(updated.email).toBe("user-1@test.com");
  });

  test("upsert update branch refetches by updated primary key", async () => {
    await client.user.create({
      data: { id: "user-1", email: "user-1@test.com", name: "Alice" },
    });

    const updated = await client.user.upsert({
      where: { id: "user-1" },
      create: { id: "ignored", email: "ignored@test.com", name: "Ignored" },
      update: { id: "user-2", name: "Ada" },
    });

    expect(updated.id).toBe("user-2");
    expect(updated.name).toBe("Ada");
    const oldRow = await client.user.findUnique({ where: { id: "user-1" } });
    expect(oldRow).toBeNull();
  });

  test("nested create, createMany, and connectOrCreate return refetched rows", async () => {
    await client.user.create({
      data: { id: "user-seed", email: "seed@test.com", name: "Seed" },
    });
    await client.post.create({
      data: { id: "post-existing", title: "Existing", userId: "user-seed" },
    });

    const result = await client.user.create({
      data: {
        id: "user-1",
        email: "user-1@test.com",
        name: "Alice",
        posts: {
          create: { id: "post-created", title: "Created" },
          createMany: {
            data: [{ id: "post-many", title: "Created many" }],
          },
          connectOrCreate: {
            where: { id: "post-coc" },
            create: { id: "post-coc", title: "Connect or create" },
          },
        },
      },
      include: { posts: { orderBy: { id: "asc" } } },
    });

    expect(result.posts.map((createdPost) => createdPost.id)).toEqual([
      "post-coc",
      "post-created",
      "post-many",
    ]);
    expect(
      result.posts.every((createdPost) => createdPost.userId === "user-1")
    ).toBe(true);
  });

  // Nested createMany of generated-PK children on a non-returning adapter with
  // no `include`: the children are inserted; nothing needs their generated PKs.
  //
  // Engine-unification (DESIGN.md §11 M3) resolves a pre-existing tx-vs-batch
  // divergence here. The frozen tx engine eagerly refetched every createMany
  // child even when no `include` consumed them, and threw `NestedWriteError`
  // when a child provided no PK to refetch by. The frozen BATCH engine already
  // did NOT refetch createMany children — it succeeded. Prisma succeeds too.
  // The create-family interpreter unifies both modes to the batch/Prisma
  // behavior: insert the children, return the parent scalars, no spurious
  // eager-refetch rejection. (Conflict recorded in the M3 report.)
  test("nested createMany of generated-PK children without include succeeds", async () => {
    const created = await client.user.create({
      data: {
        id: "user-1",
        email: "user-1@test.com",
        name: "Alice",
        autoPosts: {
          createMany: {
            data: [{ title: "No primary key" }],
          },
        },
      },
    });

    expect(created.id).toBe("user-1");
    const children = await client.autoPost.findMany({
      where: { userId: "user-1" },
    });
    expect(children).toHaveLength(1);
    expect(children[0]?.title).toBe("No primary key");
    expect(children[0]?.userId).toBe("user-1");
  });
});
