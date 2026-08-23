/**
 * Push Workflow
 *
 * Orchestrates the database schema push operation:
 * 1. Optionally reset database state
 * 2. Plan schema changes
 * 3. Generate DDL statements
 * 4. Execute DDL statements
 */

import { hydrateSchemaNames } from "../../schema/hydration";
import {
  resolveSchemaOrThrow,
  validateSchemaOrThrow,
} from "../../schema/validation";
import type { DiffOperation, PushResult, ResolveCallback } from "../types";
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
 * The unknown keys of a proposed push options bag.
 *
 * `push` is the one migration entry point where a silently-ignored key destroys
 * data: `dryRnu` executes the DDL the caller meant to preview, `forceRest`
 * skips the drop they asked for, `skipValidaton` runs a schema the validator
 * would have refused. A FRESH literal was already refused by excess-property
 * checking; a bag held in a variable — `const opts = { dryRun: ci }` reused
 * across two pushes — was not, and EPC is the only thing that was watching.
 * Demanding `never` for the unknown keys refuses regardless of freshness. Same
 * instrument as the model builder's `ExactOptions` and the client config's
 * `NoExtraConfigKeys`.
 */
type ExactPushOptions<O> = O &
  Record<Exclude<keyof O, keyof PushOptions>, never>;

/**
 * Pushes schema changes directly to the database.
 *
 * @param client - VibORM client containing driver and schema
 * @param options - Push options
 * @returns Push result with operations and SQL statements
 */
export async function push<O extends PushOptions = PushOptions>(
  client: MigrationClient,
  options: ExactPushOptions<O> = {} as ExactPushOptions<O>
): Promise<PushResult> {
  const dryRun = options.dryRun ?? false;
  // The two ordered phases of the definition pipeline (§6.1), at this boundary
  // as at every other. Hydration is idempotent for an already-bound key, and it
  // is where model-object identity is proved — before an index, a diff or a
  // DDL statement exists.
  hydrateSchemaNames(client.$schema);
  // `skipValidation` drops the ADVICE — the spelling rules a caller may
  // legitimately disagree with. It cannot drop the structural
  // relation-definition gate (plan §7.3): no DDL may be generated from a
  // topology nothing proved, so an unresolvable schema fails here whichever
  // option was passed.
  // ONE resolution for this push, handed on by identity: the planner's
  // serializer reads this exact index rather than resolving again (§10E.6).
  const relations = options.skipValidation
    ? resolveSchemaOrThrow(client.$schema)
    : validateSchemaOrThrow(client.$schema);
  const migrationDriver = getPushMigrationDriver(client);

  if (options.forceReset && !dryRun) {
    await resetDatabase(
      client.$driver,
      migrationDriver,
      options._storageDriver
    );
  }

  const plan = await planPush(client, migrationDriver, options, relations);
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
 *
 * The option is `resolve`, not `resolver`. It used to be `resolver`, and
 * `resolver` was a key nothing read: this function forwards its options to
 * `push`, and `PushOptions` calls the callback `resolve`. So a caller who passed
 * `generateDDL(client, { resolver })` got the DEFAULT resolution for every
 * ambiguous change and no indication their resolver had been dropped. The
 * mismatch survived because `push` took a plain `PushOptions` parameter, where
 * only excess-property checking was watching and a spread argument is not fresh;
 * `ExactPushOptions` refuses it structurally and turned it into a compile error.
 */
export async function generateDDL(
  client: MigrationClient,
  options: { resolve?: ResolveCallback } = {}
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
