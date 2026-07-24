// The per-field parent-reference resolver shared by the FK-edge Parts
// (`RelationLinkPart`, `RelationWritePart`, `RelationSetPart`,
// `RelationUpsertPart`). A compound foreign key is per-field (ATOM §1's
// multi-field produces): every child FK column is written/correlated from its
// index-aligned parent *referenced* column, exactly as P3's `RelationLinkPart`
// already does for connect/disconnect. This is a pure value resolver — not a
// step kind, a Part method, or an executor branch (WHY §7) — so the four Parts
// share one correct implementation instead of four copies that can drift.
//
// The referenced column a child FK points at may be the parent's primary key
// (the common case) or a non-PK unique (the D4-style shape); either way the
// resolver reads it from the located-parent planning row by name, so the locate
// read must expose every referenced field as a `firstRowField` output.

import { NestedWriteError, QueryEngineError } from "@errors";
import { type OperationValueReference, ref } from "./OperationFragment";
import type { PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import type { ParentIdSource } from "./RelationUpsertPart";

/**
 * The SQL `Ref` a *planning* probe uses to correlate to the parent's referenced
 * field (technique #1). Only a `planned` source can be referenced this way — the
 * locate read has not run yet, so the value is symbolic.
 */
export function referencedFieldRef(
  source: ParentIdSource,
  referencedField: string,
  relationName: string,
  kind: string
): OperationValueReference {
  if (source.kind !== "planned") {
    throw new QueryEngineError(
      `query-engine-v2 ${kind} for relation '${relationName}' requires a planned parent id to correlate its probe.`
    );
  }
  return ref(source.readStep, referencedField);
}

/**
 * The concrete value of the parent's referenced field, inlined at compile (a
 * final-fragment step may not ref a planning step — ATOM §9 inv. 2). A `literal`
 * source is the single-field depth/create base case (its one value regardless of
 * `referencedField`); a `planned` source reads the named column from the located
 * row. A `ref` source is symbolic and must be lowered by the caller, not here.
 */
export function referencedFieldValue(
  source: ParentIdSource,
  referencedField: string,
  known: PlanningKnown | undefined,
  relationName: string,
  kind: string
): unknown {
  if (source.kind === "literal") return source.value;
  if (source.kind !== "planned" || !known) {
    throw new QueryEngineError(
      `query-engine-v2 ${kind} for relation '${relationName}' requires a planned parent id.`
    );
  }
  const rows = known[planningKey(source.readStep, "rows")];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!(row && typeof row === "object")) {
    throw new NestedWriteError(
      `query-engine-v2 ${kind} for relation '${relationName}' could not resolve its parent id.`,
      relationName
    );
  }
  return (row as Record<string, unknown>)[referencedField];
}
