/**
 * SQL Server: the races of the `deletion` and `rows` capabilities that need
 * two real connections, under SQL Server's locking READ COMMITTED. The
 * shared suite; set MSSQL_TEST_CONNECTION_STRING to run.
 */

import type { QueryExecutionContext, QueryResult } from "@drivers";
import { MssqlDriver } from "@drivers/mssql";
import {
  type BeforeStatement,
  runDeletionRaceBehavior,
} from "@tests/contracts/engine/write/deletion-race-behavior";
import type { ConnectionPool, Transaction } from "mssql";
import { afterAll, beforeEach, describe } from "vitest";
import {
  dropEveryLiveTable,
  SQL_SERVER,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

/** A SQL Server driver that awaits `beforeStatement` before each statement. */
class PausingMssqlDriver extends MssqlDriver {
  private readonly beforeStatement: BeforeStatement;

  constructor(beforeStatement: BeforeStatement) {
    super({ databaseUrl: TEST_CONNECTION_STRING });
    this.beforeStatement = beforeStatement;
  }

  protected override async execute<T>(
    client: ConnectionPool | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    await this.beforeStatement(sql);
    return super.execute<T>(client, sql, params, context);
  }
}

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("SQL Server Driver", () => {
  beforeEach(dropEveryLiveTable);
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  runDeletionRaceBehavior({
    name: SQL_SERVER,
    createDriver: (beforeStatement) => new PausingMssqlDriver(beforeStatement),
  });
});
