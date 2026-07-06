import {
  type ConnectOrCreateInput,
  type NestedUpdateInput,
  type NestedUpdateManyInput,
  type NestedUpsertInput,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { createChildContext } from "../../context";
import {
  NestedWriteError,
  type Operation,
  type QueryContext,
} from "../../types";
import type { Mode } from "./mode";
import {
  type NestedWriteStep,
  normalizeArray,
  normalizeRecordArray,
  planRelationMutationSteps,
} from "./semantic-plan";

/**
 * The single throw site for the capability contract (§6.3).
 *
 * Runs before any effect, in both modes, walking the whole tree. It is the
 * static-check union: `separateData` parse validation (engine-independent;
 * performed as the tree is walked, so an unsupported relation payload throws
 * here), the create/upsert-create closure rule (`assertNoPlannedNested-
 * MutationExecution` — I6), and the nested-update / updateMany depth checks
 * (`assertNestedUpdatePlanIsExecutable`, `assertUpdateManyDataHasNoRelations`).
 * Walking the create/update tree to full depth up front closes D5: the
 * interpreter rejects an invalid deep tree before writing a row instead of
 * failing mid-execution.
 *
 * The remaining §6.3 gates fire closer to the effect that needs them and stay
 * single-sourced: FK-nullability and m2m-step-combination checks (I8) live in
 * the interpreter beside the step that would violate them; symbol-origin
 * legality and probe independence (planned mode only) are enforced by
 * `PlannedMode` as symbols are allocated and probes are built. The `_mode`
 * parameter is retained for the signature the pipeline threads (§8.6); this
 * function itself performs the mode-independent tree walk.
 *
 * A top-level upsert is the one operation with NO static tree check here: it
 * takes exactly one branch at runtime, decided by an existence probe the static
 * gate cannot run (create when the target is absent, update when it exists).
 * Hoisting either branch would over-reject the create-taken (missing-target)
 * case that must succeed (Pin Rule 2, §5.5); the branch-scoped check runs in the
 * interpreter inside the taken arm. (A NESTED upsert step reached from an update
 * tree IS validated here, walking both its branches — see
 * `assertUpsertBranchIsExecutable`.)
 */
export function assertPlanExecutable(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>,
  _mode: Mode
): void {
  switch (operation) {
    case "create":
      assertCreateDataIsExecutable(ctx, args.data as Record<string, unknown>);
      return;
    case "update":
      assertUpdateDataIsExecutable(ctx, args.data as Record<string, unknown>);
      return;
    case "upsert":
      // No static tree check: a top-level upsert's branch is chosen at runtime
      // by an existence probe the static gate cannot run. Hoisting either branch
      // would over-reject the create-taken (missing-target) case that must
      // succeed (Pin Rule 2). The branch-scoped check runs in the interpreter.
      return;
    default:
      return;
  }
}

/**
 * A create tree may only nest create/createMany/connect/connectOrCreate (I6).
 * Walking the whole tree here, before the interpreter emits any effect, rejects
 * an invalid key inside an after-parent child branch up front instead of after
 * the parent row is inserted (D5 closed).
 */
function assertCreateDataIsExecutable(
  ctx: QueryContext,
  data: Record<string, unknown>
): void {
  const { relations } = separateData(ctx, data);
  assertNoPlannedNestedMutationExecution(relations, "create");
  walkCreateBranchRelations(ctx, relations);
}

function walkCreateBranchRelations(
  ctx: QueryContext,
  relations: Record<string, RelationMutation>
): void {
  for (const mutation of Object.values(relations)) {
    const childCtx = createChildContext(
      ctx,
      mutation.relationInfo.targetModel,
      ctx.nextAlias()
    );

    if (mutation.create) {
      for (const createData of normalizeRecordArray(mutation.create)) {
        assertCreateDataIsExecutable(childCtx, createData);
      }
    }

    if (mutation.createMany) {
      for (const createData of mutation.createMany.data) {
        assertCreateDataIsExecutable(childCtx, createData);
      }
    }

    if (mutation.connectOrCreate) {
      for (const input of normalizeConnectOrCreateInputs(
        mutation.connectOrCreate
      )) {
        assertCreateDataIsExecutable(childCtx, input.create);
      }
    }
  }
}

/**
 * An update tree recurses through nested update relations and validates each
 * nested create/upsert-create branch (I6), plus updateMany-has-no-relations.
 * `assertNestedUpdatePlanIsExecutable` already walks the update side to full
 * depth; the create branches it reaches are walked recursively here so a
 * deeply-nested invalid create key is rejected up front too (D5 closed).
 */
function assertUpdateDataIsExecutable(
  ctx: QueryContext,
  data: Record<string, unknown>
): void {
  const { relations } = separateData(ctx, data);
  assertNestedUpdatePlanIsExecutable(ctx, relations);
  walkUpdateBranchRelations(ctx, relations);
}

function walkUpdateBranchRelations(
  ctx: QueryContext,
  relations: Record<string, RelationMutation>
): void {
  for (const mutation of Object.values(relations)) {
    const childCtx = createChildContext(
      ctx,
      mutation.relationInfo.targetModel,
      ctx.nextAlias()
    );

    for (const step of planRelationMutationSteps(
      mutation.relationInfo.name,
      mutation,
      "after"
    )) {
      if (step.kind === "create") {
        for (const createData of step.inputs) {
          assertCreateDataIsExecutable(childCtx, createData);
        }
        continue;
      }

      if (step.kind === "connectOrCreate") {
        for (const input of step.inputs) {
          assertCreateDataIsExecutable(childCtx, input.create);
        }
        continue;
      }

      if (step.kind === "update") {
        for (const updateData of getNestedUpdateDataPayloads(step)) {
          assertUpdateDataIsExecutable(childCtx, updateData);
        }
        continue;
      }

      if (step.kind === "upsert") {
        for (const upsertInput of normalizeArray(step.input)) {
          assertUpsertBranchIsExecutable(childCtx, upsertInput);
        }
      }
    }
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

/**
 * A NESTED relation upsert step (reached only from a top-level `update` tree).
 * Unlike a top-level upsert — whose branch is chosen at runtime by an existence
 * probe and cannot be statically hoisted — a nested upsert step IS validated
 * statically here, walking BOTH its branches: the create branch under the I6
 * `upsertCreate` closure rule, the update branch by nested-update recursion. The
 * interpreter interprets only the taken branch at runtime, but both are legal
 * shapes it can reach, so validating both to full depth up front rejects the
 * same invalid trees the runtime walk would, one statement earlier.
 */
function assertUpsertBranchIsExecutable(
  ctx: QueryContext,
  upsertInput: NestedUpsertInput
): void {
  const { relations } = separateData(ctx, upsertInput.create);
  assertNoPlannedNestedMutationExecution(relations, "upsertCreate");
  walkCreateBranchRelations(ctx, relations);
  assertUpdateDataIsExecutable(ctx, upsertInput.update);
}

function normalizeConnectOrCreateInputs(
  input: ConnectOrCreateInput | ConnectOrCreateInput[]
): ConnectOrCreateInput[] {
  return normalizeArray(input);
}

// ===========================================================================
// Nested update/updateMany plan legality + input normalization (§6.3 gate 3).
// `assertNestedUpdatePlanIsExecutable` walks an update tree and validates every
// nested create/upsert-create branch (I6), nested-update recursion, and
// updateMany-has-no-relations. The `normalize*` helpers are pure parsing shared
// by the interpreter and this gate.
// ===========================================================================

export function assertNestedUpdatePlanIsExecutable(
  ctx: QueryContext,
  relations: Record<string, RelationMutation>
): void {
  for (const mutation of Object.values(relations)) {
    const childCtx = createChildContext(
      ctx,
      mutation.relationInfo.targetModel,
      ctx.nextAlias()
    );
    const steps = planRelationMutationSteps(
      mutation.relationInfo.name,
      mutation,
      "after"
    );

    assertNestedCreateBranchesAreExecutable(childCtx, steps);
    assertNestedUpdateBranchesAreExecutable(childCtx, steps);
    assertNestedUpsertBranchesAreExecutable(childCtx, steps);
    assertNestedUpdateManyBranchesAreExecutable(childCtx, steps);
  }
}

export function normalizeNestedUpdateInputs(
  updateInput: Record<string, unknown> | NestedUpdateInput | NestedUpdateInput[]
): NestedUpdateInput[] {
  const inputs = Array.isArray(updateInput) ? updateInput : [updateInput];

  return inputs.map((input) => {
    if (isNestedUpdateInput(input)) {
      return input;
    }

    throw new NestedWriteError(
      "Malformed nested 'update' operation: expected an object with 'where' and 'data'.",
      "update",
      { meta: { operation: "update" } }
    );
  });
}

export function normalizeNestedUpdateManyInputs(
  updateManyInput: NestedUpdateManyInput | NestedUpdateManyInput[]
): NestedUpdateManyInput[] {
  return Array.isArray(updateManyInput) ? updateManyInput : [updateManyInput];
}

export function assertUpdateManyDataHasNoRelations(
  relationName: string,
  relations: Record<string, RelationMutation>
): void {
  const relationKeys = Object.keys(relations);
  if (relationKeys.length === 0) {
    return;
  }

  throw new NestedWriteError(
    `Nested relation writes inside updateMany data for relation '${relationName}' are not supported.`,
    relationName,
    { meta: { operation: "updateMany", relations: relationKeys } }
  );
}

function assertNestedCreateBranchesAreExecutable(
  childCtx: QueryContext,
  steps: NestedWriteStep[]
): void {
  for (const step of steps) {
    if (step.kind === "create") {
      for (const createData of step.inputs) {
        assertNoPlannedNestedMutationExecution(
          separateData(childCtx, createData).relations,
          "create"
        );
      }
      continue;
    }

    if (step.kind === "connectOrCreate") {
      for (const connectOrCreate of step.inputs) {
        assertNoPlannedNestedMutationExecution(
          separateData(childCtx, connectOrCreate.create).relations,
          "create"
        );
      }
    }
  }
}

function assertNestedUpdateBranchesAreExecutable(
  childCtx: QueryContext,
  steps: NestedWriteStep[]
): void {
  for (const updateData of getNestedUpdateDataInputs(steps)) {
    const { relations } = separateData(childCtx, updateData);
    assertNestedUpdatePlanIsExecutable(childCtx, relations);
  }
}

function assertNestedUpdateManyBranchesAreExecutable(
  childCtx: QueryContext,
  steps: NestedWriteStep[]
): void {
  for (const updateManyInput of getNestedUpdateManyInputs(steps)) {
    const { relations } = separateData(childCtx, updateManyInput.data);
    assertUpdateManyDataHasNoRelations(
      updateManyInputRelationName(steps),
      relations
    );
  }
}

function assertNestedUpsertBranchesAreExecutable(
  childCtx: QueryContext,
  steps: NestedWriteStep[]
): void {
  for (const upsertInput of getNestedUpsertInputs(steps)) {
    assertNoPlannedNestedMutationExecution(
      separateData(childCtx, upsertInput.create).relations,
      "upsertCreate"
    );

    const { relations } = separateData(childCtx, upsertInput.update);
    assertNestedUpdatePlanIsExecutable(childCtx, relations);
  }
}

function getNestedUpdateDataInputs(
  steps: NestedWriteStep[]
): Record<string, unknown>[] {
  const step = steps.find((entry) => entry.kind === "update");
  if (!step) {
    return [];
  }

  if (step.context.relationInfo.isToOne) {
    return [step.input as Record<string, unknown>];
  }

  return normalizeNestedUpdateInputs(step.input).map((input) => input.data);
}

function getNestedUpdateManyInputs(
  steps: NestedWriteStep[]
): NestedUpdateManyInput[] {
  const step = steps.find((entry) => entry.kind === "updateMany");
  if (!step) {
    return [];
  }

  return normalizeNestedUpdateManyInputs(step.input);
}

function getNestedUpsertInputs(steps: NestedWriteStep[]): NestedUpsertInput[] {
  const step = steps.find((entry) => entry.kind === "upsert");
  if (!step) {
    return [];
  }

  return normalizeArray(step.input);
}

function updateManyInputRelationName(steps: NestedWriteStep[]): string {
  const step = steps.find((entry) => entry.kind === "updateMany");
  return step?.context.relationName ?? "updateMany";
}

function isNestedUpdateInput(value: unknown): value is NestedUpdateInput {
  return isRecord(value) && isRecord(value.where) && isRecord(value.data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// --- gate 2: create / upsert-create branch closure (I6) --------------------
// Folded from the former `planned-mutation.ts` at M10. A create tree — and the
// create branch of an upsert — may only nest create/createMany/connect/
// connectOrCreate; any read-decided mutation (update/updateMany/upsert/
// deleteMany) inside it is rejected up front, in both modes, with a single
// message.

const PLANNED_MUTATION_KEYS = [
  "update",
  "updateMany",
  "upsert",
  "deleteMany",
] as const;

type PlannedMutationKey = (typeof PLANNED_MUTATION_KEYS)[number];

type PlannedMutationContext = "create" | "upsertCreate";

export function assertNoPlannedNestedMutationExecution(
  relations: Record<string, RelationMutation>,
  context: PlannedMutationContext
): void {
  for (const [relationName, mutation] of Object.entries(relations)) {
    const plannedKey = getPlannedMutationKey(mutation);
    if (!plannedKey) {
      continue;
    }

    throw new NestedWriteError(
      getPlannedMutationMessage(relationName, plannedKey, context),
      relationName,
      { meta: { operation: plannedKey, context } }
    );
  }
}

function getPlannedMutationKey(
  mutation: RelationMutation
): PlannedMutationKey | undefined {
  return PLANNED_MUTATION_KEYS.find((key) => mutation[key] !== undefined);
}

function getPlannedMutationMessage(
  relationName: string,
  operation: PlannedMutationKey,
  context: PlannedMutationContext
): string {
  const branch =
    context === "create" ? "parent create" : "upsert create branch";
  return (
    `Nested operation '${operation}' on relation '${relationName}' is not supported in ${branch}. ` +
    "Only create, createMany, connect, and connectOrCreate are allowed there."
  );
}
