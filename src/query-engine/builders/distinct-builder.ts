/**
 * Distinct builder
 *
 * Resolves a `distinct` field list into the column list the adapter turns into
 * `DISTINCT ON` (PostgreSQL without an ORDER BY) or the ROW_NUMBER-partition
 * emulation (everywhere else). One home for both the top-level window and the
 * per-parent relation window.
 */

import { type Sql, sql } from "@sql";
import { getColumnName, getScalarFieldNames } from "../context";
import { QueryEngineError, type QueryScope } from "../types";

/**
 * @param ctx - Scope of the model the distinct fields belong to
 * @param distinct - Scalar field names
 * @param alias - Alias of that model's table in the query being built
 * @returns Column list for the DISTINCT clause, or undefined when empty
 */
export function buildDistinctColumns(
  ctx: QueryScope,
  distinct: string[],
  alias: string
): Sql | undefined {
  if (distinct.length === 0) return undefined;

  const { adapter } = ctx;

  const scalarFields = getScalarFieldNames(ctx.model);
  for (const field of distinct) {
    if (!scalarFields.includes(field)) {
      throw new QueryEngineError(
        `Distinct field '${field}' not found on model '${ctx.model["~"].state.name}'`
      );
    }
  }

  const columns = distinct.map((field) => {
    const columnName = getColumnName(ctx.model, field);
    return adapter.identifiers.column(alias, columnName);
  });

  return sql.join(columns, ", ");
}
