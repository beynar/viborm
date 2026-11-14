/**
 * Default order: per model, the order its reads take when the caller gives
 * no `orderBy` (`order`). It reads no control and filters no row.
 */
import type { Schema } from "@client/types";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { getModelKeyCatalog } from "@schema/model/keys";
import { isRecord } from "@validation/value-guards";
import { rebind } from "./call-rows";
import type { ExtensionPart } from "./chain";
import type { OrderContribution, OrderTerm } from "./controls";
import { extensionError, readOwn, readOwnKeys } from "./definition";
import { bindPlain } from "./plain-domain";

/**
 * `order`, read once: per model, the terms its reads take when the caller
 * gives no `orderBy`, each `{ field: "asc" | "desc" }`. The model must have a
 * row key (its reads end with it, so the order is total)
 * and each field must be one of its scalars that orders as a value (not a
 * list, JSON, vector or point).
 */
function admitOrder(
  value: unknown,
  schema: Schema,
  name: string
): OrderContribution {
  const models = isRecord(value) ? readOwn(value, "models", name) : undefined;
  const admitted: Record<string, readonly OrderTerm[]> = {};
  for (const key of isRecord(models) ? readOwnKeys(models, name) : [""]) {
    const model = schema[key as string];
    const entry = isRecord(models)
      ? readOwn(models, key as string, name)
      : undefined;
    const terms = Array.isArray(entry) ? entry : [entry];
    const valid =
      typeof key === "string" &&
      model !== undefined &&
      getModelKeyCatalog(model).rowKey !== undefined &&
      terms.length > 0 &&
      terms.every((term) => {
        const fields = isRecord(term) ? readOwnKeys(term, name) : [];
        const field = fields[0];
        const direction = isRecord(term) ? term[field as string] : undefined;
        const state =
          typeof field === "string" &&
          Object.hasOwn(model["~"].state.scalars, field)
            ? model["~"].state.scalars[field]!["~"].state
            : undefined;
        return (
          fields.length === 1 &&
          (direction === "asc" || direction === "desc") &&
          state !== undefined &&
          !state.array &&
          !UNORDERED_SCALARS.has(state.type)
        );
      });
    if (!valid)
      extensionError(
        `Extension "${name}" order${isRecord(models) ? `.${String(key)}` : ""} must map a model with a key to { field: "asc" | "desc" } terms over its ordered scalars.`,
        name
      );
    admitted[key as string] = Object.freeze(
      terms.map((term) => Object.freeze({ ...(term as OrderTerm) }))
    );
  }
  return Object.freeze({ models: Object.freeze(admitted) });
}
const UNORDERED_SCALARS = new Set(["json", "vector", "point", "blob"]);

/** `order`: default order. A later extension's entry for a model replaces one. */
export const defaultOrderPart: ExtensionPart = {
  members: ["order"],
  admit(application) {
    const { definition, schema } = application;
    if (definition.order !== undefined)
      application.definition = Object.freeze({
        ...definition,
        order: admitOrder(definition.order, schema, definition.name),
      });
  },
  join({ definition, chain, next }) {
    if (definition.order === undefined) return;
    next.order = Object.freeze({
      ...chain?.order,
      // Admission left each entry a frozen array of terms.
      ...(definition.order.models as Readonly<
        Record<string, readonly Input[]>
      >),
    });
  },
  seal(application) {
    rebind(application, bindPlain);
  },
};
