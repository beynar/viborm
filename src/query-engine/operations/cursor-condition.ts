/**
 * Cursor condition
 *
 * Builds one null-aware lexicographic predicate against a single derived
 * cursor row. The cursor row's order values are selected once, then reused by
 * every equality prefix and strict-after branch.
 */

import { type Sql, sql } from "@sql";
import { scalarValueLiteral } from "../builders/values-builder";
import type { WhereUniqueEntry } from "../builders/where-unique-builder";
import { getColumnName, getTableName } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import type { NormalizedCursorOrder } from "./cursor-order";

type CursorComparison = {
  row: Sql;
  cursor: Sql;
  direction: NormalizedCursorOrder["direction"];
  nulls: NormalizedCursorOrder["nulls"];
};

export function buildCursorCondition(
  ctx: QueryScope,
  cursorEntries: WhereUniqueEntry[],
  order: NormalizedCursorOrder[]
): Sql {
  assertCursorValues(cursorEntries);

  if (order.length === 0) {
    throw new QueryEngineError(
      "Cursor pagination requires at least one scalar order field."
    );
  }

  const { adapter } = ctx;
  const sourceAlias = ctx.nextAlias();
  const cursorAlias = ctx.nextAlias();
  const cursorColumns = order.map((key, index) => {
    const sourceColumn = adapter.identifiers.column(
      sourceAlias,
      getColumnName(ctx.model, key.field)
    );
    return adapter.identifiers.aliased(
      sourceColumn,
      getCursorColumnAlias(index)
    );
  });
  const cursorWhere = cursorEntries.map(({ fieldName, value }) =>
    adapter.operators.eq(
      adapter.identifiers.column(
        sourceAlias,
        getColumnName(ctx.model, fieldName)
      ),
      scalarValueLiteral(ctx, fieldName, value)
    )
  );
  const cursorSelect = adapter.assemble.select({
    columns: sql.join(cursorColumns, ", "),
    from: adapter.identifiers.table(getTableName(ctx.model), sourceAlias),
    where: adapter.operators.and(...cursorWhere),
    limit: adapter.literals.value(1),
  });
  const comparisons = order.map((key, index) => ({
    row: key.expression,
    cursor: adapter.identifiers.column(
      cursorAlias,
      getCursorColumnAlias(index)
    ),
    direction: key.direction,
    nulls: key.nulls,
  }));
  const comparisonSelect = adapter.assemble.select({
    columns: adapter.literals.true(),
    from: adapter.subqueries.correlate(cursorSelect, cursorAlias),
    where: buildLexicographicPredicate(ctx, comparisons),
  });

  return adapter.operators.exists(comparisonSelect);
}

function assertCursorValues(cursorEntries: WhereUniqueEntry[]): void {
  for (const { fieldName, value } of cursorEntries) {
    if (value === null) {
      throw new QueryEngineError(
        `Cursor field '${fieldName}' cannot be null. ` +
          "Cursor must point to a specific record."
      );
    }
  }
}

function buildLexicographicPredicate(
  ctx: QueryScope,
  comparisons: CursorComparison[]
): Sql {
  const afterTerms: Sql[] = [];
  const equalPrefix: Sql[] = [];

  for (const comparison of comparisons) {
    afterTerms.push(
      ctx.adapter.operators.and(
        ...equalPrefix,
        buildStrictAfter(ctx, comparison)
      )
    );
    equalPrefix.push(buildNullSafeEquality(ctx, comparison));
  }

  afterTerms.push(ctx.adapter.operators.and(...equalPrefix));
  return ctx.adapter.operators.or(...afterTerms);
}

function buildNullSafeEquality(
  ctx: QueryScope,
  comparison: CursorComparison
): Sql {
  const { adapter } = ctx;
  const bothNull = adapter.operators.and(
    adapter.operators.isNull(comparison.row),
    adapter.operators.isNull(comparison.cursor)
  );
  const bothNonNullAndEqual = adapter.operators.and(
    adapter.operators.isNotNull(comparison.row),
    adapter.operators.isNotNull(comparison.cursor),
    adapter.operators.eq(comparison.row, comparison.cursor)
  );

  return adapter.operators.or(bothNull, bothNonNullAndEqual);
}

function buildStrictAfter(ctx: QueryScope, comparison: CursorComparison): Sql {
  const { adapter } = ctx;
  const compare =
    comparison.direction === "desc"
      ? adapter.operators.lt
      : adapter.operators.gt;
  const nonNullStrict = adapter.operators.and(
    adapter.operators.isNotNull(comparison.row),
    compare(comparison.row, comparison.cursor)
  );

  if (comparison.nulls === "first") {
    return adapter.operators.or(
      adapter.operators.and(
        adapter.operators.isNull(comparison.cursor),
        adapter.operators.isNotNull(comparison.row)
      ),
      adapter.operators.and(
        adapter.operators.isNotNull(comparison.cursor),
        nonNullStrict
      )
    );
  }

  return adapter.operators.and(
    adapter.operators.isNotNull(comparison.cursor),
    adapter.operators.or(
      adapter.operators.isNull(comparison.row),
      nonNullStrict
    )
  );
}

function getCursorColumnAlias(index: number): string {
  return `__viborm_cursor_${index}`;
}
