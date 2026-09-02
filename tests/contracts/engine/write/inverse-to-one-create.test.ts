import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { UniqueConstraintError } from "@errors";
import {
  inverseToOneCreateSchema,
  runInverseToOneCreateBehavior,
} from "@tests/contracts/engine/write/inverse-to-one-create-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { expect, test } from "vitest";

/**
 * One shared PGlite, one private schema for the statement-level witness below. The
 * recording driver is built over that database, so it carries the family's namespace —
 * without it the driver addresses `public`, where this suite has no tables. The two
 * behavior legs run on schemas of their own, provisioned by `useBehaviorDatabase`.
 */
const getFamily = usePGliteSchemaFamily(inverseToOneCreateSchema);

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
  const family = getFamily();
  const driver = new RecordingPGliteDriver({
    client: family.database,
    namespace: family.namespace,
  });
  const client = createClient({ schema: inverseToOneCreateSchema, driver });
  // The schema family created the tables and truncated them for this test, and it owns
  // the connection: the database is the worker's, shared with every other suite in the
  // process, so this driver neither syncs it nor closes it.
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

  // The table name is matched inside the statement, not anchored at its start: the
  // recorded SQL is schema-qualified (`"suite_7"."n2_ito_profiles"`), and the INSERT /
  // SELECT counts below are the claim — one insert, no pre-check probe.
  const profileStatements = driver.statements.filter((statement) =>
    statement.includes("n2_ito_profiles")
  );
  expect(
    profileStatements.filter((statement) => statement.startsWith("INSERT"))
  ).toHaveLength(1);
  expect(
    profileStatements.filter((statement) => statement.startsWith("SELECT"))
  ).toHaveLength(0);
});
