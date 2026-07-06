import type { Operation, QueryContext } from "../../types";

/**
 * The migration routing seam (§11). TEMPORARY: deleted at M10.
 *
 * A nested-write tree routes to the new interpreter iff EVERY nested step kind
 * AND relation class (fk | m2m) reachable in it is migrated. Whole trees only —
 * a mixed tree runs entirely on the old engines, so no Expr↔parentData interop
 * seam ever exists (§1.2 A3). Coverage grows milestone by milestone by adding
 * tokens to `MIGRATED`; deletion of the old engines is deferred to
 * unreachability at M9.
 */

/** A step kind that may appear in a nested-write tree. */
export type MigratedStepKind =
  | "create"
  | "createMany"
  | "connect"
  | "connectOrCreate"
  | "update"
  | "updateMany"
  | "upsert"
  | "disconnect"
  | "delete"
  | "deleteMany"
  | "set";

/** The relation class a step operates over. */
export type MigratedRelationClass = "fk" | "m2m";

/**
 * The migrated surface. Empty at M1 — the interpreter delegates 100% to the
 * old engines. Milestones M3+ add tokens here (create family FK-only at M3,
 * update family at M5, upsert at M6, anything m2m at M9). Rollback for any
 * milestone = remove its tokens.
 */
export const MIGRATED: {
  readonly stepKinds: ReadonlySet<MigratedStepKind>;
  readonly relationClasses: ReadonlySet<MigratedRelationClass>;
} = {
  stepKinds: new Set<MigratedStepKind>(),
  relationClasses: new Set<MigratedRelationClass>(),
};

/**
 * Static, pure, no I/O (semantic-plan parsing only). True iff EVERY nested
 * step kind AND relation class reachable in this operation's tree is in
 * MIGRATED. Whole trees only — a mixed tree runs entirely on the old engines.
 *
 * With an empty MIGRATED (M1) no tree is eligible, so this short-circuits to
 * false before any tree walk. The whole-tree walk lands with the first
 * migration milestone (M3), gated by this same predicate.
 */
export function isTreeEligible(
  _ctx: QueryContext,
  _operation: Operation,
  _args: Record<string, unknown>
): boolean {
  if (MIGRATED.stepKinds.size === 0 || MIGRATED.relationClasses.size === 0) {
    return false;
  }
  // The whole-tree eligibility walk lands at M3 (§11). Until a step kind and a
  // relation class are both migrated, no tree can be eligible.
  return false;
}
