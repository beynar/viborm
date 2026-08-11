// The write-engine message catalog.
//
// Every error V2 surfaces on a shape V1 also handles must carry V1's
// *byte-identical* text — the behavior suites assert message equality, and the
// dual-run oracle compares error messages across arms. This file is now the one
// owner of those retained strings. Extension-only shapes keep their own messages,
// catalogued in the second section and marked as such.
//
// This module is data, not an operation: it constructs no `Step`, imports no
// executor, and holds no dialect knowledge. It is imported by the concrete
// operations and their Parts.

import type { RelationInfo } from "../types";

// ---------------------------------------------------------------------------
// Shared shapes — V1-verbatim. Sourced from V1's own message builder.
// ---------------------------------------------------------------------------

/**
 * The "target record was not found" family V1 raises when a nested
 * connect/disconnect/delete/set/update cannot resolve its target (V1's
 * target failure. The `for this parent` suffix is present for the
 * correlated operations (update/delete/disconnect) and absent for the global
 * ones (connect/set) — exactly as V1 computes it.
 */
export function relationTargetNotFound(
  relation: RelationInfo,
  operation: "connect" | "delete" | "disconnect" | "set" | "update"
): string {
  const parentSuffix =
    operation === "update" ||
    operation === "delete" ||
    operation === "disconnect"
      ? " for this parent"
      : "";
  return `Cannot ${operation} relation '${relation.name}': target record was not found${parentSuffix}.`;
}

/**
 * The `set` orphan-guard message V1 raises when a `set` would strand a child
 * whose foreign key is required (the rows departing the membership cannot be
 * nulled, so they must be deleted instead). V1 builds this string inline in
 * `RelationRemovals.set`, so it is
 * reproduced verbatim here — the retained `notExists` orphan pin (ATOM “Branch premises and pins”)
 * carries it, and the parity oracle asserts it byte-for-byte.
 */
export function setRequiredOrphan(
  relationName: string,
  requiredFields: readonly string[]
): string {
  return `Cannot set relation '${relationName}' because foreign key field(s) ${requiredFields.join(", ")} are required: rows removed from the set cannot be disconnected. Delete them instead.`;
}

/**
 * The nested-upsert found-uncorrelated error (V7001). V1 builds this string
 * inline in `RelationBranches`, so it is reproduced verbatim here and asserted
 * equal by the upsert parity oracle.
 */
export function upsertTargetNotFoundForParent(relationName: string): string {
  return `Cannot upsert relation '${relationName}': target record was not found for this parent.`;
}

/**
 * V1's rejection of a boolean `disconnect` on a many-to-many relation — the
 * junction cannot know which membership to remove without a target selector
 * (V1's `ManyToManyMemberships.disconnect`). Reproduced verbatim so the M2M
 * parity oracle asserts it byte-for-byte.
 */
export function m2mDisconnectRequiresSelector(relationName: string): string {
  return `Nested operation 'disconnect' on many-to-many relation '${relationName}' requires a target selector.`;
}

/**
 * V1's raceable failure when the materialized membership set of a M2M
 * `delete`/`deleteMany` changed between the planning read and the atomic batch
 * (V1's `ManyToManyMutations.raceFailure`). Only the staleness path observes it;
 * `raceable: true` per the Pin Rule's materialized-set class (ATOM “Branch premises and pins”).
 */
export function m2mMembershipRace(
  relationName: string,
  operation: "delete" | "deleteMany"
): string {
  return `Concurrent membership change during '${operation}' on many-to-many relation '${relationName}': retry to converge.`;
}

/**
 * The found-premise replacement message V1 raises when a nested `upsert` or
 * `connectOrCreate` located a row at planning that a concurrent transaction
 * replaced before the write (V1's `RelationBranches.replacementFailure`). It is
 * V1-verbatim so a staleness abort on the found premise carries the same text.
 * Only race/staleness paths observe it (the single-threaded oracle never does),
 * so the class — `NestedWriteError` — is what the suites assert, but the string
 * is kept faithful.
 */
export function nestedReplacement(
  operation: "connectOrCreate" | "upsert"
): string {
  return `Record was replaced by another transaction during nested ${operation}`;
}

// ---------------------------------------------------------------------------
/**
 * CLASS IV (T4c) — V1's `relationFailure` occupied-slot message, verbatim: a root
 * update (or, since N5-U1, a nested update TARGET) transitions a key a child-held,
 * non-cascade relation references while that relation's old slot still holds rows.
 * Both askers say it identically because it is one rule at two depths.
 */
export function relationKeyOccupiedMessage(
  relationName: string,
  action: string
): string {
  return `Cannot update relation '${relationName}' with onUpdate('${action}') while the current relation is occupied.`;
}

/**
 * The owned-foreign-key refusal: a nested payload spells, as a scalar assignment, the
 * very column the enclosing relation OWNS. The engine derives that column from the row
 * the enclosing step acted on; a spelled value is a second, contradicting provenance for
 * it. One rule, so one string. Its remaining engine consumer is the adopt family's seam
 * (`RelationUpsertPart.withoutAgreeingOwnedFk`) — the nested-update guard that shared it
 * (site 11) is deleted, its invariant now impossible upstream: the aligned parse
 * omission refuses the spelling as `Unknown key` on every schema.
 */
export function relationOwnsForeignKey(
  relationName: string,
  fkFields: readonly string[]
): string {
  return `Relation '${relationName}' owns '${fkFields.join(", ")}'; omit it from nested create and update data.`;
}

/**
 * The step-4 abort floor (V1's `attributeOperationBatchError`, byte-identical): a
 * batch assertion aborted with no guard to attribute or re-probe against — a
 * guard-free write ladder. Surfaced as the typed non-raceable V7006 floor. Lives
 * here (not the executor) so the executor stays free of operation-noun tokens
 * (structural gate a); the wording matches V1's frozen runtime verbatim.
 */
export const NESTED_WRITE_ASSERTION_FLOOR_MESSAGE =
  "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold.";

// Extension-only shapes — no V1 behavior to equal.
// These describe shapes V2 supports beyond V1, or V2's own unsupported-shape
// rejections. They carry a `query-engine-v2` prefix so they never masquerade
// as a shared-shape message.
// ---------------------------------------------------------------------------

/** A nested upsert premise changed between planning and the atomic batch. */
export function upsertPremiseChanged(relationName: string): string {
  return `Nested upsert premise changed for relation '${relationName}'.`;
}

/**
 * A to-one `connect`/`connectOrCreate` addressed its target by a unique the
 * foreign key does NOT reference, and the located row's referenced column is NULL
 * (E1 U1/U2). The lookup would write that NULL into the foreign key, which
 * disconnects the relation instead of connecting it — so the arm refuses, named,
 * rather than writing it. Only a NULLABLE referenced unique can reach this.
 */
export function lookupKeyIsNull(
  relationName: string,
  referencedField: string
): string {
  return `Cannot connect relation '${relationName}': the located target's referenced field '${referencedField}' is null.`;
}

/** A nested upsert's located target vanished before its update (staleness). */
export function upsertTargetVanished(relationName: string): string {
  return `Nested upsert target for relation '${relationName}' vanished before its update.`;
}

/** The top-level upsert's conditional skip premise became true after its
 * unlocked planning read. Batch mode reports this absence-pin failure as
 * raceable so routed execution can re-plan once. */
export function upsertSkipPremiseChanged(
  field: "setWhere" | "targetWhere"
): string {
  return `query-engine-v2 top-level upsert ${field} skip premise changed before the atomic batch.`;
}
