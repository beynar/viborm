import type { Model } from "@schema/model";
import {
  type ConnectOrCreateInput,
  type CreateManyInput,
  getFkDirection,
  type NestedUpdateInput,
  type NestedUpdateManyInput,
  type NestedUpsertInput,
  type RelationMutation,
} from "../../builders/relation-data-builder";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";

export type NestedWriteTiming = "before" | "after";

export interface RecordRef {
  model: Model<any>;
  where?: Record<string, unknown>;
  record?: Record<string, unknown>;
}

export interface RelationPlanContext {
  relationName: string;
  relationInfo: RelationInfo;
  timing: NestedWriteTiming;
}

export type NestedWriteGuard =
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

export type NestedWriteStep =
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
      input: Record<string, unknown> | NestedUpdateInput | NestedUpdateInput[];
    }
  | {
      kind: "updateMany";
      context: RelationPlanContext;
      input: NestedUpdateManyInput | NestedUpdateManyInput[];
    }
  | {
      kind: "deleteMany";
      context: RelationPlanContext;
      input: Record<string, unknown> | Record<string, unknown>[];
    }
  | {
      kind: "upsert";
      context: RelationPlanContext;
      input: NestedUpsertInput | NestedUpsertInput[];
    };

export interface NestedWritePlan {
  operation: "create" | "update" | "upsert";
  steps: NestedWriteStep[];
  guards: NestedWriteGuard[];
  resultRef?: RecordRef;
}

export type ExistingUpsertBranch =
  | {
      kind: "targetWhereSkipped";
      existingRecord: Record<string, unknown>;
      pkWhere: Record<string, unknown>;
      guard: NestedWriteGuard;
    }
  | {
      kind: "setWhereSkipped";
      existingRecord: Record<string, unknown>;
      pkWhere: Record<string, unknown>;
      guard: NestedWriteGuard;
    }
  | {
      kind: "update";
      existingRecord: Record<string, unknown>;
      pkWhere: Record<string, unknown>;
      targetWhereGuard?: NestedWriteGuard;
      setWhereGuard?: NestedWriteGuard;
    };

export function splitRelationMutationsByFk(
  ctx: QueryContext,
  relations: Record<string, RelationMutation>
): {
  currentHoldsFk: Array<[string, RelationMutation]>;
  relatedHoldsFk: Array<[string, RelationMutation]>;
} {
  const currentHoldsFk: Array<[string, RelationMutation]> = [];
  const relatedHoldsFk: Array<[string, RelationMutation]> = [];

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

export function planRelationMutationSteps(
  relationName: string,
  mutation: RelationMutation,
  timing: NestedWriteTiming
): NestedWriteStep[] {
  const context: RelationPlanContext = {
    relationName,
    relationInfo: mutation.relationInfo,
    timing,
  };
  const steps: NestedWriteStep[] = [];

  if (mutation.create) {
    steps.push({
      kind: "create",
      context,
      inputs: normalizeRecordArray(mutation.create),
    });
  }

  if (mutation.createMany) {
    steps.push({ kind: "createMany", context, input: mutation.createMany });
  }

  if (mutation.connect) {
    steps.push({
      kind: "connect",
      context,
      inputs: normalizeRecordArray(mutation.connect),
    });
  }

  if (mutation.connectOrCreate) {
    steps.push({
      kind: "connectOrCreate",
      context,
      inputs: dedupeConnectOrCreateInputs(
        normalizeArray(mutation.connectOrCreate)
      ),
    });
  }

  if (mutation.disconnect) {
    steps.push({ kind: "disconnect", context, input: mutation.disconnect });
  }

  if (mutation.delete) {
    steps.push({ kind: "delete", context, input: mutation.delete });
  }

  if (mutation.set) {
    steps.push({ kind: "set", context, input: mutation.set });
  }

  if (mutation.update) {
    steps.push({ kind: "update", context, input: mutation.update });
  }

  if (mutation.updateMany) {
    steps.push({ kind: "updateMany", context, input: mutation.updateMany });
  }

  if (mutation.deleteMany) {
    steps.push({ kind: "deleteMany", context, input: mutation.deleteMany });
  }

  if (mutation.upsert) {
    steps.push({ kind: "upsert", context, input: mutation.upsert });
  }

  return steps;
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
  inputs: ConnectOrCreateInput[]
): ConnectOrCreateInput[] {
  if (inputs.length <= 1) {
    return inputs;
  }
  const seen = new Set<string>();
  return inputs.filter((input) => {
    const key = JSON.stringify(input.where);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * The tx engine executes connect/create/set before deleteMany, while the
 * batch engine resolves deleteMany targets at plan time — combining them in
 * one nested write would silently produce different end states per engine.
 */
export function assertManyToManyStepCombinationIsSupported(
  relationName: string,
  mutation: RelationMutation
): void {
  if (!mutation.deleteMany) {
    return;
  }
  const conflicting = (
    ["create", "connect", "connectOrCreate", "set"] as const
  ).find((key) => mutation[key] !== undefined);
  if (conflicting) {
    throw new NestedWriteError(
      `Cannot combine '${conflicting}' with 'deleteMany' in one nested write on many-to-many relation '${relationName}' — split them into separate updates.`,
      relationName,
      { meta: { operation: "deleteMany", conflictsWith: conflicting } }
    );
  }
}

export function normalizeRecordArray<T extends Record<string, unknown>>(
  input: T | T[]
): T[] {
  return Array.isArray(input) ? input : [input];
}

export function normalizeArray<T>(input: T | T[]): T[] {
  return Array.isArray(input) ? input : [input];
}
