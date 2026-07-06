import {
  type NestedUpdateInput,
  type NestedUpdateManyInput,
  type NestedUpsertInput,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { createChildContext } from "../../context";
import { NestedWriteError, type QueryContext } from "../../types";
import { assertNoPlannedNestedMutationExecution } from "./planned-mutation";
import {
  type NestedWriteStep,
  normalizeArray,
  planRelationMutationSteps,
} from "./semantic-plan";

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
