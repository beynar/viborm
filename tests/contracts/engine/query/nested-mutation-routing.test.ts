import { createClient } from "@client/client";
import {
  createClient as PGliteCreateClient,
  PGliteDriver,
} from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { runBatchPrimaryKeyDataflowBehavior } from "@tests/contracts/drivers/behaviors/batch-primary-key-dataflow-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.oneToMany(() => post),
});

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    userId: s.string().nullable(),
    comments: s.oneToMany(() => comment),
    author: s
      .manyToOne(() => user)
      .fields("userId")
      .references("id")
      .optional(),
  })
  .map("nested_mutation_posts");

const comment = s
  .model({
    id: s.string().id(),
    body: s.string(),
    postId: s.string(),
    post: s
      .manyToOne(() => post)
      .fields("postId")
      .references("id"),
  })
  .map("nested_mutation_comments");

const requiredUser = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.oneToMany(() => requiredPost),
  })
  .map("nested_required_users");

const requiredPost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    userId: s.string(),
    author: s
      .manyToOne(() => requiredUser)
      .fields("userId")
      .references("id"),
  })
  .map("nested_required_posts");

const safetySchema = { user, post, comment, requiredUser, requiredPost };

class NoAtomicPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = false;
}

function createBatchOnlyPGliteDriver(): BatchOnlyPGliteDriver {
  return new BatchOnlyPGliteDriver();
}

let client: Awaited<
  ReturnType<
    typeof PGliteCreateClient<
      typeof safetySchema,
      { schema: typeof safetySchema }
    >
  >
>;

beforeAll(async () => {
  client = PGliteCreateClient({ schema: safetySchema });
  await push(client, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  await client.requiredPost.deleteMany();
  await client.requiredUser.deleteMany();
  await client.comment.deleteMany();
  await client.post.deleteMany();
  await client.user.deleteMany();
});

describe("Nested Mutation Routing", () => {
  runBatchPrimaryKeyDataflowBehavior({
    driverName: "PGlite batch-only routing",
    createDriver: createBatchOnlyPGliteDriver,
  });

  test("create executes nested connect on to-many relation", async () => {
    await client.post.create({
      data: { id: "post-1", title: "Existing", userId: null },
    });

    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          connect: { id: "post-1" },
        },
      },
    });

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post?.userId).toBe("user-1");
  });

  test("create executes nested connectOrCreate on to-many relation", async () => {
    await client.post.create({
      data: { id: "post-1", title: "Existing", userId: null },
    });

    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          connectOrCreate: {
            where: { id: "post-1" },
            create: { id: "post-1", title: "Should not create" },
          },
        },
      },
    });

    const posts = await client.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((currentPost) => currentPost.userId)).toEqual(["user-1"]);
    expect(posts.map((currentPost) => currentPost.title)).toEqual(["Existing"]);
  });

  test("update executes nested createMany on to-many relation", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          createMany: {
            data: [
              { id: "post-1", title: "First" },
              { id: "post-2", title: "Second" },
            ],
          },
        },
      },
    });

    const posts = await client.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((createdPost) => createdPost.id)).toEqual([
      "post-1",
      "post-2",
    ]);
    expect(posts.map((createdPost) => createdPost.userId)).toEqual([
      "user-1",
      "user-1",
    ]);
  });

  test("update executes nested connect on to-many relation", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });
    await client.post.create({
      data: { id: "post-1", title: "Existing", userId: null },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          connect: { id: "post-1" },
        },
      },
    });

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post?.userId).toBe("user-1");
  });

  test("update executes nested disconnect on to-many relation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Connected" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          disconnect: { id: "post-1" },
        },
      },
    });

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post?.userId).toBeNull();
  });

  test("update executes nested delete on to-many relation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Delete me" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          delete: { id: "post-1" },
        },
      },
    });

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post).toBeNull();
  });

  test("update executes nested set on to-many relation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: [
            { id: "post-1", title: "Old first" },
            { id: "post-2", title: "Old second" },
          ],
        },
      },
    });
    await client.user.create({
      data: {
        id: "user-2",
        name: "Bob",
        posts: {
          create: { id: "post-3", title: "Replacement" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          set: { id: "post-3" },
        },
      },
    });

    const posts = await client.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((currentPost) => currentPost.userId)).toEqual([
      null,
      null,
      "user-1",
    ]);
  });

  test("update executes nested connectOrCreate on to-many relation", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          connectOrCreate: {
            where: { id: "post-1" },
            create: { id: "post-1", title: "Created and connected" },
          },
        },
      },
    });

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post?.userId).toBe("user-1");
    expect(post?.title).toBe("Created and connected");
  });

  test("update executes nested update on to-one relation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Original" },
        },
      },
    });

    const result = await client.post.update({
      where: { id: "post-1" },
      data: {
        title: "Changed",
        author: {
          update: { name: "Alice Updated" },
        },
      },
    });

    const user = await client.user.findUnique({ where: { id: "user-1" } });
    expect(result.title).toBe("Changed");
    expect(user?.name).toBe("Alice Updated");
  });

  test("missing to-one nested update target rolls back parent mutation", async () => {
    await client.post.create({
      data: { id: "post-1", title: "Orphan", userId: null },
    });

    await expect(
      client.post.update({
        where: { id: "post-1" },
        data: {
          title: "Changed",
          author: {
            update: { name: "Nobody" },
          },
        },
      })
    ).rejects.toThrow("Cannot update relation 'author'");

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post?.title).toBe("Orphan");
  });

  test("update executes nested update on to-many relation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Original" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          update: {
            where: { id: "post-1" },
            data: { title: "Updated" },
          },
        },
      },
    });

    const post = await client.post.findUnique({ where: { id: "post-1" } });
    expect(post?.title).toBe("Updated");
    expect(post?.userId).toBe("user-1");
  });

  test("to-many nested update cannot target another parent's child", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Alice post" },
        },
      },
    });
    await client.user.create({
      data: {
        id: "user-2",
        name: "Bob",
        posts: {
          create: { id: "post-2", title: "Bob post" },
        },
      },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            update: {
              where: { id: "post-2" },
              data: { title: "Stolen" },
            },
          },
        },
      })
    ).rejects.toThrow("Cannot update relation 'posts'");

    const [user, bobPost] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-2" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(bobPost?.title).toBe("Bob post");
    expect(bobPost?.userId).toBe("user-2");
  });

  test("missing to-many nested update target rolls back parent mutation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Existing" },
        },
      },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            update: {
              where: { id: "missing-post" },
              data: { title: "Missing" },
            },
          },
        },
      })
    ).rejects.toThrow("Cannot update relation 'posts'");

    const [user, post] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(post?.title).toBe("Existing");
  });

  test("updateMany updates only the parent's children", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: [
            { id: "post-1", title: "Draft" },
            { id: "post-2", title: "Skip" },
          ],
        },
      },
    });
    await client.user.create({
      data: {
        id: "user-2",
        name: "Bob",
        posts: {
          create: { id: "post-3", title: "Draft" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          updateMany: {
            where: { title: "Draft" },
            data: { title: "Published" },
          },
        },
      },
    });

    const posts = await client.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((currentPost) => currentPost.title)).toEqual([
      "Published",
      "Skip",
      "Draft",
    ]);
  });

  test("zero-match updateMany is not an error", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Existing" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        name: "Changed",
        posts: {
          updateMany: {
            where: { title: "Missing" },
            data: { title: "Updated" },
          },
        },
      },
    });

    const [user, post] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
    ]);
    expect(user?.name).toBe("Changed");
    expect(post?.title).toBe("Existing");
  });

  test("deleteMany deletes only the parent's matching children", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: [
            { id: "post-1", title: "Draft" },
            { id: "post-2", title: "Keep" },
          ],
        },
      },
    });
    await client.user.create({
      data: {
        id: "user-2",
        name: "Bob",
        posts: {
          create: { id: "post-3", title: "Draft" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          deleteMany: { title: "Draft" },
        },
      },
    });

    const posts = await client.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((currentPost) => currentPost.id)).toEqual([
      "post-2",
      "post-3",
    ]);
    expect(posts.map((currentPost) => currentPost.userId)).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  test("zero-match deleteMany is not an error", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Existing" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        name: "Changed",
        posts: {
          deleteMany: { title: "Missing" },
        },
      },
    });

    const [user, post] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
    ]);
    expect(user?.name).toBe("Changed");
    expect(post?.title).toBe("Existing");
    expect(post?.userId).toBe("user-1");
  });

  test("invalid nested deleteMany filter rolls back parent mutation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Existing" },
        },
      },
    });

    const invalidUpdate = {
      where: { id: "user-1" },
      data: {
        name: "Changed",
        posts: {
          deleteMany: { missingField: "nope" },
        },
      },
    } as unknown as Parameters<typeof client.user.update>[0];

    await expect(client.user.update(invalidUpdate)).rejects.toThrow(
      "Validation failed for update"
    );

    const [user, post] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(post?.title).toBe("Existing");
  });

  test("nested deleteMany database failure rolls back parent mutation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Existing" },
        },
      },
    });
    await client.comment.create({
      data: { id: "comment-1", body: "Pinned", postId: "post-1" },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            deleteMany: { id: "post-1" },
          },
        },
      })
    ).rejects.toThrow();

    const [user, post, comment] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
      client.comment.findUnique({ where: { id: "comment-1" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(post?.title).toBe("Existing");
    expect(comment?.postId).toBe("post-1");
  });

  test("nested updateMany child failure rolls back parent mutation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: [
            { id: "post-1", title: "First" },
            { id: "post-2", title: "Second" },
          ],
        },
      },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            updateMany: {
              data: { id: "post-2" },
            },
          },
        },
      })
    ).rejects.toThrow();

    const [user, posts] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findMany({ orderBy: { id: "asc" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(posts.map((currentPost) => currentPost.id)).toEqual([
      "post-1",
      "post-2",
    ]);
  });

  test("upsert update branch executes nested update", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Draft" },
        },
      },
    });

    await client.user.upsert({
      where: { id: "user-1" },
      create: { id: "user-1", name: "Created" },
      update: {
        name: "Updated Alice",
        posts: {
          update: {
            where: { id: "post-1" },
            data: { title: "Published" },
          },
        },
      },
    });

    const [user, post] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
    ]);
    expect(user?.name).toBe("Updated Alice");
    expect(post?.title).toBe("Published");
  });

  test("upsert update branch executes nested updateMany with parent correlation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Draft" },
        },
      },
    });
    await client.user.create({
      data: {
        id: "user-2",
        name: "Bob",
        posts: {
          create: { id: "post-2", title: "Draft" },
        },
      },
    });

    await client.user.upsert({
      where: { id: "user-1" },
      create: { id: "user-1", name: "Created" },
      update: {
        name: "Updated Alice",
        posts: {
          updateMany: {
            where: { title: "Draft" },
            data: { title: "Published" },
          },
        },
      },
    });

    const posts = await client.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((currentPost) => currentPost.title)).toEqual([
      "Published",
      "Draft",
    ]);
  });

  test("upsert update branch executes nested deleteMany with parent correlation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: [
            { id: "post-1", title: "Draft" },
            { id: "post-2", title: "Keep" },
          ],
        },
      },
    });
    await client.user.create({
      data: {
        id: "user-2",
        name: "Bob",
        posts: {
          create: { id: "post-3", title: "Draft" },
        },
      },
    });

    await client.user.upsert({
      where: { id: "user-1" },
      create: { id: "user-1", name: "Created" },
      update: {
        name: "Updated Alice",
        posts: {
          deleteMany: { title: "Draft" },
        },
      },
    });

    const [user, posts] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findMany({ orderBy: { id: "asc" } }),
    ]);
    expect(user?.name).toBe("Updated Alice");
    expect(posts.map((currentPost) => currentPost.id)).toEqual([
      "post-2",
      "post-3",
    ]);
    expect(posts.map((currentPost) => currentPost.userId)).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  test("recursive nested update executes supported nested writes", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Original" },
        },
      },
    });

    await client.post.update({
      where: { id: "post-1" },
      data: {
        author: {
          update: {
            posts: {
              create: { id: "post-2", title: "Recursive" },
            },
          },
        },
      },
    });

    const posts = await client.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((currentPost) => currentPost.id)).toEqual([
      "post-1",
      "post-2",
    ]);
    expect(posts.map((currentPost) => currentPost.userId)).toEqual([
      "user-1",
      "user-1",
    ]);
  });

  test("recursive nested update executes nested upsert", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Original" },
        },
      },
    });

    await client.post.update({
      where: { id: "post-1" },
      data: {
        title: "Changed",
        author: {
          update: {
            posts: {
              upsert: {
                where: { id: "post-2" },
                create: { id: "post-2", title: "Created" },
                update: { title: "Updated" },
              },
            },
          },
        },
      },
    });

    const posts = await client.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((currentPost) => currentPost.title)).toEqual([
      "Changed",
      "Created",
    ]);
    expect(posts.map((currentPost) => currentPost.userId)).toEqual([
      "user-1",
      "user-1",
    ]);
  });

  test("nested relation writes inside updateMany compile one selected subtree per child", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Original" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        name: "Changed",
        posts: {
          updateMany: {
            data: {
              author: {
                update: { name: "Nested" },
              },
            },
          },
        },
      },
    });

    const user = await client.user.findUnique({ where: { id: "user-1" } });
    expect(user?.name).toBe("Nested");
  });

  test("nested to-many upsert updates an existing child for this parent", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Original" },
        },
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        name: "Changed",
        posts: {
          upsert: {
            where: { id: "post-1" },
            create: { id: "post-2", title: "Created" },
            update: { title: "Updated" },
          },
        },
      },
    });

    const [user, post] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
    ]);
    expect(user?.name).toBe("Changed");
    expect(post?.title).toBe("Updated");
    expect(post?.userId).toBe("user-1");
  });

  test("nested to-many upsert creates a missing child for this parent", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
      },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        name: "Changed",
        posts: {
          upsert: {
            where: { id: "post-1" },
            create: { id: "post-1", title: "Created" },
            update: { title: "Updated" },
          },
        },
      },
    });

    const [user, post] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
    ]);
    expect(user?.name).toBe("Changed");
    expect(post?.title).toBe("Created");
    expect(post?.userId).toBe("user-1");
  });

  test("top-level upsert update branch executes nested to-many upsert", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Original" },
        },
      },
    });

    await client.user.upsert({
      where: { id: "user-1" },
      create: { id: "user-1", name: "Created" },
      update: {
        name: "Changed",
        posts: {
          upsert: {
            where: { id: "post-1" },
            create: { id: "post-2", title: "Created" },
            update: { title: "Updated from upsert" },
          },
        },
      },
    });

    const [user, post] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
    ]);
    expect(user?.name).toBe("Changed");
    expect(post?.title).toBe("Updated from upsert");
    expect(post?.userId).toBe("user-1");
  });

  test("nested to-many upsert cannot target another parent's child", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Alice post" },
        },
      },
    });
    await client.user.create({
      data: {
        id: "user-2",
        name: "Bob",
        posts: {
          create: { id: "post-2", title: "Bob post" },
        },
      },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            upsert: {
              where: { id: "post-2" },
              create: { id: "post-3", title: "Created" },
              update: { title: "Stolen" },
            },
          },
        },
      })
    ).rejects.toThrow("Cannot upsert relation 'posts'");

    const [user, bobPost] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-2" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(bobPost?.title).toBe("Bob post");
    expect(bobPost?.userId).toBe("user-2");
  });

  test("nested to-one upsert updates the current target", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Original" },
        },
      },
    });

    await client.post.update({
      where: { id: "post-1" },
      data: {
        author: {
          upsert: {
            create: { id: "user-2", name: "Created" },
            update: { name: "Updated Alice" },
          },
        },
      },
    });

    const [user, users] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.user.findMany({ orderBy: { id: "asc" } }),
    ]);
    expect(user?.name).toBe("Updated Alice");
    expect(users.map((currentUser) => currentUser.id)).toEqual(["user-1"]);
  });

  test("nested to-one upsert creates a target and updates the current foreign key", async () => {
    await client.post.create({
      data: { id: "post-1", title: "Orphan", userId: null },
    });

    await client.post.update({
      where: { id: "post-1" },
      data: {
        title: "Changed",
        author: {
          upsert: {
            create: { id: "user-1", name: "Alice" },
            update: { name: "Ignored" },
          },
        },
      },
    });

    const [post, user] = await Promise.all([
      client.post.findUnique({ where: { id: "post-1" } }),
      client.user.findUnique({ where: { id: "user-1" } }),
    ]);
    expect(post?.title).toBe("Changed");
    expect(post?.userId).toBe("user-1");
    expect(user?.name).toBe("Alice");
  });

  test("nested upsert branches execute supported recursive nested writes", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });

    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          upsert: {
            where: { id: "post-1" },
            create: {
              id: "post-1",
              title: "Created",
              comments: {
                create: { id: "comment-1", body: "From create branch" },
              },
            },
            update: { title: "Updated" },
          },
        },
      },
    });
    await client.user.update({
      where: { id: "user-1" },
      data: {
        posts: {
          upsert: {
            where: { id: "post-1" },
            create: { id: "post-2", title: "Unused" },
            update: {
              comments: {
                create: { id: "comment-2", body: "From update branch" },
              },
            },
          },
        },
      },
    });

    const comments = await client.comment.findMany({ orderBy: { id: "asc" } });
    expect(comments.map((currentComment) => currentComment.id)).toEqual([
      "comment-1",
      "comment-2",
    ]);
    expect(comments.map((currentComment) => currentComment.postId)).toEqual([
      "post-1",
      "post-1",
    ]);
  });

  test("nested upsert create conflict rolls back parent mutation", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });
    await client.post.create({
      data: { id: "post-conflict", title: "Existing", userId: null },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            upsert: {
              where: { id: "post-missing" },
              create: { id: "post-conflict", title: "Duplicate" },
              update: { title: "Updated" },
            },
          },
        },
      })
    ).rejects.toThrow();

    const [user, conflictPost, missingPost] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-conflict" } }),
      client.post.findUnique({ where: { id: "post-missing" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(conflictPost?.title).toBe("Existing");
    expect(conflictPost?.userId).toBeNull();
    expect(missingPost).toBeNull();
  });

  test("upsert create branch executes nested connect and connectOrCreate", async () => {
    await client.post.create({
      data: { id: "post-1", title: "Existing", userId: null },
    });

    const result = await client.user.upsert({
      where: { id: "user-1" },
      create: {
        id: "user-1",
        name: "Alice",
        posts: {
          connect: { id: "post-1" },
          connectOrCreate: {
            where: { id: "post-2" },
            create: { id: "post-2", title: "Created from create branch" },
          },
        },
      },
      update: { name: "Updated" },
    });

    expect(result.name).toBe("Alice");

    const posts = await client.post.findMany({
      where: { userId: "user-1" },
      orderBy: { id: "asc" },
    });
    expect(posts.map((currentPost) => currentPost.id)).toEqual([
      "post-1",
      "post-2",
    ]);
  });

  test("upsert create branch rejects nested deleteMany before parent create", async () => {
    const invalidUpsert = {
      where: { id: "user-1" },
      create: {
        id: "user-1",
        name: "Alice",
        posts: {
          deleteMany: { title: "Missing" },
        },
      },
      update: { name: "Updated" },
    } as unknown as Parameters<typeof client.user.upsert>[0];

    await expect(client.user.upsert(invalidUpsert)).rejects.toThrow(
      "Unknown key: deleteMany"
    );

    const users = await client.user.findMany();
    expect(users).toHaveLength(0);
  });

  test("upsert update branch executes nested connect and connectOrCreate", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });
    await client.post.create({
      data: { id: "post-1", title: "Existing", userId: null },
    });

    const result = await client.user.upsert({
      where: { id: "user-1" },
      create: { id: "user-1", name: "New Alice" },
      update: {
        name: "Updated Alice",
        posts: {
          connect: { id: "post-1" },
          connectOrCreate: {
            where: { id: "post-2" },
            create: { id: "post-2", title: "Created from update branch" },
          },
        },
      },
    });

    expect(result.name).toBe("Updated Alice");

    const posts = await client.post.findMany({
      where: { userId: "user-1" },
      orderBy: { id: "asc" },
    });
    expect(posts.map((currentPost) => currentPost.id)).toEqual([
      "post-1",
      "post-2",
    ]);
  });

  test("missing to-many connect target rolls back parent mutation", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            connect: { id: "missing-post" },
          },
        },
      })
    ).rejects.toThrow("Cannot connect relation 'posts'");

    const user = await client.user.findUnique({ where: { id: "user-1" } });
    expect(user?.name).toBe("Alice");
  });

  test("missing connect target in upsert create branch rolls back parent create", async () => {
    await expect(
      client.user.upsert({
        where: { id: "user-1" },
        create: {
          id: "user-1",
          name: "Alice",
          posts: {
            connect: { id: "missing-post" },
          },
        },
        update: { name: "Updated" },
      })
    ).rejects.toThrow("Cannot connect relation 'posts'");

    const users = await client.user.findMany();
    expect(users).toHaveLength(0);
  });

  test("missing connect target in upsert update branch rolls back scalar update", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });

    await expect(
      client.user.upsert({
        where: { id: "user-1" },
        create: { id: "user-1", name: "New Alice" },
        update: {
          name: "Changed",
          posts: {
            connect: { id: "missing-post" },
          },
        },
      })
    ).rejects.toThrow("Cannot connect relation 'posts'");

    const user = await client.user.findUnique({ where: { id: "user-1" } });
    expect(user?.name).toBe("Alice");
  });

  test("missing current-FK connect target rolls back parent create", async () => {
    await expect(
      client.post.create({
        data: {
          id: "post-1",
          title: "Orphan attempt",
          author: {
            connect: { id: "missing-user" },
          },
        },
      })
    ).rejects.toThrow("Cannot connect relation 'author'");

    const posts = await client.post.findMany();
    expect(posts).toHaveLength(0);
  });

  test("to-one multiple connect inputs reject before parent create", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });
    await client.user.create({
      data: { id: "user-2", name: "Bob" },
    });

    const invalidCreate = {
      data: {
        id: "post-1",
        title: "Invalid",
        author: {
          connect: [{ id: "user-1" }, { id: "user-2" }],
        },
      },
    } as unknown as Parameters<typeof client.post.create>[0];

    await expect(client.post.create(invalidCreate)).rejects.toThrow();

    const posts = await client.post.findMany();
    expect(posts).toHaveLength(0);
  });

  test("connectOrCreate create failure in upsert create branch rolls back parent", async () => {
    await client.post.create({
      data: { id: "post-1", title: "Existing", userId: null },
    });

    await expect(
      client.user.upsert({
        where: { id: "user-1" },
        create: {
          id: "user-1",
          name: "Alice",
          posts: {
            connectOrCreate: {
              where: { id: "post-2" },
              create: { id: "post-1", title: "Duplicate create" },
            },
          },
        },
        update: { name: "Updated" },
      })
    ).rejects.toThrow();

    const [users, posts] = await Promise.all([
      client.user.findMany(),
      client.post.findMany(),
    ]);
    expect(users).toHaveLength(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.userId).toBeNull();
  });

  test("to-many specific disconnect cannot target another parent's child", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Alice post" },
        },
      },
    });
    await client.user.create({
      data: {
        id: "user-2",
        name: "Bob",
        posts: {
          create: { id: "post-2", title: "Bob post" },
        },
      },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            disconnect: { id: "post-2" },
          },
        },
      })
    ).rejects.toThrow("Cannot disconnect relation 'posts'");

    const [user, bobPost] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-2" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(bobPost?.userId).toBe("user-2");
  });

  test("to-many specific delete cannot target another parent's child", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Alice post" },
        },
      },
    });
    await client.user.create({
      data: {
        id: "user-2",
        name: "Bob",
        posts: {
          create: { id: "post-2", title: "Bob post" },
        },
      },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            delete: { id: "post-2" },
          },
        },
      })
    ).rejects.toThrow("Cannot delete relation 'posts'");

    const [user, bobPost] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-2" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(bobPost?.userId).toBe("user-2");
  });

  test("to-one deleteMany rejects before parent mutation", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Alice post" },
        },
      },
    });

    const invalidUpdate = {
      where: { id: "post-1" },
      data: {
        title: "Changed",
        author: {
          deleteMany: { id: "user-1" },
        },
      },
    } as unknown as Parameters<typeof client.post.update>[0];

    await expect(client.post.update(invalidUpdate)).rejects.toThrow(
      "Unknown key: deleteMany"
    );

    const [user, post] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(post?.title).toBe("Alice post");
  });

  test("required inverse relation rejects disconnect before mutation", async () => {
    await client.requiredUser.create({
      data: {
        id: "required-user-1",
        name: "Alice",
        posts: {
          create: { id: "required-post-1", title: "Required" },
        },
      },
    });

    await expect(
      client.requiredUser.update({
        where: { id: "required-user-1" },
        data: {
          name: "Changed",
          posts: {
            // @ts-expect-error - required child membership cannot disconnect
            disconnect: { id: "required-post-1" },
          },
        },
      })
    ).rejects.toThrow("Unknown key: disconnect");

    const [user, post] = await Promise.all([
      client.requiredUser.findUnique({ where: { id: "required-user-1" } }),
      client.requiredPost.findUnique({ where: { id: "required-post-1" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(post?.userId).toBe("required-user-1");
  });

  test("required inverse relation rejects set empty before mutation", async () => {
    await client.requiredUser.create({
      data: {
        id: "required-user-1",
        name: "Alice",
        posts: {
          create: { id: "required-post-1", title: "Required" },
        },
      },
    });

    await expect(
      client.requiredUser.update({
        where: { id: "required-user-1" },
        data: {
          name: "Changed",
          posts: {
            set: [],
          },
        },
      })
    ).rejects.toThrow("foreign key field(s) userId are required");

    const [user, post] = await Promise.all([
      client.requiredUser.findUnique({ where: { id: "required-user-1" } }),
      client.requiredPost.findUnique({ where: { id: "required-post-1" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(post?.userId).toBe("required-user-1");
  });

  test("nested create child failure rolls back parent and prior children", async () => {
    await expect(
      client.user.create({
        data: {
          id: "user-1",
          name: "Alice",
          posts: {
            create: [
              { id: "post-1", title: "First" },
              { id: "post-1", title: "Duplicate" },
            ],
          },
        },
      })
    ).rejects.toThrow();

    const [users, posts] = await Promise.all([
      client.user.findMany(),
      client.post.findMany(),
    ]);
    expect(users).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  test("nested createMany child failure rolls back parent", async () => {
    await expect(
      client.user.create({
        data: {
          id: "user-1",
          name: "Alice",
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "First" },
                { id: "post-1", title: "Duplicate" },
              ],
            },
          },
        },
      })
    ).rejects.toThrow();

    const [users, posts] = await Promise.all([
      client.user.findMany(),
      client.post.findMany(),
    ]);
    expect(users).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  test("nested connectOrCreate child failure rolls back parent mutation", async () => {
    await client.user.create({
      data: { id: "user-1", name: "Alice" },
    });
    await client.post.create({
      data: { id: "post-1", title: "Existing", userId: null },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            connectOrCreate: {
              where: { id: "post-2" },
              create: { id: "post-1", title: "Duplicate create" },
            },
          },
        },
      })
    ).rejects.toThrow();

    const [user, posts] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findMany({ orderBy: { id: "asc" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.userId).toBeNull();
  });

  test("nested set target failure rolls back parent and existing children", async () => {
    await client.user.create({
      data: {
        id: "user-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Existing" },
        },
      },
    });

    await expect(
      client.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            set: { id: "missing-post" },
          },
        },
      })
    ).rejects.toThrow("Cannot set relation 'posts'");

    const [user, post] = await Promise.all([
      client.user.findUnique({ where: { id: "user-1" } }),
      client.post.findUnique({ where: { id: "post-1" } }),
    ]);
    expect(user?.name).toBe("Alice");
    expect(post?.userId).toBe("user-1");
  });

  test("batch-only driver executes planned nested writes atomically", async () => {
    const db = new PGlite();
    const setupClient = createClient({
      schema: safetySchema,
      driver: new PGliteDriver({ client: db }),
    });
    const driver = new BatchOnlyPGliteDriver({ client: db });
    const batchOnlyClient = createClient({
      schema: safetySchema,
      driver,
    });

    try {
      await push(setupClient, { force: true });
      await setupClient.user.create({
        data: { id: "user-1", name: "Alice" },
      });

      const updated = await batchOnlyClient.user.update({
        where: { id: "user-1" },
        data: {
          name: "Changed",
          posts: {
            create: { id: "post-1", title: "Created through batch" },
          },
        },
      });

      const [user, posts] = await Promise.all([
        batchOnlyClient.user.findUnique({ where: { id: "user-1" } }),
        batchOnlyClient.post.findMany(),
      ]);
      expect(updated.name).toBe("Changed");
      expect(user?.name).toBe("Changed");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.userId).toBe("user-1");
    } finally {
      await batchOnlyClient.$disconnect();
    }
  });

  test("batch-only driver aborts missing nested connect before parent mutation", async () => {
    const db = new PGlite();
    const setupClient = createClient({
      schema: safetySchema,
      driver: new PGliteDriver({ client: db }),
    });
    const batchOnlyClient = createClient({
      schema: safetySchema,
      driver: new BatchOnlyPGliteDriver({ client: db }),
    });

    try {
      await push(setupClient, { force: true });
      await setupClient.user.create({
        data: { id: "user-1", name: "Alice" },
      });

      await expect(
        batchOnlyClient.user.update({
          where: { id: "user-1" },
          data: {
            name: "Changed",
            posts: {
              connect: { id: "missing-post" },
            },
          },
        })
      ).rejects.toThrow();

      const user = await batchOnlyClient.user.findUnique({
        where: { id: "user-1" },
      });
      expect(user?.name).toBe("Alice");
    } finally {
      await batchOnlyClient.$disconnect();
    }
  });

  test("batch-only driver executes top-level upsert create branch nested writes", async () => {
    const db = new PGlite();
    const setupClient = createClient({
      schema: safetySchema,
      driver: new PGliteDriver({ client: db }),
    });
    const batchOnlyClient = createClient({
      schema: safetySchema,
      driver: new BatchOnlyPGliteDriver({ client: db }),
    });

    try {
      await push(setupClient, { force: true });

      await batchOnlyClient.user.upsert({
        where: { id: "user-1" },
        create: {
          id: "user-1",
          name: "Alice",
          posts: {
            create: { id: "post-1", title: "Created" },
          },
        },
        update: { name: "Unused" },
      });

      const posts = await batchOnlyClient.post.findMany();
      expect(posts).toHaveLength(1);
      expect(posts[0]?.userId).toBe("user-1");
    } finally {
      await batchOnlyClient.$disconnect();
    }
  });

  test("batch-only driver executes top-level upsert update branch nested writes", async () => {
    const db = new PGlite();
    const setupClient = createClient({
      schema: safetySchema,
      driver: new PGliteDriver({ client: db }),
    });
    const batchOnlyClient = createClient({
      schema: safetySchema,
      driver: new BatchOnlyPGliteDriver({ client: db }),
    });

    try {
      await push(setupClient, { force: true });
      await setupClient.user.create({
        data: {
          id: "user-1",
          name: "Alice",
          posts: {
            create: { id: "post-1", title: "Draft" },
          },
        },
      });

      await batchOnlyClient.user.upsert({
        where: { id: "user-1" },
        create: { id: "user-unused", name: "Unused" },
        update: {
          name: "Updated",
          posts: {
            update: {
              where: { id: "post-1" },
              data: { title: "Published" },
            },
          },
        },
      });

      const [user, post] = await Promise.all([
        batchOnlyClient.user.findUnique({ where: { id: "user-1" } }),
        batchOnlyClient.post.findUnique({ where: { id: "post-1" } }),
      ]);
      expect(user?.name).toBe("Updated");
      expect(post?.title).toBe("Published");
    } finally {
      await batchOnlyClient.$disconnect();
    }
  });

  test("driver lacking every atomic strategy rejects nested writes before parent mutation", async () => {
    const db = new PGlite();
    const setupClient = createClient({
      schema: safetySchema,
      driver: new PGliteDriver({ client: db }),
    });
    const driver = new NoAtomicPGliteDriver({ client: db });
    const noAtomicClient = createClient({
      schema: safetySchema,
      driver,
    });

    try {
      await push(setupClient, { force: true });
      await setupClient.user.create({
        data: { id: "user-1", name: "Alice" },
      });

      await expect(
        noAtomicClient.user.update({
          where: { id: "user-1" },
          data: {
            name: "Changed",
            posts: {
              create: { id: "post-1", title: "Should not write" },
            },
          },
        })
      ).rejects.toThrow(
        "supports neither transactions nor atomic batch execution"
      );

      const [user, posts] = await Promise.all([
        noAtomicClient.user.findUnique({ where: { id: "user-1" } }),
        noAtomicClient.post.findMany(),
      ]);
      expect(user?.name).toBe("Alice");
      expect(posts).toHaveLength(0);
    } finally {
      await noAtomicClient.$disconnect();
    }
  });
});
