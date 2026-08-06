import { splitToOneUpdateTarget } from "@validation/relations/to-one-update-form";
import { getRelationInfo, isRelation } from "../context";
import { NestedWriteError, type QueryScope, type RelationInfo } from "../types";

export interface ConnectOrCreateInput {
  readonly where: Record<string, unknown>;
  readonly create: Record<string, unknown>;
}

export interface NestedUpdateManyInput {
  readonly where?: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}

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
const RELATION_MUTATION_KEYS = [
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

export interface PartitionedModelData {
  readonly scalarData: Record<string, unknown>;
  readonly relationPayloads: Readonly<
    Record<
      string,
      {
        readonly relationInfo: RelationInfo;
        readonly payload: unknown;
      }
    >
  >;
}

export interface CorrelatedRelationMutationTarget {
  readonly kind: "correlated";
  readonly filter?: Record<string, unknown>;
}

export interface UniqueRelationMutationTarget {
  readonly kind: "unique";
  readonly where: Record<string, unknown>;
}

export interface NormalizedRelationUpdate {
  readonly target:
    | CorrelatedRelationMutationTarget
    | UniqueRelationMutationTarget;
  readonly data: Record<string, unknown>;
}

export interface NormalizedRelationUpsert {
  readonly target:
    | CorrelatedRelationMutationTarget
    | UniqueRelationMutationTarget;
  readonly create: Record<string, unknown>;
  readonly update: Record<string, unknown>;
}

export type CurrentOrSelectorTargets =
  | { readonly kind: "current" }
  | {
      readonly kind: "selectors";
      readonly targets: readonly Record<string, unknown>[];
    };

export type RelationMutationEntry =
  | {
      readonly kind: "create";
      readonly items: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "createMany";
      readonly rows: readonly Record<string, unknown>[];
      readonly skipDuplicates?: boolean;
    }
  | {
      readonly kind: "connect";
      readonly targets: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "connectOrCreate";
      readonly items: readonly ConnectOrCreateInput[];
    }
  | {
      readonly kind: "disconnect";
      readonly target: CurrentOrSelectorTargets;
    }
  | {
      readonly kind: "delete";
      readonly target: CurrentOrSelectorTargets;
    }
  | {
      readonly kind: "set";
      readonly targets: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "update";
      readonly items: readonly NormalizedRelationUpdate[];
    }
  | {
      readonly kind: "updateMany";
      readonly items: readonly NestedUpdateManyInput[];
    }
  | {
      readonly kind: "deleteMany";
      readonly filters: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "upsert";
      readonly items: readonly NormalizedRelationUpsert[];
    };

export interface RelationMutationProgram {
  readonly relationInfo: RelationInfo;
  readonly entries: readonly RelationMutationEntry[];
}

export function partitionModelData(
  ctx: QueryScope,
  data: Record<string, unknown>
): PartitionedModelData {
  const scalarData: Record<string, unknown> = {};
  const relationPayloads: Record<
    string,
    { readonly relationInfo: RelationInfo; readonly payload: unknown }
  > = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!isRelation(ctx.model, key)) {
      scalarData[key] = value;
      continue;
    }

    const relationInfo = getRelationInfo(ctx, key);
    if (relationInfo) relationPayloads[key] = { relationInfo, payload: value };
  }

  return { scalarData, relationPayloads };
}

export function buildRelationMutationProgram(
  relationInfo: RelationInfo,
  parsedPayload: unknown
): RelationMutationProgram | undefined {
  if (!hasRelationMutationInput(parsedPayload)) {
    if (isRecord(parsedPayload) && Object.keys(parsedPayload).length > 0) {
      throw new NestedWriteError(
        `Unsupported nested write operation on relation '${relationInfo.name}': ${Object.keys(parsedPayload).join(", ")}`,
        relationInfo.name
      );
    }
    return undefined;
  }

  const entries: RelationMutationEntry[] = [];
  for (const kind of RELATION_MUTATION_KEYS) {
    const value = parsedPayload[kind];
    if (value === undefined || value === false) continue;

    switch (kind) {
      case "create":
        entries.push({
          kind,
          items: parseSingleOrArrayRecord(value, relationInfo, kind),
        });
        break;
      case "createMany": {
        const envelope = requireRecordEnvelope(relationInfo, kind, value);
        entries.push({
          kind,
          rows: requireRecordArrayField(relationInfo, kind, envelope, "data"),
          ...(typeof envelope.skipDuplicates === "boolean"
            ? { skipDuplicates: envelope.skipDuplicates }
            : {}),
        });
        break;
      }
      case "connect":
        entries.push({
          kind,
          targets: parseSingleOrArrayRecord(value, relationInfo, kind),
        });
        break;
      case "connectOrCreate":
        entries.push({
          kind,
          items: parseConnectOrCreateItems(relationInfo, value),
        });
        break;
      case "disconnect":
      case "delete":
        entries.push({
          kind,
          target:
            value === true
              ? { kind: "current" }
              : {
                  kind: "selectors",
                  targets: parseSingleOrArrayRecord(value, relationInfo, kind),
                },
        });
        break;
      case "set":
        entries.push({
          kind,
          targets: parseSingleOrArrayRecord(value, relationInfo, kind),
        });
        break;
      case "update":
        entries.push({
          kind,
          items: parseNormalizedUpdates(relationInfo, value),
        });
        break;
      case "updateMany":
        entries.push({
          kind,
          items: parseNormalizedUpdateMany(relationInfo, value),
        });
        break;
      case "deleteMany":
        entries.push({
          kind,
          filters: parseNormalizedDeleteMany(relationInfo, value),
        });
        break;
      case "upsert":
        entries.push({
          kind,
          items: parseNormalizedUpserts(relationInfo, value),
        });
        break;
      default: {
        const exhaustive: never = kind;
        throw new TypeError(`Unknown relation mutation kind: ${exhaustive}`);
      }
    }
  }

  return entries.length > 0 ? { relationInfo, entries } : undefined;
}

export function buildParsedRelationPrograms(
  ctx: QueryScope,
  parsedData: Record<string, unknown>
): {
  scalarData: Record<string, unknown>;
  relations: Record<string, RelationMutationProgram>;
} {
  const { scalarData, relationPayloads } = partitionModelData(ctx, parsedData);
  const relations: Record<string, RelationMutationProgram> = {};
  for (const [relationName, { relationInfo, payload }] of Object.entries(
    relationPayloads
  )) {
    const program = buildRelationMutationProgram(relationInfo, payload);
    if (program) relations[relationName] = program;
  }
  return { scalarData, relations };
}

/** Partition one already schema-transformed selected-record update payload. */
export function canonicalRecordUpdateData(
  ctx: QueryScope,
  data: Record<string, unknown>
): ReturnType<typeof buildParsedRelationPrograms> {
  return buildParsedRelationPrograms(ctx, data);
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

function parseConnectOrCreateItems(
  relationInfo: RelationInfo,
  value: unknown
): ConnectOrCreateInput[] {
  return parseSingleOrArrayRecord(value, relationInfo, "connectOrCreate").map(
    (input) => ({
      where: requireRecordField(
        relationInfo,
        "connectOrCreate",
        input,
        "where"
      ),
      create: requireRecordField(
        relationInfo,
        "connectOrCreate",
        input,
        "create"
      ),
    })
  );
}

function parseNormalizedUpdates(
  relationInfo: RelationInfo,
  value: unknown
): NormalizedRelationUpdate[] {
  if (relationInfo.isToOne) {
    const target = splitToOneUpdateTarget(value);
    return [
      {
        target: {
          kind: "correlated",
          ...(target.filter ? { filter: target.filter } : {}),
        },
        data: target.data,
      },
    ];
  }

  return parseSingleOrArrayRecord(value, relationInfo, "update").map(
    (input) => ({
      target: {
        kind: "unique",
        where: requireRecordField(relationInfo, "update", input, "where"),
      },
      data: requireRecordField(relationInfo, "update", input, "data"),
    })
  );
}

function parseNormalizedUpdateMany(
  relationInfo: RelationInfo,
  value: unknown
): NestedUpdateManyInput[] {
  rejectToOneOperation(relationInfo, "updateMany");
  return parseSingleOrArrayRecord(value, relationInfo, "updateMany").map(
    (input): NestedUpdateManyInput => ({
      data: requireRecordField(relationInfo, "updateMany", input, "data"),
      ...(input.where === undefined
        ? {}
        : {
            where: requireRecordField(
              relationInfo,
              "updateMany",
              input,
              "where"
            ),
          }),
    })
  );
}

function parseNormalizedDeleteMany(
  relationInfo: RelationInfo,
  value: unknown
): Record<string, unknown>[] {
  rejectToOneOperation(relationInfo, "deleteMany");
  return parseSingleOrArrayRecord(value, relationInfo, "deleteMany");
}

function parseNormalizedUpserts(
  relationInfo: RelationInfo,
  value: unknown
): NormalizedRelationUpsert[] {
  if (relationInfo.isToOne && Array.isArray(value)) {
    throw new NestedWriteError(
      `Malformed nested 'upsert' operation on relation '${relationInfo.name}': expected a single object envelope for to-one relations.`,
      relationInfo.name,
      { meta: { operation: "upsert" } }
    );
  }

  return parseSingleOrArrayRecord(value, relationInfo, "upsert").map(
    (input) => ({
      target: relationInfo.isToOne
        ? { kind: "correlated" }
        : {
            kind: "unique",
            where: requireRecordField(relationInfo, "upsert", input, "where"),
          },
      create: requireRecordField(relationInfo, "upsert", input, "create"),
      update: requireRecordField(relationInfo, "upsert", input, "update"),
    })
  );
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

function requireRecordArrayField(
  relationInfo: RelationInfo,
  operation: string,
  input: Record<string, unknown>,
  field: string
): Record<string, unknown>[] {
  const value = input[field];
  if (Array.isArray(value) && value.every(isRecord)) return value;
  throw new NestedWriteError(
    `Malformed nested '${operation}' operation on relation '${relationInfo.name}': expected '${field}' to be an array of objects.`,
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
