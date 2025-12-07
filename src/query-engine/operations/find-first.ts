/**
 * Find First Operation
 *
 * Builds SQL for findFirst queries.
 * Returns a single record matching the criteria or null.
 */

import { Sql } from "@sql";
import type { QueryContext } from "../types";
import { buildFind, FindArgs } from "./find-common";

export interface FindFirstArgs extends FindArgs {
  // FindFirst specific: no take (always returns 1)
}

/**
 * Build SQL for findFirst operation
 *
 * @param ctx - Query context
 * @param args - FindFirst arguments
 * @returns SQL statement
 */
export function buildFindFirst(ctx: QueryContext, args: FindFirstArgs): Sql {
  // FindFirst always limits to 1 result
  return buildFind(ctx, args, { limit: 1 });
}
