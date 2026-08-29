import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";

import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const schema = (() => {
  const collection = s
    .model({
      id: s.string().id(),
      docs: s.toMany(() => doc),
    })
    .map("vector_behavior_collections");

  const doc = s
    .model({
      id: s.string().id(),
      collectionId: s.string(),
      collection: s
        .toOne(() => collection)
        .fields("collectionId")
        .references("id"),
      embedding: s.vector().dimension(3),
    })
    .map("vector_behavior_docs");

  return { collection, doc };
})();

type VectorClientConfig = VibORMConfig<typeof schema>;

type VectorClient = VibORMClient<VectorClientConfig>;

export interface VectorBehaviorOptions {
  driverName: string;
  enabled: boolean;
  createDriver: () => AnyDriver;
}

export function runVectorBehavior({
  driverName,
  enabled,
  createDriver,
}: VectorBehaviorOptions) {
  const describeIf = enabled ? describe : describe.skip;

  describeIf(`${driverName} vector distance ordering`, () => {
    let client: VectorClient | undefined;
    let driver: AnyDriver | undefined;

    beforeEach(async () => {
      driver = createDriver();
      await driver._executeRaw("CREATE EXTENSION IF NOT EXISTS vector");
      client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await driver._executeRaw('DELETE FROM "vector_behavior_docs"');
      await driver._executeRaw('DELETE FROM "vector_behavior_collections"');
      await seedVectorDocs(driver);
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
      } else if (driver) {
        await driver.disconnect();
      }
      client = undefined;
      driver = undefined;
    });

    test("orders nearest-first by l2 distance and honors take", async () => {
      const docs = await requireClient(client).doc.findMany({
        select: { id: true },
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
            },
          },
        },
        take: 2,
      });

      expect(docs.map((doc) => doc.id)).toEqual(["exact", "near"]);
    });

    test("orders farthest-first by l2 distance when distance sort is desc", async () => {
      const docs = await requireClient(client).doc.findMany({
        select: { id: true },
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
              sort: "desc",
            },
          },
        },
        take: 2,
      });

      expect(docs.map((doc) => doc.id)).toEqual(["opposite", "orthogonal"]);
    });

    test("orders nearest-first by cosine distance and honors take", async () => {
      const docs = await requireClient(client).doc.findMany({
        select: { id: true },
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "cosine",
            },
          },
        },
        take: 2,
      });

      expect(docs.map((doc) => doc.id)).toEqual(["exact", "near"]);
    });

    test("selects l2 distance scores as numbers", async () => {
      const docs = await requireClient(client).doc.findMany({
        select: {
          id: true,
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
            },
          },
        },
        orderBy: { id: "asc" },
      });

      const scores = new Map(docs.map((doc) => [doc.id, doc._distance]));

      expect(typeof scores.get("exact")).toBe("number");
      expect(scores.get("exact")).toBeCloseTo(0);
      expect(scores.get("near")).toBeCloseTo(0.2828427);
      expect(scores.get("orthogonal")).toBeCloseTo(1.4142135);
      expect(scores.get("opposite")).toBeCloseTo(2);
    });

    test("orders by distance and returns matching selected scores", async () => {
      const docs = await requireClient(client).doc.findMany({
        select: {
          id: true,
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
            },
          },
        },
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
            },
          },
        },
        take: 3,
      });

      expect(docs.map((doc) => doc.id)).toEqual([
        "exact",
        "near",
        "orthogonal",
      ]);
      expect(docs[0]?._distance).toBeCloseTo(0);
      expect(docs[1]?._distance).toBeCloseTo(0.2828427);
      expect(docs[2]?._distance).toBeCloseTo(1.4142135);
    });

    test("orders included docs nearest-first by vector distance and honors take", async () => {
      const collections = await requireClient(client).collection.findMany({
        include: {
          docs: {
            select: { id: true },
            orderBy: {
              embedding: {
                _distance: {
                  to: [1, 0, 0],
                  metric: "l2",
                },
              },
            },
            take: 2,
          },
        },
      });

      expect(collections).toHaveLength(1);
      expect(collections[0]?.docs.map((doc) => doc.id)).toEqual([
        "exact",
        "near",
      ]);
    });

    test("throws on vector dimension mismatch before execution", async () => {
      await expect(
        requireClient(client).doc.findMany({
          select: { id: true },
          orderBy: {
            embedding: {
              _distance: {
                to: [1, 0],
                metric: "l2",
              },
            },
          },
        })
      ).rejects.toThrow(
        "Vector distance orderBy dimension mismatch for 'embedding': expected 3 values, received 2."
      );
    });
  });
}

async function seedVectorDocs(driver: AnyDriver) {
  await driver._executeRaw(
    `INSERT INTO "vector_behavior_collections" ("id") VALUES ($1)`,
    ["collection"]
  );
  await driver._executeRaw(
    `INSERT INTO "vector_behavior_docs" ("id", "collectionId", "embedding") VALUES ` +
      `($1, $2, $3::vector), ` +
      `($4, $5, $6::vector), ` +
      `($7, $8, $9::vector), ` +
      `($10, $11, $12::vector)`,
    [
      "exact",
      "collection",
      "[1,0,0]",
      "near",
      "collection",
      "[0.8,0.2,0]",
      "orthogonal",
      "collection",
      "[0,1,0]",
      "opposite",
      "collection",
      "[-1,0,0]",
    ]
  );
}

function requireClient(client: VectorClient | undefined): VectorClient {
  if (!client) {
    throw new Error("Vector behavior client was not initialized.");
  }
  return client;
}

export const vectorContract = defineContract({
  id: "drivers.vector",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runVectorBehavior,
});
