/**
 * Relation Create Schema Tests
 *
 * Tests the _create.relation schema which includes nested write operations
 * (connect, create, connectOrCreate) for relations.
 */

import { s } from "@schema";
import {
  authorSchemas,
  postSchemas,
  simpleSchemas,
} from "@tests/unit/operation-schemas/fixtures";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import {
  getNestedScalarCreateWithOmittedRequiredKeys,
  type NestedScalarCreateWithOmittedRequiredKeys,
} from "@validation/model/core";
import { describe, expect, expectTypeOf, test } from "vitest";

const phase7Author = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => phase7Post),
});

const phase7Post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => phase7Author)
    .fields("authorId")
    .references("id"),
});

const phase7Schemas = createSchemaRegistry({
  author: phase7Author,
  post: phase7Post,
}).proxy;

const inverseOneToOneUser = s.model({
  id: s.string().id(),
  name: s.string(),
  profile: s.toOne(() => inverseOneToOneProfile),
});

const inverseOneToOneProfile = s.model({
  id: s.string().id(),
  bio: s.string().nullable(),
  userId: s.string().unique().nullable(),
  user: s
    .toOne(() => inverseOneToOneUser)
    .fields("userId")
    .references("id"),
});

const inverseOneToOneSchemas = createSchemaRegistry({
  user: inverseOneToOneUser,
  profile: inverseOneToOneProfile,
}).proxy;

const relationScopedAuthor = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => relationScopedPost).name("author"),
});

const relationScopedCategory = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => relationScopedPost).name("category"),
});

const relationScopedPost = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  categoryId: s.string(),
  author: s
    .toOne(() => relationScopedAuthor)
    .fields("authorId")
    .references("id")
    .name("author"),
  category: s
    .toOne(() => relationScopedCategory)
    .fields("categoryId")
    .references("id")
    .name("category"),
});

const relationScopedSchemas = createSchemaRegistry({
  author: relationScopedAuthor,
  category: relationScopedCategory,
  post: relationScopedPost,
}).proxy;

const compositeAuthor = s
  .model({
    id: s.string(),
    orgId: s.string(),
    name: s.string(),
    posts: s.toMany(() => compositePost),
  })
  .id(["id", "orgId"]);

const compositePost = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  authorOrgId: s.string(),
  author: s
    .toOne(() => compositeAuthor)
    .fields("authorId", "authorOrgId")
    .references("id", "orgId"),
});

const compositeSchemas = createSchemaRegistry({
  author: compositeAuthor,
  post: compositePost,
}).proxy;

const optionalCompositeParent = s
  .model({
    id: s.string(),
    tenantId: s.string(),
    child: s.toOne(() => optionalCompositeChild),
  })
  .id(["tenantId", "id"]);

const optionalCompositeChild = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => optionalCompositeParent)
    .fields("tenantId", "parentId")
    .references("tenantId", "id"),
});

const optionalCompositeSchemas = createSchemaRegistry({
  parent: optionalCompositeParent,
  child: optionalCompositeChild,
}).proxy;

const multiFkAuthor = s
  .model({
    id: s.string(),
    orgId: s.string(),
    name: s.string(),
    posts: s.toMany(() => multiFkPost),
  })
  .id(["id", "orgId"]);

const multiFkCategory = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => multiFkPost),
});

const multiFkPost = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  authorOrgId: s.string(),
  categoryId: s.string(),
  author: s
    .toOne(() => multiFkAuthor)
    .fields("authorId", "authorOrgId")
    .references("id", "orgId"),
  category: s
    .toOne(() => multiFkCategory)
    .fields("categoryId")
    .references("id"),
});

const multiFkSchemas = createSchemaRegistry({
  author: multiFkAuthor,
  category: multiFkCategory,
  post: multiFkPost,
}).proxy;

const helperScopedPost = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  categoryId: s.string(),
});

const helperScopedSchemas = createSchemaRegistry({
  post: helperScopedPost,
}).proxy;

const helperScopedPostNestedCreateManyData =
  getNestedScalarCreateWithOmittedRequiredKeys(
    helperScopedPost,
    helperScopedSchemas.post,
    ["authorId"] as const
  );

test("nested create keeps every required key when none are derived", () => {
  const schema = getNestedScalarCreateWithOmittedRequiredKeys(
    helperScopedPost,
    helperScopedSchemas.post,
    undefined
  );

  expect(
    parse(schema, {
      id: "post",
      title: "Title",
      authorId: "author",
      categoryId: "category",
    }).issues
  ).toBeUndefined();
  expect(
    parse(schema, { id: "post", title: "Title", authorId: "author" }).issues
  ).toBeDefined();
});

// =============================================================================
// TYPE TESTS - Author Model (has oneToMany)
// =============================================================================

describe("Relation Create - Types (Author Model)", () => {
  type Input = InferInput<typeof authorSchemas.relationCreate>;
  type Phase7CreateArgsInput = InferInput<
    typeof phase7Schemas.author.args.create
  >;
  type InverseOneToOneCreateArgsInput = InferInput<
    typeof inverseOneToOneSchemas.user.args.create
  >;

  test("type: includes relation field", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });

  test("type: all relations are optional", () => {
    expectTypeOf<Record<PropertyKey, never>>().toMatchTypeOf<Input>();
  });

  test("type: nested create can omit parent-derived inverse FK", () => {
    expectTypeOf<{
      data: {
        id: string;
        name: string;
        posts: { create: { id: string; title: string } };
      };
    }>().toMatchTypeOf<Phase7CreateArgsInput>();
  });

  test("type: nested createMany can omit parent-derived inverse FK", () => {
    expectTypeOf<{
      data: {
        id: string;
        name: string;
        posts: {
          createMany: {
            data: Array<{ id: string; title: string }>;
          };
        };
      };
    }>().toMatchTypeOf<Phase7CreateArgsInput>();
  });

  test("type: inverse one-to-one nested create can omit parent-derived FK", () => {
    expectTypeOf<{
      data: {
        id: string;
        name: string;
        profile: { create: { id: string; bio: string | null } };
      };
    }>().toMatchTypeOf<InverseOneToOneCreateArgsInput>();
  });

  test("type: nested createMany requires data", () => {
    expectTypeOf<{
      data: {
        id: string;
        name: string;
        posts: {
          createMany: Record<PropertyKey, never>;
        };
      };
    }>().not.toMatchTypeOf<Phase7CreateArgsInput>();

    expectTypeOf<{
      data: {
        id: string;
        name: string;
        posts: {
          createMany: {
            data: Array<{ id: string; title: string }>;
          };
        };
      };
    }>().toMatchTypeOf<Phase7CreateArgsInput>();
  });

  test("type: nested createMany accepts unrelated FK", () => {
    type RelationScopedCreateArgsInput = InferInput<
      typeof relationScopedSchemas.author.args.create
    >;

    expectTypeOf<{
      data: {
        id: string;
        name: string;
        posts: {
          createMany: {
            data: Array<{ id: string; title: string; categoryId: string }>;
          };
        };
      };
    }>().toMatchTypeOf<RelationScopedCreateArgsInput>();
  });

  test("type: nested createMany can supply an unrelated FK through its relation", () => {
    type RelationScopedCreateArgsInput = InferInput<
      typeof relationScopedSchemas.author.args.create
    >;

    expectTypeOf<{
      data: {
        id: string;
        name: string;
        posts: {
          createMany: {
            data: Array<{
              id: string;
              title: string;
              category: { connect: { id: string } };
            }>;
          };
        };
      };
    }>().toMatchTypeOf<RelationScopedCreateArgsInput>();
  });

  test("type: relation-scoped createMany data requires unrelated FK", () => {
    type RelationScopedPostCreateManyData = InferInput<
      typeof helperScopedPostNestedCreateManyData
    >;
    type ExpectedSchema = NestedScalarCreateWithOmittedRequiredKeys<
      typeof helperScopedPost,
      typeof helperScopedSchemas.post,
      readonly ["authorId"]
    >;

    expectTypeOf<
      typeof helperScopedPostNestedCreateManyData
    >().toEqualTypeOf<ExpectedSchema>();

    expectTypeOf<{
      id: string;
      title: string;
    }>().not.toMatchTypeOf({} as RelationScopedPostCreateManyData);

    expectTypeOf<{
      id: string;
      title: string;
      categoryId: string;
    }>().toMatchTypeOf<RelationScopedPostCreateManyData>();
  });
});

// =============================================================================
// TYPE TESTS - Post Model (has manyToOne)
// =============================================================================

describe("Relation Create - Types (Post Model)", () => {
  type Input = InferInput<typeof postSchemas.relationCreate>;
  type Phase7CreateArgsInput = InferInput<
    typeof phase7Schemas.post.args.create
  >;
  type CompositeCreateArgsInput = InferInput<
    typeof compositeSchemas.post.args.create
  >;
  type MultiFkCreateArgsInput = InferInput<
    typeof multiFkSchemas.post.args.create
  >;

  test("type: includes relation field", () => {
    expectTypeOf<Input>().toHaveProperty("author");
  });

  test("type: direct create requires FK without relation data", () => {
    expectTypeOf<{
      data: { id: string; title: string };
    }>().not.toMatchTypeOf({} as Phase7CreateArgsInput);
  });

  test("type: direct create accepts relation data instead of FK", () => {
    expectTypeOf<{
      data: {
        id: string;
        title: string;
        author: { connect: { id: string } };
      };
    }>().toMatchTypeOf<Phase7CreateArgsInput>();
  });

  test("type: composite FK direct create rejects missing FK and relation data", () => {
    expectTypeOf<{
      data: { id: string; title: string };
    }>().not.toMatchTypeOf({} as CompositeCreateArgsInput);
  });

  test("type: composite FK direct create rejects one FK component", () => {
    expectTypeOf<{
      data: { id: string; title: string; authorId: string };
    }>().not.toMatchTypeOf({} as CompositeCreateArgsInput);
  });

  test("type: composite FK direct create accepts all FK components", () => {
    expectTypeOf<{
      data: {
        id: string;
        title: string;
        authorId: string;
        authorOrgId: string;
      };
    }>().toMatchTypeOf<CompositeCreateArgsInput>();
  });

  test("type: composite FK direct create accepts relation data", () => {
    expectTypeOf<{
      data: {
        id: string;
        title: string;
        author: {
          create: { id: string; orgId: string; name: string };
        };
      };
    }>().toMatchTypeOf<CompositeCreateArgsInput>();
  });

  test("type: multi-relation direct create rejects missing second relation group", () => {
    expectTypeOf<{
      data: {
        id: string;
        title: string;
        authorId: string;
        authorOrgId: string;
      };
    }>().not.toMatchTypeOf({} as MultiFkCreateArgsInput);
  });

  test("type: multi-relation direct create rejects partial composite relation group", () => {
    expectTypeOf<{
      data: {
        id: string;
        title: string;
        authorId: string;
        categoryId: string;
      };
    }>().not.toMatchTypeOf({} as MultiFkCreateArgsInput);
  });

  test("type: multi-relation direct create accepts every FK group", () => {
    expectTypeOf<{
      data: {
        id: string;
        title: string;
        authorId: string;
        authorOrgId: string;
        categoryId: string;
      };
    }>().toMatchTypeOf<MultiFkCreateArgsInput>();
  });

  test("type: multi-relation direct create accepts mixed relation alternatives", () => {
    expectTypeOf<{
      data: {
        id: string;
        title: string;
        author: {
          create: { id: string; orgId: string; name: string };
        };
        categoryId: string;
      };
    }>().toMatchTypeOf<MultiFkCreateArgsInput>();
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (oneToMany)
// =============================================================================

describe("Relation Create - Author Model Runtime (oneToMany)", () => {
  const schema = authorSchemas.relationCreate;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts create nested write", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "post-1", title: "Hello" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts create nested write without inverse FK", () => {
    const result = parse(phase7Schemas.author.core.relationCreate, {
      posts: {
        create: { id: "post-1", title: "Hello" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts inverse one-to-one create without inverse FK", () => {
    const result = parse(inverseOneToOneSchemas.user.core.relationCreate, {
      profile: {
        create: { id: "profile-1", bio: "Hello" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts createMany nested write", () => {
    const result = parse(schema, {
      posts: {
        createMany: {
          data: [
            { id: "post-1", title: "Hello" },
            { id: "post-2", title: "World" },
          ],
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts createMany nested write without inverse FK", () => {
    const result = parse(phase7Schemas.author.core.relationCreate, {
      posts: {
        createMany: {
          data: [
            { id: "post-1", title: "Hello" },
            { id: "post-2", title: "World" },
          ],
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects relation createMany without data", () => {
    const result = parse(phase7Schemas.author.core.relationCreate, {
      posts: {
        createMany: {},
      },
    });
    expect(result.issues?.[0]?.message).toBe("Missing required field: data");
    expect(result.issues?.[0]?.path).toEqual(["posts", "createMany", "data"]);
  });

  test("runtime: rejects args createMany without data", () => {
    const result = parse(phase7Schemas.author.args.create, {
      data: {
        id: "author-1",
        name: "Alice",
        posts: {
          createMany: {},
        },
      },
    });
    expect(result.issues?.[0]?.message).toBe("Missing required field: data");
    expect(result.issues?.[0]?.path).toEqual([
      "data",
      "posts",
      "createMany",
      "data",
    ]);
  });

  test("runtime: rejects create nested write missing non-derived field", () => {
    const result = parse(phase7Schemas.author.core.relationCreate, {
      posts: {
        create: { id: "post-1" },
      },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: createMany requires FK not derived from parent relation", () => {
    const result = parse(relationScopedSchemas.author.args.create, {
      data: {
        id: "author-1",
        name: "Alice",
        posts: {
          createMany: {
            data: [{ id: "post-1", title: "Hello" }],
          },
        },
      },
    });

    expect(result.issues?.[0]?.path).toEqual([
      "data",
      "posts",
      "createMany",
      "data",
      0,
    ]);
  });

  test("runtime: createMany accepts FK not derived from parent relation", () => {
    const result = parse(relationScopedSchemas.author.args.create, {
      data: {
        id: "author-1",
        name: "Alice",
        posts: {
          createMany: {
            data: [{ id: "post-1", title: "Hello", categoryId: "category-1" }],
          },
        },
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("runtime: createMany accepts a relation not derived from its parent", () => {
    const result = parse(relationScopedSchemas.author.args.create, {
      data: {
        id: "author-1",
        name: "Alice",
        posts: {
          createMany: {
            data: [
              {
                id: "post-1",
                title: "Hello",
                category: { connect: { id: "category-1" } },
              },
            ],
          },
        },
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts connect nested write", () => {
    const result = parse(schema, {
      posts: {
        connect: { id: "existing-post-id" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts connect array for toMany", () => {
    const result = parse(schema, {
      posts: {
        connect: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne)
// =============================================================================

describe("Relation Create - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.relationCreate;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts create nested write", () => {
    const result = parse(schema, {
      author: {
        create: { id: "author-1", name: "Alice" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts connect nested write", () => {
    const result = parse(schema, {
      author: {
        connect: { id: "existing-author-id" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts connectOrCreate nested write", () => {
    const result = parse(schema, {
      author: {
        connectOrCreate: {
          where: { id: "author-1" },
          create: { id: "author-1", name: "Alice" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test.each([
    ["empty", {}],
    ["missing create", { where: { id: "author-1" } }],
    ["missing where", { create: { id: "author-1", name: "Alice" } }],
  ] as const)("runtime: rejects connectOrCreate envelope %s", (_, envelope) => {
    const result = parse(schema, {
      author: {
        connectOrCreate: envelope,
      },
    });
    expect(result.issues).toBeDefined();
  });
});

describe("Relation Create - Composite FK Direct Create Runtime", () => {
  const schema = compositeSchemas.post.args.create;

  test("runtime: rejects missing FK and relation data", () => {
    const result = parse(schema, {
      data: {
        id: "post-1",
        title: "Hello World",
      },
    });

    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects one FK component", () => {
    const result = parse(schema, {
      data: {
        id: "post-1",
        title: "Hello World",
        authorId: "author-1",
      },
    });

    expect(result.issues).toBeDefined();
  });

  test("runtime: accepts all FK components", () => {
    const result = parse(schema, {
      data: {
        id: "post-1",
        title: "Hello World",
        authorId: "author-1",
        authorOrgId: "org-1",
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation data", () => {
    const result = parse(schema, {
      data: {
        id: "post-1",
        title: "Hello World",
        author: {
          create: {
            id: "author-1",
            orgId: "org-1",
            name: "Alice",
          },
        },
      },
    });

    expect(result.issues).toBeUndefined();
  });
});

describe("Relation Create - Optional Composite FK Direct Create Runtime", () => {
  const schema = optionalCompositeSchemas.child.args.create;

  test("runtime: requires only non-produced members of an empty compound slot", () => {
    expect(
      parse(schema, {
        data: { id: "child-1", tenantId: "tenant-1" },
      }).issues
    ).toBeUndefined();
    expect(parse(schema, { data: { id: "child-1" } }).issues).toBeDefined();
  });
});

describe("Relation Create - Multiple FK Direct Create Runtime", () => {
  const schema = multiFkSchemas.post.args.create;

  test("runtime: rejects missing second relation group", () => {
    const result = parse(schema, {
      data: {
        id: "post-1",
        title: "Hello World",
        authorId: "author-1",
        authorOrgId: "org-1",
      },
    });

    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects partial composite relation group", () => {
    const result = parse(schema, {
      data: {
        id: "post-1",
        title: "Hello World",
        authorId: "author-1",
        categoryId: "category-1",
      },
    });

    expect(result.issues).toBeDefined();
  });

  test("runtime: accepts every FK group", () => {
    const result = parse(schema, {
      data: {
        id: "post-1",
        title: "Hello World",
        authorId: "author-1",
        authorOrgId: "org-1",
        categoryId: "category-1",
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts mixed relation alternatives", () => {
    const result = parse(schema, {
      data: {
        id: "post-1",
        title: "Hello World",
        author: {
          create: {
            id: "author-1",
            orgId: "org-1",
            name: "Alice",
          },
        },
        categoryId: "category-1",
      },
    });

    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no relations)
// =============================================================================

describe("Relation Create - Simple Model Runtime (no relations)", () => {
  const schema = simpleSchemas.relationCreate;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects unknown relation key (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { anyRelation: {} });
    expect(result.issues).toBeDefined();
  });
});
