import type { PolymorphicStorageColumn } from "@schema/relation";
import type { Sql } from "@sql";
import { buildScalarSqlValueForScalar } from "../builders/values-builder";
import type { QueryScope } from "../types";
import type { StatementOutputSource } from "./OperationFragment";

/** Every public field and private column a compiler consumes from a captured row. */
export interface TargetProjection {
  readonly fields: readonly string[];
  readonly columns: readonly PolymorphicStorageColumn[];
}

export function buildTargetProjection(
  fields: readonly string[],
  columns: readonly PolymorphicStorageColumn[] = []
): TargetProjection {
  return { fields, columns };
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
