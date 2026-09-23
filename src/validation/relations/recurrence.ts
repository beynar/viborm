import { getModelKeyCatalog } from "@schema/model";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import { createSchema, fail, ok } from "../primitives/helpers";
import { validateInteger } from "../primitives/number";
import v, { type V } from "../primitives/v";

export interface NormalizedRecurrence {
  readonly depth: number | false;
  readonly cycles: "reject" | "prevent" | "allow";
}

/**
 * Whether an occurrence at `level` carries the repeated key — the outer slot's
 * own occurrences are level 1. It does at every level of an exhaustive
 * traversal and at every level before a numeric cutoff; at the cutoff the key
 * is absent. The decoder and the cache walker both read this one rule.
 */
export function carriesRepeatedKey(
  depth: number | false,
  level: number
): boolean {
  return depth === false || level < depth;
}

/**
 * A foreign-key traversal has no cycle policy to choose: it rejects every
 * cycle it reaches. `preventCycles` is therefore refused by the bag's own type,
 * so no downstream guard has to know which topology a nested bag belongs to.
 */
export type ForeignKeyRecurse =
  | true
  | {
      readonly depth?: number | false;
      readonly preventCycles?: undefined;
    };

export type GraphRecurse =
  | true
  | { readonly depth?: number; readonly preventCycles?: boolean }
  | { readonly depth: false; readonly preventCycles?: true };

export type ForeignKeyRecurrenceSchema = V.Schema<
  ForeignKeyRecurse,
  NormalizedRecurrence
>;

export type GraphRecurrenceSchema = V.Schema<
  GraphRecurse,
  NormalizedRecurrence
>;

export type RecurrenceSchema =
  | ForeignKeyRecurrenceSchema
  | GraphRecurrenceSchema;

/** `true`, `{}` and an omitted or undefined nested `depth` mean this depth. */
const DEFAULT_DEPTH = 100;

// An integer inside 1..1000 is necessarily a positive safe integer.
const depth = createSchema<number, number>("integer", (value) => {
  const integer = validateInteger(value);
  if (integer.issues) return integer;
  return integer.value >= 1 && integer.value <= 1000
    ? ok(integer.value)
    : fail("recurse.depth must be a positive safe integer between 1 and 1000");
});

const foreignKeyOptions = v.object({
  depth: v.optional(v.union([depth, v.literal(false)])),
  preventCycles: v.optional(
    v.refused(
      "preventCycles applies only to a junction graph; a foreign-key recursion rejects every cycle it reaches"
    )
  ),
});

const graphOptions = v.union([
  v.object({
    depth: v.optional(depth),
    preventCycles: v.optional(v.boolean()),
  }),
  v.object(
    {
      depth: v.literal(false),
      preventCycles: v.optional(v.literal(true)),
    },
    { atLeast: ["depth"] }
  ),
]);

/** The one normalization of a foreign-key bag: it rejects every cycle. */
const normalizeForeignKey = (options: {
  readonly depth?: number | false;
}): NormalizedRecurrence => ({
  depth: options.depth ?? DEFAULT_DEPTH,
  cycles: "reject",
});

/** The one normalization of a graph bag: prevention unless declined. */
const normalizeGraph = (options: {
  readonly depth?: number | false;
  readonly preventCycles?: boolean;
}): NormalizedRecurrence => ({
  depth: options.depth ?? DEFAULT_DEPTH,
  cycles: options.preventCycles === false ? "allow" : "prevent",
});

// `true` is the empty bag of its topology, by construction.
const foreignKeyRecurrence: ForeignKeyRecurrenceSchema = v.union([
  v.coerce(v.literal(true), () => normalizeForeignKey({})),
  v.coerce(foreignKeyOptions, normalizeForeignKey),
]);

const graphRecurrence: GraphRecurrenceSchema = v.union([
  v.coerce(v.literal(true), () => normalizeGraph({})),
  v.coerce(graphOptions, normalizeGraph),
]);

/**
 * The runtime eligibility reader: the recurrence language a resolved slot
 * admits, or `undefined` when the slot cannot recurse.
 *
 * It reads three facts, each from its owner. The model's complete primary row
 * key comes from the key catalog. The edge kind comes from the resolved slot:
 * only an ordinary foreign-key or junction edge recurses, never a variant
 * carrier or an inverse bound to variant storage. Self-identity is the edge's
 * two endpoints sharing one model object, which is runtime identity rather
 * than structural agreement.
 *
 * The remaining conditions of the contract are already facts of a resolved
 * ordinary edge, so they are not asked again: only `s.toOne` declares a
 * foreign key, so a collection never owns one; the resolver publishes an
 * edge's `unique` exactly when both endpoints are singular, so a singular
 * inverse is always the proven one-to-one side; and a junction edge is
 * resolved only between two collections.
 */
export function recurrenceSchema(
  resolved: ResolvedSlot
): RecurrenceSchema | undefined {
  const { edge, slot } = resolved;
  if (edge.kind !== "foreignKey" && edge.kind !== "junction") return undefined;
  const [first, second] = edge.endpoints;
  if (first.source !== second.source) return undefined;
  if (!getModelKeyCatalog(slot.source).rowKey) return undefined;
  return edge.kind === "junction" ? graphRecurrence : foreignKeyRecurrence;
}
