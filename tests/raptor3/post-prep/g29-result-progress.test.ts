import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError, VibORMErrorCode } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

type Profile = "sqlite-interactive" | "sqlite-atomic-batch";

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

function corruptSelectedId<T>(
  sqlText: string,
  response: QueryResult<T>
): boolean {
  if (!/^SELECT\b/.test(sqlText) || response.rows.length === 0) return false;
  let corrupted = false;
  for (const row of response.rows) {
    if (!isRecord(row)) continue;
    Reflect.set(row, "id", "not-an-integer");
    corrupted = true;
  }
  return corrupted;
}

class ObservingSQLiteDriver extends SQLite3Driver {
  readonly statements: StatementObservation[] = [];
  insertDispatches = 0;
  corrupted = false;
  protected corruptionArmed = false;

  resetAndArm(): void {
    this.statements.length = 0;
    this.insertDispatches = 0;
    this.corrupted = false;
    this.corruptionArmed = true;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, parameters, context });
    const response = await super.execute<T>(client, statement, parameters);
    if (/^INSERT\b/.test(statement)) this.insertDispatches++;
    return response;
  }
}

class CorruptingInteractiveSQLiteDriver extends ObservingSQLiteDriver {
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const response = await super.execute<T>(
      client,
      statement,
      parameters,
      context
    );
    if (this.corruptionArmed && corruptSelectedId(statement, response)) {
      this.corrupted = true;
    }
    return response;
  }
}

class CorruptingBatchSQLiteDriver extends ObservingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  acknowledgedInsertBatches = 0;

  override resetAndArm(): void {
    super.resetAndArm();
    this.acknowledgedInsertBatches = 0;
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const responses = await this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
    if (queries.some(({ sql }) => /^INSERT\b/.test(sql))) {
      this.acknowledgedInsertBatches++;
    }
    if (this.corruptionArmed) {
      for (const [index, query] of queries.entries()) {
        const response = responses[index];
        assert(response);
        if (corruptSelectedId(query.sql, response)) this.corrupted = true;
      }
    }
    return responses;
  }
}

function createDriver(
  profile: Profile,
  database: Database.Database
): ObservingSQLiteDriver {
  return profile === "sqlite-interactive"
    ? new CorruptingInteractiveSQLiteDriver({ client: database })
    : new CorruptingBatchSQLiteDriver({ client: database });
}

function failureObservation(failure: unknown): object {
  if (failure instanceof QueryEngineError) {
    return {
      name: failure.name,
      code: failure.code,
      message: failure.message,
      meta: failure.meta,
    };
  }
  if (failure instanceof Error) {
    return { name: failure.name, message: failure.message };
  }
  return { thrown: String(failure) };
}

function assertMalformedResultFailure(
  failure: unknown,
  profile: Profile,
  diagnostic: string
): void {
  assert(failure instanceof QueryEngineError, diagnostic);
  assert.equal(failure.code, VibORMErrorCode.INTERNAL_ERROR, diagnostic);
  assert.equal(
    failure.message,
    'Driver "sqlite3" returned a malformed int scalar for operation "create": the value is not a canonical integer.',
    diagnostic
  );
  assert.deepEqual(
    { ...failure.meta },
    {
      driver: "sqlite3",
      operation: "create",
      scalarType: "int",
      ...(profile === "sqlite-atomic-batch"
        ? {
            recordSeriesProgress: {
              atomicity: "segment",
              phase: "result",
              committedSegments: 1,
              committedWriteMembers: 1,
              completedMembers: 0,
            },
          }
        : {}),
    },
    diagnostic
  );
}

async function runMalformedResult(profile: Profile): Promise<void> {
  const database = new Database(":memory:");
  const driver = createDriver(profile, database);
  const entity = s
    .model({ id: s.int().id(), label: s.string() })
    .map("g29_invalid_result");
  const schema = { entity };
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);

  try {
    driver.resetAndArm();
    let value: unknown;
    let failure: unknown;
    try {
      value = await createCommandEngine({ schema, driver }).execute(
        "entity",
        "create",
        { data: { id: 1, label: "written" } }
      );
    } catch (caught) {
      failure = caught;
    }

    const finalDatabase = database
      .prepare("SELECT id,label FROM g29_invalid_result ORDER BY id")
      .all();
    const diagnostic = JSON.stringify(
      {
        profile,
        engine: "commands",
        insertDispatches: driver.insertDispatches,
        acknowledgedInsertBatches:
          driver instanceof CorruptingBatchSQLiteDriver
            ? driver.acknowledgedInsertBatches
            : undefined,
        corrupted: driver.corrupted,
        finalDatabase,
        value,
        failure: failureObservation(failure),
      },
      undefined,
      2
    );

    assert.equal(value, undefined, diagnostic);
    assert.equal(driver.corrupted, true, diagnostic);
    assert.equal(driver.insertDispatches, 1, diagnostic);
    assertMalformedResultFailure(failure, profile, diagnostic);
    if (driver instanceof CorruptingBatchSQLiteDriver) {
      assert.equal(driver.acknowledgedInsertBatches, 1, diagnostic);
    }
    assert.deepEqual(
      finalDatabase,
      profile === "sqlite-atomic-batch" ? [{ id: 1, label: "written" }] : [],
      diagnostic
    );
  } finally {
    await client.$disconnect();
    database.close();
  }
}

const profiles: readonly Profile[] = [
  "sqlite-interactive",
  "sqlite-atomic-batch",
];

for (const profile of profiles) {
  describe(`G2.9 result progress [commands] (${profile})`, () => {
    it("preserves malformed-result translation with truthful progress", async () => {
      await runMalformedResult(profile);
    });
  });
}
