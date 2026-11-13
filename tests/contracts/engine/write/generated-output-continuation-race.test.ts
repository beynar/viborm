import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import type { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { TransactionError } from "@errors";

import { hydrateSchemaNames, s } from "@schema";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";

import { describe, expect, test } from "vitest";

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

const getFamily = usePGliteSchemaFamily(continuationRaceSchema);

const INSERTS_ACCOUNT = /^INSERT INTO .*"generated_continuation_accounts"/;

class MoveGeneratedCodeAfterProducerDriver extends BatchOnlyPGliteDriver {
  private armed = false;
  /** The accounts table, schema-qualified: the two statements below are VERBATIM,
   *  so nothing rewrites them onto this driver's namespace. */
  private readonly accounts: string;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    accounts: string
  ) {
    super(options);
    this.accounts = accounts;
  }

  arm(): void {
    this.armed = true;
  }

  /** Another writer moves the owner's generated code and reuses it, once the producer is written. */
  private async interfere(client: PGlite | Transaction): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    await this.executeRaw(
      client,
      `UPDATE ${this.accounts} SET "code" = $1 WHERE "id" = $2`,
      [2, "owner"]
    );
    await this.executeRaw(
      client,
      `INSERT INTO ${this.accounts} ("id", "code") VALUES ($1, $2)`,
      ["replacement", 1]
    );
  }

  // The producer leaves alone, as one statement or as a batch: the other
  // writer lands behind whichever carried it.
  protected override async execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const result = await super.execute<T>(client, statement, params, context);
    if (INSERTS_ACCOUNT.test(statement)) await this.interfere(client);
    return result;
  }
}

/** The interfering driver rides the family's shared database, so it carries the
 *  family's namespace — without it every statement would address `public`. */
function makeRaceDriver(family: ReturnType<typeof getFamily>) {
  const driver = new MoveGeneratedCodeAfterProducerDriver(
    { client: family.database, namespace: family.namespace },
    `"${family.namespace}"."generated_continuation_accounts"`
  );
  driver.adapter.capabilities.supportsCteWithMutations = false;
  return driver;
}

function clientFor(driver: MoveGeneratedCodeAfterProducerDriver) {
  return createClient({ schema: continuationRaceSchema, driver });
}

describe("generated-output continuation premise", () => {
  test("a stable non-key generated value reaches its child", async () => {
    const client = clientFor(makeRaceDriver(getFamily()));

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
    const driver = makeRaceDriver(getFamily());
    const client = clientFor(driver);
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
