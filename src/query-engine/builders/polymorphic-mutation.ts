import type { PolymorphicStorageColumn, RelationSlot } from "@schema/relation";
import type { ResolvedVariantRowStorage } from "@schema/validation/relation-resolution";
import { isRecord } from "@validation/value-guards";
import type {
  QueryScope,
  SelectedVariantRow,
  VariantRowCarrierSlot,
} from "../types";
import { QueryEngineError } from "../types";
import { selectVariantRow } from "./polymorphic-relation";

/** One atomic private `(type, id)` assignment. A one-column state is unspellable. */
export type PolymorphicStorageValue<Id> =
  | {
      readonly kind: "linked";
      /** The carrier slot these private columns belong to. */
      readonly carrier: RelationSlot;
      readonly storage: ResolvedVariantRowStorage;
      readonly storedType: string;
      readonly referencedField: string;
      readonly id: Id;
    }
  | {
      readonly kind: "empty";
      readonly carrier: RelationSlot;
      readonly storage: ResolvedVariantRowStorage;
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
  // MODEL DECLARATION ORDER, read from the one index: the private column pairs
  // of a row are written in the order their carriers were declared, which is the
  // order the resolved slot map preserves.
  const valuesByCarrier = new Map<
    RelationSlot,
    PolymorphicStorageValue<Id>[]
  >();
  for (const value of values) {
    const carrier = value.carrier;
    const carrierValues = valuesByCarrier.get(carrier);
    if (carrierValues) carrierValues.push(value);
    else valuesByCarrier.set(carrier, [value]);
  }
  const members: PolymorphicStorageMemberValue<Id>[] = [];
  for (const resolved of scope.relations.get(scope.model)?.values() ?? []) {
    const carrierValues = valuesByCarrier.get(resolved.slot);
    if (!carrierValues) continue;
    for (const value of carrierValues) {
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
      readonly edge: SelectedVariantRow;
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
      readonly carrier: VariantRowCarrierSlot;
    };

/**
 * Resolve one already schema-transformed direct payload. The validation boundary
 * owns its shape; this function only binds the public discriminator to storage and
 * translates the envelope into the existing concrete-relation program vocabulary.
 */
export function resolvePolymorphicMutationIntent(
  relation: VariantRowCarrierSlot,
  parsedPayload: unknown
): ResolvedPolymorphicMutationIntent {
  if (!isRecord(parsedPayload)) {
    throw new QueryEngineError(
      `Polymorphic relation '${relation.slot.field}' produced an invalid mutation payload.`
    );
  }
  if (parsedPayload.disconnect === true) {
    return { kind: "disconnect", carrier: relation };
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
      `Polymorphic relation '${relation.slot.field}' produced an invalid mutation payload.`
    );
  }
  const envelope = parsedPayload[operation];
  if (!(isRecord(envelope) && typeof envelope.type === "string")) {
    throw new QueryEngineError(
      `Polymorphic relation '${relation.slot.field}' produced an invalid ${operation} mutation.`
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
      `Polymorphic relation '${relation.slot.field}' produced an invalid ${operation} target.`
    );
  }
  return {
    kind: "targeted",
    edge: selectVariantRow(relation, envelope.type),
    operation,
    payload,
  };
}
