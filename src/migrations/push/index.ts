/**
 * Push Workflow
 *
 * Orchestrates the database schema push operation:
 * 1. Optionally reset database state
 * 2. Plan schema changes
 * 3. Generate DDL statements
 * 4. Execute DDL statements
 */

import type { AnyDriver } from "../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../errors";
import { hydrateSchemaNames } from "../../schema/hydration";
import {
  resolveSchemaOrThrow,
  validateSchemaOrThrow,
} from "../../schema/validation";
import type { ResolvedRelationIndex } from "../../schema/validation/relation-resolution";
import { admitLiveMigrationCapability } from "../admission";
import type { BoundMigrationDriver } from "../drivers";
import {
  resolveCommandDriver,
  runSequentialProgram,
  withLockedMigrationProducer,
} from "../pinned-session";
import { assertMigrationDecimalDomainsFitProvider } from "../serializer";
import { needsEnumAdditionCommitBoundary } from "../statement-safety";
import type { DiffOperation, PushResult, ResolveCallback } from "../types";
import { DEFAULT_TABLE_NAME } from "../utils";
import { executeDDLStatements, generateDDLStatements } from "./executor";
import {
  getPushMigrationDriver,
  type MigrationClient,
  type PushOptions,
  planPush,
  planRebuildFromEmpty,
} from "./planner";
import { planResetDatabase, resetDatabase } from "./reset";

export type { PushResult } from "../types";
export { formatOperation, formatOperations } from "./format";
export type { MigrationClient, PushOptions } from "./planner";
export { introspect } from "./planner";

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
  return runPush(client, options, DEFAULT_TABLE_NAME);
}

/**
 * `push()` with the tracking-table name the invoking migration client declared.
 *
 * INTERNAL: not exported from `viborm/migrations`. `createMigrationClient()`
 * already owns the configured name, and force-reset has to clear that exact
 * table's rows before destructive DDL rather than guessing which inventoried
 * table is special. Only the normalized PRIMITIVE travels — no push option, no
 * migration storage, no journal access (§6.2).
 */
export async function pushWithDeclaredTrackingTable(
  client: MigrationClient,
  options: PushOptions,
  trackingTableName: string
): Promise<PushResult> {
  return runPush(client, options, trackingTableName);
}

async function runPush(
  client: MigrationClient,
  options: PushOptions,
  trackingTableName: string
): Promise<PushResult> {
  const dryRun = options.dryRun ?? false;
  // The two ordered phases of the definition pipeline (§6.1), at this boundary
  // as at every other. Hydration is idempotent for an already-bound key, and it
  // is where model-object identity is proved — before an index, a diff or a
  // DDL statement exists.
  hydrateSchemaNames(client.$schema);
  assertMigrationDecimalDomainsFitProvider(
    client.$schema,
    client.$driver.dialect
  );
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
  // Binding resolves this client's estate target; a PostgreSQL driver whose
  // adapter proves no schema is refused here, before any provider call.
  const migrationDriver = getPushMigrationDriver(client);

  // Push has no journal, so there is no pre-admission probe to take: it gates
  // immediately. Non-dry push and force-reset are effectful; a dry run still
  // introspects live state, so it is admitted as a read-only live command.
  admitLiveMigrationCapability(
    migrationDriver,
    dryRun ? "read-only" : "effectful",
    options.forceReset ? "push({ forceReset: true })" : "push()"
  );

  // A dry run reads live state but changes nothing, so it stays outside the
  // session lock exactly as `status`/`pending` do: it is a point-in-time read,
  // not a concurrency-stable decision. Taking no lock does not make it a
  // different estate: it resolves the SAME command view through the same owner,
  // and both its introspection and the SQL it hands back render from that one
  // view. Rendering the returned SQL from the original bound driver is what
  // made a case-folded MySQL preview quote a database the server does not have.
  if (dryRun) {
    const command = await resolveCommandDriver(client.$driver, migrationDriver);
    const plan = await planPush(client, command, options, relations);
    return {
      operations: plan.operations,
      applied: false,
      sql: generateDDLStatements(plan.operations, command, plan.currentSchema),
    };
  }

  if (options.forceReset) {
    return forceResetPush(client, migrationDriver, options, relations, {
      trackingTableName,
    });
  }

  // Everything that reads live state and everything that changes it runs on ONE
  // pinned producer holding this estate's lock: the introspection the plan is
  // diffed against and the DDL itself. Another VibORM migration command cannot
  // interleave between them.
  return withLockedMigrationProducer(
    client.$driver,
    migrationDriver,
    async (pinned, command) => {
      const plan = await planPush(
        { $driver: pinned, $schema: client.$schema },
        command,
        options,
        relations
      );
      const sql = generateDDLStatements(
        plan.operations,
        command,
        plan.currentSchema
      );

      // MySQL commits DDL as each statement runs, so the DDL is ONE sequential
      // program and a failure part-way through reports the boundary it reached
      // instead of a rollback that did not happen. Every other dialect keeps
      // the real transaction its executor opens.
      await (command.target.dialect === "mysql"
        ? runSequentialProgram(pinned, command, (producer) =>
            executeDDLStatements(producer, command, sql)
          )
        : executeDDLStatements(pinned, command, sql));

      return {
        operations: plan.operations,
        applied: sql.length > 0,
        sql,
      };
    }
  );
}

/**
 * Clear-and-rebuild for `push({ forceReset: true })`.
 *
 * The whole program is compiled and proven free of a commit-boundary
 * statement UNDER THE LOCK, BEFORE THE CLEAR (§6.2), so nothing that could
 * fail on the way in is discovered after the namespace has been emptied —
 * and the rendered statements carry the session's resolved catalog spelling.
 * The clear itself is planned in the same breath and for the same reason: what
 * a catalog read can refuse must be refused before anything can call it a
 * partial commit.
 *
 * PostgreSQL then runs the clear and the rebuild in ONE transaction on the
 * locked session: no other effectful migration or push command can observe the
 * transient empty namespace, and a dependency or DDL failure rolls the clear
 * back. MySQL commits DDL implicitly, so the same proven program runs under the
 * same database-scoped lock as one SEQUENTIAL program instead of pretending to
 * be atomic; a failure names the last statement that completed and leaves the
 * artifact estate untouched — push never reads or writes migration storage in
 * either case.
 */
async function forceResetPush(
  client: MigrationClient,
  migrationDriver: BoundMigrationDriver,
  options: PushOptions,
  relations: ResolvedRelationIndex,
  local: { trackingTableName: string }
): Promise<PushResult> {
  const plan = await planRebuildFromEmpty(
    client,
    migrationDriver,
    options,
    relations
  );

  const sql = await withLockedMigrationProducer(
    client.$driver,
    migrationDriver,
    async (pinned, command) => {
      // Rendered and proven under the lock BEFORE the clear: §6.2's guarantee
      // — nothing that could fail on the way in is discovered after the
      // namespace has been emptied — holds, and the statements carry the
      // command-local resolved catalog spelling (§5.2), which does not exist
      // until this session selects it.
      const program = generateDDLStatements(
        plan.operations,
        command,
        plan.currentSchema
      );
      if (needsEnumAdditionCommitBoundary(program)) {
        throw new MigrationError(
          "This force-reset would need a commit boundary inside its rebuild (a PostgreSQL enum-value addition a later statement uses), so the clear and the rebuild cannot be one transaction. " +
            "Force-reset refuses rather than clearing a namespace it cannot atomically rebuild.",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }

      // The clear is decided and rendered HERE, under the lock and before the
      // commit model opens: its namespace proof, its live inventory and both of
      // its containment refusals are catalog reads, and a refusal wrapped in
      // MySQL's partial-commit report tells the caller a database this command
      // never touched "failed partway through" — without the metadata naming
      // the constraint that refused it.
      const resetPlan = await planResetDatabase(
        pinned,
        command,
        local.trackingTableName
      );

      const runProgram = async (producer: AnyDriver) => {
        await resetDatabase(producer, resetPlan);
        await executeDDLStatements(producer, command, program);
      };
      // The clear and the rebuild are ONE program on every dialect; what
      // differs is what a failure in the middle of it means. PostgreSQL rolls
      // the whole thing back. MySQL cannot, so the same program runs as one
      // sequential program and its failure names the last statement that
      // completed — the clear's drops and the rebuild's DDL alike, which is why
      // the scope is the program and not either half of it.
      if (command.target.dialect === "postgresql") {
        await pinned.withTransaction(runProgram);
      } else if (command.target.dialect === "mysql") {
        await runSequentialProgram(pinned, command, runProgram);
      } else {
        await runProgram(pinned);
      }
      return program;
    }
  );

  return { operations: plan.operations, applied: sql.length > 0, sql };
}

/**
 * Generates the DDL that would transform the live schema into the desired one,
 * without executing it.
 *
 * These are LIVE statements, not portable artifact SQL: this is `push` with
 * `dryRun`, so every operation is rendered at `destination: "live"`
 * (`push/executor.ts:25`). On a bound MySQL driver they are therefore
 * DATABASE-QUALIFIED — `viborm migrate generate` is what writes the
 * database-relative artifacts an estate deploys to `app_dev`, `app_test` and
 * `app_prod`. Do not write the output of this function into a migration file.
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
