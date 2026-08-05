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

/**
 * **The own-write linearization order (N6-U3, ATOM §4).** The ONE sequence in which
 * sibling mutation kinds on a single relation compose — used both to EMIT the parts
 * and to DERIVE their legality, so the soundness theorem is stated over exactly the
 * order that runs. Read ATOM §4 before touching it; the three stages are:
 *
 *  1. **named readers** — kinds that address rows they NAME and read committed state
 *     to do it (`disconnect`, `delete`, `update`, `upsert`, `connectOrCreate`). Their
 *     writes are bounded by the identity the payload spells.
 *  2. **unbounded writers** — kinds whose footprint is a whole-membership declaration
 *     or a filter (`set`, `updateMany`, `deleteMany`). Every read must precede them.
 *  3. **pure adders** — kinds that read nothing (`connect`, `create`, `createMany`).
 *     Their writes land last, where no decision read can be invalidated by them.
 *
 * The stage boundary is the invariant: **every read is ordered before every write it
 * could not bound.** What survives rejection is then only a genuine payload
 * contradiction — two kinds naming the SAME row — never an artefact of the order.
 */
export const RELATION_MUTATION_KEYS = [
  // 1 — named readers
  "disconnect",
  "delete",
  "update",
  "upsert",
  "connectOrCreate",
  // 2 — unbounded writers
  "set",
  "updateMany",
  "deleteMany",
  // 3 — pure adders
  "connect",
  "create",
  "createMany",
] as const;

export type RelationMutationKind = (typeof RELATION_MUTATION_KEYS)[number];

/**
 * **Prisma's boolean no-op arm (N7-U-B).** A to-one `disconnect` / `delete` is typed
 * `v.boolean()` at the parse boundary, so the only value other than `true` any payload
 * can carry is the literal `false` — and `false` means DO NOTHING. Measured live against
 * Prisma 7.9.1 (`@prisma/adapter-pg`, Postgres): `user.update({ data: { profile:
 * { disconnect: false } } })` and `{ delete: false }` both return the parent unchanged,
 * with the child row and its foreign key untouched, on the inverse side AND the
 * parent-held side alike; the same payloads spelled `true` null the key / delete the row.
 *
 * The kind list is where that is spelled ONCE, because it is the single derivation point
 * for "which kinds does this payload ask for" — the six V2 dispatches and the own-write
 * legality walk all read it (ATOM §4). A kind that asks for nothing is not in the list,
 * so no arm is built for it, no legality footprint is derived from it, and no site
 * downstream has to re-ask whether the boolean was `true`.
 */
export function getRelationMutationKinds(
  mutation: RelationMutation
): RelationMutationKind[] {
  return RELATION_MUTATION_KEYS.filter(
    (kind) => mutation[kind] !== undefined && mutation[kind] !== false
  );
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
  // `payload` keeps the narrowed record itself: this parser is the one place the
  // relation payload stops being `unknown`, so a reader that needs the WHOLE payload
  // (not one normalized kind) takes it from here rather than narrowing again.
  const mutation: RelationMutation = { relationInfo, payload: input };
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
