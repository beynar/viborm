/**
 * G4-02 author checks — one recording world.
 *
 * The world is deliberately small and self-contained: the witness estate under
 * `tests/raptor3/g4/` belongs to the independent witness author, and these files
 * are the unit's own checks on the physical envelope, the prepared-operation
 * boundary and root `delete`.
 */

import { createClient } from "@client/client";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";

export interface Statement {
  readonly sql: string;
  readonly context?: QueryExecutionContext;
}

/** Records the physical statements and the transaction control an operation costs. */
export class RecordingSQLiteDriver extends SQLite3Driver {
  readonly statements: Statement[] = [];
  readonly control: string[] = [];
  transactionCalls = 0;
  batchCalls = 0;
  /** Mutable so a check can lower it and split one grouped statement into chunks. */
  override maxBindParametersPerStatement: number | undefined = 999;

  reset(): void {
    this.statements.length = 0;
    this.control.length = 0;
    this.transactionCalls = 0;
    this.batchCalls = 0;
  }

  /** Provider round trips: one per statement outside a batch, one per batch. */
  get roundTrips(): number {
    return this.statements.length - this.batchedStatements + this.batchCalls;
  }
  private batchedStatements = 0;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, context });
    return super.execute<T>(client, statement, parameters);
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    this.batchCalls++;
    this.batchedStatements += queries.length;
    for (const query of queries)
      this.statements.push({ sql: query.sql, context: query.context });
    return super.executeBatch<T>(client, queries, context);
  }

  protected override async executeRaw<T>(
    client: Database.Database,
    statement: string,
    parameters?: unknown[]
  ): Promise<QueryResult<T>> {
    this.control.push(statement);
    return super.executeRaw<T>(client, statement, parameters);
  }

  protected override async transaction<T>(
    client: Database.Database,
    body: (transaction: Database.Database) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    this.transactionCalls++;
    return super.transaction(client, body, context);
  }
}

export const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    age: s.int(),
    avatar: s.blob().nullable(),
    posts: s.toMany(() => post),
  })
  .map("g4u2_authors");

export const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    rank: s.int(),
    authorId: s.int().nullable(),
    author: s.toOne(() => author).fields("authorId").references("id"),
  })
  .map("g4u2_posts");

export const worldSchema = { author, post };
export type WorldSchema = typeof worldSchema;

function buildClient(driver: RecordingSQLiteDriver) {
  return createClient({ schema: worldSchema, driver });
}

export interface World {
  readonly database: Database.Database;
  readonly driver: RecordingSQLiteDriver;
  readonly client: ReturnType<typeof buildClient>;
  close(): Promise<void>;
}

export async function createWorld(
  options: { readonly maxBindParameters?: number } = {}
): Promise<World> {
  const database = new Database(":memory:");
  const driver = new RecordingSQLiteDriver({ client: database });
  if (options.maxBindParameters !== undefined)
    driver.maxBindParametersPerStatement = options.maxBindParameters;
  const client = buildClient(driver);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("world schema did not apply");
  await client.author.createMany({
    data: [
      { id: 1, name: "Ada", age: 36 },
      { id: 2, name: "Bo", age: 41 },
    ],
  });
  await client.post.createMany({
    data: [
      { id: 10, title: "first", rank: 1, authorId: 1 },
      { id: 11, title: "second", rank: 2, authorId: 1 },
      { id: 12, title: "third", rank: 3, authorId: 2 },
    ],
  });
  driver.reset();
  return {
    database,
    driver,
    client,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

/** The physical cost of one operation: statements, round trips, envelope. */
export function cost(driver: RecordingSQLiteDriver) {
  return {
    statements: driver.statements.length,
    transactions: driver.transactionCalls,
    control: driver.control.filter((statement) =>
      /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(statement)
    ).length,
  };
}
