/**
 * One compiler: DiffOperation and manual Sql become structured operations
 * that share one SQL blob. No delimiter split.
 */

import type { Sql } from "@sql";
import { MigrationError, VibORMErrorCode } from "../errors";
import { canonicalizeDecimalValue } from "../validation/primitives/decimal-codec";
import { decodeCanonicalBase64, encodeBase64 } from "./base64";
import {
  type CatalogProbe,
  probeForGeneratedStatement,
} from "./catalog-probes";
import type { DDLContext, MigrationDriver } from "./drivers";
import { invertOperations } from "./invert";
import type { SqlAssembly } from "./sql-assembly";
import { sliceDispatch } from "./sql-blob";
import type { DiffOperation, SchemaSnapshot } from "./types";
import { encodeTransitionHash } from "./v1-parse";
import type {
  AtomicityClass,
  MigrationBooleanCheckV1,
  MigrationCheckInput,
  MigrationDispatchV1,
  MigrationOperationV1,
  MigrationParameterV1,
  MigrationParentTransitionV1,
  MigrationRollbackV1,
  MigrationStepV1,
} from "./v1-types";

const DESTRUCTIVE = new Set<DiffOperation["type"]>([
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

export interface CompiledTransition {
  readonly operations: readonly MigrationOperationV1[];
  readonly rollback: MigrationRollbackV1;
  readonly originChecks: readonly MigrationBooleanCheckV1[];
  readonly requestedForwardBoundary: "transactional" | "stepwise" | null;
  readonly atomicity: AtomicityClass;
}

export function groupContiguousAtomicity<
  T extends { readonly boundary: string },
>(
  items: readonly T[]
): readonly {
  readonly boundary: T["boundary"];
  readonly items: readonly T[];
}[] {
  const groups: {
    boundary: T["boundary"];
    items: T[];
  }[] = [];
  for (const item of items) {
    const current = groups.at(-1);
    if (current?.boundary === item.boundary) {
      current.items.push(item);
    } else {
      groups.push({ boundary: item.boundary, items: [item] });
    }
  }
  return groups;
}

export function compileGeneratedTransition(
  operations: readonly DiffOperation[],
  driver: MigrationDriver,
  destination: DDLContext["destination"],
  currentSchema: SchemaSnapshot,
  desiredSchema: SchemaSnapshot,
  assembly: SqlAssembly
): CompiledTransition {
  const compiled = operations
    .map((operation, index) =>
      compileGeneratedOperation(
        operation,
        driver,
        destination,
        currentSchema,
        operations,
        index,
        assembly
      )
    )
    .filter((operation) => operation.steps.length > 0);
  const inverse = invertOperations([...operations], currentSchema);
  const irreversibleReason = inverse.operations
    .map((operation) => driver.getIrreversibleRollbackReason(operation))
    .find((reason) => reason !== undefined);
  const rollback: MigrationRollbackV1 =
    inverse.operations.length === 0 && operations.length === 0
      ? { kind: "schema", operations: [] }
      : irreversibleReason !== undefined
        ? { kind: "irreversible", reason: irreversibleReason }
        : inverse.operations.length === 0
          ? {
              kind: "irreversible",
              reason:
                inverse.warnings[0] ??
                "Generated operations have no automatic inverse",
            }
          : {
              kind: "schema",
              operations: inverse.operations.map((operation, index) =>
                compileGeneratedOperation(
                  operation,
                  driver,
                  destination,
                  desiredSchema,
                  inverse.operations,
                  index,
                  assembly
                )
              ),
            };
  return {
    operations: compiled,
    rollback,
    originChecks: [],
    requestedForwardBoundary: null,
    atomicity: classifyGeneratedAtomicity(driver, operations),
  };
}

function compileGeneratedOperation(
  operation: DiffOperation,
  driver: MigrationDriver,
  destination: DDLContext["destination"],
  currentSchema: SchemaSnapshot,
  batch: readonly DiffOperation[],
  index: number,
  assembly: SqlAssembly
): MigrationOperationV1 {
  const context: DDLContext = {
    destination,
    currentSchema,
    precedingOperations: batch.slice(0, index),
  };
  const statements = driver.compileStatements(operation, context);
  const steps: MigrationStepV1[] = statements.map((statement) => {
    const probes = probeForGeneratedStatement(driver, operation, statement);
    const execute = addDispatch(assembly, statement, []);
    if (!probes) {
      return { retry: "opaque", execute };
    }
    return {
      retry: "proven",
      precheck: checkFromProbe(assembly, probes.pre),
      execute,
      postcheck: checkFromProbe(assembly, probes.post),
    };
  });
  return {
    id: `${operation.type}:${index}`,
    label: operation.type,
    origin: "generated",
    risk: DESTRUCTIVE.has(operation.type) ? "destructive" : "safe",
    steps,
  };
}

export function compileManualTransition(
  up: readonly Sql[],
  rollback:
    | {
        readonly kind: "manual";
        readonly execution: AtomicityClass;
        readonly sql: readonly Sql[];
      }
    | { readonly kind: "irreversible"; readonly reason: string },
  dialect: "postgresql" | "mysql" | "sqlite",
  requested: AtomicityClass,
  originChecks: readonly MigrationCheckInput[] | undefined,
  assembly: SqlAssembly
): CompiledTransition {
  const operations = compileManualOperations(up, dialect, assembly, "forward");
  if (rollback.kind === "irreversible" && rollback.reason.trim().length === 0) {
    throw new MigrationError(
      "Irreversible rollback requires a non-empty reason",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  const compiledRollback: MigrationRollbackV1 =
    rollback.kind === "irreversible"
      ? rollback
      : {
          kind: "manual",
          requestedBoundary: rollback.execution,
          operations: compileManualOperations(
            rollback.sql,
            dialect,
            assembly,
            "rollback"
          ),
        };
  return {
    operations,
    rollback: compiledRollback,
    originChecks: (originChecks ?? []).map((check, index) =>
      compileTrustedCheck(check, dialect, assembly, `origin:${index}`)
    ),
    requestedForwardBoundary: requested,
    atomicity: requested,
  };
}

export function assertManualStepwiseProof(
  compiled: CompiledTransition,
  destinationChecks: readonly MigrationBooleanCheckV1[]
): void {
  const forwardStepwise = compiled.requestedForwardBoundary === "stepwise";
  const rollbackStepwise =
    compiled.rollback.kind === "manual" &&
    compiled.rollback.requestedBoundary === "stepwise";
  if (!(forwardStepwise || rollbackStepwise)) return;
  if (compiled.originChecks.length === 0 || destinationChecks.length === 0) {
    throw new MigrationError(
      "Stepwise data-only manual work without complete origin and destination checks is refused before dispatch",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
}

function compileManualOperations(
  fragments: readonly Sql[],
  dialect: "postgresql" | "mysql" | "sqlite",
  assembly: SqlAssembly,
  prefix: string
): MigrationOperationV1[] {
  return fragments.map((fragment, index) => {
    const text = fragment.toStatement(dialect === "postgresql" ? "$n" : "?");
    const parameters = fragment.values.map((value) => encodeParameter(value));
    return {
      id: `manual:${prefix}:${index}`,
      label: "manual",
      origin: "manual" as const,
      risk: "opaque" as const,
      steps: [
        {
          retry: "opaque" as const,
          execute: addDispatch(assembly, text, parameters),
        },
      ],
    };
  });
}

export function compileTrustedCheck(
  input: MigrationCheckInput,
  dialect: "postgresql" | "mysql" | "sqlite",
  assembly: SqlAssembly,
  id: string
): MigrationBooleanCheckV1 & { readonly kind: "trusted-read" } {
  const text = input.query.toStatement(dialect === "postgresql" ? "$n" : "?");
  const parameters = input.query.values.map((value) => encodeParameter(value));
  return {
    kind: "trusted-read" as const,
    id,
    query: addDispatch(assembly, text, parameters),
    equals: input.equals,
  };
}

export function sealParent(
  fromState: string | null,
  compiled: CompiledTransition
): Omit<MigrationParentTransitionV1, "transitionHash"> {
  return {
    fromState,
    originChecks: compiled.originChecks,
    requestedForwardBoundary: compiled.requestedForwardBoundary,
    operations: compiled.operations,
    rollback: compiled.rollback,
  };
}

export function hashParent(
  parent: Omit<MigrationParentTransitionV1, "transitionHash">
): MigrationParentTransitionV1 {
  return { ...parent, transitionHash: encodeTransitionHash(parent) };
}

function addDispatch(
  assembly: SqlAssembly,
  text: string,
  parameters: readonly MigrationParameterV1[]
): MigrationDispatchV1 {
  const index = assembly.add(text, parameters);
  return {
    dispatchId: "0".repeat(64),
    sqlHash: "0".repeat(64),
    offset: index,
    length: 0,
    parameters,
  };
}

function checkFromProbe(
  assembly: SqlAssembly,
  probe: CatalogProbe
): MigrationBooleanCheckV1 {
  return {
    kind: "driver",
    id: probe.id,
    query: addDispatch(assembly, probe.sql, probe.parameters),
    equals: probe.equals,
  };
}

export function rebindDispatches(
  operations: readonly MigrationOperationV1[],
  dispatches: readonly MigrationDispatchV1[]
): MigrationOperationV1[] {
  return operations.map((operation) => ({
    ...operation,
    steps: operation.steps.map((step) => rebindStep(step, dispatches)),
  }));
}

function rebindStep(
  step: MigrationStepV1,
  dispatches: readonly MigrationDispatchV1[]
): MigrationStepV1 {
  const execute = takeDispatch(step.execute, dispatches);
  if (step.retry === "opaque") {
    return { retry: "opaque", execute };
  }
  return {
    retry: "proven",
    precheck: {
      ...step.precheck,
      query: takeDispatch(step.precheck.query, dispatches),
    },
    execute,
    postcheck: {
      ...step.postcheck,
      query: takeDispatch(step.postcheck.query, dispatches),
    },
  };
}

function takeDispatch(
  placeholder: MigrationDispatchV1,
  dispatches: readonly MigrationDispatchV1[]
): MigrationDispatchV1 {
  const found = dispatches[placeholder.offset];
  if (!found) {
    throw new MigrationError(
      "Compiled dispatch is missing from the SQL assembly",
      VibORMErrorCode.INTERNAL_ERROR
    );
  }
  return found;
}

export function rebindChecks(
  checks: readonly MigrationBooleanCheckV1[],
  dispatches: readonly MigrationDispatchV1[]
): MigrationBooleanCheckV1[] {
  return checks.map((check) => ({
    ...check,
    query: takeDispatch(check.query, dispatches),
  }));
}

export function rebindRollback(
  rollback: MigrationRollbackV1,
  dispatches: readonly MigrationDispatchV1[]
): MigrationRollbackV1 {
  if (rollback.kind === "irreversible") return rollback;
  return {
    ...rollback,
    operations: rebindDispatches(rollback.operations, dispatches),
  };
}

const CREATE_INDEX_CONCURRENTLY = /CREATE\s+INDEX\s+CONCURRENTLY/i;
const ALTER_TYPE_ADD_VALUE = /ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE/i;

function isNonTransactionalSql(driver: MigrationDriver, sql: string): boolean {
  if (CREATE_INDEX_CONCURRENTLY.test(sql)) return true;
  return (
    ALTER_TYPE_ADD_VALUE.test(sql) &&
    !driver.capabilities.supportsAddEnumValueInTransaction
  );
}

export function classifyGeneratedAtomicity(
  driver: MigrationDriver,
  operations: readonly DiffOperation[]
): AtomicityClass {
  if (driver.dialect === "mysql") return "stepwise";
  if (
    operations.some(
      (operation) =>
        operation.type === "alterEnum" &&
        (operation.addValues?.length ?? 0) > 0 &&
        !driver.capabilities.supportsAddEnumValueInTransaction
    )
  ) {
    return "stepwise";
  }
  return "transactional";
}

export function assertTransactionalBoundaryHonored(
  supportsTransactions: boolean,
  requested: "transactional" | "stepwise" | null
): void {
  if (requested === "transactional" && !supportsTransactions) {
    throw new MigrationError(
      "This producer cannot honor a transactional manual boundary",
      VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER
    );
  }
}

export function classifyStoredAtomicity(
  driver: MigrationDriver,
  requested: "transactional" | "stepwise" | null,
  operations: readonly MigrationOperationV1[],
  blob?: Uint8Array
): AtomicityClass {
  if (requested === "transactional") {
    if (driver.dialect === "mysql") {
      throw new MigrationError(
        "This provider cannot honor a transactional manual boundary",
        VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER
      );
    }
    return "transactional";
  }
  if (requested === "stepwise") return "stepwise";
  if (driver.dialect === "mysql") return "stepwise";
  if (blob) {
    const texts = operations.flatMap((operation) =>
      operation.steps.map((step) => sliceDispatch(blob, step.execute))
    );
    if (texts.some((text) => isNonTransactionalSql(driver, text))) {
      return "stepwise";
    }
  }
  return "transactional";
}

export function encodeParameter(value: unknown): MigrationParameterV1 {
  if (value === null || value === undefined) return { kind: "null" };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MigrationError(
        "SQL parameters refuse NaN and Infinity",
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
    return { kind: "number", value };
  }
  if (typeof value === "bigint")
    return { kind: "bigint", value: value.toString() };
  if (value instanceof Date)
    return { kind: "date-time", value: value.toISOString() };
  if (value instanceof Uint8Array) {
    return { kind: "bytes", value: encodeBase64(value) };
  }
  const decimal = canonicalizeDecimalValue(value);
  if (decimal !== undefined) return { kind: "decimal", value: decimal };
  if (typeof value === "function" || typeof value === "symbol") {
    throw new MigrationError(
      "SQL parameters refuse functions and symbols",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  return { kind: "json", value };
}

export function decodeParameter(
  parameter: MigrationParameterV1,
  targetNamespace?: string
): unknown {
  switch (parameter.kind) {
    case "null":
      return null;
    case "target-namespace":
      if (targetNamespace === undefined) {
        throw new MigrationError(
          "A stored target-namespace parameter requires a resolved migration namespace",
          VibORMErrorCode.MIGRATION_INVALID_STATE
        );
      }
      return targetNamespace;
    case "boolean":
    case "string":
    case "number":
    case "json":
      return parameter.value;
    case "bigint":
      return BigInt(parameter.value);
    case "bytes": {
      const bytes = decodeCanonicalBase64(parameter.value);
      if (bytes === undefined) {
        throw new MigrationError(
          "Stored bytes parameter is not canonical Base64",
          VibORMErrorCode.MIGRATION_INVALID_ESTATE
        );
      }
      return bytes;
    }
    case "date-time":
      return new Date(parameter.value);
    case "decimal":
      return parameter.value;
    default: {
      const kind: never = parameter;
      throw new MigrationError(
        `Unknown SQL parameter kind: ${JSON.stringify(kind)}`,
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
  }
}
