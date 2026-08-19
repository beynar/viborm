import type {
  PolymorphicStorageColumn,
  PolymorphicToOneStorage,
} from "@schema/relation";
import { isRecord } from "@validation/value-guards";
import type {
  PolymorphicToOneRelationInfo,
  QueryScope,
  ResolvedPolymorphicEdge,
} from "../types";
import { QueryEngineError } from "../types";
import { resolvePolymorphicEdge } from "./polymorphic-relation";

/** One atomic private `(type, id)` assignment. A one-column state is unspellable. */
export type PolymorphicStorageValue<Id> =
  | {
      readonly kind: "linked";
      readonly storage: PolymorphicToOneStorage;
      readonly storedType: string;
      readonly referencedField: string;
      readonly id: Id;
    }
  | {
      readonly kind: "empty";
      readonly storage: PolymorphicToOneStorage;
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

/**
 * What one direct payload MEANS, before it becomes a parsed relation entry: a
 * resolved edge plus the operation vocabulary the concrete relation program is
 * built from, or a targetless disconnect that clears the private pair.
 *
 * The two arms used to survive past this boundary as a companion map beside the
 * relation programs; they are now the two polymorphic arms of
 * `ParsedRelationMutation`, so this type ends where the parse ends.
 */
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
  | {
      readonly kind: "disconnect";
      readonly storage: PolymorphicToOneStorage;
    };

/**
 * Resolve one already schema-transformed direct payload. The validation boundary
 * owns its shape; this function only binds the public discriminator to storage and
 * translates the envelope into the existing concrete-relation program vocabulary.
 */
export function resolvePolymorphicMutationIntent(
  scope: QueryScope,
  relation: PolymorphicToOneRelationInfo,
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
