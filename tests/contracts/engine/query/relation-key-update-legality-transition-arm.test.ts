import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import {
  batchArmDriverOptions,
  createLegalityClient,
  expectParity,
  OCCUPIED_RELATION_ERROR,
  SET_NULL_OCCUPIED_ERROR,
} from "@tests/contracts/engine/query/relation-key-update-legality-fixtures";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

// The TRANSITION-ARM slice: one payload shape — a parent PK transition beside a nested
// `upsert` on the child-held slot — swept across all three referential actions
// (`setNull`, `restrict`, `cascade`) and across the occupied / empty / same-value /
// zero-delta arms of the guard, plus the batch-plant race that proves the empty slot is
// pinned until the parent update executes. Grouped here because the shape is the
// constant and the action is the variable; the kind- and cardinality-agnostic sweep of
// the SAME guard lives in the two `-occupied-*` siblings. The schema and the parity
// oracle live in `relation-key-update-legality-fixtures.ts`.

class MissingSlotRaceBatchDriver extends BatchOnlyPGliteDriver {
  private isArmed = false;
  private hasPlanted = false;
  private readonly plant: (client: PGlite) => Promise<void>;

  constructor(
    options: ConstructorParameters<typeof BatchOnlyPGliteDriver>[0],
    plant: (client: PGlite) => Promise<void>
  ) {
    super(options);
    this.plant = plant;
  }

  arm(): void {
    this.isArmed = true;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (this.isArmed && !this.hasPlanted) {
      if (!(client instanceof PGlite)) {
        throw new Error(
          "Missing-slot planting requires the base PGlite client."
        );
      }
      this.hasPlanted = true;
      await this.plant(client);
    }
    return super.executeBatch<T>(client, queries);
  }
}

describe("relation-key update legality", () => {
  test("rejects non-cascade child-holds key transition with nested upsert", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.setNullChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Updated" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.setNullParent.findMany(),
          children: await client.setNullChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 1, name: "Parent" }],
          children: [{ id: 1, label: "Child", parentId: 1 }],
        },
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("allows same-value set on an occupied setNull relation", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.setNullChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: { set: 1 },
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Updated" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.setNullParent.findMany(),
          children: await client.setNullChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 1, name: "Parent" }],
          children: [{ id: 1, label: "Updated", parentId: 1 }],
        },
      },
      undefined
    );
  });

  test("allows increment zero on an occupied setNull relation", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.setNullChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 0 },
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Updated zero" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.setNullParent.findMany(),
          children: await client.setNullChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 1, name: "Parent" }],
          children: [{ id: 1, label: "Updated zero", parentId: 1 }],
        },
      },
      undefined
    );
  });

  test("allows a setNull key transition when the old slot is empty", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullParent.create({
            data: { id: 1, name: "Parent" },
          });
        },
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: 2,
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Untaken" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.setNullParent.findMany(),
          children: await client.setNullChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 2, name: "Parent" }],
          children: [{ id: 2, label: "Created", parentId: 2 }],
        },
      },
      undefined
    );
  });

  test("allows a restrict key transition when the old slot is empty", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.restrictParent.create({
            data: { id: 1, name: "Parent" },
          });
        },
        act: (client) =>
          client.restrictParent.update({
            where: { id: 1 },
            data: {
              id: 2,
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Untaken" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.restrictParent.findMany(),
          children: await client.restrictChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 2, name: "Parent" }],
          children: [{ id: 2, label: "Created", parentId: 2 }],
        },
      },
      undefined
    );
  });

  test("pins an empty setNull slot until the parent update executes", async () => {
    // The forced-batch arm's shared database and its private schema. The race
    // driver is an EXTRA driver over that database, so it carries the namespace,
    // and the row it plants is written with verbatim SQL — which the driver does
    // not rewrite, so it names the schema itself.
    const options = batchArmDriverOptions();
    const driver = new MissingSlotRaceBatchDriver(
      options,
      async (plantingClient) => {
        await plantingClient.query(
          `INSERT INTO "${options.namespace}"."relation_key_set_null_children" ("id", "label", "parentId") VALUES ($1, $2, $3)`,
          [1, "Concurrent", 1]
        );
      }
    );
    const client = createLegalityClient(driver);
    try {
      await client.setNullParent.create({ data: { id: 1, name: "Parent" } });
      driver.arm();

      await expect(
        client.setNullParent.update({
          where: { id: 1 },
          data: {
            id: 2,
            child: {
              upsert: {
                create: { id: 2, label: "Created" },
                update: { label: "Updated" },
              },
            },
          },
        })
      ).rejects.toThrow(OCCUPIED_RELATION_ERROR);

      await expect(client.setNullParent.findMany()).resolves.toEqual([
        { id: 1, name: "Parent" },
      ]);
      await expect(client.setNullChild.findMany()).resolves.toEqual([
        { id: 1, label: "Concurrent", parentId: 1 },
      ]);
    } finally {
      await client.$disconnect();
    }
  });

  test("allows primary-key arithmetic transition with cascade upsert", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.cascadeParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.cascadeChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.cascadeParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Updated" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.cascadeParent.findMany(),
          children: await client.cascadeChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 2, name: "Parent" }],
          children: [{ id: 1, label: "Updated", parentId: 2 }],
        },
      },
      undefined
    );
  });
});
