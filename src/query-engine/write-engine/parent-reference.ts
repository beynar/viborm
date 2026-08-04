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
 * What a *planning* probe correlates on for the parent's referenced field.
 *
 * A `planned` source is symbolic — the locate read has not run when the probe is
 * built, so the correlation is the SQL `Ref` technique #1 names. A `literal` source
 * is a compile-time constant, so the correlation is that constant inlined: the probe
 * reads `WHERE fk = <literal>`, which is what the same part's WRITE correlation
 * ({@link referencedFieldValue}) already emits for it. `RelationJunctionPart.parentRef`
 * is the precedent — a membership read materializes a `Ref` and a literal identically,
 * so no leaf learns which it received.
 *
 * Both kinds arrive here for real: a depth-composed part under a located-by-PK target
 * (T3b mechanism 1) and under an upsert's UPDATE arm named by its own primary key (E3)
 * carry a `literal`, while the update root's children carry a `planned`. Before this
 * widening those two positions raised an internal `QueryEngineError` for a payload the
 * public client admits.
 */
export function referencedFieldCorrelation(
  source: ParentIdSource,
  referencedField: string,
  relationName: string,
  kind: string
): OperationValueReference | unknown {
  if (source.kind === "literal") return source.value;
  if (source.kind !== "planned") {
    throw new QueryEngineError(
      `query-engine-v2 ${kind} for relation '${relationName}' requires a planned or literal parent id to correlate its probe.`
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
  // No second guard for "the row does not carry this column". Every `planned` reference
  // names a field the producing read declares as a `firstRowField` output, and the
  // executor already fails the whole operation closed when a declared output is absent
  // from the result (`extractOutput`) — during PLANNING, before any write. Repeating
  // that check here would be redundant defense on an invariant that already has a
  // guard, which is exactly what the one-guard-per-invariant rule forbids.
  return (row as Record<string, unknown>)[referencedField];
}
