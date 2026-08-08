import type {
  PolymorphicStorage,
  PolymorphicStorageColumn,
} from "@schema/relation";
import { isRecord } from "@validation/value-guards";
import type {
  PolymorphicRelationInfo,
  QueryScope,
  ResolvedPolymorphicEdge,
} from "../types";
import { QueryEngineError } from "../types";
import { resolvePolymorphicEdge } from "./polymorphic-relation";
import type { RelationMutationProgram } from "./relation-mutation-parser";

/** One atomic private `(type, id)` assignment. A one-column state is unspellable. */
export type PolymorphicStorageValue<Id> =
  | {
      readonly kind: "linked";
      readonly storage: PolymorphicStorage;
      readonly storedType: string;
      readonly referencedField: string;
      readonly id: Id;
    }
  | {
      readonly kind: "empty";
      readonly storage: PolymorphicStorage;
    };

export interface PolymorphicStorageMemberValue<Id> {
  readonly column: PolymorphicStorageColumn;
  readonly value: Id | string | null;
}

/**
 * Expand each atomic relation value into its ordered private column members.
 * Model declaration order governs relations; type always precedes id.
 */
export function polymorphicStorageMembers<Id>(
  scope: QueryScope,
  values: readonly PolymorphicStorageValue<Id>[]
): PolymorphicStorageMemberValue<Id>[] {
  const order = new Map(
    scope.model["~"].polymorphicRelationNames.map((name, index) => [
      name,
      index,
    ])
  );
  const sorted = [...values].sort(
    (left, right) =>
      (order.get(left.storage.relationName) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.storage.relationName) ?? Number.MAX_SAFE_INTEGER)
  );
  const members: PolymorphicStorageMemberValue<Id>[] = [];
  for (const value of sorted) {
    members.push(
      {
        column: value.storage.typeColumn,
        value: value.kind === "linked" ? value.storedType : null,
      },
      {
        column: value.storage.idColumn,
        value: value.kind === "linked" ? value.id : null,
      }
    );
  }
  return members;
}

export type ResolvedPolymorphicMutation =
  | {
      readonly kind: "targeted";
      readonly edge: ResolvedPolymorphicEdge;
      readonly program: RelationMutationProgram;
    }
  | {
      readonly kind: "disconnect";
      readonly storage: PolymorphicStorage;
    };

type ResolvedPolymorphicMutationIntent =
  | {
      readonly kind: "targeted";
      readonly edge: ResolvedPolymorphicEdge;
      readonly operation:
        | "connect"
        | "create"
        | "connectOrCreate"
        | "update"
        | "upsert"
        | "delete";
      readonly payload: unknown;
    }
  | Extract<ResolvedPolymorphicMutation, { kind: "disconnect" }>;

/**
 * Resolve one already schema-transformed direct payload. The validation boundary
 * owns its shape; this function only binds the public discriminator to storage and
 * translates the envelope into the existing concrete-relation program vocabulary.
 */
export function resolvePolymorphicMutationIntent(
  scope: QueryScope,
  relation: PolymorphicRelationInfo,
  parsedPayload: unknown
): ResolvedPolymorphicMutationIntent {
  if (!isRecord(parsedPayload)) {
    throw new QueryEngineError(
      `Polymorphic relation '${relation.name}' produced an invalid mutation payload.`
    );
  }
  if (parsedPayload.disconnect === true) {
    return { kind: "disconnect", storage: relation.storage };
  }
  const operation = (
    [
      "connect",
      "create",
      "connectOrCreate",
      "update",
      "upsert",
      "delete",
    ] as const
  ).find((kind) => Object.hasOwn(parsedPayload, kind));
  if (!operation) {
    throw new QueryEngineError(
      `Polymorphic relation '${relation.name}' produced an invalid mutation payload.`
    );
  }
  const envelope = parsedPayload[operation];
  if (!(isRecord(envelope) && typeof envelope.type === "string")) {
    throw new QueryEngineError(
      `Polymorphic relation '${relation.name}' produced an invalid ${operation} mutation.`
    );
  }
  let payload: unknown;
  switch (operation) {
    case "connect":
      payload = envelope.where;
      break;
    case "create":
      payload = envelope.data;
      break;
    case "connectOrCreate":
      payload = { where: envelope.where, create: envelope.create };
      break;
    case "update":
      payload = {
        data: envelope.data,
        ...(envelope.where === undefined ? {} : { where: envelope.where }),
      };
      break;
    case "upsert":
      payload = { create: envelope.create, update: envelope.update };
      break;
    case "delete":
      payload = true;
      break;
    default: {
      const exhaustive: never = operation;
      throw new TypeError(`Unknown polymorphic mutation: ${exhaustive}`);
    }
  }
  if (operation !== "delete" && !isRecord(payload)) {
    throw new QueryEngineError(
      `Polymorphic relation '${relation.name}' produced an invalid ${operation} target.`
    );
  }
  return {
    kind: "targeted",
    edge: resolvePolymorphicEdge(scope, relation, envelope.type),
    operation,
    payload,
  };
}
