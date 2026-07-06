import {
  type ConnectOrCreateInput,
  type NestedUpsertInput,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { createChildContext } from "../../context";
import type { Operation, QueryContext } from "../../types";
import type { Mode } from "./mode";
import { assertNoPlannedNestedMutationExecution } from "./planned-mutation";
import {
  type NestedWriteStep,
  normalizeArray,
  normalizeRecordArray,
  planRelationMutationSteps,
} from "./semantic-plan";
import {
  assertNestedUpdatePlanIsExecutable,
  normalizeNestedUpdateInputs,
} from "./update-plan";

/**
 * The single throw site for the capability contract (§6.3).
 *
 * Runs before any effect, in both modes, walking the whole tree. It is the
 * union of today's static checks plus symbol-origin legality and probe
 * independence. Gates 1-5 are semantic invariants (both modes); gates 6-7 are
 * mode-scoped by the `mode` parameter, so the two modes can never disagree
 * about where the line is (§1.2 S2).
 *
 * The roster (§6.3):
 *  1. `separateData` parse validation — engine-independent; performed as the
 *     tree is walked (an unsupported relation payload throws here).
 *  2. `assertNoPlannedNestedMutationExecution` — create / upsert-create
 *     branches may only nest create/createMany/connect/connectOrCreate (I6).
 *  3. `assertNestedUpdatePlanIsExecutable` + `assertUpdateManyDataHasNoRelations`.
 *  4. `assertManyToManyStepCombinationIsSupported` (I8) — lands with the M2M
 *     interpreter (§11 M9); until then the frozen m2m engines own it.
 *  5. FK-nullability static checks — land with the update-family interpreter
 *     (§11 M5); until then the frozen update engines own them.
 *  6. Symbol-origin legality (planned mode only) — lands with the symbol
 *     substrate (§11 M3+); until then the frozen batch plan builder owns the
 *     compound-generated-PK / "known before execution" rejections, so the
 *     message stays single-sourced.
 *  7. Probe independence (planned mode only) — lands with planned-mode probes
 *     (§11 M3+).
 *
 * M2 scope (§11): fold the `update-plan.ts` / `planned-mutation.ts` logic in
 * (gates 2-3) and route it through this one function before either old engine
 * runs, walking the whole create/update tree to full depth. This closes D5 —
 * live mode now rejects an invalid deep tree up front instead of beginning the
 * parent mutation and failing mid-execution. Gates 4-7 populate at their own
 * milestones; the frozen engines keep enforcing them until then, so no premise
 * is dropped and no message diverges.
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
      assertUpsertIsExecutable(ctx, args);
      return;
    default:
      return;
  }
}

/**
 * A create tree may only nest create/createMany/connect/connectOrCreate (I6).
 * The frozen tx engine validates each level only as it reaches it during
 * execution, so an invalid key inside an after-parent child branch is caught
 * only after the parent row is inserted. Walking the whole tree here mirrors
 * the batch engine's plan-time depth and rejects up front (D5 closed).
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
 * `{ where, data }` (array) shape for a to-many relation — the same split
 * `getNestedUpdateDataInputs` makes in the frozen update-plan validator.
 */
function getNestedUpdateDataPayloads(
  step: Extract<NestedWriteStep, { kind: "update" }>
): Record<string, unknown>[] {
  if (step.context.relationInfo.isToOne) {
    return [step.input as Record<string, unknown>];
  }
  return normalizeNestedUpdateInputs(step.input).map((input) => input.data);
}

function assertUpsertIsExecutable(
  ctx: QueryContext,
  args: Record<string, unknown>
): void {
  assertUpsertBranchIsExecutable(ctx, {
    where: args.where as Record<string, unknown> | undefined,
    create: args.create as Record<string, unknown>,
    update: args.update as Record<string, unknown>,
  });
}

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
