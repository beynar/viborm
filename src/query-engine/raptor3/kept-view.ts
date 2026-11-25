/**
 * What a view kept current by the writes of its one source table cannot
 * hold: SurrealDB's every view (`DEFINE TABLE … AS`), and a view declared
 * `.materialized({ refresh: "auto" })` elsewhere, whose triggers compute
 * again the row or the group a write touched. Both follow the writes to the
 * source's own rows and nothing else, and find what a write changed by the
 * values of its fields, so the rules here are the same for both: no read of
 * another table, no caller's SQL fragment, no order or window, no distinct,
 * no filter of the groups, no time step. Each writer refuses with its own
 * reasons, the view named.
 *
 * Only the migrations import this module, as they import `view-body.ts`.
 */

import type { AnyModel } from "@schema/model";
import { viewFacts } from "@schema/view/facts";
import { Sql } from "@sql";
import type { PreparedPredicate } from "./shared/query";
import type { Arguments } from "./shared/schema";

/** Why a kept view cannot hold each clause, as its writer states it. */
export interface KeptViewReasons {
  /** It reads another table: a relation, `_count`, `_aggregate`, a relation filter. */
  readonly stale: string;
  /** It orders, windows or skips its rows. */
  readonly unordered: string;
  /** It keeps one row per distinct value. */
  readonly distinct: string;
  /** It filters its groups (`having`). */
  readonly unfiltered: string;
  /** It groups by a time step. */
  readonly noStep: string;
}

/** How a writer refuses a clause: `View '<view>' cannot be created from a query that <clause>: <reason>.` */
export type RefuseClause = (clause: string, reason: string) => never;

/** The caller's SQL in a filter, which a view's literals cannot write. */
const FRAGMENT =
  "a view's query holds plain values, which its migration writes as literals";

/**
 * Refuses a filter that is not the source's own fields compared with plain
 * values: a relation (any read of another table) would go stale, and a
 * caller's SQL fragment has no literal.
 */
function refuseFilter(
  predicate: PreparedPredicate,
  reasons: KeptViewReasons,
  refuse: RefuseClause
): void {
  switch (predicate.kind) {
    case "and":
    case "or":
      for (const inner of predicate.predicates)
        refuseFilter(inner, reasons, refuse);
      return;
    case "not":
      refuseFilter(predicate.predicate, reasons, refuse);
      return;
    case "always":
      return;
    case "operation": {
      const operands = [
        ...(predicate.operand ? [predicate.operand] : []),
        ...(predicate.operands ?? []),
      ];
      if (
        predicate.value instanceof Sql ||
        operands.some(
          (operand) =>
            operand.kind === "sql" ||
            operand.kind === "parameter" ||
            (operand.kind === "value" && operand.value instanceof Sql)
        )
      )
        refuse("filters with an SQL fragment", FRAGMENT);
      return;
    }
    default:
      refuse("filters through a relation", reasons.stale);
  }
}

/**
 * Refuses what `view`'s admitted query says that a view kept current by its
 * source's writes cannot hold, `predicate` being its prepared `where`.
 */
export function refuseUnkept(
  view: AnyModel,
  admitted: Arguments,
  predicate: PreparedPredicate | undefined,
  reasons: KeptViewReasons,
  refuse: RefuseClause
): void {
  const { documents, aggregated } = viewFacts(view)!;
  if (admitted.cursor !== undefined)
    refuse("pages from a cursor", "a paging anchor is not a row set");
  if (admitted.take !== undefined) refuse("takes a window", reasons.unordered);
  if (admitted.skip !== undefined) refuse("skips rows", reasons.unordered);
  if (admitted.orderBy !== undefined)
    refuse("orders its rows", reasons.unordered);
  if (admitted.distinct !== undefined)
    refuse("keeps one row per distinct value", reasons.distinct);
  if (admitted.having !== undefined)
    refuse("keeps the groups a having holds", reasons.unfiltered);
  // A relation, `_count` and `_aggregate` are documents read of other rows.
  const [document] = documents;
  if (document !== undefined)
    refuse(`selects '${document}' through a relation`, reasons.stale);
  for (const origin of Object.values(aggregated?.origins ?? {}))
    if (origin.step !== undefined)
      refuse("groups by a time step", reasons.noStep);
  if (predicate !== undefined) refuseFilter(predicate, reasons, refuse);
}
