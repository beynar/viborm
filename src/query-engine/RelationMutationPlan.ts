// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler owner RelationMutationPlan.
import type { Model } from "@schema/model";
import {
  type ConnectOrCreateInput,
  type CreateManyInput,
  getFkDirection,
  type NestedUpdateInput,
  type NestedUpdateManyInput,
  type NestedUpsertInput,
  type RelationMutation,
} from "./builders/relation-data-builder";
import { getRelationMutationKinds } from "./builders/relation-mutation-parser";
import {
  classifyTargetConstraintOverlap,
  normalizeWhereUniqueTargetConstraint,
  type TargetConstraint,
} from "./TargetConstraint";
import { NestedWriteError, type QueryScope, type RelationInfo } from "./types";

export type RelationMutationTiming = "before" | "after";

export interface RelationPlanContext {
  relationName: string;
  relationInfo: RelationInfo;
  timing: RelationMutationTiming;
}

export type RelationMutationGuard =
  | {
      kind: "uniqueExists" | "uniqueMissing";
      model: Model<any>;
      where: Record<string, unknown>;
    }
  | UniqueWithWhereGuard;

export interface UniqueWithWhereGuard {
  kind: "uniqueWithWhereExists" | "uniqueWithWhereMissing";
  model: Model<any>;
  uniqueWhere: Record<string, unknown>;
  where: Record<string, unknown>;
}

export interface PlannedUpdateInput {
  readonly data: Record<string, unknown>;
  readonly selector?: Record<string, unknown>;
}

export type RelationMutationStep =
  | {
      kind: "create";
      context: RelationPlanContext;
      inputs: Record<string, unknown>[];
    }
  | {
      kind: "createMany";
      context: RelationPlanContext;
      input: CreateManyInput;
    }
  | {
      kind: "connect";
      context: RelationPlanContext;
      inputs: Record<string, unknown>[];
    }
  | {
      kind: "connectOrCreate";
      context: RelationPlanContext;
      inputs: ConnectOrCreateInput[];
    }
  | {
      kind: "disconnect";
      context: RelationPlanContext;
      input: boolean | Record<string, unknown> | Record<string, unknown>[];
    }
  | {
      kind: "delete";
      context: RelationPlanContext;
      input: boolean | Record<string, unknown> | Record<string, unknown>[];
    }
  | {
      kind: "set";
      context: RelationPlanContext;
      input: Record<string, unknown>[];
    }
  | {
      kind: "update";
      context: RelationPlanContext;
      inputs: PlannedUpdateInput[];
    }
  | {
      kind: "updateMany";
      context: RelationPlanContext;
      inputs: NestedUpdateManyInput[];
    }
  | {
      kind: "deleteMany";
      context: RelationPlanContext;
      inputs: Record<string, unknown>[];
    }
  | {
      kind: "upsert";
      context: RelationPlanContext;
      inputs: NestedUpsertInput[];
    };

export type ExistingUpsertBranch =
  | {
      kind: "targetWhereSkipped";
      existingRecord: Record<string, unknown>;
      pkWhere: Record<string, unknown>;
      guard: RelationMutationGuard;
    }
  | {
      kind: "setWhereSkipped";
      existingRecord: Record<string, unknown>;
      pkWhere: Record<string, unknown>;
      guard: RelationMutationGuard;
    }
  | {
      kind: "update";
      existingRecord: Record<string, unknown>;
      pkWhere: Record<string, unknown>;
      targetWhereGuard?: RelationMutationGuard;
      setWhereGuard?: RelationMutationGuard;
    };

export function splitRelationMutationsByFk(
  ctx: QueryScope,
  relations: Record<string, RelationMutation>
): {
  currentHoldsFk: [string, RelationMutation][];
  relatedHoldsFk: [string, RelationMutation][];
} {
  const currentHoldsFk: [string, RelationMutation][] = [];
  const relatedHoldsFk: [string, RelationMutation][] = [];

  for (const entry of Object.entries(relations)) {
    const [, mutation] = entry;
    // M2M has no FK direction; junction rows are written after the parent
    // row exists, like related-holds-FK mutations.
    if (mutation.relationInfo.type === "manyToMany") {
      relatedHoldsFk.push(entry);
      continue;
    }
    if (getFkDirection(ctx, mutation.relationInfo).holdsFK) {
      currentHoldsFk.push(entry);
    } else {
      relatedHoldsFk.push(entry);
    }
  }

  return { currentHoldsFk, relatedHoldsFk };
}

/**
 * The legality derivation's step sequence. It walks
 * {@link RELATION_MUTATION_KEYS} — **the same order the parts are emitted in** — so
 * the own-write theorem is stated over exactly the sequence that runs (ATOM §4,
 * N6-U3). Before that unification this function carried its OWN order, which
 * disagreed with the emission order on `deleteMany` vs `upsert`; the legality of a
 * shape was therefore derived against a sequence the engine never executed. One
 * order, one derivation — never two.
 */
export function planRelationMutationSteps(
  relationName: string,
  mutation: RelationMutation,
  timing: RelationMutationTiming
): RelationMutationStep[] {
  const context: RelationPlanContext = {
    relationName,
    relationInfo: mutation.relationInfo,
    timing,
  };
  const steps: RelationMutationStep[] = [];

  // Each arm keeps the presence check the if-chain always had — it is the narrowing
  // that types the payload, not an added guard. What moved is only WHERE the order
  // comes from: the shared constant instead of the order these arms are written in.
  for (const kind of getRelationMutationKinds(mutation)) {
    switch (kind) {
      case "create":
        if (mutation.create) {
          steps.push({
            kind,
            context,
            inputs: normalizeRecordArray(mutation.create),
          });
        }
        break;
      case "createMany":
        if (mutation.createMany) {
          steps.push({ kind, context, input: mutation.createMany });
        }
        break;
      case "connect":
        if (mutation.connect) {
          steps.push({
            kind,
            context,
            inputs: normalizeRecordArray(mutation.connect),
          });
        }
        break;
      case "connectOrCreate":
        if (mutation.connectOrCreate) {
          steps.push({
            kind,
            context,
            inputs: dedupeConnectOrCreateInputs(
              mutation.relationInfo.targetModel,
              normalizeArray(mutation.connectOrCreate)
            ),
          });
        }
        break;
      case "disconnect":
        if (mutation.disconnect) {
          steps.push({ kind, context, input: mutation.disconnect });
        }
        break;
      case "delete":
        if (mutation.delete) {
          steps.push({ kind, context, input: mutation.delete });
        }
        break;
      case "set":
        if (mutation.set) {
          steps.push({ kind, context, input: mutation.set });
        }
        break;
      case "update":
        if (mutation.update) {
          steps.push({ kind, context, inputs: normalizeUpdateInputs(mutation) });
        }
        break;
      case "updateMany":
        if (mutation.updateMany) {
          steps.push({
            kind,
            context,
            inputs: normalizeArray(mutation.updateMany),
          });
        }
        break;
      case "deleteMany":
        if (mutation.deleteMany) {
          steps.push({
            kind,
            context,
            inputs: normalizeRecordArray(mutation.deleteMany),
          });
        }
        break;
      case "upsert":
        if (mutation.upsert) {
          steps.push({ kind, context, inputs: normalizeArray(mutation.upsert) });
        }
        break;
      default: {
        const exhaustive: never = kind;
        throw new TypeError(`Unknown relation mutation kind: ${exhaustive}`);
      }
    }
  }

  return steps;
}

function normalizeUpdateInputs(
  mutation: RelationMutation
): PlannedUpdateInput[] {
  if (mutation.relationInfo.isToOne) {
    if (isRecord(mutation.update)) return [{ data: mutation.update }];
    throw new TypeError("To-one nested update data must be an object.");
  }

  return normalizeArray(mutation.update).map((input) => {
    if (isNestedUpdateInput(input)) {
      return { data: input.data, selector: input.where };
    }
    throw new NestedWriteError(
      "Malformed nested 'update' operation: expected an object with 'where' and 'data'.",
      "update",
      { meta: { operation: "update" } }
    );
  });
}

function isNestedUpdateInput(value: unknown): value is NestedUpdateInput {
  return isRecord(value) && isRecord(value.where) && isRecord(value.data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function planExistingUpsertBranch(input: {
  model: Model<any>;
  existingRecord: Record<string, unknown>;
  pkWhere: Record<string, unknown>;
  targetWhere?: unknown;
  targetWhereMatched?: boolean;
  setWhere?: unknown;
  setWhereMatched?: boolean;
}): ExistingUpsertBranch {
  if (hasRecordKeys(input.targetWhere)) {
    const guard = createUniqueWithWhereGuard(
      "uniqueWithWhereExists",
      input.model,
      input.pkWhere,
      input.targetWhere
    );
    if (!input.targetWhereMatched) {
      return {
        kind: "targetWhereSkipped",
        existingRecord: input.existingRecord,
        pkWhere: input.pkWhere,
        guard: { ...guard, kind: "uniqueWithWhereMissing" },
      };
    }
  }

  if (hasRecordKeys(input.setWhere)) {
    const guard = createUniqueWithWhereGuard(
      "uniqueWithWhereExists",
      input.model,
      input.pkWhere,
      input.setWhere
    );
    if (!input.setWhereMatched) {
      return {
        kind: "setWhereSkipped",
        existingRecord: input.existingRecord,
        pkWhere: input.pkWhere,
        guard: { ...guard, kind: "uniqueWithWhereMissing" },
      };
    }
  }

  return {
    kind: "update",
    existingRecord: input.existingRecord,
    pkWhere: input.pkWhere,
    targetWhereGuard: hasRecordKeys(input.targetWhere)
      ? createUniqueWithWhereGuard(
          "uniqueWithWhereExists",
          input.model,
          input.pkWhere,
          input.targetWhere
        )
      : undefined,
    setWhereGuard: hasRecordKeys(input.setWhere)
      ? createUniqueWithWhereGuard(
          "uniqueWithWhereExists",
          input.model,
          input.pkWhere,
          input.setWhere
        )
      : undefined,
  };
}

export function createUniqueWithWhereGuard(
  kind: "uniqueWithWhereExists" | "uniqueWithWhereMissing",
  model: Model<any>,
  uniqueWhere: Record<string, unknown>,
  where: Record<string, unknown>
): UniqueWithWhereGuard {
  return { kind, model, uniqueWhere, where };
}

export function hasRecordKeys(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== undefined &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

/**
 * Repeated connectOrCreate targets in one array must behave like a single
 * entry (first create wins) — the tx engine's second pass would connect, but
 * the batch engine would abort on its uniqueMissing assertion.
 */
function dedupeConnectOrCreateInputs(
  model: Model<any>,
  inputs: ConnectOrCreateInput[]
): ConnectOrCreateInput[] {
  if (inputs.length <= 1) {
    return inputs;
  }

  const uniqueInputs: ConnectOrCreateInput[] = [];
  const seenTargets: TargetConstraint[] = [];
  for (const input of inputs) {
    const target = normalizeWhereUniqueTargetConstraint(model, input.where);
    const isDuplicate = seenTargets.some(
      (seenTarget) =>
        classifyTargetConstraintOverlap(seenTarget, target) === "equal"
    );
    if (!isDuplicate) {
      uniqueInputs.push(input);
      seenTargets.push(target);
    }
  }

  return uniqueInputs;
}

export function normalizeRecordArray<T extends Record<string, unknown>>(
  input: T | T[]
): T[] {
  return Array.isArray(input) ? input : [input];
}

export function normalizeArray<T>(input: T | T[]): T[] {
  return Array.isArray(input) ? input : [input];
}
