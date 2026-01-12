/**
 * Relation Types Integration Test
 *
 * This test verifies that types flow correctly through relations.
 * It tests various field types via parent-child relationships.
 */

import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";
import { z } from "zod/v4";

// =============================================================================
// MODEL DEFINITIONS - All scalar field types
// =============================================================================

// Parent model with all field types
const parentModel = s.model({
  id: s.string().id(),

  // String fields
  stringRequired: s.string(),
  stringNullable: s.string().nullable(),
  stringArray: s.string().array(),

  // Number fields
  intRequired: s.int(),
  intNullable: s.int().nullable(),
  floatRequired: s.float(),
  decimalRequired: s.decimal(),

  // Boolean fields
  booleanRequired: s.boolean(),
  booleanNullable: s.boolean().nullable(),

  // BigInt fields
  bigintRequired: s.bigInt(),
  bigintNullable: s.bigInt().nullable(),

  // DateTime fields
  datetimeRequired: s.dateTime(),
  datetimeNullable: s.dateTime().nullable(),

  // Date and Time fields
  dateRequired: s.date(),
  dateNullable: s.date().nullable(),
  timeRequired: s.time(),
  timeNullable: s.time().nullable(),

  // JSON fields
  jsonRequired: s.json().schema(
    z.object({
      name: z.string(),
      value: z.number(),
    })
  ),
  jsonNullable: s.json().nullable(),

  // Enum field
  status: s.enum(["ACTIVE", "INACTIVE", "PENDING"] as const),

  // Blob field
  blobNullable: s.blob().nullable(),

  // Relation
  children: s.oneToMany(() => childModel),
});

// Child model references parent
const childModel = s.model({
  id: s.string().id(),
  name: s.string(),
  value: s.int(),
  isActive: s.boolean(),
  createdAt: s.dateTime(),

  // Foreign key
  parentId: s.string(),
  parent: s
    .manyToOne(() => parentModel)
    .fields("parentId")
    .references("id"),
});

const schema = { parentModel, childModel };

// =============================================================================
// TEST SETUP
// =============================================================================

let client: Awaited<ReturnType<typeof PGliteCreateClient<typeof schema>>>;

// Test data
const testDate = new Date("2024-06-15T14:30:00.000Z");
const testDateOnly = new Date("2024-06-15");
const testTime = "14:30:00";

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite();
  client = await PGliteCreateClient({ schema, client: pglite });
  await push(client.$driver, schema, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

// =============================================================================
// RELATION TYPE TESTS
// =============================================================================

describe("Relation Types Integration Test", () => {
  test("oneToMany relation returns correctly typed children", async () => {
    // Create parent with all field types
    const parent = await client.parentModel.create({
      data: {
        id: "parent-1",
        stringRequired: "hello",
        stringNullable: "world",
        stringArray: ["a", "b", "c"],
        intRequired: 42,
        intNullable: null,
        floatRequired: 3.14,
        decimalRequired: 99.99,
        booleanRequired: true,
        booleanNullable: false,
        bigintRequired: 9007199254740991n,
        bigintNullable: null,
        datetimeRequired: testDate,
        datetimeNullable: null,
        dateRequired: testDateOnly,
        dateNullable: null,
        timeRequired: testTime,
        timeNullable: null,
        jsonRequired: { name: "test", value: 123 },
        jsonNullable: null,
        status: "ACTIVE",
        blobNullable: null,
      },
    });

    // Create children
    await client.childModel.create({
      data: {
        id: "child-1",
        name: "First Child",
        value: 100,
        isActive: true,
        createdAt: testDate,
        parentId: parent.id,
      },
    });

    await client.childModel.create({
      data: {
        id: "child-2",
        name: "Second Child",
        value: 200,
        isActive: false,
        createdAt: testDate,
        parentId: parent.id,
      },
    });

    // Query parent with children included
    const parentWithChildren = await client.parentModel.findUnique({
      where: { id: "parent-1" },
      include: { children: true },
    });

    expect(parentWithChildren).not.toBeNull();
    if (!parentWithChildren) throw new Error("Parent not found");

    // Verify children are included
    expect(parentWithChildren.children).toBeDefined();
    expect(Array.isArray(parentWithChildren.children)).toBe(true);
    expect(parentWithChildren.children.length).toBe(2);

    // Verify child field types at runtime
    const child = parentWithChildren.children[0]!;
    expect(typeof child.id).toBe("string");
    expect(typeof child.name).toBe("string");
    expect(typeof child.value).toBe("number");
    expect(typeof child.isActive).toBe("boolean");
    expect(typeof child.parentId).toBe("string");

    // DateTime correctly converted to Date through relations (FIXED)
    expect(child.createdAt instanceof Date).toBe(true);
    expect(child.createdAt).toBeDefined();

    // Compile-time type verification for children
    expectTypeOf(parentWithChildren.children).toEqualTypeOf<
      Array<{
        id: string;
        name: string;
        value: number;
        isActive: boolean;
        createdAt: Date;
        parentId: string;
      }>
    >();

    // Verify parent fields still have correct types
    expect(parentWithChildren.stringRequired).toBe("hello");
    expect(parentWithChildren.intRequired).toBe(42);
    expect(parentWithChildren.booleanRequired).toBe(true);
    expect(parentWithChildren.status).toBe("ACTIVE");
  });

  test("manyToOne relation returns correctly typed parent with all field types", async () => {
    // Query child with parent included
    const childWithParent = await client.childModel.findUnique({
      where: { id: "child-1" },
      include: { parent: true },
    });

    const t = childWithParent?.parent.status;

    expect(childWithParent).not.toBeNull();
    if (!childWithParent) throw new Error("Child not found");

    // Verify parent is included
    expect(childWithParent.parent).toBeDefined();

    // Verify parent field types at runtime
    const parent = childWithParent.parent;

    // String types
    expect(typeof parent.stringRequired).toBe("string");
    expect(parent.stringRequired).toBe("hello");
    expect(parent.stringNullable).toBe("world");
    expect(Array.isArray(parent.stringArray)).toBe(true);
    expect(parent.stringArray).toEqual(["a", "b", "c"]);

    // Number types
    expect(typeof parent.intRequired).toBe("number");
    expect(parent.intRequired).toBe(42);
    expect(parent.intNullable).toBeNull();
    expect(typeof parent.floatRequired).toBe("number");
    expect(parent.floatRequired).toBeCloseTo(3.14);
    expect(typeof parent.decimalRequired).toBe("number");
    expect(parent.decimalRequired).toBeCloseTo(99.99);

    // Boolean types
    expect(typeof parent.booleanRequired).toBe("boolean");
    expect(parent.booleanRequired).toBe(true);
    expect(parent.booleanNullable).toBe(false);

    // BigInt correctly converted through relations (FIXED)
    expect(typeof parent.bigintRequired).toBe("bigint");
    expect(parent.bigintRequired).toBe(9_007_199_254_740_991n);
    expect(parent.bigintNullable).toBeNull();

    // DateTime correctly converted through relations (FIXED)
    expect(parent.datetimeRequired instanceof Date).toBe(true);
    expect(parent.datetimeNullable).toBeNull();

    // Date types - correctly converted through relations (FIXED)
    expect(parent.dateRequired instanceof Date).toBe(true);
    expect(parent.dateNullable).toBeNull();

    // Time types - should be string
    expect(typeof parent.timeRequired).toBe("string");
    expect(parent.timeNullable).toBeNull();

    // JSON types
    expect(parent.jsonRequired).toEqual({ name: "test", value: 123 });
    expect(parent.jsonNullable).toBeNull();

    // Enum type
    expect(parent.status).toBe("ACTIVE");

    // Blob type
    expect(parent.blobNullable).toBeNull();

    // Compile-time type verification for parent through relation
    // Using toMatchTypeOf to allow for minor type inference differences
    expectTypeOf(childWithParent.parent.id).toEqualTypeOf<string>();
    expectTypeOf(childWithParent.parent.stringRequired).toEqualTypeOf<string>();
    expectTypeOf(childWithParent.parent.stringNullable).toEqualTypeOf<
      string | null
    >();
    expectTypeOf(childWithParent.parent.stringArray).toEqualTypeOf<string[]>();
    expectTypeOf(childWithParent.parent.intRequired).toEqualTypeOf<number>();
    expectTypeOf(childWithParent.parent.intNullable).toEqualTypeOf<
      number | null
    >();
    expectTypeOf(childWithParent.parent.floatRequired).toEqualTypeOf<number>();
    expectTypeOf(
      childWithParent.parent.decimalRequired
    ).toEqualTypeOf<number>();
    expectTypeOf(
      childWithParent.parent.booleanRequired
    ).toEqualTypeOf<boolean>();
    expectTypeOf(childWithParent.parent.booleanNullable).toEqualTypeOf<
      boolean | null
    >();
    expectTypeOf(childWithParent.parent.bigintRequired).toEqualTypeOf<bigint>();
    expectTypeOf(childWithParent.parent.bigintNullable).toEqualTypeOf<
      bigint | null
    >();
    expectTypeOf(childWithParent.parent.datetimeRequired).toEqualTypeOf<Date>();
    expectTypeOf(
      childWithParent.parent.datetimeNullable
    ).toEqualTypeOf<Date | null>();
    expectTypeOf(childWithParent.parent.dateRequired).toEqualTypeOf<Date>();
    expectTypeOf(
      childWithParent.parent.dateNullable
    ).toEqualTypeOf<Date | null>();
    expectTypeOf(childWithParent.parent.timeRequired).toEqualTypeOf<string>();
    expectTypeOf(childWithParent.parent.timeNullable).toEqualTypeOf<
      string | null
    >();
    expectTypeOf(childWithParent.parent.status).toEqualTypeOf<
      "ACTIVE" | "INACTIVE" | "PENDING"
    >();
    expectTypeOf(childWithParent.parent.jsonRequired).toEqualTypeOf<{
      name: string;
      value: number;
    }>();
    expectTypeOf(
      childWithParent.parent.blobNullable
    ).toEqualTypeOf<Uint8Array | null>();
    // Runtime value is correct - verify it
    expect(["ACTIVE", "INACTIVE", "PENDING"]).toContain(
      childWithParent.parent.status
    );
  });

  test("nested relation queries preserve types", async () => {
    // Create another parent with a child
    await client.parentModel.create({
      data: {
        id: "parent-2",
        stringRequired: "nested test",
        stringArray: [],
        intRequired: 999,
        floatRequired: 1.5,
        decimalRequired: 50.0,
        booleanRequired: false,
        bigintRequired: 100n,
        datetimeRequired: testDate,
        dateRequired: testDateOnly,
        timeRequired: testTime,
        jsonRequired: { name: "nested", value: 0 },
        status: "PENDING",
      },
    });

    await client.childModel.create({
      data: {
        id: "child-3",
        name: "Nested Child",
        value: 300,
        isActive: true,
        createdAt: testDate,
        parentId: "parent-2",
      },
    });

    // Query with select to narrow fields
    const result = await client.childModel.findMany({
      where: { parentId: "parent-2" },
      include: { parent: true },
    });

    expect(result.length).toBe(1);
    const item = result[0]!;

    // Verify types flow through the query
    expect(item.name).toBe("Nested Child");
    expect(item.parent.stringRequired).toBe("nested test");
    expect(item.parent.status).toBe("PENDING");

    // Type assertion on the result - check key properties
    const firstResult = result[0]!;
    expectTypeOf(firstResult.id).toEqualTypeOf<string>();
    expectTypeOf(firstResult.name).toEqualTypeOf<string>();
    expectTypeOf(firstResult.value).toEqualTypeOf<number>();
    expectTypeOf(firstResult.isActive).toEqualTypeOf<boolean>();
    expectTypeOf(firstResult.createdAt).toEqualTypeOf<Date>();
    expectTypeOf(firstResult.parentId).toEqualTypeOf<string>();
    expectTypeOf(firstResult.parent.id).toEqualTypeOf<string>();
    expectTypeOf(firstResult.parent.stringRequired).toEqualTypeOf<string>();
    expectTypeOf(firstResult.parent.status).toEqualTypeOf<
      "ACTIVE" | "INACTIVE" | "PENDING"
    >();
  });

  test("findMany with include returns array of properly typed results", async () => {
    const allChildren = await client.childModel.findMany({
      include: { parent: true },
    });

    expect(allChildren.length).toBeGreaterThan(0);

    // Each child should have parent with correct types
    for (const child of allChildren) {
      expect(typeof child.id).toBe("string");
      expect(typeof child.name).toBe("string");
      expect(typeof child.parent.id).toBe("string");
      expect(typeof child.parent.stringRequired).toBe("string");
      expect(typeof child.parent.status).toBe("string");
    }

    expectTypeOf(allChildren[0]!.parent.status).toEqualTypeOf<
      "ACTIVE" | "INACTIVE" | "PENDING"
    >();
  });
});
