/**
 * Cursor condition
 *
 * Builds one null-aware lexicographic predicate against a single derived
 * cursor row. The cursor row's order values are selected once, then reused by
 * every equality prefix and strict-after branch.
 */

import { assembleAdapterSelect } from "@adapters/adapter-internals";
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

  const rowValue = buildRowValueCursorCondition(ctx, cursorEntries, order);
  if (rowValue) {
    return rowValue;
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
  const cursorSelect = assembleAdapterSelect(adapter, {
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
  const comparisonSelect = assembleAdapterSelect(adapter, {
    columns: adapter.literals.true(),
    from: adapter.subqueries.correlate(cursorSelect, cursorAlias),
    where: buildLexicographicPredicate(ctx, comparisons),
  });

  return adapter.operators.exists(comparisonSelect);
}

/**
 * The sargable cursor spelling, when the schema permits it.
 *
 * The general predicate below is an OR of null-guarded AND chains, and no
 * database serves that with an index: each dialect walks the whole index and
 * filters, so page N costs a walk over everything before it. A row-value
 * comparison against a row-valued subquery says the same thing in a form the
 * planner can turn into a range seek.
 *
 * Measured at 100,000 rows with a composite index over the sort columns,
 * paging from row 99,000: PostgreSQL 18.608 ms -> 0.467 ms (`Nested Loop Semi
 * Join` with a join filter over a full `Index Scan` becomes `Index Cond:
 * (ROW(k, id) >= ROW((InitPlan 1).col1, (InitPlan 1).col2))`); SQLite 14.695 ms
 * -> 0.004 ms (`SCAN t USING INDEX` becomes `SEARCH t USING INDEX (k>?)`).
 *
 * The plan text proposed keeping the EXISTS wrapper and only replacing the
 * OR-of-ANDs inside it. Measured, that is worth 1.12x and changes no plan
 * shape: the wrapper is the blocker, because a co-routine's column cannot be
 * an index seek bound. Replacing the wrapper is what buys the seek, and it
 * costs no extra round trip — the cursor row is still located inside the same
 * statement.
 *
 * Two schema facts gate it, and both are necessary:
 *
 * - Every sort column must be NOT NULL. A row-value comparison has no way to
 *   express "nulls sort last"; SQL's own null semantics would make the whole
 *   comparison NULL rather than order around it.
 * - Every sort column must share one direction. `(a, b) > (x, y)` means
 *   `a > x OR (a = x AND b > y)`; a mixed `a ASC, b DESC` order needs
 *   `a > x OR (a = x AND b < y)`, which no row value spells.
 *
 * Anything else keeps the general predicate, which stays correct everywhere.
 */
function buildRowValueCursorCondition(
  ctx: QueryScope,
  cursorEntries: WhereUniqueEntry[],
  order: NormalizedCursorOrder[]
): Sql | undefined {
  const { direction } = order[0]!;
  const sargable = order.every(
    (key) => !key.nullable && key.direction === direction
  );
  if (!sargable) {
    return undefined;
  }

  const { adapter } = ctx;
  const sourceAlias = ctx.nextAlias();
  const cursorSelect = assembleAdapterSelect(adapter, {
    columns: sql.join(
      order.map((key) =>
        adapter.identifiers.column(
          sourceAlias,
          getColumnName(ctx.model, key.field)
        )
      ),
      ", "
    ),
    from: adapter.identifiers.table(getTableName(ctx.model), sourceAlias),
    where: adapter.operators.and(
      ...cursorEntries.map(({ fieldName, value }) =>
        adapter.operators.eq(
          adapter.identifiers.column(
            sourceAlias,
            getColumnName(ctx.model, fieldName)
          ),
          scalarValueLiteral(ctx, fieldName, value)
        )
      )
    ),
    limit: adapter.literals.value(1),
  });

  // The comparison is inclusive because the general predicate is: its last OR
  // term is the all-equal one, so the cursor row itself is in the window.
  // A cursor that matches no row makes the subquery NULL, the comparison NULL,
  // and the window empty — the same Prisma semantics the EXISTS wrapper gave.
  const compare =
    direction === "desc" ? adapter.operators.lte : adapter.operators.gte;
  return compare(
    rowValue(order.map((key) => key.expression)),
    adapter.subqueries.scalar(cursorSelect)
  );
}

/**
 * A SQL row constructor. One column needs no parentheses to mean itself, and
 * a bare column keeps the comparison a plain scalar one — same shape as the
 * bulk-limit key vector.
 */
function rowValue(expressions: Sql[]): Sql {
  return expressions.length === 1
    ? expressions[0]!
    : sql`(${sql.join(expressions, ", ")})`;
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
