/**
 * Test-only live schema sync. Production callers use push() with consent.
 * Additive empty-database setup does not need consent.
 */

import { addDropResolver, createMigrationClient } from "@migrations";
import type { MigrationClient } from "@migrations/push/planner";
import type { ResolveCallback } from "@migrations/types";

interface SyncLiveSchemaOptions {
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
  const resolve: ResolveCallback | undefined = options.force
    ? async (change) =>
        (await options.resolve?.(change)) ?? addDropResolver(change)
    : options.resolve;
  const migrations = createMigrationClient(client);
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
      type: operation.label,
    })),
    sql: outcome.statements.map((statement) => statement.sql),
  };
}
