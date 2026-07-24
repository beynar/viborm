// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this value module RelationProgramValues.
import { getPrimaryKeyFields } from "./builders/correlation-utils";
import type { FkDirection } from "./builders/relation-data-builder";
import { getTableName } from "./context";
import type {
  DerivedValue,
  FallbackValue,
  OperationStatement,
  ProducedValue,
  ProgramFailure,
} from "./operation-program";
import type { QueryScope, RelationInfo } from "./types";
import { NestedWriteError, QueryEngineError } from "./types";

export type ProgramValue =
  | unknown
  | ProducedValue
  | DerivedValue
  | FallbackValue;
export type ProgramRecord = Record<string, ProgramValue>;

export function relationStatement(
  ctx: QueryScope,
  operation: OperationStatement["operation"],
  args: Record<string, unknown>
): OperationStatement {
  const { lock, ...statementArgs } = args;
  return {
    kind: "operation",
    operation,
    model: getTableName(ctx.model),
    args: statementArgs,
    ...(lock === "transaction" ? { lock } : {}),
  };
}

export function correlatedWhere(
  fk: FkDirection,
  parentValues: ProgramRecord,
  target?: Record<string, unknown>
): Record<string, unknown> {
  const correlation = Object.fromEntries(
    fk.holdsFK
      ? fk.pkFields.map((field, index) => [
          field,
          { equals: parentValues[fk.fkFields[index]!] },
        ])
      : fk.fkFields.map((field, index) => [
          field,
          { equals: parentValues[fk.pkFields[index]!] },
        ])
  );
  return target ? andWhere(correlation, target) : correlation;
}

export function primaryKeyWhere(
  ctx: QueryScope,
  values: ProgramRecord
): Record<string, unknown> {
  const fields = getPrimaryKeyFields(ctx.model);
  if (fields.length === 1) return { [fields[0]!]: values[fields[0]!] };
  const name = ctx.model["~"].state.primaryKey?.name ?? fields.join("_");
  return {
    [name]: Object.fromEntries(fields.map((field) => [field, values[field]])),
  };
}

export function primaryKeyFilter(
  ctx: QueryScope,
  values: ProgramRecord
): Record<string, unknown> {
  return Object.fromEntries(
    getPrimaryKeyFields(ctx.model).map((field) => [
      field,
      { equals: values[field] },
    ])
  );
}

export function pickIdentity(
  ctx: QueryScope,
  values: ProgramRecord
): ProgramRecord {
  return Object.fromEntries(
    getPrimaryKeyFields(ctx.model).map((field) => {
      const value = values[field];
      if (value === undefined) {
        throw new QueryEngineError(
          `Missing primary key field '${field}' in relation update program.`
        );
      }
      return [field, value];
    })
  );
}

export function updatedValues(
  before: ProgramRecord,
  data: Record<string, unknown>
): ProgramRecord {
  const after = { ...before };
  for (const [field, update] of Object.entries(data)) {
    after[field] = updatedValue(before[field], update);
  }
  return after;
}

function updatedValue(before: ProgramValue, update: unknown): ProgramValue {
  if (!isRecord(update)) return update;
  if ("set" in update) return update.set;
  for (const operation of [
    "increment",
    "decrement",
    "multiply",
    "divide",
  ] as const) {
    const operand = update[operation];
    if (operand === undefined) continue;
    if (
      !isProducedValue(before) ||
      (typeof operand !== "number" && typeof operand !== "bigint")
    ) {
      throw new QueryEngineError(
        `Cannot derive updated primary key from '${operation}'.`
      );
    }
    return { kind: "derivedValue", input: before, operation, operand };
  }
  return update;
}

export function nullAssignments(
  fields: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, { set: null }]));
}

export function fkAssignments(
  fk: FkDirection,
  parent: ProgramRecord
): Record<string, unknown> {
  return Object.fromEntries(
    fk.fkFields.map((field, index) => [
      field,
      { set: parent[fk.pkFields[index]!] },
    ])
  );
}

export function childForeignKeys(
  fk: FkDirection,
  parent: ProgramRecord
): ProgramRecord {
  return Object.fromEntries(
    fk.fkFields.map((field, index) => [field, parent[fk.pkFields[index]!]])
  );
}

export function parentForeignKeys(
  fk: FkDirection,
  target: ProgramRecord
): ProgramRecord {
  return Object.fromEntries(
    fk.fkFields.map((field, index) => [field, target[fk.pkFields[index]!]])
  );
}

export function setAssignments(values: ProgramRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([field, value]) => [field, { set: value }])
  );
}

export function requiredFkFields(fk: FkDirection): string[] {
  return fk.fkFields.filter(
    (field) =>
      fk.fkHolder["~"].state.scalars[field]?.["~"].state.nullable !== true
  );
}

export function assertNullable(relation: RelationInfo, fk: FkDirection): void {
  const required = requiredFkFields(fk);
  if (required.length === 0) return;
  throw new NestedWriteError(
    `Cannot disconnect relation '${relation.name}' because foreign key field(s) ${required.join(", ")} are required.`,
    relation.name
  );
}

export function relationFailure(
  relation: RelationInfo,
  message: string
): ProgramFailure {
  return {
    kind: "nestedWrite",
    message,
    relation: relation.name,
    raceable: false,
  };
}

export function relationTargetFailure(
  relation: RelationInfo,
  operation: "connect" | "delete" | "disconnect" | "set" | "update"
): ProgramFailure {
  const parentSuffix =
    operation === "update" ||
    operation === "delete" ||
    operation === "disconnect"
      ? " for this parent"
      : "";
  return relationFailure(
    relation,
    `Cannot ${operation} relation '${relation.name}': target record was not found${parentSuffix}.`
  );
}

export function andWhere(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): Record<string, unknown> {
  return { AND: [left, right] };
}

export function records<T extends Record<string, unknown>>(
  value: T | T[]
): T[] {
  return Array.isArray(value) ? value : [value];
}

export function uniqueRecords<T extends Record<string, unknown>>(
  values: readonly T[]
): T[] {
  const unique: T[] = [];
  for (const value of values) {
    if (!unique.some((candidate) => recordsEqual(candidate, value))) {
      unique.push(value);
    }
  }
  return unique;
}

function recordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

export function normalize<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

export function requireRecord(
  value: unknown,
  operation: string,
  field: string
): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `Validated ${operation} arguments are missing a ${field} object.`
  );
}

function isProducedValue(value: unknown): value is ProducedValue {
  return isRecord(value) && value.kind === "producedValue";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
