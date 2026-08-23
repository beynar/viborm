/**
 * Relation Select & Include Schema Tests
 *
 * Tests select and include schemas for both to-one and to-many relations:
 * - ToOne Select: true or { select }
 * - ToMany Select: true or { where, orderBy, take, skip, select }
 * - ToOne Include: true or { select, include }
 * - ToMany Include: true or { where, orderBy, take, skip, select, include }
 *
 * Nested `cursor` and negative `take` are rejected: the include builder does
 * not implement them, and accepting them silently returned wrong results.
 *
 * Note: Boolean values are transformed to explicit select objects:
 * - `true` becomes `{ select: { field1: true, field2: true, ... } }`
 * - `false` stays `false` so the query engine omits the relation
 *
 * Covers:
 * - Type inference with expectTypeOf
 * - Runtime validation with parse
 * - Output verification (with transformation)
 * - Nested selection/inclusion
 * - Pagination options for to-many relations
 */

import { s } from "@schema";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

const MUTUALLY_EXCLUSIVE = /mutually exclusive/i;

import {
  optionalOneToOneSchemas,
  requiredManyToOneSchemas,
  requiredOneToManySchemas,
  selfRefOneToManySchemas,
} from "@tests/unit/operation-schemas/relations/fixtures";

type RelationOutput = {
  readonly [key: string]: unknown;
  readonly select?: RelationOutput;
  readonly include?: Record<string, RelationOutput>;
  readonly where?: Record<string, RelationOutput>;
  readonly orderBy?: Record<string, unknown>;
  readonly take?: number;
  readonly skip?: number;
};

const output = (value: unknown): RelationOutput => value as RelationOutput;

test("relations to a PROJECTION-empty model do not invent a selection", () => {
  // The target's every scalar is hidden by model-level `.omit()`, which is the
  // only way a model can have nothing to project and still be a relation
  // endpoint: a stored reference needs a referenced column and a junction side
  // needs a complete row key, so a model with NO scalars at all can no longer
  // take part in any edge.
  const empty = s
    .model({
      id: s.string().id(),
      holderId: s.string(),
      holder: s
        .toOne(() => holder)
        .fields("holderId")
        .references("id"),
    })
    .omit({ id: true, holderId: true });
  const holder = s.model({
    id: s.string().id(),
    empties: s.toMany(() => empty),
  });
  const schemas = createSchemaRegistry({ empty, holder }).proxy.holder.relations
    .empties;

  expect(parse(schemas.select, true)).toEqual({ value: {} });
  expect(parse(schemas.include, {})).toEqual({ value: {} });
});

// =============================================================================
// TO-ONE SELECT
// =============================================================================

describe("ToOne Select (Post.author)", () => {
  const schema = requiredManyToOneSchemas.select;
  type SelectInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts boolean true", () => {
      expectTypeOf<true>().toMatchTypeOf<SelectInput>();
    });

    test("type: accepts boolean false", () => {
      expectTypeOf<false>().toMatchTypeOf<SelectInput>();
    });

    test("type: accepts nested select object", () => {
      expectTypeOf<{
        select?: { id?: boolean; name?: boolean };
      }>().toMatchTypeOf<SelectInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts boolean true - transforms to select object", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all fields } }
        expect(output(result.value)).toHaveProperty("select");
        expect(output(result.value).select).toHaveProperty("id", true);
        expect(output(result.value).select).toHaveProperty("name", true);
        expect(output(result.value).select).toHaveProperty("email", true);
        expect(output(result.value).select).not.toHaveProperty("posts", true);
      }
    });

    test("runtime: accepts boolean false - stays false so the relation is omitted", () => {
      const result = parse(schema, false);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Prisma parity: false stays false; the query engine skips the relation
        expect(result.value).toBe(false);
      }
    });

    test("runtime: accepts nested select object", () => {
      const input = {
        select: {
          id: true,
          name: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();

      if (!result.issues) {
        expect(output(result.value).select?.id).toBe(true);
        expect(output(result.value).select?.name).toBe(true);
      }
    });

    test("runtime: accepts empty object - adds default select", () => {
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // No explicit select: the default all-scalars select is added
        expect(output(result.value).select).toHaveProperty("id", true);
      }
    });

    test("runtime: preserves nested select structure with false values", () => {
      const input = {
        select: {
          id: true,
          name: true,
          email: false,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).select?.id).toBe(true);
        expect(output(result.value).select?.name).toBe(true);
        expect(output(result.value).select?.email).toBe(false);
      }
    });
  });
});

// =============================================================================
// TO-ONE INCLUDE
// =============================================================================

describe("ToOne Include (Post.author)", () => {
  const schema = requiredManyToOneSchemas.include;
  type IncludeInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts boolean true", () => {
      expectTypeOf<true>().toMatchTypeOf<IncludeInput>();
    });

    test("type: accepts nested select object", () => {
      expectTypeOf<{
        select?: { id?: boolean };
      }>().toMatchTypeOf<IncludeInput>();
    });

    test("type: accepts nested include object", () => {
      expectTypeOf<{
        include?: { posts?: boolean };
      }>().toMatchTypeOf<IncludeInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts boolean true - transforms to select object", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all fields } }
        expect(output(result.value)).toHaveProperty("select");
        expect(output(result.value).select).toHaveProperty("id", true);
        expect(output(result.value).select).toHaveProperty("name", true);
        expect(output(result.value).select).toHaveProperty("email", true);
      }
    });

    test("runtime: accepts nested select within include - preserves select", () => {
      const input = {
        select: {
          id: true,
          name: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // When explicit select provided, it's preserved
        expect(output(result.value).select?.id).toBe(true);
        expect(output(result.value).select?.name).toBe(true);
      }
    });

    test("runtime: accepts nested include - adds default select", () => {
      const input = {
        include: {
          posts: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Include without select gets default select added
        expect(output(result.value)).toHaveProperty("select");
        // Nested posts: true is also transformed
        expect(output(result.value).include?.posts).toHaveProperty("select");
      }
    });

    test("runtime: rejects combined select and include on the same node", () => {
      const input = {
        select: { id: true },
        include: { posts: true },
      };
      const result = parse(schema, input);
      // Prisma parity: select and include are mutually exclusive
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toMatch(MUTUALLY_EXCLUSIVE);
    });

    test("runtime: accepts deeply nested include - all booleans transform", () => {
      const input = {
        include: {
          posts: {
            include: {
              author: true,
            },
          },
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Top level gets select added
        expect(output(result.value)).toHaveProperty("select");
        // Nested posts gets select added
        expect(output(result.value).include?.posts).toHaveProperty("select");
        // Deeply nested author: true transforms
        expect(
          output(result.value).include?.posts?.include?.author
        ).toHaveProperty("select");
      }
    });
  });
});

// =============================================================================
// TO-MANY SELECT
// =============================================================================

describe("ToMany Select (Author.posts)", () => {
  const schema = requiredOneToManySchemas.select;
  type SelectInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts boolean true", () => {
      expectTypeOf<true>().toMatchTypeOf<SelectInput>();
    });

    test("type: accepts nested select with where", () => {
      expectTypeOf<{
        where?: { published?: boolean };
        select?: { id?: boolean };
      }>().toMatchTypeOf<SelectInput>();
    });

    test("type: accepts pagination options", () => {
      expectTypeOf<{
        take?: number;
        skip?: number;
      }>().toMatchTypeOf<SelectInput>();
    });

    test("type: accepts orderBy option", () => {
      expectTypeOf<{
        orderBy?: { title?: "asc" | "desc" };
      }>().toMatchTypeOf<SelectInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts boolean true - transforms to select object", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all Post fields } }
        expect(output(result.value)).toHaveProperty("select");
        expect(output(result.value).select).toHaveProperty("id", true);
        expect(output(result.value).select).toHaveProperty("title", true);
        expect(output(result.value).select).toHaveProperty("content", true);
        expect(output(result.value).select).toHaveProperty("published", true);
        expect(output(result.value).select).toHaveProperty("authorId", true);
      }
    });

    test("runtime: accepts nested select object", () => {
      const input = {
        select: {
          id: true,
          title: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).select?.id).toBe(true);
        expect(output(result.value).select?.title).toBe(true);
      }
    });

    test("runtime: accepts select with where filter", () => {
      const input = {
        where: { published: true },
        select: { id: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar filter values are transformed to { equals: value }
        expect(output(result.value).where?.published).toEqual({ equals: true });
        expect(output(result.value).select?.id).toBe(true);
      }
    });

    test("runtime: accepts select with pagination", () => {
      const input = {
        take: 10,
        skip: 5,
        select: { id: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).take).toBe(10);
        expect(output(result.value).skip).toBe(5);
        expect(output(result.value).select?.id).toBe(true);
      }
    });

    test("runtime: accepts select with orderBy", () => {
      const input = {
        orderBy: { title: "asc" },
        select: { id: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).orderBy?.title).toBe("asc");
        expect(output(result.value).select?.id).toBe(true);
      }
    });

    test("runtime: accepts all options combined", () => {
      const input = {
        where: { published: true },
        orderBy: { title: "desc" },
        take: 10,
        skip: 0,
        select: { id: true, title: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar filter values are transformed to { equals: value }
        expect(output(result.value).where?.published).toEqual({ equals: true });
        expect(output(result.value).orderBy?.title).toBe("desc");
        expect(output(result.value).take).toBe(10);
        expect(output(result.value).skip).toBe(0);
        expect(output(result.value).select?.id).toBe(true);
        expect(output(result.value).select?.title).toBe(true);
      }
    });
  });
});

// =============================================================================
// TO-MANY INCLUDE
// =============================================================================

describe("ToMany Include (Author.posts)", () => {
  const schema = requiredOneToManySchemas.include;
  type IncludeInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts boolean true", () => {
      expectTypeOf<true>().toMatchTypeOf<IncludeInput>();
    });

    test("type: accepts nested options", () => {
      expectTypeOf<{
        where?: { published?: boolean };
        orderBy?: { title?: "asc" | "desc" };
        take?: number;
        skip?: number;
        select?: { id?: boolean };
        include?: { author?: boolean };
      }>().toMatchTypeOf<IncludeInput>();
    });

    // Retargeted (W3-A unit 2): `cursor` exists on to-many relation args now,
    // but only as a whereUnique of the related model — never a bare scalar.
    test("type: rejects a non-whereUnique cursor", () => {
      expectTypeOf<{ cursor: string }>().not.toMatchTypeOf<IncludeInput>();
    });

    test("type: accepts a whereUnique cursor", () => {
      expectTypeOf<{ cursor: { id: string } }>().toMatchTypeOf<IncludeInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts boolean true - transforms to select object", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all Post fields } }
        expect(output(result.value)).toHaveProperty("select");
        expect(output(result.value).select).toHaveProperty("id", true);
        expect(output(result.value).select).toHaveProperty("title", true);
      }
    });

    test("runtime: accepts with where filter - adds default select", () => {
      const input = { where: { published: true } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar filter values are transformed to { equals: value }
        expect(output(result.value).where?.published).toEqual({ equals: true });
        // Default select is added
        expect(output(result.value)).toHaveProperty("select");
      }
    });

    test("runtime: accepts with pagination - adds default select", () => {
      const input = { take: 10, skip: 5 };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).take).toBe(10);
        expect(output(result.value).skip).toBe(5);
        // Default select is added
        expect(output(result.value)).toHaveProperty("select");
      }
    });

    test("runtime: accepts with orderBy - adds default select", () => {
      const input = { orderBy: { title: "asc" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).orderBy?.title).toBe("asc");
        // Default select is added
        expect(output(result.value)).toHaveProperty("select");
      }
    });

    // Retargeted (W3-A unit 2): nested `cursor` is a whereUnique of the RELATED
    // model — accepted in that shape, still refused as a bare scalar.
    test("runtime: rejects a cursor that is not a whereUnique object", () => {
      const input = { cursor: "cursor-value" };
      const result = parse(schema, input);
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts a whereUnique cursor", () => {
      const input = { cursor: { id: "post-1" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).cursor).toEqual({ id: "post-1" });
      }
    });

    test("runtime: accepts distinct over related scalar fields", () => {
      const input = { distinct: ["title"] };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).distinct).toEqual(["title"]);
      }
    });

    test("runtime: rejects a distinct field the related model does not have", () => {
      const input = { distinct: ["nope"] };
      const result = parse(schema, input);
      expect(result.issues).toBeDefined();
    });

    // Retargeted (W3-A unit 1): nested `take` is now the top-level take schema —
    // a negative value is Prisma's "last N", a non-integer is still refused.
    test("runtime: accepts negative take - Prisma 'last N' semantics", () => {
      const input = { take: -5 };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).take).toBe(-5);
      }
    });

    test("runtime: rejects a non-integer take", () => {
      const input = { take: 1.5 };
      const result = parse(schema, input);
      expect(result.issues).toBeDefined();
    });

    test("runtime: rejects a negative skip", () => {
      const input = { skip: -1 };
      const result = parse(schema, input);
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts with nested include - transforms nested boolean", () => {
      const input = {
        include: {
          author: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Default select is added
        expect(output(result.value)).toHaveProperty("select");
        // Nested author: true transforms to { select: {...} }
        expect(output(result.value).include?.author).toHaveProperty("select");
      }
    });

    test("runtime: accepts with nested select - preserves explicit select", () => {
      const input = {
        select: {
          id: true,
          title: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Explicit select is preserved
        expect(output(result.value).select?.id).toBe(true);
        expect(output(result.value).select?.title).toBe(true);
      }
    });

    test("runtime: accepts all options combined - transforms nested values", () => {
      const input = {
        where: { published: true },
        orderBy: { title: "desc" },
        take: 10,
        skip: 0,
        select: { id: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar filter values are transformed to { equals: value }
        expect(output(result.value).where?.published).toEqual({ equals: true });
        expect(output(result.value).orderBy?.title).toBe("desc");
        expect(output(result.value).take).toBe(10);
        expect(output(result.value).skip).toBe(0);
        // Explicit select is preserved
        expect(output(result.value).select?.id).toBe(true);
      }
    });

    test("runtime: rejects combined select and include on the same node", () => {
      const result = parse(schema, {
        select: { id: true },
        include: { author: true },
      });
      // Prisma parity: select and include are mutually exclusive
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toMatch(MUTUALLY_EXCLUSIVE);
    });
  });
});

// =============================================================================
// OPTIONAL RELATION SELECT/INCLUDE
// =============================================================================

describe("Optional Relation Select/Include (Profile.user)", () => {
  const selectSchema = optionalOneToOneSchemas.select;
  const includeSchema = optionalOneToOneSchemas.include;

  describe("select runtime", () => {
    test("runtime: accepts boolean for optional relation - transforms", () => {
      const result = parse(selectSchema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all User fields } }
        expect(output(result.value)).toHaveProperty("select");
        expect(output(result.value).select).toHaveProperty("id", true);
        expect(output(result.value).select).toHaveProperty("username", true);
      }
    });

    test("runtime: accepts nested select for optional relation", () => {
      const input = { select: { id: true, username: true } };
      const result = parse(selectSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).select?.id).toBe(true);
        expect(output(result.value).select?.username).toBe(true);
      }
    });
  });

  describe("include runtime", () => {
    test("runtime: accepts boolean for optional relation - transforms", () => {
      const result = parse(includeSchema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all User fields } }
        expect(output(result.value)).toHaveProperty("select");
        expect(output(result.value).select).toHaveProperty("id", true);
        expect(output(result.value).select).toHaveProperty("username", true);
      }
    });

    test("runtime: accepts nested include for optional relation - transforms", () => {
      const input = {
        include: {
          profile: true,
        },
      };
      const result = parse(includeSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Default select is added
        expect(output(result.value)).toHaveProperty("select");
        // Nested profile: true transforms
        expect(output(result.value).include?.profile).toHaveProperty("select");
      }
    });
  });
});

// =============================================================================
// SELF-REFERENTIAL SELECT/INCLUDE
// =============================================================================

describe("Self-Referential Select/Include (User.subordinates)", () => {
  const selectSchema = selfRefOneToManySchemas.select;
  const includeSchema = selfRefOneToManySchemas.include;

  describe("runtime", () => {
    test("runtime: accepts nested self-referential select", () => {
      const input = {
        select: {
          id: true,
          username: true,
        },
      };
      const result = parse(selectSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).select?.id).toBe(true);
        expect(output(result.value).select?.username).toBe(true);
      }
    });

    test("runtime: accepts nested self-referential include - transforms", () => {
      const input = {
        include: {
          subordinates: true,
        },
      };
      const result = parse(includeSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Default select is added
        expect(output(result.value)).toHaveProperty("select");
        // Nested subordinates: true transforms
        expect(output(result.value).include?.subordinates).toHaveProperty(
          "select"
        );
      }
    });

    test("runtime: accepts deeply nested self-referential include - all transform", () => {
      const input = {
        include: {
          subordinates: {
            include: {
              subordinates: true,
            },
          },
        },
      };
      const result = parse(includeSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Default select is added at each level
        expect(output(result.value)).toHaveProperty("select");
        expect(output(result.value).include?.subordinates).toHaveProperty(
          "select"
        );
        // Deeply nested subordinates: true transforms
        expect(
          output(result.value).include?.subordinates?.include?.subordinates
        ).toHaveProperty("select");
      }
    });

    test("runtime: accepts select with pagination for self-ref", () => {
      const input = {
        take: 10,
        where: { username: { startsWith: "user" } },
        select: { id: true },
      };
      const result = parse(selectSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(output(result.value).take).toBe(10);
        expect(output(result.value).where?.username?.startsWith).toBe("user");
        expect(output(result.value).select?.id).toBe(true);
      }
    });
  });
});
