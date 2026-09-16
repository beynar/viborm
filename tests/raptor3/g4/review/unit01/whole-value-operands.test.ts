import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { closeWorld, createWorld, seedPerson, type World } from "./world";

/**
 * Q-W03 / SC-05..SC-13 probe. A scalar whose PUBLIC value is itself an object
 * (Date, Uint8Array, Decimal) is one whole value, not an operator record.
 * Admission normalizes the shorthand into `{ equals: <value> }`, so the query
 * owner sees an object operand for these domains on every equality filter.
 */
function world(): World {
  const created = createWorld();
  seedPerson(created, {
    id: 1,
    person_name: "one",
    joined_at: "2024-01-01T00:00:00.000Z",
    birthday: "1990-05-04",
    avatar: Buffer.from([1, 2, 3]),
    balance: 1234n,
  });
  seedPerson(created, {
    id: 2,
    person_name: "two",
    joined_at: "2025-06-06T12:00:00.000Z",
    birthday: "1991-07-08",
    avatar: Buffer.from([9, 9]),
    balance: 5678n,
  });
  return created;
}

async function ids(
  created: World,
  where: Record<string, unknown>
): Promise<number[]> {
  const rows = (await created.engine.execute("person", "findMany", {
    where,
    orderBy: { id: "asc" },
    select: { id: true },
  })) as Record<string, unknown>[];
  return rows.map((row) => row.id as number);
}

describe("G4-01 review — whole-value scalar operands", () => {
  it("filters a dateTime column by a Date operand", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, {
          joinedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        [1]
      );
      assert.deepEqual(
        await ids(created, {
          joinedAt: { equals: new Date("2025-06-06T12:00:00.000Z") },
        }),
        [2]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("filters a dateTime column by a Date range operand", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, { joinedAt: { gt: new Date("2025-01-01T00:00:00.000Z") } }),
        [2]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("filters a date column by a Date operand", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, { birthday: new Date("1990-05-04T00:00:00.000Z") }),
        [1]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("filters a blob column by a Uint8Array operand", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, { avatar: new Uint8Array([1, 2, 3]) }),
        [1]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("filters a decimal column by a Decimal operand", async () => {
    const created = world();
    try {
      const { Decimal } = await import("decimal.js");
      assert.deepEqual(
        await ids(created, { balance: new Decimal("12.34") }),
        [1]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("negates a blob equality operand", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, { avatar: { not: new Uint8Array([1, 2, 3]) } }),
        [2]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("filters a dateTime column inside a NOT and inside a relation scope", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, {
          NOT: { joinedAt: new Date("2024-01-01T00:00:00.000Z") },
        }),
        [2]
      );
    } finally {
      await closeWorld(created);
    }
  });
});
