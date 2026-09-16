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

const INSERT_STATEMENT = /^INSERT\b/;

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

/**
 * The fault cut: the provider answers a row whose `id` is not an integer.
 *
 * Stated over ANY row-bearing response on ANY transport, not over `^SELECT`
 * only and not over the batch entry only, because both the statement that
 * carries the stored row and the transport that carries that statement are
 * physical choices, not properties of this specimen. A scalar-only root
 * `create` folds to one `INSERT … RETURNING` — which is what the shipped engine
 * emits for this exact request — and since Arnaud's D-7 decision that lone
 * statement leaves the batch and runs on the plain execute path, so a
 * `^SELECT`-only or `executeBatch`-only cut would be ELIMINATED by the fold and
 * this specimen would silently stop witnessing (raptor3 plan §5.4: an
 * eliminated cut cannot waive the property's acceptance). The property is
 * unchanged: a malformed provider result is translated into the established
 * identity, with truthful progress, and nothing is published. The SPLIT forms
 * of the same specimen — a provider without RETURNING, on a transaction and on
 * a segment-atomic transport, and a relation-bearing create — are checked at
 * `tests/raptor3/g4/unit02/malformed-result-cuts.test.ts`, and the PROGRESS
 * half that a one-statement write no longer has (a set mutation of two
 * statements whose committed window then answers a malformed row) at
 * `tests/raptor3/g4/unit02/lone-statement-transport.test.ts`.
 */
function corruptSelectedId<T>(
  _sqlText: string,
  response: QueryResult<T>
): boolean {
  if (response.rows.length === 0) return false;
  let corrupted = false;
  for (const row of response.rows) {
    if (!isRecord(row)) continue;
    Reflect.set(row, "id", "not-an-integer");
    corrupted = true;
  }
  return corrupted;
}

/**
 * Observes every statement and applies the cut where the statement runs. The
 * driver's own batch entry dispatches each query through this same method, so
 * one override covers both transports.
 */
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
    if (INSERT_STATEMENT.test(statement)) this.insertDispatches++;
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
    if (queries.some(({ sql }) => INSERT_STATEMENT.test(sql))) {
      this.acknowledgedInsertBatches++;
    }
    return responses;
  }
}

function createDriver(
  profile: Profile,
  database: Database.Database
): ObservingSQLiteDriver {
  return profile === "sqlite-interactive"
    ? new ObservingSQLiteDriver({ client: database })
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
  operation: "create" | "createMany",
  progress: object | undefined,
  diagnostic: string
): void {
  assert(failure instanceof QueryEngineError, diagnostic);
  assert.equal(failure.code, VibORMErrorCode.INTERNAL_ERROR, diagnostic);
  assert.equal(
    failure.message,
    `Driver "sqlite3" returned a malformed int scalar for operation "${operation}": the value is not a canonical integer.`,
    diagnostic
  );
  assert.deepEqual(
    { ...failure.meta },
    {
      driver: "sqlite3",
      operation,
      scalarType: "int",
      ...(progress ? { recordSeriesProgress: progress } : {}),
    },
    diagnostic
  );
}

const entity = s
  .model({ id: s.int().id(), label: s.string() })
  .map("g29_invalid_result");
const schema = { entity };

async function withWorld<T>(
  driver: ObservingSQLiteDriver,
  database: Database.Database,
  drive: () => Promise<T>
): Promise<T> {
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  try {
    driver.resetAndArm();
    return await drive();
  } finally {
    await client.$disconnect();
    database.close();
  }
}

/**
 * A root single-record write is ONE statement on both profiles, so it carries
 * no record series at all: the truthful answer is the shipped one — the
 * malformed-scalar refusal with nothing but `{driver, operation, scalarType}`
 * (`write-engine/OperationExecutor.ts` `runBorrowedStatementAtomic`, which
 * rethrows the decoding failure raw).
 */
async function runMalformedResult(profile: Profile): Promise<void> {
  const database = new Database(":memory:");
  const driver = createDriver(profile, database);
  await withWorld(driver, database, async () => {
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
    assertMalformedResultFailure(failure, "create", undefined, diagnostic);
    if (driver instanceof CorruptingBatchSQLiteDriver) {
      // D-7 (Arnaud, 2026-09-15): a set statement that is the operation's ONLY
      // statement needs no batch envelope, so the folded root `create` never
      // reaches `_executeBatch` — the shipped transport rule, and the reason
      // this operation now answers the shipped meta exactly.
      assert.equal(driver.acknowledgedInsertBatches, 0, diagnostic);
    }
    // The row is durable on BOTH profiles now: a statement-atomic write commits
    // with its own statement and the failure happens afterwards, while decoding
    // what the provider already returned. The shipped engine leaves the same
    // state for the same request (`runStatementAtomic`, no transaction) —
    // measured in `g4/unit02/receipts/phase2/shipped-malformed-result.log`. The
    // rolled-back form of this cut is cell 1 of the split specimen named above.
    assert.deepEqual(finalDatabase, [{ id: 1, label: "written" }], diagnostic);
  });
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
