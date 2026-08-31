import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";

import { hydrateSchemaNames, s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const generatedOutputSchema = (() => {
  const owner = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      children: s.toMany(() => child),
    })
    .map("generated_output_owners");
  const child = s
    .model({
      id: s.string().id(),
      ownerId: s.int(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("generated_output_children");
  return { child, owner };
})();

hydrateSchemaNames(generatedOutputSchema);

const compoundGeneratedOutputSchema = (() => {
  const account = s
    .model({
      tenantId: s.int().increment().unique(),
      recordId: s.int().increment(),
      label: s.string(),
      profiles: s.toMany(() => profile),
    })
    .id(["tenantId", "recordId"])
    .map("compound_generated_accounts");
  const profile = s
    .model({
      id: s.string().id(),
      accountTenantId: s.int(),
      account: s
        .toOne(() => account)
        .fields("accountTenantId")
        .references("tenantId"),
    })
    .map("compound_generated_profiles");
  return { account, profile };
})();

hydrateSchemaNames(compoundGeneratedOutputSchema);

const consumedPublicationSchema = (() => {
  const provider = s
    .model({
      id: s.string().id(),
      name: s.string(),
      // A to-ONE: `account.providerId` is unique, and a unique foreign key
      // contradicting a remote collection is FK009. The badge edge references
      // that same unique, so the uniqueness is the fact that must stay.
      account: s.toOne(() => account),
    })
    .map("consumed_publication_providers");
  const account = s
    .model({
      id: s.int().id().increment(),
      providerId: s.string().unique(),
      provider: s
        .toOne(() => provider)
        .fields("providerId")
        .references("id"),
      badges: s.toMany(() => badge),
    })
    .map("consumed_publication_accounts");
  const badge = s
    .model({
      id: s.string().id(),
      accountProviderId: s.string(),
      account: s
        .toOne(() => account)
        .fields("accountProviderId")
        .references("providerId"),
    })
    .map("consumed_publication_badges");
  return { account, badge, provider };
})();

hydrateSchemaNames(consumedPublicationSchema);

type SQLiteDatabase = Database.Database;

class BatchOnlyNonReturningSQLiteDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batchCalls = 0;

  constructor() {
    super({ dataDir: ":memory:" });
    this.adapter.capabilities.supportsReturning = false;
  }

  protected override executeBatch<T>(
    client: SQLiteDatabase,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        const result = await this.executeRaw<T>(
          transaction,
          query.sql,
          query.params
        );
        const identity = await this.executeRaw<{ id: number | bigint }>(
          transaction,
          "SELECT last_insert_rowid() AS id"
        );
        const insertId = identity.rows[0]?.id;
        results.push(insertId === undefined ? result : { ...result, insertId });
      }
      return results;
    });
  }
}

describe("generated output fallback", () => {
  const family = usePGliteSchemaFamily(generatedOutputSchema, "atomicBatch");
  const transactionFamily = usePGliteSchemaFamily(
    generatedOutputSchema,
    "transaction"
  );
  const compoundFamily = usePGliteSchemaFamily(
    compoundGeneratedOutputSchema,
    "atomicBatch"
  );

  test("a capability-false PostgreSQL batch materializes RETURNING before its child", async () => {
    const { client, driver } = family();
    expect(driver.supportsTransactions).toBe(false);
    expect(driver.supportsOrderedCommittedSegments).toBe(false);
    driver.adapter.capabilities.supportsCteWithMutations = false;

    await expect(
      client.owner.create({
        data: {
          label: "generated parent",
          children: { create: { id: "child" } },
        },
        select: {
          id: true,
          label: true,
          children: { select: { id: true, ownerId: true } },
        },
      })
    ).resolves.toEqual({
      id: 1,
      label: "generated parent",
      children: [{ id: "child", ownerId: 1 }],
    });

    await expect(client.child.findMany()).resolves.toEqual([
      { id: "child", ownerId: 1 },
    ]);
  });

  test("the interactive PostgreSQL path keeps the same generated parent result", async () => {
    const { client } = transactionFamily();

    await expect(
      client.owner.create({
        data: {
          label: "generated parent",
          children: { create: { id: "child" } },
        },
        select: {
          id: true,
          label: true,
          children: { select: { id: true, ownerId: true } },
        },
      })
    ).resolves.toEqual({
      id: 1,
      label: "generated parent",
      children: [{ id: "child", ownerId: 1 }],
    });
  });

  test("one demanded member closes RETURNING over a fresh compound generated row key", async () => {
    const { client } = compoundFamily();

    await expect(
      client.profile.create({
        data: {
          id: "profile",
          account: { create: { label: "generated compound account" } },
        },
        select: { id: true, accountTenantId: true },
      })
    ).resolves.toEqual({ id: "profile", accountTenantId: 1 });

    await expect(client.account.findMany()).resolves.toEqual([
      {
        tenantId: 1,
        recordId: 1,
        label: "generated compound account",
      },
    ]);
  });
});

describe("generated output exact batch scratch", () => {
  const driver = new BatchOnlyNonReturningSQLiteDriver();
  const client = createClient({ schema: consumedPublicationSchema, driver });

  beforeAll(async () => {
    await syncLiveSchema(client);
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  test("a nested generated key and relation-supplied publication stay in one native batch", async () => {
    await client.provider.create({ data: { id: "provider", name: "P" } });
    driver.batchCalls = 0;

    await expect(
      client.badge.create({
        data: {
          id: "badge",
          account: {
            create: { provider: { connect: { id: "provider" } } },
          },
        },
        select: { id: true, accountProviderId: true },
      })
    ).resolves.toEqual({ id: "badge", accountProviderId: "provider" });

    expect(driver.batchCalls).toBe(1);
    await expect(client.account.findMany()).resolves.toEqual([
      { id: 1, providerId: "provider" },
    ]);
  });
});

describe("generated root result through exact batch scratch", () => {
  const driver = new BatchOnlyNonReturningSQLiteDriver();
  const client = createClient({ schema: generatedOutputSchema, driver });

  beforeAll(async () => {
    await syncLiveSchema(client);
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  test("scratch setup cannot masquerade as a skipped record-series root", async () => {
    driver.batchCalls = 0;

    await expect(
      client.owner.create({
        data: {
          label: "generated parent",
          children: { create: { id: "child" } },
        },
        select: {
          id: true,
          label: true,
          children: { select: { id: true, ownerId: true } },
        },
      })
    ).resolves.toEqual({
      id: 1,
      label: "generated parent",
      children: [{ id: "child", ownerId: 1 }],
    });

    expect(driver.batchCalls).toBe(1);
  });
});
