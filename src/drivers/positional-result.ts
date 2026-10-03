import { QueryError } from "@errors";
import type { Sql } from "@sql";
import type { AnyDriver } from "./driver";
import {
  createNormalizedResultMeta,
  type NormalizedResultContext,
} from "./normalized-result";
import type { QueryExecutionContext, QueryResult } from "./types";

/** Internal projection transport; the public driver result remains object rows. */
export interface PositionalQueryResult {
  readonly kind: "positional";
  readonly rows: unknown[][];
  readonly columns: readonly string[];
}

export type ProjectionExecutionResult =
  | PositionalQueryResult
  | { readonly kind: "borrowed"; readonly result: QueryResult<unknown> };

export type PositionalExecute = (
  query: Sql,
  context: QueryExecutionContext
) => Promise<ProjectionExecutionResult>;

interface PositionalResultDriver {
  readonly execute: PositionalExecute;
  readonly isEligible: (driver: AnyDriver) => boolean;
}

const positionalDrivers = new WeakMap<AnyDriver, PositionalResultDriver>();

export function registerPositionalResultDriver(
  driver: AnyDriver,
  execute: PositionalExecute,
  isEligible: (driver: AnyDriver) => boolean
): void {
  positionalDrivers.set(driver, { execute, isEligible });
}

export function resolvePositionalResultDriver(
  driver: AnyDriver
): PositionalExecute | undefined {
  const candidate = positionalDrivers.get(driver);
  return candidate?.isEligible(driver) ? candidate.execute : undefined;
}

export function assertPositionalRows(
  rows: unknown[],
  columns: readonly string[],
  context: NormalizedResultContext
): asserts rows is unknown[][] {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (
      !(Object.hasOwn(rows, index) && Array.isArray(row)) ||
      row.length !== columns.length
    ) {
      throw new QueryError(
        `Driver "${context.provider}" returned malformed positional rows for operation "${context.operation}".`,
        { meta: createNormalizedResultMeta(context) }
      );
    }
  }
}

/** A changed execution/parser surface must see the usual keyed provider rows. */
export function borrowPositionalResult(
  response: PositionalQueryResult
): QueryResult<unknown> {
  const rows = response.rows.map((row) =>
    Object.fromEntries(
      response.columns.map((column, index) => [column, row[index]])
    )
  );
  return { rows, rowCount: rows.length };
}
