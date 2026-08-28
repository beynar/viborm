/**
 * History-free push plan: live diff or force-reset rebuild, compiled
 * statements, and plan hash. This module does not execute SQL.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import type { ResolvedRelationIndex } from "../schema/validation/relation-resolution";
import { isRecord } from "../validation/value-guards";
import { canonicalizeJson, canonicalizeJsonText } from "./canonical-json";
import { classifyGeneratedAtomicity } from "./compile";
import { controlTableNames, DEFAULT_CONTROL_BASE } from "./control";
import type {
  BoundMigrationDriver,
  DDLContext,
  MigrationDriver,
} from "./drivers";
import { domainHash, HASH_DOMAIN, type Sha256 } from "./identity";
import {
  type LiveNamespaceResetPlan,
  planLiveNamespaceReset,
} from "./live-reset";
import {
  type MigrationClient,
  type PushOptions as PlannerPushOptions,
  planPush,
  planRebuildFromEmpty,
} from "./push/planner";
import type { ParsedPlanningOptions } from "./push-consent";
import {
  canonicalValue,
  fingerprintLive,
  freezeDeep,
  hashSnapshot,
  pushTargetIdentity,
} from "./push-fingerprint";
import { serializeResolvedModels } from "./serializer";
import { SqlAssembly } from "./sql-assembly";
import { sliceDispatch } from "./sql-blob";
import type {
  DiffOperation,
  ResolveCallback,
  ResolveChange,
  ResolveResult,
  SchemaSnapshot,
} from "./types";
import type {
  AtomicityClass,
  MigrationDispatchV1,
  PushConsent,
  PushOperation,
  PushResolution,
  PushStatementPreview,
  PushTargetIdentity,
} from "./v1-types";

const DESTRUCTIVE_OPERATIONS = new Set<DiffOperation["type"]>([
  "dropTable",
  "dropColumn",
  "alterColumn",
  "dropIndex",
  "dropForeignKey",
  "dropUniqueConstraint",
  "dropPrimaryKey",
  "dropEnum",
  "alterEnum",
]);

export interface PlannedStatement {
  readonly kind: "clear" | "effect";
  readonly operationId: string;
  readonly dispatch: MigrationDispatchV1;
}

export interface InternalPushPlan {
  readonly mode: PushConsent["mode"];
  readonly validation: PushConsent["validation"];
  readonly target: PushTargetIdentity;
  readonly sourceFingerprint: Sha256;
  readonly desiredFingerprint: Sha256;
  readonly desiredSchema: SchemaSnapshot;
  readonly schemaHash: Sha256;
  readonly planHash: Sha256;
  readonly resolutions: readonly PushResolution[];
  readonly operations: readonly DiffOperation[];
  readonly reportedOperations: readonly PushOperation[];
  readonly statements: readonly PlannedStatement[];
  readonly previewStatements: readonly PushStatementPreview[];
  readonly sqlBlob: Uint8Array;
  readonly atomicity: AtomicityClass;
  readonly destructive: boolean;
}

type ResolutionSource =
  | {
      readonly kind: "record";
      readonly callback: ResolveCallback | undefined;
    }
  | {
      readonly kind: "replay";
      readonly resolutions: readonly PushResolution[];
    };

interface ResolutionController {
  readonly callback: ResolveCallback;
  finish(): readonly PushResolution[];
}

export async function buildPushPlan(
  client: MigrationClient,
  producer: AnyDriver,
  command: BoundMigrationDriver,
  relations: ResolvedRelationIndex,
  options: ParsedPlanningOptions,
  resolutionSource: ResolutionSource
): Promise<InternalPushPlan> {
  const controller = resolutionController(resolutionSource);
  const plannerOptions: PlannerPushOptions = {
    skipValidation: options.skipValidation,
    resolve: controller.callback,
  };
  const planningDriver = managedPlanningDriver(command);
  const desired = serializeResolvedModels(
    client.$schema,
    planningDriver,
    relations
  );
  const mode: PushConsent["mode"] = options.forceReset ? "force-reset" : "diff";

  let reset: LiveNamespaceResetPlan | undefined;
  let current: SchemaSnapshot;
  let operations: readonly DiffOperation[];
  if (options.forceReset) {
    current = await introspectManaged(producer, command);
    const control = controlTableNames(DEFAULT_CONTROL_BASE);
    reset = await planLiveNamespaceReset(producer, command, {
      trackingTable: "preserve",
      trackingTableName: control.state,
      preserveTables: [control.log],
    });
    const rebuild = await planRebuildFromEmpty(
      { $driver: producer, $schema: client.$schema },
      planningDriver,
      plannerOptions,
      relations
    );
    operations = rebuild.operations;
  } else {
    const planned = await planPush(
      { $driver: producer, $schema: client.$schema },
      planningDriver,
      plannerOptions,
      relations
    );
    current = planned.currentSchema;
    operations = planned.operations;
  }
  const resolutions = controller.finish();
  const target = await pushTargetIdentity(client, producer, command);
  const sourceFingerprint = await fingerprintLive(current, command, producer);
  const desiredFingerprint = await fingerprintLive(desired, command, producer);
  const schemaHash = hashSnapshot(desired);
  const compiled = compilePlanStatements(
    reset,
    operations,
    planningDriver,
    options.forceReset ? { tables: [], enums: [] } : current
  );
  const reportedOperations: PushOperation[] = operations.map(
    (operation, index) => ({
      id: `${operation.type}:${index}`,
      label: operation.type,
      risk: DESTRUCTIVE_OPERATIONS.has(operation.type) ? "destructive" : "safe",
    })
  );
  const atomicity = classifyPlanAtomicity(command, operations);
  const destructive =
    mode === "force-reset" ||
    reportedOperations.some((operation) => operation.risk === "destructive");
  const validation: PushConsent["validation"] = options.skipValidation
    ? "structural-only"
    : "full";
  const planHash = hashPushPlan({
    mode,
    validation,
    target,
    sourceFingerprint,
    desiredFingerprint,
    schemaHash,
    resolutions,
    operations,
    statements: compiled.statements,
    atomicity,
  });

  return freezeDeep({
    mode,
    validation,
    target,
    sourceFingerprint,
    desiredFingerprint,
    desiredSchema: desired,
    schemaHash,
    planHash,
    resolutions,
    operations,
    reportedOperations,
    statements: compiled.statements,
    previewStatements: compiled.statements.map((statement) => ({
      sql: sliceDispatch(compiled.bytes, statement.dispatch),
      parameters: statement.dispatch.parameters,
    })),
    sqlBlob: compiled.bytes,
    atomicity,
    destructive,
  });
}

export function compilePlanStatements(
  reset: LiveNamespaceResetPlan | undefined,
  operations: readonly DiffOperation[],
  driver: MigrationDriver,
  currentSchema: SchemaSnapshot
): {
  readonly bytes: Uint8Array;
  readonly statements: readonly PlannedStatement[];
} {
  const assembly = new SqlAssembly();
  const pending: Array<{
    readonly kind: PlannedStatement["kind"];
    readonly operationId: string;
    readonly index: number;
  }> = [];

  if (reset) {
    const clear = [
      ...reset.dropForeignKeys,
      ...reset.dropTables.map((table) => table.sql),
      ...reset.dropEnums,
    ];
    for (const [index, sql] of clear.entries()) {
      pending.push({
        kind: "clear",
        operationId: `force-reset:clear:${index}`,
        index: assembly.add(sql),
      });
    }
  }

  for (const [operationIndex, operation] of operations.entries()) {
    const context: DDLContext = {
      destination: "live",
      currentSchema,
      precedingOperations: operations.slice(0, operationIndex),
    };
    const statements = driver.compileStatements(operation, context);
    for (const [statementIndex, sql] of statements.entries()) {
      pending.push({
        kind: "effect",
        operationId: `${operation.type}:${operationIndex}:${statementIndex}`,
        index: assembly.add(sql),
      });
    }
  }

  const sealed = assembly.seal();
  return {
    bytes: sealed.bytes,
    statements: pending.map((statement) => ({
      kind: statement.kind,
      operationId: statement.operationId,
      dispatch: requiredDispatch(sealed.dispatches, statement.index),
    })),
  };
}

export function hashPushPlan(input: {
  readonly mode: PushConsent["mode"];
  readonly validation: PushConsent["validation"];
  readonly target: PushTargetIdentity;
  readonly sourceFingerprint: Sha256;
  readonly desiredFingerprint: Sha256;
  readonly schemaHash: Sha256;
  readonly resolutions: readonly PushResolution[];
  readonly operations: readonly DiffOperation[];
  readonly statements: readonly PlannedStatement[];
  readonly atomicity: AtomicityClass;
}): Sha256 {
  return domainHash(
    HASH_DOMAIN.plan,
    canonicalizeJson(
      canonicalValue({
        mode: input.mode,
        validation: input.validation,
        target: input.target,
        sourceFingerprint: input.sourceFingerprint,
        desiredFingerprint: input.desiredFingerprint,
        schemaHash: input.schemaHash,
        resolutions: input.resolutions,
        operations: input.operations,
        atomicity: input.atomicity,
        // Review SQL is intentionally absent. Dispatch identity authenticates
        // the sealed statement bytes, exact ranges, and typed parameters.
        statements: input.statements.map((statement) => ({
          kind: statement.kind,
          operationId: statement.operationId,
          dispatch: statement.dispatch,
        })),
      })
    )
  );
}

export function classifyPlanAtomicity(
  driver: MigrationDriver,
  operations: readonly DiffOperation[]
): AtomicityClass {
  return classifyGeneratedAtomicity(driver, operations);
}

export async function introspectManaged(
  producer: AnyDriver,
  driver: MigrationDriver
): Promise<SchemaSnapshot> {
  return withoutControlTables(
    await driver.introspect((sql, params) => producer._executeRaw(sql, params))
  );
}

function requiredDispatch(
  dispatches: readonly MigrationDispatchV1[],
  index: number
): MigrationDispatchV1 {
  const dispatch = dispatches[index];
  if (!dispatch) {
    throw new MigrationError(
      "The structured push compiler omitted a planned dispatch",
      VibORMErrorCode.INTERNAL_ERROR
    );
  }
  return dispatch;
}

function managedPlanningDriver(
  driver: BoundMigrationDriver
): BoundMigrationDriver {
  const managed: BoundMigrationDriver = Object.create(driver);
  Object.defineProperty(managed, "introspect", {
    value: async (
      executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
    ) => withoutControlTables(await driver.introspect(executeRaw)),
  });
  Object.freeze(managed);
  return managed;
}

function withoutControlTables(snapshot: SchemaSnapshot): SchemaSnapshot {
  const names = controlTableNames(DEFAULT_CONTROL_BASE);
  return {
    ...snapshot,
    tables: snapshot.tables.filter(
      (table) => table.name !== names.state && table.name !== names.log
    ),
  };
}

function resolutionController(source: ResolutionSource): ResolutionController {
  if (source.kind === "record") {
    const recorded: PushResolution[] = [];
    return {
      callback: async (change) => {
        const result = source.callback
          ? await source.callback(change)
          : defaultResolution(change);
        const decision = closeResolution(change, result);
        if (decision) {
          recorded.push({ id: resolutionId(change), decision });
        }
        return result;
      },
      finish: () => freezeDeep([...recorded]),
    };
  }

  let cursor = 0;
  return {
    callback: (change) => {
      const expected = source.resolutions[cursor++];
      if (!expected || expected.id !== resolutionId(change)) {
        throw new MigrationError(
          "The locked push requested a different set of resolutions",
          VibORMErrorCode.MIGRATION_CONSENT_MISMATCH
        );
      }
      return replayResolution(change, expected.decision);
    },
    finish: () => {
      if (cursor !== source.resolutions.length) {
        throw new MigrationError(
          "The locked push no longer requests every consented resolution",
          VibORMErrorCode.MIGRATION_CONSENT_MISMATCH
        );
      }
      return source.resolutions;
    },
  };
}

function defaultResolution(change: ResolveChange): ResolveResult | undefined {
  // Destructive operations have one interpretation. Closing `proceed` lets a
  // preview describe it, while exact plan consent remains mandatory.
  if (change.type === "destructive") return change.proceed();
  return undefined;
}

function closeResolution(
  change: ResolveChange,
  result: ResolveResult | undefined | void
): string | undefined {
  if (result === undefined) return undefined;
  if (result === "reject") return "reject";
  if (change.type === "destructive") {
    if (result !== "proceed") invalidResolution(change);
    return "proceed";
  }
  if (change.type === "ambiguous") {
    if (result !== "rename" && result !== "addAndDrop") {
      invalidResolution(change);
    }
    return result;
  }
  if (result !== "enumMapped") invalidResolution(change);
  if (change._mappings) {
    return `map:${canonicalizeJsonText(canonicalValue(change._mappings))}`;
  }
  if (change._useNullDefault) {
    if (!change.isNullable) {
      throw new MigrationError(
        "A non-nullable enum column cannot resolve removed values to NULL",
        VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
      );
    }
    return "useNull";
  }
  invalidResolution(change);
}

function invalidResolution(change: ResolveChange): never {
  throw new MigrationError(
    `Resolver returned an invalid decision for ${change.type}`,
    VibORMErrorCode.INVALID_INPUT
  );
}

function replayResolution(
  change: ResolveChange,
  decision: string
): ResolveResult {
  if (change.type === "destructive" && decision === "proceed") {
    return change.proceed();
  }
  if (change.type === "ambiguous") {
    if (decision === "rename") return change.rename();
    if (decision === "addAndDrop") return change.addAndDrop();
  }
  if (change.type === "enumValueRemoval") {
    if (decision === "useNull" && change.isNullable) return change.useNull();
    if (decision.startsWith("map:")) {
      return change.mapValues(parseResolutionMap(decision.slice(4)));
    }
  }
  throw new MigrationError(
    "Push consent contains a resolution that is invalid for the locked request",
    VibORMErrorCode.MIGRATION_CONSENT_MISMATCH
  );
}

function resolutionId(change: ResolveChange): string {
  const identity =
    change.type === "enumValueRemoval"
      ? {
          type: change.type,
          enumName: change.enumName,
          tableName: change.tableName,
          columnName: change.columnName,
          isNullable: change.isNullable,
          removedValues: change.removedValues,
          availableValues: change.availableValues,
        }
      : {
          type: change.type,
          operation: change.operation,
          table: change.table,
          column: change.column ?? null,
          oldName:
            change.type === "ambiguous" ? (change.oldName ?? null) : null,
          newName:
            change.type === "ambiguous" ? (change.newName ?? null) : null,
          oldType:
            change.type === "ambiguous" ? (change.oldType ?? null) : null,
          newType:
            change.type === "ambiguous" ? (change.newType ?? null) : null,
        };
  return domainHash(HASH_DOMAIN.plan, canonicalizeJson(identity));
}

function parseResolutionMap(text: string): Record<string, string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new MigrationError(
      "Push consent contains a malformed enum resolution",
      VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
      { cause: cause instanceof Error ? cause : undefined }
    );
  }
  if (!isRecord(parsed) || canonicalizeJsonText(parsed) !== text) {
    throw new MigrationError(
      "Push consent contains a non-canonical enum resolution",
      VibORMErrorCode.MIGRATION_CONSENT_MISMATCH
    );
  }
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" && value !== null) {
      throw new MigrationError(
        "Push consent enum mappings must contain only strings or null",
        VibORMErrorCode.MIGRATION_CONSENT_MISMATCH
      );
    }
    result[key] = value;
  }
  return result;
}
