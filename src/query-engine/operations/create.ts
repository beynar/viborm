/**
 * Create Operation
 *
 * Builds SQL for create mutations.
 * Returns the created record.
 */

import { type Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { compileBindBudgetChunks } from "../bind-budget";
import type { PolymorphicStorageValue } from "../builders/polymorphic-mutation";
import { buildSelect } from "../builders/select-builder";
import {
  buildValueGroups,
  buildValueGroupsWithRowStorage,
  buildValues,
  type ValuesGroup,
} from "../builders/values-builder";
import { getTableName } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import { assertPortableCreateManySkip } from "./create-many-portability";

interface CreateArgs {
  data: Record<string, unknown>;
  polymorphicStorage?: readonly PolymorphicStorageValue<unknown>[];
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

export interface CreateManyStatement {
  readonly sql: Sql;
  /**
   * The input rows this statement writes, in the order it writes them. The
   * indexes of one statement are ascending and contiguous, and the statements'
   * index lists concatenate to `0 … inputCount - 1` — `planInsertRowShapes`
   * groups maximal CONTIGUOUS same-shape runs and never reorders the input.
   *
   * On a statement that carries a RETURNING clause this is also the ORDINAL
   * CONTRACT for its result: the rows it returns correspond to these input
   * indexes positionally (query-performance-plan, Decision 7.2).
   */
  readonly inputIndexes: readonly number[];
}

export interface CreateManyPlan {
  readonly inputCount: number;
  readonly skipDuplicates: boolean;
  readonly statements: readonly CreateManyStatement[];
}

/**
 * Build SQL for create operation
 *
 * @param ctx - Query context
 * @param args - Create arguments
 * @returns SQL statement (INSERT with optional RETURNING)
 */
/**
 * The bare single-row `INSERT`, with no `RETURNING`.
 *
 * Split out of {@link buildCreate} so Phase 8.1's CTE fold can supply its own
 * all-columns `RETURNING` (`mutation-projection-fold.ts`) — the two callers must
 * write the same row the same way, so the statement has one home.
 */
export function buildInsertStatement(
  ctx: QueryScope,
  data: Record<string, unknown>,
  polymorphicStorage: readonly PolymorphicStorageValue<unknown>[] = []
): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  const { columns, values } = buildValues(ctx, data, polymorphicStorage);

  const table = adapter.identifiers.table(tableName);
  return columns.length === 0
    ? adapter.mutations.insertDefault(table)
    : adapter.mutations.insert(table, columns, values);
}

export function buildCreate(ctx: QueryScope, args: CreateArgs): Sql {
  const { adapter } = ctx;
  const insertSql = buildInsertStatement(
    ctx,
    args.data,
    args.polymorphicStorage ?? []
  );

  // Build RETURNING clause if supported (no alias for INSERT RETURNING)
  // Note: MySQL doesn't support RETURNING, so this will be empty
  const returningCols = buildSelect(ctx, args.select, args.include, "");
  const returningSql = adapter.mutations.returning(returningCols);

  // Combine INSERT with RETURNING
  if (!hasReturningClause(returningSql)) {
    // No RETURNING support (MySQL) - just return INSERT
    return insertSql;
  }

  return sql`${insertSql} ${returningSql}`;
}

/**
 * Does this adapter's `returning()` actually emit a clause? The one place that
 * decides it. A non-returning adapter (MySQL) hands back an empty fragment
 * rather than throwing, so "has RETURNING" is a property of the built SQL, not
 * of a capability flag read separately.
 */
function hasReturningClause(returning: Sql | undefined): returning is Sql {
  return returning !== undefined && returning.strings.join("").trim() !== "";
}

/**
 * Build SQL for createMany operation
 *
 * @param ctx - Query context
 * @param data - Array of records to create
 * @param skipDuplicates - Whether to skip duplicate key errors
 * @returns SQL statement
 */
export function buildCreateMany(
  ctx: QueryScope,
  data: Record<string, unknown>[],
  skipDuplicates = false
): Sql {
  return requireSingleCreateManyStatement(
    buildCreateManyPlan(ctx, { data, skipDuplicates }, false),
    "createMany"
  );
}

/**
 * Build every statement required by a bulk create. Every arm uses maximal
 * contiguous same-shape runs (`buildValueGroups`), so one statement carries a
 * run of input rows and the runs concatenate back to the input in order.
 *
 * Two arms still split a run into one statement per row, and only these two:
 *
 * - **`recoverDuplicateErrors`** — a dialect whose `skipDuplicates` is not a SQL
 *   leaf (MySQL) skips by running each write behind a savepoint and absorbing
 *   its unique violation. A run cannot be absorbed row-wise, so the run is split.
 * - **`returnRows` on a driver with no RETURNING clause** (MySQL again) — the
 *   caller refetches each inserted row by its created identity, which needs one
 *   INSERT per input to address.
 *
 * A returning driver keeps the run whole: Phase 7.2 (query-performance-plan,
 * Decision 7.2) folds `createMany` with a `select` into ONE multi-row
 * `INSERT … VALUES (…),(…) RETURNING …` per run instead of N single-row
 * statements. The returned rows map to the run's input rows POSITIONALLY — see
 * the ordinal contract on {@link CreateManyStatement.inputIndexes}.
 */
export function buildCreateManyPlan(
  ctx: QueryScope,
  args: Record<string, unknown>,
  returnRows: boolean,
  polymorphicStorage?:
    | PolymorphicStorageValue<unknown>
    | readonly (readonly PolymorphicStorageValue<unknown>[])[],
  maxBindParametersPerStatement?: number
): CreateManyPlan {
  const data = getCreateManyData(args.data);
  if (data.length === 0) {
    throw new QueryEngineError("No data to insert for createMany.");
  }
  const skipDuplicates = args.skipDuplicates === true;
  const valueGroups = splitDefaultGroupsIntoRows(
    isRowPolymorphicStorage(polymorphicStorage)
      ? buildValueGroupsWithRowStorage(ctx, data, polymorphicStorage)
      : buildValueGroups(
          ctx,
          data,
          polymorphicStorage ? [polymorphicStorage] : []
        )
  );
  assertPortableCreateManySkip(
    skipDuplicates,
    valueGroups.some((group) => group.columns.length === 0)
  );
  const recoverDuplicateErrors =
    skipDuplicates &&
    ctx.adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError";
  const built = returnRows
    ? ctx.adapter.mutations.returning(
        buildSelect(
          ctx,
          isRecord(args.select) ? args.select : undefined,
          undefined,
          ""
        )
      )
    : undefined;
  const returningSql = hasReturningClause(built) ? built : undefined;
  const splitIntoRows =
    recoverDuplicateErrors || (returnRows && returningSql === undefined);
  const units = splitIntoRows ? splitGroupsIntoRows(valueGroups) : valueGroups;

  return {
    inputCount: data.length,
    skipDuplicates,
    statements: buildBudgetedCreateManyStatements(
      ctx,
      units,
      skipDuplicates && !recoverDuplicateErrors,
      returningSql,
      maxBindParametersPerStatement
    ),
  };
}

/**
 * Partition one semantic same-shape run only when its compiled SQL exceeds the
 * active provider's verified bind budget. The statement itself is the meter:
 * casts, SQL-valued cells, private discriminators, and dialect lowering can all
 * change its `values.length`, so row/column arithmetic is not authoritative.
 *
 * A one-row statement is indivisible and stays intact even when it is too
 * large. The executor owns the final pre-I/O refusal for that boundary.
 */
function buildBudgetedCreateManyStatements(
  ctx: QueryScope,
  groups: readonly ValuesGroup[],
  skipDuplicates: boolean,
  returningSql: Sql | undefined,
  maxBindParametersPerStatement: number | undefined
): CreateManyStatement[] {
  const statements: CreateManyStatement[] = [];
  for (const group of groups) {
    const chunks = compileBindBudgetChunks(
      group.values.length,
      maxBindParametersPerStatement,
      (start, end) =>
        buildCreateManyStatement(
          ctx,
          sliceValuesGroup(group, start, end),
          skipDuplicates,
          returningSql
        )
    );
    for (const chunk of chunks) {
      statements.push({
        inputIndexes: group.inputIndexes.slice(chunk.start, chunk.end),
        sql: chunk.statement,
      });
    }
  }
  return statements;
}

function sliceValuesGroup(
  group: ValuesGroup,
  start: number,
  end: number
): ValuesGroup {
  return {
    columns: group.columns,
    inputIndexes: group.inputIndexes.slice(start, end),
    values: group.values.slice(start, end),
  };
}

function isRowPolymorphicStorage(
  value:
    | PolymorphicStorageValue<unknown>
    | readonly (readonly PolymorphicStorageValue<unknown>[])[]
    | undefined
): value is readonly (readonly PolymorphicStorageValue<unknown>[])[] {
  return Array.isArray(value);
}

function getCreateManyData(value: unknown): Record<string, unknown>[] {
  if (!(Array.isArray(value) && value.every(isRecord))) {
    throw new QueryEngineError(
      "Validated createMany arguments are missing a data array."
    );
  }
  return value;
}

function splitGroupsIntoRows(groups: readonly ValuesGroup[]): ValuesGroup[] {
  const rows: ValuesGroup[] = [];
  for (const group of groups) {
    for (let index = 0; index < group.values.length; index++) {
      rows.push({
        columns: group.columns,
        inputIndexes: [group.inputIndexes[index]!],
        values: [group.values[index]!],
      });
    }
  }
  return rows;
}

function splitDefaultGroupsIntoRows(
  groups: readonly ValuesGroup[]
): ValuesGroup[] {
  const split: ValuesGroup[] = [];
  for (const group of groups) {
    if (group.columns.length > 0) {
      split.push(group);
      continue;
    }
    split.push(...splitGroupsIntoRows([group]));
  }
  return split;
}

function buildCreateManyStatement(
  ctx: QueryScope,
  group: ValuesGroup,
  skipDuplicates: boolean,
  returningSql: Sql | undefined
): Sql {
  const table = ctx.adapter.identifiers.table(getTableName(ctx.model));
  if (group.columns.length === 0) {
    assertPortableCreateManySkip(skipDuplicates, true);
    const insertSql = ctx.adapter.mutations.insertDefault(table);
    return returningSql ? sql`${insertSql} ${returningSql}` : insertSql;
  }

  let insertSql: Sql;
  if (skipDuplicates) {
    const { prefix, suffix } = ctx.adapter.mutations.skipDuplicates(
      group.columns[0]!
    );
    insertSql = sql`${ctx.adapter.mutations.insert(
      table,
      group.columns,
      group.values,
      prefix
    )} ${suffix}`;
  } else {
    insertSql = ctx.adapter.mutations.insert(
      table,
      group.columns,
      group.values
    );
  }

  return returningSql ? sql`${insertSql} ${returningSql}` : insertSql;
}

function requireSingleCreateManyStatement(
  plan: CreateManyPlan,
  operation: string
): Sql {
  if (plan.statements.length !== 1) {
    throw new QueryEngineError(
      `Cannot build ${operation} as one SQL statement; execute the operation as an atomic statement plan.`
    );
  }
  return plan.statements[0]!.sql;
}
