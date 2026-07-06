import {
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { createChildContext } from "../../context";
import type { Operation, QueryContext } from "../../types";
import {
  type NestedWriteStep,
  planRelationMutationSteps,
} from "./semantic-plan";
import { normalizeNestedUpdateInputs } from "./update-plan";

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
 * The migrated surface. M3 (§11): the create family over FK-only trees. M5
 * (§11): the update family (update / updateMany / disconnect / delete /
 * deleteMany / set) over FK-only trees, so a top-level `update` and every
 * nested update-family step becomes eligible when the whole tree is FK-only.
 * The `upsert` step kind and the `m2m` class are added at their own milestones
 * (M6/M9). Rollback = remove tokens here.
 */
export const MIGRATED: {
  readonly stepKinds: ReadonlySet<MigratedStepKind>;
  readonly relationClasses: ReadonlySet<MigratedRelationClass>;
} = {
  stepKinds: new Set<MigratedStepKind>([
    "create",
    "createMany",
    "connect",
    "connectOrCreate",
    "update",
    "updateMany",
    "disconnect",
    "delete",
    "deleteMany",
    "set",
  ]),
  relationClasses: new Set<MigratedRelationClass>(["fk"]),
};

/**
 * Static, pure, no I/O (semantic-plan parsing only). True iff EVERY nested step
 * kind AND relation class reachable in this operation's tree is in MIGRATED.
 * Whole trees only — a mixed tree runs entirely on the old engines.
 *
 * M3 migrated top-level `create`; M5 adds top-level `update`. A tree is
 * eligible iff every relation is FK (m2m routes to the old engines until M9)
 * and every reachable step kind is migrated. `separateData` throws on an
 * unsupported relation payload; that throw is engine-independent (the legality
 * gate raises the identical error), so treat it as ineligible and let the
 * frozen path surface it.
 */
export function isTreeEligible(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>
): boolean {
  if (MIGRATED.stepKinds.size === 0 || MIGRATED.relationClasses.size === 0) {
    return false;
  }
  if (!MIGRATED.relationClasses.has("fk")) {
    return false;
  }
  try {
    if (operation === "create") {
      return isDataEligible(
        ctx,
        args.data as Record<string, unknown>,
        "before"
      );
    }
    if (operation === "update") {
      return isDataEligible(ctx, args.data as Record<string, unknown>, "after");
    }
    // Top-level upsert lands at M6; everything else is not a nested-write host.
    return false;
  } catch {
    // A parse error (unsupported nested key) is surfaced identically by the
    // frozen path; route there so no new behavior is introduced.
    return false;
  }
}

/**
 * Every relation mutation in `data` must be an FK relation whose every nested
 * step kind — walked at `timing` and recursively through create/update branches
 * — is migrated. A create tree is walked "before" (I6 closure); an update tree
 * is walked "after".
 */
function isDataEligible(
  ctx: QueryContext,
  data: Record<string, unknown>,
  timing: "before" | "after"
): boolean {
  const { relations } = separateData(ctx, data);
  for (const mutation of Object.values(relations)) {
    if (!isRelationEligible(ctx, mutation, timing)) {
      return false;
    }
  }
  return true;
}

function isRelationEligible(
  ctx: QueryContext,
  mutation: RelationMutation,
  timing: "before" | "after"
): boolean {
  // m2m is not migrated until M9; route the whole tree to the old engines.
  if (mutation.relationInfo.type === "manyToMany") {
    return false;
  }

  const childCtx = createChildContext(
    ctx,
    mutation.relationInfo.targetModel,
    ctx.nextAlias()
  );

  for (const step of planRelationMutationSteps(
    mutation.relationInfo.name,
    mutation,
    timing
  )) {
    if (!MIGRATED.stepKinds.has(step.kind as MigratedStepKind)) {
      return false;
    }
    if (!isStepBranchEligible(childCtx, step)) {
      return false;
    }
  }

  return true;
}

/**
 * Recurse into every branch payload a step reaches so a deep m2m or unmigrated
 * kind nested under it is caught (whole-tree eligibility, §11 A3). Create
 * branches are walked "before" (I6 create closure); update branches "after".
 * A nested `upsert` is not migrated at M5, so its presence as a step kind
 * already fails the MIGRATED.stepKinds check above — no branch recursion needed.
 */
function isStepBranchEligible(
  childCtx: QueryContext,
  step: NestedWriteStep
): boolean {
  switch (step.kind) {
    case "create":
      return step.inputs.every((createData) =>
        isDataEligible(childCtx, createData, "before")
      );
    case "createMany":
      return step.input.data.every((createData) =>
        isDataEligible(childCtx, createData, "before")
      );
    case "connectOrCreate":
      return step.inputs.every((input) =>
        isDataEligible(childCtx, input.create, "before")
      );
    case "update":
      return getNestedUpdateDataPayloads(step).every((updateData) =>
        isDataEligible(childCtx, updateData, "after")
      );
    default:
      // connect / disconnect / delete / deleteMany / updateMany / set carry no
      // recursive create/update payload (updateMany rejects nested relations at
      // the legality gate); nothing further to walk.
      return true;
  }
}

/**
 * The update step's `input` is the raw data object for a to-one relation and a
 * `{ where, data }` (array) shape for a to-many relation.
 */
function getNestedUpdateDataPayloads(
  step: Extract<NestedWriteStep, { kind: "update" }>
): Record<string, unknown>[] {
  if (step.context.relationInfo.isToOne) {
    return [step.input as Record<string, unknown>];
  }
  return normalizeNestedUpdateInputs(step.input).map((input) => input.data);
}
