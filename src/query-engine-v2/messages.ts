// The V2 message catalog (PLAN P2a instrument 2).
//
// Every error V2 surfaces on a shape V1 also handles must carry V1's
// *byte-identical* text — the behavior suites assert message equality, and the
// dual-run oracle compares error messages across arms. The safest way to stay
// byte-identical is not to re-type the strings here but to source them from the
// exact V1 construction site, so a future V1 wording change moves both engines
// together. Extension-only shapes (no V1 behavior to equal) keep their own
// messages, catalogued in the second section and marked as such.
//
// This module is data, not an operation: it constructs no `Step`, imports no
// executor, and holds no dialect knowledge. It is imported by the concrete
// operations and their Parts.

import { relationTargetFailure } from "../query-engine/RelationProgramValues";
import type { RelationInfo } from "../query-engine/types";

// ---------------------------------------------------------------------------
// Shared shapes — V1-verbatim. Sourced from V1's own message builder.
// ---------------------------------------------------------------------------

/**
 * The "target record was not found" family V1 raises when a nested
 * connect/disconnect/delete/set/update cannot resolve its target (V1's
 * `relationTargetFailure`). The `for this parent` suffix is present for the
 * correlated operations (update/delete/disconnect) and absent for the global
 * ones (connect/set) — exactly as V1 computes it.
 */
export function relationTargetNotFound(
  relation: RelationInfo,
  operation: "connect" | "delete" | "disconnect" | "set" | "update"
): string {
  return relationTargetFailure(relation, operation).message;
}

/**
 * The nested-upsert found-uncorrelated error (V7001). V1 builds this string
 * inline in `RelationBranches` (not through `relationTargetFailure`, which has
 * no `upsert` operation), so it is reproduced verbatim here and asserted equal
 * by the upsert parity oracle.
 */
export function upsertTargetNotFoundForParent(relationName: string): string {
  return `Cannot upsert relation '${relationName}': target record was not found for this parent.`;
}

// ---------------------------------------------------------------------------
// Extension-only shapes — no V1 behavior to equal (catalogued, PLAN P−1.2).
// These describe shapes V2 supports beyond V1, or V2's own unsupported-shape
// rejections. They carry a `query-engine-v2` prefix so they never masquerade
// as a shared-shape message.
// ---------------------------------------------------------------------------

/** A nested upsert premise changed between planning and the atomic batch. */
export function upsertPremiseChanged(relationName: string): string {
  return `Nested upsert premise changed for relation '${relationName}'.`;
}

/** A nested upsert's located target vanished before its update (staleness). */
export function upsertTargetVanished(relationName: string): string {
  return `Nested upsert target for relation '${relationName}' vanished before its update.`;
}
