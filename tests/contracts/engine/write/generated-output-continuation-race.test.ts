import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { TransactionError } from "@errors";

import { hydrateSchemaNames, s } from "@schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { syncLiveSchema } from "@tests/fixtures/sync-schema";
const continuationRaceSchema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      code: s.int().increment().unique(),
      tokens: s.toMany(() => token),
    })
    .map("generated_continuation_accounts");
  const token = s
    .model({
      id: s.string().id(),
      accountCode: s.int(),
      account: s
        .toOne(() => account)
        .fields("accountCode")
        .references("code"),
    })
    .map("generated_continuation_tokens");
  return { account, token };
})();

hydrateSchemaNames(continuationRaceSchema);

class MoveGeneratedCodeAfterProducerDriver extends BatchOnlyPGliteDriver {
  private armed = false;
  private operationBatches = 0;

  arm(): void {
    this.armed = true;
    this.operationBatches = 0;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const results = await super.executeBatch<T>(client, queries);
    if (!this.armed) return results;
    this.operationBatches += 1;
    if (this.operationBatches !== 1) return results;
    this.armed = false;
    await this.transaction(client, async (transaction) => {
      await this.executeRaw(
        transaction,
        'UPDATE "generated_continuation_accounts" SET "code" = $1 WHERE "id" = $2',
        [2, "owner"]
      );
      await this.executeRaw(
        transaction,
        'INSERT INTO "generated_continuation_accounts" ("id", "code") VALUES ($1, $2)',
        ["replacement", 1]
      );
    });
    return results;
  }
}

function clientFor(driver: MoveGeneratedCodeAfterProducerDriver) {
  return createClient({ schema: continuationRaceSchema, driver });
}

describe("generated-output continuation premise", () => {
  const database = new PGlite();
  const driver = new MoveGeneratedCodeAfterProducerDriver({ client: database });
  const client = clientFor(driver);

  beforeAll(async () => {
    await syncLiveSchema(client);
    driver.adapter.capabilities.supportsCteWithMutations = false;
  });

  beforeEach(async () => {
    await client.token.deleteMany({});
    await client.account.deleteMany({});
    await client.$executeRawUnsafe(
      'ALTER SEQUENCE "generated_continuation_accounts_code_seq" RESTART WITH 1'
    );
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  test("a stable non-key generated value reaches its child", async () => {
    await expect(
      client.account.create({
        data: { id: "owner", tokens: { create: { id: "token" } } },
        select: { id: true, code: true },
      })
    ).resolves.toEqual({ id: "owner", code: 1 });
    await expect(client.token.findMany()).resolves.toEqual([
      { id: "token", accountCode: 1 },
    ]);
  });

  test("a moved and reused non-key value cannot link the child to the replacement owner", async () => {
    driver.arm();

    const failure = await client.account
      .create({
        data: { id: "owner", tokens: { create: { id: "token" } } },
        select: { id: true, code: true },
      })
      .catch((error) => error);

    if (!(failure instanceof TransactionError)) throw failure;
    expect(failure.message).toBe(
      "Created record 'account' changed across a generated-output segment boundary."
    );
    await expect(
      client.account.findMany({ select: { id: true, code: true } })
    ).resolves.toEqual([
      { id: "owner", code: 2 },
      { id: "replacement", code: 1 },
    ]);
    await expect(client.token.findMany()).resolves.toEqual([]);
  });
});
