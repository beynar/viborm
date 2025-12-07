/**
 * Find Many Operation
 *
 * Builds SQL for findMany queries.
 * Returns an array of records matching the criteria.
 */

import { Sql } from "@sql";
import type { QueryContext } from "../types";
import { buildFind, FindArgs } from "./find-common";

export interface FindManyArgs extends FindArgs {
  /** Maximum number of records to return */
  take?: number;
}

/**
 * Build SQL for findMany operation
 *
 * @param ctx - Query context
 * @param args - FindMany arguments
 * @returns SQL statement
 */
export function buildFindMany(ctx: QueryContext, args: FindManyArgs): Sql {
  return buildFind(ctx, args, { limit: args.take });
}
