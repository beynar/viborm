/**
 * Push Workflow
 *
 * Orchestrates the database schema push operation:
 * 1. Optionally reset database state
 * 2. Plan schema changes
 * 3. Generate DDL statements
 * 4. Execute DDL statements
 */

import { validateSchemaOrThrow } from "../../schema/validation";
import type { DiffOperation, PushResult, Resolver } from "../types";
import { executeDDLStatements, generateDDLStatements } from "./executor";
import { formatOperation, formatOperations } from "./format";
import {
  getPushMigrationDriver,
  introspect,
  type MigrationClient,
  type PushOptions,
  planPush,
} from "./planner";
import { resetDatabase } from "./reset";

export type { PushResult } from "../types";
export type { MigrationClient, PushOptions } from "./planner";
export { formatOperation, formatOperations, introspect };

/**
 * Pushes schema changes directly to the database.
 *
 * @param client - VibORM client containing driver and schema
 * @param options - Push options
 * @returns Push result with operations and SQL statements
 */
export async function push(
  client: MigrationClient,
  options: PushOptions = {}
): Promise<PushResult> {
  const dryRun = options.dryRun ?? false;
  // The CLI validates before push; programmatic callers must not skip it —
  // invalid schemas (e.g. colliding junction tables) corrupt data silently.
  if (!options.skipValidation) {
    validateSchemaOrThrow(client.$schema);
  }
  const migrationDriver = getPushMigrationDriver(client);

  if (options.forceReset && !dryRun) {
    await resetDatabase(
      client.$driver,
      migrationDriver,
      options._storageDriver
    );
  }

  const plan = await planPush(client, migrationDriver, options);
  const sql = generateDDLStatements(
    plan.operations,
    migrationDriver,
    plan.currentSchema
  );

  if (!dryRun) {
    await executeDDLStatements(client.$driver, migrationDriver, sql);
  }

  return {
    operations: plan.operations,
    applied: !dryRun && sql.length > 0,
    sql,
  };
}

/**
 * Generates DDL statements for transforming current schema to desired schema
 * without executing them. Useful for generating migration files.
 */
export async function generateDDL(
  client: MigrationClient,
  options: { resolver?: Resolver } = {}
): Promise<{ operations: DiffOperation[]; sql: string[] }> {
  const result = await push(client, {
    ...options,
    dryRun: true,
    force: true,
  });

  return {
    operations: result.operations,
    sql: result.sql,
  };
}
