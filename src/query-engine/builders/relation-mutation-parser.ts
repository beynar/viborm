import { getRelationInfo, isRelation } from "../context";
import { NestedWriteError, type QueryScope, type RelationInfo } from "../types";
import type {
  ConnectOrCreateInput,
  CreateManyInput,
  NestedUpdateInput,
  NestedUpdateManyInput,
  NestedUpsertInput,
  RelationMutation,
  SeparatedData,
} from "./relation-data-builder";

export const RELATION_MUTATION_KEYS = [
  "create",
  "createMany",
  "connect",
  "connectOrCreate",
  "disconnect",
  "delete",
  "set",
  "update",
  "updateMany",
  "upsert",
  "deleteMany",
] as const;

export type RelationMutationKind = (typeof RELATION_MUTATION_KEYS)[number];

export function getRelationMutationKinds(
  mutation: RelationMutation
): RelationMutationKind[] {
  return RELATION_MUTATION_KEYS.filter((kind) => mutation[kind] !== undefined);
}

export function assertSingleRelationInput(
  relationInfo: RelationInfo,
  operation: string,
  inputs: readonly unknown[]
): void {
  if (!relationInfo.isToOne || inputs.length <= 1) return;
  throw new NestedWriteError(
    `Cannot use multiple '${operation}' inputs for to-one relation '${relationInfo.name}'.`,
    relationInfo.name
  );
}

export function separateData(
  ctx: QueryScope,
  data: Record<string, unknown>
): SeparatedData {
  const scalarData: Record<string, unknown> = {};
  const relations: Record<string, RelationMutation> = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!isRelation(ctx.model, key)) {
      scalarData[key] = value;
      continue;
    }

    const relationInfo = getRelationInfo(ctx, key);
    if (!relationInfo) continue;
    const mutation = parseRelationMutation(relationInfo, value);
    if (mutation) relations[key] = mutation;
  }

  return { scalarData, relations };
}

function parseRelationMutation(
  relationInfo: RelationInfo,
  value: unknown
): RelationMutation | undefined {
  if (!hasRelationMutationInput(value)) {
    if (isRecord(value) && Object.keys(value).length > 0) {
      throw new NestedWriteError(
        `Unsupported nested write operation on relation '${relationInfo.name}': ${Object.keys(value).join(", ")}`,
        relationInfo.name
      );
    }
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const mutation: RelationMutation = { relationInfo };
  for (const key of RELATION_MUTATION_KEYS) {
    if (!(key in input) || input[key] === undefined) continue;
    switch (key) {
      case "connect":
        mutation.connect = input.connect as
          | Record<string, unknown>
          | Record<string, unknown>[];
        break;
      case "disconnect":
        mutation.disconnect = input.disconnect as
          | boolean
          | Record<string, unknown>
          | Record<string, unknown>[];
        break;
      case "create":
        mutation.create = input.create as
          | Record<string, unknown>
          | Record<string, unknown>[];
        break;
      case "createMany":
        mutation.createMany = input.createMany as CreateManyInput;
        break;
      case "connectOrCreate":
        mutation.connectOrCreate = input.connectOrCreate as
          | ConnectOrCreateInput
          | ConnectOrCreateInput[];
        break;
      case "delete":
        mutation.delete = input.delete as
          | boolean
          | Record<string, unknown>
          | Record<string, unknown>[];
        break;
      case "set":
        mutation.set = Array.isArray(input.set)
          ? (input.set as Record<string, unknown>[])
          : ([input.set] as Record<string, unknown>[]);
        break;
      case "update":
        mutation.update = parseNestedUpdateInput(relationInfo, input.update);
        break;
      case "updateMany":
        mutation.updateMany = parseNestedUpdateManyInput(
          relationInfo,
          input.updateMany
        );
        break;
      case "upsert":
        mutation.upsert = parseNestedUpsertInput(relationInfo, input.upsert);
        break;
      case "deleteMany":
        mutation.deleteMany = parseNestedDeleteManyInput(
          relationInfo,
          input.deleteMany
        );
        break;
      default:
        break;
    }
  }
  return mutation;
}

function hasRelationMutationInput(
  value: unknown
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return RELATION_MUTATION_KEYS.some((key) => {
    if (key !== "set") return value[key] !== undefined;
    return Array.isArray(value.set) || isRecord(value.set);
  });
}

function parseNestedUpdateInput(
  relationInfo: RelationInfo,
  value: unknown
): Record<string, unknown> | NestedUpdateInput | NestedUpdateInput[] {
  if (relationInfo.isToOne)
    return requireRecordEnvelope(relationInfo, "update", value);
  return parseSingleOrArrayRecord(value, relationInfo, "update").map(
    (input) => ({
      where: requireRecordField(relationInfo, "update", input, "where"),
      data: requireRecordField(relationInfo, "update", input, "data"),
    })
  );
}

function parseNestedUpdateManyInput(
  relationInfo: RelationInfo,
  value: unknown
): NestedUpdateManyInput | NestedUpdateManyInput[] {
  rejectToOneOperation(relationInfo, "updateMany");
  return parseSingleOrArrayRecord(value, relationInfo, "updateMany").map(
    (input) => {
      const parsed: NestedUpdateManyInput = {
        data: requireRecordField(relationInfo, "updateMany", input, "data"),
      };
      if (input.where !== undefined) {
        parsed.where = requireRecordField(
          relationInfo,
          "updateMany",
          input,
          "where"
        );
      }
      return parsed;
    }
  );
}

function parseNestedUpsertInput(
  relationInfo: RelationInfo,
  value: unknown
): NestedUpsertInput | NestedUpsertInput[] {
  if (relationInfo.isToOne && Array.isArray(value)) {
    throw new NestedWriteError(
      `Malformed nested 'upsert' operation on relation '${relationInfo.name}': expected a single object envelope for to-one relations.`,
      relationInfo.name,
      { meta: { operation: "upsert" } }
    );
  }
  const parsed = parseSingleOrArrayRecord(value, relationInfo, "upsert").map(
    (input) => {
      const upsertInput: NestedUpsertInput = {
        create: requireRecordField(relationInfo, "upsert", input, "create"),
        update: requireRecordField(relationInfo, "upsert", input, "update"),
      };
      if (relationInfo.isToMany) {
        upsertInput.where = requireRecordField(
          relationInfo,
          "upsert",
          input,
          "where"
        );
      }
      return upsertInput;
    }
  );
  return relationInfo.isToOne ? parsed[0]! : parsed;
}

function parseNestedDeleteManyInput(
  relationInfo: RelationInfo,
  value: unknown
): Record<string, unknown> | Record<string, unknown>[] {
  rejectToOneOperation(relationInfo, "deleteMany");
  return parseSingleOrArrayRecord(value, relationInfo, "deleteMany");
}

function parseSingleOrArrayRecord(
  value: unknown,
  relationInfo: RelationInfo,
  operation: string
): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value]).map((entry) =>
    requireRecordEnvelope(relationInfo, operation, entry)
  );
}

function requireRecordEnvelope(
  relationInfo: RelationInfo,
  operation: string,
  value: unknown
): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new NestedWriteError(
    `Malformed nested '${operation}' operation on relation '${relationInfo.name}': expected an object envelope.`,
    relationInfo.name,
    { meta: { operation } }
  );
}

function requireRecordField(
  relationInfo: RelationInfo,
  operation: string,
  input: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  const value = input[field];
  if (isRecord(value)) return value;
  throw new NestedWriteError(
    `Malformed nested '${operation}' operation on relation '${relationInfo.name}': expected '${field}' to be an object.`,
    relationInfo.name,
    { meta: { operation, field } }
  );
}

function rejectToOneOperation(
  relationInfo: RelationInfo,
  operation: string
): void {
  if (!relationInfo.isToOne) return;
  throw new NestedWriteError(
    `Nested operation '${operation}' is not supported for to-one relation '${relationInfo.name}'.`,
    relationInfo.name,
    { meta: { operation } }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
