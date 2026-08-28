/**
 * Authenticated, history-free push.
 *
 * A preview exposes review text and inert consent. The executable program stays
 * private, is rebuilt from the live catalog under the target lock, and is
 * dispatched only through the structured-statement compiler.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import { hydrateSchemaNames } from "../schema/hydration";
import {
  resolveSchemaOrThrow,
  validateSchemaOrThrow,
} from "../schema/validation";
import type { ResolvedRelationIndex } from "../schema/validation/relation-resolution";
import { admitLiveMigrationCapability } from "./admission";
import { canonicalizeJson } from "./canonical-json";
import {
  DEFAULT_CONTROL_BASE,
  inspectControlPresence,
  readLedger,
  readMarker,
  refuseIncompatibleHistory,
  refusePartialControl,
  unfinishedAttempts,
} from "./control";
import type { BoundMigrationDriver } from "./drivers";
import { executeDispatch } from "./execute-dispatch";
import { assertForeignKeysIntact, liftForeignKeyPragmas } from "./foreign-keys";
import { domainHash, HASH_DOMAIN, type Sha256 } from "./identity";
import {
  mayWrapTransaction,
  resolveCommandDriver,
  runSequentialProgram,
  withLockedMigrationProducer,
} from "./pinned-session";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import {
  assertAcceptedPlan,
  assertConsent,
  hasConsent,
  parseConsent,
  parsePlanningOptions,
} from "./push-consent";
import { fingerprintLive, freezeDeep } from "./push-fingerprint";
import {
  buildPushPlan,
  type InternalPushPlan,
  introspectManaged,
  type PlannedStatement,
} from "./push-plan";
import { sliceDispatch } from "./sql-blob";
import type {
  PushApplyResult as BasePushApplyResult,
  PushPreview as BasePushPreview,
  ExactPushOptions,
  PushConsent,
  PushOptionsV1,
  PushPlanningOptions,
} from "./v1-types";

export type {
  ExactPushOptions,
  PushConsent,
  PushOperation,
  PushOptionsV1,
  PushOptionsV1 as PushOptions,
  PushPlanningOptions,
  PushResolution,
  PushStatementPreview,
  PushTargetIdentity,
} from "./v1-types";

export interface PushAttestation {
  readonly pathHash: Sha256;
  readonly planHash: Sha256;
  readonly schemaHash: Sha256;
  readonly fingerprint: Sha256;
}

export interface PushApplyResult extends BasePushApplyResult {
  readonly attestation: PushAttestation;
}

export interface PushPreview extends BasePushPreview {
  readonly schemaHash: Sha256;
  readonly fingerprint: Sha256;
}

export type PushResultFor<O> = [O] extends [{ readonly dryRun: true }]
  ? PushPreview
  : PushApplyResult;

/**
 * Effect-free planning. It does not acquire a lock and never receives estate
 * storage. A force reset plans the empty-to-target rebuild rather than diffing
 * the desired schema from the live schema.
 */
export async function previewPush(
  client: MigrationClient,
  options: PushPlanningOptions = {}
): Promise<PushPreview> {
  const parsed = parsePlanningOptions(options, true);
  const relations = prepareSchema(client, parsed.skipValidation);
  const driver = getPushMigrationDriver(client);
  admitLiveMigrationCapability(
    driver,
    "read-only",
    parsed.forceReset ? "push({ forceReset: true })" : "push()"
  );
  const command = await resolveCommandDriver(client.$driver, driver);
  const plan = await buildPushPlan(
    client,
    client.$driver,
    command,
    relations,
    parsed,
    { kind: "record", callback: parsed.resolve }
  );
  return publicPreview(plan);
}

/**
 * Replans and executes on one pinned producer under the target lock.
 *
 * Generic force is deliberately absent. Destructive diff work and every
 * force-reset plan require exact preview consent.
 */
export function pushV1<O extends PushOptionsV1>(
  client: MigrationClient,
  options?: ExactPushOptions<O>
): Promise<PushResultFor<O>>;
export async function pushV1(
  client: MigrationClient,
  options?: PushOptionsV1
): Promise<PushApplyResult | PushPreview> {
  const given = options ?? {};
  if (hasConsent(given)) {
    return applyWithConsent(client, parseConsent(given.consent));
  }

  const parsed = parsePlanningOptions(given, given.dryRun === true);
  if (parsed.dryRun) {
    return previewPush(client, parsed);
  }

  const relations = prepareSchema(client, parsed.skipValidation);
  const driver = getPushMigrationDriver(client);

  // A resolver may perform arbitrary user work. Run it only during an unlocked
  // read-only plan, then close its normalized answers for the locked replan.
  let accepted: InternalPushPlan | undefined;
  if (parsed.resolve) {
    admitLiveMigrationCapability(driver, "read-only", "push()");
    const command = await resolveCommandDriver(client.$driver, driver);
    accepted = await buildPushPlan(
      client,
      client.$driver,
      command,
      relations,
      parsed,
      { kind: "record", callback: parsed.resolve }
    );
  }

  admitLiveMigrationCapability(
    driver,
    "effectful",
    parsed.forceReset ? "push({ forceReset: true })" : "push()"
  );
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const plan = await buildPushPlan(
        client,
        pinned,
        command,
        relations,
        parsed,
        accepted
          ? { kind: "replay", resolutions: accepted.resolutions }
          : { kind: "record", callback: undefined }
      );
      if (accepted) assertAcceptedPlan(accepted, plan);
      await assertPushControlInterlock(pinned, command, plan);
      if (plan.destructive) {
        const preview = publicPreview(plan);
        throw new MigrationError(
          "Destructive or force-reset push requires exact preview consent",
          VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
          { meta: { planHash: plan.planHash, preview } }
        );
      }
      return executeLockedPlan(pinned, command, plan);
    }
  );
}

async function applyWithConsent(
  client: MigrationClient,
  consent: PushConsent
): Promise<PushApplyResult> {
  const skipValidation = consent.validation === "structural-only";
  const relations = prepareSchema(client, skipValidation);
  const driver = getPushMigrationDriver(client);
  admitLiveMigrationCapability(
    driver,
    "effectful",
    consent.mode === "force-reset"
      ? "push({ consent: forceResetPreview.consent })"
      : "push({ consent })"
  );
  return withLockedMigrationProducer(
    client.$driver,
    driver,
    async (pinned, command) => {
      const plan = await buildPushPlan(
        client,
        pinned,
        command,
        relations,
        {
          forceReset: consent.mode === "force-reset",
          skipValidation,
          resolve: undefined,
          dryRun: false,
        },
        { kind: "replay", resolutions: consent.resolutions }
      );
      assertConsent(consent, plan);
      await assertPushControlInterlock(pinned, command, plan);
      return executeLockedPlan(pinned, command, plan);
    }
  );
}

async function executeLockedPlan(
  pinned: AnyDriver,
  command: BoundMigrationDriver,
  plan: InternalPushPlan
): Promise<PushApplyResult> {
  if (plan.statements.length === 0) {
    return appliedResult(plan, plan.sourceFingerprint, "noop");
  }

  const execute = (producer: AnyDriver): Promise<Sha256> =>
    executeAndAttest(producer, command, plan, plan.statements);

  if (
    mayWrapTransaction(pinned, command.target.dialect, plan.atomicity === "transactional")
  ) {
    const fingerprint = await executeTransactional(pinned, command, plan);
    return appliedResult(plan, fingerprint, "applied");
  }
  if (command.target.dialect === "mysql") {
    await runSequentialProgram(pinned, async (producer) => {
      for (const statement of plan.statements) {
        await executeDispatch(producer, plan.sqlBlob, statement.dispatch);
      }
    });
    const fingerprint = await attestFinalFingerprint(pinned, command, plan);
    return appliedResult(plan, fingerprint, "applied");
  }
  const fingerprint = await execute(pinned);
  return appliedResult(plan, fingerprint, "applied");
}

async function executeAndAttest(
  producer: AnyDriver,
  command: BoundMigrationDriver,
  plan: InternalPushPlan,
  statements: readonly PlannedStatement[]
): Promise<Sha256> {
  for (const statement of statements) {
    await executeDispatch(producer, plan.sqlBlob, statement.dispatch);
  }
  return attestFinalFingerprint(producer, command, plan);
}

async function executeTransactional(
  pinned: AnyDriver,
  command: BoundMigrationDriver,
  plan: InternalPushPlan
): Promise<Sha256> {
  const sql = plan.statements.map((statement) =>
    sliceDispatch(plan.sqlBlob, statement.dispatch)
  );
  const lifted = liftForeignKeyPragmas(pinned, sql);
  if (!lifted.bracket) {
    return pinned.withTransaction((transaction) =>
      executeAndAttest(transaction, command, plan, plan.statements)
    );
  }

  const disable = findStatement(plan, lifted.bracket.disable);
  const enable = findStatement(plan, lifted.bracket.enable);
  const remaining = takeStatements(plan, [
    disable.dispatch.dispatchId,
    enable.dispatch.dispatchId,
  ]);
  await executeDispatch(pinned, plan.sqlBlob, disable.dispatch);
  try {
    return await pinned.withTransaction(async (transaction) => {
      for (const statement of remaining) {
        await executeDispatch(transaction, plan.sqlBlob, statement.dispatch);
      }
      await assertForeignKeysIntact(transaction, lifted.bracket);
      return attestFinalFingerprint(transaction, command, plan);
    });
  } finally {
    await executeDispatch(pinned, plan.sqlBlob, enable.dispatch);
  }
}

async function attestFinalFingerprint(
  producer: AnyDriver,
  command: BoundMigrationDriver,
  plan: InternalPushPlan
): Promise<Sha256> {
  const finalSnapshot = await introspectManaged(producer, command);
  const fingerprint = await fingerprintLive(finalSnapshot, command, producer);
  const expected = await fingerprintLive(plan.desiredSchema, command, producer);
  if (fingerprint !== expected) {
    throw new MigrationError(
      "Push completed its statements but the final live fingerprint does not match the desired schema",
      VibORMErrorCode.MIGRATION_DRIFT,
      {
        meta: {
          planHash: plan.planHash,
          schemaHash: plan.schemaHash,
          fingerprint,
        },
      }
    );
  }
  return fingerprint;
}

function findStatement(plan: InternalPushPlan, sql: string): PlannedStatement {
  const found = plan.statements.find(
    (statement) =>
      sliceDispatch(plan.sqlBlob, statement.dispatch).trim() === sql.trim()
  );
  if (!found) {
    throw new MigrationError(
      "The compiled SQLite foreign-key bracket is missing from the authenticated push plan",
      VibORMErrorCode.INTERNAL_ERROR
    );
  }
  return found;
}

function takeStatements(
  plan: InternalPushPlan,
  excludedDispatchIds: readonly string[]
): readonly PlannedStatement[] {
  const excluded = new Set(excludedDispatchIds);
  return plan.statements.filter(
    (statement) => !excluded.has(statement.dispatch.dispatchId)
  );
}

function appliedResult(
  plan: InternalPushPlan,
  fingerprint: Sha256,
  outcome: PushApplyResult["outcome"]
): PushApplyResult {
  const pathHash = domainHash(
    HASH_DOMAIN.path,
    canonicalizeJson({
      target: plan.target,
      sourceFingerprint: plan.sourceFingerprint,
      fingerprint,
      planHash: plan.planHash,
      schemaHash: plan.schemaHash,
    })
  );
  return freezeDeep({
    outcome,
    target: plan.target,
    planHash: plan.planHash,
    operations: plan.reportedOperations,
    statements: plan.previewStatements,
    attestation: {
      pathHash,
      planHash: plan.planHash,
      schemaHash: plan.schemaHash,
      fingerprint,
    },
  });
}

async function assertPushControlInterlock(
  producer: AnyDriver,
  command: BoundMigrationDriver,
  plan: InternalPushPlan
): Promise<void> {
  const presence = await inspectControlPresence(
    producer,
    command,
    DEFAULT_CONTROL_BASE
  );
  if (presence.kind === "missing-table") {
    refusePartialControl(presence);
    return;
  }

  const marker = await readMarker(producer, command, DEFAULT_CONTROL_BASE);
  const ledger = await readLedger(producer, command, DEFAULT_CONTROL_BASE);
  if (unfinishedAttempts(ledger).length > 0) {
    throw new MigrationError(
      "An unfinished migration attempt is blocking push",
      VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
    );
  }
  refuseIncompatibleHistory(marker, ledger);
  if (!marker) {
    return;
  }
  if (plan.operations.length > 0 || plan.mode === "force-reset") {
    throw new MigrationError(
      "Non-empty push against a migration marker is refused; use generate/apply or history-aware reset",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { meta: { planHash: plan.planHash } }
    );
  }
  if (
    marker.snapshotHash !== plan.schemaHash ||
    plan.sourceFingerprint !== plan.desiredFingerprint
  ) {
    throw new MigrationError(
      "A no-op push cannot prove agreement between the marker, live schema, and desired schema",
      VibORMErrorCode.MIGRATION_DRIFT,
      {
        meta: {
          planHash: plan.planHash,
          expectedChecksum: marker.snapshotHash,
          actualChecksum: plan.schemaHash,
        },
      }
    );
  }
}

function publicPreview(plan: InternalPushPlan): PushPreview {
  const consent: PushConsent = {
    format: "1",
    target: plan.target,
    planHash: plan.planHash,
    mode: plan.mode,
    validation: plan.validation,
    resolutions: plan.resolutions,
  };
  return freezeDeep({
    outcome: plan.statements.length === 0 ? "noop" : "planned",
    target: plan.target,
    planHash: plan.planHash,
    schemaHash: plan.schemaHash,
    fingerprint: plan.sourceFingerprint,
    destructive: plan.destructive,
    operations: plan.reportedOperations,
    statements: plan.previewStatements,
    consent,
  });
}

function prepareSchema(
  client: MigrationClient,
  skipValidation: boolean
): ResolvedRelationIndex {
  hydrateSchemaNames(client.$schema);
  return skipValidation
    ? resolveSchemaOrThrow(client.$schema)
    : validateSchemaOrThrow(client.$schema);
}
