/**
 * Test-only live schema sync. Production callers use push() with consent.
 * Additive empty-database setup does not need consent.
 */

import {
  addDropResolver,
  createMigrationClient,
} from "@migrations/dialects/all";
import type { MigrationClient } from "@migrations/push/planner";
import type { ResolveCallback } from "@migrations/types";
import { pushMssqlSchema } from "@tests/fixtures/mssql-schema";

interface SyncLiveSchemaOptions {
  readonly tables?: readonly string[];
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly forceReset?: boolean;
  readonly resolve?: ResolveCallback;
  readonly skipValidation?: boolean;
}

export async function syncLiveSchema(
  client: MigrationClient,
  options: SyncLiveSchemaOptions = {}
) {
  // VibORM writes no DDL for SQL Server; a test-only T-SQL stand-in does.
  if (client.$driver.dialect === "mssql")
    return pushMssqlSchema(client, options);
  if (client.$driver.dialect === "surrealql") {
    await import("@migrations/dialects/surrealql");
    await (client.$driver as unknown as { fresh(): Promise<void> }).fresh();
  }
  const resolve: ResolveCallback | undefined = options.force
    ? async (change) =>
        (await options.resolve?.(change)) ?? addDropResolver(change)
    : options.resolve;
  const migrations =
    options.tables === undefined
      ? createMigrationClient(client)
      : createMigrationClient(client, { tables: options.tables });
  const preview = await migrations.push({
    dryRun: true,
    forceReset: options.forceReset,
    resolve,
    skipValidation: options.skipValidation,
  });
  const outcome = options.dryRun
    ? preview
    : await migrations.push({ consent: preview.consent });
  return {
    ...outcome,
    applied: outcome.outcome === "applied",
    operations: outcome.operations.map((operation) => ({
      ...operation,
      type: operation.id.slice(0, operation.id.indexOf(":")),
    })),
    sql: outcome.statements.map((statement) => statement.sql),
  };
}
