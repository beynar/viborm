/**
 * pg Driver Tests - the races of the `deletion` and `rows` capabilities that
 * need two real connections (extension-capabilities plan v3.1 §2.3 DC14, v2
 * §4.5 consumer 3). SQLite and PGlite cannot run them: one connection, and
 * an injected write rolls back with the operation's own region.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PgDriver } from "@drivers/pg";
import {
  type BeforeStatement,
  runDeletionRaceBehavior,
} from "@tests/contracts/engine/write/deletion-race-behavior";
import type { Pool, PoolClient } from "pg";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

/** A pg driver that awaits `beforeStatement` before each statement. */
class PausingPgDriver extends PgDriver {
  private readonly beforeStatement: BeforeStatement;

  constructor(beforeStatement: BeforeStatement) {
    super({ databaseUrl: TEST_CONNECTION_STRING });
    this.beforeStatement = beforeStatement;
  }

  protected override async execute<T>(
    client: Pool | PoolClient,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    await this.beforeStatement(sql);
    return super.execute<T>(client, sql, params, context);
  }
}

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  beforeEach(dropEveryLiveTable);

  runDeletionRaceBehavior({
    name: "pg",
    createDriver: (beforeStatement) => new PausingPgDriver(beforeStatement),
  });
});
