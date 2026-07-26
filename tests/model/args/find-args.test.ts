/**
 * Find Args Schema Tests
 *
 * Tests the args schemas for find operations:
 * - findUnique: where (required), select, include
 * - findFirst: where, select, include, orderBy
 * - findMany: where, select, include, orderBy, take, skip, cursor
 */

import { s } from "@schema";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  authorSchemas,
  compoundIdSchemas,
  compoundUniqueSchemas,
  simpleSchemas,
} from "../fixtures";

type ArgsOutput = {
  readonly where?: unknown;
  readonly orderBy?: unknown;
  readonly select?: unknown;
  readonly take?: number;
  readonly skip?: number;
  readonly cursor?: unknown;
  readonly distinct?: unknown;
};

const argsOutput = (value: unknown): ArgsOutput => value as ArgsOutput;

const nestedAuthorModel = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.oneToMany(() => nestedPostModel),
});

const nestedPostModel = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s.manyToOne(() => nestedAuthorModel),
});

const nestedCommentModel = s.model({
  id: s.string().id(),
  postId: s.string(),
  post: s.manyToOne(() => nestedPostModel),
});

const nestedUserModel = s.model({
  id: s.string().id(),
  username: s.string(),
  managerId: s.string().nullable(),
  manager: s.manyToOne(() => nestedUserModel).optional(),
});

const nestedOrderByRegistry = createSchemaRegistry({
  comment: nestedCommentModel,
  user: nestedUserModel,
});

const nestedCommentSchemas = nestedOrderByRegistry.proxy.comment;
const nestedUserSchemas = nestedOrderByRegistry.proxy.user;

// =============================================================================
// FIND UNIQUE ARGS
// =============================================================================

describe("FindUnique Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.findUnique>;

  test("type: has required where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has optional select", () => {
    expectTypeOf<Input>().toHaveProperty("select");
  });

  test("type: has optional include", () => {
    expectTypeOf<Input>().toHaveProperty("include");
  });
});

describe("FindUnique Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.findUnique;

  test("runtime: accepts where with id", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts where with unique field", () => {
    const result = parse(schema, {
      where: { email: "alice@example.com" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with select", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects missing where", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects empty where", () => {
    const result = parse(schema, { where: {} });
    expect(result.issues?.[0]?.message).toBe("Object cannot be empty");
  });

  test("runtime: rejects non-unique field in where (strict schema)", () => {
    // Schema is strict - only unique fields are valid in whereUnique
    const result = parse(schema, {
      where: { name: "Alice" }, // name is not unique
    });
    expect(result.issues).toBeDefined();
  });

  test("output: preserves where values correctly", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(argsOutput(result.value).where).toEqual({ id: "user-123" });
    }
  });

  test("output: preserves select values correctly", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(argsOutput(result.value).select).toEqual({ id: true, name: true });
    }
  });
});

describe("FindUnique Args - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas.args.findUnique;

  test("runtime: accepts compound id in where", () => {
    const result = parse(schema, {
      where: {
        orgId_memberId: { orgId: "org-1", memberId: "member-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

describe("FindUnique Args - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.args.findUnique;

  test("runtime: accepts with include", () => {
    const result = parse(schema, {
      where: { id: "author-1" },
      include: { posts: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with nested include", () => {
    const result = parse(schema, {
      where: { id: "author-1" },
      include: {
        posts: {
          where: { published: true },
          take: 5,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

describe("Find Args - Top-level Select/Include Exclusivity Runtime", () => {
  test("runtime: findUnique rejects top-level select and include", () => {
    const result = parse(authorSchemas.args.findUnique, {
      where: { id: "author-1" },
      select: { id: true },
      include: { posts: true },
    });
    expect(result.issues?.[0]?.message).toBe(
      "Mutually exclusive fields cannot be used together: select, include"
    );
  });

  test("runtime: findFirst rejects top-level select and include", () => {
    const result = parse(authorSchemas.args.findFirst, {
      select: { id: true },
      include: { posts: true },
    });
    expect(result.issues?.[0]?.message).toBe(
      "Mutually exclusive fields cannot be used together: select, include"
    );
  });

  test("runtime: findMany rejects top-level select and include", () => {
    const result = parse(authorSchemas.args.findMany, {
      select: { id: true },
      include: { posts: true },
    });
    expect(result.issues?.[0]?.message).toBe(
      "Mutually exclusive fields cannot be used together: select, include"
    );
  });
});

// =============================================================================
// FIND FIRST ARGS
// =============================================================================

describe("FindFirst Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.findFirst>;

  test("type: has optional where", () => {
    expectTypeOf<{ where?: { active?: boolean } }>().toMatchTypeOf<Input>();
  });

  test("type: has optional orderBy", () => {
    expectTypeOf<{ orderBy?: { name?: "asc" } }>().toMatchTypeOf<Input>();
  });
});

describe("FindFirst Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.findFirst;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with where", () => {
    const result = parse(schema, {
      where: { active: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with orderBy", () => {
    const result = parse(schema, {
      orderBy: { name: "asc" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with select", () => {
    const result = parse(schema, {
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts all options", () => {
    const result = parse(schema, {
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves all fields correctly (with filter normalization)", () => {
    const input = {
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    };
    const result = parse(schema, input);
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      // Filter values are normalized to { equals: value }
      expect(argsOutput(result.value).where).toEqual({
        active: { equals: true },
      });
      expect(argsOutput(result.value).orderBy).toEqual({ name: "asc" });
      expect(argsOutput(result.value).select).toEqual({ id: true, name: true });
    }
  });
});

// =============================================================================
// FIND MANY ARGS
// =============================================================================

describe("FindMany Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.findMany>;

  test("type: has optional where", () => {
    expectTypeOf<{ where?: { active?: boolean } }>().toMatchTypeOf<Input>();
  });

  test("type: has optional take", () => {
    expectTypeOf<{ take?: number }>().toMatchTypeOf<Input>();
  });

  test("type: has optional skip", () => {
    expectTypeOf<{ skip?: number }>().toMatchTypeOf<Input>();
  });

  test("type: has optional cursor", () => {
    expectTypeOf<{ cursor?: { id: string } }>().toMatchTypeOf<Input>();
  });
});

describe("FindMany Args - Compound Cursor Types", () => {
  type Input = InferInput<typeof compoundIdSchemas.args.findMany>;

  test("type: cursor uses whereUnique compound id input", () => {
    expectTypeOf<{
      cursor?: { orgId_memberId: { orgId: string; memberId: string } };
    }>().toMatchTypeOf<Input>();
  });
});

describe("FindMany Args - Nested Relation OrderBy Types", () => {
  type CommentInput = InferInput<typeof nestedCommentSchemas.args.findMany>;
  type UserInput = InferInput<typeof nestedUserSchemas.args.findMany>;

  test("type: accepts two-hop to-one relation orderBy", () => {
    const input = {
      orderBy: { post: { author: { name: "asc" } } },
    } satisfies CommentInput;

    expectTypeOf(input).toMatchTypeOf<CommentInput>();
  });

  test("type: accepts an eight-hop to-one relation orderBy", () => {
    // MAX_RELATION_ORDER_DEPTH (src/validation/relations/order-by.ts) is 8.
    const input = {
      orderBy: {
        manager: {
          manager: {
            manager: {
              manager: {
                manager: {
                  manager: { manager: { manager: { username: "asc" } } },
                },
              },
            },
          },
        },
      },
    } satisfies UserInput;

    expectTypeOf(input).toMatchTypeOf<UserInput>();
  });

  test("type: rejects a nine-hop to-one relation orderBy", () => {
    // Stays on ONE line (like the to-many case below): split across lines, the
    // error is reported on an inner property and @ts-expect-error misses it.
    // @ts-expect-error relation orderBy is capped at eight relation hops
    const tooDeep: UserInput = { orderBy: { manager: { manager: { manager: { manager: { manager: { manager: { manager: { manager: { manager: { username: "asc" } } } } } } } } } } };
    expect(tooDeep).toBeDefined();
  });

  test("type: rejects to-many relation in a to-one orderBy chain", () => {
    // @ts-expect-error nested to-many relations are excluded from to-one orderBy chains
    const withToMany: CommentInput = { orderBy: { post: { author: { posts: { _count: "asc" } } } } };
    expect(withToMany).toBeDefined();
  });
});

describe("FindMany Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.findMany;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with where", () => {
    const result = parse(schema, {
      where: { active: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with take and skip", () => {
    const result = parse(schema, {
      take: 10,
      skip: 0,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts negative take", () => {
    const result = parse(schema, {
      take: -10,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects fractional take", () => {
    const result = parse(schema, {
      take: 1.5,
    });
    expect(result.issues?.[0]?.message).toBe("Expected integer");
  });

  test("runtime: rejects fractional skip", () => {
    const result = parse(schema, {
      skip: 1.5,
    });
    expect(result.issues?.[0]?.message).toBe("Expected integer");
  });

  test("runtime: rejects negative skip", () => {
    const result = parse(schema, {
      skip: -1,
    });
    expect(result.issues?.[0]?.message).toBe(
      "Transform failed: skip must be greater than or equal to 0"
    );
  });

  test("runtime: rejects non-finite take values", () => {
    for (const take of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = parse(schema, { take });
      expect(result.issues?.[0]?.message).toBe("Expected integer");
    }
  });

  test("runtime: accepts with cursor", () => {
    const result = parse(schema, {
      cursor: { id: "last-seen-id" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects non-unique cursor field", () => {
    const result = parse(schema, {
      cursor: { name: "Alice" },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: accepts with orderBy array", () => {
    const result = parse(schema, {
      orderBy: [{ name: "asc" }, { age: "desc" }],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with distinct", () => {
    const result = parse(schema, {
      distinct: ["name"],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts all options combined", () => {
    const result = parse(schema, {
      where: { active: true },
      orderBy: { name: "asc" },
      take: 20,
      skip: 10,
      cursor: { id: "cursor-id" },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves take and skip as numbers", () => {
    const result = parse(schema, {
      take: 20,
      skip: 10,
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(argsOutput(result.value).take).toBe(20);
      expect(argsOutput(result.value).skip).toBe(10);
    }
  });

  test("output: preserves cursor correctly", () => {
    const result = parse(schema, {
      cursor: { id: "cursor-id" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(argsOutput(result.value).cursor).toEqual({ id: "cursor-id" });
    }
  });

  test("output: preserves distinct array", () => {
    const result = parse(schema, {
      distinct: ["name", "email"],
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(argsOutput(result.value).distinct).toEqual(["name", "email"]);
    }
  });

  test("output: preserves orderBy array", () => {
    const result = parse(schema, {
      orderBy: [{ name: "asc" }, { age: "desc" }],
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(argsOutput(result.value).orderBy).toEqual([
        { name: "asc" },
        { age: "desc" },
      ]);
    }
  });
});

describe("FindMany Args - Compound Cursor Runtime", () => {
  test("runtime: accepts compound id cursor", () => {
    const result = parse(compoundIdSchemas.args.findMany, {
      cursor: {
        orgId_memberId: { orgId: "org-1", memberId: "member-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts compound unique cursor", () => {
    const result = parse(compoundUniqueSchemas.args.findMany, {
      cursor: {
        email_tenantId: {
          email: "alice@example.com",
          tenantId: "tenant-1",
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

describe("FindMany Args - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.args.findMany;

  test("runtime: accepts with include and take/skip", () => {
    const result = parse(schema, {
      where: { name: { startsWith: "A" } },
      include: {
        posts: {
          where: { published: true },
          take: 5,
        },
      },
      take: 10,
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// DISTINCT — findFirst support + bare-string shorthand
// =============================================================================

describe("Distinct Args - findMany and findFirst", () => {
  const findMany = simpleSchemas.args.findMany;
  const findFirst = simpleSchemas.args.findFirst;

  test("type: findMany accepts a bare string and an array", () => {
    type Input = InferInput<typeof simpleSchemas.args.findMany>;
    expectTypeOf<{ distinct: "name" }>().toMatchTypeOf<Input>();
    expectTypeOf<{ distinct: ["name", "email"] }>().toMatchTypeOf<Input>();
  });

  test("type: findFirst accepts distinct in both spellings", () => {
    type Input = InferInput<typeof simpleSchemas.args.findFirst>;
    expectTypeOf<{ distinct: "name" }>().toMatchTypeOf<Input>();
    expectTypeOf<{ distinct: ["name"] }>().toMatchTypeOf<Input>();
  });

  test("type: a non-scalar name is not assignable", () => {
    type Input = InferInput<typeof simpleSchemas.args.findFirst>;
    expectTypeOf<{ distinct: "nope" }>().not.toMatchTypeOf<Input>();
  });

  test("runtime: findFirst accepts distinct as an array", () => {
    const result = parse(findFirst, { distinct: ["name"] });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(argsOutput(result.value).distinct).toEqual(["name"]);
    }
  });

  test("runtime: a bare string normalizes to a one-element array", () => {
    for (const schema of [findMany, findFirst]) {
      const result = parse(schema, { distinct: "name" });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(argsOutput(result.value).distinct).toEqual(["name"]);
      }
    }
  });

  test("runtime: string and array spellings produce the same output", () => {
    const fromString = parse(findFirst, { distinct: "email" });
    const fromArray = parse(findFirst, { distinct: ["email"] });
    expect(fromString.issues).toBeUndefined();
    expect(fromArray.issues).toBeUndefined();
    if (!(fromString.issues || fromArray.issues)) {
      expect(argsOutput(fromString.value).distinct).toEqual(
        argsOutput(fromArray.value).distinct
      );
    }
  });

  test("runtime: rejects an unknown field name in either spelling", () => {
    expect(parse(findFirst, { distinct: "nope" }).issues).toBeDefined();
    expect(parse(findFirst, { distinct: ["nope"] }).issues).toBeDefined();
    expect(parse(findMany, { distinct: "nope" }).issues).toBeDefined();
  });

  test("runtime: findFirst still rejects unknown top-level keys", () => {
    expect(parse(findFirst, { distinctt: ["name"] }).issues).toBeDefined();
  });

  test("runtime: findUnique does not accept distinct (Prisma parity)", () => {
    const result = parse(simpleSchemas.args.findUnique, {
      where: { id: "1" },
      distinct: ["name"],
    });
    expect(result.issues).toBeDefined();
  });
});
