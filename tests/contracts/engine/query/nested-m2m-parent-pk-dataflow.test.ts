import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { s } from "@schema";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { beforeEach, describe, expect, test } from "vitest";

class StaleMembershipBatchDriver extends BatchOnlyPGliteDriver {
  private isArmed = false;
  private hasPlanted = false;
  private readonly plant: (client: PGlite) => Promise<void>;

  constructor(
    client: PGlite,
    namespace: string,
    plant: (client: PGlite) => Promise<void>
  ) {
    super({ client, namespace });
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
          "Stale membership planting requires the base PGlite client."
        );
      }
      this.hasPlanted = true;
      await this.plant(client);
    }
    return super.executeBatch<T>(client, queries);
  }
}

const owner = s
  .model({
    id: s.int().id(),
    name: s.string(),
    tags: s
      .toMany(() => tag)
      .through("m2m_pk_owner_tags")
      .source("owner_ref")
      .target("tag_ref"),
  })
  .map("m2m_pk_owners");

const tag = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    owners: s.toMany(() => owner),
  })
  .map("m2m_pk_tags");

const schema = { owner, tag };

/**
 * The suite's private schema on the worker-shared PGlite. Every driver built
 * over `family.database` must carry `family.namespace`, or it addresses an empty
 * `public`.
 */
const getFamily = usePGliteSchemaFamily(schema);

describe("planned m2m delete parent-PK dataflow", () => {
  let client: ReturnType<typeof createDataflowClient>;

  function createDataflowClient() {
    const family = getFamily();
    return createClient({
      schema,
      driver: new BatchOnlyPGliteDriver({
        client: family.database,
        namespace: family.namespace,
      }),
    });
  }

  async function seedConnection(
    ownerId: number,
    tagId: number,
    code: string
  ): Promise<void> {
    await client.owner.create({ data: { id: ownerId, name: code } });
    await client.tag.create({ data: { id: tagId, code } });
    await client.owner.update({
      where: { id: ownerId },
      data: { tags: { connect: { id: tagId } } },
    });
  }

  function bootStaleMembershipClient(
    plant: (database: PGlite) => Promise<void>
  ): StaleMembershipBatchDriver {
    const family = getFamily();
    const driver = new StaleMembershipBatchDriver(
      family.database,
      family.namespace,
      plant
    );
    client = createClient({ schema, driver });
    return driver;
  }

  beforeEach(() => {
    client = createDataflowClient();
  });

  test("explicit m2m delete observes direct and set parent-PK changes at execution", async () => {
    await seedConnection(10, 1, "direct");
    await seedConnection(30, 2, "set");

    await expect(
      client.owner.update({
        where: { id: 10 },
        data: { id: 20, tags: { delete: { code: "direct" } } },
      })
    ).resolves.toMatchObject({ id: 20 });
    await expect(
      client.owner.update({
        where: { id: 30 },
        data: { id: { set: 40 }, tags: { delete: { code: "set" } } },
      })
    ).resolves.toMatchObject({ id: 40 });

    await expect(
      client.owner.findUnique({ where: { id: 10 } })
    ).resolves.toBeNull();
    await expect(
      client.owner.findUnique({ where: { id: 30 } })
    ).resolves.toBeNull();
    await expect(client.tag.findMany()).resolves.toEqual([]);
  });

  test("explicit m2m delete resolves an arithmetic parent-PK transition", async () => {
    await seedConnection(100, 3, "arithmetic");

    await expect(
      client.owner.update({
        where: { id: 100 },
        data: {
          id: { increment: 7 },
          tags: { delete: { code: "arithmetic" } },
        },
      })
    ).resolves.toMatchObject({ id: 107 });

    await expect(
      client.owner.findUnique({ where: { id: 100 } })
    ).resolves.toBeNull();
    await expect(
      client.owner.findUnique({ where: { id: 107 }, include: { tags: true } })
    ).resolves.toMatchObject({ id: 107, tags: [] });
    await expect(
      client.tag.findUnique({ where: { id: 3 } })
    ).resolves.toBeNull();
  });

  test("m2m deleteMany pins its filtered set to the final parent identity", async () => {
    await seedConnection(300, 5, "delete-match");
    await client.tag.create({ data: { id: 6, code: "keep" } });
    await client.owner.update({
      where: { id: 300 },
      data: { tags: { connect: { id: 6 } } },
    });

    await expect(
      client.owner.update({
        where: { id: 300 },
        data: {
          id: { set: 301 },
          tags: { deleteMany: { code: "delete-match" } },
        },
      })
    ).resolves.toMatchObject({ id: 301 });

    await expect(
      client.owner.findUnique({ where: { id: 301 }, include: { tags: true } })
    ).resolves.toMatchObject({ id: 301, tags: [{ id: 6, code: "keep" }] });
    await expect(
      client.tag.findUnique({ where: { id: 5 } })
    ).resolves.toBeNull();
  });

  test("deleteMany retries when a member is added to a nonempty planned set", async () => {
    // Verbatim SQL is not qualified by the driver's namespace, so this planted
    // statement must name the suite's schema itself.
    const junction = `"${getFamily().namespace}"."m2m_pk_owner_tags"`;
    const driver = bootStaleMembershipClient(async (database) => {
      await database.query(
        `INSERT INTO ${junction} ("owner_ref", "tag_ref") VALUES ($1, $2)`,
        [400, 8]
      );
    });
    await seedConnection(400, 7, "planned");
    await client.tag.create({ data: { id: 8, code: "added" } });

    driver.arm();
    await client.owner.update({
      where: { id: 400 },
      data: { tags: { deleteMany: {} } },
    });

    await expect(client.tag.findMany()).resolves.toEqual([]);
  });

  test("deleteMany retries when a member is added to an empty planned set", async () => {
    // Verbatim SQL is not qualified by the driver's namespace, so this planted
    // statement must name the suite's schema itself.
    const junction = `"${getFamily().namespace}"."m2m_pk_owner_tags"`;
    const driver = bootStaleMembershipClient(async (database) => {
      await database.query(
        `INSERT INTO ${junction} ("owner_ref", "tag_ref") VALUES ($1, $2)`,
        [500, 9]
      );
    });
    await client.owner.create({ data: { id: 500, name: "empty" } });
    await client.tag.create({ data: { id: 9, code: "added-empty" } });

    driver.arm();
    await client.owner.update({
      where: { id: 500 },
      data: { tags: { deleteMany: {} } },
    });

    await expect(client.tag.findMany()).resolves.toEqual([]);
  });

  test("deleteMany retries without deleting a member removed after planning", async () => {
    // Verbatim SQL is not qualified by the driver's namespace, so this planted
    // statement must name the suite's schema itself.
    const junction = `"${getFamily().namespace}"."m2m_pk_owner_tags"`;
    const driver = bootStaleMembershipClient(async (database) => {
      await database.query(
        `DELETE FROM ${junction} WHERE "owner_ref" = $1 AND "tag_ref" = $2`,
        [600, 10]
      );
    });
    await seedConnection(600, 10, "removed");

    driver.arm();
    await client.owner.update({
      where: { id: 600 },
      data: { tags: { deleteMany: {} } },
    });

    await expect(client.tag.findMany()).resolves.toEqual([
      { id: 10, code: "removed" },
    ]);
  });
});
