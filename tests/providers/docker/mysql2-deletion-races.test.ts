/**
 * MySQL2 Driver Tests - the races of the `deletion` and `rows` capabilities
 * that need two real connections (extension-capabilities plan v3.1 §2.3
 * DC14, v2 §4.5 consumer 3), under InnoDB's REPEATABLE READ.
 *
 * NOTE: These tests require a running MySQL database.
 */

import type { QueryExecutionContext, QueryResult } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import {
  type BeforeStatement,
  runDeletionRaceBehavior,
} from "@tests/contracts/engine/write/deletion-race-behavior";
import type { Pool, PoolConnection } from "mysql2/promise";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

/** A mysql2 driver that awaits `beforeStatement` before each statement. */
class PausingMySQL2Driver extends MySQL2Driver {
  private readonly beforeStatement: BeforeStatement;

  constructor(beforeStatement: BeforeStatement) {
    super({
      databaseUrl: TEST_CONNECTION_STRING,
      migrationNamespaceAttestation: "non-redirecting",
    });
    this.beforeStatement = beforeStatement;
  }

  protected override async execute<T>(
    client: Pool | PoolConnection,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    await this.beforeStatement(sql);
    return super.execute<T>(client, sql, params, context);
  }
}

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 Driver", () => {
  beforeEach(dropEveryLiveTable);
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  runDeletionRaceBehavior({
    name: "MySQL2",
    createDriver: (beforeStatement) => new PausingMySQL2Driver(beforeStatement),
  });
});
