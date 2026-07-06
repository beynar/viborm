import {
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { createChildContext } from "../../context";
import type { Operation, QueryContext } from "../../types";
import {
  normalizeArray,
  normalizeRecordArray,
  planRelationMutationSteps,
} from "./semantic-plan";

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
 * The migrated surface. M3 (§11): the create family over FK-only trees. The
 * legal closure of a create tree is create/createMany/connect/connectOrCreate
 * (I6), so those four step kinds plus the `fk` relation class make every
 * FK-only create tree eligible. Update/upsert step kinds and the `m2m` class
 * are added at their own milestones (M5/M6/M9). Rollback = remove tokens here.
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
  ]),
  relationClasses: new Set<MigratedRelationClass>(["fk"]),
};

/**
 * Static, pure, no I/O (semantic-plan parsing only). True iff EVERY nested step
 * kind AND relation class reachable in this operation's tree is in MIGRATED.
 * Whole trees only — a mixed tree runs entirely on the old engines.
 *
 * M3: only top-level `create` is migrated (update/upsert land at M5/M6). A
 * create tree is eligible iff every relation is FK (m2m routes to the old
 * engines until M9) and every reachable step kind is migrated. `separateData`
 * throws on an unsupported relation payload; that throw is engine-independent
 * (the legality gate raises the identical error), so treat it as ineligible and
 * let the frozen path surface it.
 */
export function isTreeEligible(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>
): boolean {
  if (MIGRATED.stepKinds.size === 0 || MIGRATED.relationClasses.size === 0) {
    return false;
  }
  // Only the create family is migrated at M3.
  if (operation !== "create") {
    return false;
  }
  try {
    return isCreateDataEligible(ctx, args.data as Record<string, unknown>);
  } catch {
    // A parse error (unsupported nested key) is surfaced identically by the
    // frozen path; route there so no new behavior is introduced.
    return false;
  }
}

function isCreateDataEligible(
  ctx: QueryContext,
  data: Record<string, unknown>
): boolean {
  const { relations } = separateData(ctx, data);
  for (const mutation of Object.values(relations)) {
    if (!isRelationEligible(ctx, mutation)) {
      return false;
    }
  }
  return true;
}

function isRelationEligible(
  ctx: QueryContext,
  mutation: RelationMutation
): boolean {
  // m2m is not migrated until M9; route the whole tree to the old engines.
  if (mutation.relationInfo.type === "manyToMany") {
    return false;
  }
  if (!MIGRATED.relationClasses.has("fk")) {
    return false;
  }

  const childCtx = createChildContext(
    ctx,
    mutation.relationInfo.targetModel,
    ctx.nextAlias()
  );

  // A create tree's steps: create / createMany / connect / connectOrCreate.
  // Any other step kind (an update-family key smuggled into a create) is not
  // migrated at M3; walking with planRelationMutationSteps surfaces the kinds.
  for (const step of planRelationMutationSteps(
    mutation.relationInfo.name,
    mutation,
    "before"
  )) {
    if (!MIGRATED.stepKinds.has(step.kind as MigratedStepKind)) {
      return false;
    }
  }

  // Recurse into every create-branch payload so a deep m2m or unmigrated kind
  // nested under a create is caught (whole-tree eligibility, §11 A3).
  if (mutation.create) {
    for (const createData of normalizeRecordArray(mutation.create)) {
      if (!isCreateDataEligible(childCtx, createData)) {
        return false;
      }
    }
  }
  if (mutation.createMany) {
    for (const createData of mutation.createMany.data) {
      if (!isCreateDataEligible(childCtx, createData)) {
        return false;
      }
    }
  }
  if (mutation.connectOrCreate) {
    for (const input of normalizeArray(mutation.connectOrCreate)) {
      if (!isCreateDataEligible(childCtx, input.create)) {
        return false;
      }
    }
  }

  return true;
}
