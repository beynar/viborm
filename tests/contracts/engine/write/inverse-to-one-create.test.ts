import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { UniqueConstraintError } from "@errors";
import {
  inverseToOneCreateSchema,
  runInverseToOneCreateBehavior,
} from "@tests/contracts/engine/write/inverse-to-one-create-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.executeRaw<T>(client, sql, params, context);
  }
}

runInverseToOneCreateBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
runInverseToOneCreateBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

test("an occupied slot is decided by the constraint alone, and is not retried", async () => {
  const driver = new RecordingPGliteDriver();
  const client = createClient({ schema: inverseToOneCreateSchema, driver });
  try {
    await syncLiveSchema(client);
    await client.account.create({
      data: { id: 1, email: "a@x", code: "A", label: "l" },
    });
    await client.account.update({
      where: { id: 1 },
      data: { profile: { create: { id: 10, bio: "first" } } },
    });

    driver.recording = true;
    await expect(
      client.account.update({
        where: { id: 1 },
        data: { profile: { create: { id: 11, bio: "second" } } },
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    driver.recording = false;

    const profileStatements = driver.statements.filter((statement) =>
      statement.includes("n2_ito_profiles")
    );
    expect(
      profileStatements.filter((statement) => statement.startsWith("INSERT"))
    ).toHaveLength(1);
    expect(
      profileStatements.filter((statement) => statement.startsWith("SELECT"))
    ).toHaveLength(0);
  } finally {
    await client.$disconnect();
  }
});
