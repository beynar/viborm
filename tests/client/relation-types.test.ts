/**
 * Relation Types Integration Test
 *
 * This test verifies that types flow correctly through relations.
 * It tests various scalar types via parent-child relationships.
 */

import type { BatchPayload } from "@client/exports";
import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { push } from "@migrations";
import { DbNull, s } from "@schema";
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
// MODEL DEFINITIONS - All scalar types
// =============================================================================

// Parent model with all scalar types
const parentModel = s.model({
  id: s.string().id(),

  // String scalars
  stringRequired: s.string(),
  stringNullable: s.string().nullable(),
  stringArray: s.string().array(),

  // Number scalars
  intRequired: s.int(),
  intNullable: s.int().nullable(),
  floatRequired: s.float(),
  decimalRequired: s.decimal(),

  // Boolean scalars
  booleanRequired: s.boolean(),
  booleanNullable: s.boolean().nullable(),

  // BigInt scalars
  bigintRequired: s.bigInt(),
  bigintNullable: s.bigInt().nullable(),

  // DateTime scalars
  datetimeRequired: s.dateTime(),
  datetimeNullable: s.dateTime().nullable(),

  // Date and Time fields
  dateRequired: s.date(),
  dateNullable: s.date().nullable(),
  timeRequired: s.time(),
  timeNullable: s.time().nullable(),

  // JSON scalars
  jsonRequired: s.json().schema(
    z.object({
      name: z.string(),
      value: z.number(),
    })
  ),
  jsonNullable: s.json().nullable(),

  // Enum field
  status: s.enum(["ACTIVE", "INACTIVE", "PENDING"] as const),

  // Blob scalar
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

let client: Awaited<
  ReturnType<typeof PGliteCreateClient<typeof schema, { schema: typeof schema }>>
>;

// Test data
const testDate = new Date("2024-06-15T14:30:00.000Z");
const testDateOnly = new Date("2024-06-15");
const testTime = "14:30:00";

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite();
  client = await PGliteCreateClient({ schema, client: pglite });
  await push(client, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

// =============================================================================
// RELATION TYPE TESTS
// =============================================================================

describe("Relation Types Integration Test", () => {
  test("type: nested child create can omit parent-derived FK", () => {
    type ParentCreateArgs = Parameters<typeof client.parentModel.create>[0];

    expectTypeOf<{
      data: {
        id: string;
        stringRequired: string;
        stringArray: string[];
        intRequired: number;
        floatRequired: number;
        decimalRequired: number;
        booleanRequired: boolean;
        bigintRequired: bigint;
        datetimeRequired: Date;
        dateRequired: Date;
        timeRequired: string;
        jsonRequired: { name: string; value: number };
        status: "ACTIVE";
        children: {
          create: {
            id: string;
            name: string;
            value: number;
            isActive: boolean;
            createdAt: Date;
          };
        };
      };
    }>().toMatchTypeOf<ParentCreateArgs>();
  });

  test("type: direct child create requires FK unless relation data provides it", () => {
    type ChildCreateArgs = Parameters<typeof client.childModel.create>[0];

    expectTypeOf<{
      data: {
        id: string;
        name: string;
        value: number;
        isActive: boolean;
        createdAt: Date;
      };
    }>().not.toMatchTypeOf({} as ChildCreateArgs);

    expectTypeOf<{
      data: {
        id: string;
        name: string;
        value: number;
        isActive: boolean;
        createdAt: Date;
        parent: { connect: { id: string } };
      };
    }>().toMatchTypeOf<ChildCreateArgs>();
  });

  test("type: client update accepts planned nested to-many update operations", () => {
    type ParentUpdateArgs = Parameters<typeof client.parentModel.update>[0];

    expectTypeOf<{
      where: { id: string };
      data: {
        children: {
          update: { where: { id: string }; data: { name?: string } };
        };
      };
    }>().toMatchTypeOf<ParentUpdateArgs>();
    expectTypeOf<{
      where: { id: string };
      data: {
        children: {
          updateMany: {
            where: { isActive?: boolean };
            data: { name?: string };
          };
        };
      };
    }>().toMatchTypeOf<ParentUpdateArgs>();
    expectTypeOf<{
      where: { id: string };
      data: {
        children: {
          deleteMany: { isActive?: boolean };
        };
      };
    }>().toMatchTypeOf<ParentUpdateArgs>();
    expectTypeOf<{
      where: { id: string };
      data: {
        children: {
          upsert: {
            where: { id: string };
            create: {
              id: string;
              name: string;
              value: number;
              isActive: boolean;
              createdAt: Date;
              parentId: string;
            };
            update: { name?: string };
          };
        };
      };
    }>().toMatchTypeOf<ParentUpdateArgs>();
  });

  test("type: client upsert accepts planned nested mutation keys in update branch", () => {
    type ParentUpsertArgs = Parameters<typeof client.parentModel.upsert>[0];

    expectTypeOf<{
      where: { id: string };
      create: {
        id: string;
        stringRequired: string;
        stringArray: string[];
        intRequired: number;
        floatRequired: number;
        decimalRequired: number;
        booleanRequired: boolean;
        bigintRequired: bigint;
        datetimeRequired: Date;
        dateRequired: Date;
        timeRequired: string;
        jsonRequired: { name: string; value: number };
        status: "ACTIVE";
      };
      update: {
        children: {
          update: { where: { id: string }; data: { name?: string } };
        };
      };
    }>().toMatchTypeOf<ParentUpsertArgs>();
  });

  test("type: client createMany rejects relation mutation envelopes", () => {
    type ParentCreateManyArgs = Parameters<
      typeof client.parentModel.createMany
    >[0];
    type ParentCreateManyItem = ParentCreateManyArgs["data"][number];

    expectTypeOf<ParentCreateManyItem>().not.toHaveProperty("children");
  });

  test("type: createMany accepts scalar data and returns BatchPayload", () => {
    type ParentCreateManyArgs = Parameters<
      typeof client.parentModel.createMany
    >[0];
    // Implicit returning: the result type is conditional on `select`, so probe
    // it with a concrete select-LESS argument rather than the generic's
    // constraint (which carries an OPTIONAL select and would answer for neither
    // arm honestly).
    type ParentCreateManyResult = Awaited<
      ReturnType<
        typeof client.parentModel.createMany<{
          data: NonNullable<ParentCreateManyArgs["data"]>;
        }>
      >
    >;

    expectTypeOf<{
      data: Array<{
        id: string;
        stringRequired: string;
        stringArray: string[];
        intRequired: number;
        floatRequired: number;
        decimalRequired: number;
        booleanRequired: boolean;
        bigintRequired: bigint;
        datetimeRequired: Date;
        dateRequired: Date;
        timeRequired: string;
        jsonRequired: { name: string; value: number };
        status: "ACTIVE";
      }>;
    }>().toMatchTypeOf<ParentCreateManyArgs>();
    expectTypeOf<ParentCreateManyResult>().toEqualTypeOf<BatchPayload>();
  });

  test("type: createMany accepts select (implicit returning) and rejects include", () => {
    type ParentCreateManyArgs = Parameters<
      typeof client.parentModel.createMany
    >[0];

    // `select` became part of the surface in W3-B: its presence is what makes a
    // bulk write return rows. `include` stays out — a RETURNING row set cannot
    // carry a joined relation.
    expectTypeOf<
      "select" extends keyof ParentCreateManyArgs ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      "include" extends keyof ParentCreateManyArgs ? true : false
    >().toEqualTypeOf<false>();
  });

  test("type: createMany with select returns rows, not BatchPayload", () => {
    type ParentCreateManyArgs = Parameters<
      typeof client.parentModel.createMany
    >[0];
    type ParentCreateManyRows = Awaited<
      ReturnType<
        typeof client.parentModel.createMany<{
          data: NonNullable<ParentCreateManyArgs["data"]>;
          select: { id: true };
        }>
      >
    >;

    expectTypeOf<ParentCreateManyRows>().toEqualTypeOf<{ id: string }[]>();
  });

  test("type: groupBy by accepts only scalar keys", () => {
    type ParentGroupByArgs = Parameters<typeof client.parentModel.groupBy>[0];

    expectTypeOf<{ by: "status" }>().toMatchTypeOf<ParentGroupByArgs>();
    expectTypeOf<{
      by: ["status", "booleanRequired"];
    }>().toMatchTypeOf<ParentGroupByArgs>();
    expectTypeOf<{ by: "children" }>().not.toMatchTypeOf<ParentGroupByArgs>();
    expectTypeOf<{
      by: ["status", "children"];
    }>().not.toMatchTypeOf<ParentGroupByArgs>();
  });

  test("oneToMany relation returns correctly typed children", async () => {
    // Create parent with all scalar types
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
        // A JSON column has two nulls; `DbNull` names the database one
        jsonNullable: DbNull,
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

    // Verify child scalar types at runtime
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

    // Verify parent scalars still have correct types
    expect(parentWithChildren.stringRequired).toBe("hello");
    expect(parentWithChildren.intRequired).toBe(42);
    expect(parentWithChildren.booleanRequired).toBe(true);
    expect(parentWithChildren.status).toBe("ACTIVE");
  });

  test("manyToOne relation returns correctly typed parent with all scalar types", async () => {
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

    // Verify parent scalar types at runtime
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
    // W6-U1: a decimal comes back as its exact canonical string, through a
    // relation as much as at the top level. `toBeCloseTo` was the tell that the
    // old value was approximate — an exact one can be compared exactly.
    expect(typeof parent.decimalRequired).toBe("string");
    expect(parent.decimalRequired).toBe("99.99");

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
    // W6-U1: decimals read as exact strings, through relations too
    expectTypeOf(
      childWithParent.parent.decimalRequired
    ).toEqualTypeOf<string>();
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
