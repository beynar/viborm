import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MssqlAdapter } from "@adapters/databases/mssql/mssql-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver, type QueryResult } from "@drivers";
import {
  type QueryExecutionContext,
  TransactionBoundDriver,
} from "@drivers/driver";
import type { Sql } from "@sql";

/** `@p1`, `@p2`, …: T-SQL's named parameters, as `viborm/mssql` sends them. */
const numbered = (query: Sql): string => {
  const [first, ...rest] = query.strings;
  return rest.reduce(
    (text, part, index) => `${text}@p${index + 1}${part}`,
    first!
  );
};

/** A scripted SQL Server transaction, numbering its parameters the same way. */
class ScriptedMssqlTransaction extends TransactionBoundDriver<object, object> {
  protected override buildStatement(query: Sql): string {
    return numbered(query);
  }
}

export type ScriptedDialect = "mssql" | "mysql" | "postgresql" | "sqlite";

/** One statement the client sent: its text and its parameters. */
export interface SentStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** The rows a statement answers, chosen by the test from what was sent. */
export type Script = (
  statement: SentStatement,
  sent: readonly SentStatement[]
) =>
  | readonly object[]
  | { readonly rows: readonly object[]; readonly rowCount: number };

/**
 * A driver that sends nothing: it records every statement the client builds
 * for its dialect, and answers each with the rows the test's script gives.
 * What the statements do on a real database is the live lanes' to prove;
 * what this pins is the text and the parameters a database receives.
 */
export class ScriptedDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter;
  readonly sent: SentStatement[] = [];
  readonly #script: Script;

  constructor(dialect: ScriptedDialect, script: Script = () => []) {
    super(dialect, `scripted-${dialect}`);
    this.adapter =
      dialect === "postgresql"
        ? new PostgresAdapter()
        : dialect === "mysql"
          ? new MySQLAdapter()
          : dialect === "mssql"
            ? new MssqlAdapter()
            : new SQLiteAdapter();
    this.#script = script;
    this.client = {};
  }

  protected override buildStatement(query: Sql): string {
    return this.dialect === "mssql"
      ? numbered(query)
      : super.buildStatement(query);
  }

  protected override createTransactionBoundDriver(
    tx: object,
    context: QueryExecutionContext
  ): TransactionBoundDriver<object, object> {
    return this.dialect === "mssql"
      ? new ScriptedMssqlTransaction(this, tx, context)
      : super.createTransactionBoundDriver(tx, context);
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // This fixture owns no provider resource.
  }

  protected async execute<T>(
    _client: object,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const statement = { sql, params: [...params] };
    this.sent.push(statement);
    const answer = this.#script(statement, this.sent);
    const rows = ("rows" in answer ? answer.rows : answer) as T[];
    return {
      rows: [...rows],
      rowCount: "rowCount" in answer ? answer.rowCount : rows.length,
    };
  }

  protected executeRaw<T>(
    client: object,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, sql, params ?? []);
  }

  protected transaction<T>(
    client: object,
    run: (transaction: object) => Promise<T>
  ): Promise<T> {
    return run(client);
  }
}
