/**
 * Relation Update Schema Tests
 *
 * Tests update schemas for both to-one and to-many relations:
 * - ToOne Update: { create?, connect?, connectOrCreate?, update?, upsert?, disconnect?, delete? }
 *   - disconnect/delete only for optional relations
 * - ToMany Update: { create?, createMany?, connect?, disconnect?, delete?, connectOrCreate?, set?, update?, updateMany?, upsert?, deleteMany? }
 *   - All operations accept single or array, normalized to array
 *
 * Covers:
 * - Type inference with expectTypeOf
 * - Runtime validation with parse
 * - Optional vs required relation differences
 * - Array normalization for to-many relations
 */

import { type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  optionalManyToOneSchemas,
  optionalOneToOneSchemas,
  requiredManyToOneSchemas,
  requiredOneToManySchemas,
} from "./fixtures";

// Test-only view over generated relation update output unions.
// Runtime assertions below still verify concrete transformed shapes.
type RelationUpdateOutput = any;

const relationOutput = (value: unknown): RelationUpdateOutput =>
  value as RelationUpdateOutput;

// =============================================================================
// TO-ONE UPDATE (Required Relation)
// =============================================================================

describe("ToOne Update - Required (Post.author)", () => {
  const schema = requiredManyToOneSchemas.update;
  type UpdateInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts create property", () => {
      expectTypeOf<{
        create?: { id: string; name: string; email: string };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts connect property", () => {
      expectTypeOf<{ connect?: { id: string } }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: connectOrCreate requires where and create", () => {
      expectTypeOf<{
        connectOrCreate?: {};
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: { where: { id: string } };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: {
          create: { id: string; name: string; email: string };
        };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: {
          where: { id: string };
          create: { id: string; name: string; email: string };
        };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts planned update and upsert properties", () => {
      expectTypeOf<UpdateInput>().toHaveProperty("update");
      expectTypeOf<UpdateInput>().toHaveProperty("upsert");
      expectTypeOf<{
        update?: { name?: string };
      }>().toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        upsert?: {
          create: { id: string; name: string; email: string };
          update: { name?: string };
        };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: rejects to-many-only planned properties", () => {
      expectTypeOf<{
        updateMany?: { data: { name?: string } };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        deleteMany?: { name?: string };
      }>().not.toMatchTypeOf<UpdateInput>();
    });

    test("type: does not accept disconnect for required relation", () => {
      // Required relations should not have disconnect
      type DisconnectInput = { disconnect: boolean };
      expectTypeOf<DisconnectInput>().not.toMatchTypeOf<UpdateInput>();
    });

    test("type: does not accept delete for required relation", () => {
      // Required relations should not have delete
      type DeleteInput = { delete: boolean };
      expectTypeOf<DeleteInput>().not.toMatchTypeOf<UpdateInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts create for new related record", () => {
      const input = {
        create: {
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(relationOutput(result.value).create).toEqual({
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
        });
      }
    });

    test("runtime: accepts connect to link existing record", () => {
      const input = { connect: { id: "author-1" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(relationOutput(result.value).connect).toEqual({
          id: "author-1",
        });
      }
    });

    test("runtime: accepts connectOrCreate with where and create", () => {
      const result = parse(schema, {
        connectOrCreate: {
          where: { id: "author-1" },
          create: { id: "author-1", name: "Alice", email: "a@b.com" },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test.each([
      ["empty", {}],
      ["missing create", { where: { id: "author-1" } }],
      [
        "missing where",
        {
          create: { id: "author-1", name: "Alice", email: "a@b.com" },
        },
      ],
    ] as const)("runtime: rejects connectOrCreate envelope %s", (_, envelope) => {
      const result = parse(schema, {
        connectOrCreate: envelope,
      });
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts planned update", () => {
      const result = parse(schema, {
        update: { name: "Updated" },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts planned upsert", () => {
      const result = parse(schema, {
        upsert: {
          create: { id: "author-1", name: "Alice", email: "a@b.com" },
          update: { name: "Updated" },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test.each([
      ["updateMany", { updateMany: { data: { name: "Updated" } } }],
      ["deleteMany", { deleteMany: { name: "Alice" } }],
    ] as const)("runtime: rejects to-many-only '%s'", (_, input) => {
      const result = parse(schema, input);
      const operation = Object.keys(input)[0];
      expect(result.issues?.[0]?.message).toBe(`Unknown key: ${operation}`);
    });

    test("runtime: rejects malformed upsert", () => {
      const result = parse(schema, {
        upsert: {
          create: { id: "author-1", name: "Alice", email: "a@b.com" },
        },
      });
      expect(result.issues).toBeDefined();
    });

    test("runtime: ignores disconnect for required relation (partial schema)", () => {
      // Note: The schema uses partial() so unknown keys are ignored at runtime.
      // Type safety prevents this at compile time, but runtime validation is lenient.
      const result = parse(schema, {
        disconnect: true,
      });
      // The key is ignored (not rejected) due to partial schema
      expect(result.issues).toBeDefined();
    });

    test("runtime: ignores delete for required relation (partial schema)", () => {
      // Note: The schema uses partial() so unknown keys are ignored at runtime.
      // Type safety prevents this at compile time, but runtime validation is lenient.
      const result = parse(schema, {
        delete: true,
      });
      // The key is ignored (not rejected) due to partial schema
      expect(result.issues).toBeDefined();
    });
  });
});

// =============================================================================
// TO-ONE UPDATE (Optional Relation)
// =============================================================================

describe("ToOne Update - Optional (Profile.user)", () => {
  const schema = optionalOneToOneSchemas.update;
  type UpdateInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts disconnect for optional relation", () => {
      expectTypeOf<{ disconnect?: boolean }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts delete for optional relation", () => {
      expectTypeOf<{ delete?: boolean }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: connectOrCreate requires where and create", () => {
      expectTypeOf<{
        connectOrCreate?: {};
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: { where: { id: string } };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: {
          create: { id: string; username: string };
        };
      }>().not.toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts planned update and upsert properties", () => {
      expectTypeOf<UpdateInput>().toHaveProperty("update");
      expectTypeOf<UpdateInput>().toHaveProperty("upsert");
      expectTypeOf<{
        update?: { username?: string };
      }>().toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        upsert?: {
          create: { id: string; username: string };
          update: { username?: string };
        };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: rejects to-many-only planned properties", () => {
      expectTypeOf<{
        updateMany?: { data: { username?: string } };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        deleteMany?: { username?: string };
      }>().not.toMatchTypeOf<UpdateInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts disconnect boolean for optional relation", () => {
      const input = { disconnect: true };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(relationOutput(result.value).disconnect).toBe(true);
      }
    });

    test("runtime: accepts delete boolean for optional relation", () => {
      const input = { delete: true };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(relationOutput(result.value).delete).toBe(true);
      }
    });

    test("runtime: accepts create for optional relation", () => {
      const input = {
        create: {
          id: "user-1",
          username: "alice",
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Verify expected properties are preserved
        expect(relationOutput(result.value).create?.id).toBe("user-1");
        expect(relationOutput(result.value).create?.username).toBe("alice");
      }
    });

    test.each([
      ["empty", {}],
      ["missing create", { where: { id: "user-1" } }],
      [
        "missing where",
        {
          create: { id: "user-1", username: "alice" },
        },
      ],
    ] as const)("runtime: rejects connectOrCreate envelope %s", (_, envelope) => {
      const result = parse(schema, {
        connectOrCreate: envelope,
      });
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts planned update", () => {
      const result = parse(schema, {
        update: { username: "updated" },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts planned upsert", () => {
      const result = parse(schema, {
        upsert: {
          create: { id: "user-1", username: "alice" },
          update: { username: "updated" },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test.each([
      ["updateMany", { updateMany: { data: { username: "updated" } } }],
      ["deleteMany", { deleteMany: { username: "alice" } }],
    ] as const)("runtime: rejects to-many-only '%s'", (_, input) => {
      const result = parse(schema, input);
      const operation = Object.keys(input)[0];
      expect(result.issues?.[0]?.message).toBe(`Unknown key: ${operation}`);
    });
  });
});

// =============================================================================
// TO-MANY UPDATE (Required Relation)
// =============================================================================

describe("ToMany Update - Required (Author.posts)", () => {
  const schema = requiredOneToManySchemas.update;
  type UpdateInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts create as single or array", () => {
      expectTypeOf<{
        create?: {
          id: string;
          title: string;
          content: string;
          authorId: string;
        };
      }>().toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        create?: Array<{
          id: string;
          title: string;
          content: string;
          authorId: string;
        }>;
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts set property", () => {
      expectTypeOf<{
        set?: Array<{ id: string }>;
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts createMany property", () => {
      expectTypeOf<{
        createMany?: {
          data: Array<{
            id: string;
            title: string;
            content: string;
            authorId: string;
          }>;
          skipDuplicates?: boolean;
        };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: requires data for createMany", () => {
      expectTypeOf<{
        createMany?: {};
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        createMany?: {
          data: Array<{
            id: string;
            title: string;
            content: string;
            authorId: string;
          }>;
        };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: connectOrCreate requires where and create", () => {
      expectTypeOf<{
        connectOrCreate?: {};
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: { where: { id: string } };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: {
          create: {
            id: string;
            title: string;
            content: string;
            authorId: string;
          };
        };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: {
          where: { id: string };
          create: {
            id: string;
            title: string;
            content: string;
            authorId: string;
          };
        };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: connectOrCreate array items require where and create", () => {
      expectTypeOf<{
        connectOrCreate?: Array<{ where: { id: string } }>;
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: Array<{
          create: {
            id: string;
            title: string;
            content: string;
            authorId: string;
          };
        }>;
      }>().not.toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts planned nested write operations", () => {
      expectTypeOf<UpdateInput>().toHaveProperty("update");
      expectTypeOf<UpdateInput>().toHaveProperty("updateMany");
      expectTypeOf<UpdateInput>().toHaveProperty("deleteMany");
      expectTypeOf<UpdateInput>().toHaveProperty("upsert");
      expectTypeOf<{
        update?: { where: { id: string }; data: { title?: string } };
      }>().toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        updateMany?: {
          where: { published?: boolean };
          data: { published?: boolean };
        };
      }>().toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        deleteMany?: { published?: boolean };
      }>().toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        upsert?: {
          where: { id: string };
          create: {
            id: string;
            title: string;
            content: string;
            authorId: string;
          };
          update: { title?: string };
        };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: rejects malformed planned nested write operations", () => {
      expectTypeOf<{
        update?: { data: { title?: string } };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        updateMany?: { where: { published?: boolean } };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        upsert?: {
          where: { id: string };
          create: {
            id: string;
            title: string;
            content: string;
            authorId: string;
          };
        };
      }>().not.toMatchTypeOf<UpdateInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts single create", () => {
      const input = {
        create: {
          id: "post-1",
          title: "Hello",
          content: "World",
          authorId: "a1",
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Single create is normalized to array
        expect(Array.isArray(relationOutput(result.value).create)).toBe(true);
        expect(relationOutput(result.value).create?.[0].title).toBe("Hello");
      }
    });

    test("runtime: accepts array create", () => {
      const input = {
        create: [
          { id: "post-1", title: "P1", content: "C1", authorId: "a1" },
          { id: "post-2", title: "P2", content: "C2", authorId: "a1" },
        ],
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(relationOutput(result.value).create).toHaveLength(2);
        expect(relationOutput(result.value).create?.[0].title).toBe("P1");
        expect(relationOutput(result.value).create?.[1].title).toBe("P2");
      }
    });

    test("runtime: accepts createMany", () => {
      const input = {
        createMany: {
          data: [
            { id: "post-1", title: "P1", content: "C1", authorId: "a1" },
            { id: "post-2", title: "P2", content: "C2", authorId: "a1" },
          ],
          skipDuplicates: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(relationOutput(result.value).createMany?.data).toHaveLength(2);
        expect(relationOutput(result.value).createMany?.skipDuplicates).toBe(
          true
        );
      }
    });

    test("runtime: rejects createMany without data", () => {
      const result = parse(schema, {
        createMany: {},
      });
      expect(result.issues?.[0]?.message).toBe("Missing required field: data");
      expect(result.issues?.[0]?.path).toEqual(["createMany", "data"]);
    });

    test("runtime: accepts connectOrCreate with where and create", () => {
      const result = parse(schema, {
        connectOrCreate: {
          where: { id: "post-1" },
          create: {
            id: "post-1",
            title: "Hello",
            content: "World",
            authorId: "a1",
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test.each([
      ["empty", {}],
      ["missing create", { where: { id: "post-1" } }],
      [
        "missing where",
        {
          create: {
            id: "post-1",
            title: "Hello",
            content: "World",
            authorId: "a1",
          },
        },
      ],
    ] as const)("runtime: rejects connectOrCreate envelope %s", (_, envelope) => {
      const result = parse(schema, {
        connectOrCreate: envelope,
      });
      expect(result.issues).toBeDefined();
    });

    test.each([
      ["missing create", { where: { id: "post-1" } }],
      [
        "missing where",
        {
          create: {
            id: "post-1",
            title: "Hello",
            content: "World",
            authorId: "a1",
          },
        },
      ],
    ] as const)("runtime: rejects connectOrCreate array item %s", (_, invalidItem) => {
      const result = parse(schema, {
        connectOrCreate: [
          {
            where: { id: "post-valid" },
            create: {
              id: "post-valid",
              title: "Valid",
              content: "World",
              authorId: "a1",
            },
          },
          invalidItem,
        ],
      });
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts single connect", () => {
      const input = { connect: { id: "post-1" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).connect)).toBe(true);
        expect(relationOutput(result.value).connect?.[0]).toEqual({
          id: "post-1",
        });
      }
    });

    test("runtime: accepts array connect", () => {
      const input = { connect: [{ id: "post-1" }, { id: "post-2" }] };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Verify connect array is present
        expect(Array.isArray(relationOutput(result.value).connect)).toBe(true);
        expect(
          relationOutput(result.value).connect?.length
        ).toBeGreaterThanOrEqual(1);
      }
    });

    test("runtime: accepts single disconnect", () => {
      const input = { disconnect: { id: "post-1" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).disconnect)).toBe(
          true
        );
        expect(relationOutput(result.value).disconnect?.[0]).toEqual({
          id: "post-1",
        });
      }
    });

    test("runtime: accepts array disconnect", () => {
      const input = { disconnect: [{ id: "post-1" }, { id: "post-2" }] };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).disconnect)).toBe(
          true
        );
        expect(
          relationOutput(result.value).disconnect?.length
        ).toBeGreaterThanOrEqual(1);
      }
    });

    test("runtime: accepts single set", () => {
      const input = { set: { id: "post-1" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).set)).toBe(true);
        expect(relationOutput(result.value).set?.[0]).toEqual({ id: "post-1" });
      }
    });

    test("runtime: accepts array set", () => {
      const input = { set: [{ id: "post-1" }, { id: "post-2" }] };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).set)).toBe(true);
        expect(relationOutput(result.value).set?.length).toBeGreaterThanOrEqual(
          1
        );
      }
    });

    test("runtime: accepts empty array set (unlink all)", () => {
      const input = { set: [] };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).set)).toBe(true);
      }
    });

    test("runtime: accepts single delete", () => {
      const input = { delete: { id: "post-1" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).delete)).toBe(true);
        expect(relationOutput(result.value).delete?.[0]).toEqual({
          id: "post-1",
        });
      }
    });

    test("runtime: accepts array delete", () => {
      const input = { delete: [{ id: "post-1" }, { id: "post-2" }] };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).delete)).toBe(true);
        expect(
          relationOutput(result.value).delete?.length
        ).toBeGreaterThanOrEqual(1);
      }
    });

    test("runtime: accepts planned single update", () => {
      const result = parse(schema, {
        update: {
          where: { id: "post-1" },
          data: { title: "Updated" },
        },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).update)).toBe(true);
      }
    });

    test("runtime: accepts planned update array", () => {
      const result = parse(schema, {
        update: [
          { where: { id: "post-1" }, data: { title: "Updated 1" } },
          { where: { id: "post-2" }, data: { title: "Updated 2" } },
        ],
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts planned updateMany", () => {
      const result = parse(schema, {
        updateMany: {
          where: { published: false },
          data: { published: true },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts planned upsert", () => {
      const result = parse(schema, {
        upsert: {
          where: { id: "post-1" },
          create: {
            id: "post-1",
            title: "Created",
            content: "C",
            authorId: "a1",
          },
          update: { title: "Updated" },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts planned deleteMany", () => {
      const result = parse(schema, {
        deleteMany: { published: false },
      });
      expect(result.issues).toBeUndefined();
    });

    test.each([
      ["update missing where", { update: { data: { title: "Updated" } } }],
      ["update missing data", { update: { where: { id: "post-1" } } }],
      [
        "updateMany missing data",
        { updateMany: { where: { published: false } } },
      ],
      [
        "upsert missing where",
        {
          upsert: {
            create: {
              id: "post-1",
              title: "Created",
              content: "C",
              authorId: "a1",
            },
            update: { title: "Updated" },
          },
        },
      ],
    ] as const)("runtime: rejects malformed planned %s", (_, input) => {
      const result = parse(schema, input);
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts combined operations", () => {
      const input = {
        create: { id: "new-post", title: "New", content: "C", authorId: "a1" },
        connect: { id: "existing-post" },
        disconnect: { id: "old-post" },
        delete: { id: "deleted-post" },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(relationOutput(result.value).create?.[0].title).toBe("New");
        expect(relationOutput(result.value).connect?.[0]).toEqual({
          id: "existing-post",
        });
        expect(relationOutput(result.value).disconnect?.[0]).toEqual({
          id: "old-post",
        });
        expect(relationOutput(result.value).delete?.[0]).toEqual({
          id: "deleted-post",
        });
      }
    });
  });

  describe("output normalization", () => {
    test("output: normalizes single create to array", () => {
      const result = parse(schema, {
        create: { id: "post-1", title: "T", content: "C", authorId: "a1" },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).create)).toBe(true);
        expect(relationOutput(result.value).create).toHaveLength(1);
      }
    });

    test("output: normalizes single set to array", () => {
      const result = parse(schema, {
        set: { id: "post-1" },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(relationOutput(result.value).set)).toBe(true);
        expect(relationOutput(result.value).set).toHaveLength(1);
      }
    });
  });
});

// =============================================================================
// SELF-REFERENTIAL UPDATE
// =============================================================================

describe("ToOne Update - Self-Referential (User.manager)", () => {
  const schema = optionalManyToOneSchemas.update;

  describe("runtime", () => {
    test("runtime: accepts disconnect for optional self-ref", () => {
      const input = { disconnect: true };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(relationOutput(result.value).disconnect).toBe(true);
      }
    });

    test("runtime: accepts planned update with self-referential data", () => {
      const result = parse(schema, {
        update: { username: "new-manager-name" },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts connect to different manager", () => {
      const input = { connect: { id: "manager-2" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(relationOutput(result.value).connect).toEqual({
          id: "manager-2",
        });
      }
    });
  });
});
