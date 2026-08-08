import { type Sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import {
  createChildScope,
  getColumnName,
  getTableName,
} from "../context";
import {
  POLYMORPHIC_RESULT_STATE_KEY,
  POLYMORPHIC_RESULT_STATE_INVALID,
  POLYMORPHIC_RESULT_STATE_LINKED,
} from "../result-aliases";
import type { PolymorphicRelationInfo, QueryScope } from "../types";
import type { BuildNestedSelection } from "./include-builder";
import { assembleInnerQuery } from "./include-query";
import { resolvePolymorphicEdge } from "./polymorphic-relation";

export type BuildPolymorphicNestedWhere = (
  scope: QueryScope,
  where: Record<string, unknown>
) => Sql | undefined;

/** Build a direct polymorphic projection as one portable correlated CASE expression. */
export function buildPolymorphicRead(
  buildNestedSelection: BuildNestedSelection,
  scope: QueryScope,
  relation: PolymorphicRelationInfo,
  projection: unknown,
  parentAlias: string
): Sql {
  const { adapter } = scope;
  const typeColumn = adapter.identifiers.column(
    parentAlias,
    relation.storage.typeColumn.name
  );
  const idColumn = adapter.identifiers.column(
    parentAlias,
    relation.storage.idColumn.name
  );
  const bothNull = adapter.operators.and(
    adapter.operators.isNull(typeColumn),
    adapter.operators.isNull(idColumn)
  );
  const branches: Array<{ readonly when: Sql; readonly then: Sql }> = [
    { when: bothNull, then: adapter.literals.null() },
  ];
  const textLiteral = (value: string) =>
    adapter.expressions.cast(adapter.literals.value(value), "text");

  for (const publicType of relation.storage.members.keys()) {
    const edge = resolvePolymorphicEdge(scope, relation, publicType);
    const targetAlias = scope.nextAlias();
    const targetScope = createChildScope(scope, edge.targetModel, targetAlias);
    const targetProjection = projectionFor(projection, publicType);
    const targetJson = buildNestedSelection(
      targetScope,
      targetProjection.select,
      targetProjection.include
    ).sql;
    const targetColumn = adapter.identifiers.column(
      targetAlias,
      getColumnName(edge.targetModel, edge.referencedField)
    );
    const targetQuery = assembleInnerQuery(adapter, {
      selectExpr: targetJson,
      from: adapter.identifiers.table(
        getTableName(edge.targetModel),
        targetAlias
      ),
      where: adapter.operators.eq(targetColumn, idColumn),
      take: 1,
    });
    const linked = adapter.json.objectFromColumns([
      [
        POLYMORPHIC_RESULT_STATE_KEY,
        textLiteral(POLYMORPHIC_RESULT_STATE_LINKED),
      ],
      ["type", textLiteral(publicType)],
      ["data", adapter.json.document(adapter.subqueries.scalar(targetQuery))],
    ]);
    branches.push({
      when: adapter.operators.and(
        adapter.operators.exactTextEq(
          typeColumn,
          adapter.literals.value(edge.storedType)
        ),
        adapter.operators.isNotNull(idColumn)
      ),
      then: linked,
    });
  }

  const invalid = adapter.json.objectFromColumns([
    [
      POLYMORPHIC_RESULT_STATE_KEY,
      textLiteral(POLYMORPHIC_RESULT_STATE_INVALID),
    ],
    ["storedType", typeColumn],
    ["hasId", adapter.json.boolean(adapter.operators.isNotNull(idColumn))],
  ]);
  return adapter.expressions.caseWhen(branches, invalid);
}

/** Build a direct polymorphic type/null/target filter. */
export function buildPolymorphicFilterSql(
  buildNestedWhere: BuildPolymorphicNestedWhere,
  scope: QueryScope,
  relation: PolymorphicRelationInfo,
  filter: unknown,
  parentAlias: string
): Sql {
  const { adapter } = scope;
  const typeColumn = adapter.identifiers.column(
    parentAlias,
    relation.storage.typeColumn.name
  );
  const idColumn = adapter.identifiers.column(
    parentAlias,
    relation.storage.idColumn.name
  );
  if (filter === null) {
    return adapter.operators.and(
      adapter.operators.isNull(typeColumn),
      adapter.operators.isNull(idColumn)
    );
  }

  const record = filter as Record<string, unknown>;
  const publicType = String(record.type);
  const edge = resolvePolymorphicEdge(scope, relation, publicType);
  const discriminator = adapter.operators.exactTextEq(
    typeColumn,
    adapter.literals.value(edge.storedType)
  );
  const nested = isRecord(record.is)
    ? record.is
    : isRecord(record.isNot)
      ? record.isNot
      : undefined;
  if (!nested) return discriminator;

  const targetAlias = scope.nextAlias();
  const targetScope = createChildScope(scope, edge.targetModel, targetAlias);
  const targetColumn = adapter.identifiers.column(
    targetAlias,
    getColumnName(edge.targetModel, edge.referencedField)
  );
  const correlation = adapter.operators.eq(targetColumn, idColumn);
  const nestedWhere = buildNestedWhere(targetScope, nested);
  const predicate = nestedWhere
    ? adapter.operators.and(correlation, nestedWhere)
    : correlation;
  const existsQuery = adapter.subqueries.existsCheck(
    adapter.identifiers.table(getTableName(edge.targetModel), targetAlias),
    predicate
  );
  const targetPredicate = Object.hasOwn(record, "is")
    ? adapter.operators.exists(existsQuery)
    : adapter.operators.notExists(existsQuery);
  return adapter.operators.and(discriminator, targetPredicate);
}

function projectionFor(
  projection: unknown,
  publicType: string
): {
  readonly select: Record<string, unknown> | undefined;
  readonly include: Record<string, unknown> | undefined;
} {
  if (!isRecord(projection)) return { select: undefined, include: undefined };
  const member = projection[publicType];
  if (!isRecord(member)) return { select: undefined, include: undefined };
  return {
    select: isRecord(member.select) ? member.select : undefined,
    include: isRecord(member.include) ? member.include : undefined,
  };
}
