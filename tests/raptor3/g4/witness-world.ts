/**
 * Independent G4 witness world.
 *
 * Every expected value in a `read-*.test.ts` witness is hand-computed from the
 * rows the witness seeds with raw SQL. This module only supplies the two
 * producers that must agree with that hand value: the shipped client and the
 * private candidate, both bound to the *same* `better-sqlite3` database and the
 * same driver instance. Nothing here derives an expectation from either engine.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { Operations } from "@client/types";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import type { Schema } from "@schema/hydration";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";

export interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

/** Records every physical statement so round-trip counts can be witnessed. */
export class WitnessSQLiteDriver extends SQLite3Driver {
  readonly statements: StatementObservation[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, parameters: [...parameters], context });
    return super.execute<T>(client, statement, parameters);
  }
}

type ModelOperations = Record<
  string,
  Record<string, (args?: unknown) => Promise<unknown>>
>;

export interface WitnessWorld {
  readonly database: Database.Database;
  readonly driver: WitnessSQLiteDriver;
  readonly shipped: ModelOperations;
  readonly candidate: ReturnType<typeof createCommandEngine>;
  /** Physical statements recorded since the last `reset()`. */
  readonly statements: StatementObservation[];
  reset(): void;
  close(): Promise<void>;
}

export interface WitnessWorldOptions {
  /** Raw SQL seeding. Never a write through either engine. */
  readonly seed?: (database: Database.Database) => void;
  /** Extra DDL applied after the migration (checked carriers, etc.). */
  readonly afterMigration?: (database: Database.Database) => void;
  readonly foreignKeys?: boolean;
}

export async function createWitnessWorld(
  schema: Schema,
  options: WitnessWorldOptions = {}
): Promise<WitnessWorld> {
  const database = new Database(":memory:");
  if (options.foreignKeys === false) database.pragma("foreign_keys = OFF");
  const driver = new WitnessSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true, "The witness schema did not migrate");
  options.afterMigration?.(database);
  options.seed?.(database);
  const candidate = createCommandEngine({ schema, driver });
  driver.statements.length = 0;
  return {
    database,
    driver,
    shipped: client as unknown as ModelOperations,
    candidate,
    statements: driver.statements,
    reset() {
      driver.statements.length = 0;
    },
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

function describeRequest(model: string, operation: string): string {
  return `${model}.${operation}`;
}

/**
 * Runs one read three ways: the hand-computed value is the authority, the
 * shipped engine is the differential oracle, and the candidate is the subject.
 * A shipped/hand disagreement is a *disputed row* and fails before the
 * candidate is consulted, so a candidate defect can never be masked by a
 * re-baselined expectation.
 */
export async function expectRead(
  world: WitnessWorld,
  model: string,
  operation: string,
  args: unknown,
  expected: unknown
): Promise<void> {
  const request = describeRequest(model, operation);
  const shipped = await world.shipped[model]?.[operation]?.(args);
  assert.deepStrictEqual(
    shipped,
    expected,
    `Disputed row: the shipped engine disagrees with the hand-computed value for ${request}`
  );
  const candidate = await world.candidate.execute(model, operation as Operations, args);
  assert.deepStrictEqual(
    candidate,
    expected,
    `The candidate disagrees with the hand-computed value for ${request}`
  );
}

export interface FailureObservation {
  readonly name: string;
  readonly message: string;
  readonly constructorName: string;
}

export async function observeFailure(
  invoke: () => Promise<unknown>
): Promise<FailureObservation> {
  try {
    await invoke();
  } catch (failure) {
    assert.ok(failure instanceof Error, "A refusal must be an Error");
    return {
      name: failure.name,
      message: failure.message,
      constructorName: failure.constructor.name,
    };
  }
  return assert.fail("The required refusal did not fire");
}

/**
 * Both engines must refuse the same shape with the same error identity. The
 * error class and name are compared exactly; the message is matched, because
 * message wording is not a frozen contract while the identity is.
 */
export async function expectRefusal(
  world: WitnessWorld,
  model: string,
  operation: string,
  args: unknown,
  expected: { readonly name: string; readonly message: RegExp }
): Promise<FailureObservation> {
  const request = describeRequest(model, operation);
  const shipped = await observeFailure(() =>
    Promise.resolve(world.shipped[model]?.[operation]?.(args))
  );
  assert.equal(
    shipped.name,
    expected.name,
    `Disputed refusal: the shipped engine raised ${shipped.name} for ${request}`
  );
  assert.match(shipped.message, expected.message);
  const candidate = await observeFailure(() =>
    world.candidate.execute(model, operation as Operations, args)
  );
  assert.equal(
    candidate.name,
    expected.name,
    `The candidate raised ${candidate.name} (${candidate.message}) instead of ${expected.name} for ${request}`
  );
  assert.match(candidate.message, expected.message);
  return candidate;
}

export function rowsOf(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "The public result is not an array");
  const rows: Record<string, unknown>[] = [];
  for (const row of value) {
    assert.ok(
      row !== null && typeof row === "object" && !Array.isArray(row),
      "The public result contains a non-row member"
    );
    rows.push(row as Record<string, unknown>);
  }
  return rows;
}
