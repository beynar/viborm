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
import type { ResolvedRelationIndex } from "../schema/validation/relation-resolution";
import { allRules } from "../schema/validation/rules";
import {
  resolveSchemaOrThrow,
  validateResolvedSchemaOrThrow,
} from "../schema/validation/validator";
import { admitLiveMigrationCapability } from "./admission";
import { canonicalizeJson } from "./canonical-json";
import { refuseIncompatibleHistory, unfinishedAttempts } from "./control";
import { diff } from "./differ";
import type { BoundMigrationDriver } from "./drivers";
import { executeDispatch } from "./execute-dispatch";
import { domainHash, HASH_DOMAIN, type Sha256 } from "./identity";
import {
  resolveCommandDriver,
  runProgram,
  withLockedMigrationProducer,
} from "./pinned-session";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import {
  assertAcceptedPlan,
  assertConsent,
  hasConsent,
  parseConsent,
  parsePlanningOptions,
  parseSnapshottedPlanningOptions,
  snapshotPushOptions,
} from "./push-consent";
import { fingerprintLive, freezeDeep } from "./push-fingerprint";
import {
  buildPushPlan,
  type InternalPushPlan,
  introspectManaged,
} from "./push-plan";
import { readCommandControl } from "./resume";
import { assertMigrationDecimalDomainsFitProvider } from "./serializer";
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
  const { relations, driver } = prepareSchema(client, parsed.skipValidation);
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
  const given = snapshotPushOptions(options ?? {});
  if (hasConsent(given)) {
    return applyWithConsent(client, parseConsent(given.consent));
  }

  const parsed = parseSnapshottedPlanningOptions(given, given.dryRun === true);
  if (parsed.dryRun) {
    return previewPush(client, parsed);
  }

  const { relations, driver } = prepareSchema(client, parsed.skipValidation);

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
        throw new MigrationError(
          "Destructive or force-reset push requires exact preview consent. Call push({ dryRun: true }), review the plan, then pass its consent unchanged to push({ consent }).",
          VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
          {
            meta: {
              command: "push",
              dialect: plan.target.dialect,
              expectedChecksum: plan.planHash,
              expectedStatementCount: plan.statements.length,
              hint: "Review push({ dryRun: true }) and pass the returned consent unchanged to push({ consent }).",
            },
          }
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
  const { relations, driver } = prepareSchema(client, skipValidation);
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
  // A plan with nothing to do still has a MySQL sequential program to run: the
  // interrupted-decimal-conversion recovery belongs to the LOCKED COMMAND, not
  // to having statements. A conversion interrupted after its MODIFY leaves the
  // column already carrying the target domain, so the differ sees no change
  // and the plan is empty — and the remnant CHECK, which no snapshot
  // vocabulary describes, would then survive every later push while refusing
  // values the declared domain admits.
  if (plan.statements.length === 0 && command.target.dialect !== "mysql") {
    return appliedResult(plan, plan.sourceFingerprint, "noop");
  }

  // In a transaction the destination is proven before its COMMIT, and the
  // lifted foreign-key bracket runs around it (its pragmas, sent again
  // inside, are no-ops there); otherwise once the statements ran — on MySQL
  // after its sequential program.
  const fingerprint = await runProgram(
    pinned,
    command,
    {
      transactional: plan.atomicity === "transactional",
      statements: plan.statements.map((statement) =>
        sliceDispatch(plan.sqlBlob, statement.dispatch)
      ),
    },
    async (producer, atomic) => {
      for (const statement of plan.statements) {
        await executeDispatch(
          producer,
          plan.sqlBlob,
          statement.dispatch,
          command.namespace
        );
      }
      return atomic ? attestFinalFingerprint(producer, command, plan) : null;
    }
  );
  if (plan.statements.length === 0) {
    return appliedResult(plan, plan.sourceFingerprint, "noop");
  }
  return appliedResult(
    plan,
    fingerprint ?? (await attestFinalFingerprint(pinned, command, plan)),
    "applied"
  );
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
      `Push completed its statements but the final live fingerprint does not match the desired schema: ${JSON.stringify(await diff(finalSnapshot, plan.desiredSchema))}`,
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
  const control = await readCommandControl(producer, command);
  if (control.presence.kind !== "present") return;
  const { marker, ledger } = control;
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

export function prepareSchema(
  client: MigrationClient,
  skipValidation: boolean
): {
  readonly relations: ResolvedRelationIndex;
  readonly driver: BoundMigrationDriver;
} {
  hydrateSchemaNames(client.$schema);
  const relations = skipValidation
    ? resolveSchemaOrThrow(client.$schema)
    : validateResolvedSchemaOrThrow(client.$schema, allRules());
  const driver = getPushMigrationDriver(client);
  assertMigrationDecimalDomainsFitProvider(client.$schema, driver.dialect);
  return { relations, driver };
}
