import { QueryEngineError } from "@errors";
import { isSql, type Sql } from "@sql";
import type { ExpectedResultShape, Operation } from "./types";

export const READ_STEP_ID = "read:0";
export const WRITE_STEP_ID = "write:0";
export const WRITE_RESULT_ID = "write:0:result";

export type ProgramReadOperation =
  | "findUnique"
  | "findFirst"
  | "findMany"
  | "count"
  | "exist"
  | "aggregate"
  | "groupBy";

export type ProgramWriteOperation =
  | "create"
  | "createMany"
  | "createManyAndReturn"
  | "update"
  | "updateMany"
  | "updateManyAndReturn"
  | "delete"
  | "deleteMany"
  | "upsert";

const PROGRAM_READ_OPERATION_SET: ReadonlySet<Operation> = new Set([
  "findUnique",
  "findFirst",
  "findMany",
  "count",
  "exist",
  "aggregate",
  "groupBy",
]);

/** Materialize a mutation against rows previously captured by primary key. */
export interface CapturedMutationStatement {
  readonly kind: "capturedMutation";
  readonly operation: "update" | "updateMany" | "delete";
  readonly rowsFrom: string;
  readonly data?: Record<string, unknown>;
}

/** Read rows by primary keys captured before or produced by a mutation. */
export interface CapturedReadStatement {
  readonly kind: "capturedRead";
  readonly rowsFrom: string;
  readonly cardinality: "one" | "many";
  readonly afterUpdate?: Record<string, unknown>;
  readonly select?: Record<string, unknown>;
  readonly include?: Record<string, unknown>;
}

/** A data-only statement rebuilt by the compiler at execution lowering time. */
export interface OperationStatement {
  readonly kind: "operation";
  readonly operation:
    | "create"
    | "createMany"
    | "delete"
    | "deleteMany"
    | "findMany"
    | "findUnique"
    | "probe"
    | "update"
    | "updateMany";
  /** SQL table name of a related model; omitted for the root model. */
  readonly model?: string;
  readonly args: Record<string, unknown>;
  readonly lock?: "transaction";
}

/** A relation-owned statement materialized by `WriteOperations`. */
export interface RelationStatement {
  readonly kind: "relation";
  readonly operation:
    | "junctionDelete"
    | "junctionDeleteTargets"
    | "junctionInsert"
    | "junctionInsertMany"
    | "membershipDifference"
    | "membershipRead"
    | "membershipUpdateMany";
  readonly model: string;
  readonly relation: string;
  readonly args: Record<string, unknown>;
}

export interface ProducedValue {
  readonly kind: "producedValue";
  readonly id: string;
  readonly producer: string;
  readonly field: string;
  readonly source: "row" | "insertId";
}

/** One selected field from every row produced by a decision read. */
export interface ProducedRows {
  readonly kind: "producedRows";
  readonly id: string;
  readonly producer: string;
  readonly field: string;
}

export type ProducedOutput = ProducedValue | ProducedRows;

export interface DerivedValue {
  readonly kind: "derivedValue";
  readonly input: ProducedValue;
  readonly operation: "increment" | "decrement" | "multiply" | "divide";
  readonly operand: number | bigint;
}

/** Uses a branch-produced value when present, otherwise the selected fallback. */
export interface FallbackValue {
  readonly kind: "fallbackValue";
  readonly preferred: ProducedValue;
  readonly fallback: unknown;
}

export type ProgramStatement =
  | Sql
  | CapturedMutationStatement
  | CapturedReadStatement
  | OperationStatement
  | RelationStatement;

interface StepBase {
  readonly id: string;
  readonly statement: ProgramStatement;
  readonly produces: string;
  readonly producedValues?: readonly ProducedOutput[];
  /** Skip this step when the prerequisite affected/read row count is zero. */
  readonly requiresRowsFrom?: string;
}

export interface ReadStep extends StepBase {
  readonly kind: "read";
  /** Planning-time read used only while specializing an atomic batch. */
  readonly specializeStatement?: ProgramStatement;
  readonly expectedRows?:
    | { readonly kind: "exact"; readonly count: number }
    | { readonly kind: "sameAs"; readonly step: string };
  readonly missing?: "not-found";
  readonly failure?: ProgramFailure;
}

export interface WriteStep extends StepBase {
  readonly kind: "write";
  readonly expectedCardinality: "one" | "many";
  readonly affectedRows: "exact" | "unrestricted";
  readonly missing?: "not-found";
  readonly maximumAffectedRows?: number | { readonly rowsFrom: string };
  readonly onUniqueConflict?: "skip";
}

export interface ProgramFailure {
  readonly kind: "nestedWrite" | "notFound" | "query";
  readonly message: string;
  readonly relation?: string;
  readonly raceable: boolean;
}

export interface GuardStep {
  readonly id: string;
  readonly kind: "guard";
  readonly premise:
    | {
        readonly kind: "exists" | "notExists";
        readonly statement: ProgramStatement;
      }
    | {
        readonly kind: "notExistsWhenChanged";
        readonly before: readonly unknown[];
        readonly after: readonly unknown[];
        readonly statement: ProgramStatement;
      }
    | {
        readonly kind: "affectedRows";
        readonly step: string;
        readonly minimum: number;
        /**
         * Adapter-owned SQL proving the same postcondition as the row-count
         * premise. The compiler must establish that equivalence.
         */
        readonly statement: Sql;
      };
  readonly failure: ProgramFailure;
}

/** A branch-local validation failure selected by an earlier program decision. */
export interface FailureStep {
  readonly id: string;
  readonly kind: "failure";
  readonly failure: ProgramFailure;
}

export interface BranchStep {
  readonly id: string;
  readonly kind: "branch";
  readonly premise: {
    readonly step: string;
    readonly test: "hasRows";
  };
  readonly pin: {
    readonly whenTrue: GuardStep;
    readonly whenFalse: GuardStep | UniqueConflictPin | NoBranchPin;
  };
  readonly whenTrue: readonly OperationStep[];
  readonly whenFalse: readonly OperationStep[];
}

/** A missing premise enforced neither by a guard nor an exact unique target. */
export interface NoBranchPin {
  readonly kind: "none";
}

/** A missing-branch create whose exact unique target is pinned by the database. */
export interface UniqueConflictPin {
  readonly kind: "uniqueConflict";
  readonly step: string;
  readonly where: Record<string, unknown>;
  readonly create: Record<string, unknown>;
  readonly target: {
    readonly fields: readonly string[];
    readonly table: string;
    readonly columns: readonly string[];
    readonly constraints: readonly string[];
  };
}

export type OperationStep =
  | ReadStep
  | WriteStep
  | GuardStep
  | BranchStep
  | FailureStep;

export interface StepResultSource {
  readonly step: string;
  readonly result: string;
  readonly inputIndex?: number;
}

export interface OperationResultSource {
  readonly kind: "rows" | "rowCount";
  readonly results: readonly StepResultSource[];
}

export interface OperationResult {
  readonly source: OperationResultSource;
  readonly operation: ProgramReadOperation | ProgramWriteOperation;
  readonly args: Record<string, unknown>;
  readonly shape?: ExpectedResultShape;
  /** Public resolution must execute before commit for operation-atomic writes. */
  readonly requiresAtomicResolution?: boolean;
}

export interface OperationProgram {
  readonly atomicity: "statement" | "operation";
  readonly steps: readonly OperationStep[];
  readonly result: OperationResult;
}

export function createOperationProgram(
  atomicity: OperationProgram["atomicity"],
  steps: readonly OperationStep[],
  operation: ProgramWriteOperation,
  args: Record<string, unknown>,
  source: OperationResultSource,
  shape?: ExpectedResultShape,
  requiresAtomicResolution = false
): OperationProgram {
  return {
    atomicity,
    steps,
    result: {
      source,
      operation,
      args,
      ...(shape ? { shape } : {}),
      ...(requiresAtomicResolution ? { requiresAtomicResolution: true } : {}),
    },
  };
}

export function createReadStep(
  id: string,
  statement: ProgramStatement,
  contract: Pick<
    ReadStep,
    | "expectedRows"
    | "missing"
    | "requiresRowsFrom"
    | "producedValues"
    | "failure"
    | "specializeStatement"
  > = {}
): ReadStep {
  return { id, kind: "read", statement, produces: `${id}:result`, ...contract };
}

export function createWriteStep(
  id: string,
  statement: ProgramStatement,
  contract: Pick<
    WriteStep,
    | "expectedCardinality"
    | "affectedRows"
    | "missing"
    | "maximumAffectedRows"
    | "onUniqueConflict"
    | "requiresRowsFrom"
    | "producedValues"
  >
): WriteStep {
  return {
    id,
    kind: "write",
    statement,
    produces: `${id}:result`,
    ...contract,
  };
}

export function createResultSource(
  step: ReadStep | WriteStep,
  inputIndex?: number
): StepResultSource {
  return {
    step: step.id,
    result: step.produces,
    ...(inputIndex === undefined ? {} : { inputIndex }),
  };
}

export function isProgramReadOperation(
  operation: Operation
): operation is ProgramReadOperation {
  return PROGRAM_READ_OPERATION_SET.has(operation);
}

export function resolveOperationValues(
  value: Record<string, unknown>,
  values: ReadonlyMap<string, unknown>
): Record<string, unknown> {
  return resolveOperationValue(value, values) as Record<string, unknown>;
}

export function resolveProgramValues(
  programValues: readonly unknown[],
  values: ReadonlyMap<string, unknown>
): unknown[] {
  return programValues.map((value) => resolveOperationValue(value, values));
}

export function programValuesEqual(
  left: readonly unknown[],
  right: readonly unknown[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => programValueEqual(value, right[index]));
}

export function operationSelection(args: Record<string, unknown>): {
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
} {
  return {
    ...(isRecord(args.select) ? { select: args.select } : {}),
    ...(isRecord(args.include) ? { include: args.include } : {}),
  };
}

function resolveOperationValue(
  value: unknown,
  values: ReadonlyMap<string, unknown>
): unknown {
  if (isProducedValue(value)) {
    if (!values.has(value.id)) {
      throw new QueryEngineError(
        `Produced value '${value.id}' was consumed before '${value.producer}' completed.`
      );
    }
    return values.get(value.id);
  }
  if (isProducedRows(value)) {
    if (!values.has(value.id)) {
      throw new QueryEngineError(
        `Produced rows '${value.id}' were consumed before '${value.producer}' completed.`
      );
    }
    return values.get(value.id);
  }
  if (isFallbackValue(value)) {
    return values.has(value.preferred.id)
      ? values.get(value.preferred.id)
      : resolveOperationValue(value.fallback, values);
  }
  if (isDerivedValue(value)) {
    const input = resolveOperationValue(value.input, values);
    return applyDerivedValue(input, value.operation, value.operand);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveOperationValue(entry, values));
  }
  if (!isPlainRecord(value) || isSql(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolveOperationValue(entry, values),
    ])
  );
}

function isDerivedValue(value: unknown): value is DerivedValue {
  return isRecord(value) && value.kind === "derivedValue";
}

function programValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return (
      left.length === right.length &&
      left.every((byte, index) => byte === right[index])
    );
  }
  return false;
}

function applyDerivedValue(
  input: unknown,
  operation: DerivedValue["operation"],
  operand: number | bigint
): number | bigint {
  if (typeof input !== "number" && typeof input !== "bigint") {
    throw new QueryEngineError(
      `Cannot apply '${operation}' to a non-portable produced numeric value.`
    );
  }
  if (operation === "divide" && (operand === 0 || operand === 0n)) {
    throw new QueryEngineError("Cannot divide a produced value by zero.");
  }
  if (typeof input === "bigint" || typeof operand === "bigint") {
    const integerInput = toPortableBigInt(input);
    const integerOperand = toPortableBigInt(operand);
    if (operation === "increment") return integerInput + integerOperand;
    if (operation === "decrement") return integerInput - integerOperand;
    if (operation === "multiply") return integerInput * integerOperand;
    return integerInput / integerOperand;
  }
  if (typeof input !== "number" || typeof operand !== "number") {
    throw new QueryEngineError(
      "Produced numeric values use incompatible types."
    );
  }
  if (operation === "increment") return input + operand;
  if (operation === "decrement") return input - operand;
  if (operation === "multiply") return input * operand;
  return input / operand;
}

function toPortableBigInt(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  throw new QueryEngineError(
    "Cannot combine an unsafe numeric value with an integer database carrier."
  );
}

function isProducedValue(value: unknown): value is ProducedValue {
  return (
    isRecord(value) &&
    value.kind === "producedValue" &&
    typeof value.id === "string"
  );
}

function isProducedRows(value: unknown): value is ProducedRows {
  return (
    isRecord(value) &&
    value.kind === "producedRows" &&
    typeof value.id === "string"
  );
}

function isFallbackValue(value: unknown): value is FallbackValue {
  return isRecord(value) && value.kind === "fallbackValue";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
