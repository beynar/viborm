import { isDestructiveOperation } from "./differ";
/**
 * One compiler: DiffOperation and manual Sql become structured operations
 * that share one SQL blob. No delimiter split.
 */

import type { Sql } from "@sql";
import { MigrationError, VibORMErrorCode } from "../errors";
import { canonicalDecimalText } from "../validation/primitives/decimal-value";
import { decodeCanonicalBase64, encodeBase64 } from "./base64";
import {
  type CatalogProbe,
  probeForGeneratedStatement,
} from "./catalog-probes";
import type { DDLContext, MigrationDriver } from "./drivers";
import { invertOperations } from "./invert";
import type { SqlAssembly } from "./sql-assembly";
import { sliceDispatch } from "./sql-blob";
import { needsEnumAdditionCommitBoundary } from "./statement-safety";
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

export interface CompiledTransition {
  readonly operations: readonly MigrationOperationV1[];
  readonly rollback: MigrationRollbackV1;
  readonly originChecks: readonly MigrationBooleanCheckV1[];
  readonly requestedForwardBoundary: "transactional" | "stepwise" | null;
  readonly atomicity: AtomicityClass;
  readonly warnings?: readonly string[];
}

/** The SQL each step of `operations` executes, in order. */
export function stepStatements(
  blob: Uint8Array,
  operations: readonly MigrationOperationV1[]
): string[] {
  return operations.flatMap((operation) =>
    operation.steps.map((step) => sliceDispatch(blob, step.execute))
  );
}

/**
 * Contiguous edges of one boundary share a commit, except that an edge adding
 * a PostgreSQL enum value ends its group: a later edge may use that value,
 * which PostgreSQL refuses until the addition commits (55P04).
 */
export function groupContiguousAtomicity<
  T extends { readonly boundary: string },
>(
  items: readonly T[],
  statementsOf: (item: T) => readonly string[]
): readonly {
  readonly boundary: T["boundary"];
  readonly items: readonly T[];
}[] {
  const groups: {
    boundary: T["boundary"];
    items: T[];
  }[] = [];
  let mustCommit = false;
  for (const item of items) {
    const current = groups.at(-1);
    if (current?.boundary === item.boundary && !mustCommit) {
      current.items.push(item);
    } else {
      groups.push({ boundary: item.boundary, items: [item] });
    }
    mustCommit = needsEnumAdditionCommitBoundary(statementsOf(item));
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
  const inverse = invertOperations(
    [...operations],
    currentSchema,
    driver.projectNativeRename.bind(driver),
    driver.generatedPrimaryKeyName.bind(driver)
  );
  const missingBackfill = inverse.operations.find(
    (operation) =>
      operation.type === "addColumn" &&
      !operation.column.nullable &&
      operation.column.default === undefined
  );
  const irreversibleReason =
    missingBackfill && missingBackfill.type === "addColumn"
      ? `Rollback cannot restore required column "${missingBackfill.tableName}.${missingBackfill.column.name}" without its lost data or an explicit backfill. Author a manual rollback.`
      : inverse.operations
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
              operations: inverse.operations
                .map((operation, index) =>
                  compileGeneratedOperation(
                    operation,
                    driver,
                    destination,
                    desiredSchema,
                    inverse.operations,
                    index,
                    assembly
                  )
                )
                .filter((operation) => operation.steps.length > 0),
            };
  return {
    operations: compiled,
    rollback,
    warnings: inverse.warnings,
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
    followingOperations: batch.slice(index + 1),
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
    label:
      "tableName" in operation
        ? `${operation.type} ${operation.tableName}${"columnName" in operation ? `.${operation.columnName}` : "column" in operation ? `.${operation.column.name}` : ""}`
        : operation.type,
    origin: "generated",
    risk: isDestructiveOperation(operation) ? "destructive" : "safe",
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
  const operations = compileManualOperations(
    up,
    dialect,
    assembly,
    "forward",
    requested
  );
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
            "rollback",
            rollback.execution
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
  prefix: string,
  execution: AtomicityClass
): MigrationOperationV1[] {
  if (fragments.length === 0) {
    throw new MigrationError(
      `Manual ${prefix} program must contain at least one SQL dispatch`,
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  return fragments.map((fragment, index) => {
    const text = fragment.toStatement(dialect === "postgresql" ? "$n" : "?");
    if (text.trim().length === 0) {
      throw new MigrationError(
        `Manual ${prefix} SQL dispatch ${index} must contain non-whitespace text`,
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
    // Refused before the state is published: sent after BEGIN, PostgreSQL
    // rejects it (25001), so the transition could never apply.
    if (execution === "transactional" && CONCURRENTLY.test(text)) {
      throw new MigrationError(
        `Manual ${prefix} SQL dispatch ${index} runs CONCURRENTLY, which PostgreSQL refuses inside a transaction. Declare execution: "stepwise" for it.`,
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
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

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${IDENTIFIER}(?:\.${IDENTIFIER})?`;

/**
 * A statement PostgreSQL refuses inside a transaction block (25001):
 * `CREATE [UNIQUE] INDEX`, `DROP INDEX`, `REINDEX INDEX|TABLE|SCHEMA|DATABASE`
 * and `REINDEX (…, CONCURRENTLY)` with `CONCURRENTLY`, and `DETACH PARTITION
 * … CONCURRENTLY`. `REFRESH MATERIALIZED VIEW CONCURRENTLY` runs in a
 * transaction and is not one.
 */
const CONCURRENTLY = new RegExp(
  String.raw`\b(?:INDEX|TABLE|SCHEMA|DATABASE|PARTITION\s+${QUALIFIED})\s+CONCURRENTLY\b|\bREINDEX\s*\([^)]*\bCONCURRENTLY\b`,
  "i"
);
const ALTER_TYPE_ADD_VALUE = /ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE/i;

/** `CREATE TABLE <name>` (group 1), or `ALTER TABLE <name>` (2) and its actions (3). */
const TABLE_STATEMENT = new RegExp(
  String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL|TEMP|TEMPORARY|UNLOGGED)\s+)*TABLE\s+(?!IF\s+NOT\s+EXISTS\b)(${QUALIFIED})|\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})([^;]*)`,
  "gi"
);
/** Each action that rewrites or scans the table, and how a refusal names it. */
const TABLE_REWRITES: readonly (readonly [RegExp, (name: string) => string])[] =
  [
    [
      new RegExp(
        String.raw`\bALTER\s+(?:COLUMN\s+)?(${IDENTIFIER})\s+(?:SET\s+DATA\s+)?TYPE\b`,
        "i"
      ),
      (column) => `column type change of ${column}`,
    ],
    [
      new RegExp(
        String.raw`\bALTER\s+(?:COLUMN\s+)?(${IDENTIFIER})\s+SET\s+NOT\s+NULL\b`,
        "i"
      ),
      (column) => `SET NOT NULL on ${column}`,
    ],
    [
      new RegExp(
        String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b)(${IDENTIFIER})[\s\S]*?(?:\b(?:gen_random_uuid|uuidv[47]|uuid_generate_v[14]|random|clock_timestamp|timeofday|nextval)\s*\(|\b(?:SMALL|BIG)?SERIAL\b|\bGENERATED\b)`,
        "i"
      ),
      (column) => `volatile default on new column ${column}`,
    ],
    [
      // `NOT VALID` counts up to the next `, ADD` action, not past it.
      new RegExp(
        String.raw`\bADD\s+(?:CONSTRAINT\s+${IDENTIFIER}\s+)?(FOREIGN\s+KEY|CHECK)\b(?!(?:(?!,\s*ADD\b)[\s\S])*\bNOT\s+VALID\b)`,
        "i"
      ),
      (constraint) => `${constraint.toUpperCase()} validation`,
    ],
  ];

/**
 * The PostgreSQL statements of `program` that rewrite or scan an existing
 * table while holding a lock that blocks it (T5a): a column type change (an
 * enum replacement and a decimal descriptor change are ones), `SET NOT NULL`,
 * a new column whose default is volatile, and a FOREIGN KEY or CHECK added
 * without `NOT VALID`. One entry per `ALTER TABLE`, naming its table as the
 * statement spells it and its first such action. A table the program has
 * already created by that spelling is empty, so it is left out (a force
 * reset, a drop and recreate). A plain `CREATE INDEX` (writes blocked, reads
 * not) is not one.
 */
export function tableRewrites(
  program: readonly string[]
): { readonly table: string; readonly operation: string }[] {
  const created = new Set<string>();
  return program.flatMap((statement) =>
    [...statement.matchAll(TABLE_STATEMENT)].flatMap(
      ([, made, table, clause]) => {
        if (made) created.add(made);
        if (!table || created.has(table)) return [];
        for (const [pattern, name] of TABLE_REWRITES) {
          const action = pattern.exec(clause ?? "")?.[1];
          if (action) return [{ table, operation: name(action) }];
        }
        return [];
      }
    )
  );
}

function isNonTransactionalSql(driver: MigrationDriver, sql: string): boolean {
  if (CONCURRENTLY.test(sql)) return true;
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
  if (
    blob &&
    stepStatements(blob, operations).some((text) =>
      isNonTransactionalSql(driver, text)
    )
  ) {
    return "stepwise";
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
  const decimal = canonicalDecimalText(value);
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
