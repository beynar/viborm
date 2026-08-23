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

import { s } from "@schema";
import {
  childHeldToOneSchemas,
  optionalManyToOneSchemas,
  optionalOneToOneSchemas,
  requiredManyToOneSchemas,
  requiredOneToManySchemas,
} from "@tests/unit/operation-schemas/relations/fixtures";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

test("to-one updates validate both envelope fields and bare failures", () => {
  expect(
    parse(requiredManyToOneSchemas.update, {
      update: {
        where: { name: "Alice" },
        data: { name: "Updated" },
      },
    }).issues
  ).toBeUndefined();
  expect(
    parse(requiredManyToOneSchemas.update, { update: { name: 1 } }).issues
  ).toBeDefined();
});

test("a to-one create accepts at most one operation while its update composes a supplier with a modify", () => {
  expect(parse(requiredManyToOneSchemas.create, {}).issues).toBeUndefined();
  expect(parse(requiredManyToOneSchemas.update, {}).issues).toBeUndefined();

  // The create root owns no `update` key at all, so no composition is spellable there
  // and two suppliers stay two identities for one slot.
  expect(
    parse(requiredManyToOneSchemas.create, {
      connect: { id: "author-1" },
      create: {
        id: "author-2",
        name: "Second",
        email: "second@example.com",
      },
    }).issues?.[0]?.message
  ).toBe("Unsupported to-one operation combination: create, connect");

  // LATTICE CHANGE (Package H): supply-then-modify. `User.profile` stores no
  // foreign key of its own — `Profile` does — so the update surface treats it as
  // CHILD-HELD, the direction that composes every supplier with a modify.
  expect(
    parse(childHeldToOneSchemas.update, {
      connect: { id: "profile-1" },
      update: { bio: "Changed" },
    }).issues
  ).toBeUndefined();
  expect(
    parse(childHeldToOneSchemas.update, {
      create: { id: "profile-2", bio: "Second" },
      update: { bio: "Changed" },
    }).issues
  ).toBeUndefined();

  // The PARENT-HELD direction (`Profile.user` names `.fields("userId")`) composes only
  // `connect` with a modify: `create` and `connectOrCreate` beside an `update` would
  // modify a row the record's own root statement is still producing. `Post.author`
  // is the same direction now that it completes its own foreign key.
  expect(
    parse(requiredManyToOneSchemas.update, {
      create: { id: "author-2", name: "Second", email: "second@example.com" },
      update: { name: "Changed" },
    }).issues?.[0]?.message
  ).toBe("Unsupported to-one operation combination: create, update");
  expect(
    parse(optionalOneToOneSchemas.update, {
      connect: { id: "user-1" },
      update: { username: "changed" },
    }).issues
  ).toBeUndefined();
  expect(
    parse(optionalOneToOneSchemas.update, {
      create: { id: "user-2", username: "second" },
      update: { username: "changed" },
    }).issues?.[0]?.message
  ).toBe("Unsupported to-one operation combination: create, update");
});

test("to-one updates refuse an ambiguous data-field spelling", () => {
  const target = s.model({
    id: s.string().id(),
    data: s.json(),
    sources: s.toMany(() => source),
  });
  const source = s.model({
    id: s.string().id(),
    targetId: s.string(),
    target: s
      .toOne(() => target)
      .fields("targetId")
      .references("id"),
  });
  const schema = createSchemaRegistry({ source, target }).proxy.source.relations
    .target.update;

  expect(
    parse(schema, { update: { data: { label: "ambiguous" } } }).issues?.[0]
      ?.message
  ).toContain("Ambiguous to-one nested `update`");
});

test("inverse to-one delete follows slot absence while disconnect follows FK nullability", () => {
  const requiredParent = s.model({
    id: s.string().id(),
    child: s.toOne(() => requiredChild),
  });
  const requiredChild = s.model({
    id: s.string().id(),
    parentId: s.string().unique(),
    parent: s
      .toOne(() => requiredParent)
      .fields("parentId")
      .references("id"),
  });
  const optionalParent = s.model({
    id: s.string().id(),
    child: s.toOne(() => optionalChild),
  });
  const optionalChild = s.model({
    id: s.string().id(),
    parentId: s.string().nullable().unique(),
    parent: s
      .toOne(() => optionalParent)
      .fields("parentId")
      .references("id"),
  });
  const registry = createSchemaRegistry({
    requiredParent,
    requiredChild,
    optionalParent,
    optionalChild,
  });
  const requiredMembership =
    registry.proxy.requiredParent.relations.child.update;
  const optionalMembership =
    registry.proxy.optionalParent.relations.child.update;
  type RequiredMembershipInput = InferInput<typeof requiredMembership>;
  type OptionalMembershipInput = InferInput<typeof optionalMembership>;

  expectTypeOf<{ delete: true }>().toMatchTypeOf<RequiredMembershipInput>();
  expectTypeOf<{
    disconnect: true;
  }>().not.toMatchTypeOf<RequiredMembershipInput>();
  expectTypeOf<{ disconnect: true }>().toMatchTypeOf<OptionalMembershipInput>();
  expectTypeOf<{
    delete: true;
    create: { id: string };
  }>().toMatchTypeOf<RequiredMembershipInput>();
  expectTypeOf<{
    disconnect: true;
    connect: { id: string };
  }>().toMatchTypeOf<OptionalMembershipInput>();
  expect(parse(requiredMembership, { delete: true }).issues).toBeUndefined();
  expect(parse(requiredMembership, { disconnect: true }).issues).toBeDefined();
  expect(
    parse(requiredMembership, {
      delete: true,
      create: { id: "child-2" },
    }).issues
  ).toBeUndefined();
  expect(
    parse(optionalMembership, { disconnect: true }).issues
  ).toBeUndefined();
  expect(
    parse(optionalMembership, {
      disconnect: true,
      connect: { id: "child-1" },
    }).issues
  ).toBeUndefined();
  expect(
    parse(optionalMembership, {
      disconnect: true,
      connectOrCreate: {
        where: { id: "child-1" },
        create: { id: "child-2" },
      },
    }).issues
  ).toBeUndefined();
  expect(
    parse(optionalMembership, {
      disconnect: true,
      create: { id: "child-2" },
    }).issues
  ).toBeUndefined();
  expect(
    parse(optionalMembership, {
      disconnect: true,
      connect: { id: "child-1" },
      create: { id: "child-2" },
    }).issues?.[0]?.message
  ).toContain("Unsupported to-one operation combination");
  expect(
    parse(optionalMembership, {
      delete: true,
      connectOrCreate: {
        where: { id: "child-1" },
        create: { id: "child-2" },
      },
    }).issues?.[0]?.message
  ).toBe("Unsupported to-one operation combination: connectOrCreate, delete");
});

test("to-many disconnect follows membership clearability while set stays available", () => {
  const requiredParent = s.model({
    id: s.string().id(),
    children: s.toMany(() => requiredChild),
  });
  const requiredChild = s.model({
    id: s.string().id(),
    parentId: s.string(),
    parent: s
      .toOne(() => requiredParent)
      .fields("parentId")
      .references("id"),
  });
  const optionalParent = s.model({
    id: s.string().id(),
    children: s.toMany(() => optionalChild),
  });
  const optionalChild = s.model({
    id: s.string().id(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => optionalParent)
      .fields("parentId")
      .references("id"),
  });
  const registry = createSchemaRegistry({
    requiredParent,
    requiredChild,
    optionalParent,
    optionalChild,
  });
  const requiredMembership =
    registry.proxy.requiredParent.relations.children.update;
  const optionalMembership =
    registry.proxy.optionalParent.relations.children.update;
  type RequiredInput = InferInput<typeof requiredMembership>;
  type OptionalInput = InferInput<typeof optionalMembership>;

  expectTypeOf<RequiredInput["disconnect"]>().toEqualTypeOf<undefined>();
  expectTypeOf<
    "set" extends keyof RequiredInput ? true : false
  >().toEqualTypeOf<true>();
  expectTypeOf<
    "disconnect" extends keyof OptionalInput ? true : false
  >().toEqualTypeOf<true>();
  expect(parse(requiredMembership, { set: [] }).issues).toBeUndefined();
  expect(
    parse(requiredMembership, { disconnect: { id: "child-1" } }).issues
  ).toBeDefined();
  expect(
    parse(optionalMembership, { disconnect: { id: "child-1" } }).issues
  ).toBeUndefined();
});

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
      expectTypeOf<
        {
          create: { id: string; name: string; email: string };
        } extends UpdateInput
          ? true
          : false
      >().toEqualTypeOf<true>();
    });

    test("type: accepts connect property", () => {
      expectTypeOf<
        { connect: { id: string } } extends UpdateInput ? true : false
      >().toEqualTypeOf<true>();
    });

    test("type: connectOrCreate requires where and create", () => {
      expectTypeOf<{
        connectOrCreate?: Record<PropertyKey, never>;
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: { where: { id: string } };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        connectOrCreate?: {
          create: { id: string; name: string; email: string };
        };
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<
        {
          connectOrCreate: {
            where: { id: string };
            create: { id: string; name: string; email: string };
          };
        } extends UpdateInput
          ? true
          : false
      >().toEqualTypeOf<true>();
    });

    test("type: accepts planned update and upsert properties", () => {
      expectTypeOf<UpdateInput>().toHaveProperty("update");
      expectTypeOf<UpdateInput>().toHaveProperty("upsert");
      expectTypeOf<
        { update: { name?: string } } extends UpdateInput ? true : false
      >().toEqualTypeOf<true>();
      expectTypeOf<
        {
          upsert: {
            create: { id: string; name: string; email: string };
            update: { name?: string };
          };
        } extends UpdateInput
          ? true
          : false
      >().toEqualTypeOf<true>();
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
    test("type: false no-ops do not consume the active operation", () => {
      expectTypeOf<
        {
          disconnect: false;
          connect: { id: string };
        } extends UpdateInput
          ? true
          : false
      >().toEqualTypeOf<true>();
      // LATTICE CHANGE (Package H): `Profile.user` is PARENT-HELD, and a vacate
      // followed by a supplier now folds to one final foreign-key value on the
      // record's own root statement, so this pair is accepted in both directions.
      // The `disconnect: false` line above still says what it always said: an
      // inactive verb is not an active operation. The pair that stays refused in
      // BOTH directions is two suppliers, pinned below.
      expectTypeOf<
        {
          disconnect: true;
          connect: { id: string };
        } extends UpdateInput
          ? true
          : false
      >().toEqualTypeOf<true>();
      expectTypeOf<
        {
          connect: { id: string };
          create: { id: string; username: string };
        } extends UpdateInput
          ? true
          : false
      >().toEqualTypeOf<false>();
    });

    test("type: accepts disconnect for optional relation", () => {
      expectTypeOf<
        { disconnect: true } extends UpdateInput ? true : false
      >().toEqualTypeOf<true>();
    });

    test("type: accepts delete for optional relation", () => {
      expectTypeOf<
        { delete: true } extends UpdateInput ? true : false
      >().toEqualTypeOf<true>();
    });

    test("type: connectOrCreate requires where and create", () => {
      expectTypeOf<{
        connectOrCreate?: Record<PropertyKey, never>;
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
      expectTypeOf<
        { update: { username?: string } } extends UpdateInput ? true : false
      >().toEqualTypeOf<true>();
      expectTypeOf<
        {
          upsert: {
            create: { id: string; username: string };
            update: { username?: string };
          };
        } extends UpdateInput
          ? true
          : false
      >().toEqualTypeOf<true>();
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
    test("runtime: false no-ops compose with one active operation", () => {
      expect(
        parse(schema, {
          disconnect: false,
          connect: { id: "user-1" },
        }).issues
      ).toBeUndefined();
      // LATTICE CHANGE (Package H): `Profile.user` is PARENT-HELD, and an ACTIVE
      // vacate followed by a supplier now folds to one final foreign-key value. The
      // inactive spelling above is still a different fact — it activates nothing —
      // and two suppliers still name two identities for one slot.
      expect(
        parse(schema, {
          disconnect: true,
          connect: { id: "user-1" },
        }).issues
      ).toBeUndefined();
      expect(
        parse(schema, {
          connect: { id: "user-1" },
          create: { id: "user-2", username: "second" },
        }).issues?.[0]?.message
      ).toBe("Unsupported to-one operation combination: create, connect");
    });

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
    test("type: makes disconnect uninhabitable but retains set for required membership", () => {
      expectTypeOf<UpdateInput["disconnect"]>().toEqualTypeOf<undefined>();
      expectTypeOf<
        "set" extends keyof UpdateInput ? true : false
      >().toEqualTypeOf<true>();
    });

    test("type: accepts create as single or array", () => {
      expectTypeOf<{
        create?: {
          id: string;
          title: string;
          content: string;
        };
      }>().toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        create?: Array<{
          id: string;
          title: string;
          content: string;
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
          }>;
          skipDuplicates?: boolean;
        };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: requires data for createMany", () => {
      expectTypeOf<{
        createMany?: Record<PropertyKey, never>;
      }>().not.toMatchTypeOf<UpdateInput>();
      expectTypeOf<{
        createMany?: {
          data: Array<{
            id: string;
            title: string;
            content: string;
          }>;
        };
      }>().toMatchTypeOf<UpdateInput>();
    });

    test("type: connectOrCreate requires where and create", () => {
      expectTypeOf<{
        connectOrCreate?: Record<PropertyKey, never>;
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
          { id: "post-1", title: "P1", content: "C1" },
          { id: "post-2", title: "P2", content: "C2" },
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
            { id: "post-1", title: "P1", content: "C1" },
            { id: "post-2", title: "P2", content: "C2" },
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

    test("runtime: rejects disconnect for required membership", () => {
      const input = { disconnect: { id: "post-1" } };
      const result = parse(schema, input);
      expect(result.issues?.[0]?.message).toBe("Unknown key: disconnect");
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
        create: { id: "new-post", title: "New", content: "C" },
        connect: { id: "existing-post" },
        set: { id: "retained-post" },
        delete: { id: "deleted-post" },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(relationOutput(result.value).create?.[0].title).toBe("New");
        expect(relationOutput(result.value).connect?.[0]).toEqual({
          id: "existing-post",
        });
        expect(relationOutput(result.value).set?.[0]).toEqual({
          id: "retained-post",
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
        create: { id: "post-1", title: "T", content: "C" },
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

/**
 * N1 — nested update data is built from the omitted-FK owner, and the omission is
 * SCOPED to the edges whose TARGET row holds the foreign key.
 *
 * The scope is the whole content of the claim. `getInverseRelationMap` answers two
 * different questions under one name: for a to-one with `.fields()` it returns THIS
 * side's own fields, and for everything else it SCANS the target for a to-one
 * back-reference. Only the second answer names a column on the row a nested payload
 * writes, so only the second may be omitted — a `manyToMany` arm and a parent-held
 * to-one keep every key, because the engine has no fold there for a spelled value to
 * contradict. Both are measured below against the child-held arm that does omit, in
 * the same schema, so the difference cannot be read as an accident of fixture choice.
 */
describe("N1 the omitted-FK owner applied to nested update data", () => {
  const n1Schema = (() => {
    const owner = s.model({
      id: s.string().id(),
      label: s.string(),
      // CHILD-HELD: `item.ownerId` is this relation's own foreign key.
      items: s.toMany(() => item),
      // JUNCTION: a third table holds membership, so `tag.featuredOwnerId` — which
      // belongs to a DIFFERENT relation — is not this one's to omit. Both edges
      // reach the same pair of models, so each names itself (§6.2).
      tags: s.toMany(() => tag).name("OwnerTags"),
      featuredTags: s.toMany(() => tag).name("FeaturedTag"),
      // CHILD-HELD TO-ONE (inverse): `profile.ownerId` is this relation's own key,
      // and it reaches the to-one `update` and `upsert` arms rather than the to-many
      // ones.
      profile: s.toOne(() => profile),
    });
    const profile = s.model({
      id: s.string().id(),
      bio: s.string(),
      ownerId: s.string().unique().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    });
    const item = s.model({
      id: s.string().id(),
      title: s.string(),
      ownerId: s.string().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
      // PARENT-HELD, self-referential: `parentId` sits on the row spelling the
      // payload, never on the target, so a nested `parent: { update }` may name it.
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => item)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => item),
    });
    const tag = s.model({
      id: s.string().id(),
      name: s.string(),
      featuredOwnerId: s.string().nullable(),
      featuredOwner: s
        .toOne(() => owner)
        .fields("featuredOwnerId")
        .references("id")
        .name("FeaturedTag"),
      owners: s.toMany(() => owner).name("OwnerTags"),
    });
    return { owner, item, tag, profile };
  })();
  const schemas = createSchemaRegistry(n1Schema).proxy;

  const ownerUpdate = () => schemas.owner.core.update;
  const itemUpdate = () => schemas.item.core.update;

  test("every child-held nested update arm refuses the owned foreign key", () => {
    const arms: Record<string, unknown>[] = [
      { items: { update: { where: { id: "i1" }, data: { ownerId: "x" } } } },
      { items: { updateMany: { where: {}, data: { ownerId: "x" } } } },
      {
        items: {
          upsert: {
            where: { id: "i1" },
            create: { id: "i1", title: "t" },
            update: { ownerId: "x" },
          },
        },
      },
    ];
    for (const arm of arms) {
      const result = parse(ownerUpdate(), arm);
      expect(result.issues).toBeDefined();
      expect(JSON.stringify(result.issues)).toContain("Unknown key: ownerId");
    }
  });

  test("the to-one update and upsert arms refuse it too", () => {
    // `owner.profile` is the inverse side of a 1:1, so its arms are the BARE-data
    // `update` and the `upsert` UPDATE arm — different schema objects from the
    // to-many ones above, and each had to be given the owner separately.
    for (const arm of [
      { profile: { update: { ownerId: "x" } } },
      { profile: { update: { where: { bio: "b" }, data: { ownerId: "x" } } } },
      {
        profile: {
          upsert: {
            create: { id: "p", bio: "b" },
            update: { ownerId: "x" },
          },
        },
      },
    ]) {
      const result = parse(ownerUpdate(), arm);
      expect(result.issues).toBeDefined();
      expect(JSON.stringify(result.issues)).toContain("ownerId");
    }
    // The control: the same arms parse with the key dropped.
    expect(
      parse(ownerUpdate(), { profile: { update: { bio: "b" } } }).issues
    ).toBeUndefined();
  });

  test("a junction arm omits NOTHING — the target's unrelated FK stays spellable", () => {
    // `getInverseRelationMap` scans `tag` for a to-one back-reference to `owner` and
    // finds `featuredOwner`, which belongs to a different relation entirely. Omitting
    // it here would refuse a write the engine performs correctly.
    for (const arm of [
      {
        tags: {
          update: { where: { id: "t1" }, data: { featuredOwnerId: "o" } },
        },
      },
      { tags: { updateMany: { where: {}, data: { featuredOwnerId: "o" } } } },
      {
        tags: {
          upsert: {
            where: { id: "t1" },
            create: { id: "t1", name: "n" },
            update: { featuredOwnerId: "o" },
          },
        },
      },
    ]) {
      expect(parse(ownerUpdate(), arm).issues).toBeUndefined();
    }
  });

  test("a parent-held to-one arm omits NOTHING — the key is on the source row", () => {
    // Self-referential, so the name collision is real rather than hypothetical:
    // `item.parentId` exists on the target model too, and it is still spellable
    // because `item.parent` stores its membership on the row being updated.
    expect(
      parse(itemUpdate(), { parent: { update: { parentId: "gp" } } }).issues
    ).toBeUndefined();
    expect(
      parse(itemUpdate(), {
        parent: {
          upsert: {
            create: { id: "gp", title: "t" },
            update: { parentId: "ggp" },
          },
        },
      }).issues
    ).toBeUndefined();
  });

  test("the child-held twin of that same column IS omitted", () => {
    // `item.children` owns `item.parentId`, so the identical key refuses one arm over.
    const result = parse(itemUpdate(), {
      children: { updateMany: { where: {}, data: { parentId: "x" } } },
    });
    expect(result.issues).toBeDefined();
    expect(JSON.stringify(result.issues)).toContain("Unknown key: parentId");
  });

  test("ordinary scalars and nested relations still parse in every arm", () => {
    expect(
      parse(ownerUpdate(), {
        items: {
          update: {
            where: { id: "i1" },
            data: { title: "t", children: { create: { id: "c", title: "c" } } },
          },
          updateMany: { where: {}, data: { title: "t" } },
        },
      }).issues
    ).toBeUndefined();
  });
});
