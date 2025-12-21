/**
 * Relation Update Schema Tests
 *
 * Tests update schemas for both to-one and to-many relations:
 * - ToOne Update: { create?, connect?, update?, upsert?, disconnect?, delete? }
 *   - disconnect/delete only for optional relations
 * - ToMany Update: Same + { set?, updateMany?, deleteMany? }
 *   - All operations accept single or array, normalized to array
 *
 * Covers:
 * - Type inference with expectTypeOf
 * - Runtime validation with safeParse
 * - Optional vs required relation differences
 * - Array normalization for to-many relations
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { safeParse, type InferInput } from "valibot";
import {
  requiredManyToOneSchemas,
  requiredOneToManySchemas,
  optionalOneToOneSchemas,
  optionalManyToOneSchemas,
} from "./fixtures";

// =============================================================================
// TO-ONE UPDATE (Required Relation)
// =============================================================================

describe("ToOne Update - Required (Post.author)", () => {
  const schema = requiredManyToOneSchemas.update;
  type UpdateInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts create property", () => {
      expectTypeOf<{ create?: { id: string; name: string; email: string } }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts connect property", () => {
      expectTypeOf<{ connect?: { id: string } }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts update property", () => {
      expectTypeOf<{ update?: { name?: string } }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts upsert property", () => {
      expectTypeOf<{
        upsert?: {
          create: { id: string; name: string; email: string };
          update: { name?: string };
        };
      }>().toMatchTypeOf<UpdateInput>();
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
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.create).toEqual({
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
        });
      }
    });

    test("runtime: accepts connect to link existing record", () => {
      const input = { connect: { id: "author-1" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.connect).toEqual({ id: "author-1" });
      }
    });

    test("runtime: accepts update with data", () => {
      const input = { update: { name: "Updated Name" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Scalar update values are transformed to { set: value }
        expect(result.output.update).toEqual({ name: { set: "Updated Name" } });
      }
    });

    test("runtime: accepts upsert with create and update", () => {
      const input = {
        upsert: {
          create: { id: "author-1", name: "Alice", email: "a@b.com" },
          update: { name: "Updated Alice" },
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.upsert?.create?.id).toBe("author-1");
        expect(result.output.upsert?.create?.name).toBe("Alice");
        expect(result.output.upsert?.create?.email).toBe("a@b.com");
        // Scalar update values are transformed to { set: value }
        expect(result.output.upsert?.update).toEqual({ name: { set: "Updated Alice" } });
      }
    });

    test("runtime: ignores disconnect for required relation (partial schema)", () => {
      // Note: The schema uses partial() so unknown keys are ignored at runtime.
      // Type safety prevents this at compile time, but runtime validation is lenient.
      const result = safeParse(schema, {
        disconnect: true,
      });
      // The key is ignored (not rejected) due to partial schema
      expect(result.success).toBe(true);
      if (result.success) {
        // disconnect is not in the output for required relations
        expect(result.output.disconnect).toBeUndefined();
      }
    });

    test("runtime: ignores delete for required relation (partial schema)", () => {
      // Note: The schema uses partial() so unknown keys are ignored at runtime.
      // Type safety prevents this at compile time, but runtime validation is lenient.
      const result = safeParse(schema, {
        delete: true,
      });
      // The key is ignored (not rejected) due to partial schema
      expect(result.success).toBe(true);
      if (result.success) {
        // delete is not in the output for required relations
        expect(result.output.delete).toBeUndefined();
      }
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
  });

  describe("runtime", () => {
    test("runtime: accepts disconnect boolean for optional relation", () => {
      const input = { disconnect: true };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.disconnect).toBe(true);
      }
    });

    test("runtime: accepts delete boolean for optional relation", () => {
      const input = { delete: true };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.delete).toBe(true);
      }
    });

    test("runtime: accepts create for optional relation", () => {
      const input = {
        create: {
          id: "user-1",
          username: "alice",
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Verify expected properties are preserved
        expect(result.output.create?.id).toBe("user-1");
        expect(result.output.create?.username).toBe("alice");
      }
    });

    test("runtime: accepts upsert for optional relation", () => {
      const input = {
        upsert: {
          create: { id: "user-1", username: "alice" },
          update: { username: "alice-updated" },
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.upsert?.create?.id).toBe("user-1");
        expect(result.output.upsert?.create?.username).toBe("alice");
        // Scalar update values are transformed to { set: value }
        expect(result.output.upsert?.update).toEqual({ username: { set: "alice-updated" } });
      }
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
        create?: { id: string; title: string; content: string; authorId: string };
      }>().toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        create?: Array<{ id: string; title: string; content: string; authorId: string }>;
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts set property", () => {
      expectTypeOf<{ set?: Array<{ id: string }> }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts update with where and data", () => {
      expectTypeOf<{
        update?: { where: { id: string }; data: { title?: string } };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts updateMany with where and data", () => {
      expectTypeOf<{
        updateMany?: { where: { published?: boolean }; data: { published?: boolean } };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts deleteMany with where filter", () => {
      expectTypeOf<{
        deleteMany?: { published?: boolean };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: accepts upsert property", () => {
      expectTypeOf<{
        upsert?: {
          where: { id: string };
          create: { id: string; title: string; content: string; authorId: string };
          update: { title?: string };
        };
      }>().toMatchTypeOf<UpdateInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts single create", () => {
      const input = {
        create: { id: "post-1", title: "Hello", content: "World", authorId: "a1" },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Single create is normalized to array
        expect(Array.isArray(result.output.create)).toBe(true);
        expect(result.output.create?.[0].title).toBe("Hello");
      }
    });

    test("runtime: accepts array create", () => {
      const input = {
        create: [
          { id: "post-1", title: "P1", content: "C1", authorId: "a1" },
          { id: "post-2", title: "P2", content: "C2", authorId: "a1" },
        ],
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.create).toHaveLength(2);
        expect(result.output.create?.[0].title).toBe("P1");
        expect(result.output.create?.[1].title).toBe("P2");
      }
    });

    test("runtime: accepts single connect", () => {
      const input = { connect: { id: "post-1" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.connect)).toBe(true);
        expect(result.output.connect?.[0]).toEqual({ id: "post-1" });
      }
    });

    test("runtime: accepts array connect", () => {
      const input = { connect: [{ id: "post-1" }, { id: "post-2" }] };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Verify connect array is present
        expect(Array.isArray(result.output.connect)).toBe(true);
        expect(result.output.connect?.length).toBeGreaterThanOrEqual(1);
      }
    });

    test("runtime: accepts single disconnect", () => {
      const input = { disconnect: { id: "post-1" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.disconnect)).toBe(true);
        expect(result.output.disconnect?.[0]).toEqual({ id: "post-1" });
      }
    });

    test("runtime: accepts array disconnect", () => {
      const input = { disconnect: [{ id: "post-1" }, { id: "post-2" }] };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.disconnect)).toBe(true);
        expect(result.output.disconnect?.length).toBeGreaterThanOrEqual(1);
      }
    });

    test("runtime: accepts single set", () => {
      const input = { set: { id: "post-1" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.set)).toBe(true);
        expect(result.output.set?.[0]).toEqual({ id: "post-1" });
      }
    });

    test("runtime: accepts array set", () => {
      const input = { set: [{ id: "post-1" }, { id: "post-2" }] };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.set)).toBe(true);
        expect(result.output.set?.length).toBeGreaterThanOrEqual(1);
      }
    });

    test("runtime: accepts empty array set (unlink all)", () => {
      const input = { set: [] };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.set)).toBe(true);
      }
    });

    test("runtime: accepts single delete", () => {
      const input = { delete: { id: "post-1" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.delete)).toBe(true);
        expect(result.output.delete?.[0]).toEqual({ id: "post-1" });
      }
    });

    test("runtime: accepts array delete", () => {
      const input = { delete: [{ id: "post-1" }, { id: "post-2" }] };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.delete)).toBe(true);
        expect(result.output.delete?.length).toBeGreaterThanOrEqual(1);
      }
    });

    test("runtime: accepts single update with where and data", () => {
      const input = {
        update: {
          where: { id: "post-1" },
          data: { title: "Updated" },
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.update)).toBe(true);
        expect(result.output.update?.[0].where).toEqual({ id: "post-1" });
        // Scalar update values are transformed to { set: value }
        expect(result.output.update?.[0].data).toEqual({ title: { set: "Updated" } });
      }
    });

    test("runtime: accepts array update", () => {
      const input = {
        update: [
          { where: { id: "post-1" }, data: { title: "Updated 1" } },
          { where: { id: "post-2" }, data: { title: "Updated 2" } },
        ],
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.update)).toBe(true);
        expect(result.output.update?.length).toBeGreaterThanOrEqual(1);
        // Scalar update values are transformed to { set: value }
        expect(result.output.update?.[0].data.title).toEqual({ set: "Updated 1" });
      }
    });

    test("runtime: accepts single updateMany with filter", () => {
      const input = {
        updateMany: {
          where: { published: false },
          data: { published: true },
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.updateMany)).toBe(true);
        // Scalar filter values are transformed to { equals: value }
        expect(result.output.updateMany?.[0].where).toEqual({ published: { equals: false } });
        // Scalar update values are transformed to { set: value }
        expect(result.output.updateMany?.[0].data).toEqual({ published: { set: true } });
      }
    });

    test("runtime: accepts array updateMany", () => {
      const input = {
        updateMany: [
          { where: { published: false }, data: { published: true } },
          { where: { title: { contains: "draft" } }, data: { title: "Final" } },
        ],
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.updateMany)).toBe(true);
        expect(result.output.updateMany?.length).toBeGreaterThanOrEqual(1);
        // Scalar update values are transformed to { set: value }
        expect(result.output.updateMany?.[0].data.published).toEqual({ set: true });
      }
    });

    test("runtime: accepts single deleteMany with filter", () => {
      const input = { deleteMany: { published: false } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.deleteMany)).toBe(true);
        // Scalar filter values are transformed to { equals: value }
        expect(result.output.deleteMany?.[0]).toEqual({ published: { equals: false } });
      }
    });

    test("runtime: accepts array deleteMany", () => {
      const input = {
        deleteMany: [{ published: false }, { title: { contains: "temp" } }],
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.deleteMany)).toBe(true);
        expect(result.output.deleteMany?.length).toBeGreaterThanOrEqual(1);
      }
    });

    test("runtime: accepts empty deleteMany (delete all)", () => {
      const input = { deleteMany: {} };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.deleteMany)).toBe(true);
        expect(result.output.deleteMany?.[0]).toEqual({});
      }
    });

    test("runtime: accepts single upsert", () => {
      const input = {
        upsert: {
          where: { id: "post-1" },
          create: { id: "post-1", title: "New", content: "C", authorId: "a1" },
          update: { title: "Updated" },
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.upsert)).toBe(true);
        expect(result.output.upsert?.[0].where).toEqual({ id: "post-1" });
        expect(result.output.upsert?.[0].create.title).toBe("New");
        // Scalar update values are transformed to { set: value }
        expect(result.output.upsert?.[0].update).toEqual({ title: { set: "Updated" } });
      }
    });

    test("runtime: accepts array upsert", () => {
      const input = {
        upsert: [
          {
            where: { id: "post-1" },
            create: { id: "post-1", title: "P1", content: "C1", authorId: "a1" },
            update: { title: "U1" },
          },
          {
            where: { id: "post-2" },
            create: { id: "post-2", title: "P2", content: "C2", authorId: "a1" },
            update: { title: "U2" },
          },
        ],
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.upsert).toHaveLength(2);
        expect(result.output.upsert?.[0].create.title).toBe("P1");
        expect(result.output.upsert?.[1].create.title).toBe("P2");
      }
    });

    test("runtime: accepts combined operations", () => {
      const input = {
        create: { id: "new-post", title: "New", content: "C", authorId: "a1" },
        connect: { id: "existing-post" },
        disconnect: { id: "old-post" },
        updateMany: { where: {}, data: { published: true } },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.create?.[0].title).toBe("New");
        expect(result.output.connect?.[0]).toEqual({ id: "existing-post" });
        expect(result.output.disconnect?.[0]).toEqual({ id: "old-post" });
        // Scalar update values are transformed to { set: value }
        expect(result.output.updateMany?.[0].data.published).toEqual({ set: true });
      }
    });
  });

  describe("output normalization", () => {
    test("output: normalizes single create to array", () => {
      const result = safeParse(schema, {
        create: { id: "post-1", title: "T", content: "C", authorId: "a1" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.create)).toBe(true);
        expect(result.output.create).toHaveLength(1);
      }
    });

    test("output: normalizes single update to array", () => {
      const result = safeParse(schema, {
        update: { where: { id: "post-1" }, data: { title: "Updated" } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.update)).toBe(true);
        expect(result.output.update).toHaveLength(1);
      }
    });

    test("output: normalizes single updateMany to array", () => {
      const result = safeParse(schema, {
        updateMany: { where: {}, data: { published: true } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.updateMany)).toBe(true);
        expect(result.output.updateMany).toHaveLength(1);
      }
    });

    test("output: normalizes single deleteMany to array", () => {
      const result = safeParse(schema, {
        deleteMany: { published: false },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.deleteMany)).toBe(true);
        expect(result.output.deleteMany).toHaveLength(1);
      }
    });

    test("output: normalizes single upsert to array", () => {
      const result = safeParse(schema, {
        upsert: {
          where: { id: "post-1" },
          create: { id: "post-1", title: "T", content: "C", authorId: "a1" },
          update: { title: "Updated" },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.upsert)).toBe(true);
        expect(result.output.upsert).toHaveLength(1);
      }
    });

    test("output: normalizes single set to array", () => {
      const result = safeParse(schema, {
        set: { id: "post-1" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.set)).toBe(true);
        expect(result.output.set).toHaveLength(1);
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
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.disconnect).toBe(true);
      }
    });

    test("runtime: accepts update with self-referential data", () => {
      const input = { update: { username: "new-manager-name" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Scalar update values are transformed to { set: value }
        expect(result.output.update).toEqual({ username: { set: "new-manager-name" } });
      }
    });

    test("runtime: accepts connect to different manager", () => {
      const input = { connect: { id: "manager-2" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.connect).toEqual({ id: "manager-2" });
      }
    });
  });
});

