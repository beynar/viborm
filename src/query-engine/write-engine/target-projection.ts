import type { Model } from "@schema/model";
import type { PolymorphicStorageColumn } from "@schema/relation";
import type { Sql } from "@sql";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import { buildScalarSqlValueForScalar } from "../builders/values-builder";
import { buildFindUnique } from "../operations/find-unique";
import { getPrimaryKeyValuesFromRecord } from "../operations/mutation-identity";
import type { QueryScope } from "../types";
import { presenceGuard } from "./fragment-builders";
import type {
  Failure,
  GuardStep,
  StatementOutputSource,
} from "./OperationFragment";

/**
 * Every public field and private column a compiler consumes from a captured row.
 *
 * `identityFields` is the target's ROW KEY — the complete primary key in schema
 * order — and is the only thing a captured UPDATE/DELETE/guard may address the
 * selected record by. `fields` opens with that row key and continues with the
 * other target fields compilation demands, which include REFERENCE-KEY fields a
 * relation points at when they are not row-key fields (CONTEXT.md keeps those two
 * questions apart). This carries no mapping from child storage members to the
 * fields they reference: that correspondence is bound relation topology, and a
 * projection only says which target values the probe publishes.
 */
export interface TargetProjection {
  readonly identityFields: readonly string[];
  readonly fields: readonly string[];
  readonly columns: readonly PolymorphicStorageColumn[];
}

/**
 * The row key leads `fields` so a caller never has to pass a primary-key field
 * beside a projection, and the remaining demanded fields keep their request order
 * after it. Duplicates collapse, which keeps the published output list and the
 * probe's `select` one field per name.
 */
export function buildTargetProjection(
  model: Model<any>,
  requiredFields: readonly string[] = [],
  columns: readonly PolymorphicStorageColumn[] = []
): TargetProjection {
  const identityFields = getPrimaryKeyFields(model);
  return {
    identityFields,
    fields: [...new Set([...identityFields, ...requiredFields])],
    columns,
  };
}

export function targetProjectionColumns(
  scope: QueryScope,
  projection: TargetProjection,
  qualifier = scope.rootAlias
): { readonly name: string; readonly sql: Sql }[] {
  return projection.columns.map((column) => ({
    name: column.name,
    sql: scope.adapter.identifiers.aliased(
      scope.adapter.identifiers.column(qualifier, column.name),
      column.name
    ),
  }));
}

export function targetProjectionOutputs(
  projection: TargetProjection,
  optional = false
): Record<string, StatementOutputSource> {
  return Object.fromEntries(
    [
      ...projection.fields,
      ...projection.columns.map((column) => column.name),
    ].map((field) => [
      field,
      {
        kind: "firstRowField" as const,
        field,
        ...(optional ? { optional: true } : {}),
      },
    ])
  );
}

/** The probe/guard `select` that publishes the whole row key. */
export function targetProjectionRowKeySelect(
  projection: TargetProjection
): Record<string, boolean> {
  return Object.fromEntries(
    projection.identityFields.map((field) => [field, true])
  );
}

/**
 * The probe `select` that publishes every demanded field — the row key plus the
 * reference-key and scalar fields compilation asked for, in `fields` order, which
 * is the same order {@link targetProjectionOutputs} publishes them in.
 */
export function targetProjectionSelect(
  projection: TargetProjection
): Record<string, boolean> {
  return Object.fromEntries(projection.fields.map((field) => [field, true]));
}

/** Existing-row guard addressed only by one already-resolved complete row key. */
export function completeTargetPresenceGuard(
  scope: QueryScope,
  id: string,
  identity: Readonly<Record<string, unknown>>,
  failure: Failure
): GuardStep {
  const projection = buildTargetProjection(scope.model);
  return presenceGuard(
    id,
    buildFindUnique(scope, {
      where: buildPrimaryKeyWhereUnique(scope.model, identity),
      select: targetProjectionRowKeySelect(projection),
    }),
    failure
  );
}

/**
 * The captured row key as a `whereUnique` — what a targeted UPDATE or DELETE
 * addresses the selected record by, every member of it.
 *
 * The read of the captured members is {@link getPrimaryKeyValuesFromRecord}, the
 * one extractor this codebase has for "the row key values inside this record",
 * and it is reused rather than reimplemented — so its arity check is the only one
 * and its message is INHERITED VERBATIM, including the "Cannot refetch mutation
 * result …" wording it carries for the refetch seam that first needed it. A
 * captured member is missing only when a probe published fewer fields than the
 * projection declared, which is an engine fault either way; reworded copies of
 * that error would be a second extractor in all but name.
 */
export function capturedTargetWhere(
  model: Model<any>,
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return buildPrimaryKeyWhereUnique(
    model,
    capturedTargetValues(model, projection, captured)
  );
}

/**
 * Every captured row-key member, in the projection's declared order.
 *
 * The projection is the ONE source of which members those are: it names them and
 * the extractor reads exactly them, so a member the probe did not publish raises
 * the inherited error instead of arriving as an absent value that the where
 * builder would quietly drop from the selector. `model` names the constraint the
 * members nest under and the model the error reports; it is not a second answer
 * to which fields the row key has.
 */
export function capturedTargetValues(
  model: Model<any>,
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return getPrimaryKeyValuesFromRecord(
    model,
    captured,
    model["~"].names.ts ?? "unknown",
    projection.identityFields
  );
}

/**
 * The captured row key as filter conjuncts — the shape a guard or probe `AND`s
 * beside its selector and membership terms, where a `whereUnique` discriminator
 * cannot go. Same extractor, same members, different consumer.
 */
export function capturedTargetFilters(
  model: Model<any>,
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>
): Record<string, unknown>[] {
  return Object.entries(capturedTargetValues(model, projection, captured)).map(
    ([field, value]) => ({ [field]: { equals: value } })
  );
}

/**
 * Address a set of captured rows by the complete row key.
 *
 * A scalar key keeps the established `IN` lowering. Compound keys use one
 * ordered AND group per row because portable row-value IN syntax and null
 * semantics differ between providers. The target projection remains the one
 * declaration of which members form the key, and the shared captured-value
 * extractor remains the one completeness check.
 */
export function capturedTargetSetWhere(
  model: Model<any>,
  projection: TargetProjection,
  captured: readonly Readonly<Record<string, unknown>>[]
): Record<string, unknown> {
  if (projection.identityFields.length === 1) {
    const field = projection.identityFields[0];
    if (field !== undefined) {
      return {
        [field]: {
          in: captured.map(
            (row) => capturedTargetValues(model, projection, row)[field]
          ),
        },
      };
    }
  }
  return {
    OR: captured.map((row) => ({
      AND: capturedTargetFilters(model, projection, row),
    })),
  };
}

/** Read one decoded complete row key in declared key order. */
export function readRowKey(
  model: Model<any>,
  record: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const projection = buildTargetProjection(model);
  return capturedTargetValues(model, projection, record);
}

/**
 * Stable lookup token for one decoded row key.
 *
 * Field names, declared scalar types, runtime value kinds, and payloads are all
 * length-delimited. This prevents textual collisions such as a decimal `"1"`
 * and a string `"1"`, adjacent compound members, or byte/text values with the
 * same printable spelling. A token is only an index hint: callers confirm a
 * match with {@link rowKeysEqual} before accepting it.
 */
export function rowKeyToken(
  model: Model<any>,
  record: Readonly<Record<string, unknown>>
): string {
  const projection = buildTargetProjection(model);
  const key = capturedTargetValues(model, projection, record);
  const fields = projection.identityFields;
  let token = lengthDelimited(String(fields.length));
  for (const field of fields) {
    const scalarType =
      model["~"].state.scalars[field]?.["~"].state.type ?? "unknown";
    token += lengthDelimited(field);
    token += lengthDelimited(scalarType);
    token += encodeRowKeyValue(key[field]);
  }
  return token;
}

/** Exact equality over decoded complete row-key values. */
export function rowKeysEqual(
  model: Model<any>,
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>
): boolean {
  const projection = buildTargetProjection(model);
  const leftKey = capturedTargetValues(model, projection, left);
  const rightKey = capturedTargetValues(model, projection, right);
  for (const field of projection.identityFields) {
    if (!rowKeyValuesEqual(leftKey[field], rightKey[field])) return false;
  }
  return true;
}

function encodeRowKeyValue(value: unknown): string {
  if (value === null) return lengthDelimited("null");
  if (value === undefined) return lengthDelimited("undefined");
  if (typeof value === "boolean") {
    return lengthDelimited(value ? "boolean:1" : "boolean:0");
  }
  if (typeof value === "bigint") {
    return lengthDelimited(`bigint:${value}`);
  }
  if (typeof value === "number") {
    const payload = Number.isNaN(value)
      ? "nan"
      : value === Number.POSITIVE_INFINITY
        ? "+infinity"
        : value === Number.NEGATIVE_INFINITY
          ? "-infinity"
          : Object.is(value, -0)
            ? "-0"
            : String(value);
    return lengthDelimited(`number:${payload}`);
  }
  if (typeof value === "string") {
    return lengthDelimited(`string:${value}`);
  }
  if (value instanceof Date) {
    return lengthDelimited(`date:${value.getTime()}`);
  }
  if (ArrayBuffer.isView(value)) {
    return lengthDelimited(`bytes:${bytesHex(viewBytes(value))}`);
  }
  return lengthDelimited(`other:${String(value)}`);
}

function lengthDelimited(value: string): string {
  return `${value.length}:${value}`;
}

function bytesHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

function rowKeyValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    return compareBytes(viewBytes(left), viewBytes(right)) === 0;
  }
  return false;
}

/**
 * ORDER a captured root set deterministically, by complete row key (plan §5.2
 * step 4, §6 K3 "applies limit before deterministic in-memory sorting").
 *
 * WHY THE ENGINE OWNS THIS AT ALL, measured rather than assumed: a bulk capture's
 * `ORDER BY` is CONDITIONAL on `limit`. `buildFindPagination` appends the identity
 * tie-breakers only when `take` is defined, so a CAPPED capture already arrives
 * ordered and this sort is a no-op over it, while an UNCAPPED capture arrives in
 * whatever order the provider felt like — the opposite of what one would guess, and
 * exactly why §5.2 asks for an in-memory sort AFTER the limit rather than an
 * `ORDER BY` in the capture SQL. Sorting here is therefore the ONLY thing that makes
 * "members execute in deterministic captured order" true for the uncapped case, and
 * it cannot be moved into the capture without changing which rows a capped capture
 * selects.
 *
 * DETERMINISTIC, NOT DATABASE COLLATION ORDER. Callers decode row-key values
 * through the normal scalar-result boundary before reaching this comparator, so
 * bigint, decimal, and temporal identities have one canonical JS representation
 * across providers. A string still compares by UTF-16 code unit here and by the
 * database's collation there; reproducing provider collations in JavaScript would
 * create a second SQL-ordering owner.
 *
 * Total over every value a row key can carry, in row-key field order:
 * `null`/absent first, then booleans, numbers and bigints numerically (they compare
 * across the two types), strings by code unit, `Date` by instant, byte arrays
 * lexicographically. Anything else falls back to its canonical text, which is total
 * and stable but orders "10" before "9". Values of DIFFERENT types
 * are separated by that type rank before any of it runs, so the comparator can never
 * answer 0 for two values that are not equal — the one property that would make the
 * execution order differ between two runs over the same captured set. The byte-array
 * rank is wider than any schema can reach (`blob().id()` throws, and blob is the only
 * byte-valued scalar), so it is exercised by the unit probe alone.
 */
export function sortCapturedRowKeys<T extends Record<string, unknown>>(
  identityFields: readonly string[],
  rows: readonly T[]
): T[] {
  return [...rows].sort((left, right) => {
    for (const field of identityFields) {
      const order = compareRowKeyValues(left[field], right[field]);
      if (order !== 0) return order;
    }
    return 0;
  });
}

/** The rank of a value's TYPE, so cross-type members stay totally ordered. */
function rowKeyValueRank(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number" || typeof value === "bigint") return 2;
  if (typeof value === "string") return 3;
  if (value instanceof Date) return 4;
  if (ArrayBuffer.isView(value)) return 5;
  return 6;
}

function compareRowKeyValues(left: unknown, right: unknown): number {
  const leftRank = rowKeyValueRank(left);
  const rightRank = rowKeyValueRank(right);
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  switch (leftRank) {
    case 0:
      return 0;
    case 1:
      return left === right ? 0 : left === false ? -1 : 1;
    case 2: {
      const leftNumber = left as number | bigint;
      const rightNumber = right as number | bigint;
      if (leftNumber < rightNumber) return -1;
      return leftNumber > rightNumber ? 1 : 0;
    }
    case 4:
      return compareRowKeyValues(
        (left as Date).getTime(),
        (right as Date).getTime()
      );
    case 5:
      // Through the VIEW's own window, not the whole backing buffer: a Node
      // `Buffer` from a driver is routinely a slice of a pooled allocation, so
      // reading `.buffer` alone would compare unrelated neighbouring bytes.
      return compareBytes(
        viewBytes(left as ArrayBufferView),
        viewBytes(right as ArrayBufferView)
      );
    default: {
      const leftText = leftRank === 3 ? (left as string) : String(left);
      const rightText = rightRank === 3 ? (right as string) : String(right);
      if (leftText < rightText) return -1;
      return leftText > rightText ? 1 : 0;
    }
  }
}

function viewBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const leftByte = left[index] as number;
    const rightByte = right[index] as number;
    if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

/** Reassert every private value that influenced the compiled record branch. */
export function capturedTargetColumnPredicate(
  scope: QueryScope,
  projection: TargetProjection,
  captured: Readonly<Record<string, unknown>>,
  qualifier = scope.rootAlias
): Sql | undefined {
  const predicates = projection.columns.map((column) => {
    const target = scope.adapter.identifiers.column(qualifier, column.name);
    const value = captured[column.name];
    return value === null || value === undefined
      ? scope.adapter.operators.isNull(target)
      : scope.adapter.operators.eq(
          target,
          buildScalarSqlValueForScalar(scope, column.scalar, column.name, value)
        );
  });
  if (predicates.length === 0) return undefined;
  return predicates.length === 1
    ? predicates[0]
    : scope.adapter.operators.and(...predicates);
}
