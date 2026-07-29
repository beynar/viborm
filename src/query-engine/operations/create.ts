/**
 * Create Operation
 *
 * Builds SQL for create mutations.
 * Returns the created record.
 */

import { type Sql, sql } from "@sql";
import { buildSelect } from "../builders/select-builder";
import {
  buildValueGroups,
  buildValues,
  type ValuesGroup,
} from "../builders/values-builder";
import { getTableName } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import { assertPortableCreateManySkip } from "./create-many-portability";

interface CreateArgs {
  data: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

export interface CreateManyStatement {
  readonly sql: Sql;
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
export function buildCreate(ctx: QueryScope, args: CreateArgs): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build VALUES
  const { columns, values } = buildValues(ctx, args.data);

  if (values.length === 0) {
    throw new QueryEngineError("No data to insert");
  }

  // Build INSERT
  const table = adapter.identifiers.escape(tableName);
  const insertSql =
    columns.length === 0
      ? adapter.mutations.insertDefault(table)
      : adapter.mutations.insert(table, columns, values);

  // Build RETURNING clause if supported (no alias for INSERT RETURNING)
  // Note: MySQL doesn't support RETURNING, so this will be empty
  const returningCols = buildSelect(ctx, args.select, args.include, "");
  const returningSql = adapter.mutations.returning(returningCols);

  // Combine INSERT with RETURNING
  if (returningSql.strings.join("").trim() === "") {
    // No RETURNING support (MySQL) - just return INSERT
    return insertSql;
  }

  return sql`${insertSql} ${returningSql}`;
}

/**
 * Build SQL for createMany operation
 *
 * @param ctx - Query context
 * @param data - Array of records to create
 * @param skipDuplicates - Whether to skip duplicate key errors
 * @returns SQL statement
 */
/**
 * Build SQL for the row-returning arm of `createMany` — internally named
 * `createManyAndReturn`; the client spells it `createMany` with a `select`.
 *
 * INSERT ... RETURNING on adapters that support it. On adapters without
 * RETURNING this returns the bare INSERT; the operation program refetches the
 * inserted rows inside the same atomic scope.
 */
export function buildCreateManyAndReturn(
  ctx: QueryScope,
  args: {
    data: Record<string, unknown>[];
    skipDuplicates?: boolean;
    select?: Record<string, unknown>;
  }
): Sql {
  return requireSingleCreateManyStatement(
    buildCreateManyPlan(ctx, args, true),
    "createManyAndReturn"
  );
}

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
 * Build every statement required by a bulk create. Count-only operations use
 * maximal contiguous same-shape runs. Returning operations use one statement
 * per input row so each provider result has an exact input ordinal.
 */
export function buildCreateManyPlan(
  ctx: QueryScope,
  args: Record<string, unknown>,
  returnRows: boolean
): CreateManyPlan {
  const data = getCreateManyData(args.data);
  if (data.length === 0) {
    throw new QueryEngineError("No data to insert for createMany.");
  }
  const skipDuplicates = args.skipDuplicates === true;
  const valueGroups = splitDefaultGroupsIntoRows(buildValueGroups(ctx, data));
  assertPortableCreateManySkip(
    skipDuplicates,
    valueGroups.some((group) => group.columns.length === 0)
  );
  const recoverDuplicateErrors =
    skipDuplicates &&
    ctx.adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError";
  const units =
    returnRows || recoverDuplicateErrors
      ? splitGroupsIntoRows(valueGroups)
      : valueGroups;
  const returningSql = returnRows
    ? ctx.adapter.mutations.returning(
        buildSelect(
          ctx,
          isRecord(args.select) ? args.select : undefined,
          undefined,
          ""
        )
      )
    : undefined;

  return {
    inputCount: data.length,
    skipDuplicates,
    statements: units.map((unit) => ({
      inputIndexes: unit.inputIndexes,
      sql: buildCreateManyStatement(
        ctx,
        unit,
        skipDuplicates && !recoverDuplicateErrors,
        returningSql
      ),
    })),
  };
}

function getCreateManyData(value: unknown): Record<string, unknown>[] {
  if (!(Array.isArray(value) && value.every(isRecord))) {
    throw new QueryEngineError(
      "Validated createMany arguments are missing a data array."
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (group.values.length === 0) {
    throw new QueryEngineError("No data to insert");
  }

  const table = ctx.adapter.identifiers.escape(getTableName(ctx.model));
  if (group.columns.length === 0) {
    assertPortableCreateManySkip(skipDuplicates, true);
    const insertSql = ctx.adapter.mutations.insertDefault(table);
    if (!returningSql || returningSql.strings.join("").trim() === "") {
      return insertSql;
    }
    return sql`${insertSql} ${returningSql}`;
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

  if (!returningSql || returningSql.strings.join("").trim() === "") {
    return insertSql;
  }
  return sql`${insertSql} ${returningSql}`;
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
